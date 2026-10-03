import type { PostgresTransaction } from "./postgres-unit-of-work.js";

export interface ForwardTraceCursor { readonly boughtAt: number; readonly sampleId: string }
export interface ForwardTraceQuery {
  readonly entityId: string; readonly generationId: string; readonly asOf: number;
  readonly limit: number; readonly after: ForwardTraceCursor | null;
}
export interface ForwardTraceSnapshot {
  readonly entityId: string; readonly generationId: string; readonly asOf: number;
  readonly purchases: readonly Record<string, unknown>[];
  readonly nextCursor: ForwardTraceCursor | null;
  readonly capability: Record<string, unknown> | null;
  readonly identityChecks: readonly Record<string, unknown>[];
  readonly identityPageLimited: boolean;
  readonly signals: readonly Record<string, unknown>[];
  readonly signalPageLimited: boolean;
  readonly countScope: "current_page"; readonly gatewayDeliveryEnabled: false;
  readonly liveSourceCoverageVerified: false;
}

export async function readPostgresForwardTrace(tx: PostgresTransaction, input: ForwardTraceQuery): Promise<ForwardTraceSnapshot> {
  if (!input.entityId.trim() || !input.generationId.trim() || !Number.isSafeInteger(input.asOf) || input.asOf < 0 ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000 ||
      (input.after !== null && (!Number.isSafeInteger(input.after.boughtAt) || input.after.boughtAt < 0 || !input.after.sampleId.trim()))) {
    throw new Error("Invalid forward trace query");
  }
  // A single statement gives all sections the same MVCC snapshot, without locking business writers.
  const result = await tx.query(`
WITH candidates AS (
  SELECT s.*,s.occurred_at AS bought_at FROM forward_purchase_samples s
  JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
  WHERE s.entity_id=$1 AND s.generation_id=$2 AND s.occurred_at<=$3 AND s.created_at<=$3 AND g.activated_at<=$3
    AND ($5::bigint IS NULL OR s.occurred_at<$5 OR (s.occurred_at=$5 AND s.sample_id>$6))
  ORDER BY s.occurred_at DESC,s.sample_id LIMIT $4+1
), purchase_page AS (
  SELECT * FROM candidates ORDER BY bought_at DESC,sample_id LIMIT $4
), purchase_rows AS (
  SELECT s.bought_at,s.sample_id,jsonb_build_object(
    'sampleId',s.sample_id,'tradeId',s.trade_id,'executionFingerprint',s.execution_fingerprint,
    'chain',s.chain,'tokenAddress',s.token_address,'boughtAt',s.bought_at,'expiresAt',s.expires_at,'sampleState',s.state,
    'amountUsd',r.amount_usd::text,'amountEstimated',r.amount_estimated,'entryPriceUsd',r.entry_price_usd::text,
    'revisionState',r.state,'executionEvidenceRef',r.execution_evidence_ref,'ownershipEvidenceRef',r.ownership_evidence_ref,
    'pendingRevision',EXISTS(SELECT 1 FROM forward_trade_revisions p WHERE p.trade_id=s.trade_id AND p.state='pending_review' AND p.recorded_at<=$3),
    'opportunity',CASE WHEN o.evaluation_id IS NULL THEN NULL ELSE jsonb_build_object(
      'evaluationId',o.evaluation_id,'executionFingerprint',o.execution_fingerprint,
      'currentExecution',o.execution_fingerprint=s.execution_fingerprint,'status',o.status,'tier',o.tier,
      'reasonCode',o.reason_code,'computedAt',o.computed_at,'peakId',o.peak_id,'peakRevisionId',o.peak_revision_id,
      'strategyVersion',o.strategy_version) END) AS value
  FROM purchase_page s
  LEFT JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint AND r.recorded_at<=$3
  LEFT JOIN LATERAL (
    SELECT * FROM forward_opportunity_evaluations e WHERE e.sample_id=s.sample_id AND e.computed_at<=$3
    ORDER BY e.computed_at DESC,e.evaluation_id DESC LIMIT 1
  ) o ON true
), identity_candidates AS (
  SELECT r.refresh_id,r.checked_at,r.source_observed_at,r.status,r.target_version_id,r.payload,
    h.channel,h.subject_key FROM forward_target_identity_refresh_heads h
  JOIN forward_target_identity_refresh_receipts r ON r.refresh_id=h.refresh_id
  WHERE h.entity_id=$1 AND h.generation_id=$2 AND h.checked_at<=$3
  ORDER BY h.channel,h.subject_key LIMIT $4+1
), identity_page AS (
  SELECT jsonb_build_object('channel',channel,'subjectKey',subject_key,'refreshReceiptId',refresh_id,
    'checkedAt',checked_at,'sourceObservedAt',source_observed_at,'sourceStatus',status,
    'freshAtAssessment',checked_at=$3,'targetVersionId',target_version_id,'recordedDecision',payload::jsonb) AS value
  FROM identity_candidates ORDER BY channel,subject_key LIMIT $4
), signal_candidates AS (
  SELECT i.* FROM forward_signal_readiness_intents i
  WHERE i.generation_id=$2 AND i.created_at<=$3 AND EXISTS (
    SELECT 1 FROM forward_signal_execution_receipts r
    JOIN forward_purchase_samples s ON s.sample_id=r.sample_id
    WHERE r.evaluation_id=i.evaluation_id AND s.entity_id=$1 AND s.generation_id=$2 AND s.created_at<=$3
  ) ORDER BY i.created_at DESC,i.signal_id LIMIT $4+1
), signal_page AS (
  SELECT i.created_at,i.signal_id,jsonb_build_object('signalId',i.signal_id,'evaluationId',i.evaluation_id,
    'chain',i.chain,'tokenAddress',i.token_address,'createdAt',i.created_at,'intentStatus',i.status,
    'readinessStatus',c.status,'checkedAt',c.checked_at,'decision',i.payload::jsonb,
    'receipts',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'sampleId',r.sample_id,'executionFingerprint',r.execution_fingerprint,
      'refreshReceiptId',r.refresh_id,'authorizationStamp',r.authorization_stamp) ORDER BY r.sample_id)
      FROM forward_signal_execution_receipts r WHERE r.evaluation_id=i.evaluation_id),'[]'::jsonb)) AS value
  FROM signal_candidates i
  LEFT JOIN LATERAL (SELECT * FROM forward_signal_readiness_checks c WHERE c.signal_id=i.signal_id AND c.checked_at<=$3
    ORDER BY c.checked_at DESC,c.check_id DESC LIMIT 1) c ON true
  ORDER BY i.created_at DESC,i.signal_id LIMIT $4
)
SELECT jsonb_build_object(
  'entityId',$1::text,'generationId',$2::text,'asOf',$3::bigint,
  'purchases',COALESCE((SELECT jsonb_agg(value ORDER BY bought_at DESC,sample_id) FROM purchase_rows),'[]'::jsonb),
  'nextCursor',CASE WHEN (SELECT count(*) FROM candidates)>$4 THEN
    (SELECT jsonb_build_object('boughtAt',bought_at,'sampleId',sample_id) FROM purchase_page ORDER BY bought_at ASC,sample_id DESC LIMIT 1)
    ELSE NULL END,
  'capability',(SELECT jsonb_build_object('versionId',version_id,'strategyVersion',strategy_version,
    'evaluatedAt',as_of,'stableCapability',stable_capability,'hit3xTokens',hit_3x_tokens,'hit5xTokens',hit_5x_tokens,
    'inputFingerprint',input_fingerprint) FROM forward_trader_capability_versions
    WHERE entity_id=$1 AND generation_id=$2 AND as_of<=$3 ORDER BY as_of DESC,version_id DESC LIMIT 1),
  'identityChecks',COALESCE((SELECT jsonb_agg(value) FROM identity_page),'[]'::jsonb),
  'identityPageLimited',(SELECT count(*) FROM identity_candidates)>$4,
  'signals',COALESCE((SELECT jsonb_agg(value ORDER BY created_at DESC,signal_id) FROM signal_page),'[]'::jsonb),
  'signalPageLimited',(SELECT count(*) FROM signal_candidates)>$4,
  'countScope','current_page','gatewayDeliveryEnabled',false,'liveSourceCoverageVerified',false) AS snapshot
`, [input.entityId,input.generationId,input.asOf,input.limit,input.after?.boughtAt ?? null,input.after?.sampleId ?? null]);
  const snapshot = result.rows[0]?.snapshot;
  if (!snapshot || typeof snapshot !== "object") throw new Error("Forward trace snapshot unavailable");
  return snapshot as ForwardTraceSnapshot;
}
