import { createPostgresExecutionFactPublisher, type PostgresExecutionPublisherOptions } from "./postgres-execution-fact-publisher.js";
import { postgresServiceFactFingerprint } from "./postgres-service-fact-adapters.js";
import { requestPostgresWalletSignalWake } from "./postgres-production-composition.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import type { PostgresRpcSourceFactCandidate } from "./postgres-rpc-source-fact-candidate.js";
import { checkSourceCandidate, checkSourceConfiguration, readSourceBinding, SOURCE_ENVELOPE_STATE_SQL,
  sourceEnvelopeFingerprint, sourceId, sourceRequire, sourceStateBinding, sourceTime,
  sourceValidationSigningPayload, verifySourceSignature,
  type PostgresSourceBindingOptions, type SignedPostgresSourceValidation } from "./postgres-source-fact-attestation.js";

export interface PostgresSourcePublisherOptions extends PostgresExecutionPublisherOptions, PostgresSourceBindingOptions {}
export interface PostgresSourcePublishRequest { readonly candidate: PostgresRpcSourceFactCandidate;
  readonly validation: SignedPostgresSourceValidation; readonly signal: AbortSignal }
export type PostgresSourcePublishResult = { readonly status: "published" | "duplicate"; readonly factId: string }
  | { readonly status: "deferred"; readonly reasonCode: string };
async function checkPrivileges(tx: PostgresTransaction): Promise<void> {
  const protectedTables = ["forward_purchase_samples", "forward_trade_revisions", "forward_economic_trades", "forward_strategy_generations",
    "forward_target_channel_versions", "forward_target_channel_heads", "forward_target_identity_bindings", "wallet_service_profile_cohort",
    "wallet_service_profile_versions", "wallet_service_import_ledger", "wallet_service_fact_validators"];
  const rows = await tx.query(`SELECT /* source-publisher-privileges */
    NOT EXISTS(SELECT 1 FROM unnest($1::text[]) t(name) WHERE
      NOT has_table_privilege(current_user,t.name,'SELECT') OR has_table_privilege(current_user,t.name,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES'))
    AND has_table_privilege(current_user,'wallet_forward_signal_wake_intents','INSERT')
    AND NOT has_table_privilege(current_user,'wallet_forward_signal_wake_intents','UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') AS safe`, [protectedTables]);
  sourceRequire(rows.rows.length === 1 && rows.rows[0]!.safe === true, "source_publisher_privileges_invalid");
}
export async function createPostgresSourceFactPublisher(input: PostgresSourcePublisherOptions) {
  const options = { ...input, replayAuthority: { ...input.replayAuthority }, validators: structuredClone(input.validators) };
  checkSourceConfiguration(options);
  await createPostgresExecutionFactPublisher(options);
  await options.run(checkPrivileges);
  return Object.freeze({ async publish(request: PostgresSourcePublishRequest): Promise<PostgresSourcePublishResult> {
    const candidate = structuredClone(request.candidate), validation = structuredClone(request.validation);
    request.signal.throwIfAborted(); const at = options.now();
    sourceRequire(sourceTime(at) && Buffer.byteLength(JSON.stringify({ candidate, validation })) <= options.maximumPayloadBytes, "source_payload_or_clock_invalid");
    // Expiry is a normal deferred state; malformed envelopes and forged signatures are contract errors.
    if (validation?.claims && sourceTime(validation.claims.expiresAt) && validation.claims.expiresAt <= at) {
      return { status: "deferred", reasonCode: "source_attestation_expired" };
    }
    checkSourceCandidate(candidate, options, at);
    const claims = validation.claims, validator = options.validators.find(v => v.validatorId === claims?.validatorId && v.keyId === claims.keyId);
    sourceRequire(validator && claims.format === 1 && claims.validatorId !== options.replayAuthority.validatorId
      && validator.reviewedSourceProviders.includes(options.replayAuthority.replayProviderId)
      && ![options.replayAuthority.sourceProviderId, options.replayAuthority.replayProviderId].includes(claims.validatorId)
      && claims.generationId === options.generationId && claims.sampleId === candidate.payload.sampleId
      && claims.executionFingerprint === candidate.payload.executionFingerprint && claims.targetVersionId === candidate.targetVersionId
      && claims.envelopeFingerprint === sourceEnvelopeFingerprint(candidate) && sourceId(claims.validationRef)
      && sourceTime(claims.checkedAt) && sourceTime(claims.expiresAt) && claims.checkedAt >= candidate.checkedAt
      && claims.checkedAt <= at && at - claims.checkedAt <= options.maximumValidationAgeMs && claims.expiresAt > at
      && claims.expiresAt <= candidate.replayEvidence.claims.expiresAt
      && verifySourceSignature(sourceValidationSigningPayload(claims), validation.signature, validator.publicKey), "source_exact_attestation_invalid");
    const check = () => {
      request.signal.throwIfAborted(); const current = options.now();
      sourceRequire(sourceTime(current) && current >= at && current < claims.expiresAt
        && current - claims.checkedAt <= options.maximumValidationAgeMs, "source_publication_deadline"); return current;
    };
    return options.run(async tx => {
      check(); await createPostgresExecutionFactPublisher({ ...options, run: operation => operation(tx) }); check();
      await checkPrivileges(tx); check();
      if (!await readSourceBinding(tx, candidate, claims, options, check())) return { status: "deferred", reasonCode: "source_current_binding_unavailable" };
      check();
      const factId = `source:${sourceEnvelopeFingerprint([options.generationId, candidate.payload.sampleId,
        candidate.payload.executionFingerprint, candidate.targetVersionId, candidate.payload.target])}`;
      const payload = JSON.stringify({ ...candidate.payload, targetVersionId: candidate.targetVersionId, validation, replayEvidence: candidate.replayEvidence });
      const fact = { fact_id: factId, generation_id: options.generationId, kind: "source", subject_key: candidate.subjectKey,
        payload, fingerprint: postgresServiceFactFingerprint(JSON.parse(payload)), source_ref: claims.validationRef,
        provider_id: options.replayAuthority.sourceProviderId, observed_at: candidate.replayEvidence.claims.purchase.occurredAt, known_at: claims.checkedAt };
      const attestation = { generation_id: options.generationId, fact_id: factId, validator_id: claims.validatorId, kind: "source",
        fingerprint: fact.fingerprint, validation_ref: claims.validationRef, checked_at: claims.checkedAt, expires_at: claims.expiresAt };
      const existing = await tx.query(`SELECT /* source-publisher-existing */ row_to_json(i) AS input,row_to_json(a) AS attestation
        FROM wallet_service_fact_inputs i LEFT JOIN wallet_service_fact_attestations a USING(generation_id,fact_id,kind)
        WHERE i.fact_id=$1`, [factId]); check();
      if (existing.rows.length) {
        const row = existing.rows[0]!;
        const normalized = (value: unknown) => {
          const obj = typeof value === "string" ? JSON.parse(value) : value;
          if (obj && typeof obj === "object") for (const field of ["observed_at", "known_at", "checked_at", "expires_at"]) {
            if (field in obj) obj[field] = Number(obj[field]);
          }
          return obj;
        };
        sourceRequire(existing.rows.length === 1 && sourceEnvelopeFingerprint(normalized(row.input)) === sourceEnvelopeFingerprint(fact)
          && sourceEnvelopeFingerprint(normalized(row.attestation)) === sourceEnvelopeFingerprint(attestation), "source_immutable_proof_collision");
        sourceRequire(await readSourceBinding(tx, candidate, claims, options, check()), "source_binding_changed"); check();
        return { status: "duplicate", factId };
      }
      await tx.query(`INSERT INTO wallet_service_fact_inputs SELECT * FROM jsonb_populate_record(NULL::wallet_service_fact_inputs,$1::jsonb)`, [JSON.stringify(fact)]); check();
      // Offset both parameters simultaneously: binding=$2, current clock=$3.
      const guarded = SOURCE_ENVELOPE_STATE_SQL.replace(/\$(1|2)\b/g, (_, n: string) => n === "1" ? "$2" : "$3");
      const inserted = await tx.query(`INSERT INTO wallet_service_fact_attestations
        SELECT a.* FROM jsonb_populate_record(NULL::wallet_service_fact_attestations,$1::jsonb) a
        WHERE EXISTS(${guarded}) RETURNING fact_id`, [JSON.stringify(attestation), JSON.stringify(sourceStateBinding(candidate, claims, options)), check()]); check();
      sourceRequire(inserted.rows.length === 1, "source_binding_changed_before_attestation");
      await requestPostgresWalletSignalWake(tx, { generationId: options.generationId, chain: candidate.replayEvidence.claims.purchase.chain,
        tokenAddress: candidate.replayEvidence.claims.purchase.tokenAddress, sourceKey: factId, now: check() }); check();
      sourceRequire(await readSourceBinding(tx, candidate, claims, options, check()), "source_binding_changed_before_commit"); check();
      return { status: "published", factId };
    });
  } });
}
