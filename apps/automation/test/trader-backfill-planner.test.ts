import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAutomationJobStore,
  createTraderAutomationStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";
import type { AutomationJob } from "@address-radar/domain";
import { describe, expect, it } from "vitest";

import { createTraderBackfillPlanner } from "../src/trader-backfill-planner.js";
import { createTraderLightweightWorker } from "../src/trader-lightweight-worker.js";

const setup = () => {
  const path = join(mkdtempSync(join(tmpdir(), "trader-backfill-planner-")), "radar.sqlite");
  const database = openAddressRadarDatabase(path);
  migrateAddressRadarDatabase(database);
  const insertTrader = database.prepare(`
    INSERT INTO trader_entities(
      entity_id, lifecycle, manual, locked, created_at, updated_at
    ) VALUES (?, 'candidate', ?, 0, 1, 1)
  `);
  const insertAccount = database.prepare(`
    INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
    VALUES (?, ?, 1, 1)
  `);
  const linkAccount = database.prepare(`
    INSERT INTO entity_accounts(
      entity_id, account_id, confidence, source, first_observed_at, last_observed_at
    ) VALUES (?, ?, 'confirmed', 'test', 1, 1)
  `);
  const insertWallet = database.prepare(`
    INSERT INTO entity_wallet_identities(
      entity_id, chain_family, address, confidence, source,
      first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, 'confirmed', 'test', 1, 1)
  `);
  for (const [traderId, manual] of [["t0", 1], ["t1", 0], ["t2", 0], ["t3", 0]] as const) {
    insertTrader.run(traderId, manual);
    insertAccount.run(`account-${traderId}`, traderId);
    linkAccount.run(traderId, `account-${traderId}`);
  }
  insertAccount.run("account-t2-duplicate", "t2-alt");
  linkAccount.run("t2", "account-t2-duplicate");
  insertWallet.run("t0", "solana", "WalletT0");
  insertWallet.run("t0", "evm", "0x0000000000000000000000000000000000000010");
  insertWallet.run("t1", "evm", "0x0000000000000000000000000000000000000011");

  const states = createTraderAutomationStore(database);
  const save = (traderId: string, tier: "T0" | "T1" | "T2" | "T3") => states.saveState({
    traderId,
    tier,
    coverageState: "unseen",
    monitoringPolicy: tier === "T0" || tier === "T1" ? "realtime" : "lightweight",
    lastCoveredAt: null,
    nextEvaluationAt: 0,
    strategyVersion: "test-v1",
    updatedAt: 1,
  });
  save("t0", "T0");
  save("t1", "T1");
  save("t2", "T2");
  save("t3", "T3");

  return {
    database,
    jobs: createAutomationJobStore(database),
    states,
  };
};

describe("trader backfill planner", () => {
  it("gives every canonical trader one explainable next action without deep-scanning all", () => {
    const { database, jobs, states } = setup();
    const planner = createTraderBackfillPlanner({
      database,
      jobs,
      states,
      windowDays: 60,
      maximumTokens: 300,
      strategyVersion: "backfill-v1",
    });

    const plan = planner.seed(1_000);
    expect(plan.deepBackfills).toHaveLength(3);
    expect(plan.deepBackfills).toContainEqual(expect.objectContaining({
      traderId: "t0",
      chainFamily: "solana",
      windowDays: 60,
      maximumTokens: 300,
    }));
    expect(plan.identityRequests).toEqual([expect.objectContaining({ traderId: "t2" })]);
    expect(plan.lightweightEvaluations.map((item) => item.traderId).sort())
      .toEqual(["t0", "t1", "t2", "t3"]);
    expect(plan.lightweightEvaluations.filter((item) => item.traderId === "t2"))
      .toHaveLength(1);

    planner.seed(1_000);
    expect(jobs.snapshot()).toMatchObject({ pending: 8 });
    planner.seed(15 * 60_000 + 1_000);
    expect(jobs.snapshot()).toMatchObject({ pending: 8 });
    expect(states.state("t3")).toMatchObject({ tier: "T3", coverageState: "queued" });
    database.close();
  });

  it("reconciles existing lightweight duplicates before planning new work", () => {
    const { database, jobs, states } = setup();
    for (const suffix of ["old", "new"]) {
      jobs.enqueue({
        jobId: `lightweight:t0:${suffix}`,
        idempotencyKey: `lightweight:t0:${suffix}`,
        lane: "trader_backfill",
        jobType: "trader_lightweight_evaluation",
        subjectKey: "t0",
        priority: 10,
        cursor: null,
        nextAttemptAt: 0,
        payload: JSON.stringify({ traderId: "t0", tier: "T0" }),
        createdAt: suffix === "old" ? 1 : 2,
      });
    }
    const planner = createTraderBackfillPlanner({
      database,
      jobs,
      states,
      windowDays: 60,
      maximumTokens: 300,
      strategyVersion: "backfill-v1",
    });

    planner.seed(1_000);

    expect(jobs.snapshot()).toMatchObject({ cancelled: 1 });
    expect(jobs.activeCount("trader_lightweight_evaluation")).toBe(4);
    database.close();
  });

  it("uses Fomo-only canonical events to upgrade lightweight evaluation priority", async () => {
    const { database, states } = setup();
    const insert = database.prepare(`
      INSERT INTO canonical_trader_events(
        canonical_event_id, entity_id, chain, token_address, side,
        amount_usd, occurred_at, source_status, updated_at
      ) VALUES (?, 't3', 'solana', ?, 'buy', 30, ?, 'FOMO_ONLY', ?)
    `);
    insert.run("event-a", "TokenA", 100, 100);
    insert.run("event-b", "TokenB", 200, 200);
    const worker = createTraderLightweightWorker({
      database,
      states,
      minimumBuyUsd: 50,
      strategyVersion: "lightweight-v1",
      now: () => 1_000,
    });
    const automationJob = {
      jobId: "lightweight:t3",
      idempotencyKey: "lightweight:t3",
      lane: "trader_backfill",
      jobType: worker.jobType,
      subjectKey: "t3",
      priority: 10,
      status: "leased",
      cursor: null,
      attemptCount: 1,
      nextAttemptAt: 0,
      leaseExpiresAt: 2_000,
      payload: JSON.stringify({ traderId: "t3" }),
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null,
    } satisfies AutomationJob;

    await expect(worker.execute(automationJob, new AbortController().signal))
      .resolves.toMatchObject({ status: "completed", diagnostic: expect.stringContaining("distinctTokens=2") });
    expect(states.state("t3")).toMatchObject({ tier: "T2", coverageState: "current" });
    database.close();
  });
});
