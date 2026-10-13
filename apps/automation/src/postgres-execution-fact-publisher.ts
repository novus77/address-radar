import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { PostgresTransaction } from "@address-radar/database";
import { postgresServiceFactFingerprint } from "./postgres-service-fact-adapters.js";
import { walletPurchaseBasisFingerprint, type VerifiedExternalWalletBasis } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresSolanaExecutionCandidate } from "./postgres-wallet-rpc-producer.js";
import type { PostgresEvmExecutionCandidate } from "./postgres-evm-execution-producer.js";

export type PostgresExecutionCandidate = PostgresSolanaExecutionCandidate | PostgresEvmExecutionCandidate;

type Purchase = PostgresSolanaExecutionCandidate["purchaseCandidate"];
export interface PostgresExecutionValidationClaims {
  readonly format: 1; readonly generationId: string; readonly providerId: string;
  readonly validatorId: string; readonly keyId: string; readonly candidateFingerprint: string;
  readonly sourceReference: string; readonly validationRef: string;
  readonly checkedAt: number; readonly expiresAt: number;
  readonly sourceBasis: { readonly kind: "independent_rpc_replay"; readonly providerId: string;
    readonly evidenceRef: string; readonly contentFingerprint: string };
  readonly purchase: Purchase; readonly purchaseFingerprint: string;
}
export interface SignedPostgresExecutionValidation {
  readonly claims: PostgresExecutionValidationClaims; readonly signature: string;
}
export interface PersistedPostgresExecutionEnvelope {
  readonly format: 1;
  readonly candidate: PostgresExecutionCandidate;
  readonly validation: SignedPostgresExecutionValidation;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Domain-separated bytes signed by an external approved validator, never by this publisher. */
export function executionValidationSigningPayload(claims: PostgresExecutionValidationClaims): Buffer {
  return Buffer.from(`address-radar/execution-validation/v1\n${canonical(claims)}`, "utf8");
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function id(value: string): void {
  assert(typeof value === "string" && !!value.trim() && value.length <= 512 && !value.includes("://"), "Bounded credential-free proof identity required");
}
function clock(value: number): void { assert(Number.isSafeInteger(value) && value >= 0, "Invalid proof clock"); }
function positive(value: number, maximum = 2_147_483_647): void {
  assert(Number.isSafeInteger(value) && value > 0 && value <= maximum, "Explicit bounded publication budget required");
}
export interface PostgresExecutionPublisherOptions {
  /** Separately authorized native UOW. A six-service BusinessRuntime is deliberately ineligible. */
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly target: { readonly database: string; readonly schema: string; readonly username: string;
    readonly serverAddress: string; readonly serverPort: number; readonly generationId: string;
    readonly schemaVersion: number; readonly schemaFingerprint: string };
  /** All six consumer roles and the migration/seed role; publisher membership in any is forbidden. */
  readonly forbiddenRoles: readonly string[];
  readonly validators: readonly { readonly validatorId: string; readonly keyId: string; readonly publicKey: string;
    readonly actorId: string; readonly authorizationRef: string; readonly reviewedSourceProviders: readonly string[] }[];
  readonly maximumValidationAgeMs: number; readonly maximumPayloadBytes: number;
  readonly statementTimeoutMs: number; readonly lockTimeoutMs: number; readonly now: () => number;
}
export interface PostgresExecutionPublication {
  readonly status: "published" | "duplicate"; readonly factId: string;
  readonly purchase: Purchase; readonly externalBasis: VerifiedExternalWalletBasis;
}

export async function createPostgresExecutionFactPublisher(options: PostgresExecutionPublisherOptions) {
  const target = options.target;
  for (const value of [target.database, target.username, target.generationId, target.serverAddress]) id(value);
  assert(/^[a-z_][a-z0-9_]*$/.test(target.schema) && !["public", "pg_catalog", "information_schema"].includes(target.schema), "Pinned publisher schema required");
  positive(target.serverPort, 65535); positive(target.schemaVersion);
  assert(/^[a-f0-9]{64}$/.test(target.schemaFingerprint), "Pinned schema fingerprint required");
  positive(options.maximumValidationAgeMs); positive(options.maximumPayloadBytes, 10_000_000);
  positive(options.statementTimeoutMs); positive(options.lockTimeoutMs);
  assert(options.lockTimeoutMs <= options.statementTimeoutMs, "Publisher lock budget exceeds statement budget");
  assert(options.forbiddenRoles.length >= 7 && new Set(options.forbiddenRoles).size === options.forbiddenRoles.length,
    "Complete distinct consumer/migration role exclusion required");
  options.forbiddenRoles.forEach(id);
  assert(!options.forbiddenRoles.includes(target.username), "Consumer cannot be a proof publisher");
  const keys = new Map<string, { readonly configuration: PostgresExecutionPublisherOptions["validators"][number]; readonly key: KeyObject }>();
  for (const configuration of options.validators) {
    [configuration.validatorId, configuration.keyId, configuration.actorId, configuration.authorizationRef].forEach(id);
    assert(configuration.reviewedSourceProviders.length > 0, "Reviewed independent source bindings required");
    configuration.reviewedSourceProviders.forEach(id);
    const key = createPublicKey(configuration.publicKey);
    assert(key.asymmetricKeyType === "ed25519", "Approved Ed25519 verification key required");
    const index = `${configuration.validatorId}:${configuration.keyId}`;
    assert(!keys.has(index), "Duplicate validator key binding"); keys.set(index, { configuration, key });
  }
  assert(keys.size > 0, "External approved validator key required");
  async function identity(transaction: PostgresTransaction): Promise<void> {
    await transaction.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
      [String(options.statementTimeoutMs), String(options.lockTimeoutMs)]);
    const result = await transaction.query(`/* execution-publisher-identity */
      SELECT current_database() AS database,current_user AS username,session_user AS session_username,current_schema() AS schema,
        COALESCE(host(inet_server_addr()),'local') AS "serverAddress",COALESCE(inet_server_port(),0) AS "serverPort",
        (SELECT generation_id FROM business_schema_identity WHERE singleton=true) AS schema_generation,
        (SELECT version FROM business_schema_ledger ORDER BY version DESC LIMIT 1) AS schema_version,
        (SELECT fingerprint FROM business_schema_ledger ORDER BY version DESC LIMIT 1) AS schema_fingerprint,
        NOT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
          AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
          AND pg_my_temp_schema()=0 AND current_schemas(false)<@ARRAY[$1,'pg_catalog']::name[]
          AND NOT has_schema_privilege(current_user,$1,'CREATE')
          AND NOT has_database_privilege(current_user,current_database(),'CREATE')
          AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND (c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))) AS role_safe,
        EXISTS(SELECT 1 FROM unnest($2::text[]) excluded(role_name) WHERE pg_has_role(current_user,role_name,'MEMBER')) AS consumer_member,
        (SELECT count(*)=5 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND c.relname IN ('business_schema_identity','business_schema_ledger',
            'wallet_service_fact_inputs','wallet_service_fact_attestations','wallet_service_fact_validators')
          AND c.relkind='r' AND c.relpersistence='p') AS objects_safe,
        NOT EXISTS(SELECT 1 FROM unnest(ARRAY['business_schema_identity','business_schema_ledger','migration_cutover_transitions',
          'wallet_service_import_ledger','wallet_service_profile_cohort','wallet_service_profile_versions','wallet_service_fact_validators']) protected(name)
          WHERE has_table_privilege(current_user,format('%I.%I',$1,name),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(current_user,format('%I.%I',$1,name),'INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['wallet_service_fact_inputs','wallet_service_fact_attestations']) proof(name)
          WHERE has_table_privilege(current_user,format('%I.%I',$1,name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(current_user,format('%I.%I',$1,name),'UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND c.relname IN ('wallet_service_fact_inputs','wallet_service_fact_attestations')
            AND a.attnum>0 AND NOT a.attisdropped AND NOT has_column_privilege(current_user,c.oid,a.attnum,'INSERT')) AS can_publish`,
    [target.schema, options.forbiddenRoles]);
    const row = result.rows[0];
    assert(result.rows.length === 1 && row && row.database === target.database && row.username === target.username
      && row.session_username === target.username && row.schema === target.schema && row.serverAddress === target.serverAddress
      && Number(row.serverPort) === target.serverPort && row.schema_generation === target.generationId
      && Number(row.schema_version) === target.schemaVersion && row.schema_fingerprint === target.schemaFingerprint
      && row.role_safe === true && row.consumer_member === false && row.objects_safe === true && row.can_publish === true,
    "Dedicated verified publisher identity/ACL required");
  }
  await options.run(identity);
  return Object.freeze({
    async publish(input: { readonly candidate: PostgresExecutionCandidate; readonly validation: SignedPostgresExecutionValidation;
      readonly signal: AbortSignal }): Promise<PostgresExecutionPublication> {
      input.signal.throwIfAborted();
      const candidate = structuredClone(input.candidate), validation = structuredClone(input.validation), claims = validation.claims;
      const at = options.now(); clock(at);
      assert(Buffer.byteLength(JSON.stringify({ candidate, validation })) <= options.maximumPayloadBytes, "Execution proof payload exceeds budget");
      [claims.generationId, claims.providerId, claims.validatorId, claims.keyId, claims.sourceReference, claims.validationRef,
        claims.sourceBasis.evidenceRef, claims.sourceBasis.providerId].forEach(id);
      clock(claims.checkedAt); clock(claims.expiresAt); clock(candidate.knownAt); clock(candidate.observedAt);
      const pin = keys.get(`${claims.validatorId}:${claims.keyId}`);
      assert(pin && claims.format === 1 && candidate.generationId === target.generationId && claims.generationId === target.generationId
        && candidate.providerId === claims.providerId && candidate.providerId !== claims.validatorId
        && candidate.providerId !== pin.configuration.actorId && claims.sourceBasis.kind === "independent_rpc_replay"
        && claims.sourceBasis.providerId !== candidate.providerId
        && pin.configuration.reviewedSourceProviders.includes(claims.sourceBasis.providerId)
        && /^[a-f0-9]{64}$/.test(claims.sourceBasis.contentFingerprint)
        && claims.sourceReference === candidate.sourceReference && claims.candidateFingerprint === candidate.contentFingerprint
        && claims.checkedAt >= candidate.knownAt && claims.checkedAt <= at && claims.expiresAt > at
        && at - claims.checkedAt <= options.maximumValidationAgeMs, "Independent source/candidate/clock validation required");
      const signature = Buffer.from(validation.signature, "base64");
      assert(signature.length === 64 && signature.toString("base64") === validation.signature
        && verify(null, executionValidationSigningPayload(claims), pin.key, signature), "External validator signature invalid");
      const purchase = claims.purchase;
      assert(purchase.executionEvidenceRef === claims.validationRef
        && canonical({ ...purchase, executionEvidenceRef: candidate.purchaseCandidate.executionEvidenceRef }) === canonical(candidate.purchaseCandidate)
        && walletPurchaseBasisFingerprint(purchase) === claims.purchaseFingerprint, "Signed execution quantities/reference mismatch");
      const payload = JSON.stringify({ canonical: "confirmed_execution", sourceReference: candidate.sourceReference, purchase,
        validation, executionEnvelope: { format: 1, candidate, validation } satisfies PersistedPostgresExecutionEnvelope,
        acquiredEvidence: { providerId: candidate.providerId,
          ...("genesisHash" in candidate ? { genesisHash: candidate.genesisHash, slot: candidate.slot }
            : { chainId: candidate.chainId, genesisBlockHash: candidate.genesisBlockHash, blockNumber: candidate.blockNumber }),
          blockHash: candidate.blockHash, contentFingerprint: candidate.contentFingerprint,
          profile: candidate.profile, evidence: candidate.evidence } });
      assert(Buffer.byteLength(payload) <= options.maximumPayloadBytes, "Execution durable payload exceeds budget");
      const fingerprint = postgresServiceFactFingerprint(JSON.parse(payload));
      const subjectKey = postgresServiceFactFingerprint([purchase.chain, candidate.profile.wallet.address, candidate.sourceReference, purchase.tokenAddress]);
      const factId = postgresServiceFactFingerprint([target.generationId, "execution", subjectKey, fingerprint, claims.validatorId, claims.validationRef]);
      const fact = { fact_id: factId, generation_id: target.generationId, kind: "execution", subject_key: subjectKey,
        payload, fingerprint, source_ref: candidate.sourceReference, provider_id: candidate.providerId,
        observed_at: candidate.observedAt, known_at: claims.checkedAt };
      const attestation = { generation_id: target.generationId, fact_id: factId, validator_id: claims.validatorId, kind: "execution",
        fingerprint, validation_ref: claims.validationRef, checked_at: claims.checkedAt, expires_at: claims.expiresAt };
      const status = await options.run(async transaction => {
        await identity(transaction); input.signal.throwIfAborted();
        const validator = await transaction.query(`/* execution-publisher-validator */ SELECT v.*,l.revoked_at AS import_revoked_at FROM wallet_service_fact_validators v
          JOIN wallet_service_import_ledger l USING(generation_id,import_id)
          WHERE v.generation_id=$1 AND v.validator_id=$2 AND v.kind='execution'
            AND l.proof_scope='validator_authority' AND l.imported_at<=$3`,
        [target.generationId, claims.validatorId, claims.checkedAt]);
        const approved = validator.rows[0];
        assert(validator.rows.length === 1 && approved && Number(approved.valid_from) <= claims.checkedAt
          && Number(approved.valid_until) >= claims.expiresAt && approved.revoked_at === null && approved.import_revoked_at === null,
        "Current migration-approved validator binding required");
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`execution-fact:${factId}`]);
        const existing = await transaction.query(`/* execution-publisher-existing */ SELECT row_to_json(i) AS input,row_to_json(a) AS attestation
          FROM wallet_service_fact_inputs i LEFT JOIN wallet_service_fact_attestations a
          ON a.generation_id=i.generation_id AND a.fact_id=i.fact_id AND a.validator_id=$2
          WHERE i.fact_id=$1`, [factId, claims.validatorId]);
        if (existing.rows.length) {
          const row = existing.rows[0]!;
          const normalize = (value: unknown) => value && typeof value === "object" ? { ...value as Record<string, unknown>,
            ...Object.fromEntries(Object.entries(value).filter(([key]) => ["observed_at", "known_at", "checked_at", "expires_at"].includes(key))
              .map(([key, item]) => [key, Number(item)])) } : value;
          assert(canonical(normalize(row.input)) === canonical(fact) && canonical(normalize(row.attestation)) === canonical(attestation),
            "Execution fact/attestation identity collision"); input.signal.throwIfAborted(); return "duplicate" as const;
        }
        await transaction.query(`INSERT INTO wallet_service_fact_inputs(fact_id,generation_id,kind,subject_key,payload,fingerprint,source_ref,provider_id,observed_at,known_at)
          SELECT x.fact_id,x.generation_id,x.kind,x.subject_key,x.payload,x.fingerprint,x.source_ref,x.provider_id,x.observed_at,x.known_at
          FROM jsonb_to_record($1::jsonb) AS x(fact_id text,generation_id text,kind text,subject_key text,payload text,fingerprint text,
            source_ref text,provider_id text,observed_at bigint,known_at bigint)`, [JSON.stringify(fact)]);
        input.signal.throwIfAborted();
        // Protected authority stays SELECT-only; row-locking SELECT would require forbidden UPDATE grants.
        const written = await transaction.query(`INSERT INTO wallet_service_fact_attestations(generation_id,fact_id,validator_id,kind,fingerprint,validation_ref,checked_at,expires_at)
          SELECT x.generation_id,x.fact_id,x.validator_id,x.kind,x.fingerprint,x.validation_ref,x.checked_at,x.expires_at
          FROM jsonb_to_record($1::jsonb) AS x(generation_id text,fact_id text,validator_id text,kind text,fingerprint text,
            validation_ref text,checked_at bigint,expires_at bigint)
          JOIN wallet_service_fact_validators v ON v.generation_id=x.generation_id AND v.validator_id=x.validator_id AND v.kind=x.kind
          JOIN wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id
          WHERE l.proof_scope='validator_authority' AND l.imported_at<=x.checked_at AND l.revoked_at IS NULL
            AND v.revoked_at IS NULL AND v.valid_from<=x.checked_at AND v.valid_until>=x.expires_at RETURNING fact_id`, [JSON.stringify(attestation)]);
        assert(written.rowCount === 1 && written.rows.length === 1 && written.rows[0]?.fact_id === factId,
          "Execution authority changed before attestation");
        input.signal.throwIfAborted(); return "published" as const;
      });
      return { status, factId, purchase, externalBasis: { verifierId: claims.validatorId, evidenceRef: claims.validationRef,
        generationId: target.generationId, sourceReference: claims.sourceReference, executionKey: purchase.executionKey,
        purchaseFingerprint: claims.purchaseFingerprint, verifiedAt: claims.checkedAt } };
    },
  });
}
