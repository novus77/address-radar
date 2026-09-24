import { expect, test } from "vitest";
import { evaluateTraderPerformance } from "../src/index.js";
import type { TraderTokenSample } from "@address-radar/domain";

test("30d style classification excludes samples outside asOf window", () => {
  const asOf = 100 * 24 * 60 * 60_000;
  const recent = sample("recent", asOf - 1_000, 50_000);
  const old = sample("old", asOf - 40 * 24 * 60 * 60_000, 5_000_000);
  const result = evaluateTraderPerformance({
    entityId: "entity",
    currentLifecycle: "candidate",
    locked: false,
    samples: [recent, old],
    outcomes: [],
    discoveries: [],
    asOf,
    window: "30d",
    preferredHorizon: "24h",
    strategyVersion: "test",
  });
  const recentOnly = evaluateTraderPerformance({
    entityId: "entity", currentLifecycle: "candidate", locked: false,
    samples: [recent], outcomes: [], discoveries: [], asOf, window: "30d",
    preferredHorizon: "24h", strategyVersion: "test",
  });
  expect(result.snapshot.styles).toEqual(recentOnly.snapshot.styles);
});

function sample(id: string, firstBuyAt: number, marketCap: number): TraderTokenSample {
  return {
    sampleId: id, entityId: "entity", chain: "base", tokenAddress: id,
    firstBuyAt, lastActivityAt: firstBuyAt + 1_000,
    weightedEntryPriceUsd: 1, weightedEntryMarketCapUsd: marketCap,
    totalBuyUsd: 100, totalSellUsd: 0, realizedValueUsd: 0, remainingCostUsd: 100,
    launchAt: firstBuyAt - 1_000, lifecycleStageAtEntry: "early",
    sourceState: "ONCHAIN_ONLY", sampleStatus: "included", exclusionReason: null,
    createdAt: firstBuyAt, updatedAt: firstBuyAt,
  };
}
