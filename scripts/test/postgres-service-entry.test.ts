import { describe, expect, it, vi } from "vitest";
import { createPostgresRootWalletExecutionReceiver, createPostgresRootPriceRetry, readPostgresServiceProgress, runPostgresServiceEntrypoint, validatePostgresServiceDeployment, verifyPostgresServiceStartup,
  type PostgresRootWalletExecutionConfiguration, type PostgresRootPriceConfiguration, type PostgresRootPriceAuthority } from "../postgres-service-entry.js";
import * as evmExecution from "../../apps/automation/src/postgres-evm-execution-producer.js";
import * as solanaExecution from "../../apps/automation/src/postgres-wallet-rpc-producer.js";
import * as executionReceiver from "../../apps/automation/src/postgres-wallet-execution-receiver.js";
import type { CapturedPostgresWalletEvent } from "../../apps/wallet-monitor/src/postgres-wallet-channel.js";
import type { PostgresTransaction } from "../../packages/database/src/postgres-unit-of-work.js";
import type { PostgresGeckoTerminalPriceCandidate } from "../../apps/automation/src/postgres-controlled-price-producer.js";
import type { SignedPostgresPriceValidation, PostgresPricePublication } from "../../apps/automation/src/postgres-price-fact-publisher.js";
import { POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL } from "../../packages/database/src/postgres-forward-purchases.js";
import { POSTGRES_BUSINESS_SERVICES } from "../../packages/database/src/postgres-service-dispatch.js";
import * as generationProgress from "../../apps/console/src/postgres-progress.js";
import * as cutoverProof from "../../packages/database/src/migration-cutover-coordinator.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Public-only synthetic keys for root boundary fixtures; no signed production authority is constructed here.
const rootFixturePublicKeys = Array.from({ length: 4 }, () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString());
function fixture() {
  return { format: 1, operationId: "isolated-operation", generationId: "isolated-generation", activatedAt: 1000,
    database: "radar_business", schema: "radar_generation", releaseRoot: "/isolated/release", cohortId: "isolated-cohort",
    lifecycle: { startupMs: 2000, pollMs: 1000, shutdownMs: 200, killMs: 200 },
    execution: { maximumEntries: 20, maximumBytes: 4096 },
    cutover: { expected: { version: 2, evidenceMode: "production-observation", closureTrust: {
      authorizationPublicKeyPem: rootFixturePublicKeys[0]!, observerPublicKeyPem: rootFixturePublicKeys[1]!,
      snapshotPublicKeyPem: rootFixturePublicKeys[2]!, independentCompatibilityPublicKeyPem: rootFixturePublicKeys[3]!,
      expectedBinding: { sourcePath: "/isolated/source.sqlite", sourceDevice: "1", sourceInode: "2", generation: "isolated-generation",
        watermark: "isolated-watermark", cluster: "123", schemaSha256: "1".repeat(64), release: "2".repeat(64),
        artifactSha256: "4".repeat(64), cohortSha256: "5".repeat(64), providerGuardSha256: "6".repeat(64), deliveryGuardSha256: "7".repeat(64) },
      expectedScopesSha256: "8".repeat(64), expectedTableNames: ["isolated_table"], expectedRollbackRelease: "3".repeat(64),
      expectedRollbackArtifactSha256: "9".repeat(64), maximumEvidenceAgeMs: 1000, maximumMaintenanceWindowMs: 2000,
    }, binding: { cohortId: "isolated-cohort", generation: "isolated-generation",
      target: { database: "radar_business", schema: "radar_generation", generation: "isolated-generation", schemaSha256: "1".repeat(64),
        releaseSha256: "2".repeat(64), serverAddress: "127.0.0.1", serverPort: 5432, systemIdentifier: "123" },
      rollbackTarget: { database: "radar_business", schema: "radar_generation", generation: "isolated-generation", schemaSha256: "1".repeat(64),
        releaseSha256: "3".repeat(64), serverAddress: "127.0.0.1", serverPort: 5432, systemIdentifier: "123" } },
      deadlines: { maximumOperationMs: 2000 } } },
    gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
    driver: { serviceConnectionBudgets: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, 1])) },
    services: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, { username: `radar_${service}`, maximumConnections: 1, intervalMs: 1000 }])),
    composition: { principal: { actorId: "fixture-actor", authorizationEvidenceRef: "fixture-authority", permissions: ["target_registry_write"] as const },
      quotas: { normalization: 1, token: 1, purchase: 1, fanout: 1, opportunity: 1, capability: 1, signal: 1 },
      maximumClaims: 7, maximumRunMs: 500, admissionLimit: 1, leaseMs: 1000, retryDelayMs: 1000,
      maximumPayloadBytes: 1000, maximumSamples: 1, factLimit: 1, reconcileIntervalMs: 1000 }, sources: {}, wallet: { maximumProfiles: 192, maximumEvents: 100, collectorQuota: 4, leaseMs: 10000, maximumPayloadBytes: 65536, maximumRunMs: 1000 },
    console: { host: "127.0.0.1", port: 3211, maximumTraceRows: 20 } };
}
function executionFixture(): PostgresRootWalletExecutionConfiguration {
  return { receiver: { maximumCandidates: 10, maximumRunMs: 500, maximumPayloadBytes: 10000 },
    evm: { eth: { providerId: "approved-eth", expectedChainId: "0x1", expectedGenesisBlockHash: `0x${"1".repeat(64)}`,
      endpoint: "https://approved.example/rpc", stableQuoteTokens: [{ address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC" }],
      maximumProfiles: 10, maximumLogs: 10, maximumDecimalsReads: 4, maximumRpcRequests: 20, maximumPayloadBytes: 10000, maximumRunMs: 500 } } };
}
function priceConfiguration(): PostgresRootPriceConfiguration {
  return { source: { providerId: "approved-gecko", baseUrl: "https://approved.example/api/v2", timeoutMs: 1000,
      minimumRequestIntervalMs: 0, rateLimitCooldownMs: 1000, maximumRunMs: 1000, maximumPayloadBytes: 64000,
      maximumCandles: 10, maximumWindowMs: 120000, maximumMappingAgeMs: 200000, timeframe: "minute", aggregate: 1 },
    receiver: { maximumCandidates: 2, maximumRunMs: 2000, maximumPayloadBytes: 128000 },
    retry: { maximumSamples: 2, maximumRetryEntries: 2, maximumMappings: 2, maximumPayloadBytes: 128000, maximumRunMs: 3000, retryDelayMs: 1000 },
    mappings: [{ mapping: { chain: "solana", tokenAddress: "TokenCase", poolAddress: "PoolCase", tokenSide: "base", network: "solana", evidenceRef: "approved:map", knownAt: 100000 },
      providerId: "approved-gecko", mappingApprovalRef: "approval:map", sourceApprovalRef: "approval:price-source", sourceProofKind: "independent-candle-replay", candleMs: 60000,
      validFrom: 100000, validUntil: 400000 }] };
}
function priceFixture(settings = priceConfiguration()) {
  const config = validatePostgresServiceDeployment({ ...fixture(), lifecycle: { ...fixture().lifecycle, pollMs: 5000 },
    composition: { maximumSamples: 10, maximumPayloadBytes: 256000, maximumRunMs: 1000 }, priceAcquisition: settings });
  let at = 200000, inUow = false;
  let rows: Record<string, unknown>[] = [{ sample_id: "sample-a", generation_id: config.generationId, execution_fingerprint: "a".repeat(64),
    original_fingerprint: "a".repeat(64), revision_state: "original", activated_at: 1000, chain: "solana", token_address: "TokenCase", occurred_at: "90000",
    expires_at: "300000", created_at: "100000" }];
  const query = vi.fn(async (_sql: string, values: readonly unknown[] = []) => ({
    rows: rows.filter(row => values[3] === null || Number(row.created_at) > Number(values[3])
      || Number(row.created_at) === Number(values[3]) && String(row.sample_id) > String(values[4])).slice(0, Number(values[5])), rowCount: null,
  }));
  const runtime = { async run<T>(operation: (tx: PostgresTransaction) => Promise<T>) {
    if (inUow) throw new Error("Nested UOW forbidden in fixture"); inUow = true;
    try { return await operation({ query }); } finally { inUow = false; }
  } };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    expect(inUow).toBe(false);
    return new Response(JSON.stringify(String(url).includes("ohlcv") ? { data: { attributes: { ohlcv_list: [[120, 1, 3, 0.5, 2, 20]] } } }
      : { data: [{ id: "solana_PoolCase", attributes: { address: "PoolCase", base_token_price_usd: "99", quote_token_price_usd: "1", reserve_in_usd: "100" },
        relationships: { base_token: { data: { id: "solana_TokenCase" } }, quote_token: { data: { id: "solana_USDC" } } } }] }), { headers: { "content-type": "application/json" } });
  });
  const pending = new Set<Promise<unknown>>(), onTimeout = vi.fn();
  const create = (authority?: PostgresRootPriceAuthority) => createPostgresRootPriceRetry({ config, runtime, ports: { fetch }, now: () => at, pending, onTimeout,
    ...(authority ? { authority } : {}) })!;
  return { config, runtime, query, fetch, pending, onTimeout, create, setNow: (value: number) => { at = value; },
    getRows: () => rows, setRows: (value: Record<string, unknown>[]) => { rows = value; } };
}
describe("root actual price factory dispatch and bounded retry", () => {
  it("does nothing without explicitly configured acquisition", () => {
    const runtime = { run: vi.fn() }, fetch = vi.fn();
    expect(createPostgresRootPriceRetry({ config: validatePostgresServiceDeployment(fixture()), runtime, ports: { fetch }, now: () => 200000,
      pending: new Set(), onTimeout: vi.fn() })).toBeUndefined();
    expect(runtime.run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("runs actual SDK and receiver after the existing UOW, but defers without independent authority", async () => {
    const f = priceFixture(), retry = f.create(); expect(f.query).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    const result = await retry.pollOnce(new AbortController().signal);
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(result.results[0]).toMatchObject({ sampleId: "sample-a", status: "deferred", reasonCode: "independent_price_validator_or_publisher_unavailable" });
    expect(result.published).toBe(0); expect(result.coverageVerified).toBe(false); expect(result.durableCheckpoint).toBe(false); expect(result.gatewayDeliveryEnabled).toBe(false);
    expect(String(f.fetch.mock.calls[0]![0])).toContain("networks/solana/tokens/TokenCase/pools");
    expect(String(f.fetch.mock.calls[1]![0])).toContain("pools/PoolCase/ohlcv/minute");
  });
  it("emits SQL matching actual purchase DDL with generation, original revision, expiry and composite keyset filters", async () => {
    const f = priceFixture(); await f.create().pollOnce(new AbortController().signal);
    const [sql, values] = f.query.mock.calls[0]!;
    expect(values).toEqual([f.config.generationId, 200000, 1000, null, null, 2]);
    for (const predicate of ["s.generation_id=$1", "g.activated_at=$3", "s.occurred_at>=g.activated_at", "r.state='original'", "s.expires_at>$2",
      "s.created_at<=$2", "r.recorded_at<=$2", "t.original_fingerprint=s.execution_fingerprint", "conflict.state='pending_review'", "s.sample_id COLLATE", "LIMIT $6"]) expect(sql).toContain(predicate);
    expect(sql).not.toMatch(/INSERT|UPDATE|FOR SHARE|FOR UPDATE|OFFSET/);
    const aliases = { s: "forward_purchase_samples", r: "forward_trade_revisions", t: "forward_economic_trades", g: "forward_strategy_generations", conflict: "forward_trade_revisions" };
    for (const [alias, table] of Object.entries(aliases)) {
      const body = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL)![1]!;
      const columns = new Set([...body.matchAll(/\b([a-z_]+)\s+(?:text|bigint|numeric|boolean)\b/g)].map(match => match[1]));
      for (const match of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_]+)`, "g"))) expect(columns.has(match[1])).toBe(true);
    }
  });
  it.each(["missing", "stale", "future", "expired", "ambiguous"])("defers %s mapping without SDK requests or publisher calls", async fault => {
    const settings = priceConfiguration();
    const pin = settings.mappings[0]!;
    const mappings = fault === "missing" ? [] : fault === "ambiguous" ? [pin, { ...pin, mappingApprovalRef: "approval:another" }]
      : [{ ...pin, ...(fault === "expired" ? { validUntil: 190000 } : {}), mapping: { ...pin.mapping,
        ...(fault === "stale" ? { knownAt: 0 } : fault === "future" ? { knownAt: 200001 } : {}) } }];
    const f = priceFixture({ ...settings, source: { ...settings.source, maximumMappingAgeMs: 100000 }, mappings });
    const publisher = { publish: vi.fn() }, validator = { validatePrice: vi.fn() };
    const result = await f.create({ publisher, validator }).pollOnce(new AbortController().signal);
    expect(result.results[0]).toMatchObject({ status: "deferred", reasonCode: "approved_price_mapping_or_generation_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(publisher.publish).not.toHaveBeenCalled(); expect(validator.validatePrice).not.toHaveBeenCalled();
  });
  it("forwards actual candidate and exact mapping/time/revision to external validator without self-trust", async () => {
    const f = priceFixture(), publisher = { publish: vi.fn() }, validator = { validatePrice: vi.fn(async (_input: { candidate: PostgresGeckoTerminalPriceCandidate; signal: AbortSignal }) => ({ status: "deferred" as const, reasonCode: "independent-replay-pending" })) };
    const result = await f.create({ publisher, validator }).pollOnce(new AbortController().signal);
    expect(validator.validatePrice).toHaveBeenCalledTimes(1);
    expect(validator.validatePrice.mock.calls[0]![0].candidate).toMatchObject({ generationId: f.config.generationId, sampleId: "sample-a", executionFingerprint: "a".repeat(64), boughtAt: 90000, until: 200000,
      mapping: f.config.priceAcquisition!.mappings[0]!.mapping, candles: [{ timestamp: 120000, high: 3 }] });
    expect(result.results[0]).toMatchObject({ status: "deferred", reasonCode: "independent-replay-pending" }); expect(publisher.publish).not.toHaveBeenCalled();
  });
  it("visits tied-created-at samples fairly and retries deferred work after explicit cooldown without a fake done receipt", async () => {
    const settings = priceConfiguration(), f = priceFixture({ ...settings, retry: { ...settings.retry, maximumSamples: 1 } });
    f.setRows([f.getRows()[0]!, { ...f.getRows()[0]!, sample_id: "sample-b" }]);
    const retry = f.create(), signal = new AbortController().signal;
    expect((await retry.pollOnce(signal)).results[0]!.sampleId).toBe("sample-a");
    expect((await retry.pollOnce(signal)).results[0]!.sampleId).toBe("sample-b");
    expect(f.query.mock.calls[1]![1]).toEqual([f.config.generationId, 200000, 1000, 100000, "sample-a", 1]);
    expect((await retry.pollOnce(signal)).scanWrapped).toBe(true);
    expect((await retry.pollOnce(signal)).requested).toBe(0); expect(f.fetch).toHaveBeenCalledTimes(4);
    f.setNow(201001); expect((await retry.pollOnce(signal)).requested).toBe(1); expect(f.fetch).toHaveBeenCalledTimes(6);
  });
  it.each(["generation", "revision", "expired", "pre-activation", "future-created", "unsafe-time"])("rejects %s rows before acquisition even if a query port returns them", async fault => {
    const f = priceFixture(), row = { ...f.getRows()[0]! };
    if (fault === "generation") row.generation_id = "old";
    if (fault === "revision") row.revision_state = "pending_review";
    if (fault === "expired") row.expires_at = "199999";
    if (fault === "pre-activation") row.occurred_at = "999";
    if (fault === "future-created") row.created_at = "200001";
    if (fault === "unsafe-time") row.occurred_at = "9007199254740993";
    f.setRows([row]); await expect(f.create().pollOnce(new AbortController().signal)).rejects.toThrow(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("bounds retry admission and never turns a full cooldown table into completion", async () => {
    const settings = priceConfiguration(), f = priceFixture({ ...settings, retry: { ...settings.retry, maximumSamples: 1, maximumRetryEntries: 1 } });
    f.setRows([f.getRows()[0]!, { ...f.getRows()[0]!, sample_id: "sample-b" }]);
    const retry = f.create(), signal = new AbortController().signal; await retry.pollOnce(signal);
    const blocked = await retry.pollOnce(signal); expect(blocked.sampled).toBe(1); expect(blocked.requested).toBe(0); expect(blocked.durableCheckpoint).toBe(false);
    await retry.pollOnce(signal); f.setNow(201001);
    expect((await retry.pollOnce(signal)).requested).toBe(1);
  });
  it.each(["array", "missing-source", "source-override", "poll-allocation", "page-budget", "mapping-approval", "candle-pin", "timeframe"])("rejects %s configuration without allocating a publisher pool", fault => {
    const settings = priceConfiguration(); let priceAcquisition: unknown = settings;
    if (fault === "array") priceAcquisition = [];
    if (fault === "missing-source") priceAcquisition = { ...settings, source: undefined };
    if (fault === "source-override") priceAcquisition = { ...settings, source: { ...settings.source, generationId: "old" } };
    if (fault === "poll-allocation") priceAcquisition = { ...settings, retry: { ...settings.retry, maximumRunMs: 5000 } };
    if (fault === "page-budget") priceAcquisition = { ...settings, retry: { ...settings.retry, maximumSamples: 3 } };
    if (fault === "mapping-approval") priceAcquisition = { ...settings, mappings: [{ ...settings.mappings[0]!, mappingApprovalRef: "" }] };
    if (fault === "candle-pin") priceAcquisition = { ...settings, mappings: [{ ...settings.mappings[0]!, candleMs: 1 }] };
    if (fault === "timeframe") priceAcquisition = { ...settings, source: { ...settings.source, timeframe: ["minute"] } };
    expect(() => validatePostgresServiceDeployment({ ...fixture(), lifecycle: { ...fixture().lifecycle, pollMs: 5000 },
      composition: { maximumSamples: 10, maximumPayloadBytes: 256000, maximumRunMs: 1000 }, priceAcquisition })).toThrow();
  });
  it("aborts a late read before acquisition and emits no late completion", async () => {
    vi.useFakeTimers();
    try {
      const settings = priceConfiguration(), f = priceFixture({ ...settings, source: { ...settings.source, maximumRunMs: 10, timeoutMs: 10 },
        receiver: { ...settings.receiver, maximumRunMs: 10 }, retry: { ...settings.retry, maximumRunMs: 10 } });
      let resolve!: (result: { rows: Record<string, unknown>[]; rowCount: null }) => void;
      f.query.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const task = f.create().pollOnce(new AbortController().signal), rejected = expect(task).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(11); await rejected; expect(f.onTimeout).toHaveBeenCalledTimes(1);
      resolve({ rows: f.getRows(), rowCount: null }); await Promise.allSettled([...f.pending]);
      expect(f.fetch).not.toHaveBeenCalled(); expect(f.pending.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(["interval", "known-at", "valid-from"])("requires exact numeric %s configuration instead of JSON coercion", field => {
    const p = priceConfiguration();
    const priceAcquisition = field === "interval" ? { ...p, source: { ...p.source, minimumRequestIntervalMs: "0" } }
      : { ...p, mappings: [{ ...p.mappings[0]!, ...(field === "valid-from" ? { validFrom: "100000" } : {}),
        mapping: { ...p.mappings[0]!.mapping, ...(field === "known-at" ? { knownAt: "100000" } : {}) } }] };
    expect(() => validatePostgresServiceDeployment({ ...fixture(), lifecycle: { ...fixture().lifecycle, pollMs: 5000 },
      composition: { maximumSamples: 10, maximumPayloadBytes: 256000, maximumRunMs: 1000 }, priceAcquisition })).toThrow();
  });
  it("tracks native publication until completion and refuses a receiver-timeout acknowledgement", async () => {
    vi.useFakeTimers();
    let resolvePublication: ((result: PostgresPricePublication) => void) | undefined;
    try {
      const p = priceConfiguration(), f = priceFixture({ ...p, source: { ...p.source, timeoutMs: 20, maximumRunMs: 20 },
        receiver: { ...p.receiver, maximumRunMs: 30 }, retry: { ...p.retry, maximumRunMs: 1000 } });
      // Synthetic authority tests lifetime only; no signature or live PG acceptance is asserted.
      const validator = { validatePrice: vi.fn(async () => ({ status: "verified" as const, validation: {} as SignedPostgresPriceValidation })) };
      const publisher = { publish: vi.fn(() => new Promise<PostgresPricePublication>(resolve => { resolvePublication = resolve; })) };
      let settled = false;
      const outcome = f.create({ validator, publisher }).pollOnce(new AbortController().signal).then(
        value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1); expect(publisher.publish).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(31); expect(settled).toBe(false); expect(f.pending.size).toBeGreaterThan(0);
      resolvePublication!({ status: "published", factIds: ["synthetic:fact"] });
      const result = await outcome; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain("PRICE_PUBLICATION_COMPLETION_UNCERTAIN");
      expect(f.pending.size).toBe(0);
    } finally { resolvePublication?.({ status: "deferred", reasonCode: "fixture-cleanup" }); vi.useRealTimers(); }
  });
  it("does not hide native publication errors as successful root poll completion", async () => {
    const f = priceFixture();
    const validator = { validatePrice: vi.fn(async () => ({ status: "verified" as const, validation: {} as SignedPostgresPriceValidation })) };
    const publisher = { publish: vi.fn(async () => { throw new Error("synthetic-native-commit-unknown"); }) };
    await expect(f.create({ validator, publisher }).pollOnce(new AbortController().signal)).rejects.toThrow("PRICE_PUBLICATION_COMPLETION_UNCERTAIN");
    expect(f.pending.size).toBe(0);
  });
});
describe("root explicit execution receiver injection", () => {
  const ports = () => ({ fetch: vi.fn(), profiles: { load: vi.fn() } });
  it("does not allocate producers or network calls when acquisition is unconfigured", () => {
    const p = ports(); expect(createPostgresRootWalletExecutionReceiver({ config: validatePostgresServiceDeployment(fixture()), ports: p, now: () => 2000 })).toBeUndefined();
    expect(p.fetch).not.toHaveBeenCalled(); expect(p.profiles.load).not.toHaveBeenCalled();
  });
  it("constructs explicit EVM factories with the existing generation, fetch and profiles without default chain fallback", async () => {
    const acquire = vi.fn().mockResolvedValue({ status: "deferred", reasonCode: "actual_proof_missing" });
    const factory = vi.spyOn(evmExecution, "createPostgresEvmExecutionProducer").mockReturnValue({ acquire });
    const solana = vi.spyOn(solanaExecution, "createPostgresSolanaExecutionProducer");
    try {
      const p = ports(), config = validatePostgresServiceDeployment({ ...fixture(), walletExecution: executionFixture() });
      const receiver = createPostgresRootWalletExecutionReceiver({ config, ports: p, now: () => 2000 })!;
      expect(factory).toHaveBeenCalledTimes(1); expect(factory.mock.calls[0]![0]).toMatchObject({ generationId: config.generationId, activatedAt: config.activatedAt, chain: "eth", fetch: p.fetch, profiles: p.profiles });
      expect(p.fetch).not.toHaveBeenCalled(); expect(solana).not.toHaveBeenCalled();
      const payload = { generationId: config.generationId, chainFamily: "evm", event: { side: "buy", chain: "bsc" } } as CapturedPostgresWalletEvent;
      const result = await receiver.receive({ payloads: [payload], signal: new AbortController().signal });
      expect(result.results[0]).toEqual({ status: "deferred", reasonCode: "evm_chain_not_explicitly_configured" }); expect(acquire).not.toHaveBeenCalled();
      expect(typeof receiver.verifyPurchase).toBe("function");
    } finally { factory.mockRestore(); solana.mockRestore(); }
  });
  it("acquires candidates but does not manufacture authority or positive risk", async () => {
    const acquire = vi.fn().mockResolvedValue({ status: "acquired", candidate: {} });
    const factory = vi.spyOn(evmExecution, "createPostgresEvmExecutionProducer").mockReturnValue({ acquire });
    try {
      const config = validatePostgresServiceDeployment({ ...fixture(), walletExecution: executionFixture() });
      const receiver = createPostgresRootWalletExecutionReceiver({ config, ports: ports(), now: () => 2000 })!;
      const payload = { generationId: config.generationId, chainFamily: "evm", event: { side: "buy", chain: "eth" } } as CapturedPostgresWalletEvent;
      const result = await receiver.receive({ payloads: [payload], signal: new AbortController().signal });
      expect(acquire).toHaveBeenCalledTimes(1); expect(result.acquired).toBe(1); expect(result.published).toBe(0);
      expect(result.results[0]).toEqual({ status: "deferred", reasonCode: "independent_validator_or_publisher_unavailable" });
    } finally { factory.mockRestore(); }
  });
  it("forwards only preconstructed independent validator/publisher ports and exposes the channel callback", () => {
    const validator = { validateExecution: vi.fn() }, publisher = { publish: vi.fn() }, spy = vi.spyOn(executionReceiver, "createPostgresWalletExecutionReceiver");
    try {
      const config = validatePostgresServiceDeployment({ ...fixture(), walletExecution: executionFixture() });
      const receiver = createPostgresRootWalletExecutionReceiver({ config, ports: ports(), authority: { validator, publisher }, now: () => 2000 })!;
      expect(spy.mock.calls[0]![0].validator).toBe(validator); expect(spy.mock.calls[0]![0].publisher).toBe(publisher);
      expect(receiver.verifyPurchase).toBeDefined(); expect(validator.validateExecution).not.toHaveBeenCalled(); expect(publisher.publish).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(["array", "unknown-chain", "generation-override", "run-budget", "payload-budget", "profile-budget", "missing-pin", "empty-registry"])("rejects %s acquisition configuration before network or UOW allocation", fault => {
    const walletExecution = executionFixture();
    let value: unknown = walletExecution;
    if (fault === "array") value = [];
    if (fault === "unknown-chain") value = { ...walletExecution, evm: { robinhood: walletExecution.evm!.eth } };
    if (fault === "generation-override") value = { ...walletExecution, evm: { eth: { ...walletExecution.evm!.eth, generationId: "other" } } };
    if (fault === "run-budget") value = { ...walletExecution, receiver: { ...walletExecution.receiver, maximumRunMs: 1001 } };
    if (fault === "payload-budget") value = { ...walletExecution, receiver: { ...walletExecution.receiver, maximumPayloadBytes: 65537 } };
    if (fault === "profile-budget") value = { ...walletExecution, evm: { eth: { ...walletExecution.evm!.eth, maximumProfiles: 193 } } };
    if (fault === "missing-pin") value = { ...walletExecution, evm: { eth: { ...walletExecution.evm!.eth, expectedChainId: "" } } };
    if (fault === "empty-registry") value = { receiver: walletExecution.receiver, evm: {} };
    expect(() => validatePostgresServiceDeployment({ ...fixture(), walletExecution: value })).toThrow();
  });
});
describe("PostgreSQL service deployment validation", () => {
  it("requires one complete six-service role and resource allocation", () => {
    expect(validatePostgresServiceDeployment(fixture()).database).toBe("radar_business");
    const value = fixture(); delete value.services.console;
    expect(() => validatePostgresServiceDeployment(value)).toThrow("six-service");
  });
  it("refuses pool allocation mismatch and shared service identities", () => {
    const value = fixture(); value.services.console!.maximumConnections = 2;
    expect(() => validatePostgresServiceDeployment(value)).toThrow("allocation mismatch");
    value.services.console!.maximumConnections = 1; value.services.console!.username = value.services.scanner!.username;
    expect(() => validatePostgresServiceDeployment(value)).toThrow("Distinct");
  });
  it.each(["gatewayDeliveryEnabled", "fomoEnabled", "fullHistoricalMiningEnabled"])("does not activate %s", key => {
    expect(() => validatePostgresServiceDeployment({ ...fixture(), [key]: true })).toThrow();
  });
  it("refuses unbounded polling, profile loads and non-loopback console", () => {
    const value = fixture(); value.wallet.maximumProfiles = Infinity;
    expect(() => validatePostgresServiceDeployment(value)).toThrow("bounded");
    value.wallet.maximumProfiles = 192; value.console.host = "0.0.0.0";
    expect(() => validatePostgresServiceDeployment(value)).toThrow("loopback");
  });
  it.each([undefined, 0, -1, Infinity, "1000"])("requires an explicit numeric wallet run budget: %s", maximumRunMs => {
    const value = fixture();
    expect(() => validatePostgresServiceDeployment({ ...value, wallet: { ...value.wallet, maximumRunMs } })).toThrow("bounded");
  });
  it.each(["cutover", "cohortId", "lifecycle", "execution"])("does not treat missing %s as approved startup", field => {
    expect(() => validatePostgresServiceDeployment({ ...fixture(), [field]: undefined })).toThrow();
  });
  it("rejects a wallet run budget exceeding the actual poll bound", () => {
    const value = fixture(); value.wallet.maximumRunMs = 1001;
    expect(() => validatePostgresServiceDeployment(value)).toThrow("poll deadline");
  });
});

describe("root generation progress adapter", () => {
  it("delegates exact generation and time without rounding or inventing qualification", async () => {
    const transaction = {} as Parameters<typeof readPostgresServiceProgress>[0];
    const input = { generationId: "isolated-generation", asOf: 1000 };
    const progress = {
      backend: "postgresql" as const, ...input,
      gatewayDeliveryEnabled: false as const, coverageVerified: false as const, runnableDelta15m: null,
      stages: [{ stage: "capture" as const, status: "recorded", reasonCode: null,
        count: "9007199254740993", lastProgressAt: 999, newRecords1h: "9007199254740993" }],
      definitions: { totals: "Not qualification", newRecords1h: "Not net queue change",
        opportunity: "Current heads", ability: "Current heads", readiness: "No delivery", gaps: "Unknown" },
    };
    const spy = vi.spyOn(generationProgress, "readPostgresGenerationProgress").mockResolvedValue(progress);
    try {
      const result = await readPostgresServiceProgress(transaction, input);
      expect(spy).toHaveBeenCalledWith(transaction, input);
      expect(result).toEqual({ ...progress, sampledAt: input.asOf, legacyTotalsIncluded: false });
      expect(result.stages[0]).not.toHaveProperty("completed");
      expect(result.stages[0]).not.toHaveProperty("pending");
    } finally { spy.mockRestore(); }
  });
  it("propagates missing evidence instead of fabricating metrics", async () => {
    const spy = vi.spyOn(generationProgress, "readPostgresGenerationProgress").mockRejectedValue(new Error("UNAVAILABLE"));
    try {
      await expect(readPostgresServiceProgress({} as Parameters<typeof readPostgresServiceProgress>[0],
        { generationId: "isolated-generation", asOf: 1000 })).rejects.toThrow("UNAVAILABLE");
    } finally { spy.mockRestore(); }
  });
});

function startupFixture() {
  const config = validatePostgresServiceDeployment(fixture());
  const target = config.cutover.expected.binding.target;
  const runtime = { run: vi.fn() } as unknown as Parameters<typeof verifyPostgresServiceStartup>[0]["runtime"];
  const identity = { database: target.database, schema: target.schema, generation: target.generation,
    schemaFingerprint: target.schemaSha256, serverAddress: target.serverAddress, serverPort: target.serverPort,
    username: "radar_console", service: "console" } as Parameters<typeof verifyPostgresServiceStartup>[0]["identity"];
  const input = { service: "console" as const, config, runtime, identity, releaseSha256: target.releaseSha256,
    deadline: new Date(Date.now() + 1000).toISOString() };
  const selection = { backend: "postgres" as const, phase: "postgres-selected" as const,
    protocolVersion: 2 as const, closureSha256: "a".repeat(64),
    target, cohortId: config.cohortId, evidenceMode: "production-observation" as const,
    firstPostgresWrite: null, mutableJournalVerified: false as const,
    writerStartupBlockers: ["FULL_MUTABLE_FAMILY_JOURNAL_NOT_VERIFIED"],
    writeAuthorized: false as const, activationEnabled: false as const };
  return { input, selection };
}

describe("root committed startup boundary", () => {
  it.each([1, "2", null, undefined])("refuses legacy or nonexact policy version %s before any committed-store work", async version => {
    const { input } = startupFixture();
    Reflect.set(input.config.cutover.expected, "version", version);
    expect(() => validatePostgresServiceDeployment(input.config)).toThrow("V1_AUDIT_ONLY_NO_POSTGRES_CAPABILITY");
    for (const service of ["console", "scanner"] as const) {
      await expect(verifyPostgresServiceStartup({ ...input, service })).rejects.toThrow("V1_AUDIT_ONLY_NO_POSTGRES_CAPABILITY");
    }
    expect(input.runtime.run).not.toHaveBeenCalled();
  });
  it.each([undefined, [], true, {}])("refuses absent or forged V2 closure trust without defaults", async trust => {
    const { input } = startupFixture();
    Reflect.set(input.config.cutover.expected, "closureTrust", trust);
    expect(() => validatePostgresServiceDeployment(input.config)).toThrow();
    await expect(verifyPostgresServiceStartup(input)).rejects.toThrow();
    expect(input.runtime.run).not.toHaveBeenCalled();
  });
  it.each(["version-missing", "v1", "string-version", "closure-missing", "closure-boolean", "closure-short", "closure-upper"])("rejects %s committed-result shortcuts", async fault => {
    const { input, selection } = startupFixture();
    if (fault === "version-missing") Reflect.deleteProperty(selection, "protocolVersion");
    if (fault === "v1") Reflect.set(selection, "protocolVersion", 1);
    if (fault === "string-version") Reflect.set(selection, "protocolVersion", "2");
    if (fault === "closure-missing") Reflect.deleteProperty(selection, "closureSha256");
    if (fault === "closure-boolean") Reflect.set(selection, "closureSha256", true);
    if (fault === "closure-short") Reflect.set(selection, "closureSha256", "a");
    if (fault === "closure-upper") Reflect.set(selection, "closureSha256", "A".repeat(64));
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresCutover")
      .mockResolvedValue(selection as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresCutover>>);
    try { await expect(verifyPostgresServiceStartup(input)).rejects.toThrow("V2_CLOSURE_REQUIRED"); }
    finally { spy.mockRestore(); }
  });
  it("never converts commit-unknown reconciliation into console readiness", async () => {
    const { input } = startupFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresCutover").mockRejectedValue(new Error("COMMIT_UNKNOWN_RECONCILE"));
    try { await expect(verifyPostgresServiceStartup(input)).rejects.toThrow("COMMIT_UNKNOWN_RECONCILE"); }
    finally { spy.mockRestore(); }
  });
  it("rejects an unknown console phase even when returned closure metadata looks valid", async () => {
    const { input, selection } = startupFixture();
    Reflect.set(selection, "phase", "commit-unknown");
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresCutover")
      .mockResolvedValue(selection as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresCutover>>);
    try { await expect(verifyPostgresServiceStartup(input)).rejects.toThrow("READ_ONLY_PHASE_REQUIRED"); }
    finally { spy.mockRestore(); }
  });
  it("uses the actual committed-selection verifier before allowing read-only console", async () => {
    const { input, selection } = startupFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresCutover")
      .mockResolvedValue(selection as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresCutover>>);
    try {
      expect(await verifyPostgresServiceStartup(input)).toBe(selection);
      expect(spy).toHaveBeenCalledTimes(1);
      const options = spy.mock.calls[0]![0];
      expect(options.runtime).toEqual({ target: input.config.cutover.expected.binding.target, cohortId: input.config.cohortId });
      expect(options.expected).toBe(input.config.cutover.expected);
      expect(input.runtime.run).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(["database", "schema", "generation", "schemaFingerprint", "serverAddress", "serverPort"])("rejects independently probed %s mismatch before selection", async field => {
    const { input } = startupFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresCutover");
    try {
      await expect(verifyPostgresServiceStartup({ ...input, identity: { ...input.identity, [field]: field === "serverPort" ? 5433 : "other" } })).rejects.toThrow("IDENTITY_REQUIRED");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(["release", "cohort", "generation", "fixture-evidence"])("refuses %s config shortcuts", async fault => {
    const { input } = startupFixture();
    if (fault === "release") input.releaseSha256 = "9".repeat(64);
    if (fault === "cohort") input.config = { ...input.config, cohortId: "other" };
    if (fault === "generation") input.config = { ...input.config, generationId: "other" };
    if (fault === "fixture-evidence") input.config = { ...input.config, cutover: { expected: { ...input.config.cutover.expected,
      evidenceMode: "injected-protocol-fixture" } } };
    await expect(verifyPostgresServiceStartup(input)).rejects.toThrow("IDENTITY_REQUIRED");
  });
  it("rejects unsigned or incomplete expectations using the real verifier", async () => {
    const { input } = startupFixture();
    await expect(verifyPostgresServiceStartup(input)).rejects.toThrow();
    expect(input.runtime.run).not.toHaveBeenCalled();
  });
  it.each(POSTGRES_BUSINESS_SERVICES.filter(service => service !== "console"))("never starts writer %s from postgres-selected", async service => {
    const { input, selection } = startupFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup")
      .mockResolvedValue(selection as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    try { await expect(verifyPostgresServiceStartup({ ...input, service })).rejects.toThrow("FIRST_WRITE_REQUIRED"); }
    finally { spy.mockRestore(); }
  });
  it("refuses written phase without a durable first-write marker", async () => {
    const { input, selection } = startupFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup").mockResolvedValue({ ...selection, phase: "postgres-written" } as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    try { await expect(verifyPostgresServiceStartup({ ...input, service: "scanner" })).rejects.toThrow("FIRST_WRITE_REQUIRED"); }
    finally { spy.mockRestore(); }
  });
  it("does not reinterpret selection writeAuthorized:false as worker permission", async () => {
    const { input, selection } = startupFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup").mockResolvedValue({ ...selection, phase: "postgres-written",
      firstPostgresWrite: { writeId: "bootstrap", receiptSha256: "4".repeat(64), providerGuardSha256: "5".repeat(64),
        deliveryGuardSha256: "6".repeat(64), recordedAt: new Date().toISOString() } } as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    try { await expect(verifyPostgresServiceStartup({ ...input, service: "scanner" })).rejects.toThrow("WRITER_STARTUP_REQUIRED"); }
    finally { spy.mockRestore(); }
  });
  it("rejects a real unsealed deployment before allocating a runtime or initializing source ports", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "radar-root-startup-")));
    const config = { ...fixture(), releaseRoot: root };
    const body = JSON.stringify(config), path = join(root, "deployment.json");
    writeFileSync(path, body, { mode: 0o600 });
    const env = { ADDRESS_RADAR_DATABASE_BACKEND: "postgresql", ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: "false",
      ADDRESS_RADAR_POSTGRES_URL: "postgresql://isolated:never-logged@127.0.0.1/fixture",
      ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE: path, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: createHash("sha256").update(body).digest("hex"),
      ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: "1".repeat(64), ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: "2".repeat(64),
      ADDRESS_RADAR_POSTGRES_STARTUP_MS: "2000", ADDRESS_RADAR_POSTGRES_POLL_MS: "1000", ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: "200", ADDRESS_RADAR_POSTGRES_KILL_MS: "200",
      ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: "0".repeat(32) };
    const createRuntime = vi.fn(), createFactPorts = vi.fn(), notify = vi.fn();
    await expect(runPostgresServiceEntrypoint("scanner", env, { createRuntime, createFactPorts, notify })).rejects.toThrow();
    expect(createRuntime).not.toHaveBeenCalled(); expect(createFactPorts).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it("already-aborted startup cannot initialize runtime, ports or emit readiness", async () => {
    const controller = new AbortController(); controller.abort(); const createRuntime = vi.fn(), createFactPorts = vi.fn(), notify = vi.fn();
    await expect(runPostgresServiceEntrypoint("scanner", { ADDRESS_RADAR_POSTGRES_STARTUP_MS: "1000", ADDRESS_RADAR_POSTGRES_POLL_MS: "1000",
      ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: "200", ADDRESS_RADAR_POSTGRES_KILL_MS: "200", ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: "0".repeat(32) },
      { createRuntime, createFactPorts, notify, stopSignal: controller.signal })).rejects.toThrow("ABORTED");
    expect(createRuntime).not.toHaveBeenCalled(); expect(createFactPorts).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
});

describe("verified compatible PostgreSQL writer startup", () => {
  function writerFixture() {
    const { input, selection } = startupFixture();
    return { input, capability: { ...selection, phase: "postgres-written",
      firstPostgresWrite: { writeId: "bootstrap", receiptSha256: "4".repeat(64), providerGuardSha256: "5".repeat(64),
        deliveryGuardSha256: "6".repeat(64), recordedAt: new Date().toISOString() },
      writerStartupBlockers: [], rollbackReadiness: { strategy: "compatible-postgres-release", recoveryMode: "retain-live-postgres-data",
        target: input.config.cutover.expected.binding.rollbackTarget, catalogSha256: "7".repeat(64), proofSha256: "8".repeat(64), mutableJournalVerified: false },
    } };
  }
  it.each(POSTGRES_BUSINESS_SERVICES.filter(service => service !== "console"))("requires dedicated verified writer capability for %s", async service => {
    const { input, capability } = writerFixture();
    const writer = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup").mockResolvedValue(capability as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    const selected = vi.spyOn(cutoverProof, "verifyCommittedPostgresCutover");
    try {
      expect(await verifyPostgresServiceStartup({ ...input, service })).toBe(capability);
      expect(writer).toHaveBeenCalledTimes(1); expect(selected).not.toHaveBeenCalled();
      expect(capability.mutableJournalVerified).toBe(false); expect(capability.writeAuthorized).toBe(false);
    } finally { writer.mockRestore(); selected.mockRestore(); }
  });
  it.each(["blocked", "wrong-release", "wrong-cluster", "wrong-cohort", "journal-boolean", "rewind", "missing-proof", "rollback-phase"])("rejects %s writer proof", async fault => {
    const { input, capability } = writerFixture();
    if (fault === "blocked") capability.writerStartupBlockers = ["UNKNOWN"] as never;
    if (fault === "wrong-release") capability.rollbackReadiness.target = { ...capability.rollbackReadiness.target, releaseSha256: "9".repeat(64) };
    if (fault === "wrong-cluster") capability.rollbackReadiness.target = { ...capability.rollbackReadiness.target, systemIdentifier: "999" };
    if (fault === "wrong-cohort") input.config = { ...input.config, cohortId: "other" };
    if (fault === "journal-boolean") capability.rollbackReadiness.mutableJournalVerified = true;
    if (fault === "rewind") capability.rollbackReadiness.recoveryMode = "source-rewind";
    if (fault === "missing-proof") capability.rollbackReadiness.proofSha256 = "";
    if (fault === "rollback-phase") capability.phase = "commit-unknown";
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup").mockResolvedValue(capability as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    try { await expect(verifyPostgresServiceStartup({ ...input, service: "scanner" })).rejects.toThrow(); }
    finally { spy.mockRestore(); }
  });
  it("binds compatible rollback startup to the actual sealed release and dedicated writer verifier", async () => {
    const { input, capability } = writerFixture();
    capability.phase = "postgres-rollback-selected";
    input.releaseSha256 = input.config.cutover.expected.binding.rollbackTarget.releaseSha256;
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup")
      .mockResolvedValue(capability as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    try {
      expect(await verifyPostgresServiceStartup({ ...input, service: "scanner" })).toBe(capability);
      expect(spy.mock.calls[0]![0].runtime.target).toEqual(input.config.cutover.expected.binding.rollbackTarget);
    } finally { spy.mockRestore(); }
  });
  it("refuses rollback-selected writer startup without its native first-write marker", async () => {
    const { input, capability } = writerFixture();
    capability.phase = "postgres-rollback-selected";
    Reflect.set(capability, "firstPostgresWrite", null);
    input.releaseSha256 = input.config.cutover.expected.binding.rollbackTarget.releaseSha256;
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup")
      .mockResolvedValue(capability as unknown as Awaited<ReturnType<typeof cutoverProof.verifyCommittedPostgresWriterStartup>>);
    try { await expect(verifyPostgresServiceStartup({ ...input, service: "scanner" })).rejects.toThrow("FIRST_WRITE_REQUIRED"); }
    finally { spy.mockRestore(); }
  });
  it("never acknowledges commit-unknown writer startup", async () => {
    const { input } = writerFixture();
    const spy = vi.spyOn(cutoverProof, "verifyCommittedPostgresWriterStartup").mockRejectedValue(new Error("COMMIT_UNKNOWN_RECONCILE"));
    try { await expect(verifyPostgresServiceStartup({ ...input, service: "scanner" })).rejects.toThrow("COMMIT_UNKNOWN_RECONCILE"); }
    finally { spy.mockRestore(); }
  });
});

describe("dedicated address-only committed startup", () => {
  function dedicatedFixture() {
    const legacy = fixture(), target = legacy.cutover.expected.binding.target;
    const manifest = { protocol: "address-only-v1" as const, operationId: legacy.operationId,
      importId: legacy.cohortId, generationId: legacy.generationId, activatedAt: legacy.activatedAt,
      planSha256: "a".repeat(64), seedSha256: "b".repeat(64), cohortSha256: "c".repeat(64),
      walletCount: 1, entityCount: 1, releaseSha256: target.releaseSha256,
      backupSha256: "d".repeat(64), fenceSha256: "e".repeat(64),
      target: { database: legacy.database, schema: legacy.schema, schemaFingerprint: target.schemaSha256,
        systemIdentifier: target.systemIdentifier, serverAddress: "127.0.0.1" as const, serverPort: 5432 as const },
      gatewayDeliveryEnabled: false as const, fomoEnabled: false as const, fullHistoricalMiningEnabled: false as const };
    const config = validatePostgresServiceDeployment({ ...legacy, cutover: { addressOnly: manifest } });
    const identity = { database: legacy.database, schema: legacy.schema, generation: legacy.generationId,
      schemaFingerprint: target.schemaSha256, serverAddress: "127.0.0.1", serverPort: 5432,
      service: "console", username: "radar_console" } as Parameters<typeof verifyPostgresServiceStartup>[0]["identity"];
    const evidence = { protocol: "address-only-native-startup-evidence-v1" as const, operationId: legacy.operationId,
      importId: legacy.cohortId, generationId: legacy.generationId, releaseSha256: manifest.releaseSha256,
      backupSha256: manifest.backupSha256, fenceSha256: manifest.fenceSha256,
      deploymentSha256: "a".repeat(64), safetyEnvironmentSha256: "b".repeat(64), measuredAt: manifest.activatedAt,
      sourceEpoch: [{path:"/var/lib/address-radar/address-radar.db",device:"1",inode:"2",size:"100",uid:"0",gid:"0",mode:"256",mtimeNs:"1",ctimeNs:"1"}],
      sourceSealed: true as const, importCommitted: true as const,
      gatewayDeliveryEnabled: false as const, fomoEnabled: false as const, fullHistoricalMiningEnabled: false as const };
    return { config, manifest, evidence, input: { service: "console" as const, config, identity,
      runtime: { run: vi.fn() } as unknown as Parameters<typeof verifyPostgresServiceStartup>[0]["runtime"],
      releaseSha256: manifest.releaseSha256, deadline: new Date(Date.now()+1000).toISOString(), addressOnlyEvidence: evidence } };
  }
  function waitingFixture() {
    const { config } = dedicatedFixture();
    return { ...config, sources: { mode: "waiting_configuration" }, composition: {
      principal: { actorId: "reviewed-actor", authorizationEvidenceRef: "reviewed-authority", permissions: ["target_registry_write"] as const },
      quotas: { normalization: 1, token: 1, purchase: 1, fanout: 1, opportunity: 1, capability: 1, signal: 1 },
      maximumClaims: 7, maximumRunMs: 500, admissionLimit: 1, leaseMs: 1000, retryDelayMs: 1000,
      maximumPayloadBytes: 1000, maximumSamples: 1, factLimit: 1, reconcileIntervalMs: 1000,
    } };
  }
  it.each(['configured', 'unconfigured', 'dual-authority', 'startup-refused', 'missing-native'] as const)(
    'runs actual scanner entry price dependency wiring: %s', async mode => {
      // Isolated startup/transport fixtures, not native approval, PostgreSQL or business acceptance evidence.
      const { config: base, evidence } = dedicatedFixture(), price = priceFixture();
      const config = { ...base, lifecycle: { ...base.lifecycle, pollMs: 5000 },
        composition: { ...base.composition, maximumSamples: 10, maximumPayloadBytes: 256000, maximumRunMs: 1000 },
        ...(mode !== 'unconfigured' ? { priceAcquisition: price.config.priceAcquisition! } : {}) };
      const database = await import('../../packages/database/src/index.js');
      const dispatch = await import('../../packages/database/src/postgres-service-dispatch.js');
      const startup = await import('../../apps/automation/src/postgres-address-only-startup.js');
      const composition = await import('../../apps/automation/src/postgres-production-composition.js');
      const authority = await import('../postgres-price-authority.js');
      const validatorModule = await import('../../apps/automation/src/postgres-independent-price-validator.js');
      const publisherModule = await import('../../apps/automation/src/postgres-price-fact-publisher.js');
      const order: string[] = [], controller = new AbortController(), output: any[] = [];
      const pin = price.config.priceAcquisition!.mappings[0]!, publicKey = rootFixturePublicKeys[0]!;
      const validator = { validatePrice: vi.fn(async () => ({ status: 'verified' as const, validation: {} as any })) };
      const publisher = { publish: vi.fn(async () => ({ status: 'published' as const, factIds: ['fixture-price-fact'] })) };
      const nativePriceAuthority = {
        validator: { generationId: config.generationId, activatedAt: config.activatedAt, validatorId: 'fixture-validator',
          keyId: 'fixture-key', publicKey, actorId: 'fixture-actor', authorizationRef: 'fixture-authorization',
          approval: { authorizePriceReplay: vi.fn() }, reviewedBindings: [{ ...pin,
            sourceProviderId: pin.providerId, sourceBaseUrl: price.config.priceAcquisition!.source.baseUrl,
            replayProviderId: 'fixture-replay', replayBaseUrl: 'https://replay.invalid/api/v2', timeframe: 'minute', aggregate: 1 }] },
        publisher: { target: { generationId: config.generationId }, mappings: [pin], validators: [{
          validatorId: 'fixture-validator', keyId: 'fixture-key', publicKey, actorId: 'fixture-actor',
          authorizationRef: 'fixture-authorization', reviewedSourceProviders: ['fixture-replay'] }] },
      } as any;
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('root-price-retry-samples')) return { rows: price.getRows(), rowCount: 1 };
        return { rows: [{ activated_at: config.activatedAt }], rowCount: 1 };
      });
      const notify = vi.fn(async (notice: { type: string }) => { order.push(notice.type); });
      const ports = { profiles: {}, facts: {}, fetch: price.fetch };
      const createFactPorts = vi.fn(async () => { order.push('ports'); return ports as any; });
      const runOnce = vi.fn(async () => ({ fixtureOnly: true })), close = vi.fn(async () => {});
      const mocks = [
        vi.spyOn(Date, 'now').mockReturnValue(200000),
        vi.spyOn(database, 'readPrivatePostgresDeployment').mockResolvedValue(config),
        vi.spyOn(dispatch, 'verifyPostgresServiceRelease').mockResolvedValue({ root: config.releaseRoot, releaseSha256: evidence.releaseSha256 }),
        vi.spyOn(startup, 'verifyAddressOnlyCommittedStartup').mockImplementation(async () => {
          order.push('fence'); if (mode === 'startup-refused') throw new Error('fixture-startup-refused'); return {} as any;
        }),
        vi.spyOn(composition, 'createPostgresProductionComposition').mockResolvedValue({ runOnce } as any),
        vi.spyOn(authority, 'composePostgresServicePriceDependencies'),
        vi.spyOn(validatorModule, 'createPostgresIndependentPriceValidator').mockImplementation(() => { order.push('validator'); return validator; }),
        vi.spyOn(publisherModule, 'createPostgresPriceFactPublisher').mockImplementation(async () => { order.push('native-probe'); return publisher; }),
        vi.spyOn(process.stdout, 'write').mockImplementation((text: any) => { output.push(JSON.parse(String(text))); controller.abort(); return true; }),
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ];
      try {
        const work = runPostgresServiceEntrypoint('scanner', {
          ADDRESS_RADAR_POSTGRES_STARTUP_MS: '2000', ADDRESS_RADAR_POSTGRES_POLL_MS: '5000',
          ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: '200', ADDRESS_RADAR_POSTGRES_KILL_MS: '200', ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: 'a'.repeat(32),
        }, { addressOnlyEvidence: evidence, notify, stopSignal: controller.signal, createFactPorts,
          createRuntime: (() => ({ probe: async () => ({}), close, run: async (fn: any) => fn({ query }) })) as any,
          ...(mode !== 'missing-native' ? { nativePriceAuthority } : {}),
          ...(mode === 'dual-authority' ? { priceAuthority: { validator, publisher } } : {}) });
        if (mode === 'configured' || mode === 'unconfigured') {
          await work;
          expect(output).toHaveLength(1); expect(runOnce).toHaveBeenCalledOnce();
          expect(order.indexOf('fence')).toBeLessThan(order.indexOf('ports'));
          expect(notify.mock.calls.map(([notice]) => notice.type)).toEqual(['postgres-service-ready', 'postgres-service-drained']);
          if (mode === 'configured') {
            expect(publisherModule.createPostgresPriceFactPublisher).toHaveBeenCalledOnce();
            expect(order.indexOf('fence')).toBeLessThan(order.indexOf('native-probe'));
            expect(order.indexOf('native-probe')).toBeLessThan(order.indexOf('postgres-service-ready'));
            expect(validator.validatePrice).toHaveBeenCalledOnce(); expect(publisher.publish).toHaveBeenCalledOnce();
            expect(price.fetch).toHaveBeenCalledTimes(2);
            expect(output[0].result.priceAcquisition).toMatchObject({ published: 1 });
            expect(authority.composePostgresServicePriceDependencies).toHaveBeenCalledWith(expect.objectContaining({ service: 'scanner', deployment: expect.objectContaining({ priceAcquisition: config.priceAcquisition }) }));
          } else {
            expect(validatorModule.createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
            expect(publisherModule.createPostgresPriceFactPublisher).not.toHaveBeenCalled();
            expect(price.fetch).not.toHaveBeenCalled(); expect(output[0].result).not.toHaveProperty('priceAcquisition');
          }
        } else {
          await expect(work).rejects.toThrow(mode === 'startup-refused' ? 'fixture-startup-refused'
            : mode === 'dual-authority' ? 'PRICE_AUTHORITY_DEPENDENCY_CONFLICT' : 'INDEPENDENT_PRICE_VALIDATOR_CLI_PORT_REQUIRED');
          expect(validatorModule.createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
          expect(publisherModule.createPostgresPriceFactPublisher).not.toHaveBeenCalled();
          expect(price.fetch).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled(); expect(runOnce).not.toHaveBeenCalled();
          if (mode === 'startup-refused') { expect(createFactPorts).not.toHaveBeenCalled(); expect(authority.composePostgresServicePriceDependencies).not.toHaveBeenCalled(); }
        }
        expect(close).toHaveBeenCalledOnce();
      } finally { for (const mock of mocks.reverse()) mock.mockRestore(); }
    });
  it("requires explicit dedicated waiting while omitting unused business configuration", () => {
    const config = waitingFixture();
    expect(validatePostgresServiceDeployment(config).sources.mode).toBe("waiting_configuration");
    expect(() => validatePostgresServiceDeployment({ ...fixture(), sources: config.sources })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config, sources: { ...config.sources, extra: true } })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config, sources: { mode: "unknown" } })).toThrow();
    const { wallet, composition, ...withoutBusiness } = config;
    expect(validatePostgresServiceDeployment(withoutBusiness).sources.mode).toBe("waiting_configuration");
    expect(() => validatePostgresServiceDeployment({ ...withoutBusiness, sources: {} })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config, sources: {}, composition: {} })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config, sources: {}, wallet: {} })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config, sources: undefined })).toThrow();
    expect(validatePostgresServiceDeployment(fixture()).sources).toEqual({});
  });
  it.each(POSTGRES_BUSINESS_SERVICES.filter(service => service !== "console"))(
    "keeps %s deferred without constructing sources or writing business SQL", async service => {
      const { wallet: _wallet, composition: _composition, ...config } = waitingFixture(); const { evidence } = dedicatedFixture();
      const database = await import("../../packages/database/src/index.js");
      const dispatch = await import("../../packages/database/src/postgres-service-dispatch.js");
      const startup = await import("../../apps/automation/src/postgres-address-only-startup.js");
      const controller = new AbortController();
      const query = vi.fn(async (_sql: string) => ({ rows: [{ activated_at: config.activatedAt }], rowCount: 1 }));
      const close = vi.fn(async () => {}), probe = vi.fn(async () => ({}));
      const createRuntime = vi.fn(() => ({ probe, close, run: async (operation: any) => operation({ query }) }));
      const createFactPorts = vi.fn(async () => { throw Error("provider constructed"); });
      const notify = vi.fn(async (_notice: { type: string }) => {});
      const mocks = [vi.spyOn(database, "readPrivatePostgresDeployment").mockResolvedValue(config),
        vi.spyOn(dispatch, "verifyPostgresServiceRelease").mockResolvedValue({ root: config.releaseRoot, releaseSha256: evidence.releaseSha256 }),
        vi.spyOn(startup, "verifyAddressOnlyCommittedStartup").mockResolvedValue({} as any)];
      const output = vi.spyOn(process.stdout, "write").mockImplementation((text: any) => {
        const report = JSON.parse(String(text));
        expect(report.result).toMatchObject({ status: "deferred", reasonCode: "sources_waiting_configuration", providerRequests: 0, monitoringCompleted: false });
        controller.abort(); return true;
      });
      try {
        await runPostgresServiceEntrypoint(service, { ADDRESS_RADAR_POSTGRES_STARTUP_MS: "2000", ADDRESS_RADAR_POSTGRES_POLL_MS: "1000",
          ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: "200", ADDRESS_RADAR_POSTGRES_KILL_MS: "200", ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: "a".repeat(32) },
        { createRuntime: createRuntime as any, createFactPorts, notify, stopSignal: controller.signal, addressOnlyEvidence: evidence });
        expect(createFactPorts).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(1);
        expect(String(query.mock.calls[0]?.[0] ?? "")).not.toMatch(/INSERT|UPDATE|DELETE|FOR UPDATE/i);
        expect(notify.mock.calls.map(call => (call[0] as any).type)).toEqual(["postgres-service-ready", "postgres-service-drained"]);
        expect(close).toHaveBeenCalledTimes(1);
      } finally { output.mockRestore(); for (const mock of mocks) mock.mockRestore(); }
    });
  it('uses service interval after settled work, not the 30s poll deadline as cadence',async()=>{
    const {config:base,evidence}=dedicatedFixture();
    const value={...base,lifecycle:{...base.lifecycle,pollMs:30_000},services:{...base.services,
      'wallet-monitor':{...base.services['wallet-monitor'],intervalMs:1000}}};
    const database=await import('../../packages/database/src/index.js');
    const dispatch=await import('../../packages/database/src/postgres-service-dispatch.js');
    const startup=await import('../../apps/automation/src/postgres-address-only-startup.js');
    const channel=await import('../../apps/wallet-monitor/src/postgres-wallet-channel.js');
    const walletConfig=await import('../../apps/wallet-monitor/src/config.js');
    const controller=new AbortController(),starts:number[]=[],logs:number[]=[];
    let active=0,maximumActive=0;
    vi.useFakeTimers();vi.setSystemTime(200_000);
    const mocks=[vi.spyOn(database,'readPrivatePostgresDeployment').mockResolvedValue(value),
      vi.spyOn(dispatch,'verifyPostgresServiceRelease').mockResolvedValue({root:value.releaseRoot,releaseSha256:evidence.releaseSha256}),
      vi.spyOn(startup,'verifyAddressOnlyCommittedStartup').mockResolvedValue({} as any),
      vi.spyOn(walletConfig,'loadWalletMonitorConfig').mockReturnValue({endpoints:{solana:{primary:'https://rpc.invalid'}},
        solanaRateLimitCooldownMs:30_000,solanaBatchSize:1,solanaSignatureLimit:1,evmBootstrapFloors:{}} as any),
      vi.spyOn(channel,'createPostgresWalletChannel').mockReturnValue({pollOnce:async()=>{
        starts.push(Date.now());maximumActive=Math.max(maximumActive,++active);
        await new Promise(resolve=>setTimeout(resolve,5000));active--;return {captured:0};
      }} as any),
      vi.spyOn(process.stdout,'write').mockImplementation(()=>{logs.push(Date.now());if(logs.length===2)controller.abort();return true;})];
    try{
      const work=runPostgresServiceEntrypoint('wallet-monitor',{
        ADDRESS_RADAR_POSTGRES_STARTUP_MS:'2000',ADDRESS_RADAR_POSTGRES_POLL_MS:'30000',
        ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS:'200',ADDRESS_RADAR_POSTGRES_KILL_MS:'200',ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE:'a'.repeat(32),
      },{addressOnlyEvidence:evidence,notify:async()=>{},stopSignal:controller.signal,
        createRuntime:(()=>({probe:async()=>({}),close:async()=>{},run:async(fn:any)=>fn({query:async()=>({rows:[{activated_at:value.activatedAt}]})})})) as any,
        createFactPorts:async()=>({profiles:{},facts:{},fetch:vi.fn()}) as any});
      await vi.advanceTimersByTimeAsync(0);expect(starts).toEqual([200_000]);
      await vi.advanceTimersByTimeAsync(5999);expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);expect(starts).toEqual([200_000,206_000]);
      await vi.advanceTimersByTimeAsync(5000);await work;
      expect(logs).toEqual([205_000,211_000]);expect(maximumActive).toBe(1);
    }finally{for(const mock of mocks)mock.mockRestore();vi.useRealTimers();}
  });

  it.each(['solana', 'bsc'] as const)('preserves %s poll diagnostics and binds only EVM range bootstrap registration', async chainName => {
    const { config, evidence } = dedicatedFixture();
    const database = await import('../../packages/database/src/index.js');
    const dispatch = await import('../../packages/database/src/postgres-service-dispatch.js');
    const startup = await import('../../apps/automation/src/postgres-address-only-startup.js');
    const channel = await import('../../apps/wallet-monitor/src/postgres-wallet-channel.js');
    const walletConfig = await import('../../apps/wallet-monitor/src/config.js');
    const collectorModule = await import('../../apps/wallet-monitor/src/collectors.js');
    const execution = executionFixture();
    const value = { ...config, walletExecution: { receiver: execution.receiver, evm: { bsc: {
      ...execution.evm!.eth!, providerId: 'approved-bsc', expectedChainId: '0x38', endpoint: 'https://rpc.example',
      stableQuoteTokens: [{ address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT' as const }],
    } } }, services: { ...config.services, 'wallet-monitor': { ...config.services['wallet-monitor'], intervalMs: 1 } } };
    let polls = 0;
    const diagnostic = { kind: 'collector_diagnostic', collector: 'evm:bsc', stage: 'collect', reasonCode: 'provider_unavailable' };
    const notify = vi.fn(async (_notice: { type: string }) => {}), close = vi.fn(async () => {});
    const mocks = [vi.spyOn(database, 'readPrivatePostgresDeployment').mockResolvedValue(value),
      vi.spyOn(dispatch, 'verifyPostgresServiceRelease').mockResolvedValue({ root: value.releaseRoot, releaseSha256: evidence.releaseSha256 }),
      vi.spyOn(startup, 'verifyAddressOnlyCommittedStartup').mockResolvedValue({} as any),
      vi.spyOn(walletConfig, 'loadWalletMonitorConfig').mockReturnValue({ endpoints: { [chainName]: { primary: 'https://rpc.example' } }, solanaRateLimitCooldownMs: 30000, solanaBatchSize: 10, solanaSignatureLimit: 17, evmBootstrapFloors: { bsc: 12345 } } as any),
      vi.spyOn(collectorModule, 'createSolanaWalletCollector'),
      vi.spyOn(channel, 'createPostgresWalletChannel').mockReturnValue({ pollOnce: async () => {
        if (++polls === 4) throw new Error('PostgreSQL business pending operation budget exhausted');
        return { captured: 0, diagnostics: [diagnostic], diagnosticsDropped: 0 };
      } } as any)];
    const output: string[] = [], errors: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((text: any) => { output.push(String(text)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((text: any) => { errors.push(String(text)); return true; });
    try {
      await expect(runPostgresServiceEntrypoint('wallet-monitor', {
        ADDRESS_RADAR_POSTGRES_STARTUP_MS: '2000', ADDRESS_RADAR_POSTGRES_POLL_MS: '1000',
        ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS: '200', ADDRESS_RADAR_POSTGRES_KILL_MS: '200', ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE: 'a'.repeat(32),
      }, { addressOnlyEvidence: evidence, notify,
        executionAuthority: { validator: { validateExecution: vi.fn() }, publisher: { publish: vi.fn() } },
        createRuntime: (() => ({ probe: async () => ({}), close, run: async (fn: any) => fn({ query: async () => ({ rows: [{ activated_at: value.activatedAt }] }) }) })) as any,
        createFactPorts: async () => ({ profiles: {}, facts: {}, fetch: globalThis.fetch }) as any,
      })).rejects.toThrow('pending operation budget exhausted');
      const registration = vi.mocked(channel.createPostgresWalletChannel).mock.calls[0]![0].collectors[0]!;
      expect(registration.collector.chainFamily).toBe(chainName === 'solana' ? 'solana' : 'evm');
      if (chainName === 'bsc') {
        expect(registration).toMatchObject({ bootstrap: { generation: value.generationId, fromBlock: 12345 }, executionTrust: 'rpc_execution' });
        expect(collectorModule.createSolanaWalletCollector).not.toHaveBeenCalled();
      } else {
        expect(registration).not.toHaveProperty('bootstrap');
        expect(collectorModule.createSolanaWalletCollector).toHaveBeenCalledWith(expect.objectContaining({
          activatedAt: value.activatedAt, signatureLimit: 17, batchSize: 10,
        }));
      }
      expect(output).toHaveLength(3);
      expect(JSON.parse(output[0]!).result.diagnostics).toEqual([diagnostic]);
      expect(errors.map(line => JSON.parse(line))).toContainEqual({ event: 'postgres_service_failure', service: 'wallet-monitor',
        phase: 'poll', reasonCode: 'pending_operation_budget_exhausted' });
      expect(notify.mock.calls.map(call => call[0].type)).toEqual(['postgres-service-ready']);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { out.mockRestore(); err.mockRestore(); for (const mock of mocks) mock.mockRestore(); }
  });
  it("generates approved resource allocations without synthesizing business configuration", async () => {
    const { createAddressOnlyWaitingDeployment } = await import("../create-address-only-waiting-deployment.js");
    const config = waitingFixture();
    const input = { manifest: config.cutover.addressOnly!, releaseRoot: config.releaseRoot, execution: config.execution,
      roles: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, config.services[service].username.replaceAll("-", "_")])) as any,
      intervalMs: 1000, lifecycle: { ...config.lifecycle, shutdownMs: 10000 }, wallet: config.wallet,
      composition: config.composition, console: config.console };
    const result = createAddressOnlyWaitingDeployment(input);
    expect(result.deployment.sources).toEqual({ mode: "waiting_configuration" });
    expect(result.deployment.driver).toMatchObject({ serverMaximumConnections: 16, reservedConnections: 3,
      maximumPendingOperations: 0, connectionTimeoutMs: 5000, idleTimeoutMs: 10000, statementTimeoutMs: 30000,
      lockTimeoutMs: 5000, idleTransactionTimeoutMs: 30000, shutdownTimeoutMs: 10000, workMemKb: 1024,
      serviceConnectionBudgets: { migration: 1, operator: 2, backup: 1 } });
    expect(result.resources).toMatchObject({ measurementMaximumAgeMs: 60000, unallocatedConnections: 3 });
    expect(result.acceptance.sourceMonitoring).toBe("waiting_configuration");
    expect(result.deployment.composition).toEqual(config.composition);
    const { wallet: _wallet, composition: _composition, lifecycle: _lifecycle, console: _console, ...minimalInput } = input;
    const minimal = createAddressOnlyWaitingDeployment(minimalInput);
    expect(minimal.deployment).not.toHaveProperty("wallet");
    expect(minimal.deployment).not.toHaveProperty("composition");
    expect(minimal.deployment.lifecycle).toEqual({ startupMs: 60000, pollMs: 15000, shutdownMs: 10000, killMs: 5000 });
    expect(minimal.deployment.console).toEqual({ host: "127.0.0.1", port: 3214, maximumTraceRows: 20 });
  });
  it("rejects simultaneous legacy and dedicated protocols", () => {
    const { config, manifest } = dedicatedFixture();
    expect(() => validatePostgresServiceDeployment({ ...config, cutover: { expected: fixture().cutover.expected, addressOnly: manifest } })).toThrow("Exactly one");
  });
  it("binds explicit compiled execution to the address-only deployment and environment", () => {
    const { config } = dedicatedFixture();
    const compiled = { ...config, executionFormat: "compiled-esm" };
    const env = { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "compiled-esm" };
    expect(validatePostgresServiceDeployment(compiled, env).executionFormat).toBe("compiled-esm");
    expect(() => validatePostgresServiceDeployment(compiled)).toThrow("execution format");
    expect(() => validatePostgresServiceDeployment(compiled, { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "tsx" })).toThrow();
    expect(() => validatePostgresServiceDeployment(config, env)).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...fixture(), executionFormat: "compiled-esm" }, env)).toThrow("address-only");
    expect(() => validatePostgresServiceDeployment({ ...config, executionFormat: "unknown" },
      { ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT: "unknown" })).toThrow();
    expect(validatePostgresServiceDeployment(fixture()).executionFormat).toBeUndefined();
  });
  it.each(["operationId", "importId", "generationId", "activatedAt"])("rejects manifest %s drift", key => {
    const { config, manifest } = dedicatedFixture();
    expect(() => validatePostgresServiceDeployment({ ...config, cutover: { addressOnly: { ...manifest, [key]: key === "activatedAt" ? manifest.activatedAt+1 : "other" } } })).toThrow();
  });
  it("cannot treat deployment expectations alone as startup authority", async () => {
    const { input } = dedicatedFixture();
    const { addressOnlyEvidence: _evidence, ...unmeasured } = input;
    await expect(verifyPostgresServiceStartup(unmeasured)).rejects.toThrow("NATIVE_STARTUP_REQUIRED");
    expect(input.runtime.run).not.toHaveBeenCalled();
  });
  it.each(POSTGRES_BUSINESS_SERVICES)("requires actual address-only committed verification for %s", async service => {
    const { input, manifest, evidence } = dedicatedFixture();
    const module = await import("../../apps/automation/src/postgres-address-only-startup.js");
    const selection = { protocol: "address-only-v1" as const, walletCount: 1, entityCount: 1,
      generationId: manifest.generationId, importId: manifest.importId, writeAuthorized: false as const, activationEnabled: false as const };
    const spy = vi.spyOn(module,"verifyAddressOnlyCommittedStartup").mockResolvedValue(selection);
    const legacy = vi.spyOn(cutoverProof,"verifyCommittedPostgresWriterStartup");
    try {
      expect(await verifyPostgresServiceStartup({ ...input, service })).toBe(selection);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ manifest, backupSha256: evidence.backupSha256,
        fenceSha256: evidence.fenceSha256, disabledFlags: evidence }));
      expect(legacy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); legacy.mockRestore(); }
  });
  it("propagates native ledger/parity refusal without readiness", async () => {
    const { input } = dedicatedFixture();
    const module = await import("../../apps/automation/src/postgres-address-only-startup.js");
    const spy = vi.spyOn(module,"verifyAddressOnlyCommittedStartup").mockRejectedValue(new Error("ledger_mismatch"));
    try { await expect(verifyPostgresServiceStartup(input)).rejects.toThrow("ledger_mismatch"); }
    finally { spy.mockRestore(); }
  });
});

it('classifies fatal reasons without exposing SQL, URLs, parameters or private errors', async () => {
  const { classifyPostgresServiceFailure } = await import('../postgres-service-entry.js');
  expect(classifyPostgresServiceFailure(new Error('PostgreSQL business pending operation budget exhausted'))).toBe('pending_operation_budget_exhausted');
  expect(classifyPostgresServiceFailure(new Error('POSTGRES_OPERATION_DEADLINE_EXCEEDED'))).toBe('operation_deadline_exceeded');
  expect(classifyPostgresServiceFailure(Object.assign(new Error('SELECT password FROM private; postgresql://secret'), { code: '42501' }))).toBe('pg_insufficient_privilege');
  expect(classifyPostgresServiceFailure(new Error('PRIVATE_DATABASE_DETAIL'))).toBe('unclassified_failure');
  expect(classifyPostgresServiceFailure({ code: 'SECRET', message: 'PRIVATE_DATABASE_DETAIL' })).toBe('unclassified_failure');
});

 describe('PG address-only EVM range collector assembly', () => {
  it('maps approved execution budgets and canonical decoder without granting authority', async () => {
    const entry = await import('../postgres-service-entry.js');
    const range = await import('../../apps/wallet-monitor/src/evm-transfer-range-collector.js');
    const canonical = await import('../../apps/wallet-monitor/src/collectors.js');
    const rpc = { request: vi.fn() } as any;
    const config = { generationId: "bound-bootstrap-generation", cutover: { addressOnly: {} }, wallet: { maximumRunMs: 12000, maximumPayloadBytes: 2097152 },
      walletExecution: { evm: { bsc: { maximumLogs: 64, maximumRpcRequests: 60,
        maximumPayloadBytes: 1048576, maximumRunMs: 5000 } } } } as any;
    const bootstrap = Object.freeze({ generation: config.generationId, fromBlock: 12345 });
    const spy = vi.spyOn(range, 'createEvmTransferRangeWalletCollector');
    try {
      expect(entry.createPostgresRootEvmWalletCollector(config, 'bsc', rpc, bootstrap).name).toBe('evm:bsc');
      expect(spy).toHaveBeenCalledWith({ chain: 'bsc', rpc, decodeReceipt: canonical.decodeEvmTransferRangeReceipt,
        maximumLogs: 64, maximumRequests: 60, maximumPayloadBytes: 1048576, maximumRunMs: 5000, rangeSize: 512,
        bootstrap });
      expect(spy.mock.calls[0]![0].bootstrap).toBe(bootstrap);
      expect(rpc.request).not.toHaveBeenCalled();
      config.wallet.maximumRunMs = 1000; config.wallet.maximumPayloadBytes = 4096;
      entry.createPostgresRootEvmWalletCollector(config, 'bsc', rpc, bootstrap);
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ maximumRunMs: 1000, maximumPayloadBytes: 4096 }));
      expect(() => entry.createPostgresRootEvmWalletCollector(config, 'base', rpc)).toThrow('EVM_RANGE_EXECUTION_BUDGET_REQUIRED');
      expect(() => entry.createPostgresRootEvmWalletCollector(config, 'robinhood', rpc)).toThrow('EVM_RANGE_UNSUPPORTED_CHAIN');
      expect(() => entry.createPostgresRootEvmWalletCollector(config, 'bsc', rpc)).toThrow('EVM_RANGE_BOOTSTRAP_FLOOR_REQUIRED');
      for (const fromBlock of [0, -1, NaN, 1.5]) {
        expect(() => entry.createPostgresRootEvmWalletCollector(config, 'bsc', rpc, { generation: config.generationId, fromBlock })).toThrow('EVM_RANGE_BOOTSTRAP_FLOOR_REQUIRED');
      }
      expect(() => entry.createPostgresRootEvmWalletCollector(config, 'bsc', rpc, { ...bootstrap, generation: 'other' })).toThrow('EVM_RANGE_BOOTSTRAP_FLOOR_REQUIRED');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(rpc.request).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('keeps legacy block discovery without requiring the new execution budget', async () => {
    const entry = await import('../postgres-service-entry.js');
    const canonical = await import('../../apps/wallet-monitor/src/collectors.js');
    const rpc = { request: vi.fn() } as any, spy = vi.spyOn(canonical, 'createEvmBlockWalletCollector');
    try {
      entry.createPostgresRootEvmWalletCollector({ cutover: { expected: {} } } as any, 'base', rpc);
      expect(spy).toHaveBeenCalledWith({ chain: 'base', rpc });
      expect(rpc.request).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

// Source wiring fixtures never assert that an execution signature is source authority.
import * as sourceEntry from "../postgres-service-entry.js";
import type { PostgresSourceFactRetryAuthority } from "../../apps/automation/src/postgres-source-fact-retry.js";
import type { PostgresRpcSourceFactCandidateRequest } from "../../apps/automation/src/postgres-rpc-source-fact-candidate.js";

function sourceWiringFixture() {
  const config = validatePostgresServiceDeployment({ ...fixture(),
    lifecycle: { ...fixture().lifecycle, pollMs: 2000 },
    sourceRetry: { maximumSamples: 2, maximumPayloadBytes: 10000, maximumRunMs: 1000 } });
  const order: string[] = [];
  let rows: Record<string, unknown>[] = [];
  const query = vi.fn(async () => { order.push("scan"); return { rows, rowCount: rows.length }; });
  const runtime = { run: async <T>(operation: (tx: PostgresTransaction) => Promise<T>) => operation({ query }) };
  const channel = { pollOnce: vi.fn(async (_signal: AbortSignal) => {
    order.push("wallet-settled"); return { captured: 0, attempted: 1, failed: 0 };
  }) };
  const reader = { load: vi.fn<PostgresSourceFactRetryAuthority["reader"]["load"]>(async () =>
    ({ status: "deferred", reasonCode: "execution_envelope_unavailable" })) };
  const receiver = { receive: vi.fn<PostgresSourceFactRetryAuthority["receiver"]["receive"]>(async () =>
    ({ status: "deferred", reasonCode: "source_validator_or_publisher_unavailable" })) };
  const authority = { reader, receiver };
  const create = (provided?: PostgresSourceFactRetryAuthority) => sourceEntry.createPostgresRootWalletSourcePoll({
    config, runtime, channel, now: () => 2000, ...(provided ? { authority: provided } : {}) });
  const sample = { sample_id: "sample-source", generation_id: config.generationId, entity_id: "entity-source", chain: "base",
    token_address: "token-source", execution_fingerprint: "a".repeat(64), original_fingerprint: "a".repeat(64),
    revision_state: "original", activated_at: 1000, occurred_at: 1500, recorded_at: 1500, created_at: 1500, source_recorded: false };
  return { config, order, query, runtime, channel, reader, receiver, authority, create, sample,
    setRows: (value: Record<string, unknown>[]) => { rows = value; } };
}

describe("root wallet committed-sample source retry wiring", () => {
  it("rejects source work that exceeds the shared poll budget", () => {
    expect(() => validatePostgresServiceDeployment({ ...fixture(),
      sourceRetry: { maximumSamples: 1, maximumPayloadBytes: 10000, maximumRunMs: 1 } })).toThrow();
  });
  it.each([
    { maximumSamples: 0, maximumPayloadBytes: 10000, maximumRunMs: 1000 },
    { maximumSamples: 1001, maximumPayloadBytes: 10000, maximumRunMs: 1000 },
    { maximumSamples: 1, maximumPayloadBytes: 10000001, maximumRunMs: 1000 },
    { maximumSamples: 1, maximumPayloadBytes: 10000, maximumRunMs: 0 },
    { maximumSamples: 1, maximumPayloadBytes: 10000, maximumRunMs: 1000, executionIsSourceAuthority: true },
  ])("requires exact explicit bounded source configuration %j", sourceRetry => {
    expect(() => validatePostgresServiceDeployment({ ...fixture(), lifecycle: { ...fixture().lifecycle, pollMs: 5000 }, sourceRetry })).toThrow();
  });
  it("preserves wallet accounting and explicitly defers with no authority and no SQL", async () => {
    const f = sourceWiringFixture();
    const result = await f.create()(new AbortController().signal);
    expect(result).toMatchObject({ captured: 0, attempted: 1, failed: 0,
      sourceRetry: { status: "deferred", reasonCode: "source_retry_authority_unavailable", scanned: 0, published: 0 } });
    expect(f.query).not.toHaveBeenCalled(); expect(f.reader.load).not.toHaveBeenCalled();
    expect(f.receiver.receive).not.toHaveBeenCalled();
  });
  it("does not invent source budgets from wallet or execution configuration", async () => {
    const f = sourceWiringFixture();
    const { sourceRetry: _sourceRetry, ...config } = f.config as typeof f.config & { sourceRetry: unknown };
    const poll = sourceEntry.createPostgresRootWalletSourcePoll({ config, runtime: f.runtime, channel: f.channel,
      authority: f.authority, now: () => 2000 });
    expect(await poll(new AbortController().signal)).toMatchObject({
      sourceRetry: { status: "deferred", reasonCode: "source_retry_not_configured", published: 0 } });
    expect(f.query).not.toHaveBeenCalled(); expect(f.reader.load).not.toHaveBeenCalled();
  });
  it("scans after settled capture even when zero captures, revisiting late commits", async () => {
    const f = sourceWiringFixture(), poll = f.create(f.authority), signal = new AbortController().signal;
    expect((await poll(signal)).sourceRetry.scanned).toBe(0);
    f.setRows([f.sample]);
    expect((await poll(signal)).sourceRetry).toMatchObject({ scanned: 1, attempted: 1, deferred: 1 });
    expect(f.order).toEqual(["wallet-settled", "scan", "wallet-settled", "scan"]);
    expect(f.reader.load).toHaveBeenCalledWith(expect.objectContaining({ generationId: f.config.generationId,
      sampleId: f.sample.sample_id, executionFingerprint: f.sample.execution_fingerprint }));
    expect(f.query.mock.calls[0]).toBeDefined(); expect(f.receiver.receive).not.toHaveBeenCalled();
  });
  it("does not scan while capture or its native commit remains pending", async () => {
    const f = sourceWiringFixture();
    let finish!: () => void;
    f.channel.pollOnce.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return { captured: 1, attempted: 1, failed: 0 };
    });
    const pending = f.create(f.authority)(new AbortController().signal);
    await Promise.resolve(); expect(f.query).not.toHaveBeenCalled();
    finish(); await pending; expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("does not scan after a failed capture commit or an aborted poll", async () => {
    const f = sourceWiringFixture();
    f.channel.pollOnce.mockRejectedValueOnce(new Error("synthetic commit failure"));
    await expect(f.create(f.authority)(new AbortController().signal)).rejects.toThrow("synthetic commit failure");
    const controller = new AbortController(); controller.abort();
    await expect(f.create(f.authority)(controller.signal)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it("recovers committed samples across a new root poller without a success cache", async () => {
    const f = sourceWiringFixture(); f.setRows([f.sample]);
    await f.create(f.authority)(new AbortController().signal);
    await f.create(f.authority)(new AbortController().signal);
    expect(f.reader.load).toHaveBeenCalledTimes(2); expect(f.receiver.receive).not.toHaveBeenCalled();
  });
  it.each([1900, 2000, 3000])("preserves original envelope and never renews expiresAt=%i", async expiresAt => {
    const f = sourceWiringFixture(); f.setRows([f.sample]);
    const original = { sampleId: f.sample.sample_id, executionFingerprint: f.sample.execution_fingerprint,
      execution: { generationId: f.config.generationId, originalRevision: "immutable-fixture" },
      validation: { claims: { expiresAt }, signature: "original-fixture-signature" } };
    f.reader.load.mockImplementation(async request => ({ status: "ready",
      request: { ...original, signal: request.signal } as unknown as PostgresRpcSourceFactCandidateRequest }));
    const result = await f.create(f.authority)(new AbortController().signal);
    expect(result.sourceRetry).toMatchObject({ published: 0, deferred: 1 });
    if (expiresAt <= 2000) expect(f.receiver.receive).not.toHaveBeenCalled();
    else expect(f.receiver.receive).toHaveBeenCalledWith({ ...original, signal: expect.any(AbortSignal) });
    expect(original.validation.claims.expiresAt).toBe(expiresAt);
  });
});

import { createPostgresIndependentExecutionValidator } from "../../apps/automation/src/postgres-independent-execution-validator.js";
import { createPostgresExecutionFactPublisher, executionValidationSigningPayload } from "../../apps/automation/src/postgres-execution-fact-publisher.js";
import { deriveExecutionBasis } from "../../apps/wallet-monitor/src/execution-basis.js";
import type { PostgresWalletProfile } from "../../apps/wallet-monitor/src/postgres-wallet-channel.js";
import { verify as verifyExecutionSignature } from "node:crypto";

async function rootSolanaProofFixture(finalized = true) {
  const wallet = "11111111111111111111111111111111", mint = "TokenCase", usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const profile: PostgresWalletProfile = { wallet: { address: wallet, accountId: "account", entityId: "entity", lifecycle: "active" },
    fact: { entityId: "entity", channel: "wallet", subjectId: wallet, walletFamily: "solana", associationConfidence: "confirmed",
      associationSource: "fixture", walletConfidence: "confirmed", walletSource: "fixture", ownerCount: 1,
      identityEvidenceRef: "fixture:identity", ownershipEvidenceRef: "fixture:owner", monitoringEnabled: true, suspended: false },
    profileEnabled: true, profileSuspended: false, bindingState: "owned", versionId: "version" };
  const config = validatePostgresServiceDeployment({ ...fixture(), walletExecution: {
    receiver: { maximumCandidates: 1, maximumRunMs: 1000, maximumPayloadBytes: 64000 },
    solana: { providerId: "source-rpc", expectedGenesisHash: "genesis", endpoint: "https://source.example/rpc",
      rateLimitCooldownMs: 1000, maximumProfiles: 10, maximumPayloadBytes: 64000, maximumRunMs: 1000 } } });
  const balance = (accountIndex: number, token: string, amount: number) => ({ accountIndex, mint: token, owner: wallet, uiTokenAmount: { uiAmount: amount } });
  const replies: Record<string, unknown> = { getGenesisHash: "genesis",
    getSignatureStatuses: { value: [{ slot: 5, err: null, confirmationStatus: finalized ? "finalized" : "confirmed" }] },
    getTransaction: { slot: 5, blockTime: 90, transaction: { signatures: ["signature"], message: { accountKeys: [wallet, "program"], instructions: [] } },
      meta: { err: null, fee: 5000, preBalances: [1000000000, 0], postBalances: [999995000, 0],
        preTokenBalances: [balance(1, mint, 0), balance(2, usdc, 100)], postTokenBalances: [balance(1, mint, 100), balance(2, usdc, 40)] } },
    getBlock: { blockhash: "canonical-block", blockTime: 90, signatures: ["signature"] } };
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: replies[request.method] }));
  });
  const profiles = { load: vi.fn(async () => ({ status: "ready" as const, profiles: [profile] })) }, keys = generateKeyPairSync("ed25519");
  const validator = createPostgresIndependentExecutionValidator({ generationId: config.generationId, activatedAt: config.activatedAt,
    validatorId: "independent-validator", keyId: "reviewed-key", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    signingKey: { loadPrivateKey: () => keys.privateKey }, reviewedProviderBindings: [{ chain: "solana", sourceProviderId: "source-rpc",
      sourceEndpoint: "https://source.example/rpc", replayProviderId: "replay-rpc", replayEndpoint: "https://independent.example/rpc", expectedGenesisHash: "genesis" }],
    fetch, profiles, maximumProfiles: 10, maximumRpcRequests: 20, maximumLogs: 100, maximumDecimalsReads: 4,
    maximumPayloadBytes: 64000, maximumRunMs: 1000, validationTtlMs: 60000, maximumNonces: 10,
    nonce: () => "root_unique_nonce_0123456789", now: () => 100000 });
  const inputs: Record<string, unknown>[] = [], attestations: Record<string, unknown>[] = [];
  const target = { database: config.database, schema: config.schema, username: "independent_publisher", serverAddress: "127.0.0.1",
    serverPort: 5432, generationId: config.generationId, schemaVersion: 3, schemaFingerprint: "b".repeat(64) };
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("execution-publisher-identity")) rows = [{ ...target, session_username: target.username, schema_generation: config.generationId,
      schema_version: target.schemaVersion, schema_fingerprint: target.schemaFingerprint, role_safe: true, consumer_member: false, objects_safe: true, can_publish: true }];
    else if (sql.includes("execution-publisher-validator")) rows = [{ valid_from: 0, valid_until: 200000, revoked_at: null, import_revoked_at: null }];
    else if (sql.includes("INSERT INTO wallet_service_fact_inputs")) inputs.push(JSON.parse(String(values[0])));
    else if (sql.includes("INSERT INTO wallet_service_fact_attestations")) {
      const row = JSON.parse(String(values[0])); attestations.push(row); rows = [{ fact_id: row.fact_id }];
    }
    return { rows, rowCount: rows.length };
  });
  const publisher = await createPostgresExecutionFactPublisher({ run: async operation => operation({ query }), target,
    forbiddenRoles: ["scanner", "automation", "wallet-monitor", "wallet-analysis", "historical-backfill", "console", "migrator"],
    validators: [{ validatorId: "independent-validator", keyId: "reviewed-key", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      actorId: "independent-actor", authorizationRef: "fixture:execution-only-approval", reviewedSourceProviders: ["replay-rpc"] }],
    maximumValidationAgeMs: 60000, maximumPayloadBytes: 64000, statementTimeoutMs: 1000, lockTimeoutMs: 500, now: () => 100000 });
  const receiver = createPostgresRootWalletExecutionReceiver({ config, ports: { profiles, fetch }, authority: { validator, publisher }, now: () => 100000 })!;
  const event = { eventId: "solana:signature:1", chain: "solana" as const, walletAddress: wallet, tokenAddress: mint,
    side: "buy" as const, occurredAt: 90000, amountUsd: 60, priceUsd: 0.6, marketCapUsd: null, sourceReference: "solana:signature",
    executionBasis: deriveExecutionBasis({ successful: true, swapConfirmed: true, tokenDeltas: [{ asset: mint, quantity: 100 }],
      quoteDeltas: [{ asset: usdc, symbol: "USDC", quantity: -60, verifiedStablecoin: true }] }) };
  const collector = { name: "solana", chainFamily: "solana" as const, collect: vi.fn() };
  return { config, receiver, event, profile, collector, fetch, inputs, attestations, keys };
}

describe("root real Solana execution proof gate and safe diagnostics", () => {
  it("passes nominal-stablecoin capture through real acquisition, independent replay, Ed25519 signing and publication", async () => {
    const f = await rootSolanaProofFixture();
    const result = await f.receiver.verifyPurchase({ generationId: f.config.generationId, event: f.event, profile: f.profile,
      collector: f.collector, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "verified", externalBasis: { verifierId: "independent-validator", generationId: f.config.generationId } });
    expect(f.inputs).toHaveLength(1); expect(f.attestations).toHaveLength(1);
    const payload = JSON.parse(String(f.inputs[0]!.payload));
    expect(verifyExecutionSignature(null, executionValidationSigningPayload(payload.validation.claims), f.keys.publicKey,
      Buffer.from(payload.validation.signature, "base64"))).toBe(true);
    expect(f.inputs[0]!.subject_key).toBe(createHash("sha256").update(JSON.stringify(["solana", f.profile.wallet.address, f.event.sourceReference, f.event.tokenAddress])).digest("hex"));
    expect(f.fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)).method)).toEqual([
      "getGenesisHash", "getSignatureStatuses", "getTransaction", "getBlock",
      "getGenesisHash", "getSignatureStatuses", "getTransaction", "getBlock" ]);
    expect(f.inputs[0]!.kind).toBe("execution"); expect(f.attestations[0]!.kind).toBe("execution");
  });
  it("retains the real finalized refusal in a safe entry diagnostic without relaxing the proof gate", async () => {
    const f = await rootSolanaProofFixture(false), log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const verify = sourceEntry.createPostgresRootWalletExecutionVerifier(f.receiver);
      expect(await verify({ generationId: f.config.generationId, event: f.event, profile: f.profile,
        collector: f.collector, signal: new AbortController().signal })).toEqual({ status: "deferred", reasonCode: "execution_not_finalized" });
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "postgres_wallet_execution_deferred", chain: "solana", reasonCode: "execution_not_finalized" }));
      expect(f.inputs).toHaveLength(0); expect(f.attestations).toHaveLength(0);
    } finally { log.mockRestore(); }
  });
  it("never logs an injected secret or unknown reason text, and preserves the original refusal", async () => {
    const f = await rootSolanaProofFixture(), reasonCode = "https://user:secret@private.example/rpc?token=secret";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const verify = sourceEntry.createPostgresRootWalletExecutionVerifier({ verifyPurchase: async () => ({ status: "deferred", reasonCode }) });
      expect(await verify({ generationId: f.config.generationId, event: f.event, profile: f.profile,
        collector: f.collector, signal: new AbortController().signal })).toEqual({ status: "deferred", reasonCode });
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/secret|private\.example|https:/);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "postgres_wallet_execution_deferred", chain: "solana", reasonCode: "execution_proof_unavailable" }));
    } finally { log.mockRestore(); }
  });
});

describe("explicit execution fact page budget configuration", () => {
  function budgetFixture() {
    const config = fixture();
    return { ...config, composition: { ...config.composition, maximumPayloadBytes: 2_097_152, factLimit: 32 },
      sources: { maximumExecutionFactPayloadBytes: 2_097_152, maximumFactResultBytes: 2_097_152 } };
  }
  it("accepts explicit publisher-sized fields without changing driver settings", () => {
    const config = budgetFixture(), driver = structuredClone(config.driver);
    expect(validatePostgresServiceDeployment(config).sources).toEqual(config.sources);
    expect(config.driver).toEqual(driver);
  });
  it.each([0,-1,1.5,2_097_153,"2097152",null,undefined])("rejects invalid execution envelope bound %s", value => {
    const config = budgetFixture();
    expect(() => validatePostgresServiceDeployment({ ...config,
      sources: { ...config.sources, maximumExecutionFactPayloadBytes: value } })).toThrow();
  });
  it.each([0,-1,1.5,2_097_153,"2097152",null,undefined])("rejects invalid total fact result bound %s", value => {
    const config = budgetFixture();
    expect(() => validatePostgresServiceDeployment({ ...config,
      sources: { ...config.sources, maximumFactResultBytes: value } })).toThrow();
  });
  it("requires paired explicit limits rather than an implicit total allowance", () => {
    const config = budgetFixture();
    expect(() => validatePostgresServiceDeployment({ ...config,
      sources: { maximumExecutionFactPayloadBytes: 2_097_152 } })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config,
      sources: { maximumFactResultBytes: 2_097_152 } })).toThrow();
  });
  it("rejects a total result allowance above the existing composition memory budget", () => {
    const config = budgetFixture();
    expect(() => validatePostgresServiceDeployment({ ...config,
      composition: { ...config.composition, maximumPayloadBytes: 1_048_576 } })).toThrow();
  });
  it("rejects a single envelope allowance above the explicit total page allowance", () => {
    const config = budgetFixture();
    expect(() => validatePostgresServiceDeployment({ ...config,
      sources: { ...config.sources, maximumFactResultBytes: 1_048_576 } })).toThrow();
  });
  it.each([0,1001,1.5])("retains a bounded SQL page row limit %s", factLimit => {
    const config = budgetFixture();
    expect(() => validatePostgresServiceDeployment({ ...config,
      composition: { ...config.composition, factLimit } })).toThrow();
  });
});

describe("closed acquisition diagnostic entry propagation", () => {
  it.each([
    "execution_rpc_provider_budget_unavailable", "execution_rpc_rate_limited", "execution_rpc_timed_out",
    "execution_rpc_response_error", "execution_rpc_aborted", "execution_rpc_transport_unavailable",
  ])("logs only the safe %s code without degrading it to generic proof missing", async reasonCode => {
    const { createPostgresRootWalletExecutionVerifier } = await import("../postgres-service-entry.js");
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    const result = { status: "deferred" as const, reasonCode };
    try {
      const verify = createPostgresRootWalletExecutionVerifier({ verifyPurchase: async () => result });
      expect(await verify({ generationId: "generation", event: { chain: "solana" } } as any)).toBe(result);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "postgres_wallet_execution_deferred", chain: "solana", reasonCode }));
      expect(Object.keys(JSON.parse(String(log.mock.calls[0]![0]))).sort()).toEqual(["chain","event","reasonCode"]);
    } finally { log.mockRestore(); }
  });
  it("does not allow a safe-code prefix to carry a provider message or URL", async () => {
    const { createPostgresRootWalletExecutionVerifier } = await import("../postgres-service-entry.js");
    const log = vi.spyOn(console,"error").mockImplementation(() => {});
    try {
      const reasonCode = "execution_rpc_response_error https://user:secret@private.example/?token=secret";
      const verify = createPostgresRootWalletExecutionVerifier({ verifyPurchase: async () => ({ status: "deferred",reasonCode }) });
      await verify({ generationId: "generation", event: { chain: "solana" } } as any);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "postgres_wallet_execution_deferred", chain: "solana", reasonCode: "execution_proof_unavailable" }));
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/secret|private|https:/);
    } finally { log.mockRestore(); }
  });
});

describe("explicit root execution retry wiring", () => {
  function retryConfig() {
    const base = fixture();
    return { ...base, lifecycle: { ...base.lifecycle,pollMs: 3000 },
      sources: { maximumFactAgeMs: 60_000, maximumFactPayloadBytes: 10_000 }, walletExecution: executionFixture(),
      executionRetry: { maximumCaptures: 1, maximumPayloadBytes: 10_000, maximumRunMs: 500 } };
  }
  it.each([
    { maximumCaptures: 11 }, { maximumCaptures: 0 }, { maximumPayloadBytes: 10_001 },
    { maximumRunMs: 501 }, { extra: true }, { maximumRunMs: 0 },
  ])("rejects execution retry outside the existing receiver allocation: %j", override => {
    const config = retryConfig();
    expect(() => validatePostgresServiceDeployment({ ...config,executionRetry: { ...config.executionRetry,...override } })).toThrow();
  });
  it("requires execution registry and the existing explicit fact age budget", () => {
    const config = retryConfig();
    expect(() => validatePostgresServiceDeployment({ ...config,walletExecution: undefined })).toThrow();
    expect(() => validatePostgresServiceDeployment({ ...config,sources: {} })).toThrow();
  });
  it("does not oversubscribe the wallet/source/execution poll time sum", () => {
    const config = retryConfig();
    expect(() => validatePostgresServiceDeployment({ ...config,lifecycle: { ...config.lifecycle,pollMs: 1500 },
      sourceRetry: { maximumSamples: 1,maximumPayloadBytes: 1000,maximumRunMs: 100 } })).toThrow();
  });
  it("runs recovery after the capture commit with the same injected receiver, without another pool or RPC port", async () => {
    const { createPostgresRootWalletSourcePoll } = await import("../postgres-service-entry.js");
    const config = validatePostgresServiceDeployment(retryConfig());
    let captured = false;
    const query = vi.fn(async () => { expect(captured).toBe(true); return { rows: [],rowCount: 0 }; });
    const receive = vi.fn();
    const poll = createPostgresRootWalletSourcePoll({ config, runtime: { run: async (operation: (tx: PostgresTransaction) => Promise<unknown>) => operation({ query }) },
      channel: { pollOnce: async () => { captured = true; return { captured: 0 }; } }, now: () => 2000,
      executionReceiver: { receive } } as any);
    const result = await poll(new AbortController().signal);
    expect(result).toMatchObject({ captured: 0, executionRetry: { status: "polled",scanned: 0 } });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(1,expect.stringContaining("execution-retry-scan-timeout"),expect.any(Array));
    expect(query).toHaveBeenNthCalledWith(2,expect.stringContaining("execution-retry-committed-captures"),expect.any(Array));
    expect(receive).not.toHaveBeenCalled();
  });
});

describe("root acquisition safe RPC detail diagnostics",()=>{
  it.each([
    [-32602,"Invalid params: https://private.example/?token=secret","invalid_params"],
    [-32601,"Method not found: secret","method_not_found"],
    [-32015,"Unsupported transaction version: secret","unsupported_transaction_version"],
    [-32000,"Invalid API key: secret","authentication_required"],
    [-32000,"Access denied: secret","permission_denied"],
  ])("logs actual configured RPC failure %s before receiver defer without publishing",async(code,message,subcategory)=>{
    const f=await rootSolanaProofFixture(),base=f.fetch.getMockImplementation()!,log=vi.spyOn(console,"error").mockImplementation(()=>{});
    f.fetch.mockImplementation(async(url,init)=>{
      const request=JSON.parse(String(init?.body));
      if(request.method==="getTransaction")return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,error:{code,message}}));
      return base(url,init);
    });
    try{
      const result=await f.receiver.verifyPurchase({generationId:f.config.generationId,event:f.event,profile:f.profile,collector:f.collector,signal:new AbortController().signal});
      expect(result).toEqual({status:"deferred",reasonCode:"execution_rpc_response_error"});
      expect(log).toHaveBeenCalledWith(JSON.stringify({event:"postgres_wallet_execution_rpc_failure",chain:"solana",method:"getTransaction",code,subcategory,reasonCode:"execution_rpc_response_error",purpose:"source"}));
      expect(log).toHaveBeenCalledTimes(code === -32015 ? 2 : 1);
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/secret|private|https:|signature|"params"/);
      const request=JSON.parse(String(f.fetch.mock.calls.at(-1)![1]?.body));
      expect(request.params).toEqual(["signature",{commitment:"finalized",encoding:"jsonParsed",maxSupportedTransactionVersion:1}]);
      expect(f.fetch).toHaveBeenCalledTimes(3);expect(f.inputs).toHaveLength(0);expect(f.attestations).toHaveLength(0);
    }finally{log.mockRestore();}
  });
  it("revalidates method/subcategory/reason and discards extra fields at the root log boundary",async()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{
      const emit=(sourceEntry as any).logPostgresRootExecutionRpcDiagnostic;
      expect(emit).toBeTypeOf("function");
      const good={method:"getBlock",code:-32602,subcategory:"invalid_params",reasonCode:"execution_rpc_response_error",message:"secret",endpoint:"https://private.example"};
      emit(good);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:"postgres_wallet_execution_rpc_failure",chain:"solana",method:"getBlock",code:-32602,subcategory:"invalid_params",reasonCode:"execution_rpc_response_error"}));
      for(const field of ["method","subcategory","reasonCode"])emit({...good,[field]:"secret https://private.example"});
      expect(log).toHaveBeenCalledTimes(1);
      emit({...good,code:Infinity});
      expect(JSON.parse(String(log.mock.calls.at(-1)![0])).code).toBeNull();
    }finally{log.mockRestore();}
  });
});

describe("root RPC diagnostic own-data snapshot fencing",()=>{
  const good={method:"getTransaction",code:-32602,subcategory:"invalid_params",reasonCode:"execution_rpc_response_error"};
  it.each(["method","code","subcategory","reasonCode"])("rejects a changing %s getter without executing it",field=>{
    const toJSON=vi.fn(()=>"secret"),getter=vi.fn().mockReturnValueOnce(good[field as keyof typeof good]).mockReturnValue({toJSON});
    const value={...good};Object.defineProperty(value,field,{get:getter});
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{sourceEntry.logPostgresRootExecutionRpcDiagnostic(value);expect(log).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();expect(toJSON).not.toHaveBeenCalled();}
    finally{log.mockRestore();}
  });
  it.each(["method","code","subcategory","reasonCode"])("rejects inherited %s even when its value is valid",field=>{
    const value:Record<string,unknown>={...good};delete value[field];Object.setPrototypeOf(value,{[field]:good[field as keyof typeof good]});
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{sourceEntry.logPostgresRootExecutionRpcDiagnostic(value);expect(log).not.toHaveBeenCalled();}finally{log.mockRestore();}
  });
  it("does not invoke an unknown subclass's inherited accessors or toJSON hooks",()=>{
    const getter=vi.fn(()=>"secret"),toJSON=vi.fn(()=>"secret");
    class UnknownDiagnostic { toJSON=toJSON; get method(){return getter();} }
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{
      sourceEntry.logPostgresRootExecutionRpcDiagnostic(Object.assign(new UnknownDiagnostic(),{code:-32602,subcategory:"invalid_params",reasonCode:"execution_rpc_response_error"}));
      expect(log).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();expect(toJSON).not.toHaveBeenCalled();
      sourceEntry.logPostgresRootExecutionRpcDiagnostic({...good,toJSON});
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:"postgres_wallet_execution_rpc_failure",chain:"solana",...good}));
      expect(toJSON).not.toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
});

describe("bounded source/replay RPC diagnostic metadata",()=>{
  const detail={method:"getGenesisHash",code:null,subcategory:"provider_budget_unavailable",reasonCode:"execution_rpc_provider_budget_unavailable",purpose:"replay",budgetReason:"cooldown",transport:"local"};
  it("logs closed optional fields only",()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{sourceEntry.logPostgresRootExecutionRpcDiagnostic({...detail,message:"secret"});
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject(detail);expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    }finally{log.mockRestore();}
  });
  it.each(["purpose","budgetReason","transport"])("rejects optional %s getters, inheritance and unknown values",field=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{}),getter=vi.fn(()=>"secret");
    try{
      const value={...detail};Object.defineProperty(value,field,{get:getter});sourceEntry.logPostgresRootExecutionRpcDiagnostic(value);
      const inherited:Record<string,unknown>={...detail};delete inherited[field];Object.setPrototypeOf(inherited,{[field]:"secret"});sourceEntry.logPostgresRootExecutionRpcDiagnostic(inherited);
      sourceEntry.logPostgresRootExecutionRpcDiagnostic({...detail,[field]:"secret"});
      expect(log).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
    }finally{log.mockRestore();}
  });
  it("deduplicates and caps runtime logs without invoking raw object hooks",()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{
      const emit=sourceEntry.createPostgresRootExecutionRpcDiagnosticLogger();
      for(let i=0;i<100;i++)emit(detail);
      expect(log).toHaveBeenCalledTimes(1);
    }finally{log.mockRestore();}
  });
});

it("caps unique runtime RPC diagnostics at 32 per minute",()=>{
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  try{const emit=sourceEntry.createPostgresRootExecutionRpcDiagnosticLogger();
    for(let code=0;code<100;code++)emit({method:"getSignaturesForAddress",code,subcategory:"unknown_failure",reasonCode:"execution_rpc_transport_unavailable",purpose:"source",transport:"unknown"});
    expect(log).toHaveBeenCalledTimes(32);
  }finally{log.mockRestore();}
});

it("adds trusted observer purpose without spreading an untrusted diagnostic",()=>{
  const getter=vi.fn(()=>"secret"),log=vi.spyOn(console,"error").mockImplementation(()=>{});
  const diagnostic={method:"getTransaction",code:null,subcategory:"unknown_failure",reasonCode:"execution_rpc_transport_unavailable"};
  Object.defineProperty(diagnostic,"private",{enumerable:true,get:getter});
  try{sourceEntry.createPostgresRootExecutionRpcDiagnosticLogger()(diagnostic,"source");
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).purpose).toBe("source");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  }finally{log.mockRestore();}
});

// Explicit reported protocol fixtures are synthetic, not native source/approval proof.
function reportedEntryFixture() {
  const base=fixture(), hash='a'.repeat(64), candle=priceConfiguration();
  const manifest={protocol:'address-only-v1',operationId:base.operationId,importId:base.cohortId,generationId:base.generationId,activatedAt:base.activatedAt,
    planSha256:hash,seedSha256:hash,cohortSha256:hash,walletCount:1,entityCount:1,releaseSha256:hash,backupSha256:hash,fenceSha256:hash,
    target:{database:base.database,schema:base.schema,schemaFingerprint:hash,systemIdentifier:'123',serverAddress:'127.0.0.1',serverPort:5432},
    gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false};
  const price={protocol:'approved_reported_market_cap_v1',approval:{path:'/private/reported-approval.json',sha256:hash},
    source:{providerId:'approved-ave',baseUrl:'https://prod.ave-api.com',sourceApprovalRef:'approval:reported',maximumRunMs:1000,
      maximumPayloadBytes:64000,maximumWindowMs:120000,maximumMappingAgeMs:200000},receiver:candle.receiver,retry:candle.retry,
    mappings:[{...candle.mappings[0]!,providerId:'approved-ave',sourceApprovalRef:'approval:reported',sourceProofKind:'approved_reported_market_cap_v1',candleMs:0,
      quoteAddress:'1'.repeat(31)+'4',mapping:{...candle.mappings[0]!.mapping,tokenAddress:'1'.repeat(31)+'2',poolAddress:'1'.repeat(31)+'3'}}]};
  return {...base,cutover:{addressOnly:manifest},lifecycle:{...base.lifecycle,pollMs:5000},
    composition:{...base.composition,maximumSamples:10,maximumPayloadBytes:256000,maximumRunMs:1000},priceAcquisition:price};
}
describe('explicit reported entry protocol',()=>{
  it('accepts a dedicated reported configuration without invented candle fields',()=>{
    const config=validatePostgresServiceDeployment(reportedEntryFixture());
    expect(config.priceAcquisition?.protocol).toBe('approved_reported_market_cap_v1');
    expect(config.priceAcquisition?.source).not.toHaveProperty('timeframe');
    expect(validatePostgresServiceDeployment(fixture()).priceAcquisition).toBeUndefined();
  });
  it.each(['unknown','missing-pin','relative-pin','dot-parent','candle-authority','missing-quote','mixed-source','candle-fields','legacy','empty-mappings'])(
    'refuses %s before creating any source',fault=>{
      const config=reportedEntryFixture(),p=config.priceAcquisition;
      if(fault==='unknown')p.protocol='unknown';
      if(fault==='missing-pin')Reflect.deleteProperty(p,'approval');
      if(fault==='relative-pin')p.approval.path='approval.json';
      if(fault==='dot-parent')p.approval.path='/private/../approval.json';
      if(fault==='candle-authority')p.mappings[0]!.sourceProofKind='independent-candle-replay';
      if(fault==='missing-quote')Reflect.deleteProperty(p.mappings[0]!,'quoteAddress');
      if(fault==='mixed-source')p.mappings[0]!.sourceApprovalRef='other';
      if(fault==='candle-fields')Object.assign(p.source,{timeframe:'minute'});
      if(fault==='legacy')Object.assign(config,{cutover:fixture().cutover});
      if(fault==='empty-mappings')p.mappings=[];
      expect(()=>validatePostgresServiceDeployment(config)).toThrow();
    });
  it.each([false,true])('uses only the explicit guarded reported client; clientPresent=%s',async present=>{
    const config=validatePostgresServiceDeployment(reportedEntryFixture()),pin=config.priceAcquisition!.mappings[0]!;
    const query=vi.fn(async()=>({rows:[{sample_id:'sample',generation_id:config.generationId,execution_fingerprint:'a'.repeat(64),
      original_fingerprint:'a'.repeat(64),revision_state:'original',activated_at:1000,chain:'solana',token_address:pin.mapping.tokenAddress,
      occurred_at:'90000',expires_at:'300000',created_at:'100000'}],rowCount:1}));
    const fetch=vi.fn(), tokenDetail=vi.fn(async()=>({status:'candidate' as const,verified:false as const,independence:'unverified' as const,
      identity:{chain:'solana',token:pin.mapping.tokenAddress,pool:pin.mapping.poolAddress,quote:'1'.repeat(31)+'4'},
      reportedMarketCap:100000,reportedFdv:900000,reportedTvl:null,reportedUpdatedAt:150,circulatingMarketCapVerified:false as const,amm:null}));
    const retry=createPostgresRootPriceRetry({config,runtime:{run:async op=>op({query})},ports:{fetch,...(present?{reportedMarketCapClient:{tokenDetail}}:{})},
      now:()=>200000,pending:new Set(),onTimeout:()=>{}})!;
    const result=await retry.pollOnce(new AbortController().signal);
    expect(fetch).not.toHaveBeenCalled();expect(tokenDetail).toHaveBeenCalledTimes(present?1:0);
    expect(result.published).toBe(0);
    expect(JSON.stringify(result)).toContain(present?'independent_price_validator_or_publisher_unavailable':'reported_price_provider_credentials_or_budget_unavailable');
  });
});


describe("native RPC diagnostic sink contract",()=>{
  const detail={chain:"base",providerId:"approved-base",method:"eth_getLogs",code:-32602,httpStatus:200,retryAt:160000,
    subcategory:"invalid_params",reasonCode:"execution_rpc_response_error",purpose:"source",transport:"rpc"};
  it("retains separate status/code and native identity while dropping raw material",()=>{
    const sink=vi.fn();sourceEntry.logPostgresRootExecutionRpcDiagnostic({...detail,endpoint:"https://private?key=secret",params:["private"]},sink);
    expect(sink).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:"postgres_wallet_execution_rpc_failure",chain:"base",method:"eth_getLogs",code:-32602,
      subcategory:"invalid_params",reasonCode:"execution_rpc_response_error",purpose:"source",transport:"rpc",providerId:"approved-base",httpStatus:200,retryAt:160000}));
  });
  it.each(["chain","providerId","httpStatus","retryAt"])("rejects accessor/inherited %s without executing it",field=>{
    const sink=vi.fn(),getter=vi.fn(()=>"private"),value={...detail};Object.defineProperty(value,field,{get:getter});
    sourceEntry.logPostgresRootExecutionRpcDiagnostic(value,sink);
    const inherited:Record<string,unknown>={...detail};delete inherited[field];Object.setPrototypeOf(inherited,{[field]:detail[field as keyof typeof detail]});
    sourceEntry.logPostgresRootExecutionRpcDiagnostic(inherited,sink);expect(sink).not.toHaveBeenCalled();expect(getter).not.toHaveBeenCalled();
  });
  it.each([{httpStatus:600},{retryAt:-1},{providerId:"https://private?key=secret"},{chain:"other"},{chain:"solana"}])("rejects invalid native metadata %j",override=>{
    const sink=vi.fn();sourceEntry.logPostgresRootExecutionRpcDiagnostic({...detail,...override},sink);expect(sink).not.toHaveBeenCalled();
  });
  it("rejects proxies and isolates sink exceptions",()=>{
    const trap=vi.fn(),sink=vi.fn();sourceEntry.logPostgresRootExecutionRpcDiagnostic(new Proxy(detail,{getOwnPropertyDescriptor:trap,get:trap}),sink);
    expect(trap).not.toHaveBeenCalled();expect(sink).not.toHaveBeenCalled();
    expect(()=>sourceEntry.logPostgresRootExecutionRpcDiagnostic(detail,()=>{throw new Error("sink");})).not.toThrow();
  });
});

it("runs offline loopback source and reviewed replay through real durable adapters and root sink",async()=>{
  const {createServer}=await import("node:http"),{createPostgresServiceFactAdapters}=await import("../../apps/automation/src/postgres-service-fact-adapters.js");
  const server=createServer((request,response)=>{request.resume();response.writeHead(request.url==="/replay"?403:429,{"Retry-After":"1"});response.end("private body key=secret");});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const log=vi.spyOn(console,"error").mockImplementation(()=>{});
  try {
    const address=server.address();if(!address||typeof address==="string")throw new Error("Expected loopback address");
    const endpoint="http://127.0.0.1:"+address.port,queries:string[]=[];
    const runtime={probe:async()=>({generation:"generation",service:"wallet-monitor"}),run:async(operation:any)=>operation({query:async(sql:string)=>{
      queries.push(sql);return {rows:sql.includes("service-provider-budget-lock")?[{provider_id:"approved-provider",window_started_at:90000,window_ms:60000,
        maximum_requests:60,requests_used:0,maximum_concurrency:1,active_leases:0,cooldown_until:0}]
        :sql.includes("service-provider-budget-debit")?[{provider_id:"approved-provider"}]:sql.includes("service-provider-cooldown")?[{cooldown_until:101000}]:[],rowCount:1};}})};
    const config={sources:{},walletExecution:{solana:{providerId:"approved-provider",endpoint:endpoint+"/solana"},evm:{base:{providerId:"approved-provider",endpoint:endpoint+"/base"}}}} as any;
    const contexts=sourceEntry.postgresRootSourceRpcDiagnosticContexts(config);
    expect(contexts.map(context=>context.chain)).toEqual(["solana","base"]);
    const ports=await createPostgresServiceFactAdapters({runtime:runtime as any,generationId:"generation",maximumProfiles:1,now:()=>100000,
      sources:{leaseMs:5000,maximumProfileAgeMs:60000,maximumFactAgeMs:60000,maximumSafetyAgeMs:10000,providerTimeoutMs:2000,maximumResponseBytes:1000,maximumFactPayloadBytes:20000},
      sourceRpcContexts:contexts,onSourceRpcDiagnostic:sourceEntry.createPostgresRootExecutionRpcDiagnosticLogger()});
    for(const [path,method] of [["/solana","getTransaction"],["/base","eth_getLogs"]]) {
      expect((await ports.fetch(endpoint+path,{method:"POST",body:JSON.stringify({method,params:["private"]})})).status).toBe(429);
    }
    const replay=sourceEntry.postgresRootReplayRpcDiagnosticFetch({reviewedProviderBindings:[{chain:"base",replayProviderId:"approved-provider",replayEndpoint:endpoint+"/replay"}]} as any,ports);
    expect((await replay(endpoint+"/replay",{method:"POST",body:JSON.stringify({method:"eth_getTransactionReceipt",params:["private"]})})).status).toBe(403);
    const diagnostics=log.mock.calls.map(call=>JSON.parse(String(call[0])));
    expect(diagnostics).toMatchObject([{chain:"solana",providerId:"approved-provider",httpStatus:429,purpose:"source"},
      {chain:"base",providerId:"approved-provider",httpStatus:429,purpose:"source"},{chain:"base",providerId:"approved-provider",httpStatus:403,purpose:"replay"}]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/127\.0\.0\.1|private|secret|params/);
    expect(queries.filter(sql=>sql.includes("service-provider-budget-debit"))).toHaveLength(3);
    expect(queries.filter(sql=>sql.includes("service-provider-release"))).toHaveLength(3);
    expect(queries.filter(sql=>sql.includes("service-provider-cooldown"))).toHaveLength(2);
  } finally {log.mockRestore();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
