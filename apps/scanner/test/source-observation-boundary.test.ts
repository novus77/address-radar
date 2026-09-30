import { describe, expect, it } from "vitest";

import type { AddressRadarRepository } from "@address-radar/database";
import type { SourceObservation } from "@address-radar/domain";
import { createScannerRuntime } from "../src/runtime.js";

describe("scanner source observation boundary", () => {
  it("persists source evidence before the canonical event", async () => {
    const calls: string[] = [];
    const observations: SourceObservation[] = [];
    const repository = {
      latestRuntimeQualitySnapshot: () => null,
      entityForAccount: () => null,
      latestTraderAbility: () => null,
      insertTraderEvent: () => { calls.push("event"); return { inserted: true }; },
      claimEventProjection: () => "claimed",
      completeEventProjection: () => true,
      failEventProjection: () => true,
      saveRuntimeQualitySnapshot: () => undefined,
    } as unknown as AddressRadarRepository;
    const runtime = createScannerRuntime({
      repository,
      sourceLedger: {
        saveObservation(observation) {
          calls.push("observation");
          observations.push(observation);
          return { status: "inserted" };
        },
      },
      collectors: [{
        name: "fomo-feed",
        async collect() {
          return [{
            event: {
              eventId: "scanner-fomo-1",
              accountId: "account-1",
              entityId: "fomo:account-1",
              chain: "base",
              tokenAddress: "0xabc",
              side: "buy",
              amountUsd: 25,
              priceUsd: 0.5,
              marketCapUsd: 100_000,
              tokenAgeMs: null,
              occurredAt: 2_000,
              collectedAt: 2_100,
              source: "fomo_stream",
            },
          }];
        },
      }],
      clock: { now: () => 3_000 },
      config: {
        signalThreshold: 0.7,
        minimumAggregateBuyUsd: 100,
        strategyVersion: "test",
        allowedChains: ["base"],
        excludedTokenIds: [],
        minimumPurchaseUsd: 100,
      } as never,
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ collected: 1, rejected: 1 });
    expect(calls).toEqual(["observation", "event"]);
    expect(observations).toEqual([
      expect.objectContaining({
        source: "fomo_feed",
        sourceEventId: "scanner-fomo-1",
        extractionMode: "network",
      }),
    ]);
  });

  it("persists source progress before acknowledging a collector batch", async () => {
    const calls: string[] = [];
    const cursors = new Map<string, { source: "fomo_feed"; chain: "base"; cursor: string; position: number; updatedAt: number }>();
    const health = new Map<string, never>();
    const repository = {
      latestRuntimeQualitySnapshot: () => null,
      saveRuntimeQualitySnapshot: () => undefined,
    } as unknown as AddressRadarRepository;
    const runtime = createScannerRuntime({
      repository,
      sourceHealthLedger: {
        advanceCursor(cursor) { calls.push("cursor"); cursors.set("fomo_feed:base", cursor as never); return true; },
        sourceCursor: () => cursors.get("fomo_feed:base") ?? null,
        saveSourceHealth(value) { calls.push("health"); health.set("fomo_feed:base", value as never); },
        sourceHealth: () => null,
      },
      collectors: [{
        name: "quiet-fomo",
        async collect() {
          return {
            observations: [],
            status: "ready" as const,
            sourceProgress: [{ source: "fomo_feed" as const, chain: "base" as const, stream: "fomo_live" as const, cursor: "55", position: 55 }],
            commit: () => { calls.push("commit"); },
          };
        },
      }],
      clock: { now: () => 3_000 },
      config: {
        signalThreshold: 0.7,
        minimumAggregateBuyUsd: 100,
        strategyVersion: "test",
        allowedChains: ["base"],
        excludedTokenIds: [],
        minimumPurchaseUsd: 100,
      } as never,
    });

    await runtime.runOnce();
    expect(calls).toEqual(["cursor", "health", "commit"]);
  });
});
