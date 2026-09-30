import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createAutomationJobStore,
  createCandidateHistoryStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
} from "@address-radar/database";

describe("candidate history store", () => {
  it("creates candidate history tables during the main database migration", () => {
    const database = new DatabaseSync(":memory:");

    migrateAddressRadarDatabase(database);

    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map(item => item.name)).toEqual(expect.arrayContaining([
      "historical_tokens",
      "token_milestone_crossings",
      "candidate_evidence_v3",
      "candidate_admission_snapshots",
    ]));
    database.close();
  });

  it("persists historical tokens and real milestone precision", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);

    store.saveHistoricalToken({
      tokenId: "solana:token-a",
      chain: "solana",
      tokenAddress: "token-a",
      symbol: "AAA",
      imageUrl: null,
      firstTradeAt: 1,
      firstReached1mAt: 2,
      peakMarketCapUsd: 1_500_000,
      source: "dune",
      sourceQueryId: "query-1",
      provenance: { executionId: "execution-1" },
    });
    store.saveMilestoneCrossing({
      milestoneId: "solana:token-a:100000",
      tokenId: "solana:token-a",
      marketCapUsd: 100_000,
      crossedAt: 10,
      precision: "exact",
      source: "dune",
      sourceEventIds: ["tx-1"],
      strategyVersion: "candidate-history-v3",
    });

    expect(store.historicalToken("solana:token-a")).toMatchObject({ peakMarketCapUsd: 1_500_000 });
    expect(store.milestoneCrossings("solana:token-a")).toEqual([
      expect.objectContaining({ marketCapUsd: 100_000, precision: "exact", crossedAt: 10 }),
    ]);
    database.close();
  });

  it("keeps evidence idempotent and independent from trader lifecycle", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    const evidence = {
      evidenceId: "evidence-1",
      traderId: "wallet:unresolved",
      tokenId: "base:token-a",
      milestoneId: "base:token-a:500000",
      evidenceType: "market_cap_500k_10x",
      admissionClass: "strong" as const,
      cumulativeBuyUsd: 50,
      weightedEntryMarketCapUsd: 40_000,
      theoreticalOpportunity: 12.5,
      capturableMultiple: null,
      realizedMultiple: null,
      evidenceAt: 100,
      sourceEventIds: ["event-1"],
      strategyVersion: "candidate-history-v3",
    };

    expect(store.saveEvidence(evidence)).toBe("inserted");
    expect(store.saveEvidence(evidence)).toBe("unchanged");

    expect(store.evidenceForTrader("wallet:unresolved")).toEqual([evidence]);
    database.close();
  });

  it("updates mutable evidence without merging a conflicting identity", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    const evidence = {
      evidenceId: "evidence-1",
      traderId: "trader-1",
      tokenId: "base:token-a",
      milestoneId: "base:token-a:500000",
      evidenceType: "market_cap_500k_10x",
      admissionClass: "strong" as const,
      cumulativeBuyUsd: 50,
      weightedEntryMarketCapUsd: 40_000,
      theoreticalOpportunity: 12.5,
      capturableMultiple: null,
      realizedMultiple: null,
      evidenceAt: 100,
      sourceEventIds: ["event-1"],
      strategyVersion: "candidate-history-v3",
    };

    expect(store.saveEvidence(evidence)).toBe("inserted");
    expect(store.saveEvidence({ ...evidence, cumulativeBuyUsd: 75 })).toBe("updated");
    expect(store.evidenceForTrader("trader-1")).toEqual([
      expect.objectContaining({ cumulativeBuyUsd: 75 }),
    ]);
    expect(() => store.saveEvidence({ ...evidence, traderId: "trader-2" }))
      .toThrow("candidate_evidence_identity_conflict:evidence-1");
    database.close();
  });

  it("atomically wakes candidate evidence when a milestone becomes available", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const history = createCandidateHistoryStore(database);
    const jobs = createAutomationJobStore(database);
    history.saveHistoricalToken({ tokenId: "base:token-a", chain: "base", tokenAddress: "token-a", symbol: "AAA", imageUrl: null, firstTradeAt: 1, firstReached1mAt: 2, peakMarketCapUsd: 1_500_000, source: "test", sourceQueryId: null, provenance: {} });
    jobs.enqueue({ jobId: "candidate-1", idempotencyKey: "candidate-1", lane: "trader_backfill", jobType: "candidate_evidence", subjectKey: "base:token-a", priority: 10, cursor: null, nextAttemptAt: 0, payload: "{}", createdAt: 1 });
    jobs.claim("trader_backfill", 2, 100, "worker");
    jobs.waitForSource("candidate-1", "worker", { diagnostic: "token milestone data is not available", reasonCode: "missing_milestone", context: { tokenId: "base:token-a" }, recoveryJobIds: [], retryAt: 3, updatedAt: 2 });

    history.saveMilestoneCrossing({ milestoneId: "base:token-a:1000000", tokenId: "base:token-a", marketCapUsd: 1_000_000, crossedAt: 10, precision: "estimated", source: "test", sourceEventIds: ["event-1"], strategyVersion: "candidate-history-v3" });

    expect(jobs.sourceBlock("candidate-1")).toMatchObject({ resolvedAt: 10 });
    expect(jobs.claim("trader_backfill", 10, 100, "worker")).toMatchObject({ jobId: "candidate-1" });
    database.close();
  });

  it("returns the latest rolling admission snapshot without deleting history", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    const base = {
      traderId: "trader-1",
      windowStart: 0,
      earlyDistinctTokenCount: 2,
      strongDistinctTokenCount: 0,
      historicalDistinctTokenCount: 2,
      currentAdmission: true,
      historicalCapability: true,
      status: "current_admitted" as const,
      reasonCodes: ["two_early_tokens_in_30d"],
      strategyVersion: "candidate-history-v3",
    };
    store.saveAdmissionSnapshot({ ...base, snapshotId: "snapshot-1", windowEnd: 100, evaluatedAt: 100 });
    store.saveAdmissionSnapshot({
      ...base,
      snapshotId: "snapshot-2",
      windowEnd: 200,
      evaluatedAt: 200,
      currentAdmission: false,
      status: "awaiting_recent_confirmation",
      reasonCodes: ["evidence_outside_30d_window"],
    });

    expect(store.admissionSnapshots("trader-1")).toHaveLength(2);
    expect(store.latestAdmissionSnapshot("trader-1")).toMatchObject({
      snapshotId: "snapshot-2",
      currentAdmission: false,
      status: "awaiting_recent_confirmation",
    });
    database.close();
  });
});
