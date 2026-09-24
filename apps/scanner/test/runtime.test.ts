import { afterEach, describe, expect, it, vi } from "vitest";

import { openAddressRadarRepository, type AddressRadarRepository } from "@address-radar/database";
import { createScannerRuntime } from "../src/runtime.js";

describe("scanner runtime", () => {
  let repository: AddressRadarRepository | undefined;
  afterEach(() => { repository?.close(); repository = undefined; });
  const ability = (entityId: string) => ({ snapshotId: `ability-${entityId}`, entityId, window: "30d" as const, asOf: 1, strategyVersion: "address-v1", rawQuality: 0.9, adjustedQuality: 0.8, sampleConfidence: 0.85, coverageConfidence: 1, metrics: {}, components: {}, styles: { HIGH_MULTIPLE: 0.9 }, createdAt: 1 });

  it("injects collectors and sink while applying chain, token, and purchase filters", async () => {
    repository = openAddressRadarRepository(":memory:");
    for (const [index, eventId] of ["accepted-a", "accepted-b", "small", "blocked-chain"].entries()) {
      const accountId = `account-${index}`;
      const entityId = `entity-${index}`;
      repository.upsertFomoAccount({ accountId, handle: `trader-${index}`, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId, lifecycle: "elite", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
      repository.upsertTraderSignalProfile({ entityId, monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: true, updatedAt: 1 });
      repository.insertTraderEvent({ eventId, accountId, entityId, chain: index === 3 ? "base" : "solana", tokenAddress: "TokenA", side: "buy", amountUsd: index === 2 ? 10 : 1_000, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: 60_000, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    }
    const accepted = vi.fn();
    const runtime = createScannerRuntime({
      repository,
      collectors: [{
        collect: async () => [
          { chain: "solana", tokenAddress: "TokenA", evidence: { eventId: "accepted-a", entityId: "entity-0", contribution: 0.8, occurredAt: 1_000, side: "buy", amountUsd: 1_000, lifecycleStage: "launched_0_2h", traderTags: ["EARLY_LAUNCH"] } },
          { chain: "solana", tokenAddress: "TokenA", evidence: { eventId: "accepted-b", entityId: "entity-1", contribution: 0.8, occurredAt: 1_001, side: "buy", amountUsd: 1_000, lifecycleStage: "launched_0_2h", traderTags: ["HIGH_MULTIPLE"] } },
          { chain: "solana", tokenAddress: "TokenA", evidence: { eventId: "small", entityId: "entity-2", contribution: 0.9, occurredAt: 1_002, side: "buy", amountUsd: 10, lifecycleStage: "launched_0_2h" } },
          { chain: "base", tokenAddress: "TokenA", evidence: { eventId: "blocked-chain", entityId: "entity-3", contribution: 0.9, occurredAt: 1_003, side: "buy", amountUsd: 1_000, lifecycleStage: "launched_0_2h" } },
        ],
      }],
      signalSink: { accept: accepted },
      clock: { now: () => 3_000 },
      config: {
        strategyVersion: "address-v1",
        signalThreshold: 0.7,
        minimumPurchaseUsd: 100,
        minimumAggregateBuyUsd: 100,
        allowedChains: ["solana"],
        excludedTokenIds: [],
      },
    });

    const result = await runtime.runOnce();

    expect(result).toMatchObject({ collected: 4, accepted: 2, rejected: 2, candidateCount: 1 });
    expect(accepted).toHaveBeenCalledWith([expect.objectContaining({ signalId: "solana:TokenA", broadcastSequence: 1 })]);
  });

  it("isolates failed providers and persists runtime quality", async () => {
    repository = openAddressRadarRepository(":memory:");
    const accountId = "account-active";
    const entityId = "entity-active";
    repository.upsertFomoAccount({ accountId, handle: "active", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId, lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
    repository.upsertTraderSignalProfile({ entityId, monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: true, updatedAt: 1 });
    repository.saveTraderAbilitySnapshot(ability(entityId));
    const runtime = createScannerRuntime({
      repository,
      collectors: [
        { name: "fomo", collect: async () => ({ observations: [{ event: { eventId: "event-a", accountId, entityId, chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 1_000, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" } }], status: "ready", queueOldestAt: 900, registryVersion: 4 }) },
        { name: "onchain", collect: async () => { throw new Error("provider down"); } },
      ],
      signalSink: { accept: vi.fn() },
      clock: { now: () => 3_000 },
      lifecycleResolver: { resolve: async () => "launched_0_2h" },
      marketProvider: { lookup: async () => ({ chain: "solana", tokenAddress: "TokenA", symbol: "TOK", name: "Token", imageUrl: null, priceUsd: 0.01, marketCapUsd: 100_000, liquidityUsd: 50_000, createdAt: 1, launchedAt: 1, observedAt: new Date(3_000).toISOString() }) },
      config: { strategyVersion: "address-v1", signalThreshold: 0.7, minimumPurchaseUsd: 100, minimumAggregateBuyUsd: 100, allowedChains: ["solana"], excludedTokenIds: [] },
    });
    expect(await runtime.runOnce()).toMatchObject({ collected: 1, accepted: 1, collectorFailures: 1 });
    expect(repository.latestRuntimeQualitySnapshot()).toMatchObject({
      registryVersion: 4,
      providerStatuses: { fomo: "ready", onchain: "unavailable", market: "ready" },
      queueLagMs: 2_100,
      aggregationLagMs: 0,
      status: "unavailable",
    });
  });

  it("does not synthesize quality or style tags without an ability snapshot", async () => {
    repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "a", handle: "a", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "e", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "a", entityId: "e", confidence: "confirmed", source: "test", observedAt: 1 });
    repository.upsertTraderSignalProfile({ entityId: "e", monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: true, updatedAt: 1 });
    const runtime = createScannerRuntime({ repository, collectors: [{ collect: async () => ({ observations: [{ event: { eventId: "event", accountId: "a", entityId: "e", chain: "solana", tokenAddress: "Token", side: "buy", amountUsd: 1_000, priceUsd: null, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" } }], status: "ready" }) }], signalSink: { accept: vi.fn() }, clock: { now: () => 2_000 }, lifecycleResolver: { resolve: async () => "launched_0_2h" }, config: { strategyVersion: "address-v1", signalThreshold: 0.7, minimumPurchaseUsd: 0, minimumAggregateBuyUsd: 0, allowedChains: ["solana"], excludedTokenIds: [] } });
    await runtime.runOnce();
    expect(repository.addressSignalEvidenceForToken("solana", "Token", 0)).toEqual([expect.objectContaining({ contribution: 0, traderTags: [] })]);
  });

  it("degrades a failing lifecycle token, continues unrelated tokens, and leaves the batch uncommitted", async () => {
    repository = openAddressRadarRepository(":memory:");
    for (const id of ["a", "b"]) {
      repository.upsertFomoAccount({ accountId: id, handle: id, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId: id, lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId: id, entityId: id, confidence: "confirmed", source: "test", observedAt: 1 });
      repository.saveTraderAbilitySnapshot(ability(id));
    }
    const commit = vi.fn();
    const event = (id: string, tokenAddress: string) => ({ eventId: id, accountId: id, entityId: id, chain: "solana", tokenAddress, side: "buy" as const, amountUsd: 1_000, priceUsd: null, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" as const });
    const runtime = createScannerRuntime({ repository, collectors: [{ name: "fomo", collect: async () => ({ observations: [{ event: event("a", "Broken") }, { event: event("b", "Healthy") }], status: "ready" as const, commit }) }], signalSink: { accept: vi.fn() }, clock: { now: () => 2_000 }, lifecycleResolver: { resolve: async input => { if (input.tokenAddress === "Broken") throw new Error("down"); return "launched_0_2h"; } }, config: { strategyVersion: "address-v1", signalThreshold: 0.7, minimumPurchaseUsd: 0, minimumAggregateBuyUsd: 0, allowedChains: ["solana"], excludedTokenIds: [] } });
    await runtime.runOnce();
    expect(repository.addressSignalEvidenceForToken("solana", "Broken", 0)).toEqual([expect.objectContaining({ lifecycleStage: "unknown" })]);
    expect(repository.addressSignalEvidenceForToken("solana", "Healthy", 0)).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    expect(repository.latestRuntimeQualitySnapshot()).toMatchObject({ providerStatuses: { lifecycle: "degraded" } });
  });

  it("retains freshness watermarks across idle polls and ages a never-producing source", async () => {
    repository = openAddressRadarRepository(":memory:");
    let now = 1_000;
    const runtime = createScannerRuntime({ repository, collectors: [{ name: "fomo", collect: async () => ({ observations: [], status: "ready" as const }) }], signalSink: { accept: vi.fn() }, clock: { now: () => now }, config: { strategyVersion: "address-v1", signalThreshold: 0.7, minimumPurchaseUsd: 0, minimumAggregateBuyUsd: 0, allowedChains: [], excludedTokenIds: [] } });
    await runtime.runOnce();
    expect(repository.latestRuntimeQualitySnapshot()?.status).toBe("warming");
    now = 20 * 60_000;
    await runtime.runOnce();
    expect(repository.latestRuntimeQualitySnapshot()?.status).toBe("degraded");
  });
});
