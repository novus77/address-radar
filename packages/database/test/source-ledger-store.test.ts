import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createSourceObservation } from "@address-radar/domain";
import { describe, expect, it } from "vitest";

import {
  createSourceLedgerStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "../src/index.js";

const databasePath = () => join(mkdtempSync(join(tmpdir(), "source-ledger-")), "radar.sqlite");

const observation = (payload: unknown = { tokenAddress: "0xabc" }) => createSourceObservation({
  source: "fomo_feed",
  sourceEventId: "event-1",
  chain: "base",
  observedAt: 100,
  collectedAt: 120,
  payloadVersion: 1,
  payload,
  confidence: 0.85,
  extractionMode: "network",
  provenance: { response: "feed" },
});

describe("source ledger store", () => {
  it("ages recovery jobs ahead of newer high-priority work", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    const store = createSourceLedgerStore(database);

    store.enqueueRecoveryJob({
      jobId: "historical-old",
      jobType: "historical_research",
      chain: "base",
      subjectKey: "base:old-token",
      priority: 60,
      cursor: null,
      nextAttemptAt: 1,
      createdAt: 1,
    });
    store.enqueueRecoveryJob({
      jobId: "market-new",
      jobType: "market_enrichment",
      chain: "base",
      subjectKey: "base:new-token",
      priority: 1,
      cursor: null,
      nextAttemptAt: 100,
      createdAt: 100,
    });

    expect(store.claimRecoveryJob(200, 1_000)?.jobId).toBe("historical-old");
    database.close();
  });

  it("retries an observation write while another process holds the writer lock", async () => {
    const path = databasePath();
    const setup = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(setup);
    setup.close();

    const lockHolder = new Worker(`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
        parentPort.postMessage("released");
      }, 120);
    `, { eval: true, workerData: path });
    await once(lockHolder, "message");

    const database = openAddressRadarDatabase(path);
    database.exec("PRAGMA busy_timeout = 1");
    const store = createSourceLedgerStore(database);
    expect(store.saveObservation(observation())).toEqual({ status: "inserted" });
    expect(store.observation(observation().observationId)).not.toBeNull();

    database.close();
    await once(lockHolder, "exit");
  });

  it("persists observations idempotently and records conflicting content", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    const store = createSourceLedgerStore(database);

    expect(store.saveObservation(observation())).toEqual({ status: "inserted" });
    expect(store.saveObservation(observation())).toEqual({ status: "duplicate" });
    expect(store.observation(observation().observationId)).toMatchObject({
      source: "fomo_feed",
      chain: "base",
      payload: { tokenAddress: "0xabc" },
      provenance: { response: "feed" },
    });
    expect(store.saveObservation(observation({ tokenAddress: "0xdef" }))).toMatchObject({ status: "conflict" });
    database.close();
  });

  it("stores mutable enrichment revisions without creating content conflicts", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    const store = createSourceLedgerStore(database);
    const first = observation({
      eventId: "event-1", source: "fomo", occurredAt: 100,
      tokenAddress: "0xabc", amountUsd: 100, priceUsd: 1,
    });
    const second = createSourceObservation({
      ...first,
      collectedAt: 180,
      confidence: 0.95,
      payload: { ...(first.payload as Record<string, unknown>), amountUsd: 125, priceUsd: 1.25 },
      provenance: { response: "refreshed" },
    });

    expect(store.saveObservation(first)).toEqual({ status: "inserted" });
    expect(store.saveObservation(second)).toEqual({ status: "duplicate" });
    expect(database.prepare(`
      SELECT revision, amount_usd AS amountUsd, price_usd AS priceUsd
      FROM source_observation_enrichments WHERE observation_id=? ORDER BY revision
    `).all(first.observationId)).toEqual([
      { revision: 1, amountUsd: 100, priceUsd: 1 },
      { revision: 2, amountUsd: 125, priceUsd: 1.25 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM source_observation_conflicts").get()).toEqual({ count: 0 });
    database.close();
  });

  it("keeps source cursors monotonic and provider health chain-specific", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    const store = createSourceLedgerStore(database);

    expect(store.advanceCursor({ source: "rpc_evm", chain: "base", cursor: "block:10", position: 10, updatedAt: 100 })).toBe(true);
    expect(store.advanceCursor({ source: "rpc_evm", chain: "base", cursor: "block:9", position: 9, updatedAt: 110 })).toBe(false);
    expect(store.sourceCursor("rpc_evm", "base")).toMatchObject({ cursor: "block:10", position: 10 });

    store.saveSourceHealth({
      source: "rpc_evm", chain: "base", state: "degraded", lastAttemptAt: 200,
      lastSuccessAt: 100, lastEventAt: 90, consecutiveFailures: 2, latencyMs: 500,
      rateLimitResetAt: null, cursor: "block:10", lastErrorCode: "timeout",
    });
    expect(store.sourceHealth("rpc_evm", "base")).toMatchObject({ state: "degraded", consecutiveFailures: 2, lastErrorCode: "timeout" });
    expect(store.sourceHealth("rpc_evm", "bsc")).toBeNull();
    database.close();
  });

  it("accounts provider budgets independently", () => {
    const database = openAddressRadarDatabase(databasePath());
    migrateAddressRadarDatabase(database);
    const store = createSourceLedgerStore(database);

    store.addBudgetUsage("dune", "2026-09-26", 3, 100);
    store.addBudgetUsage("dune", "2026-09-26", 2, 110);
    store.addBudgetUsage("dexscreener", "2026-09-26", 7, 120);
    expect(store.budgetUsage("dune", "2026-09-26")).toBe(5);
    expect(store.budgetUsage("dexscreener", "2026-09-26")).toBe(7);
    database.close();
  });

  it("recovers expired recovery leases after restart", () => {
    const path = databasePath();
    const firstDatabase = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(firstDatabase);
    const first = createSourceLedgerStore(firstDatabase);
    first.enqueueRecoveryJob({
      jobId: "job-1", jobType: "rpc_gap", chain: "base", subjectKey: "100:110",
      priority: 1, cursor: null, nextAttemptAt: 0, createdAt: 1,
    });
    expect(first.claimRecoveryJob(10, 20)).toMatchObject({ jobId: "job-1", status: "running", leaseExpiresAt: 30 });
    firstDatabase.close();

    const secondDatabase = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(secondDatabase);
    const second = createSourceLedgerStore(secondDatabase);
    expect(second.claimRecoveryJob(31, 20)).toMatchObject({ jobId: "job-1", status: "running", attemptCount: 2, leaseExpiresAt: 51 });
    second.completeRecoveryJob("job-1", 40);
    expect(second.recoveryJob("job-1")).toMatchObject({ status: "completed", completedAt: 40, leaseExpiresAt: null });
    secondDatabase.close();
  });
});
