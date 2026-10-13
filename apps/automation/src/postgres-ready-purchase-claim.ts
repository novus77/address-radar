import type { CaptureConsumerLease, PostgresTransaction } from "@address-radar/database";

/** Scheduling hints only. The caller must still resolve the claimed input through its factual adapter. */
export const POSTGRES_READY_PURCHASE_CLAIM_SQL = `/* ready-purchase-claim */ WITH due AS (
  WITH qualified_representatives AS NOT MATERIALIZED (
    -- Metadata-only deterministic representatives, before fact count and byte windows.
    SELECT DISTINCT ON(f.generation_id,f.kind,f.subject_key) f.generation_id,f.kind,f.subject_key,f.fact_id,f.known_at
    FROM wallet_service_fact_inputs f
    JOIN wallet_service_fact_attestations a ON a.generation_id=f.generation_id AND a.fact_id=f.fact_id AND a.kind=f.kind
      AND a.fingerprint=f.fingerprint AND a.checked_at<=$3 AND a.expires_at>$3
    JOIN wallet_service_fact_validators v ON v.generation_id=a.generation_id AND v.validator_id=a.validator_id AND v.kind=a.kind
    JOIN wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id
    WHERE $10::boolean AND f.generation_id=$6 AND f.kind='execution' AND f.known_at<=$3
      AND f.observed_at<=f.known_at AND f.known_at<=a.checked_at AND v.valid_from<=a.checked_at AND v.valid_until>$3
      AND (v.revoked_at IS NULL OR v.revoked_at>$3) AND (l.revoked_at IS NULL OR l.revoked_at>$3)
      AND l.proof_scope='validator_authority' AND l.imported_at<=a.checked_at AND v.validator_id<>f.provider_id
    ORDER BY f.generation_id,f.kind,f.subject_key,f.known_at DESC,f.fact_id DESC
  ), fact_window AS MATERIALIZED (
    SELECT f.fact_id,f.subject_key,f.payload,f.known_at
    FROM qualified_representatives r JOIN wallet_service_fact_inputs f ON f.generation_id=r.generation_id AND f.fact_id=r.fact_id
    ORDER BY f.known_at DESC,f.fact_id LIMIT $7
  ), sized_facts AS MATERIALIZED (
    SELECT f.*,sum(octet_length(row_to_json(f)::text)+256) OVER (ORDER BY f.known_at DESC,f.fact_id ROWS UNBOUNDED PRECEDING)+2 result_bytes
    FROM fact_window f
  ), live_hints AS MATERIALIZED (
    SELECT f.subject_key,CASE WHEN result_bytes<=$9 THEN f.payload::jsonb ELSE NULL END value FROM sized_facts f
  ), capture_window AS MATERIALIZED (
    -- Jobs/intents/results are unique here; EXISTS prevents hint and binding fanout before LIMIT/bytes.
    SELECT w.intent_id,w.next_attempt_at,n.normalized_payload
    FROM capture_consumer_jobs w
    JOIN capture_consumer_intents i ON i.intent_id=w.intent_id
    JOIN capture_normalized_results n ON n.job_id=i.job_id
    JOIN capture_normalization_jobs j ON j.job_id=n.job_id
    WHERE n.event_kind='buy' AND n.requires_review=false AND j.status='completed' AND j.parser_version='wallet-chain-v1'
      AND n.committed_at<=$3 AND octet_length(n.normalized_payload)<=$9
      AND w.consumer_name=$1 AND w.consumer_version=$2 AND w.status='pending' AND w.next_attempt_at<=$3
      AND w.lease_owner IS NULL AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=$3)
      AND EXISTS(SELECT 1 FROM wallet_capture_generation_bindings g WHERE g.source_namespace=j.source_namespace
        AND g.source_event_id=j.source_event_id AND g.semantic_fingerprint=j.semantic_fingerprint
        AND g.generation_id=$6 AND g.created_at<=$3)
      AND EXISTS(SELECT 1 FROM live_hints h WHERE h.value->>'canonical'='confirmed_execution'
        AND n.chain=h.value->'purchase'->>'chain' AND n.token_address=h.value->'purchase'->>'tokenAddress'
        -- Convert only the bounded hint scalar, not the indexed capture column.
        AND n.occurred_at=CASE WHEN jsonb_typeof(h.value->'purchase'->'occurredAt')='number'
          AND (h.value->'purchase'->>'occurredAt') ~ '^(0|[1-9][0-9]{0,15})$'
          THEN (h.value->'purchase'->>'occurredAt')::bigint ELSE NULL END
        -- Match before LIMIT; CASE protects JSON casts independently of predicate order.
        AND h.subject_key=(SELECT encode(sha256(convert_to('['||to_json(p->'event'->>'chain')::text||','||
          to_json(p->'event'->>'walletAddress')::text||','||to_json(p->'event'->>'sourceReference')::text||','||
          to_json(p->'event'->>'tokenAddress')::text||']','UTF8')),'hex')
          FROM (SELECT CASE WHEN octet_length(n.normalized_payload)<=$9 THEN n.normalized_payload::jsonb ELSE NULL END p) bounded_capture))
    ORDER BY w.next_attempt_at,w.intent_id LIMIT $8
  ), sized_captures AS MATERIALIZED (
    SELECT c.*,sum(octet_length(row_to_json(c)::text)+256) OVER (ORDER BY c.next_attempt_at,c.intent_id ROWS UNBOUNDED PRECEDING)+2 result_bytes
    FROM capture_window c
  ), capture_hints AS MATERIALIZED (
    SELECT c.intent_id,CASE WHEN result_bytes<=$9 THEN c.normalized_payload::jsonb ELSE NULL END p FROM sized_captures c
  ), ready AS MATERIALIZED (
    SELECT w.intent_id FROM capture_consumer_jobs w JOIN capture_hints h ON h.intent_id=w.intent_id
    WHERE $10::boolean AND w.consumer_name=$1 AND w.consumer_version=$2 AND w.status='pending' AND w.next_attempt_at<=$3
      AND w.lease_owner IS NULL AND (w.lease_expires_at IS NULL OR w.lease_expires_at<=$3)
      AND h.p->>'generationId'=$6 AND h.p->>'schemaVersion'='wallet-chain-v1'
    ORDER BY w.next_attempt_at,w.intent_id FOR UPDATE OF w SKIP LOCKED LIMIT 1
  ), fallback AS MATERIALIZED (
    SELECT intent_id FROM capture_consumer_jobs WHERE consumer_name=$1 AND consumer_version=$2
      AND NOT EXISTS(SELECT 1 FROM ready) AND
      ((status='pending' AND next_attempt_at<=$3) OR (status='leased' AND lease_expires_at<=$3))
    ORDER BY next_attempt_at,intent_id FOR UPDATE SKIP LOCKED LIMIT 1
  ) SELECT intent_id FROM ready UNION ALL SELECT intent_id FROM fallback
), claimed AS (
  UPDATE capture_consumer_jobs w SET status='leased',lease_owner=$4,claim_generation=w.claim_generation+1,lease_expires_at=$5
    FROM due WHERE w.intent_id=due.intent_id AND w.consumer_name=$1 AND w.consumer_version=$2 RETURNING w.*
) SELECT w.*,i.job_id,j.semantic_fingerprint,j.parser_version,r.requires_review FROM claimed w
  JOIN capture_consumer_intents i USING(intent_id) JOIN capture_normalization_jobs j ON j.job_id=i.job_id
  JOIN capture_normalized_results r ON r.job_id=j.job_id`;

export async function claimPostgresReadyPurchase(transaction: PostgresTransaction, input: {
  readonly generationId: string; readonly consumerVersion: string; readonly owner: string; readonly now: number; readonly leaseMs: number;
  readonly maximumFacts: number; readonly maximumCaptures: number; readonly maximumPayloadBytes: number; readonly preferReady: boolean;
}): Promise<CaptureConsumerLease | null> {
  for (const id of [input.generationId,input.consumerVersion,input.owner]) {
    if (typeof id !== "string" || !id.trim() || id.length>512) throw new Error("Bounded purchase claim identity required");
  }
  for (const [value,max] of [[input.maximumFacts,1000],[input.maximumCaptures,1000],[input.maximumPayloadBytes,2_147_483_647],
    [input.leaseMs,2_147_483_647]]) {
    if (!Number.isSafeInteger(value) || value!<1 || value!>max!) throw new Error("Bounded purchase claim budget required");
  }
  if (!Number.isSafeInteger(input.now) || input.now<0 || !Number.isSafeInteger(input.now+input.leaseMs)
    || typeof input.preferReady!=="boolean") throw new Error("Invalid purchase claim clock/turn");
  const result=await transaction.query(POSTGRES_READY_PURCHASE_CLAIM_SQL,["forward_purchase_match",input.consumerVersion,input.now,input.owner,
    input.now+input.leaseMs,input.generationId,input.maximumFacts,input.maximumCaptures,input.maximumPayloadBytes,input.preferReady]);
  const row=result.rows[0]; if (!row) return null;
  return Object.freeze({intentId:String(row.intent_id),jobId:String(row.job_id),consumerName:"forward_purchase_match",consumerVersion:input.consumerVersion,
    owner:input.owner,claimGeneration:Number(row.claim_generation),leaseExpiresAt:Number(row.lease_expires_at),
    inputFingerprint:String(row.semantic_fingerprint),parserVersion:String(row.parser_version),requiresReview:row.requires_review===true});
}
