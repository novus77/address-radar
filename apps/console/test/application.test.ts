import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { createAddressConsoleApplication } from "../src/application.js";
import { startAddressRadarConsole } from "../src/server.js";
import { openAddressRadarRepository } from "@address-radar/database";

const TOKEN = "developer-token-with-at-least-32-characters";
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

const fixture = async () => {
  const application = createAddressConsoleApplication();
  const server = await startAddressRadarConsole({
    application,
    host: "127.0.0.1",
    port: 0,
  });
  servers.push(server);
  return server;
};

const authorizedFetch = (url: string, path: string) => fetch(`${url}${path}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});

const authorizedJson = (url: string, path: string, method: string, body: unknown) => fetch(`${url}${path}`, {
  method,
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

it("reads the identity queue without mutating it during a concurrent database write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "address-console-lock-"));
  const databasePath = join(directory, "address.sqlite");
  const repository = openAddressRadarRepository(databasePath);
  repository.upsertFomoAccount({ accountId: "account-locked", handle: "LockedTrader", firstSeenAt: 1, lastSeenAt: 2 });
  repository.upsertTraderEntity({ entityId: "entity-locked", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
  repository.linkAccountToEntity({ entityId: "entity-locked", accountId: "account-locked", confidence: "high", source: "fomo_stream", observedAt: 2 });
  repository.close();
  const application = createAddressConsoleApplication(databasePath);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData);
    database.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      parentPort.postMessage("released");
    }, 150);
  `, { eval: true, workerData: databasePath });
  await once(worker, "message");

  expect(application.handle("GET", "/api/v1/identity-queue")).toMatchObject({
    status: 200,
    body: [],
  });
  await once(worker, "exit");
  application.close();
});

describe("address intelligence developer console", () => {
  it("serves developer data without a token on loopback", async () => {
    const server = await fixture();
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    expect((await fetch(`${server.url}/api/v1/traders`)).status).toBe(200);
  });

  it("exposes address library, candidates, backtests, aggregations, and outcomes", async () => {
    const server = await fixture();
    for (const path of ["traders", "candidates", "backtests", "aggregations", "outcomes"]) {
      const response = await authorizedFetch(server.url, `/api/v1/${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("rejects an unauthenticated console bound beyond loopback", async () => {
    await expect(startAddressRadarConsole({
      application: createAddressConsoleApplication(),
      host: "0.0.0.0",
      port: 0,
    })).rejects.toThrow(/loopback/);
  });

  it("exports and imports protected manual identity batches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-console-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-alpha", handle: "AlphaTrader", firstSeenAt: 1, lastSeenAt: 1 });
    repository.enqueueIdentityResolution({ handle: "AlphaTrader", accountId: "account-alpha", priority: 90, reason: "leaderboard_24h", observedAt: 1 });
    repository.close();
    const application = createAddressConsoleApplication(databasePath);
    const server = await startAddressRadarConsole({ application, developerToken: TOKEN, host: "127.0.0.1", port: 0 });
    servers.push(server);

    expect((await fetch(`${server.url}/api/v1/identity-queue`)).status).toBe(401);
    const queue = await (await authorizedFetch(server.url, "/api/v1/identity-queue")).json() as Array<{ handle: string }>;
    expect(queue.map(item => item.handle)).toEqual(["alphatrader"]);

    const batchResponse = await authorizedJson(server.url, "/api/v1/identity-batches", "POST", { batchId: "batch-console", maxSize: 25 });
    expect(batchResponse.status).toBe(201);
    const batch = await batchResponse.json() as { batch: { items: unknown[] } };
    expect(batch.batch.items).toHaveLength(1);

    const importResponse = await authorizedJson(server.url, "/api/v1/identity-imports", "POST", {
      batchId: "batch-console",
      importId: "import-console",
      items: [{ handle: "AlphaTrader", observedAt: 2, source: "fomolens_manual", wallets: [{ family: "evm", address: "0x1111111111111111111111111111111111111111" }] }],
    });
    expect(importResponse.status).toBe(200);
    expect(await importResponse.json()).toMatchObject({ resolved: 1, conflicts: 0, observations: 1 });
    expect((await authorizedFetch(server.url, "/api/v1/identity-conflicts")).status).toBe(200);
  });

  it("directly resolves multiple-chain wallets and exposes them in the trader library", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-console-direct-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-direct", handle: "DirectTrader", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-direct", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "entity-direct", accountId: "account-direct", confidence: "high", source: "leaderboard", observedAt: 1 });
    repository.enqueueIdentityResolution({ handle: "DirectTrader", accountId: "account-direct", priority: 90, reason: "leaderboard_24h", observedAt: 1 });
    repository.close();
    const application = createAddressConsoleApplication(databasePath);
    const server = await startAddressRadarConsole({ application, developerToken: TOKEN, host: "127.0.0.1", port: 0 });
    servers.push(server);

    const importResponse = await authorizedJson(server.url, "/api/v1/identity-imports/direct", "POST", {
      items: [{
        handle: "DirectTrader",
        evmAddress: "0x3333333333333333333333333333333333333333",
        solanaAddress: "11111111111111111111111111111111",
      }],
    });
    expect(importResponse.status).toBe(200);
    expect(await importResponse.json()).toMatchObject({ resolved: 1, conflicts: 0, observations: 2 });

    const traders = await (await authorizedFetch(server.url, "/api/v1/traders")).json() as Array<Record<string, unknown>>;
    expect(traders).toEqual([expect.objectContaining({
      entityId: "entity-direct",
      handles: "directtrader",
      evmAddresses: "0x3333333333333333333333333333333333333333",
      solanaAddresses: "11111111111111111111111111111111",
    })]);
  });

  it("does not expose unrelated unresolved traders for manual resolution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-console-unresolved-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-unresolved", handle: "NeedsWallet", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-unresolved", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
    repository.linkAccountToEntity({ entityId: "entity-unresolved", accountId: "account-unresolved", confidence: "high", source: "fomo_stream", observedAt: 2 });
    repository.close();
    const server = await startAddressRadarConsole({ application: createAddressConsoleApplication(databasePath), developerToken: TOKEN, host: "127.0.0.1", port: 0 });
    servers.push(server);

    const queue = await (await authorizedFetch(server.url, "/api/v1/identity-queue")).json() as Array<{ handle: string; reasons: string[] }>;
    expect(queue).toEqual([]);
    expect(await (await authorizedFetch(server.url, "/api/v1/traders")).json()).toEqual([]);
  });

  it("exposes observed token decisions with their missing conditions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-console-evaluations-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-alpha", handle: "AlphaTrader", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-alpha", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "entity-alpha", accountId: "account-alpha", confidence: "confirmed", source: "test", observedAt: 1 });
    repository.saveAddressSignalEvidence("base", "0xtoken", { eventId: "event-alpha", entityId: "entity-alpha", contribution: 0.95, occurredAt: 9_000, source: "fomo", side: "buy", amountUsd: 500, lifecycleStage: "launched_0_2h" });
    repository.saveTokenEvaluation({
      chain: "base",
      tokenAddress: "0xtoken",
      action: "observe",
      signalFamily: "NEW_TOKEN_DISCOVERY",
      lifecycleStage: "launched_0_2h",
      score: 0.95,
      participantCount: 1,
      totalBuyUsd: 500,
      sourceState: "FOMO_ONLY",
      windowMs: 300_000,
      missingConditions: ["distinct_traders:2"],
      updatedAt: 10_000,
    });
    repository.close();
    const server = await startAddressRadarConsole({ application: createAddressConsoleApplication(databasePath), developerToken: TOKEN, host: "127.0.0.1", port: 0 });
    servers.push(server);

    const evaluations = await (await authorizedFetch(server.url, "/api/v1/aggregations")).json() as Array<Record<string, unknown>>;
    expect(evaluations).toEqual([expect.objectContaining({
      tokenAddress: "0xtoken",
      action: "observe",
      participantCount: 1,
      missingConditions: "[\"distinct_traders:2\"]",
      participantHandles: "alphatrader",
    })]);
  });

  it("separates formal 30d traders from genuine high-multiple candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-console-candidates-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-top", handle: "TopTrader", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-top", lifecycle: "probation", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
    repository.linkAccountToEntity({ entityId: "entity-top", accountId: "account-top", confidence: "high", source: "fomo_leaderboard_30d", observedAt: 2 });
    repository.recordLeaderboardObservation({ accountId: "account-top", window: "30d", rank: 3, profitUsd: 25_000, observedAt: 2 });
    repository.upsertFomoAccount({ accountId: "account-candidate", handle: "Multiplier", firstSeenAt: 1, lastSeenAt: 4 });
    repository.upsertTraderEntity({ entityId: "entity-candidate", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 4 });
    repository.linkAccountToEntity({ entityId: "entity-candidate", accountId: "account-candidate", confidence: "high", source: "fomo_stream", observedAt: 4 });
    repository.saveCandidateDiscovery({ discoveryId: "candidate-100k", accountId: "account-candidate", discoveryType: "market_cap_100k_5x", payload: JSON.stringify({ chain: "solana", tokenAddress: "TokenA", maximumOpportunity: 5, tierRank: 2 }), discoveredAt: 2 });
    repository.saveCandidateDiscovery({ discoveryId: "candidate-500k", accountId: "account-candidate", discoveryType: "market_cap_500k_10x", payload: JSON.stringify({ chain: "solana", tokenAddress: "TokenA", maximumOpportunity: 12.5, tierRank: 7 }), discoveredAt: 3 });
    repository.saveCandidateDiscovery({ discoveryId: "candidate-1m", accountId: "account-candidate", discoveryType: "market_cap_1m_20x", payload: JSON.stringify({ chain: "solana", tokenAddress: "TokenB", maximumOpportunity: 20, tierRank: 9 }), discoveredAt: 4 });
    repository.upsertFomoAccount({ accountId: "account-24h", handle: "ShortTerm", firstSeenAt: 1, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-24h", lifecycle: "suspended", manual: false, locked: false, createdAt: 1, updatedAt: 2 });
    repository.linkAccountToEntity({ entityId: "entity-24h", accountId: "account-24h", confidence: "high", source: "legacy_leaderboard_24h", observedAt: 2 });
    repository.recordLeaderboardObservation({ accountId: "account-24h", window: "24h", rank: 1, profitUsd: 50_000, observedAt: 2 });
    repository.close();
    const server = await startAddressRadarConsole({ application: createAddressConsoleApplication(databasePath), host: "127.0.0.1", port: 0 });
    servers.push(server);

    const traders = await (await fetch(`${server.url}/api/v1/traders`)).json() as Array<Record<string, unknown>>;
    const candidates = await (await fetch(`${server.url}/api/v1/candidates`)).json() as Array<Record<string, unknown>>;
    const overview = await (await fetch(`${server.url}/api/v1/overview`)).json() as Record<string, unknown>;

    expect(traders).toEqual([expect.objectContaining({ entityId: "entity-top", handles: "toptrader", lifecycle: "probation" })]);
    expect(candidates).toEqual([expect.objectContaining({
      accountId: "account-candidate",
      handle: "multiplier",
      lifecycle: "candidate",
      strongestEvidenceType: "market_cap_1m_20x",
      distinctTokenCount: 2,
      progressionRecordCount: 3,
      strongestOpportunityMultiple: 20,
    })]);
    expect(overview).toMatchObject({ traders: 1, candidates: 1 });
  });

  it("exposes historical samples, outcomes, and repeatable ability in trader detail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "address-console-performance-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertTraderEntity({ entityId: "entity-performance", lifecycle: "active", manual: true, locked: false, createdAt: 1, updatedAt: 1 });
    repository.upsertTraderTokenSample({
      sampleId: "sample-performance", entityId: "entity-performance", chain: "solana", tokenAddress: "TokenA",
      firstBuyAt: 1_000, lastActivityAt: 2_000, weightedEntryPriceUsd: 1, weightedEntryMarketCapUsd: 50_000,
      totalBuyUsd: 100, totalSellUsd: 0, realizedValueUsd: 0, remainingCostUsd: 100, launchAt: 500,
      lifecycleStageAtEntry: "new_launch", sourceState: "FOMO_ONLY", sampleStatus: "included", exclusionReason: null,
      createdAt: 2_000, updatedAt: 2_000,
    });
    repository.saveTraderTokenOutcome({
      sampleId: "sample-performance", horizon: "24h", targetAt: 86_401_000, observedAt: 86_402_000,
      closeMultiple: 10, mfeMultiple: 12, maeMultiple: 0.8, capturedMultiple: 8,
      hit1_5x: true, hit2x: true, hit5x: true, hit10x: true,
      timeTo1_5xMs: 1_000, timeTo2xMs: 2_000, timeTo5xMs: 3_000, timeTo10xMs: 4_000,
      coverageStatus: "complete", source: "dex", computedAt: 86_402_000,
    });
    repository.saveTraderAbilitySnapshot({
      snapshotId: "ability-performance", entityId: "entity-performance", window: "30d", asOf: 90_000_000,
      strategyVersion: "trader-ability-v2", rawQuality: 0.9, adjustedQuality: 0.81,
      sampleConfidence: 0.85, coverageConfidence: 1, metrics: { validSamples: 20, hit10xRate: 0.4 },
      components: { repeatableAlpha: 0.9 }, styles: { HIGH_MULTIPLE: 0.95 }, createdAt: 90_000_000,
    });
    repository.close();
    const server = await startAddressRadarConsole({ application: createAddressConsoleApplication(databasePath), developerToken: TOKEN, host: "127.0.0.1", port: 0 });
    servers.push(server);

    const detail = await (await authorizedFetch(server.url, "/api/v1/traders/entity-performance")).json() as Record<string, unknown>;
    expect(detail).toMatchObject({
      abilitySnapshots: [expect.objectContaining({ adjustedQuality: 0.81, styles: "{\"HIGH_MULTIPLE\":0.95}" })],
      tokenSamples: [expect.objectContaining({ tokenAddress: "TokenA", sampleStatus: "included" })],
      tokenOutcomes: [expect.objectContaining({ horizon: "24h", closeMultiple: 10 })],
    });

    const backtests = await (await authorizedFetch(server.url, "/api/v1/backtests")).json() as Array<Record<string, unknown>>;
    expect(backtests).toEqual([expect.objectContaining({ entityId: "entity-performance", adjustedQuality: 0.81, validSamples: 20 })]);
  });
});
