import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAutomationJobStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";
import type { AutomationLane } from "@address-radar/domain";
import { describe, expect, it } from "vitest";

import {
  allocateMinimumChainSlots,
  createAutomationScheduler,
  type AutomationHandler,
} from "../src/scheduler.js";

const setup = () => {
  const path = join(mkdtempSync(join(tmpdir(), "automation-scheduler-")), "radar.sqlite");
  const database = openAddressRadarDatabase(path);
  migrateAddressRadarDatabase(database);
  return { database, store: createAutomationJobStore(database) };
};

const enqueue = (
  store: ReturnType<typeof createAutomationJobStore>,
  jobId: string,
  lane: AutomationLane,
  jobType = "complete",
) => store.enqueue({
  jobId,
  idempotencyKey: `key:${jobId}`,
  lane,
  jobType,
  subjectKey: jobId,
  priority: 10,
  cursor: null,
  nextAttemptAt: 0,
  payload: "{}",
  createdAt: 1,
});

const completeHandler: AutomationHandler = {
  jobType: "complete",
  async execute() {
    return { status: "completed" };
  },
};

describe("automation scheduler", () => {
  it("keeps execution disabled while still exposing queue snapshots", async () => {
    const { database, store } = setup();
    enqueue(store, "disabled", "trader_backfill");
    const scheduler = createAutomationScheduler({
      enabled: false,
      store,
      handlers: [completeHandler],
      workerId: "worker-a",
      now: () => 10,
    });

    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      executed: false,
      snapshot: { pending: 1, leased: 0 },
    });
    expect(store.job("disabled")).toMatchObject({ status: "pending" });
    database.close();
  });

  it("leaves disabled job types pending while executing an allowed type", async () => {
    const { database, store } = setup();
    enqueue(store, "blocked", "trader_backfill", "blocked");
    enqueue(store, "allowed", "token_mining", "complete");
    const scheduler = createAutomationScheduler({
      enabled: true,
      enabledJobTypes: ["complete"],
      store,
      handlers: [completeHandler],
      workerId: "worker-a",
      now: () => 10,
    });

    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      executed: true,
      jobId: "allowed",
      status: "completed",
    });
    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      executed: false,
    });
    expect(store.job("blocked")).toMatchObject({ status: "pending", attemptCount: 0 });
    database.close();
  });

  it("allocates completed work in a persistent 40/40/20 ratio", async () => {
    const { database, store } = setup();
    for (let index = 0; index < 40; index += 1) enqueue(store, `trader-${index}`, "trader_backfill");
    for (let index = 0; index < 40; index += 1) enqueue(store, `token-${index}`, "token_mining");
    for (let index = 0; index < 20; index += 1) enqueue(store, `repair-${index}`, "repair");
    let now = 10;
    const scheduler = createAutomationScheduler({
      enabled: true,
      store,
      handlers: [completeHandler],
      workerId: "worker-a",
      now: () => now++,
    });
    const lanes: AutomationLane[] = [];
    for (let index = 0; index < 100; index += 1) {
      const result = await scheduler.runOnce(new AbortController().signal);
      if (result.lane) lanes.push(result.lane);
    }

    expect(lanes.filter((lane) => lane === "trader_backfill")).toHaveLength(40);
    expect(lanes.filter((lane) => lane === "token_mining")).toHaveLength(40);
    expect(lanes.filter((lane) => lane === "repair")).toHaveLength(20);
    database.close();
  });

  it("carries unused lane credits forward and reclaims expired leases", async () => {
    const { database, store } = setup();
    for (let index = 0; index < 5; index += 1) enqueue(store, `repair-${index}`, "repair");
    let now = 10;
    const scheduler = createAutomationScheduler({
      enabled: true,
      store,
      handlers: [completeHandler],
      workerId: "worker-a",
      now: () => now,
      leaseMs: 10,
    });
    for (let index = 0; index < 5; index += 1) {
      await scheduler.runOnce(new AbortController().signal);
      now += 1;
    }
    enqueue(store, "stale-trader", "trader_backfill");
    store.claim("trader_backfill", now, 10, "dead-worker");
    enqueue(store, "token-after-gap", "token_mining");
    now += 11;

    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      lane: "trader_backfill",
      status: "completed",
    });
    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      lane: "token_mining",
      status: "completed",
    });
    database.close();
  });

  it("isolates a handler failure to its job and continues another lane", async () => {
    const { database, store } = setup();
    enqueue(store, "broken", "trader_backfill", "broken");
    enqueue(store, "healthy", "token_mining");
    const brokenHandler: AutomationHandler = {
      jobType: "broken",
      async execute() {
        throw new Error("provider unavailable");
      },
    };
    const scheduler = createAutomationScheduler({
      enabled: true,
      store,
      handlers: [completeHandler, brokenHandler],
      workerId: "worker-a",
      now: () => 100,
    });

    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      jobId: "broken",
      status: "retryable",
    });
    await expect(scheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({
      jobId: "healthy",
      status: "completed",
    });
    database.close();
  });

  it("reserves one slot for every non-empty target chain", () => {
    expect(allocateMinimumChainSlots(
      ["solana", "bsc", "eth", "base", "robinhood"],
      7,
    )).toEqual({ solana: 2, bsc: 2, eth: 1, base: 1, robinhood: 1 });
    expect(() => allocateMinimumChainSlots(["solana", "bsc"], 1))
      .toThrow(/at least one slot/i);
  });
});
