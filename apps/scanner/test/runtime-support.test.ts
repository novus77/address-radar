import { afterEach, describe, expect, it, vi } from "vitest";

import { parseScannerConfig, runScannerPreflight } from "../src/config.js";
import { createPollingRuntimeJob, reconciliationIntervalMs } from "../src/runtime.js";

describe("scanner runtime support", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("polls immediately, recovers after an error, and stops cleanly", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    const onError = vi.fn();
    const setInterval = vi.spyOn(globalThis, "setInterval");
    const job = createPollingRuntimeJob({ runOnce, intervalMs: 1_000, onError });

    job.start();
    expect((setInterval.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await job.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("uses lifecycle-sensitive reconciliation intervals", () => {
    expect(reconciliationIntervalMs("elite")).toBe(2 * 60_000);
    expect(reconciliationIntervalMs("suspended")).toBe(24 * 60 * 60_000);
    expect(reconciliationIntervalMs("candidate", true)).toBe(2 * 60_000);
  });

  it("parses scanner-only configuration and preflights its database path", async () => {
    const config = parseScannerConfig({
      ADDRESS_RADAR_DATABASE_PATH: "/data/address.sqlite",
      ADDRESS_RADAR_STRATEGY_VERSION: "address-v1",
      ADDRESS_RADAR_SIGNAL_THRESHOLD: "0.7",
      ADDRESS_RADAR_MINIMUM_PURCHASE_USD: "100",
      ADDRESS_RADAR_MINIMUM_AGGREGATE_BUY_USD: "500",
      ADDRESS_RADAR_ALLOWED_CHAINS: "solana,base",
      ADDRESS_RADAR_EXCLUDED_TOKEN_IDS: "solana:Blocked",
      ADDRESS_RADAR_FOMO_EVENT_LOG_PATH: "/data/fomo.jsonl",
    });
    const report = await runScannerPreflight({
      config,
      filesystem: { writable: async path => path === "/data", exists: async path => path === "/data/fomo.jsonl" },
    });

    expect(config.allowedChains).toEqual(["solana", "base"]);
    expect(config.projectionReplayEnabled).toBe(false);
    expect(report).toEqual({ ready: true, delivery: "disabled_outbox_only", failures: [] });
  });

  it("fails preflight without a usable collector", async () => {
    const config = parseScannerConfig({ ADDRESS_RADAR_DATABASE_PATH: "/data/address.sqlite", ADDRESS_RADAR_STRATEGY_VERSION: "address-v1" });
    const report = await runScannerPreflight({ config, filesystem: { writable: async () => true, exists: async () => false } });
    expect(report.ready).toBe(false);
    expect(report.failures).toContainEqual(expect.objectContaining({ code: "collector_unavailable" }));
  });
});
