import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createAutomationJobStore, migrateAddressRadarDatabase } from "@address-radar/database";
import {
  reconcileTokenEvidencePipelineV1,
  TOKEN_EVIDENCE_RECONCILIATION_REASON,
} from "../src/migrations/reconcile-token-evidence-pipeline-v1.js";

describe("token evidence pipeline reconciliation", () => {
  it("coalesces legacy active jobs into one revisioned request and remains idempotent", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const jobs = createAutomationJobStore(database);
    for (let index = 0; index < 3; index += 1) jobs.enqueue({
      jobId: `legacy-${index}`,
      idempotencyKey: `candidate-evidence:event-${index}`,
      lane: "token_mining",
      jobType: "candidate_evidence",
      subjectKey: "bsc:0xtoken",
      priority: 80,
      cursor: null,
      nextAttemptAt: 100 + index,
      payload: JSON.stringify({ tokenId: "bsc:0xtoken", evaluatedAt: 100 + index }),
      createdAt: 100 + index,
    });

    expect(reconcileTokenEvidencePipelineV1({ database, dryRun: true, now: () => 200 })).toMatchObject({
      examinedSubjects: 1,
      legacyActiveJobs: 3,
      cancelledJobs: 0,
      requestsSeeded: 0,
      jobsEnqueued: 0,
    });
    expect(reconcileTokenEvidencePipelineV1({ database, dryRun: false, now: () => 200 })).toMatchObject({
      examinedSubjects: 1,
      legacyActiveJobs: 3,
      cancelledJobs: 3,
      requestsSeeded: 1,
      jobsEnqueued: 1,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs WHERE status='cancelled' AND last_error=?`).get(TOKEN_EVIDENCE_RECONCILIATION_REASON)).toEqual({ count: 3 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM automation_jobs WHERE status='pending' AND idempotency_key LIKE 'candidate-evidence:candidate-evidence-v2:%'`).get()).toEqual({ count: 1 });
    expect(database.prepare(`SELECT requested_revision AS requestedRevision,processed_revision AS processedRevision FROM candidate_evaluation_requests`).get()).toEqual({ requestedRevision: 1, processedRevision: 0 });
    expect(reconcileTokenEvidencePipelineV1({ database, dryRun: false, now: () => 300 })).toMatchObject({ examinedSubjects: 0, cancelledJobs: 0, requestsSeeded: 0, jobsEnqueued: 0 });
    database.close();
  });

  it("does not cancel a legacy job with an active lease", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue({ jobId: "legacy-running", idempotencyKey: "candidate-evidence:running", lane: "token_mining", jobType: "candidate_evidence", subjectKey: "eth:0xtoken", priority: 80, cursor: null, nextAttemptAt: 100, payload: "{}", createdAt: 100 });
    jobs.claim("token_mining", 100, 60_000, "worker", ["candidate_evidence"]);

    expect(reconcileTokenEvidencePipelineV1({ database, dryRun: false, now: () => 200 })).toMatchObject({
      skippedInFlightSubjects: 1,
      cancelledJobs: 0,
      jobsEnqueued: 0,
    });
    expect(database.prepare("SELECT status FROM automation_jobs WHERE job_id='legacy-running'").get()).toEqual({ status: "leased" });
    database.close();
  });
});
