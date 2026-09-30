import { afterEach, describe, expect, it } from "vitest";
import { createSourceLedgerStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("recovery type fairness", () => {
  it("gives a sparse ready type a turn despite older history backlog", async () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const ledger = createSourceLedgerStore(database);
    let now = 10_000;
    for (let index = 0; index < 20; index += 1) {
      ledger.enqueueRecoveryJob({ jobId: `history:${index}`, jobType: "historical_research", chain: "base", subjectKey: `base:token:${index}`, priority: 1, cursor: null, nextAttemptAt: 1, createdAt: 1 });
    }
    ledger.enqueueRecoveryJob({ jobId: "market", jobType: "market_enrichment", chain: "base", subjectKey: "base:market", priority: 50, cursor: null, nextAttemptAt: 9_000, createdAt: 9_000 });
    const runtime = createRecoveryRuntime({ ledger, clock: { now: () => now }, handlers: { historical_research: () => undefined, market_enrichment: () => undefined } });
    await runtime.runOnce();
    now += 1;
    await expect(runtime.runOnce()).resolves.toMatchObject({ jobId: "market", outcome: "completed" });
  });
});
