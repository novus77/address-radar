import { afterEach, describe, expect, it } from "vitest";

import {
  createSourceLedgerStore,
  initializeSourceLedgerSchema,
  openAddressRadarDatabase,
  type RecoveryJobType,
} from "@address-radar/database";
import {
  createRecoveryRuntime,
  RetryableRecoveryError,
  TerminalRecoveryError,
} from "../src/recovery-runtime.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];

function setup(now = 10_000) {
  const database = openAddressRadarDatabase(":memory:");
  databases.push(database);
  initializeSourceLedgerSchema(database);
  const ledger = createSourceLedgerStore(database);
  const enqueue = (jobId: string, jobType: RecoveryJobType, priority: number) => ledger.enqueueRecoveryJob({
    jobId,
    jobType,
    chain: "base",
    subjectKey: `${jobType}:subject`,
    priority,
    cursor: null,
    nextAttemptAt: now,
    createdAt: now,
  });
  return { ledger, enqueue };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("durable recovery runtime", () => {
  it("claims the highest-priority eligible job", async () => {
    const { ledger, enqueue } = setup();
    enqueue("history", "historical_research", 60);
    enqueue("gap", "rpc_gap", 10);
    const handled: string[] = [];
    const runtime = createRecoveryRuntime({
      ledger,
      clock: { now: () => 10_000 },
      handlers: { rpc_gap: async context => { handled.push(context.job.jobId); } },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ jobId: "gap", outcome: "completed" });
    expect(handled).toEqual(["gap"]);
    expect(ledger.recoveryJob("history")?.status).toBe("pending");
  });

  it("retries provider failures without losing the job", async () => {
    const { ledger, enqueue } = setup();
    enqueue("market", "market_enrichment", 20);
    const runtime = createRecoveryRuntime({
      ledger,
      clock: { now: () => 10_000 },
      retryBaseMs: 500,
      handlers: { market_enrichment: async () => { throw new RetryableRecoveryError("provider_timeout"); } },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ jobId: "market", outcome: "retry" });
    expect(ledger.recoveryJob("market")).toMatchObject({ status: "failed", nextAttemptAt: 10_500, lastError: "provider_timeout" });
  });

  it("dead-letters terminal identity conflicts", async () => {
    const { ledger, enqueue } = setup();
    enqueue("identity", "identity_resolution", 40);
    const runtime = createRecoveryRuntime({
      ledger,
      clock: { now: () => 10_000 },
      handlers: { identity_resolution: async () => { throw new TerminalRecoveryError("identity_conflict"); } },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "dead_letter" });
    expect(ledger.recoveryJob("identity")?.status).toBe("dead_letter");
  });

  it("resumes a job after an expired lease", async () => {
    const { ledger, enqueue } = setup();
    enqueue("gap", "rpc_gap", 10);
    expect(ledger.claimRecoveryJob(10_000, 100)?.status).toBe("running");
    const runtime = createRecoveryRuntime({
      ledger,
      clock: { now: () => 10_101 },
      handlers: { rpc_gap: async () => undefined },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ jobId: "gap", outcome: "completed" });
    expect(ledger.recoveryJob("gap")?.attemptCount).toBe(2);
  });

  it("contains Dune budget exhaustion to historical research", async () => {
    const { ledger, enqueue } = setup();
    enqueue("history", "historical_research", 60);
    const runtime = createRecoveryRuntime({
      ledger,
      clock: { now: () => 10_000 },
      handlers: {
        historical_research: async context => {
          context.consumeBudget({ provider: "dune", usageWindow: "2026-09-26", units: 2, limit: 1, retryAt: 20_000 });
        },
      },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "budget_exhausted" });
    expect(ledger.recoveryJob("history")).toMatchObject({ status: "failed", nextAttemptAt: 20_000 });
    expect(ledger.budgetUsage("dune", "2026-09-26")).toBe(0);
  });
});
