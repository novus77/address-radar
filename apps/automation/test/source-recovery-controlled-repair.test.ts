import { describe, expect, it } from "vitest";
import { openAddressRadarDatabase, migrateAddressRadarDatabase, createSourceLedgerStore } from "@address-radar/database";
import { reconcileSourceRecoveryV2 } from "../src/migrations/reconcile-source-recovery-v2.js";
describe("controlled recovery repair", () => {
  it("does not write on dry run and preserves the old record once on apply", () => {
    const db = openAddressRadarDatabase(":memory:");
    try {
      migrateAddressRadarDatabase(db);
      const ledger = createSourceLedgerStore(db);
      ledger.enqueueRecoveryJob({ jobId: "old", jobType: "historical_research", chain: "solana", subjectKey: "solana:token", priority: 1, cursor: null, nextAttemptAt: 1, createdAt: 1 });
      db.prepare("UPDATE recovery_jobs SET status='dead_letter',last_error='historical_milestone_crossing_unavailable' WHERE job_id='old'").run();
      expect(reconcileSourceRecoveryV2({ database: db, jobIds: ["old"] })).toMatchObject({ eligible: ["old"], reopened: 0 });
      expect(ledger.recoveryJob("old")?.status).toBe("dead_letter");
      expect(reconcileSourceRecoveryV2({ database: db, jobIds: ["old"], dryRun: false, now: 2 }).reopened).toBe(1);
      expect(reconcileSourceRecoveryV2({ database: db, jobIds: ["old"], dryRun: false, now: 3 }).reopened).toBe(0);
      expect(db.prepare("SELECT count(*) n FROM source_recovery_repair_audit").get()).toEqual({ n: 1 });
      expect(ledger.recoveryJob("old")).toMatchObject({ status: "pending", nextAttemptAt: 2 });
      expect(() => reconcileSourceRecoveryV2({ database: db, jobIds: Array.from({ length: 21 }, (_, i) => String(i)) })).toThrow();
    } finally { db.close(); }
  });
});
