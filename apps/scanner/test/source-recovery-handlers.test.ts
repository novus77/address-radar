import { DatabaseSync } from "node:sqlite";

import {
  createAutomationJobStore,
  createCandidateHistoryStore,
  createSourceLedgerStore,
  createTokenFactStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

import { createRecoveryRuntime } from "../src/recovery-runtime.js";
import { createSourceRecoveryHandlers, reconcileCandidateSourceRecovery } from "../src/source-recovery-handlers.js";

const NOW = 10_000;

const automationJob = {
  jobId: "candidate-base-token",
  idempotencyKey: "candidate-base-token",
  lane: "trader_backfill" as const,
  jobType: "candidate_evidence",
  subjectKey: "base:0xabc",
  priority: 10,
  cursor: null,
  nextAttemptAt: 0,
  payload: "{}",
  createdAt: 1,
};

describe("source recovery handlers", () => {
  it("persists market facts and wakes only the matching candidate", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue(automationJob);
    jobs.claim("trader_backfill", 1, 100, "worker");
    jobs.waitForSource(automationJob.jobId, "worker", {
      diagnostic: "token price history is not available",
      reasonCode: "missing_market_history",
      context: { tokenId: automationJob.subjectKey },
      recoveryJobIds: ["recovery:market_enrichment:base:0xabc"],
      retryAt: 100,
      updatedAt: 2,
    });
    ledger.enqueueRecoveryJob({
      jobId: "recovery:market_enrichment:base:0xabc",
      jobType: "market_enrichment",
      chain: "base",
      subjectKey: "base:0xabc",
      priority: 20,
      cursor: null,
      nextAttemptAt: 0,
      createdAt: 1,
    });
    const handlers = createSourceRecoveryHandlers({
      database,
      ledger,
      jobs,
      history: createCandidateHistoryStore(database),
      facts: createTokenFactStore(database),
      marketProvider: {
        async lookup() {
          return { chain: "base", tokenAddress: "0xabc", priceUsd: 0.25, marketCapUsd: 250_000, liquidityUsd: 50_000, symbol: "ABC", observedAt: new Date(NOW).toISOString() };
        },
      },
      fomoProducer: { async enqueue() { throw new Error("not used"); } },
      now: () => NOW,
    });
    const runtime = createRecoveryRuntime({
      ledger,
      handlers,
      clock: { now: () => NOW },
      onReEvaluate: request => { jobs.wakeBlockedSource(request.key, NOW, "candidate_evidence"); },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "completed" });
    expect(database.prepare("SELECT price_usd AS priceUsd FROM market_observations WHERE chain = 'base' AND token_address = '0xabc'").get()).toEqual({ priceUsd: 0.25 });
    expect(database.prepare("SELECT market_cap_usd AS marketCapUsd, precision FROM token_milestone_crossings ORDER BY market_cap_usd").all()).toEqual([
      { marketCapUsd: 100_000, precision: "estimated" },
      { marketCapUsd: 200_000, precision: "estimated" },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM historical_tokens").get()).toEqual({ count: 0 });
    expect(jobs.job(automationJob.jobId)).toMatchObject({ status: "pending" });
    expect(jobs.sourceBlock(automationJob.jobId)).toMatchObject({ resolvedAt: NOW });
    database.close();
  });

  it("queues a milestone Fomo lookup while early trades are unavailable", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const history = createCandidateHistoryStore(database);
    history.saveHistoricalToken({ tokenId: "solana:Mint", chain: "solana", tokenAddress: "Mint", symbol: "MINT", imageUrl: null, firstTradeAt: 1, firstReached1mAt: 2_000, peakMarketCapUsd: 1_000_000, source: "test", sourceQueryId: null, provenance: {} });
    history.saveMilestoneCrossing({ milestoneId: "solana:Mint:500000", tokenId: "solana:Mint", marketCapUsd: 500_000, crossedAt: 2_000, precision: "exact", source: "test", sourceEventIds: ["m1"], strategyVersion: "test" });
    ledger.enqueueRecoveryJob({ jobId: "recovery:milestone_early_buyers:solana:Mint", jobType: "milestone_early_buyers", chain: "solana", subjectKey: "solana:Mint", priority: 35, cursor: null, nextAttemptAt: 0, createdAt: 1 });
    const requests: unknown[] = [];
    const handlers = createSourceRecoveryHandlers({
      database,
      ledger,
      jobs: createAutomationJobStore(database),
      history,
      facts: createTokenFactStore(database),
      marketProvider: { async lookup() { return null; } },
      fomoProducer: { async enqueue(request) { requests.push(request); return { enqueued: true, request: request as never }; } },
      now: () => NOW,
    });
    const runtime = createRecoveryRuntime({ ledger, handlers, clock: { now: () => NOW }, retryBaseMs: 500 });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
    expect(requests).toEqual([expect.objectContaining({ chainId: "solana", tokenAddress: "Mint", purpose: "milestone_backfill", milestoneId: "solana:Mint:500000", beforeAt: 2_000 })]);
    database.close();
  });

  it("backfills historical OHLCV and wakes blocked candidate evidence", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const jobs = createAutomationJobStore(database);
    database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES ('trader', 'candidate', 0, 0, 1, 1)").run();
    database.prepare("INSERT INTO canonical_trader_events(canonical_event_id, entity_id, chain, token_address, side, amount_usd, occurred_at, source_status, updated_at) VALUES ('event', 'trader', 'base', '0xabc', 'buy', 100, 1000, 'FOMO_ONLY', 1000)").run();
    jobs.enqueue({ ...automationJob, payload: JSON.stringify({ tokenId: "base:0xabc", evaluatedAt: 5_000 }) });
    jobs.claim("trader_backfill", 1, 100, "worker");
    jobs.waitForSource(automationJob.jobId, "worker", { diagnostic: "missing", reasonCode: "missing_market_history", context: { tokenId: "base:0xabc", evaluatedAt: 5_000 }, recoveryJobIds: [], retryAt: 100, updatedAt: 2 });
    expect(reconcileCandidateSourceRecovery({ database, ledger, now: () => NOW })).toEqual({ resolvedBlocks: 0, enqueued: 1 });
    const handlers = createSourceRecoveryHandlers({
      database,
      ledger,
      jobs,
      history: createCandidateHistoryStore(database),
      facts: createTokenFactStore(database),
      marketProvider: { async lookup() { return null; } },
      historicalMarketProvider: {
        async topPool() { return { network: "base", poolAddress: "pool", tokenAddress: "0xabc", tokenSide: "base", tokenPriceUsd: 2, reserveUsd: 1000, marketCapUsd: null, fdvUsd: null, createdAt: 0 }; },
        async ohlcv() { return [{ timestamp: 0, open: 1, high: 2, low: 1, close: 1.5, volumeUsd: 100 }]; },
        async trades() { return []; },
      },
      fomoProducer: { async enqueue() { throw new Error("not used"); } },
      now: () => NOW,
    });
    const runtime = createRecoveryRuntime({ ledger, handlers, clock: { now: () => NOW }, onReEvaluate: request => { jobs.wakeBlockedSource(request.key, NOW, "candidate_evidence"); } });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "completed" });
    expect(database.prepare("SELECT observed_at AS observedAt, price_usd AS priceUsd FROM market_observations WHERE source = 'geckoterminal_ohlcv'").all()).toEqual([{ observedAt: 0, priceUsd: 1.5 }]);
    expect(jobs.job(automationJob.jobId)).toMatchObject({ status: "pending" });
    database.close();
  });

  it("falls back to token-level history when GeckoTerminal has no pool coverage", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const jobs = createAutomationJobStore(database);
    database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES ('trader', 'candidate', 0, 0, 1, 1)").run();
    database.prepare("INSERT INTO canonical_trader_events(canonical_event_id, entity_id, chain, token_address, side, amount_usd, occurred_at, source_status, updated_at) VALUES ('event', 'trader', 'base', '0xabc', 'buy', 100, 1000, 'FOMO_ONLY', 1000)").run();
    jobs.enqueue({ ...automationJob, payload: JSON.stringify({ tokenId: "base:0xabc", evaluatedAt: 5_000 }) });
    jobs.claim("trader_backfill", 1, 100, "worker");
    jobs.waitForSource(automationJob.jobId, "worker", { diagnostic: "missing", reasonCode: "missing_market_history", context: { tokenId: "base:0xabc", evaluatedAt: 5_000 }, recoveryJobIds: [], retryAt: 100, updatedAt: 2 });
    reconcileCandidateSourceRecovery({ database, ledger, now: () => NOW });
    const handlers = createSourceRecoveryHandlers({
      database,
      ledger,
      jobs,
      history: createCandidateHistoryStore(database),
      facts: createTokenFactStore(database),
      marketProvider: { async lookup() { return null; } },
      historicalMarketProvider: {
        async topPool() { return null; },
        async ohlcv() { return []; },
        async trades() { return []; },
      },
      historicalPriceFallback: {
        async chart() {
          return { source: "defillama_chart", confidence: 0.9, prices: [{ observedAt: 0, priceUsd: 1.25 }] };
        },
      },
      fomoProducer: { async enqueue() { throw new Error("not used"); } },
      now: () => NOW,
    });
    const runtime = createRecoveryRuntime({ ledger, handlers, clock: { now: () => NOW }, onReEvaluate: request => { jobs.wakeBlockedSource(request.key, NOW, "candidate_evidence"); } });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "completed" });
    expect(database.prepare("SELECT observed_at AS observedAt, price_usd AS priceUsd, source FROM market_observations").all())
      .toEqual([{ observedAt: 0, priceUsd: 1.25, source: "defillama_chart" }]);
    expect(jobs.job(automationJob.jobId)).toMatchObject({ status: "pending" });
    database.close();
  });

  it("completes Fomo history recovery after local market facts arrive", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES ('trader', 'candidate', 0, 0, 1, 1)").run();
    database.prepare("INSERT INTO canonical_trader_events(canonical_event_id, entity_id, chain, token_address, side, amount_usd, occurred_at, source_status, updated_at) VALUES ('event', 'trader', 'robinhood', '0xabc', 'buy', 100, 1000, 'FOMO_ONLY', 1000)").run();
    database.prepare("INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source) VALUES ('robinhood', '0xabc', 1000, 1.5, 'fomo_stream')").run();
    ledger.enqueueRecoveryJob({ jobId: "recovery:fomo_token_history:robinhood:0xabc", jobType: "fomo_token_history", chain: "robinhood", subjectKey: "robinhood:0xabc", priority: 30, cursor: null, nextAttemptAt: 0, createdAt: 1 });
    const requests: unknown[] = [];
    const handlers = createSourceRecoveryHandlers({
      database,
      ledger,
      jobs: createAutomationJobStore(database),
      history: createCandidateHistoryStore(database),
      facts: createTokenFactStore(database),
      marketProvider: { async lookup() { return null; } },
      fomoProducer: { async enqueue(request) { requests.push(request); return { enqueued: true, request: request as never }; } },
      now: () => NOW,
    });
    const runtime = createRecoveryRuntime({ ledger, handlers, clock: { now: () => NOW } });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "completed" });
    expect(requests).toEqual([]);
    expect(createTokenFactStore(database).fact("robinhood:0xabc", "price_history")).toMatchObject({ status: "available", primarySource: "market_observations" });
    database.close();
  });

  it("resolves stale source blocks after a candidate job has already been requeued", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue(automationJob);
    jobs.claim("trader_backfill", 1, 100, "worker");
    jobs.waitForSource(automationJob.jobId, "worker", {
      diagnostic: "missing",
      reasonCode: "missing_market_history",
      context: { tokenId: "base:0xabc" },
      recoveryJobIds: [],
      retryAt: 100,
      updatedAt: 2,
    });
    database.prepare("UPDATE automation_jobs SET status = 'pending' WHERE job_id = ?").run(automationJob.jobId);

    expect(reconcileCandidateSourceRecovery({ database, ledger, now: () => NOW })).toEqual({ resolvedBlocks: 1, enqueued: 0 });
    expect(jobs.sourceBlock(automationJob.jobId)).toMatchObject({ resolvedAt: NOW });
    database.close();
  });

  it("reopens historical coverage dead letters when a blocked candidate still needs them", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const ledger = createSourceLedgerStore(database);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue(automationJob);
    jobs.claim("trader_backfill", 1, 100, "worker");
    jobs.waitForSource(automationJob.jobId, "worker", {
      diagnostic: "missing",
      reasonCode: "missing_market_history",
      context: { tokenId: "base:0xabc" },
      recoveryJobIds: ["recovery:market_history:base:0xabc"],
      retryAt: 100,
      updatedAt: 2,
    });
    ledger.enqueueRecoveryJob({ jobId: "recovery:market_history:base:0xabc", jobType: "market_history", chain: "base", subjectKey: "base:0xabc", priority: 25, cursor: null, nextAttemptAt: 0, createdAt: 1 });
    ledger.claimRecoveryJob(1, 100);
    ledger.failRecoveryJob("recovery:market_history:base:0xabc", "historical_market_coverage_unavailable", 2, true);

    reconcileCandidateSourceRecovery({ database, ledger, now: () => NOW });

    expect(ledger.recoveryJob("recovery:market_history:base:0xabc")).toMatchObject({ status: "pending", attemptCount: 0, lastError: null, nextAttemptAt: NOW });
    database.close();
  });
});
