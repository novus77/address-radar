import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createAutomationJobStore, migrateAddressRadarDatabase } from "@address-radar/database";

import { createQueueAdmissionPolicy } from "../src/queue-policy.js";

function createStore(options: Parameters<typeof createAutomationJobStore>[1] = {}) {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  return { database, store: createAutomationJobStore(database, options) };
}

function enqueue(store: ReturnType<typeof createAutomationJobStore>, id: string, jobType: string, createdAt = 0) {
  store.enqueue({
    jobId: id,
    idempotencyKey: id,
    lane: "token_mining",
    jobType,
    subjectKey: id,
    priority: 10,
    cursor: null,
    nextAttemptAt: createdAt,
    payload: "{}",
    createdAt,
  });
}

describe("automation queue convergence", () => {
  it("pauses historical admission at a per-type high-water mark without pausing live work", () => {
    const { database, store } = createStore();
    for (let index = 0; index < 3; index += 1) enqueue(store, `history-${index}`, "token_mining");
    enqueue(store, "live", "candidate_evidence");
    const policy = createQueueAdmissionPolicy({
      policies: {
        token_mining: { highWaterMark: 3, concurrencyLimit: 1, retryBudget: 2, workload: "historical" },
        candidate_evidence: { highWaterMark: 1, concurrencyLimit: 1, retryBudget: 2, workload: "live" },
      },
    });

    expect(policy.evaluate(store.metrics(1, 60_000))).toMatchObject({
      admitHistorical: false,
      reason: "high_water_mark",
    });
    expect(store.claim("token_mining", 1, 100, "worker", ["candidate_evidence"])?.jobId).toBe("live");
    database.close();
  });

  it("defers a retry-heavy job after its retry budget is exhausted", () => {
    const { database, store } = createStore({ retryBudgetByJobType: { unstable: 2 } });
    enqueue(store, "unstable-job", "unstable");
    store.claim("token_mining", 0, 100, "worker-1");
    store.retry("unstable-job", "worker-1", { error: "temporary", now: 1 });
    const retryAt = store.job("unstable-job")!.nextAttemptAt;
    store.claim("token_mining", retryAt, 100, "worker-2");
    store.retry("unstable-job", "worker-2", { error: "still_unavailable", now: retryAt + 1 });

    expect(store.job("unstable-job")).toMatchObject({
      status: "waiting_source",
      lastError: "retry_budget_exhausted:still_unavailable",
    });
    expect(store.metrics(retryAt + 2, 60_000).deferred).toBe(1);
    database.close();
  });

  it("enforces per-type concurrency while allowing another type in the same lane", () => {
    const { database, store } = createStore({ concurrencyLimitByJobType: { crowded: 1, other: 1 } });
    enqueue(store, "crowded-1", "crowded");
    enqueue(store, "crowded-2", "crowded");
    enqueue(store, "other-1", "other");

    expect(store.claim("token_mining", 0, 100, "worker-1")?.jobType).toBe("crowded");
    expect(store.claim("token_mining", 0, 100, "worker-2")?.jobType).toBe("other");
    database.close();
  });

  it("recognizes convergence when completions exceed admissions and runnable age falls", () => {
    const { database, store } = createStore();
    enqueue(store, "one", "token_mining", 10);
    enqueue(store, "two", "token_mining", 10);
    const policy = createQueueAdmissionPolicy();
    policy.evaluate(store.metrics(20, 100));
    for (const [index, id] of ["one", "two"].entries()) {
      store.claim("token_mining", 20 + index, 100, `worker-${index}`);
      store.complete(id, `worker-${index}`, { cursor: null, completedAt: 30 + index });
    }

    expect(policy.evaluate(store.metrics(40, 20))).toMatchObject({
      converging: true,
      runnableDelta: -2,
    });
    database.close();
  });
});
