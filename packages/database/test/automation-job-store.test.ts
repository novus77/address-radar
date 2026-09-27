import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAutomationJobStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "../src/index.js";

const setup = () => {
  const path = join(mkdtempSync(join(tmpdir(), "automation-job-store-")), "radar.sqlite");
  const database = openAddressRadarDatabase(path);
  migrateAddressRadarDatabase(database);
  return { database, path, store: createAutomationJobStore(database) };
};

const job = (
  jobId: string,
  lane: "trader_backfill" | "token_mining" | "repair" = "trader_backfill",
  overrides: Record<string, unknown> = {},
) => ({
  jobId,
  idempotencyKey: `key:${jobId}`,
  lane,
  jobType: "test_job",
  subjectKey: `subject:${jobId}`,
  priority: 10,
  cursor: "page-1",
  nextAttemptAt: 0,
  payload: "{}",
  createdAt: 1,
  ...overrides,
});

describe("automation job store", () => {
  it("migrates legacy waiting_source jobs into the non-polling blocked state", () => {
    const { database, store } = setup();
    store.enqueue(job("legacy-waiting"));
    database.prepare("UPDATE automation_jobs SET status = 'waiting_source' WHERE job_id = ?").run("legacy-waiting");

    migrateAddressRadarDatabase(database);

    expect(store.job("legacy-waiting")).toMatchObject({ status: "blocked_source" });
    database.close();
  });

  it("reports active backlog by job type for producer backpressure", () => {
    const { database, store } = setup();
    store.enqueue(job("one", "trader_backfill", { jobType: "candidate_evidence" }));
    store.enqueue(job("two", "trader_backfill", { jobType: "candidate_evidence" }));
    store.enqueue(job("other", "trader_backfill", { jobType: "ability_evaluation" }));
    expect(store.activeCount("candidate_evidence")).toBe(2);
    database.close();
  });

  it("rotates across job types before returning to a large backlog", () => {
    const { database, store } = setup();
    store.enqueue(job("light-1", "trader_backfill", { jobType: "trader_lightweight_evaluation", priority: 10 }));
    store.enqueue(job("light-2", "trader_backfill", { jobType: "trader_lightweight_evaluation", priority: 10 }));
    store.enqueue(job("ability", "trader_backfill", { jobType: "ability_evaluation", priority: 80 }));

    const first = store.claim("trader_backfill", 10, 100, "worker-a");
    expect(first?.jobType).toBe("trader_lightweight_evaluation");
    store.complete(first!.jobId, "worker-a", { cursor: null, completedAt: 11 });
    expect(store.claim("trader_backfill", 12, 100, "worker-a")?.jobType).toBe("ability_evaluation");
    database.close();
  });

  it("blocks source-dependent jobs until their subject is explicitly awakened", () => {
    const { database, store } = setup();
    store.enqueue(job("blocked", "trader_backfill", { subjectKey: "base:0xabc", jobType: "candidate_evidence" }));
    store.claim("trader_backfill", 10, 100, "worker-a");
    store.waitForSource("blocked", "worker-a", {
      diagnostic: "price history missing",
      reasonCode: "missing_market_history",
      context: { tokenId: "base:0xabc" },
      recoveryJobIds: ["recovery:market_enrichment:base:0xabc"],
      retryAt: 20,
      updatedAt: 10,
    });

    expect(store.job("blocked")).toMatchObject({ status: "blocked_source" });
    expect(store.sourceBlock("blocked")).toMatchObject({
      reasonCode: "missing_market_history",
      context: { tokenId: "base:0xabc" },
      recoveryJobIds: ["recovery:market_enrichment:base:0xabc"],
      resolvedAt: null,
    });
    expect(store.claim("trader_backfill", 1_000, 100, "worker-a")).toBeNull();
    expect(store.wakeBlockedSource("base:0xabc", 1_001, "candidate_evidence")).toBe(1);
    expect(store.sourceBlock("blocked")).toMatchObject({ resolvedAt: 1_001 });
    expect(store.claim("trader_backfill", 1_001, 100, "worker-a")).toMatchObject({ jobId: "blocked" });
    database.close();
  });

  it("deduplicates jobs by stable idempotency key", () => {
    const { database, store } = setup();
    expect(store.enqueue(job("job-1"))).toMatchObject({ inserted: true, job: { jobId: "job-1" } });
    expect(store.enqueue(job("job-2", "trader_backfill", { idempotencyKey: "key:job-1" })))
      .toMatchObject({ inserted: false, job: { jobId: "job-1" } });
    database.close();
  });

  it("leases only due jobs from the requested resource lane", () => {
    const { database, store } = setup();
    store.enqueue(job("token", "token_mining"));
    store.enqueue(job("future", "trader_backfill", { nextAttemptAt: 1_000 }));
    store.enqueue(job("trader", "trader_backfill"));

    expect(store.claim("trader_backfill", 10, 100, "worker-a")).toMatchObject({
      jobId: "trader",
      lane: "trader_backfill",
      status: "leased",
      attemptCount: 1,
      leaseExpiresAt: 110,
    });
    expect(store.claim("trader_backfill", 10, 100, "worker-a")).toBeNull();
    database.close();
  });

  it("reclaims an expired lease after worker failure", () => {
    const { database, path, store } = setup();
    store.enqueue(job("restart"));
    expect(store.claim("trader_backfill", 10, 20, "worker-a")).toMatchObject({
      attemptCount: 1,
      leaseExpiresAt: 30,
    });
    database.close();

    const resumedDatabase = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(resumedDatabase);
    const resumed = createAutomationJobStore(resumedDatabase);
    expect(resumed.claim("trader_backfill", 31, 20, "worker-b")).toMatchObject({
      jobId: "restart",
      attemptCount: 2,
      leaseExpiresAt: 51,
    });
    resumedDatabase.close();
  });

  it("does not advance a cursor before successful completion", () => {
    const { database, store } = setup();
    store.enqueue(job("cursor"));
    store.claim("trader_backfill", 10, 100, "worker-a");
    store.retry("cursor", "worker-a", { error: "temporary", now: 20 });
    expect(store.job("cursor")).toMatchObject({ cursor: "page-1", status: "retryable" });

    const retryAt = store.job("cursor")!.nextAttemptAt;
    store.claim("trader_backfill", retryAt, 100, "worker-b");
    store.complete("cursor", "worker-b", { cursor: "page-2", completedAt: retryAt + 1 });
    expect(store.job("cursor")).toMatchObject({ cursor: "page-2", status: "completed" });
    database.close();
  });

  it("schedules retry with exponential backoff and source retry-after", () => {
    const { database } = setup();
    const store = createAutomationJobStore(database, { baseRetryDelayMs: 1_000 });
    store.enqueue(job("retry"));
    store.claim("trader_backfill", 10, 100, "worker-a");
    store.retry("retry", "worker-a", { error: "rate_limited", now: 100, retryAfterAt: 500 });
    expect(store.job("retry")).toMatchObject({ nextAttemptAt: 1_100, status: "retryable" });

    store.claim("trader_backfill", 1_100, 100, "worker-b");
    store.retry("retry", "worker-b", { error: "rate_limited", now: 1_200, retryAfterAt: 5_000 });
    expect(store.job("retry")).toMatchObject({ nextAttemptAt: 5_000, attemptCount: 2 });
    database.close();
  });

  it("preserves terminal audit records", () => {
    const { database, store } = setup();
    store.enqueue(job("terminal"));
    store.claim("trader_backfill", 10, 100, "worker-a");
    store.terminate("terminal", "worker-a", { reason: "invalid_subject", terminatedAt: 20 });

    expect(store.job("terminal")).toMatchObject({
      status: "terminal",
      lastError: "invalid_subject",
      completedAt: 20,
    });
    expect(store.claim("trader_backfill", 1_000, 100, "worker-b")).toBeNull();
    database.close();
  });

  it("selects resource lanes with persistent 40/40/20 credits", () => {
    const { database, store } = setup();
    const selections = Array.from({ length: 100 }, (_, index) =>
      store.selectLane(["trader_backfill", "token_mining", "repair"], index + 1));
    expect(selections.filter((lane) => lane === "trader_backfill")).toHaveLength(40);
    expect(selections.filter((lane) => lane === "token_mining")).toHaveLength(40);
    expect(selections.filter((lane) => lane === "repair")).toHaveLength(20);
    database.close();
  });
});
