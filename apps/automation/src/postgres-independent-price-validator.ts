import { createPostgresReportedMarketCapProducer, normalizeAveReportedMarketCap, type PostgresReportedMarketCapCandidate, type PostgresReportedMarketCapClient, type PostgresPriceCandidate } from './postgres-controlled-price-producer.js';
import { createPublicKey, KeyObject, randomUUID, sign } from "node:crypto";
import { createPostgresGeckoTerminalPriceProducer, type PostgresGeckoTerminalPriceCandidate,
  type PostgresPricePoolMapping } from "./postgres-controlled-price-producer.js";
import { priceCandidateFingerprint, priceValidationSigningPayload, type PostgresPriceSourceProof,
  type PostgresPriceValidationClaims, type SignedPostgresPriceValidation } from "./postgres-price-fact-publisher.js";
import { postgresServiceFactFingerprint } from "./postgres-service-fact-adapters.js";

type ProducerOptions = Parameters<typeof createPostgresGeckoTerminalPriceProducer>[0];
export interface PostgresPriceIndependenceApproval {
  readonly approvalRef: string;
  readonly generationId: string;
  readonly validatorId: string;
  readonly keyId: string;
  readonly actorId: string;
  readonly sourceProviderId: string;
  readonly replayProviderId: string;
  readonly sourceOperatorId: string;
  readonly replayOperatorId: string;
  readonly sourceDataPlatformId: string;
  readonly replayDataPlatformId: string;
  readonly mappingApprovalRef: string;
  readonly sourceApprovalRef: string;
  readonly sourceProofKind: string;
  readonly mappingFingerprint: string;
  readonly candleMs: number;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly revokedAt: number | null;
  readonly consistencyPolicy: {
    readonly policyId: string;
    readonly kind: string;
    readonly approvedAt: number | null;
    readonly validFrom: number;
    readonly validUntil: number;
    readonly revokedAt: number | null;
  } | null;
}
export interface PostgresPriceIndependenceApprovalPort {
  /** Read actual reviewed authority; never derive approval from hosts or candidate-provided claims. */
  authorizePriceReplay(input: {
    readonly authorizationRef: string;
    readonly generationId: string;
    readonly validatorId: string;
    readonly keyId: string;
    readonly actorId: string;
    readonly sourceProviderId: string;
    readonly replayProviderId: string;
    readonly mappingApprovalRef: string;
    readonly sourceApprovalRef: string;
    readonly sourceProofKind: string;
    readonly mappingFingerprint: string;
    readonly candleMs: number;
    readonly candidateFingerprint: string;
    readonly sampleId: string;
    readonly executionFingerprint: string;
    readonly checkedAt: number;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly status: "approved"; readonly approval: PostgresPriceIndependenceApproval }
    | { readonly status: "deferred"; readonly reasonCode: string }
  >;
}
export interface PostgresReviewedPriceReplayBinding {
  readonly sourceProviderId: string;
  readonly replayProviderId: string;
  readonly sourceBaseUrl: string;
  readonly replayBaseUrl: string;
  readonly mapping: PostgresPricePoolMapping;
  readonly timeframe: ProducerOptions["timeframe"];
  readonly aggregate: number;
  readonly candleMs: number;
  readonly mappingApprovalRef: string;
  readonly sourceApprovalRef: string;
  readonly sourceProofKind: string;
  readonly validFrom: number;
  readonly validUntil: number;
}
export type PostgresIndependentPriceValidatorOptions = Omit<ProducerOptions,
  "providerId" | "baseUrl" | "timeframe" | "aggregate" | "fetch" | "now"> & {
  readonly validatorId: string;
  readonly keyId: string;
  readonly actorId: string;
  readonly authorizationRef: string;
  /** Absence intentionally disables verified output; static reviewedBindings are not approval. */
  readonly approval?: PostgresPriceIndependenceApprovalPort;
  readonly publicKey: string;
  /** This trusted port must never load key material or a key path from a candidate. */
  readonly signingKey: { loadPrivateKey(input: { readonly validatorId: string; readonly keyId: string;
    readonly signal: AbortSignal }): KeyObject | Promise<KeyObject> };
  readonly reviewedBindings: readonly PostgresReviewedPriceReplayBinding[];
  /** Production wiring must supply the independently authorized durable-budget transport. */
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly validationTtlMs: number;
  readonly maximumCandidateAgeMs: number;
  readonly maximumResponseBytes: number;
  readonly maximumRequests: number;
  readonly maximumOutstandingPorts: number;
};
export type PostgresIndependentPriceValidationResult =
  | { readonly status: "verified"; readonly validation: SignedPostgresPriceValidation }
  | { readonly status: "deferred"; readonly reasonCode: string };

class Refusal extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}
function requireValue(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function identity(value: string): void {
  requireValue(typeof value === "string" && !!value.trim() && value.length <= 512 && !value.includes("://"), "Explicit bounded identity required");
}
function timestamp(value: number): void {
  requireValue(Number.isSafeInteger(value) && value >= 0, "Explicit valid timestamp required");
}
function budget(value: number, maximum = 2_147_483_647): void {
  requireValue(Number.isSafeInteger(value) && value > 0 && value <= maximum, "Explicit bounded budget required");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function endpoint(value: string): URL {
  const url = new URL(value);
  requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    "Reviewed HTTPS endpoint without credentials/query/fragment required");
  return url;
}
function semantic(candidate: PostgresGeckoTerminalPriceCandidate): unknown {
  return { generationId: candidate.generationId, sampleId: candidate.sampleId, executionFingerprint: candidate.executionFingerprint,
    boughtAt: candidate.boughtAt, until: candidate.until, mapping: candidate.mapping, candles: candidate.candles, coverage: candidate.coverage };
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Refusal("price_validation_aborted_or_timed_out"));
    if (signal.aborted) { work.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
  });
}
interface ReplayContext {
  readonly signal: AbortSignal;
  readonly responses: { readonly path: string; readonly content: unknown }[];
  requests: number;
  bytes: number;
  failure: string | null;
}

/** Validates bounded observed highs only. It cannot assert exhaustive/non-hit coverage or an execution price. */
export function createPostgresIndependentPriceValidator(input: PostgresIndependentPriceValidatorOptions) {
  const options = { ...input, reviewedBindings: structuredClone(input.reviewedBindings), signingKey: input.signingKey,
    approval: input.approval ? { authorizePriceReplay: input.approval.authorizePriceReplay.bind(input.approval) } : undefined };
  [options.generationId, options.validatorId, options.keyId, options.actorId, options.authorizationRef].forEach(identity);
  timestamp(options.activatedAt);
  [options.maximumRunMs, options.timeoutMs, options.rateLimitCooldownMs, options.maximumMappingAgeMs,
    options.maximumCandidateAgeMs].forEach(value => budget(value));
  budget(options.maximumCandles, 1000); budget(options.maximumWindowMs, Number.MAX_SAFE_INTEGER);
  budget(options.maximumPayloadBytes, 10_000_000); budget(options.maximumResponseBytes, options.maximumPayloadBytes);
  budget(options.maximumRequests, 16); budget(options.maximumOutstandingPorts, 32); budget(options.validationTtlMs, 300_000);
  requireValue(options.maximumRequests >= 2 && options.maximumOutstandingPorts >= 2, "Pool and candle replay capacity required");
  requireValue(Number.isSafeInteger(options.minimumRequestIntervalMs) && options.minimumRequestIntervalMs >= 0,
    "Explicit request pacing required");
  requireValue(typeof options.fetch === "function" && typeof options.now === "function"
    && typeof options.signingKey?.loadPrivateKey === "function", "Trusted clock, transport and signing-key ports required");
  const publicKey = createPublicKey(options.publicKey);
  requireValue(publicKey.asymmetricKeyType === "ed25519", "Pinned Ed25519 public key required");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  requireValue(options.reviewedBindings.length > 0 && options.reviewedBindings.length <= 128, "Explicit bounded reviewed bindings required");
  const seen = new Set<string>();
  let active = false;
  let outstandingPorts = 0;
  async function port<T>(operation: () => Promise<T> | T, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (outstandingPorts >= options.maximumOutstandingPorts) throw new Refusal("price_validation_port_capacity_exceeded");
    outstandingPorts++;
    // Keep capacity charged until the actual port settles, even when its caller has already timed out.
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .finally(() => { outstandingPorts--; });
    return abortable(work, signal);
  }
  function checkApproval(approval: PostgresPriceIndependenceApproval, pin: PostgresReviewedPriceReplayBinding, at: number): void {
    if (!approval || approval.approvalRef !== options.authorizationRef || approval.generationId !== options.generationId
      || approval.validatorId !== options.validatorId || approval.keyId !== options.keyId || approval.actorId !== options.actorId
      || approval.sourceProviderId !== pin.sourceProviderId || approval.replayProviderId !== pin.replayProviderId
      || approval.mappingApprovalRef !== pin.mappingApprovalRef || approval.sourceApprovalRef !== pin.sourceApprovalRef
      || approval.sourceProofKind !== pin.sourceProofKind || approval.mappingFingerprint !== postgresServiceFactFingerprint(pin.mapping)
      || approval.candleMs !== pin.candleMs) throw new Refusal("price_independence_approval_scope_mismatch");
    [approval.sourceOperatorId, approval.replayOperatorId, approval.sourceDataPlatformId, approval.replayDataPlatformId].forEach(identity);
    if (approval.sourceOperatorId === approval.replayOperatorId || approval.sourceDataPlatformId === approval.replayDataPlatformId) {
      throw new Refusal("price_provider_independence_not_approved");
    }
    timestamp(approval.validFrom); timestamp(approval.validUntil);
    if (approval.revokedAt !== null || approval.validUntil <= approval.validFrom
      || at < approval.validFrom || at >= approval.validUntil) throw new Refusal("price_independence_approval_inactive");
    const policy = approval.consistencyPolicy;
    if (!policy || policy.kind !== "exact_closed_candles_v1" || policy.approvedAt === null
      || !Number.isSafeInteger(policy.approvedAt) || policy.approvedAt < 0 || policy.approvedAt > at) {
      throw new Refusal("price_consistency_policy_unapproved");
    }
    identity(policy.policyId); timestamp(policy.validFrom); timestamp(policy.validUntil);
    if (policy.revokedAt !== null || policy.validUntil <= policy.validFrom || at < policy.validFrom || at >= policy.validUntil) {
      throw new Refusal("price_consistency_policy_unapproved");
    }
  }
  async function readApproval(pin: PostgresReviewedPriceReplayBinding, value: PostgresGeckoTerminalPriceCandidate,
    at: number, signal: AbortSignal): Promise<PostgresPriceIndependenceApproval> {
    if (!options.approval) throw new Refusal("price_independence_approval_unavailable");
    const result = await port(() => options.approval!.authorizePriceReplay({ authorizationRef: options.authorizationRef,
      generationId: options.generationId, validatorId: options.validatorId, keyId: options.keyId, actorId: options.actorId,
      sourceProviderId: pin.sourceProviderId, replayProviderId: pin.replayProviderId, mappingApprovalRef: pin.mappingApprovalRef,
      sourceApprovalRef: pin.sourceApprovalRef, sourceProofKind: pin.sourceProofKind,
      mappingFingerprint: postgresServiceFactFingerprint(pin.mapping), candleMs: pin.candleMs,
      candidateFingerprint: value.contentFingerprint, sampleId: value.sampleId, executionFingerprint: value.executionFingerprint,
      checkedAt: at, signal }), signal);
    signal.throwIfAborted();
    if (result.status !== "approved") throw new Refusal("price_independence_approval_unavailable");
    const approval = structuredClone(result.approval);
    checkApproval(approval, pin, at);
    return approval;
  }
  const bindings = options.reviewedBindings.map(pin => {
    [pin.sourceProviderId, pin.replayProviderId, pin.mappingApprovalRef, pin.sourceApprovalRef, pin.sourceProofKind,
      pin.mapping.chain, pin.mapping.tokenAddress, pin.mapping.poolAddress, pin.mapping.network, pin.mapping.evidenceRef].forEach(identity);
    requireValue(["solana", "eth", "bsc", "base"].includes(pin.mapping.chain)
      && ["base", "quote"].includes(pin.mapping.tokenSide), "Explicit supported pool identity required");
    const sourceUrl = endpoint(pin.sourceBaseUrl), replayUrl = endpoint(pin.replayBaseUrl);
    requireValue(pin.sourceProviderId !== pin.replayProviderId && sourceUrl.hostname !== replayUrl.hostname
      && ![pin.sourceProviderId, pin.replayProviderId].includes(options.validatorId)
      && ![pin.sourceProviderId, pin.replayProviderId].includes(options.actorId), "Independently reviewed provider and endpoint required");
    budget(pin.aggregate, 1000); budget(pin.candleMs); timestamp(pin.validFrom); timestamp(pin.validUntil); timestamp(pin.mapping.knownAt);
    const unitMs = pin.timeframe === "minute" ? 60_000 : pin.timeframe === "hour" ? 3_600_000 : pin.timeframe === "day" ? 86_400_000 : 0;
    requireValue(unitMs > 0 && pin.candleMs === unitMs * pin.aggregate, "Pinned canonical candle duration required");
    requireValue(pin.validUntil > pin.validFrom && pin.mapping.knownAt <= pin.validFrom, "Explicit mapping authority interval required");
    const index = canonical([pin.sourceProviderId, pin.mapping]);
    requireValue(!seen.has(index), "Ambiguous reviewed mapping binding"); seen.add(index);
    let context: ReplayContext | null = null;
    const fetch: typeof globalThis.fetch = async (resource, init) => {
      const current = context;
      if (!current) throw new Refusal("price_replay_outside_validation");
      const signal = init?.signal ? AbortSignal.any([current.signal, init.signal]) : current.signal;
      try {
        signal.throwIfAborted();
        const url = new URL(typeof resource === "string" || resource instanceof URL ? resource : resource.url);
        const prefix = `${replayUrl.pathname.replace(/\/$/, "")}/`;
        if (url.origin !== replayUrl.origin || !url.pathname.startsWith(prefix) || url.username || url.password || url.hash
          || (init?.method ?? "GET").toUpperCase() !== "GET") throw new Refusal("price_replay_endpoint_mismatch");
        if (++current.requests > options.maximumRequests) throw new Refusal("price_replay_request_budget_exceeded");
        return await port(async () => {
          const response = await options.fetch(resource, { ...init, signal, redirect: "error" });
          if (response.redirected || (response.url && new URL(response.url).origin !== replayUrl.origin)) {
            void response.body?.cancel().catch(() => {}); throw new Refusal("price_replay_redirect_rejected");
          }
          if (!response.ok) {
            void response.body?.cancel().catch(() => {}); throw new Refusal(`price_replay_http_${response.status}`);
          }
          const declaredLength = response.headers.get("content-length");
          if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > options.maximumResponseBytes)) {
            void response.body?.cancel().catch(() => {}); throw new Refusal("price_replay_response_budget_exceeded");
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Refusal("price_replay_response_body_missing");
          const cancel = () => { void reader.cancel().catch(() => {}); };
          signal.addEventListener("abort", cancel, { once: true });
          const chunks: Buffer[] = [];
          let bytes = 0;
          try {
            while (true) {
              signal.throwIfAborted();
              const chunk = await reader.read();
              signal.throwIfAborted();
              if (chunk.done) break;
              bytes += chunk.value.byteLength; current.bytes += chunk.value.byteLength;
              if (bytes > options.maximumResponseBytes || current.bytes > options.maximumPayloadBytes) {
                cancel(); throw new Refusal("price_replay_response_budget_exceeded");
              }
              chunks.push(Buffer.from(chunk.value));
            }
          } finally { signal.removeEventListener("abort", cancel); }
          const body = Buffer.concat(chunks).toString("utf8");
          const content: unknown = JSON.parse(body);
          current.responses.push({ path: url.pathname, content });
          return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
        }, signal);
      } catch (error) {
        current.failure = error instanceof Refusal ? error.reasonCode
          : signal.aborted ? "price_validation_aborted_or_timed_out" : "price_replay_transport_unavailable";
        throw error;
      }
    };
    // Persist SDK pacing/cooldown across calls rather than recreating a fresh provider budget for every candidate.
    const producer = createPostgresGeckoTerminalPriceProducer({ generationId: options.generationId, activatedAt: options.activatedAt,
      providerId: pin.replayProviderId, fetch, baseUrl: pin.replayBaseUrl, timeoutMs: options.timeoutMs,
      minimumRequestIntervalMs: options.minimumRequestIntervalMs, rateLimitCooldownMs: options.rateLimitCooldownMs,
      maximumRunMs: options.maximumRunMs, maximumPayloadBytes: options.maximumPayloadBytes, maximumCandles: options.maximumCandles,
      maximumWindowMs: options.maximumWindowMs, maximumMappingAgeMs: options.maximumMappingAgeMs,
      timeframe: pin.timeframe, aggregate: pin.aggregate, now: options.now });
    return { pin, producer, setContext: (value: ReplayContext | null) => { context = value; } };
  });
  return Object.freeze({
    async validatePrice(request: { readonly candidate: PostgresPriceCandidate;
      readonly signal: AbortSignal }): Promise<PostgresIndependentPriceValidationResult> {
      const deferred = (reasonCode: string): PostgresIndependentPriceValidationResult => ({ status: "deferred", reasonCode });
      if (request.signal.aborted) return deferred("price_validation_aborted_or_timed_out");
      if (active || outstandingPorts > 0) return deferred("price_validator_busy");
      if (request.candidate.kind === 'reported_market_cap') return deferred('reported_market_requires_separate_source_authority');
      active = true;
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), options.maximumRunMs);
      let selected: typeof bindings[number] | undefined;
      try {
        const startedAt = options.now(); timestamp(startedAt);
        if (Buffer.byteLength(JSON.stringify(request.candidate)) > options.maximumPayloadBytes) return deferred("price_candidate_payload_budget_exceeded");
        const value = structuredClone(request.candidate);
        [value.generationId, value.providerId, value.sampleId].forEach(identity);
        [value.knownAt, value.boughtAt, value.until].forEach(timestamp);
        if (value.generationId !== options.generationId || value.coverage !== "bounded_observations_only"
          || !/^[a-f0-9]{64}$/.test(value.executionFingerprint) || value.contentFingerprint !== priceCandidateFingerprint(value)
          || value.boughtAt < options.activatedAt || value.until <= value.boughtAt || value.until > value.knownAt
          || value.until - value.boughtAt > options.maximumWindowMs || value.knownAt > startedAt
          || startedAt - value.knownAt > options.maximumCandidateAgeMs
          || !Array.isArray(value.candles) || !value.candles.length || value.candles.length > options.maximumCandles) {
          return deferred("price_candidate_contract_mismatch");
        }
        selected = bindings.find(binding => binding.pin.sourceProviderId === value.providerId
          && canonical(binding.pin.mapping) === canonical(value.mapping));
        if (!selected || startedAt < selected.pin.validFrom || startedAt >= selected.pin.validUntil
          || startedAt - value.mapping.knownAt > options.maximumMappingAgeMs) return deferred("approved_price_replay_binding_unavailable");
        const approval = await readApproval(selected.pin, value, startedAt, signal);
        const acquisitionAt = options.now(); timestamp(acquisitionAt);
        if (acquisitionAt < startedAt || acquisitionAt >= selected.pin.validUntil) return deferred("price_validation_clock_or_authority_expired");
        checkApproval(approval, selected.pin, acquisitionAt);
        const current: ReplayContext = { signal, responses: [], requests: 0, bytes: 0, failure: null };
        selected.setContext(current);
        const acquired = await port(() => selected!.producer.acquire({ generationId: value.generationId, sampleId: value.sampleId,
          executionFingerprint: value.executionFingerprint, boughtAt: value.boughtAt, until: value.until,
          mapping: structuredClone(selected!.pin.mapping), signal }), signal);
        signal.throwIfAborted();
        if (acquired.status !== "acquired") return deferred(current.failure ?? "independent_price_replay_unavailable");
        if (canonical(semantic(acquired.candidate)) !== canonical(semantic(value))) return deferred("independent_price_replay_mismatch");
        if (current.responses.length < 2 || current.responses.length > options.maximumRequests) return deferred("independent_price_raw_proof_unavailable");
        const rawEvidence = { format: 1, providerId: selected.pin.replayProviderId, approval, responses: current.responses };
        const revision = postgresServiceFactFingerprint({ mapping: selected.pin.mapping, candleMs: selected.pin.candleMs, rawEvidence });
        const sourceProof: PostgresPriceSourceProof = { mapping: structuredClone(selected.pin.mapping), candleMs: selected.pin.candleMs,
          sourceRevision: `sha256:${revision}`, candles: structuredClone(acquired.candidate.candles), rawEvidence };
        const privateKey = await port(() => options.signingKey.loadPrivateKey({ validatorId: options.validatorId, keyId: options.keyId, signal }), signal);
        signal.throwIfAborted();
        if (!(privateKey instanceof KeyObject) || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519"
          || !createPublicKey(privateKey).export({ format: "der", type: "spki" }).equals(publicDer)) return deferred("price_validator_key_binding_mismatch");
        const authorityAt = options.now(); timestamp(authorityAt);
        if (authorityAt < startedAt) return deferred("price_validation_clock_or_authority_expired");
        const finalApproval = await readApproval(selected.pin, value, authorityAt, signal);
        if (canonical(finalApproval) !== canonical(approval)) return deferred("price_independence_approval_changed");
        const checkedAt = options.now(); timestamp(checkedAt);
        if (checkedAt < startedAt || checkedAt < acquired.candidate.knownAt || checkedAt >= selected.pin.validUntil
          || checkedAt - value.knownAt > options.maximumCandidateAgeMs
          || checkedAt - value.mapping.knownAt > options.maximumMappingAgeMs) return deferred("price_validation_clock_or_authority_expired");
        checkApproval(finalApproval, selected.pin, checkedAt);
        const expiresAt = Math.min(checkedAt + options.validationTtlMs, selected.pin.validUntil,
          finalApproval.validUntil, finalApproval.consistencyPolicy!.validUntil); timestamp(expiresAt);
        const claims: PostgresPriceValidationClaims = { format: 1, generationId: options.generationId, providerId: value.providerId,
          validatorId: options.validatorId, keyId: options.keyId, candidateFingerprint: value.contentFingerprint,
          candidateKnownAt: value.knownAt, sampleId: value.sampleId, executionFingerprint: value.executionFingerprint,
          mappingApprovalRef: selected.pin.mappingApprovalRef, sourceApprovalRef: selected.pin.sourceApprovalRef,
          sourceRevision: sourceProof.sourceRevision, validationRef: `price-validation:${randomUUID()}`, checkedAt, expiresAt,
          sourceBasis: { kind: selected.pin.sourceProofKind, providerId: selected.pin.replayProviderId,
            evidenceRef: `price-replay:${revision}`, contentFingerprint: postgresServiceFactFingerprint(sourceProof) } };
        signal.throwIfAborted();
        const validation: SignedPostgresPriceValidation = { claims, sourceProof,
          signature: sign(null, priceValidationSigningPayload(claims), privateKey).toString("base64") };
        if (Buffer.byteLength(JSON.stringify({ candidate: value, validation })) > options.maximumPayloadBytes) {
          return deferred("price_validation_payload_budget_exceeded");
        }
        return { status: "verified", validation };
      } catch (error) {
        return deferred(signal.aborted ? "price_validation_aborted_or_timed_out"
          : error instanceof Refusal ? error.reasonCode : "independent_price_validation_unavailable");
      } finally {
        clearTimeout(timer); controller.abort(); selected?.setContext(null); active = false;
      }
    },
  });
}

/** Source report authorization is deliberately separate from candle independence and consistency policy. */
export interface PostgresReportedMarketCapApproval {
  readonly approvalRef: string; readonly generationId: string; readonly validatorId: string; readonly keyId: string; readonly actorId: string;
  readonly providerId: string; readonly mappingApprovalRef: string; readonly sourceApprovalRef: string;
  readonly mappingFingerprint: string; readonly quoteAddress: string; readonly sourceProofKind: 'approved_reported_market_cap_v1';
  readonly quality: 'reported'; readonly conflictState: 'none_observed' | 'conflict' | 'unknown';
  readonly validFrom: number; readonly validUntil: number; readonly revokedAt: number | null;
}
export interface PostgresReportedMarketCapBinding {
  readonly mapping: PostgresPricePoolMapping; readonly providerId: string; readonly quoteAddress: string;
  readonly mappingApprovalRef: string; readonly sourceApprovalRef: string; readonly sourceProofKind: 'approved_reported_market_cap_v1';
  readonly candleMs: 0; readonly validFrom: number; readonly validUntil: number;
}
export interface PostgresReportedMarketCapValidatorOptions {
  readonly generationId: string; readonly activatedAt: number; readonly validatorId: string; readonly keyId: string;
  readonly actorId: string; readonly authorizationRef: string; readonly publicKey: string;
  readonly signingKey: PostgresIndependentPriceValidatorOptions['signingKey'];
  readonly client: PostgresReportedMarketCapClient;
  readonly bindings: readonly PostgresReportedMarketCapBinding[];
  readonly approval?: { authorizeReportedMarketCap(input: { readonly authorizationRef: string; readonly generationId: string;
    readonly validatorId: string; readonly keyId: string; readonly actorId: string; readonly providerId: string;
    readonly sourceApprovalRef: string; readonly mappingApprovalRef: string; readonly mappingFingerprint: string;
    readonly quoteAddress: string; readonly candidateFingerprint: string; readonly sampleId: string;
    readonly executionFingerprint: string; readonly checkedAt: number; readonly signal: AbortSignal }): Promise<
      { readonly status: 'approved'; readonly approval: PostgresReportedMarketCapApproval } | { readonly status: 'deferred'; readonly reasonCode: string }> };
  readonly now: () => number; readonly maximumRunMs: number; readonly maximumPayloadBytes: number;
  readonly maximumCandidateAgeMs: number; readonly maximumMappingAgeMs: number; readonly maximumWindowMs: number; readonly validationTtlMs: number;
}
export function createPostgresReportedMarketCapValidator(input: PostgresReportedMarketCapValidatorOptions) {
  const options = { ...input, bindings: structuredClone(input.bindings), client: { tokenDetail: input.client.tokenDetail.bind(input.client) },
    signingKey: { loadPrivateKey: input.signingKey.loadPrivateKey.bind(input.signingKey) },
    approval: typeof input.approval?.authorizeReportedMarketCap === 'function'
      ? { authorizeReportedMarketCap: input.approval.authorizeReportedMarketCap.bind(input.approval) } : undefined };
  [options.generationId, options.validatorId, options.keyId, options.actorId, options.authorizationRef].forEach(identity);
  timestamp(options.activatedAt);
  [options.maximumRunMs, options.maximumCandidateAgeMs, options.maximumMappingAgeMs, options.maximumWindowMs].forEach(value => budget(value));
  budget(options.maximumPayloadBytes, 10_000_000); budget(options.validationTtlMs, 300_000);
  const key = createPublicKey(options.publicKey);
  requireValue(key.asymmetricKeyType === 'ed25519', 'Pinned Ed25519 reported-market key required');
  const publicDer = key.export({ format: 'der', type: 'spki' });
  requireValue(options.bindings.length > 0 && options.bindings.length <= 128, 'Bounded explicit reported-market bindings required');
  const seen = new Set<string>();
  const sources = options.bindings.map(pin => {
    [pin.providerId, pin.quoteAddress, pin.mappingApprovalRef, pin.sourceApprovalRef].forEach(identity);
    timestamp(pin.validFrom); timestamp(pin.validUntil); timestamp(pin.mapping.knownAt);
    requireValue(pin.sourceProofKind === 'approved_reported_market_cap_v1' && pin.candleMs === 0
      && pin.validUntil > pin.validFrom && pin.mapping.knownAt <= pin.validFrom
      && pin.providerId !== options.validatorId && pin.providerId !== options.actorId, 'Explicit source-report binding required');
    const index = canonical([pin.providerId, pin.mapping]);
    requireValue(!seen.has(index), 'Ambiguous reported-market binding'); seen.add(index);
    const producer = createPostgresReportedMarketCapProducer({ generationId: options.generationId, activatedAt: options.activatedAt,
      providerId: pin.providerId, sourceApprovalRef: pin.sourceApprovalRef, client: options.client,
      identity: { chain: pin.mapping.chain, token: pin.mapping.tokenAddress, pool: pin.mapping.poolAddress, quote: pin.quoteAddress },
      maximumRunMs: options.maximumRunMs, maximumPayloadBytes: options.maximumPayloadBytes,
      maximumWindowMs: options.maximumWindowMs, maximumMappingAgeMs: options.maximumMappingAgeMs, now: options.now });
    return { pin, producer };
  });
  let active = false, outstanding = 0;
  async function port<T>(work: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted(); outstanding++;
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).finally(() => { outstanding--; });
    return abortable(pending, signal);
  }
  function checkApproval(approval: PostgresReportedMarketCapApproval, pin: PostgresReportedMarketCapBinding, at: number): void {
    if (!approval || approval.approvalRef !== options.authorizationRef || approval.generationId !== options.generationId
      || approval.validatorId !== options.validatorId || approval.keyId !== options.keyId || approval.actorId !== options.actorId
      || approval.providerId !== pin.providerId || approval.mappingApprovalRef !== pin.mappingApprovalRef
      || approval.sourceApprovalRef !== pin.sourceApprovalRef || approval.mappingFingerprint !== postgresServiceFactFingerprint(pin.mapping)
      || approval.quoteAddress !== pin.quoteAddress || approval.sourceProofKind !== pin.sourceProofKind || approval.quality !== 'reported') {
      throw new Refusal('reported_market_approval_scope_mismatch');
    }
    timestamp(approval.validFrom); timestamp(approval.validUntil);
    if (approval.revokedAt !== null || approval.validUntil <= approval.validFrom || at < approval.validFrom || at >= approval.validUntil) {
      throw new Refusal('reported_market_approval_inactive');
    }
    if (approval.conflictState !== 'none_observed') throw new Refusal('reported_market_conflict_pending');
  }
  return Object.freeze({ async validatePrice(request: { readonly candidate: PostgresPriceCandidate; readonly signal: AbortSignal }): Promise<PostgresIndependentPriceValidationResult> {
    const defer = (reasonCode: string): PostgresIndependentPriceValidationResult => ({ status: 'deferred', reasonCode });
    if (request.signal.aborted) return defer('reported_market_validation_aborted_or_timed_out');
    if (active || outstanding > 0) return defer('reported_market_validator_busy');
    if (!options.approval) return defer('reported_market_source_approval_unavailable');
    active = true;
    const controller = new AbortController(), signal = AbortSignal.any([request.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), options.maximumRunMs);
    try {
      const started = options.now(); timestamp(started);
      if (Buffer.byteLength(JSON.stringify(request.candidate)) > options.maximumPayloadBytes) return defer('reported_market_payload_budget');
      const candidate = structuredClone(request.candidate);
      if (candidate.kind !== 'reported_market_cap' || candidate.generationId !== options.generationId
        || candidate.coverage !== 'reported_snapshot_only' || !/^[a-f0-9]{64}$/.test(candidate.executionFingerprint)
        || candidate.contentFingerprint !== priceCandidateFingerprint(candidate)) return defer('reported_market_candidate_contract_mismatch');
      [candidate.sampleId, candidate.providerId, candidate.sourceApprovalRef].forEach(identity);
      [candidate.knownAt, candidate.boughtAt, candidate.until, candidate.mapping.knownAt].forEach(timestamp);
      const selected = sources.find(source => source.pin.providerId === candidate.providerId && canonical(source.pin.mapping) === canonical(candidate.mapping));
      if (!selected || candidate.sourceApprovalRef !== selected.pin.sourceApprovalRef || started < selected.pin.validFrom || started >= selected.pin.validUntil
        || candidate.boughtAt < options.activatedAt || candidate.until <= candidate.boughtAt || candidate.until > candidate.knownAt
        || candidate.until - candidate.boughtAt > options.maximumWindowMs || candidate.knownAt > started
        || started - candidate.knownAt > options.maximumCandidateAgeMs || candidate.mapping.knownAt > started
        || started - candidate.mapping.knownAt > options.maximumMappingAgeMs) return defer('reported_market_binding_or_clock_unavailable');
      const pin = selected.pin;
      const read = async () => {
        const checkedAt = options.now(); timestamp(checkedAt);
        if (checkedAt < started || checkedAt >= pin.validUntil) throw new Refusal('reported_market_authority_expired');
        const result = await port(() => options.approval!.authorizeReportedMarketCap({ authorizationRef: options.authorizationRef,
          generationId: options.generationId, validatorId: options.validatorId, keyId: options.keyId, actorId: options.actorId,
          providerId: pin.providerId, sourceApprovalRef: pin.sourceApprovalRef, mappingApprovalRef: pin.mappingApprovalRef,
          mappingFingerprint: postgresServiceFactFingerprint(pin.mapping), quoteAddress: pin.quoteAddress,
          candidateFingerprint: candidate.contentFingerprint, sampleId: candidate.sampleId, executionFingerprint: candidate.executionFingerprint,
          checkedAt, signal }), signal);
        if (result.status !== 'approved') throw new Refusal('reported_market_source_approval_unavailable');
        const approval = structuredClone(result.approval); checkApproval(approval, pin, options.now()); return approval;
      };
      const approval = await read();
      const acquired = await port(() => selected.producer.acquire({ ...candidate, signal }), signal);
      if (acquired.status !== 'acquired') return defer(acquired.reasonCode);
      if (canonical(acquired.candidate.report) !== canonical(candidate.report)) return defer('reported_market_source_snapshot_conflict');
      const normalized = normalizeAveReportedMarketCap(candidate.report.sourceEvidence, { chain: pin.mapping.chain,
        token: pin.mapping.tokenAddress, pool: pin.mapping.poolAddress, quote: pin.quoteAddress });
      if (canonical(normalized) !== canonical(candidate.report)) return defer('reported_market_normalization_mismatch');
      const privateKey = await port(() => options.signingKey.loadPrivateKey({ validatorId: options.validatorId, keyId: options.keyId, signal }), signal);
      if (!(privateKey instanceof KeyObject) || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519'
        || !createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).equals(publicDer)) return defer('reported_market_key_binding_mismatch');
      const finalApproval = await read();
      if (canonical(approval) !== canonical(finalApproval)) return defer('reported_market_approval_changed');
      const checkedAt = options.now(); timestamp(checkedAt); checkApproval(finalApproval, pin, checkedAt);
      if (checkedAt < started || checkedAt < acquired.candidate.knownAt || checkedAt >= pin.validUntil
        || checkedAt - candidate.knownAt > options.maximumCandidateAgeMs || checkedAt - candidate.mapping.knownAt > options.maximumMappingAgeMs) return defer('reported_market_authority_expired');
      const expiresAt = Math.min(checkedAt + options.validationTtlMs, pin.validUntil, finalApproval.validUntil); timestamp(expiresAt);
      const rawEvidence = { format: 1, protocol: 'ave_token_market_cap_v1', providerId: pin.providerId,
        approval: finalApproval, response: acquired.candidate.report.sourceEvidence };
      const revision = postgresServiceFactFingerprint(rawEvidence);
      const sourceProof: PostgresPriceSourceProof = { mapping: structuredClone(pin.mapping), candleMs: 0, candles: [],
        reportedMarketCap: structuredClone(acquired.candidate.report), sourceRevision: `sha256:${revision}`, rawEvidence };
      const claims: PostgresPriceValidationClaims = { format: 1, generationId: options.generationId, providerId: pin.providerId,
        validatorId: options.validatorId, keyId: options.keyId, candidateFingerprint: candidate.contentFingerprint,
        candidateKnownAt: candidate.knownAt, sampleId: candidate.sampleId, executionFingerprint: candidate.executionFingerprint,
        mappingApprovalRef: pin.mappingApprovalRef, sourceApprovalRef: pin.sourceApprovalRef, sourceRevision: sourceProof.sourceRevision,
        validationRef: `reported-market-validation:${randomUUID()}`, checkedAt, expiresAt,
        sourceBasis: { kind: pin.sourceProofKind, providerId: pin.providerId, evidenceRef: `reported-market:${revision}`,
          contentFingerprint: postgresServiceFactFingerprint(sourceProof) } };
      signal.throwIfAborted();
      const validation: SignedPostgresPriceValidation = { claims, sourceProof,
        signature: sign(null, priceValidationSigningPayload(claims), privateKey).toString('base64') };
      if (Buffer.byteLength(JSON.stringify({ candidate, validation })) > options.maximumPayloadBytes) return defer('reported_market_payload_budget');
      return { status: 'verified', validation };
    } catch (error) { return defer(signal.aborted ? 'reported_market_validation_aborted_or_timed_out'
      : error instanceof Refusal ? error.reasonCode : 'reported_market_validation_unavailable'); }
    finally { clearTimeout(timer); controller.abort(); active = false; }
  } });
}
