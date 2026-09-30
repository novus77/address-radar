import { afterEach, describe, expect, it } from "vitest";
import { createSourceLedgerStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime, WaitingRecoveryResultError } from "../src/recovery-runtime.js";
import { parseRecoveryHandoff } from "../src/recovery-handoff.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
describe("durable early trade handoff", () => {
  it("preserves the submitted request identity across a waiting retry", async () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const ledger = createSourceLedgerStore(database);
    ledger.enqueueRecoveryJob({ jobId: "early", jobType: "milestone_early_buyers", chain: "base", subjectKey: "base:token", priority: 35, cursor: null, nextAttemptAt: 10_000, createdAt: 10_000 });
    const handoff = { kind: "fomo_milestone_lookup", lookupId: "lookup", milestoneId: "milestone", beforeAt: 9_000, submittedAt: 10_000, checkAt: 40_000 } as const;
    const runtime = createRecoveryRuntime({ ledger, clock: { now: () => 10_000 }, handlers: {
      milestone_early_buyers: context => { context.checkpoint(JSON.stringify(handoff)); throw new WaitingRecoveryResultError("waiting_result", 40_000); },
    } });
    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
    expect(ledger.recoveryJob("early")).toMatchObject({ status: "failed", nextAttemptAt: 40_000, updatedAt: 10_000 });
    expect(parseRecoveryHandoff(ledger.recoveryJob("early")!.cursor)).toEqual(handoff);
  });
  it("rejects malformed or incompatible cursors", () => {
    expect(parseRecoveryHandoff("not-json")).toBeNull();
    expect(parseRecoveryHandoff(JSON.stringify({ kind: "fomo_milestone_lookup", lookupId: "lookup", milestoneId: "m", beforeAt: -1 }))).toBeNull();
  });
});
