import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresIndependentPriceValidator, type PostgresIndependentPriceValidatorOptions,
  type PostgresPriceIndependenceApproval, type PostgresPriceIndependenceApprovalPort } from "../src/postgres-independent-price-validator.js";
import { priceCandidateFingerprint, priceValidationSigningPayload } from "../src/postgres-price-fact-publisher.js";
import { postgresServiceFactFingerprint } from "../src/postgres-service-fact-adapters.js";
import type { PostgresGeckoTerminalPriceCandidate } from "../src/postgres-controlled-price-producer.js";

const keys = generateKeyPairSync("ed25519");
const otherKeys = generateKeyPairSync("ed25519");
const mapping = { chain: "solana" as const, tokenAddress: "TokenCase", poolAddress: "PoolCase", tokenSide: "base" as const,
  network: "solana", evidenceRef: "reviewed:pool-token-map", knownAt: 100_000 };
const candle = { timestamp: 120_000, open: 1, high: 3, low: 0.5, close: 2, volumeUsd: 20 };
function candidate(patch: Partial<PostgresGeckoTerminalPriceCandidate> = {}): PostgresGeckoTerminalPriceCandidate {
  const value = { generationId: "generation", providerId: "source-gecko", sampleId: "sample", executionFingerprint: "a".repeat(64),
    boughtAt: 90_000, until: 180_000, knownAt: 200_000, mapping, candles: [candle],
    coverage: "bounded_observations_only" as const, contentFingerprint: "", ...patch };
  return { ...value, contentFingerprint: priceCandidateFingerprint(value) };
}
function response(path: string, rows: unknown = [[120, 1, 3, 0.5, 2, 20]], token = "TokenCase"): Response {
  const content = path.includes("ohlcv") ? { data: { attributes: { ohlcv_list: rows } } }
    : { data: [{ id: "solana_PoolCase", attributes: { address: "PoolCase", base_token_price_usd: "99", quote_token_price_usd: "1",
      reserve_in_usd: "100", market_cap_usd: null, fdv_usd: null, pool_created_at: null },
      relationships: { base_token: { data: { id: `solana_${token}` } }, quote_token: { data: { id: "solana_USDC" } } } }] };
  return new Response(JSON.stringify(content), { headers: { "content-type": "application/json" } });
}
// These are simulated trusted-port receipts, not real provider or policy approvals.
function approved(patch: Partial<PostgresPriceIndependenceApproval> = {}): PostgresPriceIndependenceApproval {
  return { approvalRef: "reviewed:independent-price", generationId: "generation", validatorId: "price-validator", keyId: "price-key",
    actorId: "price-reviewer", sourceProviderId: "source-gecko", replayProviderId: "reviewed-price-source",
    sourceOperatorId: "gecko-operator", replayOperatorId: "independent-operator", sourceDataPlatformId: "gecko-platform",
    replayDataPlatformId: "independent-platform", mappingApprovalRef: "approved:mapping", sourceApprovalRef: "approved:price-source",
    sourceProofKind: "independent_gecko_ohlcv_replay_v1", mappingFingerprint: postgresServiceFactFingerprint({ ...mapping, poolAddress: "PoolCase" }),
    candleMs: 60_000, validFrom: 100_000, validUntil: 300_000, revokedAt: null,
    consistencyPolicy: { policyId: "fixture:exact-policy", kind: "exact_closed_candles_v1", approvedAt: 100_000,
      validFrom: 100_000, validUntil: 300_000, revokedAt: null }, ...patch };
}
function fixture(overrides: Partial<PostgresIndependentPriceValidatorOptions> = {}) {
  let now = 200_000;
  const fetch = vi.fn<typeof globalThis.fetch>(async url => response(String(url)));
  const loadPrivateKey = vi.fn(async () => keys.privateKey);
  const authorizePriceReplay = vi.fn<PostgresPriceIndependenceApprovalPort["authorizePriceReplay"]>(
    async () => ({ status: "approved", approval: approved() }));
  const options: PostgresIndependentPriceValidatorOptions = {
    generationId: "generation", activatedAt: 1_000, validatorId: "price-validator", keyId: "price-key", actorId: "price-reviewer",
    authorizationRef: "reviewed:independent-price", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    approval: { authorizePriceReplay },
    signingKey: { loadPrivateKey }, fetch, now: () => now,
    timeoutMs: 100, minimumRequestIntervalMs: 0, rateLimitCooldownMs: 1_000,
    maximumRunMs: 1_000, maximumPayloadBytes: 128_000, maximumResponseBytes: 32_000, maximumCandles: 3,
    maximumWindowMs: 200_000, maximumMappingAgeMs: 200_000, maximumCandidateAgeMs: 10_000,
    maximumRequests: 2, maximumOutstandingPorts: 3, validationTtlMs: 30_000,
    reviewedBindings: [{ sourceProviderId: "source-gecko", replayProviderId: "reviewed-price-source",
      sourceBaseUrl: "https://source.example/api/v2", replayBaseUrl: "https://independent.example/api/v2", mapping,
      timeframe: "minute", aggregate: 1, candleMs: 60_000, mappingApprovalRef: "approved:mapping",
      sourceApprovalRef: "approved:price-source", sourceProofKind: "independent_gecko_ohlcv_replay_v1",
      validFrom: 100_000, validUntil: 300_000 }], ...overrides,
  };
  return { options, fetch, loadPrivateKey, authorizePriceReplay, setNow: (value: number) => { now = value; } };
}
const signal = () => new AbortController().signal;

describe("independent actual price replay validator", () => {
  it("replays actual pool and candles before signing the existing publisher protocol", async () => {
    const f = fixture(), validator = createPostgresIndependentPriceValidator(f.options);
    const result = await validator.validatePrice({ candidate: candidate(), signal: signal() });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    const { claims, signature, sourceProof } = result.validation;
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.authorizePriceReplay).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls.every(([url]) => String(url).startsWith("https://independent.example/api/v2/"))).toBe(true);
    expect(verify(null, priceValidationSigningPayload(claims), keys.publicKey, Buffer.from(signature, "base64"))).toBe(true);
    expect(claims).toMatchObject({ providerId: "source-gecko", candidateFingerprint: candidate().contentFingerprint,
      sampleId: "sample", executionFingerprint: "a".repeat(64), candidateKnownAt: 200_000, checkedAt: 200_000, expiresAt: 230_000,
      mappingApprovalRef: "approved:mapping", sourceApprovalRef: "approved:price-source",
      sourceBasis: { kind: "independent_gecko_ohlcv_replay_v1", providerId: "reviewed-price-source" } });
    expect(claims.sourceBasis.contentFingerprint).toBe(postgresServiceFactFingerprint(sourceProof));
    expect(sourceProof).toMatchObject({ mapping, candleMs: 60_000, candles: [candle], rawEvidence: { providerId: "reviewed-price-source" } });
    expect(sourceProof.rawEvidence).not.toEqual({ caller: "untrusted" });
    expect(result.validation).not.toHaveProperty("coverage");
    expect(result.validation).not.toHaveProperty("entryPriceUsd");
    expect(result.validation).not.toHaveProperty("risk");
  });

  it("does not compare provider-dependent candidate hashes or sign caller evidence", async () => {
    const f = fixture(), validator = createPostgresIndependentPriceValidator(f.options);
    const original = candidate();
    expect(priceCandidateFingerprint({ ...original, providerId: "reviewed-price-source" })).not.toBe(original.contentFingerprint);
    const result = await validator.validatePrice({ candidate: { ...original, evidence: { caller: "untrusted" } } as typeof original, signal: signal() });
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(JSON.stringify(result.validation.sourceProof)).not.toContain("untrusted");
  });

  it.each([4, 2.5])("refuses an independently replayed high of %s that differs from the candidate", async high => {
    const f = fixture(); f.fetch.mockImplementation(async url => response(String(url), [[120, 1, high, 0.5, 2, 20]]));
    const result = await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() });
    expect(result).toMatchObject({ status: "deferred" }); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it("refuses a pool whose actual Solana token differs in case", async () => {
    const f = fixture(); f.fetch.mockImplementation(async url => response(String(url), undefined, "tokencase"));
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it.each(["same-provider", "same-host", "credentials", "insecure", "candle-duration"])("rejects unsafe reviewed binding %s at construction", kind => {
    const f = fixture(), pin = f.options.reviewedBindings[0]!;
    const patch = kind === "same-provider" ? { replayProviderId: pin.sourceProviderId }
      : kind === "same-host" ? { replayBaseUrl: "https://source.example/other" }
      : kind === "credentials" ? { replayBaseUrl: "https://user:secret@independent.example/api/v2" }
      : kind === "insecure" ? { replayBaseUrl: "http://independent.example/api/v2" } : { candleMs: 1_000 };
    expect(() => createPostgresIndependentPriceValidator({ ...f.options, reviewedBindings: [{ ...pin, ...patch }] })).toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["generation", "fingerprint", "coverage", "future", "mapping", "stale"])("refuses invalid candidate %s before RPC", async kind => {
    const f = fixture(); let value = candidate();
    if (kind === "generation") value = candidate({ generationId: "other" });
    if (kind === "fingerprint") value = { ...value, contentFingerprint: "f".repeat(64) };
    if (kind === "coverage") value = { ...value, coverage: "complete" } as unknown as typeof value;
    if (kind === "future") value = candidate({ knownAt: 200_001 });
    if (kind === "mapping") value = candidate({ mapping: { ...mapping, poolAddress: "OtherPool" } });
    if (kind === "stale") f.setNow(220_001);
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: value, signal: signal() })).status).toBe("deferred");
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it.each([[[60, 1, 3, 0.5, 2, 20]], [[180, 1, 3, 0.5, 2, 20]]])("does not validate a pre-buy or still-open candle", async rows => {
    const f = fixture(); f.fetch.mockImplementation(async url => response(String(url), rows));
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it("rejects an injected private key that does not match the pinned public key", async () => {
    const f = fixture(); f.loadPrivateKey.mockResolvedValue(otherKeys.privateKey);
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
  });

  it("honors caller abort without transport or signing", async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: controller.signal })).status).toBe("deferred");
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it("bounds ignored transport aborts and retains outstanding capacity instead of restarting the deadline", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maximumRunMs: 20, timeoutMs: 10 }); f.fetch.mockImplementation(async () => new Promise<Response>(() => {}));
      const validator = createPostgresIndependentPriceValidator(f.options);
      const work = validator.validatePrice({ candidate: candidate(), signal: signal() });
      await vi.advanceTimersByTimeAsync(20);
      expect((await work).status).toBe("deferred");
      expect((await validator.validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
      expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.loadPrivateKey).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("rejects an oversized raw response without signing it", async () => {
    const f = fixture({ maximumResponseBytes: 100 });
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it("does not follow a response redirected outside its reviewed endpoint", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async () => { const value = response("pool"); Object.defineProperty(value, "redirected", { value: true }); return value; });
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it.each([300_000, 199_999])("rechecks expiry and clock regression after trusted key acquisition at %s", async clock => {
    const f = fixture(); f.loadPrivateKey.mockImplementation(async () => { f.setNow(clock); return keys.privateKey; });
    expect((await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() })).status).toBe("deferred");
  });

  it("caps signature expiry at the reviewed authority end", async () => {
    const f = fixture(); const pin = f.options.reviewedBindings[0]!;
    const validator = createPostgresIndependentPriceValidator({ ...f.options, reviewedBindings: [{ ...pin, validUntil: 210_000 }] });
    const result = await validator.validatePrice({ candidate: candidate(), signal: signal() });
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.validation.claims.expiresAt).toBe(210_000);
  });

  it.each([0, 300_001, undefined])("requires explicit bounded signature TTL %s", ttl => {
    const f = fixture(); expect(() => createPostgresIndependentPriceValidator({ ...f.options, validationTtlMs: ttl } as PostgresIndependentPriceValidatorOptions)).toThrow();
  });

  it("requires an explicit request budget and snapshots reviewed pins", async () => {
    const f = fixture(); expect(() => createPostgresIndependentPriceValidator({ ...f.options, maximumRequests: 0 })).toThrow();
    const validator = createPostgresIndependentPriceValidator(f.options);
    (f.options.reviewedBindings[0]!.mapping as { poolAddress: string }).poolAddress = "mutated";
    try {
      const originalMapping = { ...mapping, poolAddress: "PoolCase" };
      const result = await validator.validatePrice({ candidate: candidate({ mapping: originalMapping }), signal: signal() });
      expect(result.status).toBe("verified");
    } finally { mapping.poolAddress = "PoolCase"; }
  });

  it("always defers without a trusted approval port despite distinct hosts and forged candidate approval", async () => {
    const f = fixture(), { approval: _approval, ...withoutApproval } = f.options;
    const value = { ...candidate(), approval: approved() };
    const result = await createPostgresIndependentPriceValidator(withoutApproval).validatePrice({ candidate: value, signal: signal() });
    expect(result).toEqual({ status: "deferred", reasonCode: "price_independence_approval_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it("defers when the trusted port reports that actual approval is unavailable", async () => {
    const f = fixture(); f.authorizePriceReplay.mockResolvedValue({ status: "deferred", reasonCode: "actual_ledger_missing" });
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "price_independence_approval_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it.each(["operator", "platform"])("does not accept distinct hosts/providers sharing the same %s", async kind => {
    const f = fixture(), receipt = approved();
    f.authorizePriceReplay.mockResolvedValue({ status: "approved", approval: approved(kind === "operator"
      ? { replayOperatorId: receipt.sourceOperatorId } : { replayDataPlatformId: receipt.sourceDataPlatformId }) });
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "price_provider_independence_not_approved" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it.each(["approvalRef", "generationId", "validatorId", "keyId", "actorId", "sourceProviderId", "replayProviderId",
    "mappingApprovalRef", "sourceApprovalRef", "sourceProofKind", "mappingFingerprint"] as const)("binds real approval scope %s", async field => {
    const f = fixture(); f.authorizePriceReplay.mockResolvedValue({ status: "approved", approval: approved({ [field]: "wrong" }) });
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "price_independence_approval_scope_mismatch" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "approximate", "not-approved", "future", "revoked", "expired"])("defers an unapproved consistency policy: %s", async kind => {
    const f = fixture(), receipt = approved(), policy = receipt.consistencyPolicy!;
    const consistencyPolicy = kind === "missing" ? null : { ...policy,
      ...(kind === "approximate" ? { kind: "relative_tolerance_v1" } : {}),
      ...(kind === "not-approved" ? { approvedAt: null } : {}),
      ...(kind === "future" ? { approvedAt: 200_001 } : {}),
      ...(kind === "revoked" ? { revokedAt: 199_999 } : {}),
      ...(kind === "expired" ? { validUntil: 200_000 } : {}) };
    f.authorizePriceReplay.mockResolvedValue({ status: "approved", approval: approved({ consistencyPolicy }) });
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "price_consistency_policy_unapproved" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it.each(["revoked", "expired", "future"])("defers inactive independence approval: %s", async kind => {
    const f = fixture(); f.authorizePriceReplay.mockResolvedValue({ status: "approved", approval: approved(kind === "revoked"
      ? { revokedAt: 199_999 } : kind === "expired" ? { validUntil: 200_000 } : { validFrom: 200_001 }) });
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "price_independence_approval_inactive" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rechecks actual approval after replay and key acquisition before producing a signature", async () => {
    const f = fixture();
    f.authorizePriceReplay.mockResolvedValueOnce({ status: "approved", approval: approved() })
      .mockResolvedValueOnce({ status: "approved", approval: approved({ revokedAt: 200_000 }) });
    const result = await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() });
    expect(result).toEqual({ status: "deferred", reasonCode: "price_independence_approval_inactive" });
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.authorizePriceReplay).toHaveBeenCalledTimes(2);
  });

  it("rejects approval or policy revision drift instead of silently accepting a new policy", async () => {
    const f = fixture(), first = approved();
    f.authorizePriceReplay.mockResolvedValueOnce({ status: "approved", approval: first })
      .mockResolvedValueOnce({ status: "approved", approval: approved({ consistencyPolicy: { ...first.consistencyPolicy!, policyId: "changed" } }) });
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "price_independence_approval_changed" });
  });

  it("binds the actual approval receipt into the signed raw proof and caps its expiry", async () => {
    const f = fixture(), receipt = approved();
    f.authorizePriceReplay.mockResolvedValue({ status: "approved", approval: approved({ validUntil: 220_000,
      consistencyPolicy: { ...receipt.consistencyPolicy!, validUntil: 210_000 } }) });
    const result = await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.validation.claims.expiresAt).toBe(210_000);
    expect(result.validation.sourceProof.rawEvidence).toMatchObject({ approval: { approvalRef: receipt.approvalRef,
      sourceDataPlatformId: "gecko-platform", replayDataPlatformId: "independent-platform", consistencyPolicy: { kind: "exact_closed_candles_v1" } } });
    expect(result.validation.claims.sourceBasis.contentFingerprint).toBe(postgresServiceFactFingerprint(result.validation.sourceProof));
  });

  it("never introduces a tolerance even for a nearly equal high under the approved exact policy", async () => {
    const f = fixture(); f.fetch.mockImplementation(async url => response(String(url), [[120, 1, 3.000001, 0.5, 2, 20]]));
    expect(await createPostgresIndependentPriceValidator(f.options).validatePrice({ candidate: candidate(), signal: signal() }))
      .toEqual({ status: "deferred", reasonCode: "independent_price_replay_mismatch" });
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });

  it("bounds an ignored approval-port abort and keeps its outstanding capacity charged", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ maximumRunMs: 20 }); f.authorizePriceReplay.mockImplementation(async () => new Promise(() => {}));
      const validator = createPostgresIndependentPriceValidator(f.options);
      const work = validator.validatePrice({ candidate: candidate(), signal: signal() });
      await vi.advanceTimersByTimeAsync(20);
      expect(await work).toEqual({ status: "deferred", reasonCode: "price_validation_aborted_or_timed_out" });
      expect(await validator.validatePrice({ candidate: candidate(), signal: signal() })).toEqual({ status: "deferred", reasonCode: "price_validator_busy" });
      expect(f.authorizePriceReplay).toHaveBeenCalledTimes(1); expect(f.fetch).not.toHaveBeenCalled(); expect(f.loadPrivateKey).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
