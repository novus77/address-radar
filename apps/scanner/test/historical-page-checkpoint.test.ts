import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefiLlamaPriceClient } from "@address-radar/collectors";
import { createAutomationJobStore, createCandidateHistoryStore, createFactDemandStore,
  createSourceLedgerStore, createTokenFactStore, initializeCandidateHistorySchema,
  migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";
import { createSourceRecoveryHandlers } from "../src/source-recovery-handlers.js";
const HOUR = 3_600_000;

describe("durable historical page checkpoint", () => {
  it("commits the first page for independent readers before the second request fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-page-checkpoint-"));
    const path = join(directory, "radar.db");
    const database = new DatabaseSync(path);
    try {
      migrateAddressRadarDatabase(database);
      initializeCandidateHistorySchema(database);
      const ledger = createSourceLedgerStore(database);
      const demands = createFactDemandStore(database);
      const facts = createTokenFactStore(database);
      const at = 602 * HOUR;
      demands.record({ demandId: "page-wallet", consumerId: "wallet", purchaseId: "buy",
        tokenId: "base:0xabc", strategyVersion: "trader-ability-v4-opportunity", purpose: "complete_range",
        requiredFrom: HOUR, requiredTo: 501 * HOUR, evaluatedAt: at, reasonCode: "market_range_missing", proof: null });
      ledger.enqueueRecoveryJob({ jobId: "page-history", jobType: "market_history", chain: "base",
        subjectKey: "base:0xabc", priority: 25, cursor: null, nextAttemptAt: 0, createdAt: 1 });
      let requests = 0;
      let committedBeforeFailure = false;
      const fallback = createDefiLlamaPriceClient({ fetch: async () => {
        if (++requests === 1) return new Response(JSON.stringify({ coins: { "base:0xabc": {
          confidence: 0.9, prices: [{ timestamp: 3600, price: 2 }],
        } } }));
        const observer = new DatabaseSync(path, { readOnly: true });
        try {
          const row = observer.prepare("SELECT COUNT(*) n FROM market_observations WHERE source='defillama_chart'").get();
          committedBeforeFailure = row?.n === 1;
        } finally { observer.close(); }
        return new Response("", { status: 503 });
      } });
      const handlers = createSourceRecoveryHandlers({ database, ledger, facts,
        jobs: createAutomationJobStore(database), history: createCandidateHistoryStore(database),
        marketProvider: { async lookup() { return null; } },
        historicalMarketProvider: { async topPool() { return null; }, async ohlcv() { return []; }, async trades() { return []; } },
        historicalPriceFallback: fallback,
        fomoProducer: { async enqueue() { throw new Error("Unexpected FOMO request"); } }, now: () => at });
      const runtime = createRecoveryRuntime({ ledger, handlers, clock: { now: () => at } });
      await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
      expect(committedBeforeFailure).toBe(true);
      expect(database.prepare("SELECT outcome,facts_written factsWritten FROM token_fact_attempts WHERE attempt_id LIKE 'page-price:%'").all())
        .toEqual([{ outcome: "partial", factsWritten: 1 }]);
      expect(database.prepare("SELECT COUNT(*) n FROM token_fact_attempts WHERE attempt_id LIKE 'partial-price:%'").get()).toEqual({ n: 0 });
      expect(facts.fact("base:0xabc", "price_history")).toMatchObject({ status: "partial" });
      expect(demands.get("page-wallet")).toMatchObject({ status: "pending" });
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
