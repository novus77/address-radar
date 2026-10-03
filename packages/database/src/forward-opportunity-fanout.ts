import type { PostgresTransaction } from "./postgres-unit-of-work.js";
import { createPostgresForwardOpportunityWorkRepository } from "./forward-opportunity-work.js";

export const POSTGRES_FORWARD_OPPORTUNITY_FANOUT_SCHEMA_SQL = `
CREATE TABLE forward_peak_fanout_jobs (
  peak_id text NOT NULL, revision_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','completed')),
  last_sample_id text NOT NULL DEFAULT '', next_attempt_at bigint NOT NULL,
  claim_generation integer NOT NULL DEFAULT 0, lease_owner text, lease_expires_at bigint, completed_at bigint,
  PRIMARY KEY(peak_id,revision_id),
  FOREIGN KEY(peak_id,revision_id) REFERENCES forward_peak_evidence(peak_id,revision_id)
);
CREATE INDEX forward_peak_fanout_due ON forward_peak_fanout_jobs(next_attempt_at,peak_id,revision_id)
  WHERE status IN ('pending','leased');
CREATE INDEX forward_peak_available_revision ON forward_peak_evidence(known_at,peak_id,revision_id);
`;
export interface ForwardPeakFanoutLease {
  readonly peakId: string;
  readonly revisionId: string;
  readonly owner: string;
  readonly claimGeneration: number;
  readonly leaseExpiresAt: number;
}
export class ForwardPeakFanoutLeaseLostError extends Error {
  constructor() { super("Peak fanout lease is expired, replaced or owned by another worker"); }
}
function id(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Peak fanout identity is invalid");
}
function clock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Peak fanout timestamp is invalid");
}
function batch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new Error("Peak fanout batch must be between 1 and 1000");
}

export function createPostgresForwardOpportunityFanoutRepository(transaction: PostgresTransaction) {
  async function enqueue(input: { readonly peakId: string; readonly revisionId: string; readonly now: number }) {
    [input.peakId, input.revisionId].forEach(id); clock(input.now);
    const result = await transaction.query("SELECT known_at FROM forward_peak_evidence WHERE peak_id=$1 AND revision_id=$2",
      [input.peakId, input.revisionId]);
    if (!result.rows[0] || Number(result.rows[0].known_at) > input.now) throw new Error("Peak fanout requires an available stored revision");
    const inserted = await transaction.query(`INSERT INTO forward_peak_fanout_jobs(peak_id,revision_id,next_attempt_at)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING peak_id`, [input.peakId, input.revisionId, input.now]);
    return inserted.rows[0] ? "scheduled" as const : "duplicate" as const;
  }
  async function owned(lease: ForwardPeakFanoutLease, now: number) {
    [lease.peakId, lease.revisionId, lease.owner].forEach(id); clock(now); clock(lease.leaseExpiresAt);
    if (!Number.isSafeInteger(lease.claimGeneration) || lease.claimGeneration < 1) throw new Error("Peak fanout claim generation is invalid");
    const result = await transaction.query(`SELECT w.*,p.chain,p.token_address,p.observed_from,p.observed_until,p.known_at
      FROM forward_peak_fanout_jobs w JOIN forward_peak_evidence p USING(peak_id,revision_id)
      WHERE w.peak_id=$1 AND w.revision_id=$2 AND w.status='leased' AND w.lease_owner=$3
      AND w.claim_generation=$4 AND w.lease_expires_at=$5 AND w.lease_expires_at>$6 FOR UPDATE OF w`,
    [lease.peakId, lease.revisionId, lease.owner, lease.claimGeneration, lease.leaseExpiresAt, now]);
    if (!result.rows[0]) throw new ForwardPeakFanoutLeaseLostError();
    return result.rows[0];
  }
  return Object.freeze({
    enqueue,
    async recover(now: number, limit: number): Promise<number> {
      clock(now); batch(limit);
      const missing = await transaction.query(`SELECT p.peak_id,p.revision_id FROM forward_peak_evidence p
        WHERE p.known_at<=$1 AND NOT EXISTS(SELECT 1 FROM forward_peak_fanout_jobs w
          WHERE w.peak_id=p.peak_id AND w.revision_id=p.revision_id)
        ORDER BY p.known_at,p.peak_id,p.revision_id LIMIT $2`, [now, limit]);
      let scheduled = 0;
      for (const row of missing.rows) {
        if (await enqueue({ peakId: String(row.peak_id), revisionId: String(row.revision_id), now }) === "scheduled") scheduled++;
      }
      return scheduled;
    },
    async claim(input: { readonly owner: string; readonly now: number; readonly leaseMs: number }): Promise<ForwardPeakFanoutLease | null> {
      id(input.owner); clock(input.now);
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0 || !Number.isSafeInteger(input.now + input.leaseMs)) {
        throw new Error("Peak fanout lease duration is invalid");
      }
      const result = await transaction.query(`WITH due AS (
        SELECT peak_id,revision_id FROM forward_peak_fanout_jobs WHERE
          (status='pending' AND next_attempt_at<=$1) OR (status='leased' AND lease_expires_at<=$1)
        ORDER BY next_attempt_at,peak_id,revision_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE forward_peak_fanout_jobs w SET status='leased',lease_owner=$2,
        claim_generation=w.claim_generation+1,lease_expires_at=$3 FROM due
        WHERE w.peak_id=due.peak_id AND w.revision_id=due.revision_id RETURNING w.*`,
      [input.now, input.owner, input.now + input.leaseMs]);
      const row = result.rows[0]; if (!row) return null;
      return Object.freeze({ peakId: String(row.peak_id), revisionId: String(row.revision_id), owner: input.owner,
        claimGeneration: Number(row.claim_generation), leaseExpiresAt: Number(row.lease_expires_at) });
    },
    async dispatch(lease: ForwardPeakFanoutLease, input: { readonly now: () => number; readonly limit: number }) {
      batch(input.limit);
      const startedAt = input.now();
      const job = await owned(lease, startedAt);
      if (Number(job.known_at) > startedAt) throw new Error("Peak fanout cannot dispatch future evidence");
      // Never skip a locked sample and advance beyond it: a retry must retain that cursor position.
      const samples = await transaction.query(`SELECT sample_id,execution_fingerprint FROM forward_purchase_samples
        WHERE chain=$1 AND token_address=$2 AND occurred_at<=$3 AND expires_at>$4 AND sample_id>$5
        ORDER BY sample_id LIMIT $6`, [job.chain, job.token_address, job.observed_until, job.observed_from,
        job.last_sample_id, input.limit]);
      const work = createPostgresForwardOpportunityWorkRepository(transaction);
      let scheduled = 0;
      let staleExecutions = 0;
      for (const sample of samples.rows) {
        const requestedAt = input.now(); clock(requestedAt);
        if (requestedAt < startedAt) throw new Error("Peak fanout clock moved backwards");
        const status = await work.request({ sampleId: String(sample.sample_id), executionFingerprint: String(sample.execution_fingerprint),
          trigger: { kind: "peak_revision", peakId: lease.peakId, revisionId: lease.revisionId }, requestedAt });
        if (status === "scheduled") scheduled++;
        if (status === "stale_execution") staleExecutions++;
      }
      const finishedAt = input.now(); clock(finishedAt);
      if (finishedAt < startedAt) throw new Error("Peak fanout clock moved backwards");
      await owned(lease, finishedAt);
      const completed = samples.rows.length < input.limit;
      const cursor = samples.rows.at(-1)?.sample_id ?? job.last_sample_id;
      await transaction.query(`UPDATE forward_peak_fanout_jobs SET last_sample_id=$3,status=$4,next_attempt_at=$5,
        lease_owner=NULL,lease_expires_at=NULL,completed_at=$6 WHERE peak_id=$1 AND revision_id=$2`,
      [lease.peakId, lease.revisionId, cursor, completed ? "completed" : "pending", finishedAt, completed ? finishedAt : null]);
      return Object.freeze({ examined: samples.rows.length, scheduled, staleExecutions, completed });
    },
  });
}
