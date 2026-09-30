import { DatabaseSync } from "node:sqlite";

import {
  createAutomationJobStore,
  createCandidateHistoryStore,
  createSourceLedgerStore,
  createTokenFactStore,
  migrateAddressRadarDatabase,
} from "@address-radar/database";
import { createSourceObservation } from "@address-radar/domain";
import { describe, expect, it } from "vitest";

import { createEarlyTradeReconciler } from "../src/early-trade-reconciler.js";

describe("early trade reconciler", () => {
  it("promotes eligible source observations and remains idempotent", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    database.prepare(`
      INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
      VALUES ('trader-1', 'candidate', 0, 0, 1, 1)
    `).run();
    createCandidateHistoryStore(database).saveMilestoneCrossing({
      milestoneId: "m1", tokenId: "base:0xabc", marketCapUsd: 300_000,
      crossedAt: 200, precision: "exact", source: "test",
      sourceEventIds: ["milestone-1"], strategyVersion: "test",
    });
    const ledger = createSourceLedgerStore(database);
    ledger.saveObservation(createSourceObservation({
      source: "fomo_feed", sourceEventId: "trade-1", chain: "base",
      observedAt: 100, collectedAt: 110, payloadVersion: 1,
      payload: {
        eventId: "trade-1", entityId: "trader-1", tokenAddress: "0xAbC",
        side: "buy", amountUsd: 75, occurredAt: 100,
      },
      confidence: 0.9, extractionMode: "network", provenance: {},
    }));
    const reconciler = createEarlyTradeReconciler({
      database, jobs: createAutomationJobStore(database), facts: createTokenFactStore(database),
      now: () => 300, batchSize: 10,
    });

    expect(reconciler.runOnce()).toMatchObject({
      examined: 1, canonicalEventsInserted: 1, earlyTradeFactsProduced: 1, skipped: 0,
    });
    expect(reconciler.runOnce()).toMatchObject({
      examined: 0, canonicalEventsInserted: 0, earlyTradeFactsProduced: 0,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_trader_events").get()).toEqual({ count: 1 });
    expect(createTokenFactStore(database).fact("base:0xabc", "early_trades")).toMatchObject({ status: "available" });
    database.close();
  });

  it("advances past malformed observations without creating facts", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    createSourceLedgerStore(database).saveObservation(createSourceObservation({
      source: "manual", sourceEventId: "bad-1", chain: "eth",
      observedAt: 100, collectedAt: 100, payloadVersion: 1,
      payload: { tokenAddress: "0xabc" }, confidence: 0.5,
      extractionMode: "manual", provenance: {},
    }));
    const reconciler = createEarlyTradeReconciler({
      database, jobs: createAutomationJobStore(database), facts: createTokenFactStore(database), now: () => 200,
    });
    expect(reconciler.runOnce()).toMatchObject({ examined: 1, skipped: 1 });
    expect(reconciler.runOnce()).toMatchObject({ examined: 0 });
    database.close();
  });
});
