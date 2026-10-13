import { assertReportedMarketApprovalInTransaction } from './postgres-reported-market-approval-ledger.js';
import { reportedMarketCapCandidateFingerprint, normalizeAveReportedMarketCap, type PostgresPriceCandidate, type PostgresReportedMarketCapReport } from './postgres-controlled-price-producer.js';
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { PostgresTransaction } from "@address-radar/database";
import { canonicalForwardPeak, type ForwardPeakEvidence } from "../../../packages/domain/src/forward-opportunity-evidence.js";
import { postgresServiceFactFingerprint } from "./postgres-service-fact-adapters.js";
import { requestPostgresWalletSignalWake } from "./postgres-production-composition.js";
import type { PostgresExecutionPublisherOptions } from "./postgres-execution-fact-publisher.js";
import type { PostgresGeckoTerminalPriceCandidate, PostgresPricePoolMapping } from "./postgres-controlled-price-producer.js";

export interface PostgresPriceSourceProof {
  readonly mapping: PostgresPricePoolMapping;
  readonly candleMs: number;
  readonly sourceRevision: string;
  readonly candles: PostgresGeckoTerminalPriceCandidate["candles"];
  /** Actual externally acquired response/evidence; this publisher does not synthesize it. */
  readonly rawEvidence: unknown;
  readonly reportedMarketCap?: PostgresReportedMarketCapReport;
}
export interface PostgresPriceValidationClaims {
  readonly format: 1; readonly generationId: string; readonly providerId: string;
  readonly validatorId: string; readonly keyId: string; readonly candidateFingerprint: string;
  readonly candidateKnownAt: number; readonly sampleId: string; readonly executionFingerprint: string;
  readonly mappingApprovalRef: string; readonly sourceApprovalRef: string; readonly sourceRevision: string;
  readonly validationRef: string; readonly checkedAt: number; readonly expiresAt: number;
  /** The proof protocol name is pinned by explicit approved configuration, not inferred. */
  readonly sourceBasis: { readonly kind: string; readonly providerId: string;
    readonly evidenceRef: string; readonly contentFingerprint: string };
}
export interface SignedPostgresPriceValidation {
  readonly claims: PostgresPriceValidationClaims; readonly signature: string; readonly sourceProof: PostgresPriceSourceProof;
}
export interface PostgresPricePublisherOptions extends PostgresExecutionPublisherOptions {
  readonly mappings: readonly { readonly mapping: PostgresPricePoolMapping; readonly providerId: string;
    readonly mappingApprovalRef: string; readonly sourceApprovalRef: string; readonly sourceProofKind: string;
    readonly candleMs: number; readonly validFrom: number; readonly validUntil: number; readonly quoteAddress?: string }[];
  readonly maximumCandles: number; readonly maximumWindowMs: number; readonly maximumMappingAgeMs: number;
}
export type PostgresPricePublication =
  | { readonly status: "published" | "duplicate"; readonly factIds: readonly string[] }
  | { readonly status: "deferred"; readonly reasonCode: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function priceValidationSigningPayload(claims: PostgresPriceValidationClaims): Buffer {
  return Buffer.from(`address-radar/price-validation/v1\n${canonical(claims)}`, "utf8");
}
/** Matches the existing producer's semantic hash, excluding moving acquisition clocks. */
export function priceCandidateFingerprint(candidate: PostgresPriceCandidate): string {
  if (candidate.kind === 'reported_market_cap') return reportedMarketCapCandidateFingerprint(candidate);
  const semantic = { generationId: candidate.generationId, sampleId: candidate.sampleId, executionFingerprint: candidate.executionFingerprint,
    providerId: candidate.providerId, boughtAt: candidate.boughtAt, until: candidate.until, mapping: candidate.mapping, candles: candidate.candles };
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function id(value: string): void {
  assert(typeof value === "string" && !!value.trim() && value.length <= 512 && !value.includes("://"), "Bounded proof identity required");
}
function clock(value: number): void { assert(Number.isSafeInteger(value) && value >= 0, "Invalid proof clock"); }
function positive(value: number, maximum = 2_147_483_647): void {
  assert(Number.isSafeInteger(value) && value > 0 && value <= maximum, "Explicit publication budget required");
}
const deferred = (reasonCode: string): PostgresPricePublication => ({ status: "deferred", reasonCode });

export async function createPostgresPriceFactPublisher(inputOptions: PostgresPricePublisherOptions) {
  // Snapshot approved pins so callers cannot mutate authority while a UOW is suspended.
  const options = { ...inputOptions, target: structuredClone(inputOptions.target), forbiddenRoles: [...inputOptions.forbiddenRoles],
    validators: structuredClone(inputOptions.validators), mappings: structuredClone(inputOptions.mappings) };
  const target = options.target;
  [target.database, target.username, target.generationId, target.serverAddress].forEach(id);
  assert(/^[a-z_][a-z0-9_]*$/.test(target.schema) && !["public", "pg_catalog", "information_schema"].includes(target.schema), "Pinned schema required");
  positive(target.serverPort, 65535); positive(target.schemaVersion);
  assert(/^[a-f0-9]{64}$/.test(target.schemaFingerprint), "Pinned schema fingerprint required");
  positive(options.maximumValidationAgeMs); positive(options.maximumPayloadBytes, 10_000_000);
  positive(options.maximumCandles, 1000); positive(options.maximumWindowMs, Number.MAX_SAFE_INTEGER); positive(options.maximumMappingAgeMs);
  positive(options.statementTimeoutMs); positive(options.lockTimeoutMs);
  assert(options.lockTimeoutMs <= options.statementTimeoutMs, "Invalid lock budget");
  assert(options.forbiddenRoles.length >= 7 && new Set(options.forbiddenRoles).size === options.forbiddenRoles.length
    && !options.forbiddenRoles.includes(target.username), "Complete consumer/migration role exclusion required");
  options.forbiddenRoles.forEach(id);
  const keys = new Map<string, { readonly configuration: PostgresPricePublisherOptions["validators"][number]; readonly key: KeyObject }>();
  for (const configuration of options.validators) {
    [configuration.validatorId, configuration.keyId, configuration.actorId, configuration.authorizationRef].forEach(id);
    assert(configuration.reviewedSourceProviders.length > 0, "Approved independent sources required");
    configuration.reviewedSourceProviders.forEach(id);
    const key = createPublicKey(configuration.publicKey);
    assert(key.asymmetricKeyType === "ed25519", "Approved Ed25519 key required");
    const index = canonical([configuration.validatorId, configuration.keyId]);
    assert(!keys.has(index), "Duplicate validator key"); keys.set(index, { configuration, key });
  }
  assert(keys.size > 0 && options.mappings.length > 0 && options.mappings.length <= 1000, "Explicit validator and source/mapping approval required");
  const mappingKeys = new Set<string>();
  for (const pin of options.mappings) {
    [pin.providerId, pin.mappingApprovalRef, pin.sourceApprovalRef, pin.sourceProofKind, pin.mapping.chain,
      pin.mapping.tokenAddress, pin.mapping.poolAddress, pin.mapping.network, pin.mapping.evidenceRef].forEach(id);
    assert(["solana", "eth", "bsc", "base"].includes(pin.mapping.chain)
      && ["base", "quote"].includes(pin.mapping.tokenSide), "Explicit supported pool mapping required");
if (pin.sourceProofKind === 'approved_reported_market_cap_v1') {
      assert(pin.candleMs === 0 && typeof pin.quoteAddress === 'string', 'Explicit reported source quote binding required');
      id(pin.quoteAddress);
    } else positive(pin.candleMs);
    clock(pin.validFrom); clock(pin.validUntil); clock(pin.mapping.knownAt);
    assert(pin.validUntil > pin.validFrom && pin.mapping.knownAt <= pin.validFrom, "Invalid mapping authority interval");
    const key = canonical([pin.providerId, pin.mapping]);
    assert(!mappingKeys.has(key), "Duplicate mapping approval"); mappingKeys.add(key);
  }
  async function identity(transaction: PostgresTransaction): Promise<void> {
    await transaction.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
      [String(options.statementTimeoutMs), String(options.lockTimeoutMs)]);
    const result = await transaction.query(`/* price-publisher-identity */
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
        (SELECT count(*)=10 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND c.relname IN ('business_schema_identity','business_schema_ledger',
            'wallet_service_fact_inputs','wallet_service_fact_attestations','wallet_service_fact_validators',
            'wallet_service_import_ledger','forward_purchase_samples','forward_trade_revisions','wallet_forward_signal_wake_intents','forward_strategy_generations')
          AND c.relkind='r' AND c.relpersistence='p') AS objects_safe,
        NOT EXISTS(SELECT 1 FROM unnest(ARRAY['business_schema_identity','business_schema_ledger','migration_cutover_transitions',
          'wallet_service_import_ledger','wallet_service_profile_cohort','wallet_service_profile_versions','wallet_service_fact_validators',
          'forward_purchase_samples','forward_trade_revisions','forward_strategy_generations','wallet_service_provider_budgets']) protected(name)
          WHERE has_table_privilege(current_user,format('%I.%I',$1,name),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(current_user,format('%I.%I',$1,name),'INSERT,UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['wallet_service_fact_inputs','wallet_service_fact_attestations','wallet_forward_signal_wake_intents']) proof(name)
          WHERE has_table_privilege(current_user,format('%I.%I',$1,name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(current_user,format('%I.%I',$1,name),'UPDATE,REFERENCES'))
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname=$1 AND c.relname IN ('wallet_service_fact_inputs','wallet_service_fact_attestations','wallet_forward_signal_wake_intents')
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
    async publish(input: { readonly candidate: PostgresPriceCandidate; readonly validation: SignedPostgresPriceValidation;
      readonly signal: AbortSignal }): Promise<PostgresPricePublication> {
      input.signal.throwIfAborted();
      assert(Buffer.byteLength(JSON.stringify(input.candidate)) + Buffer.byteLength(JSON.stringify(input.validation))
        <= options.maximumPayloadBytes, "Price proof payload exceeds budget");
      const candidate = structuredClone(input.candidate), validation = structuredClone(input.validation), claims = validation.claims;
      const reported = candidate.kind === 'reported_market_cap';
      const at = options.now(); clock(at);
      const mappingPin = options.mappings.find(pin => pin.providerId === candidate.providerId && canonical(pin.mapping) === canonical(candidate.mapping));
      if (!mappingPin || at < mappingPin.validFrom || at >= mappingPin.validUntil
        || at - candidate.mapping.knownAt > options.maximumMappingAgeMs
        || reported !== (mappingPin.sourceProofKind === 'approved_reported_market_cap_v1')) return deferred("approved_current_price_mapping_unavailable");
      [claims.generationId, claims.providerId, claims.validatorId, claims.keyId, claims.sampleId, claims.mappingApprovalRef,
        claims.sourceApprovalRef, claims.sourceRevision, claims.validationRef, claims.sourceBasis.kind, claims.sourceBasis.providerId,
        claims.sourceBasis.evidenceRef, candidate.sampleId, candidate.providerId].forEach(id);
      [claims.checkedAt, claims.expiresAt, claims.candidateKnownAt, candidate.knownAt, candidate.boughtAt, candidate.until].forEach(clock);
      const pin = keys.get(canonical([claims.validatorId, claims.keyId]));
      assert(pin && claims.format === 1 && candidate.generationId === target.generationId && claims.generationId === target.generationId
        && candidate.providerId === claims.providerId && claims.validatorId !== candidate.providerId
        && pin.configuration.actorId !== candidate.providerId && (reported || claims.sourceBasis.providerId !== candidate.providerId)
        && pin.configuration.reviewedSourceProviders.includes(claims.sourceBasis.providerId)
        && claims.sourceBasis.kind === mappingPin.sourceProofKind && claims.mappingApprovalRef === mappingPin.mappingApprovalRef
        && claims.sourceApprovalRef === mappingPin.sourceApprovalRef && claims.sampleId === candidate.sampleId
        && claims.executionFingerprint === candidate.executionFingerprint && /^[a-f0-9]{64}$/.test(candidate.executionFingerprint)
        && candidate.contentFingerprint === priceCandidateFingerprint(candidate) && claims.candidateFingerprint === candidate.contentFingerprint
        && claims.candidateKnownAt === candidate.knownAt && candidate.coverage === (reported ? "reported_snapshot_only" : "bounded_observations_only")
        && candidate.until > candidate.boughtAt && candidate.until <= candidate.knownAt && candidate.until - candidate.boughtAt <= options.maximumWindowMs
        && claims.checkedAt >= candidate.knownAt && claims.checkedAt <= at && claims.expiresAt > at
        && claims.expiresAt <= mappingPin.validUntil && at - claims.checkedAt <= options.maximumValidationAgeMs,
      "Independent price candidate/source/revision/clock validation required");
      const proof = validation.sourceProof;
      assert(proof && proof.rawEvidence !== null && proof.rawEvidence !== undefined
        && typeof proof.rawEvidence === "object" && Object.keys(proof.rawEvidence).length > 0
        && proof.sourceRevision === claims.sourceRevision && proof.candleMs === mappingPin.candleMs
        && canonical(proof.mapping) === canonical(candidate.mapping)
        && (reported ? canonical(proof.reportedMarketCap) === canonical(candidate.report) && proof.candles.length === 0
          : proof.reportedMarketCap === undefined && canonical(proof.candles) === canonical(candidate.candles))
        && /^[a-f0-9]{64}$/.test(claims.sourceBasis.contentFingerprint)
        && postgresServiceFactFingerprint(proof) === claims.sourceBasis.contentFingerprint,
      "Authenticated independent raw candle proof mismatch");
      const signature = Buffer.from(validation.signature, "base64");
      assert(signature.length === 64 && signature.toString("base64") === validation.signature
        && verify(null, priceValidationSigningPayload(claims), pin.key, signature), "External price signature invalid");
if (!reported) assert(candidate.candles.length > 0 && candidate.candles.length <= options.maximumCandles, "Bounded actual candles required");
      if (reported) {
        const raw = proof.rawEvidence as { approval?: Record<string, unknown>; response?: unknown; providerId?: unknown; protocol?: unknown };
        const approval = raw.approval;
        const report = candidate.report;
        assert(mappingPin.quoteAddress && report.quality === 'reported' && report.independence === 'unverified'
          && report.conflictState === 'unassessed' && report.sourceProtocol === 'ave_token_market_cap_v1'
          && report.quoteAddress === mappingPin.quoteAddress && candidate.sourceApprovalRef === mappingPin.sourceApprovalRef
          && claims.sourceBasis.providerId === candidate.providerId && proof.candleMs === 0
          && raw.providerId === candidate.providerId && raw.protocol === report.sourceProtocol
          && canonical(raw.response) === canonical(report.sourceEvidence), 'Authenticated reported source snapshot required');
        const normalized = normalizeAveReportedMarketCap(report.sourceEvidence, { chain: candidate.mapping.chain,
          token: candidate.mapping.tokenAddress, pool: candidate.mapping.poolAddress, quote: mappingPin.quoteAddress });
        assert(canonical(normalized) === canonical(report) && report.reportedAt >= candidate.boughtAt && report.reportedAt <= candidate.until,
          'Reported market normalization/time mismatch');
        assert(approval && approval.approvalRef === pin.configuration.authorizationRef && approval.generationId === target.generationId
          && approval.validatorId === claims.validatorId && approval.keyId === claims.keyId && approval.actorId === pin.configuration.actorId
          && approval.providerId === candidate.providerId && approval.sourceApprovalRef === mappingPin.sourceApprovalRef
          && approval.mappingApprovalRef === mappingPin.mappingApprovalRef && approval.sourceProofKind === mappingPin.sourceProofKind
          && approval.mappingFingerprint === postgresServiceFactFingerprint(candidate.mapping) && approval.quoteAddress === mappingPin.quoteAddress
          && approval.quality === 'reported' && approval.conflictState === 'none_observed' && approval.revokedAt === null,
          'Separate current reported-market source approval required');
        clock(approval.validFrom as number); clock(approval.validUntil as number);
        assert((approval.validFrom as number) <= claims.checkedAt && (approval.validUntil as number) >= claims.expiresAt
          && (approval.validUntil as number) > at, 'Reported market source approval expired');
      }
      let previousClosedAt = -1;
      let durableBytes = 0;
const facts = reported ? [(() => {
        const sourceEventId = postgresServiceFactFingerprint([target.generationId, candidate.providerId, candidate.mapping,
          candidate.sampleId, candidate.executionFingerprint, candidate.report]);
        const evidenceRef = postgresServiceFactFingerprint([candidate.providerId, claims.sourceRevision, sourceEventId]);
        // Validated envelope/source authority does not upgrade source-reported market quality.
        const market = { generationId: target.generationId, chain: candidate.mapping.chain, tokenAddress: candidate.mapping.tokenAddress,
          sourceEventId, marketCapUsd: candidate.report.marketCapUsd, fdvUsd: candidate.report.fdvUsd,
          occurredAt: candidate.report.reportedAt, now: claims.checkedAt, verification: 'validated', evidenceRef,
          quality: 'reported', independence: 'unverified', conflictState: 'none_observed',
          source: { providerId: candidate.providerId, approvalRef: candidate.sourceApprovalRef,
            protocol: candidate.report.sourceProtocol, reportedAt: candidate.report.reportedAt, quoteAddress: candidate.report.quoteAddress } };
        const payload = JSON.stringify({ type: 'market', market, generationId: target.generationId, sampleId: candidate.sampleId,
          executionFingerprint: candidate.executionFingerprint, validation, acquiredEvidence: candidate });
        const fingerprint = postgresServiceFactFingerprint(JSON.parse(payload));
        const factId = postgresServiceFactFingerprint([target.generationId, 'reported-market', sourceEventId, claims.validatorId]);
        const fact = { fact_id: factId, generation_id: target.generationId, kind: 'price', subject_key: candidate.sampleId,
          payload, fingerprint, source_ref: evidenceRef, provider_id: candidate.providerId,
          observed_at: candidate.report.reportedAt, known_at: claims.checkedAt };
        const attestation = { generation_id: target.generationId, fact_id: factId, validator_id: claims.validatorId, kind: 'price',
          fingerprint, validation_ref: claims.validationRef, checked_at: claims.checkedAt, expires_at: claims.expiresAt };
        durableBytes += Buffer.byteLength(JSON.stringify({ fact, attestation }));
        assert(durableBytes <= options.maximumPayloadBytes, 'Durable reported-market batch exceeds payload budget');
        return { fact, attestation };
      })()] : candidate.candles.map(candle => {
        clock(candle.timestamp); const closedAt = candle.timestamp + mappingPin.candleMs; clock(closedAt);
        assert(candle.timestamp >= candidate.boughtAt && candle.timestamp >= previousClosedAt && closedAt <= candidate.until
          && [candle.open, candle.high, candle.low, candle.close, candle.volumeUsd].every(Number.isFinite)
          && candle.low > 0 && candle.volumeUsd >= 0 && candle.high >= Math.max(candle.open, candle.close)
          && candle.low <= Math.min(candle.open, candle.close), "Canonical closed post-purchase candle required");
        previousClosedAt = closedAt;
        const peakId = postgresServiceFactFingerprint([target.generationId, candidate.providerId, candidate.mapping.chain,
          candidate.mapping.tokenAddress, candidate.mapping.poolAddress, candidate.mapping.tokenSide, candle.timestamp, closedAt]);
        const revisionId = postgresServiceFactFingerprint([candidate.contentFingerprint, candidate.sampleId, candidate.executionFingerprint,
          claims.mappingApprovalRef, claims.sourceApprovalRef, claims.sourceRevision, claims.sourceBasis.contentFingerprint]);
        const evidenceRef = postgresServiceFactFingerprint([claims.sourceBasis.providerId, claims.sourceRevision, peakId, revisionId]);
        const peak: ForwardPeakEvidence = canonicalForwardPeak({ peakId, revisionId, chain: candidate.mapping.chain,
          tokenAddress: candidate.mapping.tokenAddress, kind: "candle", openedAt: candle.timestamp, closedAt,
          priceUsd: String(candle.high), knownAt: claims.checkedAt, verification: "validated", evidenceRef });
        const payload = JSON.stringify({ type: "peak", peak, generationId: target.generationId, sampleId: candidate.sampleId,
          executionFingerprint: candidate.executionFingerprint, validation, acquiredEvidence: candidate });
        const fingerprint = postgresServiceFactFingerprint(JSON.parse(payload));
        // Moving acquisition/validation clocks do not mint another immutable source revision.
        const factId = postgresServiceFactFingerprint([target.generationId, "price", candidate.sampleId, candidate.executionFingerprint,
          peakId, revisionId, claims.validatorId]);
        const fact = { fact_id: factId, generation_id: target.generationId, kind: "price", subject_key: candidate.sampleId,
          payload, fingerprint, source_ref: evidenceRef, provider_id: candidate.providerId,
          observed_at: closedAt, known_at: claims.checkedAt };
        const attestation = { generation_id: target.generationId, fact_id: factId, validator_id: claims.validatorId, kind: "price",
          fingerprint, validation_ref: claims.validationRef, checked_at: claims.checkedAt, expires_at: claims.expiresAt };
        durableBytes += Buffer.byteLength(JSON.stringify({fact,attestation}));
        assert(durableBytes <= options.maximumPayloadBytes, "Durable price batch exceeds payload budget");
        return { fact, attestation };
      });
      const assertReportedApproval = async (transaction: PostgresTransaction) => {
        if (!reported) return;
        const raw = validation.sourceProof.rawEvidence as { approval: unknown };
        await assertReportedMarketApprovalInTransaction(transaction, { approval: raw.approval, now: options.now,
          binding: { generationId: target.generationId, providerId: candidate.providerId, validatorId: claims.validatorId,
            keyId: claims.keyId, sourceApprovalRef: claims.sourceApprovalRef, mappingApprovalRef: claims.mappingApprovalRef,
            mapping: candidate.mapping, quoteAddress: mappingPin.quoteAddress! } });
      };
      return options.run(async transaction => {
        await identity(transaction); input.signal.throwIfAborted();
        await assertReportedApproval(transaction);
        const sample = await transaction.query(`/* price-publisher-sample */ SELECT s.*,g.activated_at,r.state AS revision_state
          FROM forward_purchase_samples s JOIN forward_trade_revisions r
            ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
          JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
          WHERE s.sample_id=$1 AND s.generation_id=$2`, [candidate.sampleId, target.generationId]);
        const row = sample.rows[0];
        if (sample.rows.length !== 1 || !row || row.execution_fingerprint !== candidate.executionFingerprint
          || row.chain !== candidate.mapping.chain || row.token_address !== candidate.mapping.tokenAddress
          || ![row.occurred_at,row.activated_at,row.expires_at].every(value => Number.isSafeInteger(Number(value)) && value !== null)
          || Number(row.occurred_at) !== candidate.boughtAt || row.revision_state !== "original"
          || Number(row.activated_at) > candidate.boughtAt || candidate.until > Number(row.expires_at)) {
          return deferred("current_price_sample_revision_unavailable");
        }
        const authority = await transaction.query(`/* price-publisher-validator */ SELECT v.*,l.revoked_at AS import_revoked_at
          FROM wallet_service_fact_validators v JOIN wallet_service_import_ledger l USING(generation_id,import_id)
          WHERE v.generation_id=$1 AND v.validator_id=$2 AND v.kind='price'
            AND l.proof_scope='validator_authority' AND l.imported_at<=$3`,
        [target.generationId, claims.validatorId, claims.checkedAt]);
        const approved = authority.rows[0];
        if (authority.rows.length !== 1 || !approved || approved.revoked_at !== null || approved.import_revoked_at !== null
          || ![approved.valid_from,approved.valid_until].every(value => Number.isSafeInteger(Number(value)) && value !== null)
          || Number(approved.valid_from) > claims.checkedAt || Number(approved.valid_until) < claims.expiresAt) {
          return deferred("approved_current_price_validator_unavailable");
        }
        let inserted = 0;
        for (const { fact, attestation } of facts) {
          input.signal.throwIfAborted();
          const current = options.now(); clock(current);
          assert(current >= at && current < claims.expiresAt && current < mappingPin.validUntil, "Price proof expired during publication");
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`price-fact:${fact.fact_id}`]);
          const existing = await transaction.query(`/* price-publisher-existing */ SELECT row_to_json(i) AS input,row_to_json(a) AS attestation
            FROM wallet_service_fact_inputs i LEFT JOIN wallet_service_fact_attestations a
              ON a.generation_id=i.generation_id AND a.fact_id=i.fact_id AND a.validator_id=$2
            WHERE i.fact_id=$1`, [fact.fact_id, claims.validatorId]);
          if (existing.rows.length) {
            const normalize = (value: unknown) => value && typeof value === "object" ? { ...value as Record<string, unknown>,
              ...Object.fromEntries(Object.entries(value).filter(([key]) => ["observed_at", "known_at", "checked_at", "expires_at"].includes(key))
                .map(([key, item]) => [key, Number(item)])) } : value;
            assert(existing.rows.length === 1 && canonical(normalize(existing.rows[0]!.input)) === canonical(fact)
              && canonical(normalize(existing.rows[0]!.attestation)) === canonical(attestation), "Immutable price fact/attestation collision");
            continue;
          }
          await assertReportedApproval(transaction);
          await transaction.query(`INSERT INTO wallet_service_fact_inputs(fact_id,generation_id,kind,subject_key,payload,fingerprint,source_ref,provider_id,observed_at,known_at)
            SELECT x.fact_id,x.generation_id,x.kind,x.subject_key,x.payload,x.fingerprint,x.source_ref,x.provider_id,x.observed_at,x.known_at
            FROM jsonb_to_record($1::jsonb) AS x(fact_id text,generation_id text,kind text,subject_key text,payload text,fingerprint text,
              source_ref text,provider_id text,observed_at bigint,known_at bigint)`, [JSON.stringify(fact)]);
          // Recheck the current revision and authority in the actual INSERT, without authority UPDATE privilege.
          const written = await transaction.query(`INSERT INTO wallet_service_fact_attestations(generation_id,fact_id,validator_id,kind,fingerprint,validation_ref,checked_at,expires_at)
            SELECT x.generation_id,x.fact_id,x.validator_id,x.kind,x.fingerprint,x.validation_ref,x.checked_at,x.expires_at
            FROM jsonb_to_record($1::jsonb) AS x(generation_id text,fact_id text,validator_id text,kind text,fingerprint text,
              validation_ref text,checked_at bigint,expires_at bigint)
            JOIN wallet_service_fact_validators v ON v.generation_id=x.generation_id AND v.validator_id=x.validator_id AND v.kind=x.kind
            JOIN wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id
            JOIN forward_purchase_samples s ON s.generation_id=x.generation_id AND s.sample_id=$2 AND s.execution_fingerprint=$3
            JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
            JOIN forward_strategy_generations g ON g.generation_id=s.generation_id
            WHERE l.proof_scope='validator_authority' AND l.imported_at<=x.checked_at AND l.revoked_at IS NULL
              AND v.revoked_at IS NULL AND v.valid_from<=x.checked_at AND v.valid_until>=x.expires_at
              AND r.state='original' AND s.chain=$4 AND s.token_address=$5 AND s.occurred_at=$6
              AND g.activated_at<=$6 AND s.expires_at>=$7 RETURNING fact_id`,
          [JSON.stringify(attestation),candidate.sampleId,candidate.executionFingerprint,candidate.mapping.chain,candidate.mapping.tokenAddress,candidate.boughtAt,candidate.until]);
          assert(written.rowCount === 1 && written.rows.length === 1 && written.rows[0]?.fact_id === fact.fact_id,
            "Price authority/sample changed before attestation");
          await requestPostgresWalletSignalWake(transaction, { generationId: target.generationId,
            chain: candidate.mapping.chain, tokenAddress: candidate.mapping.tokenAddress, sourceKey: `price:${fact.fact_id}`, now: claims.checkedAt });
          inserted++;
        }
        input.signal.throwIfAborted();
        await assertReportedApproval(transaction);
        const committedAt = options.now(); clock(committedAt);
        assert(committedAt >= at && committedAt < claims.expiresAt && committedAt < mappingPin.validUntil, "Price proof expired before commit");
        return { status: inserted ? "published" : "duplicate", factIds: facts.map(value => value.fact.fact_id) };
      });
    },
  });
}
