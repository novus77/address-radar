import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createWalletAnalysisRuntime, openWalletAnalysisStore } from "../src/index.js";

describe("wallet analysis progress", () => {
  it("publishes heartbeat and completes with visible progress", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "wallet-progress-")), "radar.sqlite");
    const store = openWalletAnalysisStore(path);
    store.enqueue({ analysisId: "analysis", chainFamily: "solana", address: "wallet", requestedSamples: 1, createdAt: 100 });
    const runtime = createWalletAnalysisRuntime({
      store,
      providers: { solana: { collect: async () => ({ positions: [{ tokenId: "solana:token", enteredAt: 100, investedUsd: 10, realizedValueUsd: 20, remainingValueUsd: 0, peakValueUsd: 30, holdingDurationMs: 1, maximumDrawdownRatio: 0, earlyEntry: true, largeBuy: false }], nextCursor: null, done: true, provenance: "test" }) } },
      now: () => 200,
    });

    await runtime.runOnce();

    expect(store.job("analysis")).toMatchObject({
      phase: "completed",
      heartbeatAt: 200,
      discoveredTokens: 1,
      progressPercent: 100,
    });
    store.close();
  });

  it("marks stale collecting jobs as blocked and allows an explicit retry", () => {
    const path = join(mkdtempSync(join(tmpdir(), "wallet-blocked-")), "radar.sqlite");
    const store = openWalletAnalysisStore(path);
    store.enqueue({ analysisId: "analysis", chainFamily: "evm", address: "0x1111111111111111111111111111111111111111", requestedSamples: 10, createdAt: 100 });

    expect(store.blockStale(1_000, 500)).toBe(1);
    expect(store.job("analysis")).toMatchObject({ phase: "blocked" });
    expect(store.next()).toBeNull();

    store.retry("analysis", 1_100);
    expect(store.job("analysis")).toMatchObject({ phase: "queued", heartbeatAt: 1_100 });
    expect(store.next()?.analysisId).toBe("analysis");
    store.close();
  });
});
