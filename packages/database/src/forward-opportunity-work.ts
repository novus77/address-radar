import { createHash } from "node:crypto";
import { FORWARD_OPPORTUNITY_EVIDENCE_VERSION } from "@address-radar/domain";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL = `
CREATE TABLE forward_opportunity_requests (
  sample_id text NOT NULL REFERENCES forward_purchase_samples(sample_id), execution_fingerprint text NOT NULL,
  strategy_version text NOT NULL, request_key text NOT NULL, requested_at bigint NOT NULL,
  PRIMARY KEY(sample_id,execution_fingerprint,strategy_version,request_key)
);
CREATE TABLE forward_opportunity_jobs (
  sample_id text NOT NULL, execution_fingerprint text NOT NULL, strategy_version text NOT NULL,
  latest_request_key text NOT NULL, request_generation integer NOT NULL CHECK(request_generation>0),
  claim_generation integer NOT NULL DEFAULT 0, status text NOT NULL CHECK(status IN ('pending','leased','completed','superseded')),
  next_attempt_at bigint NOT NULL, lease_owner text, lease_expires_at bigint, reason_code text, completed_at bigint,
  PRIMARY KEY(sample_id,execution_fingerprint,strategy_version),
  FOREIGN KEY(sample_id,execution_fingerprint,strategy_version,latest_request_key)
    REFERENCES forward_opportunity_requests(sample_id,execution_fingerprint,strategy_version,request_key)
);
CREATE INDEX forward_opportunity_jobs_due ON forward_opportunity_jobs(next_attempt_at,sample_id)
  WHERE status IN ('pending','leased');
CREATE TABLE forward_opportunity_work_receipts (
  sample_id text NOT NULL, execution_fingerprint text NOT NULL, strategy_version text NOT NULL,
  request_generation integer NOT NULL, request_key text NOT NULL,
  evaluation_id text NOT NULL REFERENCES forward_opportunity_evaluations(evaluation_id), committed_at bigint NOT NULL,
  PRIMARY KEY(sample_id,execution_fingerprint,strategy_version,request_generation),
  FOREIGN KEY(sample_id,execution_fingerprint,strategy_version,request_key)
    REFERENCES forward_opportunity_requests(sample_id,execution_fingerprint,strategy_version,request_key)
);
`;

export interface ForwardOpportunityLease {
  readonly sampleId: string;
  readonly executionFingerprint: string;
  readonly strategyVersion: typeof FORWARD_OPPORTUNITY_EVIDENCE_VERSION;
  readonly owner: string;
  readonly requestGeneration: number;
  readonly claimGeneration: number;
  readonly leaseExpiresAt: number;
}
export type ForwardOpportunityTrigger = { readonly kind: "sample_created" }
  | { readonly kind: "peak_revision"; readonly peakId: string; readonly revisionId: string };

export class ForwardOpportunityLeaseLostError extends Error {
  constructor() { super("Opportunity work lease is expired, replaced or owned by another worker"); }
}
function id(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Opportunity work identity is invalid");
}
function clock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Opportunity work timestamp is invalid");
}

export function createPostgresForwardOpportunityWorkRepository(transaction: PostgresTransaction) {
  const version = FORWARD_OPPORTUNITY_EVIDENCE_VERSION;
  async function owned(lease: ForwardOpportunityLease, now: number) {
    [lease.sampleId, lease.executionFingerprint, lease.owner].forEach(id); clock(now);
    if (lease.strategyVersion !== version || !Number.isSafeInteger(lease.requestGeneration) || lease.requestGeneration < 1
      || !Number.isSafeInteger(lease.claimGeneration) || lease.claimGeneration < 1) throw new Error("Opportunity lease version is invalid");
    clock(lease.leaseExpiresAt);
    const result = await transaction.query(`SELECT * FROM forward_opportunity_jobs
      WHERE sample_id=$1 AND execution_fingerprint=$2 AND strategy_version=$3 AND status='leased'
      AND lease_owner=$4 AND request_generation=$5 AND claim_generation=$6
      AND lease_expires_at=$7 AND lease_expires_at>$8 FOR UPDATE`,
    [lease.sampleId, lease.executionFingerprint, version, lease.owner, lease.requestGeneration,
      lease.claimGeneration, lease.leaseExpiresAt, now]);
    if (!result.rows[0]) throw new ForwardOpportunityLeaseLostError();
    return result.rows[0];
  }
  async function request(input: { readonly sampleId: string; readonly executionFingerprint: string;
    readonly trigger: ForwardOpportunityTrigger; readonly requestedAt: number }) {
    [input.sampleId, input.executionFingerprint].forEach(id); clock(input.requestedAt);
    // All result writers acquire the sample before the work row to keep lock order consistent.
    const samples = await transaction.query("SELECT * FROM forward_purchase_samples WHERE sample_id=$1 FOR UPDATE", [input.sampleId]);
    const sample = samples.rows[0];
    if (!sample || sample.execution_fingerprint !== input.executionFingerprint) return "stale_execution" as const;
    if (input.requestedAt < Number(sample.occurred_at)) throw new Error("Opportunity request predates purchase");
    let triggerKey: readonly string[];
    if (input.trigger.kind === "sample_created") {
      const source = await transaction.query("SELECT sample_id FROM forward_sample_work_intents WHERE sample_id=$1 AND execution_fingerprint=$2",
        [input.sampleId, input.executionFingerprint]);
      if (!source.rows[0]) throw new Error("Opportunity sample work intent missing");
      triggerKey = ["sample_created"];
    } else if (input.trigger.kind === "peak_revision") {
      [input.trigger.peakId, input.trigger.revisionId].forEach(id);
      const source = await transaction.query(`SELECT peak_id FROM forward_peak_evidence WHERE peak_id=$1 AND revision_id=$2
        AND chain=$3 AND token_address=$4 AND known_at<=$5 AND observed_until>=$6 AND observed_from<$7`,
      [input.trigger.peakId, input.trigger.revisionId, sample.chain, sample.token_address, input.requestedAt,
        sample.occurred_at, sample.expires_at]);
      if (!source.rows[0]) throw new Error("Opportunity peak trigger is unavailable or unrelated to sample");
      triggerKey = ["peak_revision", input.trigger.peakId, input.trigger.revisionId];
    } else { throw new Error("Unknown opportunity request trigger"); }
    const key = createHash("sha256").update(JSON.stringify(triggerKey)).digest("hex");
    const inserted = await transaction.query(`INSERT INTO forward_opportunity_requests(sample_id,execution_fingerprint,strategy_version,request_key,requested_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING request_key`,
    [input.sampleId, input.executionFingerprint, version, key, input.requestedAt]);
    if (inserted.rows[0]) {
      await transaction.query(`UPDATE forward_opportunity_jobs SET status='superseded',reason_code='execution_replaced',lease_owner=NULL,lease_expires_at=NULL
        WHERE sample_id=$1 AND execution_fingerprint<>$2 AND status IN ('pending','leased')`, [input.sampleId, input.executionFingerprint]);
      await transaction.query(`INSERT INTO forward_opportunity_jobs(sample_id,execution_fingerprint,strategy_version,latest_request_key,
        request_generation,status,next_attempt_at) VALUES($1,$2,$3,$4,1,'pending',$5)
        ON CONFLICT(sample_id,execution_fingerprint,strategy_version) DO UPDATE SET
          latest_request_key=EXCLUDED.latest_request_key,request_generation=forward_opportunity_jobs.request_generation+1,
          status='pending',next_attempt_at=EXCLUDED.next_attempt_at,lease_owner=NULL,lease_expires_at=NULL,reason_code=NULL,completed_at=NULL`,
      [input.sampleId, input.executionFingerprint, version, key, input.requestedAt]);
    }
    if (input.trigger.kind === "sample_created") await transaction.query(`UPDATE forward_sample_work_intents SET status='dispatched'
      WHERE sample_id=$1 AND execution_fingerprint=$2`, [input.sampleId, input.executionFingerprint]);
    return inserted.rows[0] ? "scheduled" as const : "duplicate" as const;
  }
  return Object.freeze({
    request,
    async scheduleSamples(now: number, limit: number): Promise<number> {
      clock(now);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Opportunity admission batch must be between 1 and 1000");
      const pending = await transaction.query(`SELECT i.sample_id,i.execution_fingerprint FROM forward_sample_work_intents i
        JOIN forward_purchase_samples s USING(sample_id) WHERE i.status='pending' AND i.execution_fingerprint=s.execution_fingerprint
        AND s.occurred_at<=$1 ORDER BY i.created_at,i.sample_id FOR UPDATE OF s SKIP LOCKED LIMIT $2`, [now, limit]);
      let count = 0;
      for (const row of pending.rows) {
        if (await request({ sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint),
          trigger: { kind: "sample_created" }, requestedAt: now }) === "scheduled") count++;
      }
      return count;
    },
    async claim(input: { readonly owner: string; readonly now: number; readonly leaseMs: number }): Promise<ForwardOpportunityLease | null> {
      id(input.owner); clock(input.now);
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0 || !Number.isSafeInteger(input.now + input.leaseMs)) {
        throw new Error("Opportunity work lease duration is invalid");
      }
      const result = await transaction.query(`WITH due AS (
        SELECT sample_id,execution_fingerprint,strategy_version FROM forward_opportunity_jobs
        WHERE strategy_version=$1 AND ((status='pending' AND next_attempt_at<=$2) OR (status='leased' AND lease_expires_at<=$2))
        ORDER BY next_attempt_at,sample_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE forward_opportunity_jobs w SET status='leased',lease_owner=$3,claim_generation=w.claim_generation+1,lease_expires_at=$4
        FROM due WHERE w.sample_id=due.sample_id AND w.execution_fingerprint=due.execution_fingerprint
        AND w.strategy_version=due.strategy_version RETURNING w.*`, [version, input.now, input.owner, input.now + input.leaseMs]);
      const row = result.rows[0]; if (!row) return null;
      return Object.freeze({ sampleId: String(row.sample_id), executionFingerprint: String(row.execution_fingerprint),
        strategyVersion: version, owner: input.owner, requestGeneration: Number(row.request_generation),
        claimGeneration: Number(row.claim_generation), leaseExpiresAt: Number(row.lease_expires_at) });
    },
    assertOwned: owned,
    async complete(lease: ForwardOpportunityLease, evaluationId: string, now: number): Promise<void> {
      id(evaluationId);
      const row = await owned(lease, now);
      const result = await transaction.query(`SELECT evaluation_id FROM forward_opportunity_evaluations
        WHERE evaluation_id=$1 AND sample_id=$2 AND execution_fingerprint=$3 AND strategy_version=$4
        AND status IN ('hit','observing','excluded') AND computed_at<=$5`,
      [evaluationId, lease.sampleId, lease.executionFingerprint, version, now]);
      if (!result.rows[0]) throw new Error("Opportunity receipt requires its actual non-missing evaluation");
      await transaction.query(`INSERT INTO forward_opportunity_work_receipts(sample_id,execution_fingerprint,strategy_version,
        request_generation,request_key,evaluation_id,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [lease.sampleId, lease.executionFingerprint, version, lease.requestGeneration, row.latest_request_key, evaluationId, now]);
      await transaction.query(`UPDATE forward_opportunity_jobs SET status='completed',completed_at=$4,lease_owner=NULL,lease_expires_at=NULL,reason_code=NULL
        WHERE sample_id=$1 AND execution_fingerprint=$2 AND strategy_version=$3`, [lease.sampleId, lease.executionFingerprint, version, now]);
    },
    async defer(lease: ForwardOpportunityLease, input: { readonly now: number; readonly retryAt: number; readonly reasonCode: string }): Promise<void> {
      clock(input.retryAt); id(input.reasonCode);
      if (input.retryAt < input.now) throw new Error("Opportunity retry predates evaluation");
      await owned(lease, input.now);
      await transaction.query(`UPDATE forward_opportunity_jobs SET status='pending',next_attempt_at=$4,reason_code=$5,lease_owner=NULL,lease_expires_at=NULL
        WHERE sample_id=$1 AND execution_fingerprint=$2 AND strategy_version=$3`,
      [lease.sampleId, lease.executionFingerprint, version, input.retryAt, input.reasonCode]);
    },
    async supersede(lease: ForwardOpportunityLease, now: number): Promise<void> {
      await owned(lease, now);
      await transaction.query(`UPDATE forward_opportunity_jobs SET status='superseded',reason_code='execution_replaced',lease_owner=NULL,lease_expires_at=NULL
        WHERE sample_id=$1 AND execution_fingerprint=$2 AND strategy_version=$3`, [lease.sampleId, lease.executionFingerprint, version]);
    },
  });
}
