import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createAutomationOutcomeStore, migrateAddressRadarDatabase } from "../src/index.js";

describe("automation outcome store", () => {
  it("records and replaces one durable outcome per attempt", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const store = createAutomationOutcomeStore(database);

    store.record({
      jobId: "job-1", jobType: "candidate_evidence", attempt: 1,
      outcome: "no_output", reasonCode: "missing_early_trades",
      inputCount: 3, diagnostic: { missing: 3 }, createdAt: 100,
    });
    store.record({
      jobId: "job-1", jobType: "candidate_evidence", attempt: 1,
      outcome: "produced", inputCount: 3, producedCount: 2, createdAt: 110,
    });

    expect(store.latestForJob("job-1")).toMatchObject({
      outcome: "produced", inputCount: 3, producedCount: 2, createdAt: 110,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_job_outcomes").get()).toMatchObject({ count: 1 });
    database.close();
  });

  it("rejects a produced outcome without facts", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const store = createAutomationOutcomeStore(database);
    expect(() => store.record({
      jobId: "job-2", jobType: "candidate_evidence", attempt: 1,
      outcome: "produced", producedCount: 0, createdAt: 100,
    })).toThrow("Produced outcomes require producedCount greater than zero");
    database.close();
  });
});
