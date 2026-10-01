import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createDefiLlamaPriceClient } from "@address-radar/collectors";
import { createAutomationJobStore, createCandidateHistoryStore, createFactDemandStore,
  createSourceLedgerStore, createTokenFactStore, initializeCandidateHistorySchema,
  migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";
import { createSourceRecoveryHandlers } from "../src/source-recovery-handlers.js";

const HOUR = 3_600_000;
const JOB_ID = "recovery:market_history:base:0xabc";
function fixture(available = false) {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  initializeCandidateHistorySchema(database);
  let at = 602 * HOUR;
  const ledger = createSourceLedgerStore(database);
  const facts = createTokenFactStore(database);
  const demands = createFactDemandStore(database);
  demands.record({ demandId: "partial-wallet", consumerId: "wallet-trader", purchaseId: "wallet-buy",
    tokenId: "base:0xabc", strategyVersion: "trader-ability-v4-opportunity", purpose: "complete_range",
    requiredFrom: HOUR, requiredTo: 501 * HOUR, evaluatedAt: at,
    reasonCode: "market_range_missing", proof: null });
  if (available) {
    facts.ensure("base:0xabc", "price_history", "test", at);
    facts.transition({ tokenId: "base:0xabc", factType: "price_history", status: "available",
      primarySource: "existing", observedAt: at, updatedAt: at, strategyVersion: "test" });
  }
  ledger.enqueueRecoveryJob({ jobId: JOB_ID, jobType: "market_history", chain: "base",
    subjectKey: "base:0xabc", priority: 25, cursor: null, nextAttemptAt: 0, createdAt: 1 });
  let requests = 0;
  const handlers = createSourceRecoveryHandlers({ database, ledger, facts,
    jobs: createAutomationJobStore(database), history: createCandidateHistoryStore(database),
    marketProvider: { async lookup() { return null; } },
    historicalMarketProvider: { async topPool() { return null; }, async ohlcv() { return []; }, async trades() { return []; } },
    historicalPriceFallback: createDefiLlamaPriceClient({ fetch: async () => ++requests % 2 === 1
      ? new Response(JSON.stringify({ coins: { "base:0xabc": {
        confidence: 0.9, prices: [{ timestamp: 3_600, price: 2 }],
      } } })) : new Response("", { status: 429 }) }),
    fomoProducer: { async enqueue() { throw new Error("Unexpected FOMO request"); } },
    now: () => at });
  const runtime = createRecoveryRuntime({ ledger, handlers, clock: { now: () => at }, retryBaseMs: 100 });
  return { database, ledger, facts, demands, runtime, nextAttempt: () => { at = ledger.recoveryJob(JOB_ID)!.nextAttemptAt; } };
}

describe("partial historical price recovery", () => {
  it("persists partial pages atomically without completing demand or the recovery job", async () => {
    const f = fixture();
    try {
      await expect(f.runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
      expect(f.database.prepare("SELECT observed_at observedAt,price_usd priceUsd FROM market_observations WHERE source='defillama_chart'").all())
        .toEqual([{ observedAt: HOUR, priceUsd: 2 }]);
      expect(f.facts.fact("base:0xabc", "price_history")).toMatchObject({ status: "partial", primarySource: "defillama_chart" });
      expect(f.database.prepare("SELECT outcome,facts_written factsWritten FROM token_fact_attempts WHERE outcome='partial'").all())
        .toEqual([{ outcome: "partial", factsWritten: 1 }]);
      expect(f.demands.get("partial-wallet")).toMatchObject({ status: "pending" });
      expect(f.ledger.recoveryJob(JOB_ID)).toMatchObject({ status: "failed" });
      f.nextAttempt();
      await expect(f.runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
      expect(f.database.prepare("SELECT COUNT(*) n FROM market_observations WHERE source='defillama_chart'").get()).toEqual({ n: 1 });
    } finally { f.database.close(); }
  });

  it("does not downgrade an existing available fact on an unrelated partial attempt", async () => {
    const f = fixture(true);
    try {
      await expect(f.runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
      expect(f.database.prepare("SELECT COUNT(*) n FROM market_observations WHERE source='defillama_chart'").get()).toEqual({ n: 1 });
      expect(f.facts.fact("base:0xabc", "price_history")).toMatchObject({ status: "available", primarySource: "existing" });
      expect(f.demands.get("partial-wallet")).toMatchObject({ status: "pending" });
    } finally { f.database.close(); }
  });
});
