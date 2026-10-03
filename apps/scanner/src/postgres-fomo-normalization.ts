import { prepareFomoSourceMessage, fomoSourceObservation, type FomoSourceMessage } from "@address-radar/collectors";
import { createPostgresCaptureRepository, createPostgresNormalizationRepository,
  type PostgresTransaction, type NormalizationLease } from "@address-radar/database";

export const FOMO_SOURCE_PARSER_VERSION = "fomo-source-observation-v1";

// Inactive adapter: the caller owns the transaction and must await its commit before acknowledging capture.
export async function stagePostgresFomoMessage(transaction: PostgresTransaction, input: FomoSourceMessage & {
  readonly collectorId: string; readonly sessionId: string; readonly receivedAt: number;
}) {
  const prepared = prepareFomoSourceMessage(input);
  if (!prepared) return null;
  const captured = await createPostgresCaptureRepository(transaction, input).append({
    sourceNamespace: "fomo-live-feed", sourceEventId: prepared.sourceEventId,
    collectorId: input.collectorId, sessionId: input.sessionId, receivedAt: input.receivedAt,
    scrubbedPayload: prepared.scrubbedPayload, semanticPayload: prepared.semanticPayload,
  });
  const jobId = await createPostgresNormalizationRepository(transaction, input.maximumPayloadBytes).request({
    sourceNamespace: "fomo-live-feed", sourceEventId: prepared.sourceEventId,
    semanticFingerprint: captured.semanticFingerprint, parserVersion: FOMO_SOURCE_PARSER_VERSION, requestedAt: input.receivedAt,
  });
  return Object.freeze({ captured, jobId });
}

export async function normalizePostgresFomoLease(transaction: PostgresTransaction, lease: NormalizationLease,
  input: { readonly now: number; readonly maximumPayloadBytes: number }) {
  if (lease.sourceNamespace !== "fomo-live-feed" || lease.parserVersion !== FOMO_SOURCE_PARSER_VERSION) {
    throw new Error("FOMO normalization lease belongs to a different adapter");
  }
  const repository = createPostgresNormalizationRepository(transaction, input.maximumPayloadBytes);
  const revision = await transaction.query(`SELECT semantic_payload FROM capture_event_revisions
    WHERE source_namespace=$1 AND source_event_id=$2 AND semantic_fingerprint=$3`,
  [lease.sourceNamespace, lease.sourceEventId, lease.semanticFingerprint]);
  const payload = revision.rows[0]?.semantic_payload;
  if (typeof payload !== "string") return repository.quarantine(lease, { now: input.now, reason: "source_payload_unavailable" });
  // The immutable semantic projection omits the mutable display handle. It is not identity evidence.
  const parsed: unknown = JSON.parse(payload);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return repository.quarantine(lease, { now: input.now, reason: "invalid_source_projection" });
  }
  const fields = parsed as Record<string, unknown>;
  const body = JSON.stringify({ type: "data", topicType: "trading_activity", payload: { ...fields, userHandle: "unresolved-display-handle" } });
  const prepared = prepareFomoSourceMessage({ sourceMessageId: lease.sourceEventId,
    sourceUrl: "https://source-adapter.invalid", approvedOrigins: ["https://source-adapter.invalid"], body,
    maximumPayloadBytes: input.maximumPayloadBytes });
  if (!prepared?.activity) return repository.quarantine(lease, { now: input.now, reason: "unsupported_or_incomplete_activity" });
  const { handle: _handle, ...observation } = fomoSourceObservation(prepared.activity, lease.sourceEventId);
  return repository.complete(lease, { eventKind: prepared.activity.side, sourceUserId: prepared.activity.accountId,
    entityId: null, chain: prepared.activity.chain, tokenAddress: prepared.activity.tokenAddress,
    occurredAt: prepared.activity.occurredAt, normalizedPayload: JSON.stringify(observation) }, input.now);
}
