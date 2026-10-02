import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createAutomationJobStore, migrateAddressRadarDatabase } from "../src/index.js";

it("retains capacity-blocked jobs across restart and promotes them without losing audit", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateAddressRadarDatabase(db);
    let store = createAutomationJobStore(db);
    expect(store.enqueueBounded).toBeTypeOf("function");
    const input = (id: string) => ({ jobId: id, idempotencyKey: id, jobType: "ability_evaluation",
      lane: "trader_backfill" as const, subjectKey: id, priority: 76, cursor: null,
      nextAttemptAt: 1, payload: "{}", createdAt: 1 });
    store.enqueue(input("busy"));
    expect(store.enqueueBounded!(input("waiting"), 1)).toMatchObject({ deferred: true, job: null });
    expect(store.enqueueBounded!(input("waiting"), 1)).toMatchObject({ deferred: true });
    expect(store.activeCount("ability_evaluation")).toBe(1);
    expect(db.prepare("SELECT count(*) n FROM automation_admission_intents").get()).toEqual({ n: 1 });
    const first = store.claim("trader_backfill", 10, 100, "worker")!;
    store.complete(first.jobId, "worker", { cursor: null, completedAt: 11 });
    store = createAutomationJobStore(db);
    expect(store.claim("trader_backfill", 12, 100, "worker")).toMatchObject({ jobId: "waiting" });
    expect(db.prepare("SELECT admitted_job_id FROM automation_admission_intents").get()).toEqual({ admitted_job_id: "waiting" });
  } finally { db.close(); }
});

it("does not let a busy owner hide an eligible later admission", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateAddressRadarDatabase(db);
    const store = createAutomationJobStore(db);
    expect(store.enqueueBounded).toBeTypeOf("function");
    const input = (id: string, subject = id) => ({ jobId: id, idempotencyKey: id, jobType: "ability_evaluation",
      lane: "trader_backfill" as const, subjectKey: subject, priority: 76, cursor: null,
      nextAttemptAt: 1, payload: "{}", createdAt: 1 });
    store.enqueue(input("busy"));
    store.enqueueBounded!(input("busy-correction", "busy"), 2);
    store.enqueueBounded!(input("later"), 1);
    expect(store.claim("trader_backfill", 10, 100, "worker")).toMatchObject({ jobId: "busy" });
    store.complete("busy", "worker", { cursor: null, completedAt: 11 });
    const next = store.claim("trader_backfill", 12, 100, "worker")!;
    expect(next.jobId).toBe("busy-correction");
    expect(store.activeCount("ability_evaluation")).toBe(1);
    store.complete(next.jobId, "worker", { cursor: null, completedAt: 13 });
    expect(store.claim("trader_backfill", 14, 100, "worker")).toMatchObject({ jobId: "later" });
  } finally { db.close(); }
});
