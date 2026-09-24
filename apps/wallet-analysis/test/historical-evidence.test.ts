import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createCandidateHistoryStore, initializeCandidateHistorySchema } from "@address-radar/database";
import { createHistoricalEvidenceService } from "../src/index.js";

describe("historical candidate evidence", () => {
  it("deduplicates pages, aggregates 50 USD, weights entry market cap, and keeps the strongest token tier", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    store.saveMilestoneCrossing({ milestoneId: "base:t:100000", tokenId: "base:t", marketCapUsd: 100_000, crossedAt: 100, precision: "exact", source: "dune", sourceEventIds: ["m1"], strategyVersion: "v3" });
    store.saveMilestoneCrossing({ milestoneId: "base:t:500000", tokenId: "base:t", marketCapUsd: 500_000, crossedAt: 500, precision: "estimated", source: "dune", sourceEventIds: ["m2"], strategyVersion: "v3" });
    store.saveMilestoneCrossing({ milestoneId: "base:t:1000000", tokenId: "base:t", marketCapUsd: 1_000_000, crossedAt: null, precision: "unavailable", source: "dune", sourceEventIds: [], strategyVersion: "v3" });
    const service = createHistoricalEvidenceService({ store, resolveTraderId: () => null, strategyVersion: "candidate-history-v3" });

    const result = service.ingest([
      { eventId: "dune:tx:1", economicKey: "base:tx:1:0", chain: "base", tokenAddress: "T", traderAddress: "0xABC", side: "buy", amountUsd: 20, marketCapUsd: 10_000, occurredAt: 10, source: "dune", capturableMultiple: 8, realizedMultiple: 2 },
      { eventId: "fomo:tx:1", economicKey: "base:tx:1:0", chain: "base", tokenAddress: "T", traderAddress: "0xabc", side: "buy", amountUsd: 20, marketCapUsd: 10_000, occurredAt: 10, source: "fomo", capturableMultiple: 8, realizedMultiple: 2 },
      { eventId: "dune:tx:2", economicKey: "base:tx:2:0", chain: "base", tokenAddress: "T", traderAddress: "0xabc", side: "buy", amountUsd: 30, marketCapUsd: 20_000, occurredAt: 20, source: "dune", capturableMultiple: 10, realizedMultiple: 3 },
      { eventId: "dune:tx:2", economicKey: "base:tx:2:0", chain: "base", tokenAddress: "T", traderAddress: "0xabc", side: "buy", amountUsd: 30, marketCapUsd: 20_000, occurredAt: 20, source: "dune", capturableMultiple: 10, realizedMultiple: 3 },
    ], 600);

    expect(result).toMatchObject({ acceptedEvidence: 1, duplicateEvents: 2, unresolvedTraderIds: ["wallet:base:0xabc"] });
    expect(store.evidenceForTrader("wallet:base:0xabc")).toEqual([
      expect.objectContaining({
        tokenId: "base:t",
        milestoneId: "base:t:500000",
        evidenceType: "market_cap_500k_10x",
        admissionClass: "strong",
        cumulativeBuyUsd: 50,
        weightedEntryMarketCapUsd: 16_000,
        theoreticalOpportunity: 31.25,
        capturableMultiple: 10,
        realizedMultiple: 3,
        sourceEventIds: ["dune:tx:1", "dune:tx:2", "fomo:tx:1"],
      }),
    ]);
    expect(store.latestAdmissionSnapshot("wallet:base:0xabc")).toMatchObject({ currentAdmission: true, strongDistinctTokenCount: 1, historicalDistinctTokenCount: 1 });
    database.close();
  });

  it("rejects buys below 50 USD and maps known wallets to the canonical trader", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    store.saveMilestoneCrossing({ milestoneId: "solana:S:100000", tokenId: "solana:S", marketCapUsd: 100_000, crossedAt: 100, precision: "exact", source: "dune", sourceEventIds: ["m"], strategyVersion: "v3" });
    const service = createHistoricalEvidenceService({ store, resolveTraderId: () => "trader-1", strategyVersion: "candidate-history-v3" });

    expect(service.ingest([{ eventId: "e1", economicKey: "e1", chain: "solana", tokenAddress: "S", traderAddress: "Wallet", side: "buy", amountUsd: 49.99, marketCapUsd: 20_000, occurredAt: 10, source: "dune" }], 200)).toMatchObject({ acceptedEvidence: 0 });
    expect(store.evidenceForTrader("trader-1")).toEqual([]);
    database.close();
  });
});
