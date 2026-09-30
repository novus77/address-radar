import { describe, expect, it } from "vitest";

import { createSourceObservationIngestor, normalizeFomoHistoryLine } from "@address-radar/collectors";

const fomoLine = JSON.stringify({
  kind: "event",
  value: {
    eventType: "fomo.activity.buy",
    eventId: "fomo-observation-1",
    payload: {
      trader: { id: "account-1", handle: "@Alpha" },
      asset: { chain: "BASE", tokenAddress: "0xAbC" },
      action: "buy",
      usdAmount: 125,
      price: 0.5,
      marketCap: 500_000,
      occurredAt: 2_000,
    },
  },
});

describe("source observation ingestion", () => {
  it("persists immutable source evidence before the normalized trade event", async () => {
    const calls: string[] = [];
    const observations: unknown[] = [];
    const events: unknown[] = [];
    const ingestor = createSourceObservationIngestor({
      sourceLedger: {
        saveObservation(observation) {
          calls.push("observation");
          observations.push(observation);
          return { status: "inserted" };
        },
      },
      eventRepository: {
        insertTraderEvent(event) {
          calls.push("event");
          events.push(event);
          return { inserted: true };
        },
      },
    });
    const event = normalizeFomoHistoryLine(fomoLine, { collectedAt: 2_100 })!;

    await expect(ingestor.ingest({ events: [event], extractionMode: "network" })).resolves.toEqual({
      observationsInserted: 1,
      eventsInserted: 1,
      duplicateObservations: 0,
      duplicateEvents: 0,
    });
    expect(calls).toEqual(["observation", "event"]);
    expect(observations).toEqual([
      expect.objectContaining({
        source: "fomo_token_page",
        sourceEventId: "fomo-observation-1",
        chain: "base",
        extractionMode: "network",
        confidence: 0.85,
        payload: event,
        provenance: expect.objectContaining({ originalSource: "fomo_token_history" }),
      }),
    ]);
    expect(events).toEqual([event]);
  });

  it("still repairs the normalized event when the immutable observation is already present", async () => {
    const ingestor = createSourceObservationIngestor({
      sourceLedger: { saveObservation: () => ({ status: "duplicate" }) },
      eventRepository: { insertTraderEvent: () => ({ inserted: true }) },
    });
    const event = normalizeFomoHistoryLine(fomoLine, { collectedAt: 2_100 })!;

    await expect(ingestor.ingest({ events: [event], extractionMode: "replay" })).resolves.toEqual({
      observationsInserted: 0,
      eventsInserted: 1,
      duplicateObservations: 1,
      duplicateEvents: 0,
    });
  });

  it("does not insert an event when its source evidence cannot be persisted", async () => {
    let eventWrites = 0;
    const ingestor = createSourceObservationIngestor({
      sourceLedger: { saveObservation: () => { throw new Error("ledger unavailable"); } },
      eventRepository: { insertTraderEvent: () => { eventWrites += 1; return { inserted: true }; } },
    });
    const event = normalizeFomoHistoryLine(fomoLine, { collectedAt: 2_100 })!;

    await expect(ingestor.ingest({ events: [event], extractionMode: "network" })).rejects.toThrow("ledger unavailable");
    expect(eventWrites).toBe(0);
  });
});
