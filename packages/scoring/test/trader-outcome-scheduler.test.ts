import { describe, expect, it } from "vitest";

import type { TraderTokenSample } from "@address-radar/domain";
import { evaluateScheduledTraderOutcomes, scheduleTraderOutcomes } from "@address-radar/scoring";

const sample = (overrides: Partial<TraderTokenSample> = {}): TraderTokenSample => ({
  sampleId: "sample-1", entityId: "entity-1", chain: "solana", tokenAddress: "TokenA", firstBuyAt: 1_000,
  lastActivityAt: 1_000, weightedEntryPriceUsd: 1, weightedEntryMarketCapUsd: 500_000, totalBuyUsd: 100,
  totalSellUsd: 0, realizedValueUsd: 0, remainingCostUsd: 100, launchAt: 500, lifecycleStageAtEntry: "new_launch",
  sourceState: "FOMO_ONLY", sampleStatus: "included", exclusionReason: null, createdAt: 1_000, updatedAt: 1_000,
  ...overrides,
});

describe("trader outcome scheduler", () => {
  it("schedules every configured horizon only for valid included samples", () => {
    const outcomes = scheduleTraderOutcomes(sample(), 2_000);
    expect(outcomes).toHaveLength(8);
    expect(outcomes[0]).toEqual(expect.objectContaining({ horizon: "60s", targetAt: 61_000, coverageStatus: "pending" }));
    expect(outcomes.at(-1)).toEqual(expect.objectContaining({ horizon: "7d", targetAt: 604_801_000 }));
    expect(scheduleTraderOutcomes(sample({ sampleStatus: "dust" }), 2_000)).toEqual([]);
    expect(scheduleTraderOutcomes(sample({ weightedEntryPriceUsd: null }), 2_000)).toEqual([]);
  });

  it("completes mature horizons while retaining future horizons as pending", () => {
    const outcomes = evaluateScheduledTraderOutcomes({
      sample: sample(), observations: [{ observedAt: 30_000, priceUsd: 1.2, source: "dex" }, { observedAt: 61_500, priceUsd: 2, source: "dex" }],
      computedAt: 70_000, maximumObservationDelayMs: 5_000, capturedMultiple: null,
    });
    expect(outcomes.find((item) => item.horizon === "60s")).toEqual(expect.objectContaining({ coverageStatus: "complete", closeMultiple: 2, hit2x: true }));
    expect(outcomes.find((item) => item.horizon === "5m")?.coverageStatus).toBe("pending");
  });
});
