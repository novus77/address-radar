import { createHash } from "node:crypto";
import { FORWARD_TRADER_CAPABILITY_VERSION, forwardEvidenceIdentifier, forwardEvidenceTime } from "@address-radar/domain";
import { FORWARD_PURCHASE_WINDOW_MS } from "./postgres-forward-purchases.js";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_FORWARD_TRADER_CAPABILITY_WORK_SCHEMA_SQL = `
CREATE TABLE forward_capability_requests (
  entity_id text NOT NULL, generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  strategy_version text NOT NULL, request_key text NOT NULL, source_kind text NOT NULL,
  source_key text NOT NULL, requested_at bigint NOT NULL,
  PRIMARY KEY(entity_id,generation_id,strategy_version,request_key)
);
CREATE TABLE forward_capability_jobs (
  entity_id text NOT NULL, generation_id text NOT NULL, strategy_version text NOT NULL,
  latest_request_key text NOT NULL, request_generation integer NOT NULL CHECK(request_generation>0),
  claim_generation integer NOT NULL DEFAULT 0, latest_requested_at bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','leased','completed')),
  next_attempt_at bigint NOT NULL, lease_owner text, lease_expires_at bigint, reason_code text, completed_at bigint,
  PRIMARY KEY(entity_id,generation_id,strategy_version),
  FOREIGN KEY(entity_id,generation_id,strategy_version,latest_request_key)
    REFERENCES forward_capability_requests(entity_id,generation_id,strategy_version,request_key)
);
CREATE INDEX forward_capability_jobs_due ON forward_capability_jobs(next_attempt_at,entity_id)
  WHERE status IN ('pending','leased');
CREATE TABLE forward_capability_wake_links (
  source_kind text NOT NULL, source_key text NOT NULL, entity_id text NOT NULL, generation_id text NOT NULL,
  strategy_version text NOT NULL, request_key text NOT NULL, scheduled_at bigint NOT NULL,
  PRIMARY KEY(source_kind,source_key,entity_id,generation_id,strategy_version),
  FOREIGN KEY(entity_id,generation_id,strategy_version,request_key)
    REFERENCES forward_capability_requests(entity_id,generation_id,strategy_version,request_key)
);
CREATE TABLE forward_trader_capability_work_receipts (
  entity_id text NOT NULL, generation_id text NOT NULL, strategy_version text NOT NULL,
  request_generation integer NOT NULL, request_key text NOT NULL,
  version_id text NOT NULL REFERENCES forward_trader_capability_versions(version_id),
  head_generation bigint NOT NULL, committed_at bigint NOT NULL,
  PRIMARY KEY(entity_id,generation_id,strategy_version,request_generation),
  FOREIGN KEY(entity_id,generation_id,strategy_version,request_key)
    REFERENCES forward_capability_requests(entity_id,generation_id,strategy_version,request_key)
);
CREATE TABLE forward_capability_reconcile_cursors (
  generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id), strategy_version text NOT NULL,
  last_entity_id text, next_cycle_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(generation_id,strategy_version)
);
`;

export interface ForwardTraderCapabilityLease {
  readonly entityId: string;
  readonly generationId: string;
  readonly strategyVersion: typeof FORWARD_TRADER_CAPABILITY_VERSION;
  readonly requestKey: string;
  readonly requestGeneration: number;
  readonly claimGeneration: number;
  readonly owner: string;
  readonly leaseExpiresAt: number;
}
export class ForwardTraderCapabilityLeaseLostError extends Error {
  constructor() { super("Forward capability lease lost"); this.name = "ForwardTraderCapabilityLeaseLostError"; }
}
type SourceKind = "sample" | "opportunity" | "screening" | "cohort";
function positive(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid capability work budget");
}
function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid capability work integer");
  return parsed;
}
function requestKey(kind: SourceKind, key: string): string {
  return createHash("sha256").update(JSON.stringify([kind, key])).digest("hex");
}

export function createPostgresForwardTraderCapabilityWorkRepository(transaction: PostgresTransaction) {
  const version = FORWARD_TRADER_CAPABILITY_VERSION;
  const request = async (input: {
    readonly entityId: string; readonly generationId: string; readonly sourceKind: SourceKind;
    readonly sourceKey: string; readonly now: number;
  }) => {
    forwardEvidenceIdentifier(input.entityId); forwardEvidenceIdentifier(input.generationId); forwardEvidenceTime(input.now);
    if (!["sample", "opportunity", "screening", "cohort"].includes(input.sourceKind) || input.sourceKey.length < 1 || input.sourceKey.length > 4096) {
      throw new Error("Invalid capability wake source");
    }
    const subject = await transaction.query(`SELECT 1 FROM forward_strategy_generations g WHERE g.generation_id=$1 AND g.activated_at<=$3
      AND (EXISTS(SELECT 1 FROM forward_purchase_samples s WHERE s.generation_id=g.generation_id AND s.entity_id=$2 AND s.created_at<=$3)
        OR EXISTS(SELECT 1 FROM forward_trader_capability_heads h WHERE h.generation_id=g.generation_id AND h.entity_id=$2 AND h.strategy_version=$4))`,
    [input.generationId, input.entityId, input.now, version]);
    if (!subject.rowCount) throw new Error("Unknown capability subject");
    const key = requestKey(input.sourceKind, input.sourceKey);
    const recorded = await transaction.query(`INSERT INTO forward_capability_requests
      (entity_id,generation_id,strategy_version,request_key,source_kind,source_key,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT DO NOTHING`, [input.entityId, input.generationId, version, key, input.sourceKind, input.sourceKey, input.now]);
    if (!recorded.rowCount) return { status: "duplicate" as const, requestKey: key };
    const scheduled = await transaction.query(`INSERT INTO forward_capability_jobs
      (entity_id,generation_id,strategy_version,latest_request_key,request_generation,latest_requested_at,status,next_attempt_at)
      VALUES($1,$2,$3,$4,1,$5,'pending',$5)
      ON CONFLICT(entity_id,generation_id,strategy_version) DO UPDATE SET
      latest_request_key=excluded.latest_request_key, request_generation=forward_capability_jobs.request_generation+1,
      latest_requested_at=excluded.latest_requested_at,status='pending',next_attempt_at=excluded.next_attempt_at,
      lease_owner=NULL,lease_expires_at=NULL,reason_code=NULL,completed_at=NULL
      WHERE forward_capability_jobs.latest_requested_at<=excluded.latest_requested_at`,
    [input.entityId, input.generationId, version, key, input.now]);
    return { status: scheduled.rowCount ? "scheduled" as const : "stale_request" as const, requestKey: key };
  };
  const scheduleSources = async (kind: Exclude<SourceKind, "cohort">, now: number, limit: number): Promise<number> => {
    forwardEvidenceTime(now); positive(limit, 1000);
    const joins = kind === "sample"
      ? `forward_sample_work_intents i JOIN forward_purchase_samples s ON s.sample_id=i.sample_id AND s.execution_fingerprint=i.execution_fingerprint`
      : kind === "opportunity"
        ? `forward_opportunity_intents i JOIN forward_opportunity_evaluations e ON e.evaluation_id=i.evaluation_id
           JOIN forward_opportunity_heads h ON h.evaluation_id=e.evaluation_id AND h.sample_id=e.sample_id
           JOIN forward_purchase_samples s ON s.sample_id=e.sample_id AND s.execution_fingerprint=e.execution_fingerprint`
        : `forward_token_watch_intents i JOIN forward_purchase_samples s ON s.generation_id=i.generation_id AND s.chain=i.chain AND s.token_address=i.token_address
           JOIN forward_token_milestone_hits m ON m.generation_id=i.generation_id AND m.chain=i.chain AND m.token_address=i.token_address AND m.threshold=100000
           JOIN forward_token_market_inputs p ON p.generation_id=m.generation_id AND p.chain=m.chain AND p.token_address=m.token_address AND p.source_event_id=m.source_event_id`;
    const sourceKeySql = kind === "opportunity" ? "i.intent_id" : kind === "sample"
      ? "json_build_array(s.sample_id,s.execution_fingerprint)::text"
      : "json_build_array(i.event_key,s.sample_id,s.execution_fingerprint)::text";
    const guard = kind === "opportunity" ? "AND e.computed_at<=$1" : kind === "screening"
      ? "AND i.purpose='screening' AND i.event_key='milestone:100000' AND p.market_cap_usd>=100000 AND p.occurred_at<=$1" : "";
    // Source transport status belongs to other consumers; capability owns only its wake links.
    const selected = await transaction.query(`SELECT s.entity_id,s.generation_id,${sourceKeySql} AS source_key FROM ${joins}
      JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
      WHERE i.created_at<=$1 AND s.created_at<=$1 AND s.occurred_at<=$1
        AND s.occurred_at>=g.activated_at AND s.occurred_at>=GREATEST(0,$1::bigint-$4::bigint) ${guard}
        AND NOT EXISTS(SELECT 1 FROM forward_capability_wake_links w WHERE w.source_kind='${kind}' AND w.source_key=${sourceKeySql}
          AND w.entity_id=s.entity_id AND w.generation_id=s.generation_id AND w.strategy_version=$2)
      ORDER BY i.created_at,s.entity_id,s.generation_id,s.sample_id LIMIT $3 FOR UPDATE OF i SKIP LOCKED`,
    [now, version, limit, FORWARD_PURCHASE_WINDOW_MS]);
    for (const row of selected.rows) {
      const input = { entityId: String(row.entity_id), generationId: String(row.generation_id), sourceKind: kind, sourceKey: String(row.source_key), now };
      const result = await request(input);
      await transaction.query(`INSERT INTO forward_capability_wake_links
        (source_kind,source_key,entity_id,generation_id,strategy_version,request_key,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT DO NOTHING`, [kind, input.sourceKey, input.entityId, input.generationId, version, result.requestKey, now]);
    }
    return selected.rows.length;
  };
  const leaseValues = (lease: ForwardTraderCapabilityLease, now: number) => {
    forwardEvidenceIdentifier(lease.entityId); forwardEvidenceIdentifier(lease.generationId); forwardEvidenceIdentifier(lease.owner);
    forwardEvidenceIdentifier(lease.requestKey); forwardEvidenceTime(now); forwardEvidenceTime(lease.leaseExpiresAt);
    positive(lease.requestGeneration); positive(lease.claimGeneration);
    if (lease.strategyVersion !== version) throw new ForwardTraderCapabilityLeaseLostError();
    return [lease.entityId, lease.generationId, version, lease.requestKey, lease.requestGeneration, lease.claimGeneration, lease.owner, lease.leaseExpiresAt, now];
  };
  const owned = async (lease: ForwardTraderCapabilityLease, now: number, lock: boolean) => {
    const result = await transaction.query(`SELECT j.* FROM forward_capability_jobs j WHERE
      entity_id=$1 AND generation_id=$2 AND strategy_version=$3 AND latest_request_key=$4 AND request_generation=$5
      AND claim_generation=$6 AND lease_owner=$7 AND lease_expires_at=$8 AND lease_expires_at>$9 AND status='leased'
      ${lock ? "FOR UPDATE" : ""}`, leaseValues(lease, now));
    if (!result.rowCount) throw new ForwardTraderCapabilityLeaseLostError();
    return result.rows[0]!;
  };
  return Object.freeze({
    request,
    scheduleSamples: (now: number, limit: number) => scheduleSources("sample", now, limit),
    scheduleOpportunities: (now: number, limit: number) => scheduleSources("opportunity", now, limit),
    scheduleScreening: (now: number, limit: number) => scheduleSources("screening", now, limit),
    async reconcile(input: { readonly generationId: string; readonly now: number; readonly limit: number; readonly intervalMs: number }) {
      forwardEvidenceIdentifier(input.generationId); forwardEvidenceTime(input.now); positive(input.limit, 1000); positive(input.intervalMs);
      const nextCycleAt = input.now + input.intervalMs; forwardEvidenceTime(nextCycleAt);
      await transaction.query(`INSERT INTO forward_capability_reconcile_cursors(generation_id,strategy_version)
        SELECT generation_id,$2 FROM forward_strategy_generations WHERE generation_id=$1 AND activated_at<=$3 ON CONFLICT DO NOTHING`,
      [input.generationId, version, input.now]);
      const cursor = (await transaction.query(`SELECT * FROM forward_capability_reconcile_cursors WHERE generation_id=$1 AND strategy_version=$2 FOR UPDATE`,
        [input.generationId, version])).rows[0];
      if (!cursor) throw new Error("Unknown capability generation");
      if (number(cursor.next_cycle_at) > input.now) return { scheduled: 0, more: false, nextCycleAt: number(cursor.next_cycle_at) };
      const subjects = await transaction.query(`SELECT entity_id FROM (
        SELECT entity_id FROM forward_purchase_samples WHERE generation_id=$1 AND created_at<=$3
        UNION SELECT entity_id FROM forward_trader_capability_heads WHERE generation_id=$1 AND strategy_version=$2
      ) subjects WHERE ($4::text IS NULL OR entity_id COLLATE "C">$4::text COLLATE "C")
      ORDER BY entity_id COLLATE "C" LIMIT $5`, [input.generationId, version, input.now, cursor.last_entity_id, input.limit + 1]);
      const page = subjects.rows.slice(0, input.limit); const more = subjects.rows.length > input.limit;
      const key = JSON.stringify([input.intervalMs, Math.floor(input.now / input.intervalMs)]);
      let scheduled = 0;
      for (const row of page) {
        const result = await request({ entityId: String(row.entity_id), generationId: input.generationId, sourceKind: "cohort", sourceKey: key, now: input.now });
        if (result.status === "scheduled") scheduled++;
      }
      await transaction.query(`UPDATE forward_capability_reconcile_cursors SET last_entity_id=$3,next_cycle_at=$4 WHERE generation_id=$1 AND strategy_version=$2`,
        [input.generationId, version, more ? String(page.at(-1)!.entity_id) : null, more ? number(cursor.next_cycle_at) : nextCycleAt]);
      return { scheduled, more, nextCycleAt: more ? number(cursor.next_cycle_at) : nextCycleAt };
    },
    async claim(input: { readonly owner: string; readonly now: number; readonly leaseMs: number }): Promise<ForwardTraderCapabilityLease | null> {
      forwardEvidenceIdentifier(input.owner); forwardEvidenceTime(input.now); positive(input.leaseMs);
      const expires = input.now + input.leaseMs; forwardEvidenceTime(expires);
      const result = await transaction.query(`WITH due AS (
        SELECT entity_id,generation_id,strategy_version FROM forward_capability_jobs WHERE strategy_version=$1
          AND ((status='pending' AND next_attempt_at<=$2) OR (status='leased' AND lease_expires_at<=$2))
        ORDER BY next_attempt_at,latest_requested_at,entity_id,generation_id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE forward_capability_jobs j SET status='leased',lease_owner=$3,lease_expires_at=$4,claim_generation=j.claim_generation+1
        FROM due WHERE j.entity_id=due.entity_id AND j.generation_id=due.generation_id AND j.strategy_version=due.strategy_version RETURNING j.*`,
      [version, input.now, input.owner, expires]);
      const row = result.rows[0]; if (!row) return null;
      return { entityId: String(row.entity_id), generationId: String(row.generation_id), strategyVersion: version,
        requestKey: String(row.latest_request_key), requestGeneration: number(row.request_generation), claimGeneration: number(row.claim_generation),
        owner: input.owner, leaseExpiresAt: expires };
    },
    preflight: (lease: ForwardTraderCapabilityLease, now: number) => owned(lease, now, false),
    async complete(lease: ForwardTraderCapabilityLease, input: { readonly versionId: string; readonly headGeneration: number; readonly now: number }) {
      forwardEvidenceIdentifier(input.versionId); positive(input.headGeneration);
      const job = await owned(lease, input.now, true);
      const head = await transaction.query(`SELECT 1 FROM forward_trader_capability_heads WHERE entity_id=$1 AND generation_id=$2 AND strategy_version=$3
        AND version_id=$4 AND head_generation=$5 AND evaluated_at BETWEEN $6 AND $7`,
      [lease.entityId, lease.generationId, version, input.versionId, input.headGeneration, number(job.latest_requested_at), input.now]);
      if (!head.rowCount) throw new Error("Capability receipt has no current projection");
      await transaction.query(`INSERT INTO forward_trader_capability_work_receipts
        (entity_id,generation_id,strategy_version,request_generation,request_key,version_id,head_generation,committed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [lease.entityId, lease.generationId, version, lease.requestGeneration, lease.requestKey, input.versionId, input.headGeneration, input.now]);
      await transaction.query(`UPDATE forward_capability_jobs SET status='completed',completed_at=$4,lease_owner=NULL,lease_expires_at=NULL,reason_code=NULL
        WHERE entity_id=$1 AND generation_id=$2 AND strategy_version=$3`, [lease.entityId, lease.generationId, version, input.now]);
    },
    async defer(lease: ForwardTraderCapabilityLease, input: { readonly now: number; readonly retryAt: number; readonly reasonCode: string }) {
      forwardEvidenceTime(input.retryAt); forwardEvidenceIdentifier(input.reasonCode);
      if (input.retryAt <= input.now) throw new Error("Invalid capability retry time");
      await owned(lease, input.now, true);
      await transaction.query(`UPDATE forward_capability_jobs SET status='pending',next_attempt_at=$4,reason_code=$5,lease_owner=NULL,lease_expires_at=NULL
        WHERE entity_id=$1 AND generation_id=$2 AND strategy_version=$3`, [lease.entityId, lease.generationId, version, input.retryAt, input.reasonCode]);
    },
  });
}
