import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { createSolanaRpcWalletHistoryProvider, createWalletAnalysisReviewService, loadHistoricalBackfillConfig, loadWalletAnalysisConfig, openWalletAnalysisStore, reconstructWalletPositions, runWalletAnalysisService } from "../src/index.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wallet-analysis-review-"));
  const path = join(directory, "radar.sqlite");
  const store = openWalletAnalysisStore(path);
  store.enqueue({ analysisId: "analysis-1", chainFamily: "evm", address: "0x1111111111111111111111111111111111111111", requestedSamples: 10, createdAt: 100 });
  store.savePage("analysis-1", [{ tokenId: "base:token", enteredAt: 100, investedUsd: 100, realizedValueUsd: 200, remainingValueUsd: 0, peakValueUsd: 500, holdingDurationMs: 10, maximumDrawdownRatio: 0.1, earlyEntry: true, largeBuy: false }], null, "base-rpc", 101);
  store.complete("analysis-1", { requestedSamples: 10, validSamples: 1, coverageRate: 0.1, profitableRate: 1, hit1_5xRate: 1, hit2xRate: 1, hit3xRate: 1, hit5xRate: 1, hit10xRate: 0, meanPeakMultiple: 5, medianPeakMultiple: 5, meanRealizedMultiple: 2, medianRealizedMultiple: 2, meanHoldingDurationMs: 10, medianHoldingDurationMs: 10, earlyEntryRate: 1, largeBuyRate: 0, medianMaximumDrawdownRatio: 0.1, unsoldPositionRate: 0 }, 101);
  return { path, store };
}

describe("wallet analysis review", () => {
  it("accepts only explicitly reviewed identities and bumps the monitoring registry", async () => {
    const { path, store } = await fixture();
    const repository = openAddressRadarRepository(path);
    const review = createWalletAnalysisReviewService({ store, repository });
    expect(review.accept({ analysisId: "analysis-1", accountId: "account-1", handle: "alpha", entityId: "entity-1", reviewedAt: 200 })).toMatchObject({ status: "accepted", entityId: "entity-1" });
    const database = new DatabaseSync(path);
    expect(database.prepare("SELECT status FROM wallet_analysis_jobs WHERE analysis_id = 'analysis-1'").get()).toEqual({ status: "accepted" });
    expect(database.prepare("SELECT entity_id AS entityId, monitoring_enabled AS enabled FROM trader_profiles WHERE entity_id = 'entity-1'").get()).toEqual({ entityId: "entity-1", enabled: 0 });
    expect(database.prepare("SELECT version FROM monitoring_registry_state WHERE singleton = 1").get()).toEqual({ version: 1 });
    database.close();
    repository.close();
    store.close();
  });

  it("records ownership conflicts and leaves the analysis pending review", async () => {
    const { path, store } = await fixture();
    const repository = openAddressRadarRepository(path);
    repository.upsertFomoAccount({ accountId: "owner", handle: "owner", firstSeenAt: 1, lastSeenAt: 1 });
    repository.attachWallet({ accountId: "owner", chainFamily: "evm", address: "0x1111111111111111111111111111111111111111", confidence: "confirmed", source: "test", observedAt: 1 });
    const review = createWalletAnalysisReviewService({ store, repository });
    expect(review.accept({ analysisId: "analysis-1", accountId: "account-1", handle: "alpha", entityId: "entity-1", reviewedAt: 200 })).toMatchObject({ status: "conflict" });
    expect(store.job("analysis-1")?.status).toBe("review_required");
    expect(repository.identityConflicts("pending")).toHaveLength(1);
    repository.close();
    store.close();
  });

  it("rejects without admitting the wallet to monitoring", async () => {
    const { path, store } = await fixture();
    const repository = openAddressRadarRepository(path);
    createWalletAnalysisReviewService({ store, repository }).reject({ analysisId: "analysis-1", reviewedAt: 200 });
    expect(store.job("analysis-1")?.status).toBe("rejected");
    expect(repository.walletOwner("evm", "0x1111111111111111111111111111111111111111")).toBeNull();
    repository.close();
    store.close();
  });
});

describe("wallet analysis production wiring", () => {
  it("backfills bounded history for jobs created before bounds were introduced", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-analysis-legacy-"));
    const path = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    repository.close();
    const createdAt = 100 * 24 * 60 * 60_000;
    const database = new DatabaseSync(path);
    database.prepare(`
      INSERT INTO wallet_analysis_jobs(
        analysis_id, chain_family, address, status, requested_sample_count,
        valid_sample_count, coverage_rate, created_at, updated_at
      ) VALUES (?, 'evm', ?, 'collecting', 300, 0, 0, ?, ?)
    `).run("legacy-analysis", "0x1111111111111111111111111111111111111111", createdAt, createdAt);
    database.close();

    const store = openWalletAnalysisStore(path);
    expect(store.next()).toMatchObject({
      analysisId: "legacy-analysis",
      from: createdAt - 60 * 24 * 60 * 60_000,
      to: createdAt,
      maxTokens: 300,
    });
    store.close();
  });

  it("fails preflight without usable history providers", () => {
    expect(() => loadWalletAnalysisConfig({})).toThrow("At least one wallet-analysis RPC endpoint is required");
  });

  it("loads a delivery-disabled historical backfill configuration", () => {
    expect(loadHistoricalBackfillConfig({
      DUNE_API_KEY: "secret",
      DUNE_TOKEN_UNIVERSE_QUERY_ID: "11",
      DUNE_MILESTONE_CROSSINGS_QUERY_ID: "12",
      DUNE_PRE_MILESTONE_TRADES_QUERY_ID: "13",
      DUNE_HISTORICAL_START_AT: "2026-08-09T16:00:00.000Z",
      ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: "false",
    })).toMatchObject({ queryIds: { token_universe: 11, milestone_crossings: 12, pre_milestone_trades: 13 }, chains: ["solana", "bsc", "eth", "base"], dailyCreditBudget: 1000 });
    expect(() => loadHistoricalBackfillConfig({ DUNE_API_KEY: "secret", ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: "true" })).toThrow(/delivery/i);
  });

  it("reconstructs positions only from priced historical evidence", async () => {
    const positions = await reconstructWalletPositions({ events: [
      { eventId: "buy", chain: "base", tokenAddress: "0xtoken", side: "buy", tokenAmount: 10, occurredAt: 10, source: "base-rpc" },
      { eventId: "sell", chain: "base", tokenAddress: "0xtoken", side: "sell", tokenAmount: 5, occurredAt: 20, source: "base-rpc" },
    ], limit: 300, observedAt: 30, market: { priceAt: async (_chain, _token, at) => at === 10 ? 2 : at === 20 ? 4 : 3, peakPrice: async () => 5, minimumPrice: async () => 1, firstObservedAt: async () => 0 } });
    expect(positions).toEqual([expect.objectContaining({ tokenId: "base:0xtoken", investedUsd: 20, realizedValueUsd: 20, remainingValueUsd: 15, peakValueUsd: 50 })]);
  });

  it("reconstructs a bounded Solana history page through the provider boundary", async () => {
    const saved: Array<{ tokenAddress: string }> = [];
    const provider = createSolanaRpcWalletHistoryProvider({
      pageSize: 10,
      rpc: { request: async (_chain, method) => method === "getSignaturesForAddress"
        ? [{ signature: "sig-1", blockTime: 50 }]
        : { meta: { preTokenBalances: [{ mint: "TokenA", owner: "Wallet", uiTokenAmount: { amount: "0", decimals: 0 } }, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "Wallet", uiTokenAmount: { amount: "20", decimals: 0 } }], postTokenBalances: [{ mint: "TokenA", owner: "Wallet", uiTokenAmount: { amount: "10", decimals: 0 } }, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: "Wallet", uiTokenAmount: { amount: "0", decimals: 0 } }] } } },
      events: { append: (_analysisId, events) => saved.push(...events), events: () => saved.map((event, index) => ({ eventId: `event-${index}`, chain: "solana", tokenAddress: event.tokenAddress, side: "buy" as const, tokenAmount: 10, occurredAt: 50_000, source: "solana-rpc" })), close() {} },
      market: { priceAt: async () => 2, peakPrice: async () => 3, minimumPrice: async () => 1, firstObservedAt: async () => 49_000 },
    });
    const page = await provider.collect({ analysisId: "a", address: "Wallet", from: 40_000, to: 60_000, limit: 300, cursor: null, signal: new AbortController().signal });
    expect(page).toMatchObject({ done: true, nextCursor: null, provenance: expect.stringContaining("solana-rpc"), positions: [expect.objectContaining({ investedUsd: 20, peakValueUsd: 30 })] });
  });

  it("stops the analysis loop gracefully", async () => {
    const controller = new AbortController();
    let runs = 0;
    await runWalletAnalysisService({ signal: controller.signal, intervalMs: 1, runOnce: async () => { runs += 1; controller.abort(); return { processed: false }; } });
    expect(runs).toBe(1);
  });
});
