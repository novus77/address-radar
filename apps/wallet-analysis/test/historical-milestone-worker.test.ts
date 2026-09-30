import { describe, expect, it, vi } from "vitest";

import type {
  HistoricalMilestoneQueue,
  HistoricalMilestoneRepository,
} from "../src/historical-milestone-worker.js";
import { createHistoricalMilestoneWorker } from "../src/historical-milestone-worker.js";
import type { HistoricalProviderRouter } from "../src/historical-provider-router.js";

const job = {
  id: "job-1",
  chain: "base" as const,
  tokenAddress: "0xToken",
  fromTimestamp: 0,
  toTimestamp: 100,
  attempt: 0,
};

function queueFor(current = job): HistoricalMilestoneQueue & {
  complete: ReturnType<typeof vi.fn>;
  defer: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
} {
  return {
    claim: async () => current,
    complete: vi.fn(async () => undefined),
    defer: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
}

function repository(): HistoricalMilestoneRepository & { upsert: ReturnType<typeof vi.fn> } {
  return { upsert: vi.fn(async () => undefined) };
}

describe("HistoricalMilestoneWorker", () => {
  it("persists idempotent milestones before completing a job", async () => {
    const queue = queueFor();
    const store = repository();
    const router: HistoricalProviderRouter = {
      fallbackCircuit: () => ({ open: false, retryAt: null }),
      reconstruct: async () => ({
        provider: "gecko_terminal",
        result: {
          status: "available",
          poolAddress: "pool",
          supplyEstimate: 1_000_000,
          supplyBasis: "market_cap",
          milestones: [{
            thresholdUsd: 500_000,
            crossedAt: 50,
            estimatedMarketCapUsd: 550_000,
            source: "gecko_terminal_ohlcv",
            precision: "estimated_market_cap",
          }],
          candleCount: 24,
        },
        attempts: [{ provider: "gecko_terminal", outcome: "available", retryable: false, message: null }],
      }),
    };
    const worker = createHistoricalMilestoneWorker({ queue, repository: store, router, now: () => 1_000 });

    await expect(worker.runOnce()).resolves.toEqual({
      status: "completed",
      jobId: "job-1",
      provider: "gecko_terminal",
      milestoneCount: 1,
    });
    expect(store.upsert).toHaveBeenCalledWith([expect.objectContaining({
      idempotencyKey: "base:0xtoken:500000:gecko_terminal",
      recordedAt: 1_000,
    })]);
    expect(queue.complete).toHaveBeenCalledOnce();
  });

  it("defers missing market history without failing the queue", async () => {
    const queue = queueFor();
    const router: HistoricalProviderRouter = {
      fallbackCircuit: () => ({ open: false, retryAt: null }),
      reconstruct: async () => ({
        provider: "gecko_terminal",
        result: { status: "not_found", poolAddress: null, supplyEstimate: null, supplyBasis: null, milestones: [], candleCount: 0 },
        attempts: [{ provider: "gecko_terminal", outcome: "not_found", retryable: false, message: null }],
      }),
    };
    const worker = createHistoricalMilestoneWorker({ queue, repository: repository(), router, now: () => 1_000 });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: "deferred", retryAt: 21_601_000 });
    expect(queue.defer).toHaveBeenCalledWith("job-1", 21_601_000, "not_found");
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("defers a persistence failure so evidence is never silently lost", async () => {
    const queue = queueFor();
    const store = repository();
    store.upsert.mockRejectedValueOnce(new Error("database is locked"));
    const router: HistoricalProviderRouter = {
      fallbackCircuit: () => ({ open: false, retryAt: null }),
      reconstruct: async () => ({
        provider: "gecko_terminal",
        result: { status: "available", poolAddress: "pool", supplyEstimate: 1, supplyBasis: "fdv", milestones: [], candleCount: 1 },
        attempts: [{ provider: "gecko_terminal", outcome: "available", retryable: false, message: null }],
      }),
    };
    const worker = createHistoricalMilestoneWorker({ queue, repository: store, router, now: () => 1_000 });

    await expect(worker.runOnce()).resolves.toMatchObject({ status: "deferred", retryAt: 301_000 });
    expect(queue.complete).not.toHaveBeenCalled();
  });

  it("returns idle when no job is available", async () => {
    const queue = queueFor(null as never);
    const router = { fallbackCircuit: () => ({ open: false, retryAt: null }) } as HistoricalProviderRouter;
    const worker = createHistoricalMilestoneWorker({ queue, repository: repository(), router });

    await expect(worker.runOnce()).resolves.toEqual({ status: "idle" });
  });
});

