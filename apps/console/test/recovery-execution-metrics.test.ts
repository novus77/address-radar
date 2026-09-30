import { describe, expect, it } from "vitest";
import { createSourceLedgerStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { recoveryExecutionMetrics } from "../src/recovery-execution-metrics.js";

describe("independent recovery metrics", () => {
  it("shows recovery backlog even without runnable automation jobs", () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    try {
      createSourceLedgerStore(database).enqueueRecoveryJob({ jobId: "history", jobType: "historical_research", chain: "base", subjectKey: "base:token", priority: 1, cursor: null, nextAttemptAt: 100, createdAt: 100 });
      expect(recoveryExecutionMetrics(database, 1_000)).toMatchObject({ runnable: 1, completed: 0, attempts30m: 0, oldestDueAgeMs: 900 });
    } finally { database.close(); }
  });
});
