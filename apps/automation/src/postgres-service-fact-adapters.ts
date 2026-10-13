import { assertReportedMarketApprovalInTransaction } from './postgres-reported-market-approval-ledger.js';
import type { PostgresPricePoolMapping } from './postgres-controlled-price-producer.js';
import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { POSTGRES_EXECUTION_RPC_METHODS, type PostgresRpcDiagnosticContext, type PostgresExecutionRpcDiagnostic } from "./postgres-wallet-rpc-producer.js";
import { classifyJsonRpcLimit } from "../../../packages/collectors/src/json-rpc-client.js";
import type { FetchLike } from "../../../packages/collectors/src/types.js";
import { canonicalForwardPeak, canonicalForwardTargetChannelFact, forwardTargetSubjectKey,
  type ForwardPeakEvidence } from "@address-radar/domain";
import type { PostgresBusinessRuntime } from "../../../packages/database/src/postgres-business-driver.js";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { preparePostgresWalletCapture, selectPostgresWalletProfiles, walletPurchaseBasisFingerprint,
  type PostgresWalletChannelOptions, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { receivePostgresProductionPriceBatch, type PostgresProductionFactAdapters,
  type PostgresProductionPriceLease, type PostgresCompositionContext } from "./postgres-production-composition.js";

/** Migration-owned provenance/cohort/budget seeds. Runtime factories never execute this DDL. */
export const POSTGRES_SERVICE_FACT_SCHEMA_SQL = `
CREATE TABLE wallet_service_import_ledger (
  import_id text PRIMARY KEY,generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  approval_ref text NOT NULL,source_fingerprint text NOT NULL,proof_scope text NOT NULL,
  imported_at bigint NOT NULL,revoked_at bigint,UNIQUE(generation_id,import_id)
);
CREATE TABLE wallet_service_profile_cohort (
  generation_id text NOT NULL,subject_key text NOT NULL,entity_id text NOT NULL,wallet_family text NOT NULL CHECK(wallet_family IN ('evm','solana')),
  profile_payload text NOT NULL,import_id text NOT NULL,observed_at bigint NOT NULL,
  PRIMARY KEY(generation_id,subject_key),
  FOREIGN KEY(generation_id,import_id) REFERENCES wallet_service_import_ledger(generation_id,import_id)
);
CREATE TABLE wallet_service_profile_versions (
  generation_id text NOT NULL,subject_key text NOT NULL,version_id text NOT NULL,
  enabled boolean NOT NULL,suspended boolean NOT NULL,effective_at bigint NOT NULL,known_at bigint NOT NULL,
  import_id text NOT NULL,PRIMARY KEY(generation_id,subject_key,version_id),CHECK(known_at>=effective_at),
  FOREIGN KEY(generation_id,subject_key) REFERENCES wallet_service_profile_cohort(generation_id,subject_key),
  FOREIGN KEY(generation_id,import_id) REFERENCES wallet_service_import_ledger(generation_id,import_id)
);
CREATE INDEX wallet_service_profile_current ON wallet_service_profile_versions(generation_id,subject_key,effective_at DESC,known_at DESC,version_id);
CREATE TABLE wallet_service_fact_validators (
  generation_id text NOT NULL,validator_id text NOT NULL,kind text NOT NULL,import_id text NOT NULL,
  valid_from bigint NOT NULL,valid_until bigint NOT NULL,revoked_at bigint,
  PRIMARY KEY(generation_id,validator_id,kind),CHECK(valid_until>valid_from),
  FOREIGN KEY(generation_id,import_id) REFERENCES wallet_service_import_ledger(generation_id,import_id)
);
CREATE TABLE wallet_service_fact_inputs (
  fact_id text PRIMARY KEY,generation_id text NOT NULL REFERENCES forward_strategy_generations(generation_id),
  kind text NOT NULL CHECK(kind IN ('execution','price','source','risk','independence')),
  subject_key text NOT NULL,payload text NOT NULL,fingerprint text NOT NULL,source_ref text NOT NULL,
  provider_id text NOT NULL,observed_at bigint NOT NULL,known_at bigint NOT NULL,CHECK(known_at>=observed_at),
  UNIQUE(generation_id,fact_id)
);
CREATE INDEX wallet_service_fact_subject ON wallet_service_fact_inputs(generation_id,kind,subject_key,known_at,fact_id);
CREATE TABLE wallet_service_fact_attestations (
  generation_id text NOT NULL,fact_id text NOT NULL,validator_id text NOT NULL,kind text NOT NULL,
  fingerprint text NOT NULL,validation_ref text NOT NULL,checked_at bigint NOT NULL,expires_at bigint NOT NULL,
  PRIMARY KEY(generation_id,fact_id,validator_id),CHECK(expires_at>checked_at),
  FOREIGN KEY(generation_id,fact_id) REFERENCES wallet_service_fact_inputs(generation_id,fact_id),
  FOREIGN KEY(generation_id,validator_id,kind) REFERENCES wallet_service_fact_validators(generation_id,validator_id,kind)
);
CREATE TABLE wallet_service_price_leases (
  generation_id text PRIMARY KEY REFERENCES forward_strategy_generations(generation_id),claim_generation integer NOT NULL DEFAULT 0,
  lease_owner text,lease_expires_at bigint
);
CREATE TABLE wallet_service_price_consumption (
  generation_id text NOT NULL,fact_id text NOT NULL,consumed_at bigint NOT NULL,PRIMARY KEY(generation_id,fact_id),
  FOREIGN KEY(generation_id,fact_id) REFERENCES wallet_service_fact_inputs(generation_id,fact_id)
);
CREATE TABLE wallet_service_provider_budgets (
  generation_id text NOT NULL,provider_id text NOT NULL,origin text NOT NULL,import_id text NOT NULL,
  window_started_at bigint NOT NULL,window_ms integer NOT NULL CHECK(window_ms>0),
  maximum_requests integer NOT NULL CHECK(maximum_requests>0),requests_used integer NOT NULL CHECK(requests_used>=0),
  cooldown_until bigint NOT NULL CHECK(cooldown_until>=0),
  maximum_concurrency integer NOT NULL CHECK(maximum_concurrency>0),PRIMARY KEY(generation_id,provider_id),UNIQUE(generation_id,origin),
  FOREIGN KEY(generation_id,import_id) REFERENCES wallet_service_import_ledger(generation_id,import_id)
);
CREATE TABLE wallet_service_provider_leases (
  lease_id text PRIMARY KEY,generation_id text NOT NULL,provider_id text NOT NULL,owner_id text NOT NULL,
  expires_at bigint NOT NULL,released_at bigint,
  FOREIGN KEY(generation_id,provider_id) REFERENCES wallet_service_provider_budgets(generation_id,provider_id)
);
CREATE INDEX wallet_service_provider_inflight ON wallet_service_provider_leases(generation_id,provider_id,expires_at) WHERE released_at IS NULL;
CREATE TABLE wallet_service_source_requests (
  generation_id text NOT NULL,provider_id text NOT NULL,request_key text NOT NULL,kind text NOT NULL,
  subject_key text NOT NULL,requested_at bigint NOT NULL,status text NOT NULL CHECK(status IN ('pending','claimed','completed','deferred')),
  PRIMARY KEY(generation_id,provider_id,request_key),
  FOREIGN KEY(generation_id,provider_id) REFERENCES wallet_service_provider_budgets(generation_id,provider_id)
);
`;

export interface PostgresServiceFactPorts {
  readonly profiles: PostgresWalletChannelOptions["profiles"];
  readonly facts: PostgresProductionFactAdapters;
  readonly fetch: FetchLike;
  /** Bind already validated native replay configuration without changing acquisition. */
  readonly withRpcDiagnosticContexts?: (contexts: readonly PostgresRpcDiagnosticContext[]) => FetchLike;
  targetedBackfillPoll(input: { readonly signal: AbortSignal; readonly limit: number }): Promise<unknown>;
  /** Demand only: a separately authorized producer must acquire and independently validate actual facts. */
  enqueueSourceRequest(input: { readonly providerId: string; readonly kind: string; readonly subjectKey: string; readonly signal: AbortSignal }): Promise<void>;
}
export interface PostgresServiceFactAdapterOptions {
  /** Legacy Solana-origin observer remains supported. Native bindings take precedence. */
  readonly sourceRpcContexts?: readonly PostgresRpcDiagnosticContext[];
  readonly sourceRpcOrigin?: string;
  readonly onSourceRpcDiagnostic?: (diagnostic: PostgresExecutionRpcDiagnostic) => void;
  readonly runtime: PostgresBusinessRuntime; readonly generationId: string; readonly maximumProfiles: number;
  readonly now: () => number; readonly sources: Readonly<Record<string, unknown>>;
}
import { acquirePacedProvider, pacedEvmRequest, providerPacingUntil } from "./postgres-provider-pacing.js";

export const POSTGRES_PROVIDER_BUDGET_REASONS = Object.freeze(["contract_unavailable", "invalid_cooldown", "paused", "cooldown", "clock_regressed", "concurrency", "window", "debit_unavailable"] as const);
export class PostgresProviderBudgetError extends Error {
  constructor(readonly retryAt: number | null, readonly budgetReason?: typeof POSTGRES_PROVIDER_BUDGET_REASONS[number]) { super("Durable provider budget unavailable"); this.name = "PostgresProviderBudgetError"; }
}
/** Explicit review pause, not an inferred duration. Only reviewed migration/operations may clear it. */
export const POSTGRES_PROVIDER_COOLDOWN_PAUSED = "9223372036854775807";
/** Operational transport policy only; never changes request allocations or business eligibility. */
export const POSTGRES_PROVIDER_RETRY_AFTER_POLICY = Object.freeze({ fallbackMs: 60_000, maximumMs: 86_400_000 });
export const postgresServiceFactFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Row = Record<string, unknown>;
const object = (value: unknown): Row => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid factual payload"); return value as Row; };
const clock = (value: unknown): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0 || value === null) throw new Error("Invalid factual clock"); return result; };
const identifier = (value: unknown): string => { if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("Invalid factual identifier"); return value; };
const deferred = (reasonCode: string) => ({ status: "deferred" as const, reasonCode });

function retryAfterCooldown(header: string | null, receivedAt: number): string {
  const until = (delay: bigint): string => {
    const { fallbackMs, maximumMs } = POSTGRES_PROVIDER_RETRY_AFTER_POLICY;
    const bounded = delay <= 0n ? BigInt(fallbackMs) : delay > BigInt(maximumMs) ? BigInt(maximumMs) : delay;
    const result = BigInt(receivedAt) + bounded;
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Provider retry clock exceeds budget");
    return result.toString();
  };
  const fallback = () => until(0n);
  if (header === null || header.length > 256) return fallback();
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    return until(BigInt(value) * 1000n);
  }
  const weekdays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const fullDays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const imf = /^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const old = /^([A-Za-z]+), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asc = /^([A-Za-z]{3}) ([A-Za-z]{3}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  const parts = imf?.slice(1) ?? old?.slice(1) ?? (asc ? [asc[1]!,asc[3]!,asc[2]!,asc[7]!,asc[4]!,asc[5]!,asc[6]!] : null);
  if (!parts) return fallback();
  const weekday = old ? fullDays.indexOf(parts[0]!) : weekdays.indexOf(parts[0]!);
  const day = Number(parts[1]), month = months.indexOf(parts[2]!), hour = Number(parts[4]), minute = Number(parts[5]), second = Number(parts[6]);
  let year = Number(parts[3]);
  if (old) {
    const currentYear = new Date(receivedAt).getUTCFullYear();
    year += Math.floor(currentYear / 100) * 100;
    if (year > currentYear + 50) year -= 100;
  }
  const date = new Date(0); date.setUTCFullYear(year,month,day); date.setUTCHours(hour,minute,second,0);
  if (weekday < 0 || month < 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCDay() !== weekday || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return fallback();
  return until(BigInt(date.getTime()) - BigInt(receivedAt));
}

export async function createPostgresServiceFactAdapters(options: PostgresServiceFactAdapterOptions): Promise<PostgresServiceFactPorts> {
  const { runtime, generationId, maximumProfiles } = options;
  identifier(generationId);
  const budget = (key: string, max = 2_147_483_647) => {
    const value = options.sources[key]; if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Explicit ${key} budget required`); return value;
  };
  if (!Number.isSafeInteger(maximumProfiles) || maximumProfiles < 1 || maximumProfiles > 10_000) throw new Error("Explicit profile budget required");
  const leaseMs = budget("leaseMs"), profileAge = budget("maximumProfileAgeMs"), factAge = budget("maximumFactAgeMs"),
    safetyAge = budget("maximumSafetyAgeMs"), timeout = budget("providerTimeoutMs"), responseBytes = budget("maximumResponseBytes"),
    payloadBytes = budget("maximumFactPayloadBytes");
  // Explicit root binding to the already approved execution publisher ceiling.
  // Other fact kinds retain their original per-fact allowance.
  const executionPayloadBytes = options.sources.maximumExecutionFactPayloadBytes === undefined ? payloadBytes
    : budget("maximumExecutionFactPayloadBytes", 2_097_152);
  const factResultBytes = options.sources.maximumFactResultBytes === undefined ? null
    : budget("maximumFactResultBytes", 2_097_152);
  const identity = await runtime.probe();
  if (identity.generation !== generationId) throw new Error("Fact adapter runtime generation mismatch");
  const ownerId = `${identifier(identity.service)}:${randomUUID()}`;
  const now = () => clock(options.now());
  now();
  const baseFetch = (options.sources.fetchImpl ?? globalThis.fetch) as FetchLike;
  if (typeof baseFetch !== "function") throw new Error("Explicit RPC fetch implementation required");
  const context = (ctx: PostgresCompositionContext) => {
    ctx.signal.throwIfAborted(); if (ctx.generationId !== generationId || !Number.isSafeInteger(ctx.limit) || ctx.limit < 1 || ctx.limit > 1000) throw new Error("Factual generation or budget mismatch");
    clock(ctx.asOf); if (ctx.asOf > now()) throw new Error("Future factual assessment");
  };
  const parse = (payload: unknown, maximumBytes = payloadBytes) => {
    if (typeof payload !== "string" || Buffer.byteLength(payload) > maximumBytes) throw new Error("Factual payload budget exceeded");
    return object(JSON.parse(payload));
  };
  async function profilesAt(asOf: number, family: string | null, subject: string | null, limit: number) {
    const rows = await runtime.run(tx => tx.query(`/* service-fact-profile-cohort */ SELECT c.*,l.proof_scope,l.imported_at,l.revoked_at import_revoked_at,
      p.enabled,p.suspended,p.known_at profile_known_at,p.version_id profile_version_id,
      v.payload channel_payload,v.version_id channel_version_id,v.known_at channel_known_at,
      b.owner_entity_id,b.conflict_at
      FROM wallet_service_profile_cohort c JOIN wallet_service_import_ledger l ON l.generation_id=c.generation_id AND l.import_id=c.import_id
      LEFT JOIN LATERAL (SELECT p.* FROM wallet_service_profile_versions p JOIN wallet_service_import_ledger i ON i.import_id=p.import_id
        WHERE p.generation_id=c.generation_id AND p.subject_key=c.subject_key AND p.effective_at<=$2 AND p.known_at<=$2
          AND (i.revoked_at IS NULL OR i.revoked_at>$2) ORDER BY p.effective_at DESC,p.known_at DESC,p.version_id DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT v.* FROM forward_target_channel_versions v WHERE v.entity_id=c.entity_id AND v.channel='wallet'
        AND v.subject_key=c.subject_key AND v.effective_at<=$2 AND v.known_at<=$2
        ORDER BY v.effective_at DESC,v.known_at DESC,v.version_id DESC LIMIT 1) v ON true
      LEFT JOIN forward_target_identity_bindings b ON b.channel='wallet' AND b.subject_key=c.subject_key AND b.created_at<=$2
      WHERE c.generation_id=$1 AND ($3::text IS NULL OR c.wallet_family=$3) AND ($4::text IS NULL OR c.subject_key=$4)
      ORDER BY c.subject_key LIMIT $5`, [generationId, asOf, family, subject, limit + 1]));
    if (!rows.rows.length || rows.rows.length > limit) return null;
    try { return rows.rows.map(row => {
      if (!["legacy_registry_linkage", "address_only_registry"].includes(String(row.proof_scope)) || (row.import_revoked_at !== null && clock(row.import_revoked_at) <= asOf)
        || clock(row.imported_at) > asOf || clock(row.observed_at) > asOf || asOf - clock(row.observed_at) > profileAge
        || typeof row.enabled !== "boolean" || typeof row.suspended !== "boolean") throw new Error("Current approved profile proof unavailable");
      const payload = parse(row.profile_payload);
      const imported = payload as unknown as PostgresWalletProfile;
      if (row.proof_scope === "address_only_registry" && (payload.provenanceScope !== "address_only_registry"
        || !["realtime", "periodic", "lightweight", "off"].includes(String(imported.monitoringPolicy)))) {
        throw new Error("Address-only monitoring policy unavailable");
      }
      const fact = canonicalForwardTargetChannelFact(parse(row.channel_payload) as unknown as PostgresWalletProfile["fact"]);
      if (fact.channel !== "wallet" || fact.entityId !== row.entity_id || imported.wallet.entityId !== fact.entityId
        || fact.walletFamily !== row.wallet_family || forwardTargetSubjectKey(fact) !== row.subject_key
        || clock(row.profile_known_at) > asOf || clock(row.channel_known_at) > asOf) throw new Error("Current owner mismatch");
      const bound = row.owner_entity_id === fact.entityId && (row.conflict_at === null || clock(row.conflict_at) > asOf);
      const profile: PostgresWalletProfile = { wallet: imported.wallet, fact, profileEnabled: row.enabled,
        profileSuspended: row.suspended, bindingState: bound ? "owned" : "conflict", versionId: identifier(row.channel_version_id),
        ...(imported.monitoringPolicy === undefined ? {} : { monitoringPolicy: imported.monitoringPolicy }) };
      return { profile, observedAt: clock(row.observed_at), fingerprint: postgresServiceFactFingerprint([row.import_id,row.profile_version_id,profile]) };
    }); } catch { return null; }
  }
  async function assertReportedPriceApproval(tx: PostgresTransaction, value: Row, at: number) {
    const market = value.type === 'market' ? object(value.market) : {};
    const validation = value.validation ? object(value.validation) : {};
    const claims = validation.claims ? object(validation.claims) : {};
    const basis = claims.sourceBasis ? object(claims.sourceBasis) : {};
    if (!('quality' in market) && basis.kind !== 'approved_reported_market_cap_v1') return;
    const proof = object(validation.sourceProof), raw = object(proof.rawEvidence), source = object(market.source);
    await assertReportedMarketApprovalInTransaction(tx, { approval: raw.approval, now: () => Math.max(now(),at),
      binding: { generationId, providerId: identifier(claims.providerId), validatorId: identifier(claims.validatorId),
        keyId: identifier(claims.keyId), sourceApprovalRef: identifier(claims.sourceApprovalRef),
        mappingApprovalRef: identifier(claims.mappingApprovalRef), mapping: proof.mapping as PostgresPricePoolMapping,
        quoteAddress: identifier(source.quoteAddress) } });
  }
  async function readFacts(ctx: PostgresCompositionContext, kind: string, subject: string | null, limit: number,
    onBudgetExceeded?: (reason: string) => void): Promise<Row[] | null> {
    context(ctx);
    const perFactBytes = kind === "execution" ? executionPayloadBytes : payloadBytes;
    const resultBytes = factResultBytes ?? perFactBytes * (limit + 1);
    const result = await runtime.run(async tx => {
      const result = await tx.query(`/* service-fact-inputs */ WITH bounded_facts AS MATERIALIZED (
      SELECT DISTINCT ON(f.fact_id) f.*,a.validator_id,
      a.validation_ref,a.checked_at,a.expires_at,v.valid_from validator_from,v.valid_until validator_until,
      v.revoked_at,l.revoked_at import_revoked_at
      FROM wallet_service_fact_inputs f JOIN wallet_service_fact_attestations a ON a.generation_id=f.generation_id
        AND a.fact_id=f.fact_id AND a.kind=f.kind AND a.fingerprint=f.fingerprint
      JOIN wallet_service_fact_validators v ON v.generation_id=a.generation_id AND v.validator_id=a.validator_id AND v.kind=a.kind
      JOIN wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id
      WHERE f.generation_id=$1 AND f.kind=$2 AND ($3::text IS NULL OR f.subject_key=$3) AND f.known_at<=$4
        AND a.checked_at<=$4 AND a.expires_at>$4 AND v.valid_from<=a.checked_at AND v.valid_until>$4
        AND (v.revoked_at IS NULL OR v.revoked_at>$4) AND (l.revoked_at IS NULL OR l.revoked_at>$4)
        AND l.proof_scope='validator_authority' AND l.imported_at<=a.checked_at AND v.validator_id<>f.provider_id
        AND ($2<>'price' OR NOT EXISTS(SELECT 1 FROM wallet_service_price_consumption c WHERE c.generation_id=f.generation_id AND c.fact_id=f.fact_id))
      ORDER BY f.fact_id,a.checked_at DESC,a.validator_id LIMIT $5
      ), sized_facts AS (
        SELECT b.*,octet_length(b.payload) payload_bytes,
          sum(octet_length(row_to_json(b)::text)+256) OVER () + 2 result_bytes
        FROM bounded_facts b
      ) SELECT fact_id,generation_id,kind,subject_key,fingerprint,source_ref,provider_id,observed_at,known_at,
        validator_id,validation_ref,checked_at,expires_at,validator_from,validator_until,revoked_at,import_revoked_at,
        payload_bytes,result_bytes,
        CASE WHEN payload_bytes<=$6 AND result_bytes<=$7 THEN payload ELSE NULL END payload
      FROM sized_facts ORDER BY fact_id`, [generationId,kind,subject,ctx.asOf,limit + 1,perFactBytes,resultBytes]);
      // Dedicated approval is checked while these durable facts are read, not in a later UOW.
      if (kind === 'price') for (const row of result.rows.slice(0,limit)) {
        if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > perFactBytes) continue;
        await assertReportedPriceApproval(tx, parse(row.payload,perFactBytes), Math.max(now(),ctx.asOf));
      }
      return result;
    });
    if (result.rows.some(row => (row.payload_bytes === undefined
      ? typeof row.payload === "string" ? Buffer.byteLength(row.payload) : Infinity : Number(row.payload_bytes)) > perFactBytes)) {
      onBudgetExceeded?.("wallet_execution_fact_payload_budget_exceeded"); return null;
    }
    // Count escaped payload strings and row metadata, not only raw envelope bytes.
    // SQL reserves bounded overhead for its two added counters and the page array.
    const returnedBytes = Buffer.byteLength(JSON.stringify(result.rows));
    if (result.rows.length > limit + 1 || returnedBytes > resultBytes
      || result.rows.some(row => row.result_bytes !== undefined && Number(row.result_bytes) > resultBytes)) {
      onBudgetExceeded?.("wallet_execution_fact_result_budget_exceeded"); return null;
    }
    if (!result.rows.length || (kind !== "price" && result.rows.length > limit)) return null;
    try { return result.rows.slice(0,limit).map(row => {
      const value = parse(row.payload,perFactBytes), at = ctx.asOf, maxAge = ["source","risk","independence"].includes(kind) ? safetyAge : factAge;
      if (row.generation_id !== generationId || row.kind !== kind || (subject !== null && row.subject_key !== subject)
        || row.fingerprint !== postgresServiceFactFingerprint(value) || row.provider_id === row.validator_id
        || clock(row.observed_at) > clock(row.known_at) || clock(row.known_at) > clock(row.checked_at) || clock(row.checked_at) > at
        || at - clock(row.known_at) > maxAge || clock(row.expires_at) <= at || clock(row.validator_from) > clock(row.checked_at)
        || clock(row.validator_until) <= at || (row.revoked_at !== null && clock(row.revoked_at) <= at)
        || (row.import_revoked_at !== null && clock(row.import_revoked_at) <= at)) throw new Error("Independent factual validation unavailable");
      identifier(row.fact_id); identifier(row.source_ref); identifier(row.validation_ref); identifier(row.validator_id);
      return { ...row, value };
    }); } catch { return null; }
  }
  const profiles: PostgresWalletChannelOptions["profiles"] = { async load(input) {
    input.signal.throwIfAborted(); if (input.generationId !== generationId || input.limit > maximumProfiles || input.limit < 1) return deferred("profile_cohort_budget_or_generation");
    const rows = await profilesAt(clock(input.asOf), input.chainFamily, null, input.limit);
    if (!rows) return deferred("approved_current_profile_cohort_unavailable");
    return { status: "ready", profiles: rows.map(row => row.profile) };
  } };
  const facts: PostgresProductionFactAdapters = {
    async purchase(ctx) {
      context(ctx); const payload = ctx.payload;
      if (payload.generationId !== generationId || !payload.profile) return deferred("wallet_execution_or_owner_unavailable");
      const subject = forwardTargetSubjectKey(payload.profile.fact);
      const current = await profilesAt(ctx.asOf,payload.chainFamily,subject,1);
      const profile = current?.[0]?.profile;
      if (!profile || !selectPostgresWalletProfiles([profile],payload.chainFamily).length
        || profile.wallet.accountId !== payload.profile.wallet.accountId || profile.wallet.entityId !== payload.profile.wallet.entityId
        || profile.fact.ownershipEvidenceRef !== payload.profile.fact.ownershipEvidenceRef) return deferred("wallet_current_owner_unavailable");
      const key = postgresServiceFactFingerprint([payload.event.chain,payload.event.walletAddress,payload.event.sourceReference,payload.event.tokenAddress]);
      let budgetReason: string | undefined;
      const proof = (await readFacts(ctx,"execution",key,1,reason => { budgetReason = reason; }))?.[0];
      if (!proof) return deferred(budgetReason ?? "wallet_canonical_execution_proof_unavailable");
      try {
        const purchase = object(proof.value).purchase as NonNullable<typeof payload.purchase>;
        const externalBasis = { verifierId: identifier(proof.validator_id), evidenceRef: identifier(proof.validation_ref),
          generationId, sourceReference: payload.event.sourceReference, executionKey: purchase.executionKey,
          purchaseFingerprint: walletPurchaseBasisFingerprint(purchase), verifiedAt: clock(proof.checked_at) };
        if (purchase.executionEvidenceRef !== externalBasis.evidenceRef || object(proof.value).sourceReference !== payload.event.sourceReference
          || object(proof.value).canonical !== "confirmed_execution") return deferred("wallet_execution_proof_mismatch");
        preparePostgresWalletCapture({ ...payload, profile, sessionId: "durable-fact-validation", receivedAt: ctx.asOf,
          executionTrust: "unverified", verifiedPurchase: purchase, externalBasis });
        return { status: "verified", purchase, externalBasis };
      } catch { return deferred("wallet_execution_proof_mismatch"); }
    },
    async target(ctx) {
      context(ctx); if (ctx.key.channel !== "wallet") return { status: "missing" };
      const rows = await profilesAt(ctx.asOf,ctx.key.walletFamily,forwardTargetSubjectKey(ctx.key),1);
      const row = rows?.[0]; if (!row || row.profile.fact.entityId !== ctx.key.entityId) return { status: "unavailable" };
      const fact = canonicalForwardTargetChannelFact({ ...row.profile.fact,
        monitoringEnabled: row.profile.fact.monitoringEnabled && row.profile.profileEnabled,
        suspended: row.profile.fact.suspended || row.profile.profileSuspended,
        ownerCount: row.profile.bindingState === "owned" ? row.profile.fact.ownerCount : Math.max(2,row.profile.fact.ownerCount) });
      return { status: "available", snapshot: { fact, capturedAt: ctx.asOf, sourceObservedAt: row.observedAt,
        sourceFingerprint: row.fingerprint, proofScope: "legacy_registry_linkage" } };
    },
    async safety(ctx) {
      context(ctx); const sample = ctx.sample;
      const stored = await runtime.run(tx => tx.query(`/* service-fact-safety-sample */ SELECT s.*,r.ownership_evidence_ref
        FROM forward_purchase_samples s JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
        WHERE s.generation_id=$1 AND s.sample_id=$2 AND s.execution_fingerprint=$3 AND s.entity_id=$4 AND s.chain=$5 AND s.token_address=$6
          AND s.occurred_at=$7 AND s.created_at<=$8 AND r.state='original'
          AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions x WHERE x.trade_id=s.trade_id AND x.state='pending_review' AND x.recorded_at<=$8)`,
      [generationId,sample.sampleId,sample.executionFingerprint,sample.entityId,sample.chain,sample.tokenAddress,sample.boughtAt,ctx.asOf]));
      if (stored.rows.length !== 1) return deferred("signal_execution_revision_unavailable");
      const subject = postgresServiceFactFingerprint([sample.sampleId,sample.executionFingerprint]);
      const source = (await readFacts(ctx,"source",subject,1))?.[0], risk = (await readFacts(ctx,"risk",subject,1))?.[0], independent = (await readFacts(ctx,"independence",subject,1))?.[0];
      if (!source || !risk || !independent) return deferred("signal_source_risk_independence_unavailable");
      const sourceValue = object(source.value), riskValue = object(risk.value), independentValue = object(independent.value);
      const key = sourceValue.target as Parameters<PostgresProductionFactAdapters["target"]>[0]["key"];
      if (!key || key.entityId !== sample.entityId || key.channel !== "wallet" || key.walletFamily !== (sample.chain === "solana" ? "solana" : "evm")) return deferred("signal_source_owner_mismatch");
      for (const proof of [sourceValue,riskValue,independentValue]) if (proof.sampleId !== sample.sampleId || proof.executionFingerprint !== sample.executionFingerprint) return deferred("signal_exact_execution_proof_required");
      const current = await profilesAt(ctx.asOf,key.walletFamily,forwardTargetSubjectKey(key),1), profile = current?.[0]?.profile;
      if (!profile || !selectPostgresWalletProfiles([profile],key.walletFamily!).length
        || profile.fact.ownershipEvidenceRef !== stored.rows[0]!.ownership_evidence_ref
        || sourceValue.canonical !== "confirmed_live_execution" || sourceValue.targetVersionId !== profile.versionId
        || postgresServiceFactFingerprint(canonicalForwardTargetChannelFact(sourceValue.target as PostgresWalletProfile["fact"])) !== postgresServiceFactFingerprint(profile.fact)
        || !["validated","blocked"].includes(String(riskValue.verdict))
        || typeof independentValue.independenceKey !== "string" || !independentValue.independenceKey.trim()) return deferred("signal_current_owner_or_proof_unavailable");
      return { status: "available", assessment: { sampleId: sample.sampleId, executionFingerprint: sample.executionFingerprint,
        assessedAt: ctx.asOf, target: key, independenceKey: independentValue.independenceKey,
        riskVerdict: riskValue.verdict as "validated" | "blocked", riskEvidenceRef: identifier(risk.source_ref),
        liveSourceVerified: true, sourceEvidenceRef: identifier(source.source_ref) } };
    },
    async prices(ctx) {
      context(ctx); const started = now();
      const claim = await runtime.run(tx => tx.query(`/* service-fact-price-claim */ UPDATE wallet_service_price_leases
        SET claim_generation=claim_generation+1,lease_owner=$2,lease_expires_at=$3
        WHERE generation_id=$1 AND (lease_owner IS NULL OR lease_expires_at<=$4) RETURNING claim_generation,lease_expires_at`,
      [generationId,ownerId,started+leaseMs,started]));
      const row = claim.rows[0]; if (!row) return deferred("shared_price_lease_unavailable");
      const claimGeneration = clock(row.claim_generation), leaseExpiresAt = clock(row.lease_expires_at);
      const release = () => runtime.run(tx => tx.query(`/* service-fact-price-release */ UPDATE wallet_service_price_leases
        SET lease_owner=NULL,lease_expires_at=NULL WHERE generation_id=$1 AND lease_owner=$2 AND claim_generation=$3`,[generationId,ownerId,claimGeneration]));
      try {
        const rows = await readFacts(ctx,"price",null,ctx.limit);
        if (!rows) { await release(); return deferred("independently_validated_price_unavailable"); }
        const peaks: ForwardPeakEvidence[] = [], markets: Extract<Awaited<ReturnType<PostgresProductionFactAdapters["prices"]>>,{status:"available"}>["markets"][number][] = [];
        for (const row of rows) {
          const payload = object(row.value);
          if (payload.type === "peak") {
            const peak = canonicalForwardPeak(payload.peak as ForwardPeakEvidence);
            if (peak.verification !== "validated" || peak.knownAt > ctx.asOf || peak.evidenceRef !== row.source_ref) throw new Error("Invalid durable peak provenance");
            peaks.push(peak);
          } else if (payload.type === "market") {
            const market = object(payload.market) as unknown as typeof markets[number];
            if (market.generationId !== generationId || market.verification !== "validated" || market.evidenceRef !== row.source_ref
              || clock(market.occurredAt) > ctx.asOf) throw new Error("Invalid durable market provenance");
// Reported cap is eligible only through its separate signed source-authority branch.
            // Existing market payloads remain compatible; FDV never substitutes for marketCapUsd.
            const signedMarketBasis = object(object(object(payload.validation).claims).sourceBasis);
            if ('quality' in market || signedMarketBasis.kind === 'approved_reported_market_cap_v1') {
              const value = object(market), source = object(value.source), validation = object(payload.validation);
              const claims = object(validation.claims), basis = object(claims.sourceBasis), proof = object(validation.sourceProof);
              const report = object(proof.reportedMarketCap), raw = object(proof.rawEvidence), approval = object(raw.approval);
              if (value.quality !== 'reported' || value.independence !== 'unverified' || value.conflictState !== 'none_observed'
                || source.protocol !== 'ave_token_market_cap_v1' || source.providerId !== row.provider_id
                || source.reportedAt !== market.occurredAt || report.reportedAt !== market.occurredAt
                || report.marketCapUsd !== market.marketCapUsd || report.fdvUsd !== value.fdvUsd
                || source.quoteAddress !== report.quoteAddress || source.protocol !== report.sourceProtocol
                || raw.providerId !== row.provider_id || raw.protocol !== source.protocol
                || postgresServiceFactFingerprint(raw.response) !== postgresServiceFactFingerprint(report.sourceEvidence)
                || report.quality !== 'reported' || report.independence !== 'unverified' || report.conflictState !== 'unassessed'
                || basis.kind !== 'approved_reported_market_cap_v1' || basis.providerId !== row.provider_id
                || claims.sourceApprovalRef !== source.approvalRef || claims.generationId !== generationId
                || claims.validatorId !== row.validator_id || claims.validationRef !== row.validation_ref
                || claims.providerId !== row.provider_id || clock(claims.checkedAt) !== clock(row.checked_at)
                || clock(claims.expiresAt) !== clock(row.expires_at)
                || approval.generationId !== generationId || approval.validatorId !== row.validator_id
                || approval.keyId !== claims.keyId || approval.sourceProofKind !== basis.kind
                || claims.sourceBasis === undefined || basis.contentFingerprint !== postgresServiceFactFingerprint(proof)
                || approval.sourceApprovalRef !== source.approvalRef || approval.providerId !== row.provider_id
                || approval.quality !== 'reported' || approval.conflictState !== 'none_observed' || approval.revokedAt !== null
                || clock(approval.validFrom) > ctx.asOf || clock(approval.validUntil) <= ctx.asOf
                || clock(market.occurredAt) !== clock(row.observed_at)) throw new Error('Invalid durable reported-market source authority');
            }
            markets.push({ ...market, now: ctx.asOf });
          } else throw new Error("Price facts require actual trade/candle or canonical market inputs");
        }
        const lease: PostgresProductionPriceLease = { generationId,ownerId,claimGeneration,leaseExpiresAt,
          async assertOwned(tx,at) {
            if (at >= leaseExpiresAt || at < started) throw new Error("Price lease expired");
            if (rows.some(row => clock(row.expires_at)<=at || clock(row.validator_until)<=at)) throw new Error("Price validation proof expired");
            for (const row of rows) await assertReportedPriceApproval(tx, object(row.value), at);
            const owned = await tx.query(`/* service-fact-price-owned */ SELECT claim_generation FROM wallet_service_price_leases
              WHERE generation_id=$1 AND lease_owner=$2 AND claim_generation=$3 AND lease_expires_at>$4 FOR UPDATE`,[generationId,ownerId,claimGeneration,at]);
            if (owned.rows.length !== 1) throw new Error("Price lease lost");
          },
          async complete(tx,at) {
            await lease.assertOwned(tx,at);
            for (const row of rows) await tx.query(`INSERT INTO wallet_service_price_consumption(generation_id,fact_id,consumed_at)
              VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[generationId,row.fact_id,at]);
            const done = await tx.query(`/* service-fact-price-complete */ UPDATE wallet_service_price_leases SET lease_owner=NULL,lease_expires_at=NULL
              WHERE generation_id=$1 AND lease_owner=$2 AND claim_generation=$3 AND lease_expires_at>$4 RETURNING claim_generation`,[generationId,ownerId,claimGeneration,at]);
            if (done.rows.length !== 1) throw new Error("Price lease lost before completion");
          } };
        return { status: "available", lease, peaks, markets };
      } catch (error) { await release().catch(() => undefined); if (ctx.signal.aborted) throw error; return deferred("durable_price_proof_invalid"); }
    },
  };
  const bindFetch = (contexts?: readonly PostgresRpcDiagnosticContext[]): FetchLike => {
    const bindings: PostgresRpcDiagnosticContext[] = [];
    // Snapshot only own data; hostile metadata must not affect acquisition or invoke hooks.
    try {
      if (contexts && !utilTypes.isProxy(contexts) && Array.isArray(contexts) && contexts.length <= 100) {
        for (let index = 0; index < contexts.length; index++) {
          const slot = Object.getOwnPropertyDescriptor(contexts,String(index));
          const value: unknown = slot && "value" in slot ? slot.value : undefined;
          if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) continue;
          const descriptors = ["endpoint","chain","providerId","purpose"].map(key => Object.getOwnPropertyDescriptor(value,key));
          if (descriptors.some(item => !item || !("value" in item))) continue;
          const [endpoint,chain,providerId,purpose] = descriptors.map(item => item!.value as unknown);
          if (typeof endpoint !== "string" || typeof chain !== "string" || !["solana","eth","bsc","base"].includes(chain)
            || typeof providerId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(providerId)
            || (purpose !== "source" && purpose !== "replay")) continue;
          const target = new URL(endpoint);
          if (!["http:","https:"].includes(target.protocol) || target.username || target.password || target.hash) continue;
          bindings.push({ endpoint: target.href,chain: chain as PostgresRpcDiagnosticContext["chain"],providerId,purpose });
        }
      }
    } catch { /* Invalid diagnostic context never changes transport. */ }
    return async (input,init) => {
    const request = input instanceof Request ? input : null, url = new URL(request?.url ?? String(input));
    if (url.username || url.password || !["https:","http:"].includes(url.protocol)) throw new Error("Invalid provider URL");
    const signal = AbortSignal.any([...(init?.signal ? [init.signal] : request ? [request.signal] : []),AbortSignal.timeout(timeout)]);
    signal.throwIfAborted(); const leaseId = randomUUID();
    let observedMethod: PostgresExecutionRpcDiagnostic["method"] | undefined;
    let boundContext: PostgresRpcDiagnosticContext | undefined;
    const matches = bindings.filter(binding => binding.endpoint === url.href);
    const nativeContext = matches.length === 1 ? matches[0] : undefined;
    const legacy = contexts === undefined && options.sourceRpcOrigin === url.origin;
    const bodyDescriptor = init && !utilTypes.isProxy(init) ? Object.getOwnPropertyDescriptor(init,"body") : undefined;
    const serializedBody: unknown = bodyDescriptor && "value" in bodyDescriptor ? bodyDescriptor.value : undefined;
    if (options.onSourceRpcDiagnostic && (nativeContext || legacy)
      && typeof serializedBody === "string" && Buffer.byteLength(serializedBody) <= responseBytes) {
      try {
        const requestBody = JSON.parse(serializedBody) as unknown;
        if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
          const method: unknown = Object.getOwnPropertyDescriptor(requestBody,"method")?.value;
          if (typeof method === "string" && POSTGRES_EXECUTION_RPC_METHODS.some(allowed => allowed === method)
            && (method.startsWith("eth_") ? nativeContext && nativeContext.chain !== "solana" : legacy || nativeContext?.chain === "solana"))
            observedMethod = method as PostgresExecutionRpcDiagnostic["method"];
        }
      } catch { /* No observer for malformed or non-serialized request bodies. */ }
    }
    const observe = (detail: Omit<PostgresExecutionRpcDiagnostic,"method">) => {
      if (!observedMethod || (!legacy && !boundContext)) return;
      try { options.onSourceRpcDiagnostic?.({ method: observedMethod,...detail,
        ...(boundContext ? { chain: boundContext.chain,providerId: boundContext.providerId,purpose: boundContext.purpose } : {}) }); } catch { /* Observers never change transport semantics. */ }
    };
    // Unintegrated pacing must not change sealed deployments without explicit approval.
    const paced = options.sources.evmProviderPacingEnabled === true && pacedEvmRequest(init?.body, responseBytes);
    const acquire = () => {
      const at = now();
      return runtime.run(async tx => {
      const row = (await tx.query(`/* service-provider-budget-lock */ SELECT b.*,
        (SELECT count(*) FROM wallet_service_provider_leases x WHERE x.generation_id=b.generation_id AND x.provider_id=b.provider_id
          AND x.released_at IS NULL AND x.expires_at>$3) active_leases
        FROM wallet_service_provider_budgets b JOIN wallet_service_import_ledger l ON l.generation_id=b.generation_id AND l.import_id=b.import_id
        WHERE b.generation_id=$1 AND b.origin=$2 AND l.proof_scope='provider_contract' AND l.imported_at<=$3
          AND (l.revoked_at IS NULL OR l.revoked_at>$3) FOR UPDATE OF b`,[generationId,url.origin,at])).rows[0];
      if (!row) throw new PostgresProviderBudgetError(at+timeout,"contract_unavailable");
      if (!utilTypes.isProxy(row)) {
        const provider = Object.getOwnPropertyDescriptor(row,"provider_id");
        if (provider && "value" in provider && provider.value === nativeContext?.providerId) boundContext = nativeContext;
      }
      const storedCooldown = row.cooldown_until;
      if (!((typeof storedCooldown === "string" && /^\d+$/.test(storedCooldown))
        || (typeof storedCooldown === "number" && Number.isSafeInteger(storedCooldown) && storedCooldown >= 0)
        || (typeof storedCooldown === "bigint" && storedCooldown >= 0n))) throw new PostgresProviderBudgetError(null,"invalid_cooldown");
      let cooldownUntil: number;
      try { cooldownUntil = clock(storedCooldown); } catch { throw new PostgresProviderBudgetError(null,
        String(storedCooldown) === POSTGRES_PROVIDER_COOLDOWN_PAUSED ? "paused" : "invalid_cooldown"); }
      if (cooldownUntil > at) throw new PostgresProviderBudgetError(cooldownUntil,"cooldown");
      const start = clock(row.window_started_at), windowMs = clock(row.window_ms), next = start+windowMs;
      if (at < start) throw new PostgresProviderBudgetError(next,"clock_regressed");
      if (clock(row.active_leases) >= clock(row.maximum_concurrency)) throw new PostgresProviderBudgetError(next,"concurrency");
      if (at < next && clock(row.requests_used) >= clock(row.maximum_requests)) throw new PostgresProviderBudgetError(next,"window");
      const reset = at >= next, used = reset ? 1 : clock(row.requests_used)+1;
      if (paced) signal.throwIfAborted();
      const debit = await tx.query(`/* service-provider-budget-debit */ UPDATE wallet_service_provider_budgets
        SET window_started_at=$3,requests_used=$4 WHERE generation_id=$1 AND provider_id=$2 RETURNING provider_id`,
      [generationId,row.provider_id,reset ? start+Math.floor((at-start)/windowMs)*windowMs : start,used]);
      if (debit.rows.length !== 1) throw new PostgresProviderBudgetError(next,"debit_unavailable");
      if (paced) {
        const until = providerPacingUntil(at, windowMs, clock(row.maximum_requests));
        const persisted = await tx.query(`/* service-provider-cooldown */ UPDATE wallet_service_provider_budgets
            SET cooldown_until=GREATEST(cooldown_until,$3::bigint) WHERE generation_id=$1 AND provider_id=$2 RETURNING cooldown_until`,
          [generationId,row.provider_id,until]);
        if (persisted.rows.length !== 1) throw new Error("Provider pacing persistence unavailable");
      }
      await tx.query(`INSERT INTO wallet_service_provider_leases(lease_id,generation_id,provider_id,owner_id,expires_at)
        VALUES($1,$2,$3,$4,$5)`,[leaseId,generationId,row.provider_id,ownerId,at+timeout]);
      return identifier(row.provider_id);
      });
    };
    const providerId = paced ? await acquirePacedProvider(acquire, { paced, signal, now, maximumWaitMs: timeout,
      budgetRetryAt: error => error instanceof PostgresProviderBudgetError ? error.retryAt : null }).catch(error => {
        observeBudget(error); throw error;
      }) : await acquire().catch(error => { observeBudget(error); throw error; });
    function observeBudget(error: unknown) {
      if (utilTypes.isProxy(error)) return;
      if (!(error instanceof PostgresProviderBudgetError)) return;
      const reason: unknown = Object.getOwnPropertyDescriptor(error,"budgetReason")?.value;
      const retryAt: unknown = Object.getOwnPropertyDescriptor(error,"retryAt")?.value;
      observe({ code: null,subcategory: "provider_budget_unavailable",reasonCode: "execution_rpc_provider_budget_unavailable",transport: "local",
        ...(typeof retryAt === "number" && Number.isSafeInteger(retryAt) && retryAt >= 0 ? { retryAt } : {}),
        ...(POSTGRES_PROVIDER_BUDGET_REASONS.some(allowed => allowed === reason)
          ? { budgetReason: reason as typeof POSTGRES_PROVIDER_BUDGET_REASONS[number] } : {}) });
    }
    let reject!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve,fail) => { reject = fail; }), abort = () => reject(signal.reason);
    signal.addEventListener("abort",abort,{once:true});
    try {
      if (paced) signal.throwIfAborted();
      if (signal.aborted) abort();
      const response = await Promise.race([baseFetch(input,{ ...init,redirect:"error",signal }),aborted]);
      if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) throw new Error("Unbudgeted provider redirect refused");
      const persistCooldown = async () => {
        const until = retryAfterCooldown(response.headers.get("Retry-After"),now());
        await runtime.run(async tx => {
          const persisted = await tx.query(`/* service-provider-cooldown */ UPDATE wallet_service_provider_budgets
            SET cooldown_until=GREATEST(cooldown_until,$3::bigint) WHERE generation_id=$1 AND provider_id=$2 RETURNING cooldown_until`,
          [generationId,providerId,until]);
          if (persisted.rows.length !== 1) throw new Error("Provider cooldown persistence unavailable");
        });
      };
      if (response.status === 429) {
        observe({ code: null,subcategory: "rate_limit",reasonCode: "execution_rpc_rate_limited",transport: "http",httpStatus: response.status });
        await persistCooldown();
      }
      if (response.status >= 400 && response.status !== 429) {
        observe({ code: null,httpStatus: response.status,transport: "http",reasonCode: "execution_rpc_response_error",
          subcategory: response.status === 401 ? "authentication_required" : response.status === 403 ? "permission_denied" : "other_rpc_error" });
      }
      const reader = response.body?.getReader(), parts: Uint8Array[] = []; let size = 0;
      try { if (reader) for (;;) {
        const chunk = await Promise.race([reader.read(),aborted]); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > responseBytes) throw new Error("Provider response budget exceeded"); parts.push(chunk.value);
      } } finally { if (reader) await reader.cancel().catch(() => undefined); }
      const body = Buffer.concat(parts), headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
      if (response.status === 200) {
        let rpc: Row | undefined, method: string | undefined;
        try { rpc = object(JSON.parse(body.toString("utf8"))); } catch { /* Not a JSON-RPC response. */ }
        if (typeof init?.body === "string" && Buffer.byteLength(init.body) <= responseBytes) {
          try {
            const requestBody = object(JSON.parse(init.body));
            if (typeof requestBody.method === "string") method = requestBody.method;
          } catch { /* Classification never consumes an unbounded request body. */ }
        }
        const error = rpc?.error;
        if (rpc?.jsonrpc === "2.0" && error && typeof error === "object" && !Array.isArray(error)
          && classifyJsonRpcLimit({ ...(method === undefined ? {} : { method }), code: (error as Row).code, message: (error as Row).message,
            httpStatus: response.status }) === "rate_limit") await persistCooldown();
        if (rpc?.jsonrpc === "2.0" && error && typeof error === "object" && !Array.isArray(error)) {
          const rawCode = (error as Row).code;
          const code = typeof rawCode === "number" && Number.isSafeInteger(rawCode) ? rawCode : null;
          const category = classifyJsonRpcLimit({ ...(method === undefined ? {} : { method }),code,message: (error as Row).message,httpStatus: 200 });
          observe({ code,transport: "rpc",httpStatus: response.status,
            subcategory: category === "rate_limit" ? "rate_limit" : category === "ambiguous_limit" ? "ambiguous_limit"
              : code === -32602 ? "invalid_params" : code === -32601 ? "method_not_found"
              : code === -32015 ? "unsupported_transaction_version" : code === -32603 ? "rpc_internal_error" : "other_rpc_error",
            reasonCode: category === "rate_limit" || category === "ambiguous_limit" ? "execution_rpc_rate_limited" : "execution_rpc_response_error" });
        }
      }
      return new Response([204,205,304].includes(response.status) ? null : body,{ status: response.status,statusText:response.statusText,headers });
    } catch (error) {
      observe({ code: null,subcategory: signal.aborted ? "aborted" : "unknown_failure",
        reasonCode: signal.aborted ? "execution_rpc_aborted" : "execution_rpc_transport_unavailable",transport: "unknown" });
      throw error;
    } finally {
      signal.removeEventListener("abort",abort);
      await runtime.run(tx => tx.query(`/* service-provider-release */ UPDATE wallet_service_provider_leases SET released_at=$5
        WHERE lease_id=$1 AND generation_id=$2 AND provider_id=$3 AND owner_id=$4 AND released_at IS NULL`,[leaseId,generationId,providerId,ownerId,now()]));
    }
    };
  };
  const guardedFetch = bindFetch(options.sourceRpcContexts);
  return Object.freeze({ profiles,facts,fetch:guardedFetch,withRpcDiagnosticContexts: bindFetch,
    async targetedBackfillPoll(input: Parameters<PostgresServiceFactPorts["targetedBackfillPoll"]>[0]) {
      const asOf = now(), batch = await facts.prices({ generationId,asOf,limit:input.limit,signal:input.signal });
      if (batch.status !== "available") return batch;
      const received = await runtime.run(tx => receivePostgresProductionPriceBatch(tx,{ generationId,asOf,limit:input.limit,batch,now }));
      return { status:"applied",...received,gatewayDeliveryEnabled:false };
    },
    async enqueueSourceRequest(input: Parameters<PostgresServiceFactPorts["enqueueSourceRequest"]>[0]) {
      input.signal.throwIfAborted(); [input.providerId,input.kind,input.subjectKey].forEach(identifier);
      if (!["execution","price","source","risk","independence"].includes(input.kind)) throw new Error("Unknown targeted factual request");
      const at = now(); await runtime.run(async tx => {
        const result = await tx.query(`INSERT INTO wallet_service_source_requests(generation_id,provider_id,request_key,kind,subject_key,requested_at,status)
          SELECT b.generation_id,b.provider_id,$3,$4,$5,$6,'pending' FROM wallet_service_provider_budgets b
          JOIN wallet_service_import_ledger l ON l.import_id=b.import_id WHERE b.generation_id=$1 AND b.provider_id=$2
            AND l.proof_scope='provider_contract' AND l.imported_at<=$6 AND (l.revoked_at IS NULL OR l.revoked_at>$6)
          ON CONFLICT DO NOTHING RETURNING request_key`,[generationId,input.providerId,postgresServiceFactFingerprint([input.kind,input.subjectKey]),input.kind,input.subjectKey,at]);
        if (!result.rows.length) {
          const duplicate = await tx.query("SELECT request_key FROM wallet_service_source_requests WHERE generation_id=$1 AND provider_id=$2 AND request_key=$3",
            [generationId,input.providerId,postgresServiceFactFingerprint([input.kind,input.subjectKey])]);
          if (!duplicate.rows.length) throw new PostgresProviderBudgetError(at+timeout);
        }
      });
    },
  });
}
