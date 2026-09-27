import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { createCandidateDiscoveryService, createTraderPerformanceRuntime, createWalletAnalysisRuntime, openWalletAnalysisStore } from "../src/index.js";

const DAY = 24 * 60 * 60_000;
const position = { tokenId: "solana:TokenA", enteredAt: 50 * DAY, investedUsd: 100, realizedValueUsd: 200, remainingValueUsd: 0, peakValueUsd: 500, holdingDurationMs: 1_000, maximumDrawdownRatio: 0.2, earlyEntry: true, largeBuy: false };

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "address-radar-analysis-"));
  return join(directory, "radar.sqlite");
}

describe("wallet analysis runtime", () => {
  it("limits history to 60 days and 300 tokens, then resumes a checkpoint after restart", async () => {
    const path = await databasePath();
    const firstStore = openWalletAnalysisStore(path);
    firstStore.enqueue({ analysisId: "analysis-1", chainFamily: "solana", address: "Wallet", requestedSamples: 999, createdAt: 100 * DAY });
    const requests: unknown[] = [];
    const provider = { collect: async (request: { cursor: string | null; from: number; to: number; limit: number }) => {
      requests.push(request);
      return request.cursor === null
        ? { positions: [position], nextCursor: "page-2", done: false, provenance: "solana-rpc" }
        : { positions: [position, { ...position, tokenId: "solana:TokenB" }], nextCursor: null, done: true, provenance: "solana-rpc" };
    } };
    const first = createWalletAnalysisRuntime({ store: firstStore, providers: { solana: provider }, now: () => 100 * DAY });
    await expect(first.runOnce()).resolves.toMatchObject({ status: "collecting", saved: 1 });
    firstStore.close();

    const secondStore = openWalletAnalysisStore(path);
    const second = createWalletAnalysisRuntime({ store: secondStore, providers: { solana: provider }, now: () => 200 * DAY });
    await expect(second.runOnce()).resolves.toMatchObject({ status: "review_required", saved: 1, metrics: { requestedSamples: 300, validSamples: 2, hit5xRate: 1 } });
    expect(requests).toEqual([
      expect.objectContaining({ cursor: null, from: 40 * DAY, to: 100 * DAY, limit: 300 }),
      expect.objectContaining({ cursor: "page-2", from: 40 * DAY, to: 100 * DAY, limit: 300 }),
    ]);
    expect(secondStore.job("analysis-1")).toMatchObject({ status: "review_required", checkpoint: null, provenance: ["solana-rpc"] });
    secondStore.close();
  });

  it("keeps the previous checkpoint when an incomplete page omits nextCursor", async () => {
    const path = await databasePath();
    const store = openWalletAnalysisStore(path);
    store.enqueue({ analysisId: "analysis-1", chainFamily: "solana", address: "Wallet", requestedSamples: 10, createdAt: 100 * DAY });
    store.savePage("analysis-1", [], "page-1", "solana-rpc", 100 * DAY);
    const runtime = createWalletAnalysisRuntime({ store, providers: { solana: { collect: async () => ({ positions: [], nextCursor: null, done: false, provenance: "solana-rpc" }) } }, now: () => 200 * DAY });
    await expect(runtime.runOnce()).resolves.toMatchObject({ processed: false, error: "Incomplete wallet history page requires nextCursor" });
    expect(store.job("analysis-1")).toMatchObject({ status: "collecting", checkpoint: "page-1", from: 40 * DAY, to: 100 * DAY, maxTokens: 300 });
    store.close();
  });

  it("keeps provider failure retryable without inventing metrics", async () => {
    const path = await databasePath();
    const store = openWalletAnalysisStore(path);
    store.enqueue({ analysisId: "analysis-1", chainFamily: "evm", address: "0x1111111111111111111111111111111111111111", requestedSamples: 10, createdAt: 1 });
    const runtime = createWalletAnalysisRuntime({ store, providers: { evm: { collect: async () => { throw new Error("rate_limited"); } } }, now: () => 100 * DAY });
    await expect(runtime.runOnce()).resolves.toEqual({ analysisId: "analysis-1", processed: false, status: "collecting", error: "rate_limited" });
    expect(store.job("analysis-1")).toMatchObject({ status: "collecting", metrics: null, lastError: "rate_limited" });
    store.close();
  });
});

describe("candidate milestone discovery", () => {
  it("encodes approved tiers and queues identity resolution instead of signal eligibility", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "u1", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.ensureTraderEntity({ entityId: "fomo:u1", lifecycle: "suspended", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "u1", entityId: "fomo:u1", confidence: "confirmed", source: "test", observedAt: 1 });
    repository.insertTraderEvent({ eventId: "buy", accountId: "u1", entityId: "fomo:u1", chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 100, priceUsd: 0.01, marketCapUsd: 20_000, tokenAgeMs: 100, occurredAt: 100, collectedAt: 100, source: "fomo_stream" });
    const service = createCandidateDiscoveryService({ repository });
    const discoveries = service.observe({ chain: "solana", tokenAddress: "TokenA", marketCapUsd: 1_000_000, reachedAt: 1_000, provenance: { source: "fomo_stream", sourceEventIds: ["milestone-event"] } });

    expect(discoveries.map(item => item.discoveryType)).toEqual(["market_cap_100k_5x", "market_cap_200k_5x", "market_cap_300k_5x", "market_cap_500k_10x", "market_cap_1m_20x"]);
    expect(repository.identityResolutionQueue(10)).toEqual([expect.objectContaining({ handle: "alpha" })]);
    expect(repository.traderEntity("fomo:u1")?.lifecycle).toBe("candidate");
    const evidence = repository.candidateDiscoveries("u1");
    expect(JSON.parse(evidence[0]!.payload)).toMatchObject({ processor: "wallet_analysis", evidence: { milestone: { source: "fomo_stream", sourceEventIds: ["milestone-event"] }, trades: [{ source: "fomo_stream", eventId: "buy" }] } });
    service.observe({ chain: "solana", tokenAddress: "TokenA", marketCapUsd: 1_000_000, reachedAt: 1_000, provenance: { source: "fomo_stream", sourceEventIds: ["milestone-event"] } });
    expect(repository.candidateDiscoveries("u1")).toHaveLength(5);
    repository.close();
  });
});

describe("trader performance runtime", () => {
  it("produces reproducible ability and style snapshots from persisted evidence", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "u1", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.ensureTraderEntity({ entityId: "fomo:u1", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "u1", entityId: "fomo:u1", confidence: "confirmed", source: "test", observedAt: 1 });
    repository.insertTraderEvent({ eventId: "buy", accountId: "u1", entityId: "fomo:u1", chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 200, priceUsd: 1, marketCapUsd: 50_000, tokenAgeMs: 500, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    repository.insertTraderEvent({ eventId: "sell", accountId: "u1", entityId: "fomo:u1", chain: "solana", tokenAddress: "TokenA", side: "sell", amountUsd: 400, priceUsd: 2, marketCapUsd: 100_000, tokenAgeMs: 60_000, occurredAt: 61_000, collectedAt: 61_000, source: "fomo_stream" });
    const runtime = createTraderPerformanceRuntime({ repository, now: () => 70_000, strategyVersion: "trader-ability-v2", dustThresholdUsd: 25, maximumObservationDelayMs: 5_000 });

    await runtime.runOnce();
    const first = repository.latestTraderAbility("fomo:u1", "30d");
    repository.insertTraderEvent({ eventId: "sell-later", accountId: "u1", entityId: "fomo:u1", chain: "solana", tokenAddress: "TokenA", side: "sell", amountUsd: 100, priceUsd: 2.5, marketCapUsd: 125_000, tokenAgeMs: 120_000, occurredAt: 121_000, collectedAt: 121_000, source: "fomo_stream" });
    await runtime.runOnce();
    const second = repository.latestTraderAbility("fomo:u1", "30d");

    expect(first).not.toBeNull();
    expect(repository.traderTokenSamples("fomo:u1")).toHaveLength(1);
    expect(repository.traderTokenOutcomes(repository.traderTokenSamples("fomo:u1")[0]!.sampleId).length).toBeGreaterThan(0);
    expect(second).toEqual(expect.objectContaining({ strategyVersion: "trader-ability-v2", styles: expect.objectContaining({ EARLY_LAUNCH: expect.any(Number), HIGH_MULTIPLE: expect.any(Number) }) }));
    repository.close();
  });
});
