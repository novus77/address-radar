import { afterEach, describe, expect, it, vi } from "vitest";
import { runWalletAnalysisService } from "../src/service.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("wallet analysis service contention", () => {
  it.each([5, 6, 517])("survives SQLite contention code %s and retries", async errcode => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const runOnce = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("database is locked"), { errcode }))
      .mockImplementationOnce(async () => { controller.abort(); return { processed: true }; });
    const work = runWalletAnalysisService({ signal: controller.signal, intervalMs: 10, runOnce });
    await vi.advanceTimersByTimeAsync(1_000);
    await work;
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("does not swallow unrelated failures", async () => {
    const error = new Error("invalid schema");
    await expect(runWalletAnalysisService({ signal: new AbortController().signal, intervalMs: 10, runOnce: async () => { throw error; } })).rejects.toBe(error);
  });

  it("allows shutdown during contention backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const runOnce = vi.fn().mockRejectedValue(Object.assign(new Error("locked"), { errcode: 5 }));
    const work = runWalletAnalysisService({ signal: controller.signal, intervalMs: 10, runOnce });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await work;
    expect(runOnce).toHaveBeenCalledTimes(1);
  });
});
