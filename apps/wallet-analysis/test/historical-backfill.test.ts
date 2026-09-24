import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { createHistoricalBackfillScheduler, createHistoricalPartitions } from "../src/index.js";

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
    expect(partitions.map(item => item.partitionId)).toEqual([
      `pre_milestone_trades:base:${START}:0`,
      `pre_milestone_trades:base:${START + DAY}:0`,
      `pre_milestone_trades:solana:${START}:0`,
      `pre_milestone_trades:solana:${START}:1`,
      `pre_milestone_trades:solana:${START + DAY}:0`,
      `pre_milestone_trades:solana:${START + DAY}:1`,
    ]);
    expect(partitions[3]).toMatchObject({ chain: "solana", dayStart: START, dayEnd: START + DAY, tokenAddresses: ["C"], nextOffset: 0 });
  });
});

describe("historical backfill scheduler", () => {
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
