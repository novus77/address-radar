import { describe, expect, it, vi } from "vitest";
import { createSourceLedgerStore, migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";
import { reconcileCandidateSourceRecovery } from "../src/source-recovery-handlers.js";

describe("startup recovery contention", () => {
  it("retries a busy reconciliation statement without crashing startup", () => {
    const database = openAddressRadarDatabase(":memory:");
    try {
      migrateAddressRadarDatabase(database);
      const prepare = database.prepare.bind(database);
      let updates = 0;
      const spy = vi.spyOn(database, "prepare").mockImplementation(sql => {
        if (sql.includes("UPDATE automation_job_blocks") && updates++ === 0) {
          throw Object.assign(new Error("database is locked"), { errcode: 5 });
        }
        return prepare(sql);
      });
      expect(reconcileCandidateSourceRecovery({ database, ledger: createSourceLedgerStore(database), now: () => 100 })).toEqual({ resolvedBlocks: 0, enqueued: 0 });
      expect(updates).toBe(2);
      expect(database.isTransaction).toBe(false);
      spy.mockRestore();
    } finally { vi.restoreAllMocks(); database.close(); }
  });
});
