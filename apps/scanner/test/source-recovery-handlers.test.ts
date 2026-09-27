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
import { createSourceRecoveryHandlers } from "../src/source-recovery-handlers.js";

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
      onReEvaluate: request => jobs.wakeBlockedSource(request.key, NOW, "candidate_evidence"),
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
});
