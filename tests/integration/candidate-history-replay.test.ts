import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCandidateHistoryStore, initializeCandidateHistorySchema, openAddressRadarRepository } from "@address-radar/database";
import { createCandidateDiscoveryService, createHistoricalEvidenceService } from "../../apps/wallet-analysis/src/index.js";
import { auditCandidateHistory, resolveAuditDatabasePath } from "../../scripts/audit-candidate-history.js";

describe("candidate history replay convergence", () => {
  it("produces identical evidence and admission snapshots for historical and real-time inputs", async () => {
    const historicalDatabase = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(historicalDatabase);
    const historicalStore = createCandidateHistoryStore(historicalDatabase);
    for (const marketCapUsd of [100_000, 200_000, 300_000, 500_000]) {
      historicalStore.saveMilestoneCrossing({
        milestoneId: `base:token:${marketCapUsd}`,
        tokenId: "base:token",
        marketCapUsd,
        crossedAt: 500,
        precision: "exact",
        source: "dune",
        sourceEventIds: ["milestone-event"],
        strategyVersion: "candidate-history-v3",
      });
    }
    const historicalService = createHistoricalEvidenceService({
      store: historicalStore,
      resolveTraderId: () => "entity-1",
      strategyVersion: "candidate-history-v3",
    });
    historicalService.ingest([{
      eventId: "buy-1",
      economicKey: "buy-1",
      chain: "base",
      tokenAddress: "token",
      traderAddress: "WalletA",
      side: "buy",
      amountUsd: 50,
      marketCapUsd: 10_000,
      occurredAt: 100,
      source: "dune",
    }], 500);

    const directory = await mkdtemp(join(tmpdir(), "candidate-replay-"));
    const databasePath = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-1", handle: "alpha", firstSeenAt: 1, lastSeenAt: 100 });
    repository.ensureTraderEntity({ entityId: "entity-1", lifecycle: "candidate", manual: false, locked: false, createdAt: 1, updatedAt: 100 });
    repository.linkAccountToEntity({ entityId: "entity-1", accountId: "account-1", confidence: "confirmed", source: "test", observedAt: 100 });
    repository.insertTraderEvent({ eventId: "buy-1", accountId: "account-1", entityId: "entity-1", chain: "base", tokenAddress: "token", side: "buy", amountUsd: 50, priceUsd: 1, marketCapUsd: 10_000, tokenAgeMs: 100, occurredAt: 100, collectedAt: 100, source: "dune" });
    const realtimeDatabase = new DatabaseSync(databasePath);
    initializeCandidateHistorySchema(realtimeDatabase);
    const realtimeStore = createCandidateHistoryStore(realtimeDatabase);
    const realtimeService = createCandidateDiscoveryService({
      repository,
      historyStore: realtimeStore,
      historyStrategyVersion: "candidate-history-v3",
    });
    realtimeService.observe({ chain: "base", tokenAddress: "token", marketCapUsd: 500_000, reachedAt: 500, provenance: { source: "dune", sourceEventIds: ["milestone-event"] } });

    expect(realtimeStore.evidenceForTrader("entity-1")).toEqual(historicalStore.evidenceForTrader("entity-1"));
    expect(realtimeStore.latestAdmissionSnapshot("entity-1")).toEqual(historicalStore.latestAdmissionSnapshot("entity-1"));
    realtimeDatabase.close();
    repository.close();
    historicalDatabase.close();
  });

  it("reports orphan evidence and unsafe shadow delivery as production blockers", () => {
    const database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    database.prepare(`
      INSERT INTO candidate_evidence_v3(
        evidence_id, trader_id, token_id, milestone_id, evidence_type,
        admission_class, cumulative_buy_usd, weighted_entry_market_cap_usd,
        theoretical_opportunity, capturable_multiple, realized_multiple,
        evidence_at, source_event_ids, strategy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("orphan", "trader-1", "base:missing", "base:missing:500000", "market_cap_500k_10x", "strong", 50, 10_000, 50, null, null, 500, "[]", "candidate-history-v3");

    const report = auditCandidateHistory(database, {
      now: 1_000,
      deliveryEnabled: true,
      staleLeaseGraceMs: 60_000,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toContain("gateway_delivery_enabled_during_shadow");
    expect(report.counts.orphanEvidence).toBe(1);
    expect(report.blockers).toContain("orphan_candidate_evidence");
    database.close();
  });

  it("ignores the package-manager argument separator when resolving the audit database", () => {
    expect(resolveAuditDatabasePath(["--", "/var/lib/address-radar/address-radar.db"], "/fallback.db")).toBe("/var/lib/address-radar/address-radar.db");
    expect(resolveAuditDatabasePath([], "/fallback.db")).toBe("/fallback.db");
  });

});
