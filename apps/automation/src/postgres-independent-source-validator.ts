import { createPrivateKey, createPublicKey, sign, KeyObject } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PostgresRpcSourceFactCandidate } from "./postgres-rpc-source-fact-candidate.js";
import { checkSourceCandidate, checkSourceConfiguration, readSourceBinding, sourceEnvelopeFingerprint,
  sourceId, sourceRequire, sourceTime, SourceBindingUnavailable, sourceValidationSigningPayload,
  type PostgresSourceBindingOptions, type PostgresSourceValidationClaims, type SignedPostgresSourceValidation } from "./postgres-source-fact-attestation.js";

export interface PostgresIndependentSourceValidatorOptions extends PostgresSourceBindingOptions {
  readonly validatorId: string; readonly keyId: string; readonly actorId: string; readonly publicKey: string;
  readonly signingKey: { loadPrivateKey(): string | KeyObject | Promise<string | KeyObject> };
  readonly validationTtlMs: number; readonly maximumRunMs: number; readonly maximumNonces: number;
  readonly nonce: () => string;
}
export type PostgresSourceValidationResult = { readonly status: "verified"; readonly validation: SignedPostgresSourceValidation }
  | { readonly status: "deferred"; readonly reasonCode: string };
export function createPostgresIndependentSourceValidator(input: PostgresIndependentSourceValidatorOptions) {
  const options = { ...input, replayAuthority: { ...input.replayAuthority } };
  checkSourceConfiguration(options);
  sourceRequire([options.validatorId, options.keyId, options.actorId].every(sourceId)
    && options.validatorId !== options.replayAuthority.validatorId
    && ![options.replayAuthority.sourceProviderId, options.replayAuthority.replayProviderId].includes(options.validatorId)
    && [options.validationTtlMs, options.maximumRunMs, options.maximumNonces].every(v => sourceTime(v) && v > 0)
    && options.maximumRunMs <= 300000 && options.validationTtlMs <= options.maximumValidationAgeMs
    && options.maximumNonces <= 100000 && typeof options.nonce === "function", "source_validator_configuration_invalid");
  const nonces = new Set<string>();
  let busy = false;
  return Object.freeze({ async validateSource(request: { readonly candidate: PostgresRpcSourceFactCandidate;
    readonly signal: AbortSignal }): Promise<PostgresSourceValidationResult> {
    if (busy) return { status: "deferred", reasonCode: "source_validator_busy" };
    busy = true;
    const started = performance.now(); let previous = -1;
    const check = () => {
      request.signal.throwIfAborted(); const at = options.now();
      sourceRequire(sourceTime(at) && at >= previous && performance.now() - started < options.maximumRunMs, "source_validator_deadline");
      previous = at; return at;
    };
    try {
      check(); const candidate = structuredClone(request.candidate); checkSourceCandidate(candidate, options, check());
      const at = check(), nonce = options.nonce();
      sourceRequire(sourceId(nonce) && !nonces.has(nonce) && nonces.size < options.maximumNonces, "source_validator_nonce_unavailable");
      const claims: PostgresSourceValidationClaims = { format: 1, generationId: options.generationId,
        sampleId: candidate.payload.sampleId, executionFingerprint: candidate.payload.executionFingerprint,
        targetVersionId: candidate.targetVersionId, envelopeFingerprint: sourceEnvelopeFingerprint(candidate),
        validatorId: options.validatorId, keyId: options.keyId, checkedAt: at,
        expiresAt: Math.min(at + options.validationTtlMs, candidate.replayEvidence.claims.expiresAt),
        validationRef: `source:${options.validatorId}:${nonce}` };
      const available = await options.run(async tx => {
        check(); const result = await readSourceBinding(tx, candidate, claims, options, check()); check(); return result;
      });
      sourceRequire(available, "source_current_binding_unavailable");
      const loadedKey = await options.signingKey.loadPrivateKey(); check();
      const key = loadedKey instanceof KeyObject ? loadedKey : createPrivateKey(loadedKey);
      nonces.add(nonce);
      sourceRequire(key.asymmetricKeyType === "ed25519" && createPublicKey(key).export({ type: "spki", format: "pem" }).toString()
        === createPublicKey(options.publicKey).export({ type: "spki", format: "pem" }).toString(), "source_signing_key_mismatch");
      checkSourceCandidate(candidate, options, check()); sourceRequire(check() < claims.expiresAt, "source_attestation_expired");
      sourceRequire(await options.run(tx => readSourceBinding(tx, candidate, claims, options, check())), "source_binding_changed_before_signing");
      check(); sourceRequire(check() < claims.expiresAt, "source_attestation_expired");
      const validation = { claims, signature: sign(null, sourceValidationSigningPayload(claims), key).toString("base64") };
      check(); return { status: "verified", validation };
    } catch (error) { return { status: "deferred", reasonCode: error instanceof SourceBindingUnavailable ? error.message : "source_independent_attestation_unavailable" }; }
    finally { busy = false; }
  } });
}
