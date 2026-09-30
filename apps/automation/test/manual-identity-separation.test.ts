import { DatabaseSync } from "node:sqlite";

import { createAutomationJobStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { describe, expect, it } from "vitest";

import {
  MANUAL_IDENTITY_MIGRATION_REASON,
  migrateManualIdentityAutomationJobs,
} from "../src/migrations/manual-identity-job-cleanup.js";

describe("manual identity automation separation", () => {
  it("cancels legacy identity jobs without affecting schedulable work", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue({
      jobId: "identity-1", idempotencyKey: "identity-1", lane: "repair",
      jobType: "identity_resolution", subjectKey: "handle-1", priority: 1,
      cursor: null, nextAttemptAt: 0, payload: "{}", createdAt: 1,
    });
    jobs.enqueue({
      jobId: "candidate-1", idempotencyKey: "candidate-1", lane: "trader_backfill",
      jobType: "candidate_evidence", subjectKey: "base:0xabc", priority: 1,
      cursor: null, nextAttemptAt: 0, payload: "{}", createdAt: 1,
    });

    expect(migrateManualIdentityAutomationJobs(database, 100)).toBe(1);
    expect(migrateManualIdentityAutomationJobs(database, 200)).toBe(0);
    expect(jobs.job("identity-1")).toMatchObject({
      status: "cancelled", lastError: MANUAL_IDENTITY_MIGRATION_REASON,
    });
    expect(jobs.claim("trader_backfill", 100, 1_000, "worker")).toMatchObject({ jobId: "candidate-1" });
    database.close();
  });
});
