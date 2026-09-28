import { DatabaseSync } from "node:sqlite";

import {
  createAutomationJobStore,
  createAutomationOutcomeStore,
  migrateAddressRadarDatabase,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

import { createAutomationScheduler, type AutomationExecutionResult } from "../src/scheduler.js";

function setup(result: AutomationExecutionResult | Error) {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  const jobs = createAutomationJobStore(database);
  const outcomes = createAutomationOutcomeStore(database);
  jobs.enqueue({
    jobId: "job-1",
    idempotencyKey: "job-1",
    lane: "token_mining",
    jobType: "test_job",
    subjectKey: "subject-1",
    priority: 1,
    cursor: null,
    nextAttemptAt: 0,
    payload: "{}",
    createdAt: 1,
  });
  const scheduler = createAutomationScheduler({
    enabled: true,
    store: jobs,
    outcomeStore: outcomes,
    handlers: [{
      jobType: "test_job",
      async execute() {
        if (result instanceof Error) throw result;
        return result;
      },
    }],
    workerId: "worker-1",
    now: () => 100,
  });
  return { database, jobs, outcomes, scheduler };
}

describe("automation job outcomes", () => {
  it("persists an explicit productive result", async () => {
    const { database, outcomes, scheduler } = setup({
      status: "completed",
      outcome: { status: "produced", inputCount: 4, producedCount: 2, deferredCount: 0 },
    });
    await scheduler.runOnce(new AbortController().signal);
    expect(outcomes.latestForJob("job-1")).toMatchObject({
      outcome: "produced", inputCount: 4, producedCount: 2,
    });
    database.close();
  });

  it("persists a deferred source reason", async () => {
    const { database, outcomes, scheduler } = setup({
      status: "waiting_source",
      sourceBlock: { reasonCode: "missing_early_trades", context: {}, recoveryJobIds: [] },
    });
    await scheduler.runOnce(new AbortController().signal);
    expect(outcomes.latestForJob("job-1")).toMatchObject({
      outcome: "deferred", reasonCode: "missing_early_trades", deferredCount: 1,
    });
    database.close();
  });

  it("persists thrown errors as failed attempts", async () => {
    const { database, outcomes, scheduler } = setup(new Error("provider unavailable"));
    await scheduler.runOnce(new AbortController().signal);
    expect(outcomes.latestForJob("job-1")).toMatchObject({
      outcome: "failed", reasonCode: "retryable_failure",
      diagnostic: { message: "provider unavailable" },
    });
    database.close();
  });
});
