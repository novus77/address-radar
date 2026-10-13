import { createPublicKey, verify } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { postgresServiceFactFingerprint } from "./postgres-service-fact-adapters.js";
import { executionValidationSigningPayload, type PostgresExecutionCandidate,
  type SignedPostgresExecutionValidation } from "./postgres-execution-fact-publisher.js";
import { selectPostgresWalletProfiles, walletPurchaseBasisFingerprint,
  type PostgresWalletChannelOptions, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";

export interface PostgresRpcSourceFactCandidateOptions {
  readonly generationId: string; readonly activatedAt: number;
  /** Trusted, read-only native port. This module never allocates a pool or performs RPC. */
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly profiles: PostgresWalletChannelOptions["profiles"];
  readonly authority?: { readonly validatorId: string; readonly keyId: string; readonly publicKey: string;
    readonly sourceProviderId: string; readonly replayProviderId: string } | undefined;
  readonly maximumProfiles: number; readonly maximumPayloadBytes: number;
  readonly maximumValidationAgeMs: number; readonly maximumRunMs: number; readonly now: () => number;
}
export interface PostgresRpcSourceFactCandidateRequest {
  readonly sampleId: string; readonly executionFingerprint: string;
  readonly execution: PostgresExecutionCandidate;
  /** Reuse the existing independent validator result; never fetch the same replay a second time. */
  readonly validation: SignedPostgresExecutionValidation; readonly signal: AbortSignal;
}
export interface PostgresRpcSourceFactCandidate {
  readonly kind: "source"; readonly generationId: string; readonly subjectKey: string; readonly checkedAt: number;
  readonly payload: { readonly sampleId: string; readonly executionFingerprint: string;
    readonly target: PostgresWalletProfile["fact"]; readonly canonical: "confirmed_live_execution" };
  readonly replayEvidence: SignedPostgresExecutionValidation;
  readonly targetVersionId: string;
  /** Execution signatures do not independently attest the new sample/revision/target envelope. */
  readonly publication: { readonly status: "deferred"; readonly reasonCode: "source_exact_binding_not_independently_attested" };
}
export type PostgresRpcSourceFactCandidateResult =
  | { readonly status: "candidate_ready"; readonly candidate: PostgresRpcSourceFactCandidate }
  | { readonly status: "deferred"; readonly reasonCode: string };
class SourceRefused extends Error {}
function requireProof(value: unknown, reason: string): asserts value { if (!value) throw new SourceRefused(reason); }
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 512 && !value.includes("://");
function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value) ?? "null";
  return canonical(left) === canonical(right);
}
function decimal(value: unknown): string {
  requireProof(typeof value === "string" && value.length <= 512 && /^\d+(?:\.\d+)?$/.test(value), "source_revision_mismatch");
  const [whole = "", fraction = ""] = value.split(".");
  const normalized = whole.replace(/^0+/, "") || "0", tail = fraction.replace(/0+$/, "");
  requireProof(normalized !== "0" || !!tail, "source_revision_mismatch");
  return normalized + (tail ? `.${tail}` : "");
}

/** Read-only candidate verification. No signing key, INSERT, attestation, wake or publication port exists here. */
export function createPostgresRpcSourceFactCandidateVerifier(inputOptions: PostgresRpcSourceFactCandidateOptions) {
  const options = { ...inputOptions, authority: inputOptions.authority ? structuredClone(inputOptions.authority) : undefined };
  requireProof(id(options.generationId) && time(options.activatedAt) && typeof options.run === "function"
    && typeof options.profiles?.load === "function" && typeof options.now === "function", "source_configuration_invalid");
  for (const [value, maximum] of [[options.maximumProfiles, 10_000], [options.maximumPayloadBytes, 10_000_000],
    [options.maximumValidationAgeMs, 300_000], [options.maximumRunMs, 300_000]]) {
    requireProof(time(value) && value > 0 && value <= maximum!, "source_explicit_budget_required");
  }
  const authority = options.authority;
  if (authority) requireProof([authority.validatorId, authority.keyId, authority.sourceProviderId, authority.replayProviderId].every(id)
    && new Set([authority.validatorId, authority.sourceProviderId, authority.replayProviderId]).size === 3, "source_authority_invalid");
  const key = authority ? createPublicKey(authority.publicKey) : undefined;
  requireProof(!key || key.asymmetricKeyType === "ed25519", "source_authority_invalid");
  let busy = false;
  return Object.freeze({ async verify(input: PostgresRpcSourceFactCandidateRequest): Promise<PostgresRpcSourceFactCandidateResult> {
    const deferred = (reasonCode: string) => ({ status: "deferred" as const, reasonCode });
    if (!authority || !key) return deferred("source_authority_unavailable");
    if (busy) return deferred("source_verifier_busy");
    if (input.signal.aborted) return deferred("source_verifier_aborted_or_timed_out");
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
    const timer = setTimeout(abort, options.maximumRunMs), started = performance.now();
    let lastAt: number | undefined;
    const check = () => {
      controller.signal.throwIfAborted(); const at = options.now();
      requireProof(time(at) && (lastAt === undefined || at >= lastAt) && performance.now() - started < options.maximumRunMs,
        "source_clock_or_deadline"); lastAt = at; return at;
    };
    let onAbort: () => void = () => {};
    const stopped = new Promise<PostgresRpcSourceFactCandidateResult>(resolve => {
      onAbort = () => resolve(deferred("source_verifier_aborted_or_timed_out"));
      controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort();
    });
    const work = async (): Promise<PostgresRpcSourceFactCandidateResult> => {
      const at = check();
      requireProof(Buffer.byteLength(JSON.stringify({ sampleId: input.sampleId, executionFingerprint: input.executionFingerprint,
        execution: input.execution, validation: input.validation })) <= options.maximumPayloadBytes, "source_payload_budget");
      const request = structuredClone({ sampleId: input.sampleId, executionFingerprint: input.executionFingerprint,
        execution: input.execution, validation: input.validation });
      const { execution, validation } = request, claims = validation.claims, purchase = claims.purchase;
      requireProof(id(request.sampleId) && /^[a-f0-9]{64}$/.test(request.executionFingerprint)
        && claims.format === 1 && claims.generationId === options.generationId && execution.generationId === options.generationId
        && claims.providerId === authority.sourceProviderId && execution.providerId === claims.providerId
        && claims.validatorId === authority.validatorId && claims.keyId === authority.keyId
        && claims.sourceBasis.kind === "independent_rpc_replay" && claims.sourceBasis.providerId === authority.replayProviderId
        && /^[a-f0-9]{64}$/.test(claims.sourceBasis.contentFingerprint) && id(claims.sourceBasis.evidenceRef)
        && /^[a-f0-9]{64}$/.test(claims.candidateFingerprint) && claims.candidateFingerprint === execution.contentFingerprint
        && claims.sourceReference === execution.sourceReference && id(claims.validationRef)
        && time(execution.knownAt) && time(claims.checkedAt) && time(claims.expiresAt)
        && execution.knownAt <= claims.checkedAt && claims.checkedAt <= at && claims.expiresAt > at
        && at - claims.checkedAt <= options.maximumValidationAgeMs
        && purchase.executionEvidenceRef === claims.validationRef
        && claims.purchaseFingerprint === walletPurchaseBasisFingerprint(purchase)
        && same(purchase, { ...execution.purchaseCandidate, executionEvidenceRef: claims.validationRef }), "source_replay_binding_unavailable");
      const signature = Buffer.from(validation.signature, "base64");
      requireProof(signature.length === 64 && signature.toString("base64") === validation.signature
        && verify(null, executionValidationSigningPayload(claims), key, signature), "source_replay_signature_invalid");
      const family = purchase.chain === "solana" ? "solana" : "evm";
      const currentProfile = async () => {
        check();
        const loaded = await options.profiles.load({ generationId: options.generationId, chainFamily: family,
          asOf: check(), limit: options.maximumProfiles, signal: controller.signal }); check();
        requireProof(loaded.status === "ready" && loaded.profiles.length <= options.maximumProfiles, "source_current_target_unavailable");
        const matches = selectPostgresWalletProfiles(loaded.profiles, family).filter(profile => same(profile, execution.profile));
        requireProof(matches.length === 1 && matches[0]!.fact.entityId === purchase.entityId
          && matches[0]!.fact.ownershipEvidenceRef === purchase.ownershipEvidenceRef, "source_current_target_unavailable");
        return matches[0]!;
      };
      const profile = await currentProfile();
      await options.run(async tx => {
        const authorityRows = await tx.query(`SELECT /* source-candidate-authority */ v.kind
          FROM wallet_service_fact_validators v JOIN wallet_service_import_ledger l USING(generation_id,import_id)
          WHERE v.generation_id=$1 AND v.validator_id=$2 AND v.kind IN ('execution','source')
            AND v.revoked_at IS NULL AND l.revoked_at IS NULL AND l.proof_scope='validator_authority'
            AND l.imported_at<=$3 AND v.valid_from<=$3 AND v.valid_until>=$4 AND v.valid_until>$5`,
        [options.generationId, authority.validatorId, claims.checkedAt, claims.expiresAt, check()]); check();
        requireProof(authorityRows.rows.length === 2 && new Set(authorityRows.rows.map(row => row.kind)).size === 2
          && authorityRows.rows.every(row => row.kind === "execution" || row.kind === "source"), "source_authority_unavailable");
        const result = await tx.query(`SELECT /* source-candidate-revision */ s.*,t.execution_key,t.original_fingerprint,
          r.state AS revision_state,r.token_quantity::text,r.quote_asset,r.quote_amount::text,r.amount_usd::text,
          r.entry_price_usd::text,r.amount_basis,r.amount_estimated,r.ownership_evidence_ref,r.execution_evidence_ref,
          r.recorded_at,g.activated_at
          FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
          JOIN forward_economic_trades t ON t.trade_id=s.trade_id AND t.original_fingerprint=s.execution_fingerprint
          JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
          WHERE s.sample_id=$1 AND s.generation_id=$2 AND s.execution_fingerprint=$3 AND r.state='original'
            AND s.entity_id=r.entity_id AND s.token_address=r.token_address AND s.occurred_at=r.occurred_at
            AND t.entity_id=s.entity_id AND t.chain=s.chain AND t.token_address=s.token_address AND t.occurred_at=s.occurred_at
            AND s.created_at<=$4 AND r.recorded_at<=$4 AND s.occurred_at>=g.activated_at
            AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions pending WHERE pending.trade_id=s.trade_id
              AND pending.state='pending_review' AND pending.recorded_at<=$4)`,
        [request.sampleId, options.generationId, request.executionFingerprint, check()]); check();
        requireProof(result.rows.length === 1, "source_revision_unavailable");
        const row = result.rows[0]!;
        requireProof(row.sample_id === request.sampleId && row.generation_id === options.generationId
          && row.execution_fingerprint === request.executionFingerprint && row.original_fingerprint === request.executionFingerprint
          && row.revision_state === "original" && row.entity_id === purchase.entityId && row.chain === purchase.chain
          && row.token_address === purchase.tokenAddress && row.execution_key === purchase.executionKey
          && row.quote_asset === purchase.quoteAsset && row.amount_basis === purchase.amountBasis && row.amount_estimated === purchase.amountEstimated
          && row.ownership_evidence_ref === purchase.ownershipEvidenceRef && row.execution_evidence_ref === purchase.executionEvidenceRef,
        "source_revision_mismatch");
        for (const [stored, expected] of [[row.occurred_at, purchase.occurredAt], [row.activated_at, options.activatedAt]]) {
          requireProof((typeof stored === "string" && /^(0|[1-9][0-9]*)$/.test(stored) || time(stored))
            && Number(stored) === expected, "source_revision_mismatch");
        }
        for (const stored of [row.created_at, row.recorded_at]) requireProof((typeof stored === "string" && /^(0|[1-9][0-9]*)$/.test(stored) || time(stored))
          && Number.isSafeInteger(Number(stored)) && Number(stored) <= at, "source_revision_mismatch");
        for (const [stored, expected] of [[row.token_quantity, purchase.tokenQuantity], [row.quote_amount, purchase.quoteAmount],
          [row.amount_usd, purchase.amountUsd], [row.entry_price_usd, purchase.entryPriceUsd]]) {
          requireProof(decimal(stored) === decimal(expected), "source_revision_mismatch");
        }
      }); check();
      await currentProfile();
      const checkedAt = check(); requireProof(checkedAt < claims.expiresAt
        && checkedAt - claims.checkedAt <= options.maximumValidationAgeMs, "source_replay_expired");
      const candidate: PostgresRpcSourceFactCandidate = { kind: "source", generationId: options.generationId,
        subjectKey: postgresServiceFactFingerprint([request.sampleId, request.executionFingerprint]), checkedAt,
        payload: { sampleId: request.sampleId, executionFingerprint: request.executionFingerprint,
          target: structuredClone(profile.fact), canonical: "confirmed_live_execution" }, replayEvidence: validation,
        targetVersionId: profile.versionId,
        publication: { status: "deferred", reasonCode: "source_exact_binding_not_independently_attested" } };
      requireProof(Buffer.byteLength(JSON.stringify(candidate)) <= options.maximumPayloadBytes, "source_payload_budget");
      return { status: "candidate_ready", candidate };
    };
    // Keep busy until outstanding native reads settle, even if a port ignores cancellation.
    const operation = work().catch(error => deferred(error instanceof SourceRefused ? error.message : "source_verification_unavailable"))
      .finally(() => { busy = false; });
    try { return await Promise.race([operation, stopped]); }
    finally { controller.abort(); clearTimeout(timer); input.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", onAbort); }
  } });
}
