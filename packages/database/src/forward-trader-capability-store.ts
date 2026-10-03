import { createHash } from "node:crypto";
import { FORWARD_TRADER_CAPABILITY_VERSION, FORWARD_OPPORTUNITY_WINDOW_MS,
  type ForwardTraderCapabilityFact, type ForwardTraderCapabilityProjection } from "@address-radar/domain";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL = `
CREATE TABLE forward_trader_projection_locks (
  entity_id text NOT NULL, generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  PRIMARY KEY(entity_id,generation_id)
);
CREATE TABLE forward_trader_capability_versions (
  version_id text PRIMARY KEY, entity_id text NOT NULL, generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  strategy_version text NOT NULL, input_fingerprint text NOT NULL, as_of bigint NOT NULL,
  stable_capability boolean NOT NULL, hit_3x_tokens integer NOT NULL, hit_5x_tokens integer NOT NULL, payload text NOT NULL,
  UNIQUE(entity_id,generation_id,strategy_version,input_fingerprint),
  CHECK(hit_3x_tokens>=hit_5x_tokens AND hit_5x_tokens>=0),
  CHECK(stable_capability=(hit_3x_tokens>=3 OR hit_5x_tokens>=2))
);
CREATE TABLE forward_trader_capability_heads (
  entity_id text NOT NULL, generation_id text NOT NULL, strategy_version text NOT NULL,
  version_id text NOT NULL REFERENCES forward_trader_capability_versions(version_id), head_generation bigint NOT NULL,
  evaluated_at bigint NOT NULL, PRIMARY KEY(entity_id,generation_id,strategy_version)
);
CREATE TABLE forward_trader_capability_intents (
  intent_id text PRIMARY KEY, entity_id text NOT NULL, generation_id text NOT NULL, strategy_version text NOT NULL,
  head_generation bigint NOT NULL, version_id text NOT NULL REFERENCES forward_trader_capability_versions(version_id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched')), created_at bigint NOT NULL,
  UNIQUE(entity_id,generation_id,strategy_version,head_generation)
);
`;
function id(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Forward capability identity is invalid");
}
function clock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Forward capability timestamp is invalid");
}

export function createPostgresForwardTraderCapabilityRepository(transaction: PostgresTransaction) {
  return Object.freeze({
    async load(input: { readonly entityId: string; readonly generationId: string; readonly asOf: number; readonly maximumSamples: number }) {
      [input.entityId, input.generationId].forEach(id); clock(input.asOf);
      if (!Number.isSafeInteger(input.maximumSamples) || input.maximumSamples < 1 || input.maximumSamples > 10000) {
        throw new Error("Forward capability sample budget must be between 1 and 10000");
      }
      const generation = await transaction.query("SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1", [input.generationId]);
      const activatedAt = Number(generation.rows[0]?.activated_at);
      clock(activatedAt);
      if (activatedAt > input.asOf) throw new Error("Forward capability generation is not active");
      await transaction.query("INSERT INTO forward_trader_projection_locks(entity_id,generation_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [input.entityId, input.generationId]);
      await transaction.query("SELECT entity_id FROM forward_trader_projection_locks WHERE entity_id=$1 AND generation_id=$2 FOR UPDATE",
        [input.entityId, input.generationId]);
      const rows = await transaction.query(`SELECT s.*,r.amount_usd::text AS amount_usd,r.amount_estimated,
        r.entry_price_usd::text AS entry_price_usd,r.execution_evidence_ref,r.ownership_evidence_ref,r.state AS revision_state,
        e.evaluation_id,e.payload AS evaluation_payload,p.payload AS peak_payload,
        hit.occurred_at AS screening_observed_at,wi.created_at AS screening_known_at,mi.evidence_ref AS screening_ref
        FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
        LEFT JOIN forward_opportunity_heads h ON h.sample_id=s.sample_id
        LEFT JOIN forward_opportunity_evaluations e ON e.evaluation_id=h.evaluation_id
        LEFT JOIN forward_peak_evidence p ON p.peak_id=e.peak_id AND p.revision_id=e.peak_revision_id
        LEFT JOIN forward_token_milestone_hits hit ON hit.generation_id=s.generation_id AND hit.chain=s.chain
          AND hit.token_address=s.token_address AND hit.threshold=100000
        LEFT JOIN forward_token_market_inputs mi ON mi.generation_id=hit.generation_id AND mi.chain=hit.chain
          AND mi.token_address=hit.token_address AND mi.source_event_id=hit.source_event_id AND mi.market_cap_usd>=100000
        LEFT JOIN forward_token_watch_intents wi ON wi.generation_id=hit.generation_id AND wi.chain=hit.chain
          AND wi.token_address=hit.token_address AND wi.event_key='milestone:100000' AND wi.purpose='screening'
        WHERE s.entity_id=$1 AND s.generation_id=$2 AND s.occurred_at>=$3 AND s.occurred_at<=$4 AND s.created_at<=$4
        ORDER BY s.sample_id LIMIT $5 FOR SHARE OF s`,
      [input.entityId, input.generationId, Math.max(activatedAt, input.asOf - FORWARD_OPPORTUNITY_WINDOW_MS), input.asOf, input.maximumSamples + 1]);
      if (rows.rows.length > input.maximumSamples) return { status: "deferred" as const, reasonCode: "capability_sample_budget_exceeded" };
      const facts: ForwardTraderCapabilityFact[] = rows.rows.map(row => ({ generationId: String(row.generation_id),
        sampleCreatedAt: Number(row.created_at), sample: { sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint),
          entityId: String(row.entity_id), chain: String(row.chain), tokenAddress: String(row.token_address), boughtAt: Number(row.occurred_at),
          amountUsd: String(row.amount_usd), amountEstimated: row.amount_estimated === true,
          entryPriceUsd: row.entry_price_usd === null ? null : String(row.entry_price_usd),
          entryBasisVerified: row.revision_state === "original" && Boolean(row.execution_evidence_ref) && Boolean(row.ownership_evidence_ref),
          executionEvidenceRef: row.execution_evidence_ref === null ? null : String(row.execution_evidence_ref) },
        evaluationId: row.evaluation_id === null ? null : String(row.evaluation_id),
        evaluation: typeof row.evaluation_payload === "string" ? JSON.parse(row.evaluation_payload) as ForwardTraderCapabilityFact["evaluation"] : null,
        peak: typeof row.peak_payload === "string" ? JSON.parse(row.peak_payload) as ForwardTraderCapabilityFact["peak"] : null,
        screening: row.screening_observed_at !== null && row.screening_known_at !== null && typeof row.screening_ref === "string"
          ? { observedAt: Number(row.screening_observed_at), knownAt: Number(row.screening_known_at), evidenceRef: row.screening_ref } : null }));
      return { status: "loaded" as const, activatedAt, facts };
    },
    async save(projection: ForwardTraderCapabilityProjection, basisFingerprint: string) {
      [projection.entityId, projection.generationId, basisFingerprint].forEach(id); clock(projection.asOf);
      const metrics = projection.metrics;
      if (projection.strategyVersion !== FORWARD_TRADER_CAPABILITY_VERSION || Object.values(metrics).some(value => !Number.isSafeInteger(value) || value < 0)
        || metrics.hit5xTokens > metrics.hit3xTokens || metrics.hit3xTokens > metrics.screeningReadyTokens
        || metrics.screeningReadyTokens > metrics.distinctTokens || metrics.distinctTokens > metrics.samples
        || projection.stableCapability !== (metrics.hit3xTokens >= 3 || metrics.hit5xTokens >= 2)) {
        throw new Error("Forward capability projection violates its approved predicates");
      }
      const lock = await transaction.query("SELECT entity_id FROM forward_trader_projection_locks WHERE entity_id=$1 AND generation_id=$2 FOR UPDATE",
        [projection.entityId, projection.generationId]);
      if (!lock.rows[0]) throw new Error("Forward capability facts must be loaded before saving");
      const key = [projection.entityId, projection.generationId, projection.strategyVersion];
      const previous = await transaction.query("SELECT * FROM forward_trader_capability_heads WHERE entity_id=$1 AND generation_id=$2 AND strategy_version=$3 FOR UPDATE", key);
      const head = previous.rows[0];
      if (head && Number(head.evaluated_at) > projection.asOf) return { status: "stale_decision" as const, versionId: null, headGeneration: null };
      const { asOf: _asOf, cohortStart: _start, cohortEnd: _end, ...semantic } = projection;
      const fingerprint = createHash("sha256").update(JSON.stringify({ basisFingerprint, semantic })).digest("hex");
      const versionId = createHash("sha256").update(JSON.stringify([...key, fingerprint])).digest("hex");
      if (head?.version_id === versionId) {
        await transaction.query("UPDATE forward_trader_capability_heads SET evaluated_at=$4 WHERE entity_id=$1 AND generation_id=$2 AND strategy_version=$3",
          [...key, projection.asOf]);
        return { status: "unchanged" as const, versionId, headGeneration: Number(head.head_generation) };
      }
      const headGeneration = head ? Number(head.head_generation) + 1 : 1;
      if (!Number.isSafeInteger(headGeneration)) throw new Error("Forward capability head generation is unsafe");
      await transaction.query(`INSERT INTO forward_trader_capability_versions(version_id,entity_id,generation_id,strategy_version,input_fingerprint,as_of,
        stable_capability,hit_3x_tokens,hit_5x_tokens,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [versionId, ...key, fingerprint, projection.asOf, projection.stableCapability, metrics.hit3xTokens, metrics.hit5xTokens, JSON.stringify(projection)]);
      await transaction.query(`INSERT INTO forward_trader_capability_heads(entity_id,generation_id,strategy_version,version_id,head_generation,evaluated_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(entity_id,generation_id,strategy_version) DO UPDATE SET
        version_id=EXCLUDED.version_id,head_generation=EXCLUDED.head_generation,evaluated_at=EXCLUDED.evaluated_at`,
      [...key, versionId, headGeneration, projection.asOf]);
      const intentId = createHash("sha256").update(JSON.stringify([...key, headGeneration])).digest("hex");
      await transaction.query(`INSERT INTO forward_trader_capability_intents(intent_id,entity_id,generation_id,strategy_version,head_generation,version_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [intentId, ...key, headGeneration, versionId, projection.asOf]);
      return { status: "projected" as const, versionId, headGeneration };
    },
  });
}
