import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationJobStore, createFactDemandStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { reconcileConsumerHistoryWakeups } from "../src/consumer-history-wakeup.js";

const databases: DatabaseSync[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
const fixture = () => {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database); databases.push(database);
  const demands = createFactDemandStore(database);
  for (const id of ["a", "b"]) demands.record({ demandId: id, consumerId: id, purchaseId: `buy:${id}`,
    tokenId: "base:0xabc", strategyVersion: "trader-ability-v4-opportunity", purpose: "positive_hit",
    requiredFrom: 1000, requiredTo: 5000, evaluatedAt: 10000, reasonCode: "market_range_missing", proof: null });
  const jobs = createAutomationJobStore(database);
  const run = () => reconcileConsumerHistoryWakeups({ database, jobs, now: () => 10000 });
  const price = (value: number, observedAt = 2000) => database.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES ('base','0xabc',?,?,'test')").run(observedAt,value);
  return { database, jobs, run, price };
};

describe("consumer history semantic wakeups", () => {
  it("wakes wallet-only consumers once when real price facts arrive", () => {
    const { database, run, price } = fixture();
    expect(run()).toMatchObject({ dispatched: 0 });
    price(5);
    expect(run()).toMatchObject({ dispatched: 2 });
    expect(run()).toMatchObject({ dispatched: 0 });
    expect(database.prepare("SELECT count(*) n FROM automation_jobs WHERE job_type='ability_evaluation'").get()).toEqual({ n: 2 });
  });
  it("does not let one active consumer block another and retains deferred work", () => {
    const { database, run, price, jobs } = fixture();
    jobs.enqueue({ jobId: "active-a", idempotencyKey: "active-a", lane: "trader_backfill", jobType: "ability_evaluation", subjectKey: "a", priority: 76, cursor: null, nextAttemptAt: 1, payload: "{}", createdAt: 1 });
    price(5);
    expect(run()).toMatchObject({ dispatched: 1, deferred: 1 });
    database.prepare("UPDATE automation_jobs SET status='completed' WHERE job_id='active-a'").run();
    expect(run()).toMatchObject({ dispatched: 1 });
  });
  it("does not wake on missing, future, out-of-range or invalid price facts", () => {
    const { run, price } = fixture();
    price(0); price(5,6000); price(3,999); price(-1,3000);
    expect(run()).toMatchObject({ dispatched: 0 });
  });
  it("detects price corrections after a previous evaluation without resetting other jobs", () => {
    const { database, run, price } = fixture();
    price(5); expect(run()).toMatchObject({ dispatched: 2 });
    database.prepare("UPDATE automation_jobs SET status='completed'").run();
    database.prepare("UPDATE market_observations SET price_usd=6").run();
    expect(run()).toMatchObject({ dispatched: 2 });
  });
  it("rotates bounded batches even when earlier consumers have no facts", () => {
    const { database, jobs, price } = fixture();
    const run = () => reconcileConsumerHistoryWakeups({ database, jobs, now: () => 10000, limit: 1 });
    expect(run()).toMatchObject({ examined: 1, dispatched: 0 });
    price(5);
    expect(run()).toMatchObject({ examined: 1, dispatched: 1 });
    expect(database.prepare("SELECT subject_key FROM automation_jobs").get()).toEqual({ subject_key: "b" });
  });
});
