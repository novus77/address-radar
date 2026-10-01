import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeAddressRadarTokenAddress, type TraderEvent } from "@address-radar/domain";
import { withAddressRadarWriteTransaction } from "./connection.js";

export const EXECUTION_REVISION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trader_execution_heads (
  source TEXT NOT NULL,event_id TEXT NOT NULL,entity_id TEXT NOT NULL,chain TEXT NOT NULL,token_address TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,fingerprint TEXT NOT NULL DEFAULT '',last_observed_at INTEGER NOT NULL,
  projection_state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(source,event_id)
);
CREATE INDEX IF NOT EXISTS trader_execution_heads_entity ON trader_execution_heads(entity_id,projection_state);
CREATE INDEX IF NOT EXISTS trader_execution_heads_token ON trader_execution_heads(chain,token_address);
CREATE TABLE IF NOT EXISTS trader_execution_revisions (
  source TEXT NOT NULL,event_id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(source,event_id,revision)
);
CREATE TABLE IF NOT EXISTS wallet_execution_revision_conflicts (
  conflict_id TEXT PRIMARY KEY,source TEXT NOT NULL,event_id TEXT NOT NULL,reason_code TEXT NOT NULL,
  payload TEXT NOT NULL,recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_revision_requests (
  source TEXT NOT NULL,event_id TEXT NOT NULL,consumer_type TEXT NOT NULL,subject_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,token_id TEXT NOT NULL,desired_revision INTEGER NOT NULL,applied_revision INTEGER NOT NULL DEFAULT 0,
  dispatched_revision INTEGER NOT NULL DEFAULT 0,requested_at INTEGER NOT NULL,dispatched_at INTEGER,applied_at INTEGER,
  last_outcome TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(source,event_id,consumer_type)
);
CREATE INDEX IF NOT EXISTS execution_revision_requests_pending
  ON execution_revision_requests(consumer_type,subject_key,desired_revision,applied_revision,requested_at);
`;
export function initializeExecutionRevisionSchema(database: DatabaseSync): void {
  withAddressRadarWriteTransaction(database, () => database.exec(EXECUTION_REVISION_SCHEMA_SQL));
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const chainOf = (chain: string): string => chain.trim().toLowerCase();
const addressOf = (chain: string, address: string): string => normalizeAddressRadarTokenAddress(chainOf(chain), address.trim());
const sameNumber = (a: unknown, b: number): boolean => typeof a === "number" && Number.isFinite(a)
  && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE) * 1e-9;
interface Basis {
  readonly status: "estimated"; readonly reason: "nominal_stablecoin_usd";
  readonly tokenAddress: string; readonly side: string; readonly tokenQuantity: number;
  readonly quoteAsset: string; readonly quoteQuantity: number; readonly amountUsd: number;
  readonly priceUsd: number; readonly amountBasis: "nominal_stablecoin";
}
function basisOf(value: unknown, chain: string, token: string, side: string): Basis | null {
  if (!value || typeof value !== "object") return null;
  const b = value as Partial<Basis>;
  if (b.status !== "estimated" || b.reason !== "nominal_stablecoin_usd" || b.amountBasis !== "nominal_stablecoin"
    || typeof b.tokenAddress !== "string" || addressOf(chain, b.tokenAddress) !== addressOf(chain, token)
    || b.side !== side || typeof b.quoteAsset !== "string" || !b.quoteAsset.trim()
    || addressOf(chain, b.quoteAsset) === addressOf(chain, token)
    || ![b.tokenQuantity,b.quoteQuantity,b.amountUsd,b.priceUsd].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)
    || !sameNumber(b.amountUsd, b.quoteQuantity!) || !sameNumber(b.priceUsd, b.amountUsd! / b.tokenQuantity!)) return null;
  return b as Basis;
}
interface WalletInput {
  readonly eventId: string; readonly chainFamily: string; readonly chain: string; readonly walletAddress: string;
  readonly tokenAddress: string; readonly accountId: string; readonly entityId: string; readonly side: string;
  readonly amountUsd: number | null; readonly priceUsd: number | null; readonly occurredAt: number;
  readonly collectedAt: number; readonly executionBasis?: unknown;
}
const sameIdentity = (event: TraderEvent | WalletInput, row: Record<string, unknown>): boolean =>
  event.accountId === row.account_id && event.entityId === row.entity_id && event.side === row.side
  && event.occurredAt === row.occurred_at && chainOf(event.chain) === chainOf(String(row.chain))
  && addressOf(event.chain,event.tokenAddress) === addressOf(String(row.chain),String(row.token_address));

export function createExecutionRevisionStore(database: DatabaseSync) {
  const conflict = (source: string, eventId: string, reason: string, payload: unknown, at: number): void => {
    const content = payload && typeof payload === "object" ? { ...payload as Record<string, unknown>, collectedAt: undefined } : payload;
    database.prepare(`INSERT OR IGNORE INTO wallet_execution_revision_conflicts
      (conflict_id,source,event_id,reason_code,payload,recorded_at) VALUES(?,?,?,?,?,?)`)
      .run(hash([source,eventId,reason,content]),source,eventId,reason,JSON.stringify(payload),at);
  };
  const currentWallet = (source: string, eventId: string): Record<string, unknown> | undefined =>
    database.prepare(`SELECT w.*,(SELECT basis_json FROM wallet_monitor_execution_bases b
      WHERE b.source=w.source AND b.event_id=w.event_id) basis_json FROM wallet_monitor_observations w
      WHERE source=? AND event_id=?`).get(source,eventId) as Record<string, unknown> | undefined;
  const matches = (event: TraderEvent, source: string, basisJson: string | null): boolean => {
    const row = currentWallet(source,event.eventId);
    return !!row && row.orphaned_at === null && sameIdentity(event,row)
      && row.collected_at === event.collectedAt && row.amount_usd === event.amountUsd && row.price_usd === event.priceUsd
      && row.basis_json === basisJson;
  };
  const markProjected = (event: TraderEvent, source: string, at: number): void => {
    database.prepare(`UPDATE wallet_monitor_observations SET projected_at=?
      WHERE source=? AND event_id=? AND collected_at=? AND orphaned_at IS NULL`)
      .run(at,source,event.eventId,event.collectedAt);
  };
  return Object.freeze({
    matches,
    stage<T extends WalletInput>(source: string, input: T, at: number): T | null {
      const previous = currentWallet(source,input.eventId);
      const priorEvent = database.prepare("SELECT * FROM trader_events WHERE event_id=?").get(input.eventId) as Record<string,unknown> | undefined;
      const head = database.prepare("SELECT * FROM trader_execution_heads WHERE source=? AND event_id=?").get(source,input.eventId) as Record<string,unknown> | undefined;
      const reject = (reason: string): null => { conflict(source,input.eventId,reason,input,at); return null; };
      if (![input.occurredAt,input.collectedAt,at].every(v => Number.isSafeInteger(v) && v >= 0)
        || input.occurredAt > input.collectedAt || input.collectedAt > at) return reject("execution_time_invalid");
      if (previous && (!sameIdentity(input,previous) || input.chainFamily !== previous.chain_family
        || addressOf(input.chain,input.walletAddress) !== addressOf(String(previous.chain),String(previous.wallet_address)))) {
        return reject("execution_identity_conflict");
      }
      if (priorEvent && (!sameIdentity(input,priorEvent) || priorEvent.source !== "onchain_wallet")) return reject("execution_event_identity_conflict");
      if (input.collectedAt < Math.max(Number(previous?.collected_at ?? 0),Number(head?.last_observed_at ?? 0))) return reject("execution_revision_stale");
      const basis = basisOf(input.executionBasis,input.chain,input.tokenAddress,input.side);
      if ((input.executionBasis as { status?: string } | undefined)?.status === "estimated" && !basis) return reject("execution_basis_invalid");
      if (basis && ((input.amountUsd !== null && !sameNumber(input.amountUsd,basis.amountUsd))
        || (input.priceUsd !== null && !sameNumber(input.priceUsd,basis.priceUsd)))) return reject("execution_basis_value_conflict");
      const oldBasis = previous?.basis_json ? basisOf(JSON.parse(String(previous.basis_json)),input.chain,input.tokenAddress,input.side) : null;
      if (oldBasis && ((!basis && input.executionBasis !== undefined)
        || (!basis && (input.amountUsd !== previous?.amount_usd || input.priceUsd !== previous?.price_usd)))) {
        return reject("execution_basis_quality_regression");
      }
      if (oldBasis && basis && input.collectedAt === Number(head?.last_observed_at ?? previous?.collected_at)
        && (!sameNumber(oldBasis.amountUsd,basis.amountUsd) || !sameNumber(oldBasis.priceUsd,basis.priceUsd))) return reject("execution_revision_order_ambiguous");
      const value = { ...input, amountUsd: input.amountUsd ?? basis?.amountUsd ?? null, priceUsd: input.priceUsd ?? basis?.priceUsd ?? null,
        ...(previous ? { chain: String(previous.chain), tokenAddress: String(previous.token_address), walletAddress: String(previous.wallet_address) } : {}) } as T;
      const changed = !previous || value.amountUsd !== previous.amount_usd || value.priceUsd !== previous.price_usd
        || (value.executionBasis !== undefined && JSON.stringify(value.executionBasis) !== previous.basis_json);
      database.prepare(`INSERT INTO trader_execution_heads(source,event_id,entity_id,chain,token_address,last_observed_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(source,event_id) DO UPDATE SET
        last_observed_at=MAX(last_observed_at,excluded.last_observed_at),
        projection_state=CASE WHEN ? THEN 'pending' ELSE projection_state END`)
        .run(source,value.eventId,value.entityId,chainOf(value.chain),addressOf(value.chain,value.tokenAddress),value.collectedAt,changed ? 1 : 0);
      return value;
    },
    apply(event: TraderEvent, source: string, basisJson: string | null, at: number): "applied" | "legacy" | "stale" | "review_required" {
      return withAddressRadarWriteTransaction(database, () => {
        if (!matches(event,source,basisJson)) return "stale";
        database.prepare(`INSERT OR IGNORE INTO trader_execution_heads
          (source,event_id,entity_id,chain,token_address,last_observed_at) VALUES(?,?,?,?,?,?)`)
          .run(source,event.eventId,event.entityId,chainOf(event.chain),addressOf(event.chain,event.tokenAddress),event.collectedAt);
        const basis = basisOf(basisJson === null ? null : JSON.parse(basisJson),event.chain,event.tokenAddress,event.side);
        if (!basis) {
          database.prepare("UPDATE trader_execution_heads SET projection_state='legacy' WHERE source=? AND event_id=?").run(source,event.eventId);
          markProjected(event,source,at); return "legacy";
        }
        const prior = database.prepare("SELECT * FROM trader_events WHERE event_id=?").get(event.eventId) as Record<string,unknown> | undefined;
        const observationId = `observation:onchain:${event.eventId}`;
        const links = database.prepare(`SELECT c.* FROM canonical_trader_event_observations l
          JOIN canonical_trader_events c ON c.canonical_event_id=l.canonical_event_id WHERE l.observation_id=?`).all(observationId);
        const review = (reason: string): "review_required" => {
          conflict(source,event.eventId,reason,{ ...event, executionBasis: basis },at);
          database.prepare("UPDATE trader_execution_heads SET projection_state='review_required' WHERE source=? AND event_id=?").run(source,event.eventId);
          return "review_required";
        };
        if (!prior || !sameIdentity(event,prior) || prior.source !== "onchain_wallet" || links.length !== 1) return review("execution_canonical_identity_unavailable");
        const canonicalId = String(links[0]!.canonical_event_id);
        const counterparts = database.prepare(`SELECT o.amount_usd FROM canonical_trader_event_observations l
          JOIN raw_trader_observations o ON o.observation_id=l.observation_id
          WHERE l.canonical_event_id=? AND o.observation_id<>?`).all(canonicalId,observationId);
        if (counterparts.some(r => r.amount_usd !== null && !sameNumber(r.amount_usd,basis.amountUsd))) return review("execution_counterpart_conflict");
        const others = database.prepare(`SELECT r.payload FROM trader_execution_heads h JOIN trader_execution_revisions r
          ON r.source=h.source AND r.event_id=h.event_id AND r.revision=h.revision
          WHERE h.event_id=? AND h.source<>? AND h.projection_state='applied'`).all(event.eventId,source);
        if (others.some(r => { const other = JSON.parse(String(r.payload)) as TraderEvent;
          return !sameNumber(other.amountUsd,basis.amountUsd) || !sameNumber(other.priceUsd,basis.priceUsd); })) return review("execution_provider_conflict");
        const fingerprint = hash([event.accountId,event.entityId,chainOf(event.chain),addressOf(event.chain,event.tokenAddress),event.side,
          event.occurredAt,basis.amountUsd,basis.priceUsd,event.marketCapUsd,basis.tokenQuantity,basis.quoteAsset,basis.quoteQuantity,basis.reason]);
        const head = database.prepare("SELECT revision,fingerprint FROM trader_execution_heads WHERE source=? AND event_id=?").get(source,event.eventId) as { revision: number; fingerprint: string } | undefined;
        if (head?.fingerprint === fingerprint) {
          database.prepare("UPDATE trader_execution_heads SET projection_state='applied' WHERE source=? AND event_id=?").run(source,event.eventId);
          markProjected(event,source,at); return "applied";
        }
        const baseline = { ...event, amountUsd: prior.amount_usd, priceUsd: prior.price_usd, marketCapUsd: prior.market_cap_usd,
          collectedAt: prior.collected_at, executionBasis: null };
        database.prepare(`INSERT OR IGNORE INTO trader_execution_revisions(source,event_id,revision,fingerprint,payload,recorded_at)
          VALUES(?,?,0,?,?,?)`).run(source,event.eventId,hash(baseline),JSON.stringify(baseline),at);
        const revision = (head?.revision ?? 0) + 1;
        database.prepare(`INSERT INTO trader_execution_revisions(source,event_id,revision,fingerprint,payload,recorded_at)
          VALUES(?,?,?,?,?,?)`).run(source,event.eventId,revision,fingerprint,JSON.stringify({ ...event, executionBasis: basis }),at);
        database.prepare(`UPDATE trader_events SET amount_usd=?,price_usd=?,market_cap_usd=COALESCE(?,market_cap_usd),collected_at=MAX(collected_at,?)
          WHERE event_id=?`).run(basis.amountUsd,basis.priceUsd,event.marketCapUsd,event.collectedAt,event.eventId);
        database.prepare("UPDATE raw_trader_observations SET amount_usd=?,payload=?,recorded_at=MAX(recorded_at,?) WHERE observation_id=?")
          .run(basis.amountUsd,JSON.stringify(event),event.collectedAt,observationId);
        database.prepare("UPDATE canonical_trader_events SET amount_usd=?,updated_at=MAX(updated_at,?) WHERE canonical_event_id=?")
          .run(basis.amountUsd,at,canonicalId);
        database.prepare("UPDATE address_signal_evidence SET amount_usd=? WHERE event_id=? AND entity_id=?")
          .run(basis.amountUsd,event.eventId,event.entityId);
        database.prepare(`INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES(?,?,?,?,?)
          ON CONFLICT(chain,token_address,observed_at,source) DO UPDATE SET price_usd=excluded.price_usd`)
          .run(chainOf(event.chain),addressOf(event.chain,event.tokenAddress),event.occurredAt,basis.priceUsd,"trader_event:onchain_wallet");
        database.prepare(`UPDATE trader_execution_heads SET revision=?,fingerprint=?,projection_state='applied'
          WHERE source=? AND event_id=?`).run(revision,fingerprint,source,event.eventId);
        const tokenId = `${chainOf(event.chain)}:${addressOf(event.chain,event.tokenAddress)}`;
        for (const consumer of ["ability_evaluation","candidate_evidence","event_projection","signal_projection","token_aggregation"]) {
          database.prepare(`INSERT INTO execution_revision_requests(source,event_id,consumer_type,subject_key,entity_id,token_id,desired_revision,requested_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source,event_id,consumer_type) DO UPDATE SET
            desired_revision=excluded.desired_revision,requested_at=excluded.requested_at,last_outcome='pending'`)
            .run(source,event.eventId,consumer,consumer === "ability_evaluation" ? event.entityId : consumer === "event_projection" ? event.eventId : tokenId,
              event.entityId,tokenId,revision,at);
        }
        markProjected(event,source,at); return "applied";
      });
    },
  });
}

const executionContext = new AsyncLocalStorage<ReadonlyMap<string,number>>();
export function executionRevisionForDemand(consumerId: string, purchaseId: string): number | null {
  return executionContext.getStore()?.get(JSON.stringify([consumerId,purchaseId])) ?? null;
}
export function withExecutionRevisionContext<T>(database: DatabaseSync, entityId: string, asOf: number, operation: () => T): T {
  const rows = database.prepare(`SELECT h.event_id,SUM(h.revision) revision FROM trader_execution_heads h
    JOIN wallet_monitor_observations w ON w.source=h.source AND w.event_id=h.event_id
    WHERE h.entity_id=? AND h.projection_state='applied' AND h.revision>0 AND h.last_observed_at<=? AND w.orphaned_at IS NULL
    GROUP BY h.event_id`).all(entityId,asOf);
  const revisions = new Map(rows.map(r => [JSON.stringify([entityId,String(r.event_id)]),Number(r.revision)]));
  return executionContext.run(revisions,operation);
}
