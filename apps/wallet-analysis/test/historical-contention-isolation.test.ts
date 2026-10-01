import { afterEach, describe, expect, it, vi } from "vitest";
import { runHistoricalBackfillCycle } from "../src/historical-backfill.js";
import { runWalletAnalysisService } from "../src/service.js";
import { FileLockTimeoutError } from "../../../packages/collectors/src/fomo/durable-file.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const timeout = () => new FileLockTimeoutError("/tmp/token-lookups.lock",2000);

describe("historical contention isolation", () => {
  it("continues the scheduler when verification cannot acquire its request lock", async () => {
    const scheduler = { runOnce: vi.fn(async () => ({ processed: true })) };
    const result = await runHistoricalBackfillCycle({ verification: { runOnce: async () => { throw timeout(); } }, scheduler, signal: new AbortController().signal });
    expect(result).toMatchObject({ processed: true, contention: true });
    expect(scheduler.runOnce).toHaveBeenCalledOnce();
  });
  it("retains verification progress if the scheduler encounters SQLite contention", async () => {
    const result = await runHistoricalBackfillCycle({ verification: { runOnce: async () => ({ processed: true }) }, scheduler: { runOnce: async () => { throw Object.assign(new Error("locked"),{ errcode: 517 }); } }, signal: new AbortController().signal });
    expect(result).toMatchObject({ processed: true, contention: true });
  });
  it("does not suppress corruption or cleanup failures hidden inside aggregates", async () => {
    const failure = new AggregateError([timeout(),new Error("close failed")],"unsafe cleanup");
    const scheduler = { runOnce: vi.fn(async () => ({ processed: true })) };
    await expect(runHistoricalBackfillCycle({ verification: { runOnce: async () => { throw failure; } }, scheduler, signal: new AbortController().signal })).rejects.toBe(failure);
    expect(scheduler.runOnce).not.toHaveBeenCalled();
  });
  it("does not claim scheduler work after shutdown", async () => {
    const controller = new AbortController();
    const scheduler = { runOnce: vi.fn(async () => ({ processed: true })) };
    await expect(runHistoricalBackfillCycle({ verification: { runOnce: async () => { controller.abort(new Error("shutdown")); throw timeout(); } }, scheduler, signal: controller.signal })).rejects.toThrow("shutdown");
    expect(scheduler.runOnce).not.toHaveBeenCalled();
  });
  it("retries a typed request lock timeout rather than terminating the service", async () => {
    vi.useFakeTimers(); vi.spyOn(console,"warn").mockImplementation(() => {});
    const controller = new AbortController();
    const runOnce = vi.fn().mockRejectedValueOnce(timeout()).mockImplementationOnce(async () => { controller.abort(); return { processed: true }; });
    const work = runWalletAnalysisService({ signal: controller.signal, intervalMs: 10, runOnce });
    await vi.advanceTimersByTimeAsync(1000); await work;
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
  it("backs off partial cycles even when the other stage produced work", async () => {
    vi.useFakeTimers(); vi.spyOn(console,"warn").mockImplementation(() => {});
    const controller = new AbortController();
    const runOnce = vi.fn().mockResolvedValueOnce({ processed: true, contention: true }).mockImplementationOnce(async () => { controller.abort(); return { processed: true }; });
    const work = runWalletAnalysisService({ signal: controller.signal, intervalMs: 10, runOnce });
    await vi.advanceTimersByTimeAsync(999); expect(runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
