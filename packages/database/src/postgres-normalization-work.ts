import { randomUUID } from "node:crypto";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export const POSTGRES_NORMALIZATION_SCHEMA_SQL = `
CREATE TABLE capture_normalization_jobs (
  job_id text PRIMARY KEY, source_namespace text NOT NULL, source_event_id text NOT NULL,
  semantic_fingerprint text NOT NULL, parser_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','completed','quarantined')),
  requested_at bigint NOT NULL, next_attempt_at bigint NOT NULL,
  lease_owner text, claim_generation integer NOT NULL DEFAULT 0, lease_expires_at bigint,
  completed_at bigint, failure_reason text,
  UNIQUE(source_namespace,source_event_id,semantic_fingerprint,parser_version),
  FOREIGN KEY(source_namespace,source_event_id,semantic_fingerprint)
    REFERENCES capture_event_revisions(source_namespace,source_event_id,semantic_fingerprint)
);
CREATE INDEX capture_normalization_due ON capture_normalization_jobs(next_attempt_at,requested_at,job_id)
  WHERE status IN ('pending','leased');
CREATE TABLE capture_normalized_results (
  job_id text PRIMARY KEY REFERENCES capture_normalization_jobs(job_id),
  event_kind text NOT NULL CHECK(event_kind IN ('buy','sell','transfer','thesis','market')),
  source_user_id text, entity_id text, chain text, token_address text, occurred_at bigint,
  normalized_payload text NOT NULL, requires_review boolean NOT NULL, committed_at bigint NOT NULL
);
CREATE TABLE capture_consumer_intents (
  intent_id text PRIMARY KEY, job_id text NOT NULL UNIQUE REFERENCES capture_normalized_results(job_id),
  intent_type text NOT NULL CHECK(intent_type = 'source_event_normalized'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched')),
  created_at bigint NOT NULL, dispatched_at bigint
);
`;

export interface NormalizationRequest {
  readonly sourceNamespace: string;
  readonly sourceEventId: string;
  readonly semanticFingerprint: string;
  readonly parserVersion: string;
  readonly requestedAt: number;
}

export interface NormalizationLease extends NormalizationRequest {
  readonly jobId: string;
  readonly owner: string;
  readonly claimGeneration: number;
  readonly leaseExpiresAt: number;
}

export interface NormalizedCaptureResult {
  readonly eventKind: "buy" | "sell" | "transfer" | "thesis" | "market";
  readonly sourceUserId: string | null;
  readonly entityId: string | null;
  readonly chain: string | null;
  readonly tokenAddress: string | null;
  readonly occurredAt: number | null;
  readonly normalizedPayload: string;
}

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Normalization timestamp is invalid");
}
function identifier(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Normalization identity must be nonempty and bounded");
}

export function createPostgresNormalizationRepository(transaction: PostgresTransaction, maximumPayloadBytes: number) {
  if (!Number.isSafeInteger(maximumPayloadBytes) || maximumPayloadBytes <= 0) throw new Error("Normalization payload limit is invalid");
  async function owned(lease: NormalizationLease, now: number) {
    timestamp(now);
    identifier(lease.jobId);
    identifier(lease.owner);
    if (!Number.isSafeInteger(lease.claimGeneration) || lease.claimGeneration < 1) throw new Error("Normalization claim generation is invalid");
    const rows = await transaction.query(`SELECT j.*,i.original_fingerprint FROM capture_normalization_jobs j
      JOIN capture_event_identities i USING(source_namespace,source_event_id)
      WHERE j.job_id=$1 AND j.status='leased' AND j.lease_owner=$2 AND j.claim_generation=$3
        AND j.lease_expires_at>$4 FOR UPDATE OF j`, [lease.jobId, lease.owner, lease.claimGeneration, now]);
    const row = rows.rows[0];
    if (row && (row.source_namespace !== lease.sourceNamespace || row.source_event_id !== lease.sourceEventId
      || row.semantic_fingerprint !== lease.semanticFingerprint || row.parser_version !== lease.parserVersion)) {
      throw new Error("Normalization lease input revision does not match");
    }
    return row;
  }
  return Object.freeze({
    async request(input: NormalizationRequest): Promise<string> {
      [input.sourceNamespace,input.sourceEventId,input.semanticFingerprint,input.parserVersion].forEach(identifier);
      timestamp(input.requestedAt);
      await transaction.query(`INSERT INTO capture_normalization_jobs(job_id,source_namespace,source_event_id,
        semantic_fingerprint,parser_version,requested_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(source_namespace,source_event_id,semantic_fingerprint,parser_version) DO NOTHING`,
      [randomUUID(),input.sourceNamespace,input.sourceEventId,input.semanticFingerprint,input.parserVersion,input.requestedAt]);
      const result = await transaction.query(`SELECT job_id FROM capture_normalization_jobs WHERE
        source_namespace=$1 AND source_event_id=$2 AND semantic_fingerprint=$3 AND parser_version=$4`,
      [input.sourceNamespace,input.sourceEventId,input.semanticFingerprint,input.parserVersion]);
      if (!result.rows[0]) throw new Error("Normalization request was not persisted");
      return String(result.rows[0].job_id);
    },
    async claim(input: { readonly owner: string; readonly now: number; readonly leaseMs: number }): Promise<NormalizationLease | null> {
      identifier(input.owner);
      timestamp(input.now);
      if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0 || !Number.isSafeInteger(input.now + input.leaseMs)) {
        throw new Error("Normalization lease duration is invalid");
      }
      const result = await transaction.query(`WITH due AS (
        SELECT job_id FROM capture_normalization_jobs WHERE
          (status='pending' AND next_attempt_at<=$1) OR (status='leased' AND lease_expires_at<=$1)
        ORDER BY next_attempt_at,requested_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE capture_normalization_jobs j SET status='leased',lease_owner=$2,
        claim_generation=j.claim_generation+1,lease_expires_at=$3 FROM due WHERE j.job_id=due.job_id RETURNING j.*`,
      [input.now,input.owner,input.now+input.leaseMs]);
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({ jobId:String(row.job_id),sourceNamespace:String(row.source_namespace),sourceEventId:String(row.source_event_id),
        semanticFingerprint:String(row.semantic_fingerprint),parserVersion:String(row.parser_version),requestedAt:Number(row.requested_at),
        owner:input.owner,claimGeneration:Number(row.claim_generation),leaseExpiresAt:Number(row.lease_expires_at) });
    },
    async complete(lease: NormalizationLease, result: NormalizedCaptureResult, now: number): Promise<boolean> {
      if (!["buy","sell","transfer","thesis","market"].includes(result.eventKind)) throw new Error("Normalization event kind is invalid");
      for (const value of [result.sourceUserId,result.entityId,result.chain,result.tokenAddress]) if (value !== null) identifier(value);
      if (result.occurredAt !== null) timestamp(result.occurredAt);
      if (Buffer.byteLength(result.normalizedPayload,"utf8")>maximumPayloadBytes) throw new Error("Normalization payload exceeds limit");
      const payload: unknown = JSON.parse(result.normalizedPayload);
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Normalization payload must be an object");
      const row = await owned(lease,now);
      if (!row) return false;
      await transaction.query(`INSERT INTO capture_normalized_results(job_id,event_kind,source_user_id,entity_id,chain,
        token_address,occurred_at,normalized_payload,requires_review,committed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [lease.jobId,result.eventKind,result.sourceUserId,result.entityId,result.chain,result.tokenAddress,result.occurredAt,
        result.normalizedPayload,row.original_fingerprint !== lease.semanticFingerprint,now]);
      await transaction.query(`INSERT INTO capture_consumer_intents(intent_id,job_id,intent_type,created_at)
        VALUES($1,$2,'source_event_normalized',$3)`,[`normalization:${lease.jobId}`,lease.jobId,now]);
      await transaction.query(`UPDATE capture_normalization_jobs SET status='completed',completed_at=$2,
        lease_owner=NULL,lease_expires_at=NULL WHERE job_id=$1`,[lease.jobId,now]);
      return true;
    },
    async retry(lease: NormalizationLease, input: { readonly now:number; readonly retryAt:number; readonly reason:string }): Promise<boolean> {
      identifier(input.reason); timestamp(input.retryAt);
      if (input.retryAt<input.now) throw new Error("Normalization retry cannot precede its decision time");
      if (!await owned(lease,input.now)) return false;
      await transaction.query(`UPDATE capture_normalization_jobs SET status='pending',next_attempt_at=$2,
        failure_reason=$3,lease_owner=NULL,lease_expires_at=NULL WHERE job_id=$1`,[lease.jobId,input.retryAt,input.reason]);
      return true;
    },
    async quarantine(lease: NormalizationLease, input: { readonly now:number; readonly reason:string }): Promise<boolean> {
      identifier(input.reason);
      if (!await owned(lease,input.now)) return false;
      await transaction.query(`UPDATE capture_normalization_jobs SET status='quarantined',failure_reason=$2,
        lease_owner=NULL,lease_expires_at=NULL WHERE job_id=$1`,[lease.jobId,input.reason]);
      return true;
    },
  });
}
