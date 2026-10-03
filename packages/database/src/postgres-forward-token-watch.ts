import { createHash } from "node:crypto";
import {
  forwardDecimal, forwardExtendedCaptureDeadline, forwardInitialCaptureDeadline,
  forwardQualifyingBuyAmount, forwardReachedMarketCapTiers, type DiscoveryChain,
} from "@address-radar/domain";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS forward_token_watches (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  chain text NOT NULL, token_address text NOT NULL,
  first_discovered_at bigint NOT NULL, capture_until bigint NOT NULL,
  screening_enabled_at bigint,
  PRIMARY KEY (generation_id,chain,token_address)
);
CREATE TABLE IF NOT EXISTS forward_token_discovery_links (
  generation_id text NOT NULL, source_job_id text NOT NULL REFERENCES capture_normalized_results(job_id),
  chain text NOT NULL, token_address text NOT NULL, discovered_at bigint NOT NULL,
  PRIMARY KEY (generation_id,source_job_id),
  FOREIGN KEY (generation_id,chain,token_address) REFERENCES forward_token_watches(generation_id,chain,token_address)
);
CREATE TABLE IF NOT EXISTS forward_token_market_inputs (
  generation_id text NOT NULL, chain text NOT NULL, token_address text NOT NULL,
  source_event_id text NOT NULL, fingerprint text NOT NULL, market_cap_usd numeric NOT NULL,
  occurred_at bigint NOT NULL, evidence_ref text NOT NULL,
  PRIMARY KEY (generation_id,chain,token_address,source_event_id),
  FOREIGN KEY (generation_id,chain,token_address) REFERENCES forward_token_watches(generation_id,chain,token_address)
);
CREATE TABLE IF NOT EXISTS forward_token_milestone_hits (
  generation_id text NOT NULL, chain text NOT NULL, token_address text NOT NULL,
  threshold integer NOT NULL CHECK (threshold IN (100000,200000,300000,500000,1000000)),
  source_event_id text NOT NULL, occurred_at bigint NOT NULL,
  PRIMARY KEY (generation_id,chain,token_address,threshold),
  FOREIGN KEY (generation_id,chain,token_address,source_event_id)
    REFERENCES forward_token_market_inputs(generation_id,chain,token_address,source_event_id)
);
CREATE TABLE IF NOT EXISTS forward_token_buyer_extensions (
  generation_id text NOT NULL, trade_id text NOT NULL REFERENCES forward_economic_trades(trade_id),
  chain text NOT NULL, token_address text NOT NULL, occurred_at bigint NOT NULL,
  eligibility_kind text NOT NULL CHECK (eligibility_kind IN ('system_stable','manual_authorized')),
  eligibility_ref text NOT NULL,
  PRIMARY KEY (generation_id,trade_id),
  FOREIGN KEY (generation_id,chain,token_address) REFERENCES forward_token_watches(generation_id,chain,token_address)
);
CREATE TABLE IF NOT EXISTS forward_token_watch_intents (
  generation_id text NOT NULL, chain text NOT NULL, token_address text NOT NULL,
  event_key text NOT NULL, purpose text NOT NULL CHECK (purpose IN ('buyer_capture','screening','capture_extension')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched')), created_at bigint NOT NULL,
  PRIMARY KEY (generation_id,chain,token_address,event_key,purpose),
  FOREIGN KEY (generation_id,chain,token_address) REFERENCES forward_token_watches(generation_id,chain,token_address)
);
CREATE INDEX IF NOT EXISTS forward_token_capture_deadline ON forward_token_watches(capture_until);
CREATE INDEX IF NOT EXISTS forward_token_watch_pending_intents ON forward_token_watch_intents(status,created_at);
`;

export interface ForwardTokenWatchKey {
  generationId: string;
  chain: DiscoveryChain;
  tokenAddress: string;
}
export interface ForwardTokenWatch extends ForwardTokenWatchKey {
  firstDiscoveredAt: number;
  captureUntil: number;
  screeningEnabledAt: number | null;
}
type DiscoveryResult = { status: "watch_ready"; watch: ForwardTokenWatch } | { status: "non_trade" };

function text(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Invalid token-watch identifier");
}
function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid token-watch timestamp");
}
function keyValues(key: ForwardTokenWatchKey): readonly string[] {
  text(key.generationId);
  text(key.tokenAddress);
  if (!["solana", "eth", "bsc", "base", "robinhood"].includes(key.chain)) throw new Error("Unsupported forward chain");
  return [key.generationId, key.chain, key.chain === "solana" ? key.tokenAddress : key.tokenAddress.toLowerCase()];
}
function mapWatch(row: Record<string, unknown>): ForwardTokenWatch {
  return {
    generationId: String(row.generation_id), chain: String(row.chain) as DiscoveryChain,
    tokenAddress: String(row.token_address), firstDiscoveredAt: Number(row.first_discovered_at),
    captureUntil: Number(row.capture_until), screeningEnabledAt: row.screening_enabled_at === null ? null : Number(row.screening_enabled_at),
  };
}

export function createPostgresForwardTokenWatchRepository(transaction: PostgresTransaction) {
  const tx = transaction;
  async function lockedWatch(key: ForwardTokenWatchKey): Promise<ForwardTokenWatch> {
    const result = await tx.query("SELECT * FROM forward_token_watches WHERE generation_id=$1 AND chain=$2 AND token_address=$3 FOR UPDATE", keyValues(key));
    if (!result.rows[0]) throw new Error("Forward token watch is missing");
    return mapWatch(result.rows[0]);
  }
  async function intent(key: ForwardTokenWatchKey, eventKey: string, purpose: string, now: number): Promise<void> {
    await tx.query(`INSERT INTO forward_token_watch_intents(generation_id,chain,token_address,event_key,purpose,created_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [...keyValues(key), eventKey, purpose, now]);
  }
  return {
    async discover(input: { generationId: string; sourceJobId: string; discoveredAt: number }): Promise<DiscoveryResult> {
      text(input.generationId); text(input.sourceJobId); time(input.discoveredAt);
      const source = await tx.query("SELECT event_kind,chain,token_address,requires_review FROM capture_normalized_results WHERE job_id=$1", [input.sourceJobId]);
      const observation = source.rows[0];
      if (!observation) throw new Error("Token discovery source result is missing");
      if (observation.requires_review) throw new Error("Token discovery source requires review");
      if (!["buy", "sell"].includes(String(observation.event_kind)) || !observation.chain || !observation.token_address) return { status: "non_trade" };
      const generation = await tx.query("SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1", [input.generationId]);
      if (!generation.rows[0] || Number(generation.rows[0].activated_at) > input.discoveredAt) throw new Error("Forward generation is not active at discovery");
      const key: ForwardTokenWatchKey = { generationId: input.generationId, chain: String(observation.chain) as DiscoveryChain, tokenAddress: String(observation.token_address) };
      const inserted = await tx.query(`INSERT INTO forward_token_watches(generation_id,chain,token_address,first_discovered_at,capture_until)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING generation_id`,
      [...keyValues(key), input.discoveredAt, forwardInitialCaptureDeadline(input.discoveredAt)]);
      const watch = await lockedWatch(key);
      await tx.query(`INSERT INTO forward_token_discovery_links(generation_id,source_job_id,chain,token_address,discovered_at)
        VALUES($1,$4,$2,$3,$5) ON CONFLICT DO NOTHING`, [...keyValues(key), input.sourceJobId, input.discoveredAt]);
      if (inserted.rows.length) await intent(key, "first_discovery", "buyer_capture", input.discoveredAt);
      return { status: "watch_ready", watch };
    },
    async get(key: ForwardTokenWatchKey): Promise<ForwardTokenWatch | null> {
      const result = await tx.query("SELECT * FROM forward_token_watches WHERE generation_id=$1 AND chain=$2 AND token_address=$3", keyValues(key));
      return result.rows[0] ? mapWatch(result.rows[0]) : null;
    },
    async recordMarket(input: ForwardTokenWatchKey & {
      sourceEventId: string; marketCapUsd: string; occurredAt: number; now: number;
      verification: "validated" | "pending_review"; evidenceRef: string;
    }): Promise<{ status: "applied" | "duplicate" | "deferred"; reasonCode?: string; newTiers: readonly number[]; watch: ForwardTokenWatch }> {
      time(input.now); time(input.occurredAt); text(input.sourceEventId); text(input.evidenceRef);
      if (input.occurredAt > input.now) throw new Error("Future token market evidence");
      const watch = await lockedWatch(input);
      if (input.verification !== "validated") return { status: "deferred", reasonCode: "market_evidence_unverified", newTiers: [], watch };
      const cap = forwardDecimal(input.marketCapUsd);
      const fingerprint = createHash("sha256").update(JSON.stringify([cap, input.occurredAt, input.evidenceRef])).digest("hex");
      const inserted = await tx.query(`INSERT INTO forward_token_market_inputs(generation_id,chain,token_address,source_event_id,fingerprint,market_cap_usd,occurred_at,evidence_ref)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING fingerprint`,
      [...keyValues(input), input.sourceEventId, fingerprint, cap, input.occurredAt, input.evidenceRef]);
      if (!inserted.rows.length) {
        const existing = await tx.query(`SELECT fingerprint FROM forward_token_market_inputs
          WHERE generation_id=$1 AND chain=$2 AND token_address=$3 AND source_event_id=$4`, [...keyValues(input), input.sourceEventId]);
        if (existing.rows[0]?.fingerprint !== fingerprint) throw new Error("Token market event identity conflict");
        return { status: "duplicate", newTiers: [], watch };
      }
      const newTiers: number[] = [];
      for (const threshold of forwardReachedMarketCapTiers(cap)) {
        const tier = await tx.query(`INSERT INTO forward_token_milestone_hits(generation_id,chain,token_address,threshold,source_event_id,occurred_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING threshold`,
        [...keyValues(input), threshold, input.sourceEventId, input.occurredAt]);
        if (tier.rows.length) newTiers.push(threshold);
      }
      if (!newTiers.length) return { status: "applied", newTiers, watch };
      const captureUntil = forwardExtendedCaptureDeadline(watch.captureUntil, input.occurredAt);
      const startsScreening = watch.screeningEnabledAt === null && newTiers.includes(100000);
      await tx.query(`UPDATE forward_token_watches SET capture_until=$4,screening_enabled_at=COALESCE(screening_enabled_at,$5)
        WHERE generation_id=$1 AND chain=$2 AND token_address=$3`,
      [...keyValues(input), captureUntil, startsScreening ? input.occurredAt : null]);
      if (startsScreening) await intent(input, "milestone:100000", "screening", input.now);
      await intent(input, "market:" + input.sourceEventId, "capture_extension", input.now);
      return { status: "applied", newTiers, watch: { ...watch, captureUntil, screeningEnabledAt: watch.screeningEnabledAt ?? input.occurredAt } };
    },
    async extendForPurchase(input: {
      generationId: string; tradeId: string; now: number;
      eligibility: { entityId: string; kind: "system_stable" | "manual_authorized"; evidenceRef: string } | null;
    }): Promise<{ status: "applied" | "duplicate" | "ineligible"; watch: ForwardTokenWatch }> {
      time(input.now); text(input.tradeId);
      const result = await tx.query(`SELECT t.chain,t.token_address,t.entity_id,t.occurred_at,r.amount_usd::text,g.activated_at
        FROM forward_economic_trades t JOIN forward_trade_revisions r ON r.trade_id=t.trade_id AND r.fingerprint=t.original_fingerprint
        JOIN forward_strategy_generations g ON g.generation_id=$2
        WHERE t.trade_id=$1 AND r.state='original'`, [input.tradeId, input.generationId]);
      const trade = result.rows[0];
      if (!trade) throw new Error("Verified forward purchase is missing");
      const key: ForwardTokenWatchKey = { generationId: input.generationId, chain: String(trade.chain) as DiscoveryChain, tokenAddress: String(trade.token_address) };
      const watch = await lockedWatch(key);
      const occurredAt = Number(trade.occurred_at);
      if (occurredAt > input.now) throw new Error("Future token buyer extension");
      if (!input.eligibility || input.eligibility.entityId !== trade.entity_id ||
          !["system_stable", "manual_authorized"].includes(input.eligibility.kind) ||
          occurredAt < Number(trade.activated_at) || !forwardQualifyingBuyAmount(String(trade.amount_usd))) return { status: "ineligible", watch };
      text(input.eligibility.evidenceRef);
      const inserted = await tx.query(`INSERT INTO forward_token_buyer_extensions(generation_id,trade_id,chain,token_address,occurred_at,eligibility_kind,eligibility_ref)
        VALUES($1,$4,$2,$3,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING trade_id`,
      [...keyValues(key), input.tradeId, occurredAt, input.eligibility.kind, input.eligibility.evidenceRef]);
      if (!inserted.rows.length) return { status: "duplicate", watch };
      const captureUntil = forwardExtendedCaptureDeadline(watch.captureUntil, occurredAt);
      await tx.query("UPDATE forward_token_watches SET capture_until=$4 WHERE generation_id=$1 AND chain=$2 AND token_address=$3", [...keyValues(key), captureUntil]);
      await intent(key, "trade:" + input.tradeId, "capture_extension", input.now);
      return { status: "applied", watch: { ...watch, captureUntil } };
    },
  };
}
