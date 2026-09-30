import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceLedgerStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { vi.useRealTimers(); while (databases.length) databases.pop()!.close(); });

describe("recovery deadline", () => {
  it("aborts a stalled handler and fences its late checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const ledger = createSourceLedgerStore(database);
    ledger.enqueueRecoveryJob({ jobId: "gap", jobType: "rpc_gap", chain: "base", subjectKey: "base:token", priority: 1, cursor: null, nextAttemptAt: 10_000, createdAt: 10_000 });
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    let lateWriteRejected = false;
    const runtime = createRecoveryRuntime({ ledger, clock: { now: Date.now }, deadlineMs: 100, handlers: {
      rpc_gap: async context => {
        signal = context.signal;
        await new Promise<void>(resolve => { finish = resolve; });
        try { context.checkpoint("late"); } catch { lateWriteRejected = true; }
      },
    } });
    const pending = runtime.runOnce();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({ outcome: "retry" });
    expect(signal?.aborted).toBe(true);
    finish();
    await Promise.resolve();
    expect(lateWriteRejected).toBe(true);
    expect(ledger.recoveryJob("gap")).toMatchObject({ status: "failed", cursor: null, lastError: "recovery_deadline_exceeded" });
  });

  it("rejects results after another worker acquires the expired lease", async () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const ledger = createSourceLedgerStore(database);
    let now = 10_000;
    ledger.enqueueRecoveryJob({ jobId: "gap", jobType: "rpc_gap", chain: "base", subjectKey: "base:token", priority: 1, cursor: null, nextAttemptAt: now, createdAt: now });
    const runtime = createRecoveryRuntime({ ledger, clock: { now: () => now }, deadlineMs: 100, leaseMs: 100, handlers: {
      rpc_gap: () => { now += 6_000; ledger.claimRecoveryJob(now, 10_000); },
    } });
    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
    expect(ledger.recoveryJob("gap")).toMatchObject({ status: "running", attemptCount: 2 });
  });
});
