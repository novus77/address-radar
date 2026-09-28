import { DatabaseSync } from "node:sqlite";

import { createSourceObservation } from "@address-radar/domain";
import {
  createSourceLedgerStore,
  initializeSourceLedgerSchema,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

function observation(collectedAt: number) {
  return createSourceObservation({
    source: "fomo_feed",
    sourceEventId: "event-1",
    chain: "base",
    observedAt: 2_000,
    collectedAt,
    payloadVersion: 1,
    payload: {
      eventId: "event-1",
      source: "fomo_stream",
      occurredAt: 2_000,
      collectedAt,
      amountUsd: 100,
    },
    confidence: 0.85,
    extractionMode: "network",
    provenance: { originalSource: "fomo_stream" },
  });
}

describe("source ledger semantic fingerprints", () => {
  it("treats recollection time changes as semantic duplicates", () => {
    const database = new DatabaseSync(":memory:");
    initializeSourceLedgerSchema(database);
    const store = createSourceLedgerStore(database);

    expect(store.saveObservation(observation(2_100))).toEqual({ status: "inserted" });
    expect(store.saveObservation(observation(9_900))).toEqual({ status: "duplicate" });
    expect(database.prepare("SELECT count(*) AS count FROM source_observations").get())
      .toEqual({ count: 1 });

    database.close();
  });

  it("aggregates true business conflicts without throwing", () => {
    const database = new DatabaseSync(":memory:");
    initializeSourceLedgerSchema(database);
    const store = createSourceLedgerStore(database);
    const conflictingObservation = (collectedAt: number) => ({
      ...observation(collectedAt),
      payload: { ...observation(collectedAt).payload, tokenAddress: "0xdef" },
    });

    expect(store.saveObservation(observation(2_100))).toEqual({ status: "inserted" });
    const conflict = store.saveObservation(conflictingObservation(9_900));
    expect(conflict.status).toBe("conflict");
    expect(store.saveObservation(conflictingObservation(70_000))).toEqual(conflict);
    expect(database.prepare(`
      SELECT occurrence_count AS occurrenceCount
      FROM source_observation_conflicts
    `).get()).toEqual({ occurrenceCount: 2 });

    database.close();
  });
});
