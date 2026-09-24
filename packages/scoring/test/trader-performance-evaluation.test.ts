import { describe, expect, it } from "vitest";

import type { TraderTokenOutcome, TraderTokenSample } from "@address-radar/domain";
import { evaluateTraderPerformance } from "@address-radar/scoring";

const samples: TraderTokenSample[] = Array.from({ length: 20 }, (_, index) => ({
  sampleId: `sample-${index}`, entityId: "entity-1", chain: "solana", tokenAddress: `Token${index}`,
  firstBuyAt: 1_000 + index, lastActivityAt: 1_000 + index, weightedEntryPriceUsd: 1,
  weightedEntryMarketCapUsd: 50_000, totalBuyUsd: 100, totalSellUsd: 0, realizedValueUsd: 0,
  remainingCostUsd: 100, launchAt: 500, lifecycleStageAtEntry: "new_launch", sourceState: "FOMO_AND_ONCHAIN",
  sampleStatus: "included", exclusionReason: null, createdAt: 2_000, updatedAt: 2_000,
}));

const outcomes: TraderTokenOutcome[] = samples.map((sample, index) => ({
  sampleId: sample.sampleId, horizon: "24h", targetAt: 10_000 + index, observedAt: 10_000 + index,
  closeMultiple: 10, mfeMultiple: 12, maeMultiple: 0.9, capturedMultiple: 8, hit1_5x: true,
  hit2x: true, hit5x: true, hit10x: true, timeTo1_5xMs: 1_000, timeTo2xMs: 2_000,
  timeTo5xMs: 3_000, timeTo10xMs: 4_000, coverageStatus: "complete", source: "dex", computedAt: 20_000,
}));

describe("trader performance evaluation", () => {
  it("creates an auditable snapshot and promotes only repeatable evidence", () => {
    const result = evaluateTraderPerformance({
      entityId: "entity-1", currentLifecycle: "candidate", locked: false, previousBelowThresholdCount: 0,
      samples, outcomes,
      discoveries: samples.slice(0, 3).map((sample, index) => ({ chain: sample.chain, tokenAddress: sample.tokenAddress, discoveryType: "market_cap_500k_10x", discoveredAt: 15_000 + index })),
      asOf: 30_000, window: "30d", preferredHorizon: "24h", strategyVersion: "trader-ability-v2",
    });
    expect(result.snapshot).toEqual(expect.objectContaining({ entityId: "entity-1", strategyVersion: "trader-ability-v2" }));
    expect(result.snapshot.metrics).toEqual(expect.objectContaining({ validSamples: 20, independentHighMultipleCases: 3 }));
    expect(result.snapshot.styles).toMatchObject({ EARLY_LAUNCH: expect.any(Number), HIGH_MULTIPLE: 1, LARGE_CAP: 0.01, OLD_TOKEN_MOMENTUM: 0 });
    expect(result.lifecycle).toEqual(expect.objectContaining({ next: "active", changed: true }));
  });

  it("does not fabricate large-cap, old-token, leader, or follower styles without evidence", () => {
    const unknown = samples.slice(0, 2).map(sample => ({ ...sample, weightedEntryMarketCapUsd: null, launchAt: null, lifecycleStageAtEntry: "unknown" }));
    const result = evaluateTraderPerformance({ entityId: "entity-1", currentLifecycle: "candidate", locked: false, samples: unknown, outcomes: [], discoveries: [], asOf: 30_000, window: "30d", preferredHorizon: "24h", strategyVersion: "trader-ability-v2" });
    expect(result.snapshot.styles).toMatchObject({ LARGE_CAP: 0, HIGH_CAP: 0, OLD_TOKEN_MOMENTUM: 0, LEADER: 0, FOLLOWER: 0 });
  });

  it("keeps sparse high-return evidence in candidate state", () => {
    const result = evaluateTraderPerformance({
      entityId: "entity-1", currentLifecycle: "candidate", locked: false, samples: samples.slice(0, 2),
      outcomes: outcomes.slice(0, 2), discoveries: [], asOf: 30_000, window: "30d", preferredHorizon: "24h",
      strategyVersion: "trader-ability-v2",
    });
    expect(result.snapshot.sampleConfidence).toBe(0.35);
    expect(result.lifecycle.next).toBe("candidate");
  });
});
