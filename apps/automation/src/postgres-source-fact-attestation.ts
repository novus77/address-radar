import { createHash, createPublicKey, verify } from "node:crypto";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { executionValidationSigningPayload } from "./postgres-execution-fact-publisher.js";
import type { PostgresRpcSourceFactCandidate, PostgresRpcSourceFactCandidateOptions } from "./postgres-rpc-source-fact-candidate.js";
import { walletPurchaseBasisFingerprint } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { forwardTargetIdentityTrusted, forwardTargetSubjectKey } from "../../../packages/domain/src/forward-target-authorization.js";

export interface PostgresSourceBindingOptions {
  readonly generationId: string; readonly activatedAt: number;
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly replayAuthority: NonNullable<PostgresRpcSourceFactCandidateOptions["authority"]>;
  readonly maximumProfileAgeMs: number; readonly maximumValidationAgeMs: number;
  readonly maximumPayloadBytes: number; readonly now: () => number;
}
export interface PostgresSourceValidationClaims {
  readonly format: 1; readonly generationId: string; readonly sampleId: string;
  readonly executionFingerprint: string; readonly targetVersionId: string;
  readonly envelopeFingerprint: string; readonly validatorId: string; readonly keyId: string;
  readonly checkedAt: number; readonly expiresAt: number; readonly validationRef: string;
}
export interface SignedPostgresSourceValidation { readonly claims: PostgresSourceValidationClaims; readonly signature: string }
export class SourceBindingUnavailable extends Error {}
export function sourceRequire(value: unknown, reason: string): asserts value {
  if (!value) throw new SourceBindingUnavailable(reason);
}
export function sourceTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function sourceId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:.\-/]+$/.test(value) && value.length <= 512 && !value.includes("://");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function sourceEnvelopeFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function sourceValidationSigningPayload(claims: PostgresSourceValidationClaims): Buffer {
  return Buffer.from(`address-radar/source-exact-envelope-validation/v1\n${canonical(claims)}`);
}
export function verifySourceSignature(payload: Buffer, signature: string, publicKey: string): boolean {
  try {
    const key = createPublicKey(publicKey), bytes = Buffer.from(signature, "base64");
    return key.asymmetricKeyType === "ed25519" && bytes.length === 64 && bytes.toString("base64") === signature
      && verify(null, payload, key, bytes);
  } catch { return false; }
}
export function checkSourceConfiguration(options: PostgresSourceBindingOptions): void {
  sourceRequire(sourceId(options.generationId) && sourceTime(options.activatedAt) && typeof options.run === "function"
    && typeof options.now === "function", "source_configuration_invalid");
  for (const value of [options.maximumProfileAgeMs, options.maximumValidationAgeMs, options.maximumPayloadBytes]) {
    sourceRequire(sourceTime(value) && value > 0, "source_explicit_budget_required");
  }
  const a = options.replayAuthority;
  sourceRequire(a && [a.validatorId, a.keyId, a.sourceProviderId, a.replayProviderId].every(sourceId)
    && new Set([a.validatorId, a.sourceProviderId, a.replayProviderId]).size === 3, "source_replay_authority_required");
}
export function checkSourceCandidate(candidate: PostgresRpcSourceFactCandidate, options: PostgresSourceBindingOptions, at: number): void {
  sourceRequire(Buffer.byteLength(JSON.stringify(candidate)) <= options.maximumPayloadBytes, "source_payload_budget");
  const { payload, replayEvidence } = candidate, c = replayEvidence.claims, a = options.replayAuthority, p = c.purchase;
  sourceRequire(sourceTime(at) && candidate.kind === "source" && candidate.generationId === options.generationId
    && payload.canonical === "confirmed_live_execution" && sourceId(payload.sampleId)
    && /^[a-f0-9]{64}$/.test(payload.executionFingerprint) && sourceId(candidate.targetVersionId)
    && candidate.subjectKey === createHash("sha256").update(JSON.stringify([payload.sampleId, payload.executionFingerprint])).digest("hex")
    && sourceTime(candidate.checkedAt) && candidate.checkedAt >= c.checkedAt && candidate.checkedAt <= at
    && at - candidate.checkedAt <= options.maximumValidationAgeMs
    && c.format === 1 && c.generationId === options.generationId && c.validatorId === a.validatorId && c.keyId === a.keyId
    && c.providerId === a.sourceProviderId && c.sourceBasis.kind === "independent_rpc_replay"
    && c.sourceBasis.providerId === a.replayProviderId && sourceId(c.sourceBasis.evidenceRef)
    && /^[a-f0-9]{64}$/.test(c.sourceBasis.contentFingerprint) && /^[a-f0-9]{64}$/.test(c.candidateFingerprint)
    && sourceTime(c.checkedAt) && sourceTime(c.expiresAt) && c.checkedAt <= at && c.expiresAt > at
    && at - c.checkedAt <= options.maximumValidationAgeMs && sourceId(c.validationRef)
    && c.purchaseFingerprint === walletPurchaseBasisFingerprint(p) && p.executionEvidenceRef === c.validationRef
    && p.entityId === payload.target.entityId && p.ownershipEvidenceRef === payload.target.ownershipEvidenceRef
    && payload.target.channel === "wallet" && (p.chain === "solana" ? "solana" : "evm") === payload.target.walletFamily
    && forwardTargetIdentityTrusted(payload.target) && payload.target.monitoringEnabled && !payload.target.suspended,
  "source_replay_or_envelope_invalid");
  sourceRequire(verifySourceSignature(executionValidationSigningPayload(c), replayEvidence.signature, a.publicKey), "source_replay_signature_invalid");
}

// The JSON binding is independently interpreted by PostgreSQL, not an application-supplied ready flag.
// Reuse this predicate inside the attestation INSERT to close the check/write gap without UPDATE privileges.
export const SOURCE_ENVELOPE_STATE_SQL = `SELECT /* source-envelope-state */ s.sample_id,s.chain,s.token_address
 FROM jsonb_to_record($1::jsonb) AS x("generationId" text,"activatedAt" bigint,"sampleId" text,
 "executionFingerprint" text,"targetVersionId" text,target jsonb,purchase jsonb,"validatorId" text,
 "replayValidatorId" text,"checkedAt" bigint,"expiresAt" bigint,"replayCheckedAt" bigint,"replayExpiresAt" bigint,
 "maximumProfileAgeMs" bigint,"subjectKey" text)
 JOIN forward_purchase_samples s ON s.sample_id=x."sampleId" AND s.generation_id=x."generationId"
   AND s.execution_fingerprint=x."executionFingerprint"
 JOIN forward_strategy_generations g ON g.generation_id=s.generation_id AND g.activated_at=x."activatedAt"
 JOIN forward_economic_trades t ON t.trade_id=s.trade_id AND t.original_fingerprint=s.execution_fingerprint
 JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
 JOIN wallet_service_profile_cohort c ON c.generation_id=s.generation_id AND c.subject_key=x."subjectKey"
 JOIN wallet_service_import_ledger ci ON ci.generation_id=c.generation_id AND ci.import_id=c.import_id
 JOIN LATERAL (SELECT p.* FROM wallet_service_profile_versions p
   WHERE p.generation_id=c.generation_id AND p.subject_key=c.subject_key AND p.effective_at<=$2 AND p.known_at<=$2
   ORDER BY p.effective_at DESC,p.known_at DESC,p.version_id DESC LIMIT 1) pv ON true
 JOIN wallet_service_import_ledger pi ON pi.generation_id=pv.generation_id AND pi.import_id=pv.import_id
 JOIN LATERAL (SELECT v.* FROM forward_target_channel_versions v
   WHERE v.entity_id=c.entity_id AND v.channel='wallet' AND v.subject_key=c.subject_key
   AND v.effective_at<=$2 AND v.known_at<=$2 ORDER BY v.effective_at DESC,v.known_at DESC,v.version_id DESC LIMIT 1) cv ON true
 JOIN forward_target_identity_bindings b ON b.channel='wallet' AND b.subject_key=c.subject_key
 WHERE r.state='original' AND s.created_at<=$2 AND r.recorded_at<=$2 AND s.occurred_at>=g.activated_at
 AND s.entity_id=r.entity_id AND s.entity_id=t.entity_id AND s.token_address=r.token_address
 AND s.token_address=t.token_address AND s.occurred_at=r.occurred_at AND s.occurred_at=t.occurred_at AND s.chain=t.chain
 AND s.entity_id=x.purchase->>'entityId' AND s.chain=x.purchase->>'chain' AND s.token_address=x.purchase->>'tokenAddress'
 AND s.occurred_at=(x.purchase->>'occurredAt')::bigint AND t.execution_key=x.purchase->>'executionKey'
 AND r.token_quantity=(x.purchase->>'tokenQuantity')::numeric AND r.quote_asset=x.purchase->>'quoteAsset'
 AND r.quote_amount=(x.purchase->>'quoteAmount')::numeric AND r.amount_usd=(x.purchase->>'amountUsd')::numeric
 AND r.entry_price_usd=(x.purchase->>'entryPriceUsd')::numeric AND r.amount_basis=x.purchase->>'amountBasis'
 AND r.amount_estimated=(x.purchase->>'amountEstimated')::boolean
 AND r.ownership_evidence_ref=x.purchase->>'ownershipEvidenceRef' AND r.execution_evidence_ref=x.purchase->>'executionEvidenceRef'
 AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions pending WHERE pending.trade_id=s.trade_id
   AND pending.state='pending_review' AND pending.recorded_at<=$2)
 AND c.entity_id=s.entity_id AND c.wallet_family=x.target->>'walletFamily' AND c.observed_at<=$2
 AND $2-c.observed_at<=x."maximumProfileAgeMs" AND ci.imported_at<=$2 AND ci.revoked_at IS NULL
 AND ci.proof_scope IN ('address_only_registry','legacy_registry_linkage')
 AND (ci.proof_scope<>'address_only_registry' OR c.profile_payload::jsonb->>'provenanceScope'='address_only_registry')
 AND c.profile_payload::jsonb->'wallet'->>'accountId'=x.purchase->>'sourceUserId'
 AND c.profile_payload::jsonb->'wallet'->>'entityId'=s.entity_id
 AND (c.profile_payload::jsonb->>'monitoringPolicy' IS NULL OR c.profile_payload::jsonb->>'monitoringPolicy'='realtime')
 AND pv.enabled AND NOT pv.suspended AND pi.imported_at<=$2 AND pi.revoked_at IS NULL
 AND cv.version_id=x."targetVersionId" AND cv.payload::jsonb=x.target
 AND b.owner_entity_id=s.entity_id AND b.created_at<=$2 AND (b.conflict_at IS NULL OR b.conflict_at>$2)
 AND x."checkedAt"<=$2 AND x."expiresAt">$2 AND x."replayCheckedAt"<=x."checkedAt" AND x."replayExpiresAt">=$2
 AND NOT EXISTS(SELECT 1 FROM (VALUES ('source',x."validatorId",x."checkedAt",x."expiresAt"),
 ('execution',x."replayValidatorId",x."replayCheckedAt",x."replayExpiresAt")) required(kind,id,checked,expires)
 WHERE NOT EXISTS(SELECT 1 FROM wallet_service_fact_validators v
 JOIN wallet_service_import_ledger l USING(generation_id,import_id)
 WHERE v.generation_id=x."generationId" AND v.validator_id=required.id AND v.kind=required.kind
 AND v.revoked_at IS NULL AND l.revoked_at IS NULL AND l.proof_scope='validator_authority'
 AND l.imported_at<=required.checked AND v.valid_from<=required.checked AND v.valid_until>=required.expires AND v.valid_until>$2))`;

export function sourceStateBinding(candidate: PostgresRpcSourceFactCandidate, claims: PostgresSourceValidationClaims,
  options: PostgresSourceBindingOptions) {
  const target = candidate.payload.target;
  return { ...claims, activatedAt: options.activatedAt, target, purchase: candidate.replayEvidence.claims.purchase,
    replayValidatorId: options.replayAuthority.validatorId, replayCheckedAt: candidate.replayEvidence.claims.checkedAt,
    replayExpiresAt: candidate.replayEvidence.claims.expiresAt, maximumProfileAgeMs: options.maximumProfileAgeMs,
    subjectKey: forwardTargetSubjectKey(target) };
}
export async function readSourceBinding(tx: PostgresTransaction, candidate: PostgresRpcSourceFactCandidate,
  claims: PostgresSourceValidationClaims, options: PostgresSourceBindingOptions, at: number): Promise<boolean> {
  return (await tx.query(SOURCE_ENVELOPE_STATE_SQL, [JSON.stringify(sourceStateBinding(candidate, claims, options)), at])).rows.length === 1;
}
