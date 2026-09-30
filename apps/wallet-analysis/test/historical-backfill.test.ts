import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { createCandidateHistoryStore } from "@address-radar/database";
import { DatabaseSync } from "node:sqlite";
import { createDuneHistoricalBackfillWorker, createHistoricalBackfillScheduler, createHistoricalPartitions, runHistoricalBackfillCycle } from "../src/index.js";

const DAY = 24 * 60 * 60_000;
const START = Date.parse("2026-08-09T16:00:00.000Z");

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "address-radar-history-"));
  return join(directory, "radar.sqlite");
}

describe("historical partition planning", () => {
  it("creates deterministic chain-day-token-page partitions from the Shanghai watermark", () => {
    const partitions = createHistoricalPartitions({
      queryKind: "pre_milestone_trades",
      chains: ["solana", "base"],
      from: START,
      to: START + 2 * DAY,
      tokenAddressesByChain: { solana: ["A", "B", "C"], base: ["0x1"] },
      tokenPageSize: 2,
      createdAt: 10,
    });

    expect(partitions).toHaveLength(6);
    expect(new Set(partitions.map(item => item.partitionId)).size).toBe(6);
    expect(partitions.every(item => item.partitionId.startsWith(`${item.queryKind}:${item.chain}:${item.dayStart}:`))).toBe(true);
    expect(partitions[3]).toMatchObject({ chain: "solana", dayStart: START, dayEnd: START + DAY, tokenAddresses: ["C"], nextOffset: 0 });
  });

  it("changes partition identity when the token page content changes", () => {
    const first = createHistoricalPartitions({ queryKind: "milestone_crossings", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xa"] }, createdAt: 1 });
    const second = createHistoricalPartitions({ queryKind: "milestone_crossings", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xb"] }, createdAt: 2 });

    expect(first[0]?.partitionId).not.toBe(second[0]?.partitionId);
  });
});

describe("Solana historical valuation", () => {
  it("combines Dune peak price with RPC token supply before admitting a token", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const runSavedQueryPage = vi.fn(async () => ({
      queryId: 11,
      executionId: "exec-solana",
      rows: [{ chain: "solana", token_address: "MintA", symbol: "SOLMEME", first_trade_at: "2026-08-10T00:00:00.000Z", peak_price_at: "2026-08-10T01:00:00.000Z", peak_price_usd: 0.002 }],
      nextOffset: null,
      totalRowCount: 1,
    }));
    const worker = createDuneHistoricalBackfillWorker({
      client: { runSavedQueryPage } as never,
      repository,
      historyStore,
      queryIds: { token_universe: 11, milestone_crossings: 12, pre_milestone_trades: 13 },
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
      solanaSupply: { resolveMany: async () => new Map([["MintA", 1_000_000_000]]) },
    });
    const [partition] = createHistoricalPartitions({ queryKind: "token_universe", chains: ["solana"], from: START, to: START + DAY, createdAt: 1 });

    await worker.execute(partition!, new AbortController().signal);

    expect(historyStore.historicalToken("solana:MintA")).toMatchObject({ peakMarketCapUsd: 2_000_000, firstReached1mAt: Date.parse("2026-08-10T01:00:00.000Z") });
    expect(historyStore.milestoneCrossings("solana:MintA")).toEqual([
      expect.objectContaining({ marketCapUsd: 1_000_000, source: "historical_token_first_reached_1m" }),
    ]);
    database.close();
    repository.close();
  });

  it("does not persist a canonical quote asset from the token universe", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const tokenAddress = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const worker = createDuneHistoricalBackfillWorker({
      client: { runSavedQueryPage: vi.fn(async () => ({
        queryId: 11,
        executionId: "exec-usdc",
        rows: [{ chain: "solana", token_address: tokenAddress, symbol: "USDC", peak_price_at: "2026-08-10T01:00:00.000Z", peak_price_usd: 1 }],
        nextOffset: null,
        totalRowCount: 1,
      })) } as never,
      repository,
      historyStore,
      queryIds: { token_universe: 11, milestone_crossings: 12, pre_milestone_trades: 13 },
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
      solanaSupply: { resolveMany: async () => new Map([[tokenAddress, 1_000_000_000]]) },
    });
    const [partition] = createHistoricalPartitions({ queryKind: "token_universe", chains: ["solana"], from: START, to: START + DAY, createdAt: 1 });

    await worker.execute(partition!, new AbortController().signal);

    expect(historyStore.historicalToken(`solana:${tokenAddress}`)).toBeNull();
    database.close();
    repository.close();
  });
});

describe("historical backfill scheduler", () => {
  it("interleaves chains by day instead of exhausting one chain first", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const partitions = createHistoricalPartitions({ queryKind: "token_universe", chains: ["base", "solana"], from: START, to: START + 2 * DAY, createdAt: 1 });
    partitions.forEach(partition => repository.enqueueHistoricalBackfillPartition(partition));
    const database = new DatabaseSync(path);
    database.prepare("UPDATE historical_backfill_partitions SET next_retry_at = 2 WHERE chain = 'solana'").run();
    database.close();
    const worker = { execute: vi.fn(async input => ({ executionId: `exec-${input.partitionId}`, nextOffset: null, rowCount: 1, watermark: input.dayEnd, creditsUsed: 1, done: true })) };
    const scheduler = createHistoricalBackfillScheduler({ repository, worker, dailyCreditBudget: 10, now: () => START + 100 });

    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(worker.execute.mock.calls.map(([partition]) => [partition.chain, partition.dayStart])).toEqual([
      ["base", START],
      ["solana", START],
    ]);
    repository.close();
  });

  it("runs historical work even while verification remains busy", async () => {
    const verification = { runOnce: vi.fn(async () => ({ processed: true })) };
    const scheduler = { runOnce: vi.fn(async () => ({ processed: true })) };
    const signal = new AbortController().signal;

    await expect(runHistoricalBackfillCycle({ verification, scheduler, signal })).resolves.toEqual({ processed: true });

    expect(verification.runOnce).toHaveBeenCalledTimes(1);
    expect(scheduler.runOnce).toHaveBeenCalledWith(signal);
  });

  it("persists a page checkpoint and resumes it after restart", async () => {
    const path = await databasePath();
    const firstRepository = openAddressRadarRepository(path);
    const [partition] = createHistoricalPartitions({ queryKind: "token_universe", chains: ["solana"], from: START, to: START + DAY, createdAt: 1 });
    firstRepository.enqueueHistoricalBackfillPartition(partition!);
    const firstWorker = { execute: vi.fn(async () => ({ executionId: "exec-1", nextOffset: 100, rowCount: 100, watermark: START + 1, creditsUsed: 3, done: false })) };
    const first = createHistoricalBackfillScheduler({ repository: firstRepository, worker: firstWorker, dailyCreditBudget: 10, now: () => START + 100 });
    await expect(first.runOnce()).resolves.toMatchObject({ processed: true, status: "pending", partitionId: partition!.partitionId });
    firstRepository.close();

    const secondRepository = openAddressRadarRepository(path);
    const secondWorker = { execute: vi.fn(async input => ({ executionId: input.executionId, nextOffset: null, rowCount: 150, watermark: START + DAY, creditsUsed: 2, done: true })) };
    const second = createHistoricalBackfillScheduler({ repository: secondRepository, worker: secondWorker, dailyCreditBudget: 10, now: () => START + 200 });
    await expect(second.runOnce()).resolves.toMatchObject({ processed: true, status: "completed" });
    expect(secondWorker.execute).toHaveBeenCalledWith(expect.objectContaining({ executionId: "exec-1", nextOffset: 100 }), expect.any(AbortSignal));
    expect(secondRepository.historicalBackfillPartitions()).toEqual([expect.objectContaining({ status: "completed", rowCount: 150, attemptCount: 2 })]);
    expect(secondRepository.historicalWatermark("solana", "token_universe")).toBe(START + DAY);
    secondRepository.close();
  });

  it("does not rerun an idempotently completed partition", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const [partition] = createHistoricalPartitions({ queryKind: "token_universe", chains: ["base"], from: START, to: START + DAY, createdAt: 1 });
    repository.enqueueHistoricalBackfillPartition(partition!);
    const worker = { execute: vi.fn(async () => ({ executionId: "exec", nextOffset: null, rowCount: 1, watermark: START + DAY, creditsUsed: 1, done: true })) };
    const scheduler = createHistoricalBackfillScheduler({ repository, worker, dailyCreditBudget: 10, now: () => START + 100 });

    await scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ processed: false, status: "idle" });
    expect(worker.execute).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("pauses at the daily budget without claiming more work", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const partitions = createHistoricalPartitions({ queryKind: "token_universe", chains: ["base", "solana"], from: START, to: START + DAY, createdAt: 1 });
    partitions.forEach(partition => repository.enqueueHistoricalBackfillPartition(partition));
    const worker = { execute: vi.fn(async () => ({ executionId: "exec", nextOffset: null, rowCount: 1, watermark: START + DAY, creditsUsed: 5, done: true })) };
    const scheduler = createHistoricalBackfillScheduler({ repository, worker, dailyCreditBudget: 5, now: () => START + 100 });

    await scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toMatchObject({ processed: false, status: "budget_wait", creditsUsed: 5 });
    expect(worker.execute).toHaveBeenCalledTimes(1);
    repository.close();
  });

  it("isolates one chain failure and continues another chain", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const partitions = createHistoricalPartitions({ queryKind: "token_universe", chains: ["base", "solana"], from: START, to: START + DAY, createdAt: 1 });
    partitions.forEach(partition => repository.enqueueHistoricalBackfillPartition(partition));
    const worker = { execute: vi.fn(async input => {
      if (input.chain === "base") throw new Error("base unavailable");
      return { executionId: "exec-sol", nextOffset: null, rowCount: 1, watermark: START + DAY, creditsUsed: 1, done: true };
    }) };
    let now = START + 100;
    const scheduler = createHistoricalBackfillScheduler({ repository, worker, dailyCreditBudget: 10, retryDelayMs: DAY, now: () => now });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ processed: false, status: "failed", chain: "base" });
    now += 1;
    await expect(scheduler.runOnce()).resolves.toMatchObject({ processed: true, status: "completed", chain: "solana" });
    expect(repository.historicalBackfillPartitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ chain: "base", status: "failed", lastError: "base unavailable" }),
      expect.objectContaining({ chain: "solana", status: "completed" }),
    ]));
    repository.close();
  });
});

describe("Dune historical backfill worker", () => {
  it("completes legacy token-universe partitions without calling Dune when it is disabled", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const worker = createDuneHistoricalBackfillWorker({ repository, historyStore, queryIds: {}, pageSize: 100, strategyVersion: "candidate-history-v3" });
    const [partition] = createHistoricalPartitions({ queryKind: "token_universe", chains: ["base"], from: START, to: START + DAY, createdAt: 1 });

    await expect(worker.execute(partition!, new AbortController().signal)).resolves.toMatchObject({ creditsUsed: 0, done: true, rowCount: 0 });
    database.close();
    repository.close();
  });

  it("completes milestone partitions through GeckoTerminal without Dune credits", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const worker = createDuneHistoricalBackfillWorker({
      repository,
      historyStore,
      queryIds: {},
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
      milestoneRouter: {
        fallbackCircuit: () => ({ open: false, retryAt: null }),
        reconstruct: async () => ({
          provider: "gecko_terminal",
          result: { status: "available", poolAddress: "pool", supplyEstimate: 1_000_000, supplyBasis: "market_cap", candleCount: 10, milestones: [{ thresholdUsd: 500_000, crossedAt: START + 1_000, estimatedMarketCapUsd: 550_000, source: "gecko_terminal_ohlcv", precision: "estimated_market_cap" }] },
          attempts: [{ provider: "gecko_terminal", outcome: "available", retryable: false, message: null }],
        }),
      },
      duneFallbackEnabled: false,
    });
    const [partition] = createHistoricalPartitions({ queryKind: "milestone_crossings", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xABC"] }, createdAt: 1 });

    await expect(worker.execute(partition!, new AbortController().signal)).resolves.toMatchObject({ creditsUsed: 0, done: true, rowCount: 1 });
    expect(historyStore.milestoneCrossings("base:0xabc")).toEqual([expect.objectContaining({ marketCapUsd: 500_000, source: "gecko_terminal_ohlcv" })]);
    database.close();
    repository.close();
  });

  it.each(["missing", "fdv"] as const)("does not complete temporary or FDV-only milestone evidence: %s", async kind => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const worker = createDuneHistoricalBackfillWorker({
      repository, historyStore, queryIds: {}, pageSize: 100, strategyVersion: "candidate-history-v3", duneFallbackEnabled: false,
      milestoneRouter: {
        fallbackCircuit: () => ({ open: false, retryAt: null }),
        reconstruct: async () => ({
          provider: "gecko_terminal",
          result: { status: kind === "missing" ? "insufficient_market_data" : "available", poolAddress: "pool", supplyEstimate: kind === "fdv" ? 100000 : null, supplyBasis: kind === "fdv" ? "fdv" : null, candleCount: 1, milestones: kind === "fdv" ? [{ thresholdUsd: 500000, crossedAt: START + 1000, estimatedMarketCapUsd: 500000, source: "gecko_terminal_ohlcv", precision: "estimated_market_cap", supplyBasis: "fdv" }] : [] },
          attempts: [{ provider: "gecko_terminal", outcome: "not_found", retryable: true, message: null }],
        }),
      },
    });
    const [partition] = createHistoricalPartitions({ queryKind: "milestone_crossings", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xABC"] }, createdAt: 1 });
    await expect(worker.execute(partition!, new AbortController().signal)).rejects.toThrow("historical_milestone_evidence_unavailable");
    expect(historyStore.milestoneCrossings("base:0xabc")).toEqual([]);
    database.close(); repository.close();
  });

  it("completes permanently unavailable milestone tokens when Dune fallback is disabled", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const worker = createDuneHistoricalBackfillWorker({
      repository,
      historyStore,
      queryIds: {},
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
      milestoneRouter: {
        fallbackCircuit: () => ({ open: false, retryAt: null }),
        reconstruct: async () => ({
          provider: "gecko_terminal",
          result: { status: "not_found", poolAddress: null, supplyEstimate: null, supplyBasis: null, candleCount: 0, milestones: [] },
          attempts: [{ provider: "gecko_terminal", outcome: "not_found", retryable: false, message: null }],
        }),
      },
      duneFallbackEnabled: false,
    });
    const [partition] = createHistoricalPartitions({ queryKind: "milestone_crossings", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xABC"] }, createdAt: 1 });

    await expect(worker.execute(partition!, new AbortController().signal)).resolves.toMatchObject({ creditsUsed: 0, done: true, rowCount: 0 });
    database.close();
    repository.close();
  });

  it("completes recent early-trade partitions without Dune credits", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    historyStore.saveMilestoneCrossing({ milestoneId: "base:0xabc:500000", tokenId: "base:0xabc", marketCapUsd: 500_000, crossedAt: START + 10_000, precision: "estimated", source: "gecko_terminal_ohlcv", sourceEventIds: ["pool:1"], strategyVersion: "candidate-history-v3" });
    const worker = createDuneHistoricalBackfillWorker({
      repository,
      historyStore,
      queryIds: {},
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
      resolveTraderId: () => "entity-1",
      earlyTradeProvider: { recover: async () => ({
        status: "available",
        poolAddress: "pool",
        coverageStartAt: START,
        coverageEndAt: START + 10_000,
        trades: [{ eventId: "trade-1", economicKey: "tx-1", chain: "base", tokenAddress: "0xabc", traderAddress: "0xwallet", side: "buy", amountUsd: 100, marketCapUsd: 100_000, occurredAt: START + 1_000, source: "gecko_terminal:pool" }],
      }) },
      duneFallbackEnabled: false,
    });
    const [partition] = createHistoricalPartitions({ queryKind: "pre_milestone_trades", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xabc"] }, createdAt: 1 });

    await expect(worker.execute(partition!, new AbortController().signal)).resolves.toMatchObject({ creditsUsed: 0, done: true, rowCount: 1 });
    expect(historyStore.evidenceForTrader("entity-1")).toHaveLength(1);
    database.close();
    repository.close();
  });

  it("resumes a persisted execution page and normalizes token inventory", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const runSavedQueryPage = vi.fn(async () => ({
      queryId: 11,
      executionId: "exec-1",
      rows: [{ chain: "base", token_address: "0xABC", symbol: "ALPHA", first_trade_at: "2026-08-10T00:00:00.000Z", first_reached_1m_at: "2026-08-10T01:00:00.000Z", peak_market_cap_usd: 2_000_000 }],
      nextOffset: null,
      totalRowCount: 101,
    }));
    const worker = createDuneHistoricalBackfillWorker({
      client: { runSavedQueryPage } as never,
      repository,
      historyStore,
      queryIds: { token_universe: 11, milestone_crossings: 12, pre_milestone_trades: 13 },
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
    });
    const [base] = createHistoricalPartitions({ queryKind: "token_universe", chains: ["base"], from: START, to: START + DAY, createdAt: 1 });
    const partition = { ...base!, status: "running" as const, executionId: "exec-1", nextOffset: 100, rowCount: 100, attemptCount: 2 };

    await expect(worker.execute(partition, new AbortController().signal)).resolves.toMatchObject({ executionId: "exec-1", nextOffset: null, rowCount: 101, watermark: START + DAY, creditsUsed: 0, done: true });
    expect(runSavedQueryPage).toHaveBeenCalledWith(11, expect.objectContaining({ executionId: "exec-1", offset: 100, pageSize: 100, parameters: expect.objectContaining({ chain: "base" }) }));
    const calls = runSavedQueryPage.mock.calls as unknown as readonly [number, { readonly parameters: Readonly<Record<string, unknown>> }][];
    expect(calls[0]?.[1].parameters).not.toHaveProperty("token_addresses");
    expect(historyStore.historicalToken("base:0xabc")).toMatchObject({ symbol: "ALPHA", peakMarketCapUsd: 2_000_000 });
    database.close();
    repository.close();
  });

  it("preserves approximate milestone precision from Dune", async () => {
    const path = await databasePath();
    const repository = openAddressRadarRepository(path);
    const database = new DatabaseSync(path);
    const historyStore = createCandidateHistoryStore(database);
    const runSavedQueryPage = vi.fn(async () => ({
      queryId: 12,
      executionId: "exec-estimated",
      rows: [{
        chain: "base",
        token_address: "0xABC",
        milestone_market_cap_usd: 500_000,
        crossed_at: "2026-08-10T01:00:00.000Z",
        precision: "estimated_latest_supply_5m_median",
        source_reference: "dune:milestone:0xabc",
      }],
      nextOffset: null,
      totalRowCount: 1,
    }));
    const worker = createDuneHistoricalBackfillWorker({
      client: { runSavedQueryPage } as never,
      repository,
      historyStore,
      queryIds: { token_universe: 11, milestone_crossings: 12, pre_milestone_trades: 13 },
      pageSize: 100,
      strategyVersion: "candidate-history-v3",
    });
    const [base] = createHistoricalPartitions({ queryKind: "milestone_crossings", chains: ["base"], from: START, to: START + DAY, tokenAddressesByChain: { base: ["0xabc"] }, createdAt: 1 });

    await worker.execute(base!, new AbortController().signal);

    expect(historyStore.milestoneCrossings("base:0xabc")).toEqual([
      expect.objectContaining({ marketCapUsd: 500_000, precision: "estimated" }),
    ]);
    database.close();
    repository.close();
  });

});
