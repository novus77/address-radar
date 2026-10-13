import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { executionValidationSigningPayload, type PersistedPostgresExecutionEnvelope,
  type PostgresExecutionCandidate } from "./postgres-execution-fact-publisher.js";
import type { PostgresRpcSourceFactCandidateOptions, PostgresRpcSourceFactCandidateRequest } from "./postgres-rpc-source-fact-candidate.js";
import { postgresServiceFactFingerprint } from "./postgres-service-fact-adapters.js";
import { walletPurchaseBasisFingerprint } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { sourceId, sourceTime, sourceRequire, SourceBindingUnavailable, verifySourceSignature } from "./postgres-source-fact-attestation.js";

export interface PostgresExecutionEnvelopeReaderOptions {
  readonly generationId: string; readonly activatedAt: number;
  /** Trusted read-only native UOW with configured statement timeout; never an RPC or signing port. */
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly replayAuthority: NonNullable<PostgresRpcSourceFactCandidateOptions["authority"]>;
  readonly maximumValidationAgeMs: number; readonly maximumPayloadBytes: number; readonly maximumRunMs: number;
  readonly now: () => number;
}
export interface PostgresExecutionEnvelopeReadRequest {
  readonly generationId: string; readonly sampleId: string; readonly executionFingerprint: string; readonly signal: AbortSignal;
}
export type PostgresExecutionEnvelopeReadResult =
  | { readonly status: "ready"; readonly request: PostgresRpcSourceFactCandidateRequest }
  | { readonly status: "deferred"; readonly reasonCode: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
function decimal(value: unknown): string {
  sourceRequire(typeof value === "string" && value.length <= 512 && /^\d+(?:\.\d+)?$/.test(value), "execution_envelope_revision_mismatch");
  const [whole = "", fraction = ""] = value.split(".");
  return `${whole.replace(/^0+/, "") || "0"}.${fraction.replace(/0+$/, "")}`;
}
function storedTime(value: unknown): number {
  sourceRequire(sourceTime(value) || typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), "execution_envelope_clock_invalid");
  const result = Number(value); sourceRequire(sourceTime(result), "execution_envelope_clock_invalid"); return result;
}
function contentFingerprint(candidate: PostgresExecutionCandidate): string {
  const common = { generationId: candidate.generationId, providerId: candidate.providerId };
  const value = "genesisHash" in candidate
    ? { ...common, genesisHash: candidate.genesisHash, sourceReference: candidate.sourceReference,
      profile: candidate.profile, purchase: candidate.purchaseCandidate, evidence: candidate.evidence }
    : { ...common, chainId: candidate.chainId, genesisBlockHash: candidate.genesisBlockHash,
      sourceReference: candidate.sourceReference, profile: candidate.profile, purchase: candidate.purchaseCandidate,
      transaction: candidate.evidence.transaction, receipt: candidate.evidence.receipt,
      canonicalBlock: candidate.evidence.canonicalBlock, tokenDecimals: candidate.evidence.tokenDecimals };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
const READ_SQL = `SELECT /* execution-envelope-read */ s.sample_id,s.generation_id,s.execution_fingerprint,
 s.entity_id,s.chain,s.token_address,s.occurred_at,s.created_at,t.execution_key,t.original_fingerprint,
 r.state AS revision_state,r.token_quantity::text,r.quote_asset,r.quote_amount::text,r.amount_usd::text,
 r.entry_price_usd::text,r.amount_basis,r.amount_estimated,r.ownership_evidence_ref,r.execution_evidence_ref,r.recorded_at,g.activated_at,
 f.fact_id,f.kind,f.subject_key,f.fingerprint,f.source_ref,f.provider_id,f.observed_at,f.known_at,
 CASE WHEN octet_length(f.payload)<=$5 THEN f.payload ELSE NULL END AS payload,
 a.validator_id,a.validation_ref,a.checked_at,a.expires_at,v.valid_from AS validator_from,v.valid_until AS validator_until,
 v.revoked_at,l.revoked_at AS import_revoked_at,l.imported_at,l.proof_scope
 FROM forward_purchase_samples s
 JOIN forward_strategy_generations g ON g.generation_id=s.generation_id AND g.activated_at=$6
 JOIN forward_economic_trades t ON t.trade_id=s.trade_id AND t.original_fingerprint=s.execution_fingerprint
 JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
 JOIN wallet_service_fact_attestations a ON a.generation_id=s.generation_id AND a.kind='execution'
   AND a.validation_ref=r.execution_evidence_ref
 JOIN wallet_service_fact_inputs f ON f.fact_id=a.fact_id AND f.generation_id=a.generation_id
   AND f.kind=a.kind AND f.fingerprint=a.fingerprint
 JOIN wallet_service_fact_validators v ON v.generation_id=a.generation_id AND v.validator_id=a.validator_id AND v.kind=a.kind
 JOIN wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id
 WHERE s.generation_id=$1 AND s.sample_id=$2 AND s.execution_fingerprint=$3 AND r.state='original'
 AND s.entity_id=r.entity_id AND s.entity_id=t.entity_id AND s.chain=t.chain
 AND s.token_address=r.token_address AND s.token_address=t.token_address
 AND s.occurred_at=r.occurred_at AND s.occurred_at=t.occurred_at AND s.occurred_at>=g.activated_at
 AND s.created_at<=$4 AND r.recorded_at<=$4
 AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions pending WHERE pending.trade_id=s.trade_id
   AND pending.state='pending_review' AND pending.recorded_at<=$4)
 AND a.checked_at<=$4 AND a.expires_at>$4 AND v.valid_from<=a.checked_at AND v.valid_until>=a.expires_at
 AND v.revoked_at IS NULL AND l.revoked_at IS NULL AND l.proof_scope='validator_authority' AND l.imported_at<=a.checked_at
 ORDER BY f.fact_id,a.validator_id LIMIT 2`;

export function createPostgresExecutionEnvelopeReader(input: PostgresExecutionEnvelopeReaderOptions) {
  const options = { ...input, replayAuthority: { ...input.replayAuthority } }, authority = options.replayAuthority;
  sourceRequire(sourceId(options.generationId) && sourceTime(options.activatedAt) && typeof options.run === "function"
    && typeof options.now === "function" && [authority.validatorId, authority.keyId, authority.sourceProviderId, authority.replayProviderId].every(sourceId)
    && new Set([authority.validatorId, authority.sourceProviderId, authority.replayProviderId]).size === 3, "execution_envelope_configuration_invalid");
  for (const [value, maximum] of [[options.maximumValidationAgeMs, 300_000], [options.maximumPayloadBytes, 10_000_000], [options.maximumRunMs, 300_000]]) {
    sourceRequire(sourceTime(value) && value > 0 && value <= maximum!, "execution_envelope_explicit_budget_required");
  }
  let busy = false;
  return Object.freeze({ async load(inputRequest: PostgresExecutionEnvelopeReadRequest): Promise<PostgresExecutionEnvelopeReadResult> {
    const deferred = (reasonCode: string): PostgresExecutionEnvelopeReadResult => ({ status: "deferred", reasonCode });
    if (busy) return deferred("execution_envelope_reader_busy");
    if (inputRequest.signal.aborted) return deferred("execution_envelope_aborted_or_timed_out");
    busy = true;
    const request = { ...inputRequest }, started = performance.now(), controller = new AbortController(), abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true }); if (request.signal.aborted) abort();
    const timer = setTimeout(abort, options.maximumRunMs); let previous = -1;
    const check = () => {
      controller.signal.throwIfAborted(); const at = options.now();
      sourceRequire(sourceTime(at) && at >= previous && performance.now() - started < options.maximumRunMs, "execution_envelope_clock_or_deadline");
      previous = at; return at;
    };
    const work = async (): Promise<PostgresExecutionEnvelopeReadResult> => {
      const at = check();
      sourceRequire(request.generationId === options.generationId && sourceId(request.sampleId)
        && /^[a-f0-9]{64}$/.test(request.executionFingerprint), "execution_envelope_request_binding_invalid");
      const result = await options.run(async tx => {
        check(); const rows = await tx.query(READ_SQL, [options.generationId, request.sampleId, request.executionFingerprint, at,
          options.maximumPayloadBytes, options.activatedAt]); check(); return rows;
      }); check();
      sourceRequire(result.rows.length === 1, "execution_envelope_revision_or_authority_unavailable");
      sourceRequire(Buffer.byteLength(JSON.stringify(result.rows)) <= options.maximumPayloadBytes * 2, "execution_envelope_payload_budget");
      const row = result.rows[0]!;
      sourceRequire(typeof row.payload === "string" && Buffer.byteLength(row.payload) <= options.maximumPayloadBytes, "execution_envelope_payload_budget");
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      sourceRequire(payload.executionEnvelope && typeof payload.executionEnvelope === "object", "execution_envelope_unavailable");
      const envelope = payload.executionEnvelope as PersistedPostgresExecutionEnvelope, candidate = envelope.candidate, validation = envelope.validation;
      sourceRequire(envelope.format === 1 && candidate && validation?.claims, "execution_envelope_format_invalid");
      const claims = validation.claims, purchase = claims.purchase;
      sourceRequire(row.sample_id === request.sampleId && row.generation_id === options.generationId
        && row.execution_fingerprint === request.executionFingerprint && row.original_fingerprint === request.executionFingerprint
        && row.revision_state === "original" && storedTime(row.activated_at) === options.activatedAt
        && storedTime(row.created_at) <= at && storedTime(row.recorded_at) <= at && storedTime(row.occurred_at) >= options.activatedAt,
      "execution_envelope_revision_mismatch");
      sourceRequire(claims.format === 1 && candidate.generationId === options.generationId && claims.generationId === options.generationId
        && claims.providerId === authority.sourceProviderId && candidate.providerId === claims.providerId && row.provider_id === claims.providerId
        && claims.validatorId === authority.validatorId && claims.keyId === authority.keyId && row.validator_id === claims.validatorId
        && claims.sourceBasis.kind === "independent_rpc_replay" && claims.sourceBasis.providerId === authority.replayProviderId
        && sourceId(claims.sourceBasis.evidenceRef) && /^[a-f0-9]{64}$/.test(claims.sourceBasis.contentFingerprint)
        && claims.candidateFingerprint === candidate.contentFingerprint && contentFingerprint(candidate) === candidate.contentFingerprint
        && sourceId(claims.validationRef) && claims.validationRef === row.validation_ref && claims.validationRef === purchase.executionEvidenceRef
        && candidate.sourceReference === claims.sourceReference && row.source_ref === claims.sourceReference
        && sourceTime(candidate.knownAt) && sourceTime(candidate.observedAt) && candidate.observedAt <= candidate.knownAt
        && sourceTime(claims.checkedAt) && sourceTime(claims.expiresAt) && candidate.knownAt <= claims.checkedAt
        && claims.checkedAt <= at && claims.expiresAt > check() && check() - claims.checkedAt <= options.maximumValidationAgeMs
        && storedTime(row.checked_at) === claims.checkedAt && storedTime(row.expires_at) === claims.expiresAt
        && storedTime(row.observed_at) === candidate.observedAt && storedTime(row.known_at) === claims.checkedAt
        && row.proof_scope === "validator_authority" && row.revoked_at === null && row.import_revoked_at === null
        && storedTime(row.imported_at) <= claims.checkedAt && storedTime(row.validator_from) <= claims.checkedAt
        && storedTime(row.validator_until) >= claims.expiresAt,
      "execution_envelope_proof_binding_invalid");
      sourceRequire(verifySourceSignature(executionValidationSigningPayload(claims), validation.signature, authority.publicKey), "execution_envelope_signature_invalid");
      sourceRequire(payload.canonical === "confirmed_execution" && payload.sourceReference === candidate.sourceReference
        && same(payload.validation, validation) && same(payload.purchase, purchase)
        && same(purchase, { ...candidate.purchaseCandidate, executionEvidenceRef: claims.validationRef })
        && walletPurchaseBasisFingerprint(purchase) === claims.purchaseFingerprint
        && row.fingerprint === postgresServiceFactFingerprint(payload)
        && same(payload.acquiredEvidence, { providerId: candidate.providerId,
          ...("genesisHash" in candidate ? { genesisHash: candidate.genesisHash, slot: candidate.slot }
            : { chainId: candidate.chainId, genesisBlockHash: candidate.genesisBlockHash, blockNumber: candidate.blockNumber }),
          blockHash: candidate.blockHash, contentFingerprint: candidate.contentFingerprint, profile: candidate.profile, evidence: candidate.evidence }),
      "execution_envelope_immutable_payload_mismatch");
      sourceRequire(row.entity_id === purchase.entityId && row.chain === purchase.chain && row.token_address === purchase.tokenAddress
        && storedTime(row.occurred_at) === purchase.occurredAt && row.execution_key === purchase.executionKey
        && row.quote_asset === purchase.quoteAsset && row.amount_basis === purchase.amountBasis && row.amount_estimated === purchase.amountEstimated
        && row.ownership_evidence_ref === purchase.ownershipEvidenceRef && row.execution_evidence_ref === purchase.executionEvidenceRef
        && candidate.profile.fact.entityId === purchase.entityId && candidate.profile.wallet.entityId === purchase.entityId
        && candidate.profile.wallet.accountId === purchase.sourceUserId && candidate.profile.fact.ownershipEvidenceRef === purchase.ownershipEvidenceRef
        && row.subject_key === postgresServiceFactFingerprint([purchase.chain, candidate.profile.wallet.address, candidate.sourceReference, purchase.tokenAddress]),
      "execution_envelope_revision_mismatch");
      for (const [stored, signed] of [[row.token_quantity, purchase.tokenQuantity], [row.quote_amount, purchase.quoteAmount],
        [row.amount_usd, purchase.amountUsd], [row.entry_price_usd, purchase.entryPriceUsd]]) {
        sourceRequire(decimal(stored) === decimal(signed), "execution_envelope_revision_mismatch");
      }
      check(); sourceRequire(claims.expiresAt > check(), "execution_envelope_expired");
      return { status: "ready", request: { sampleId: request.sampleId, executionFingerprint: request.executionFingerprint,
        execution: structuredClone(candidate), validation: structuredClone(validation), signal: request.signal } };
    };
    const operation = work().catch(error => deferred(error instanceof SourceBindingUnavailable ? error.message : "execution_envelope_read_unavailable"))
      .finally(() => { busy = false; });
    let onAbort: () => void = () => {};
    const stopped = new Promise<PostgresExecutionEnvelopeReadResult>(resolve => {
      onAbort = () => resolve(deferred("execution_envelope_aborted_or_timed_out"));
      controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort();
    });
    try { return await Promise.race([operation, stopped]); }
    finally { controller.abort(); clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort); }
  } });
}
