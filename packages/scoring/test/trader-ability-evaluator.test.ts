import { describe, expect, it } from "vitest";

import type { TraderTokenOutcome, TraderTokenSample } from "@address-radar/domain";
import { evaluateTraderAbility, sampleConfidence } from "@address-radar/scoring";

const NOW = 10_000_000;

const sample = (tokenAddress: string, overrides: Partial<TraderTokenSample> = {}): TraderTokenSample => ({
  sampleId: `entity-1:solana:${tokenAddress}`, entityId: "entity-1", chain: "solana", tokenAddress,
  firstBuyAt: NOW - 1_000_000, lastActivityAt: NOW - 500_000, weightedEntryPriceUsd: 1,
  weightedEntryMarketCapUsd: 40_000, totalBuyUsd: 200, totalSellUsd: 0, realizedValueUsd: 0,
  remainingCostUsd: 200, launchAt: NOW - 2_000_000, lifecycleStageAtEntry: "launched_0_2h",
  sourceState: "FOMO_ONLY", sampleStatus: "included", exclusionReason: null,
  createdAt: NOW - 1_000_000, updatedAt: NOW - 500_000, ...overrides,
});

const outcome = (tokenAddress: string, closeMultiple: number, computedAt = NOW): TraderTokenOutcome => ({
  sampleId: `entity-1:solana:${tokenAddress}`, horizon: "24h", targetAt: NOW - 500_000,
  observedAt: NOW - 400_000, closeMultiple, mfeMultiple: closeMultiple, maeMultiple: Math.min(1, closeMultiple),
  capturedMultiple: closeMultiple * 0.8, hit1_5x: closeMultiple >= 1.5, hit2x: closeMultiple >= 2,
  hit5x: closeMultiple >= 5, hit10x: closeMultiple >= 10, timeTo1_5xMs: closeMultiple >= 1.5 ? 100_000 : null,
  timeTo2xMs: closeMultiple >= 2 ? 200_000 : null, timeTo5xMs: closeMultiple >= 5 ? 300_000 : null,
  timeTo10xMs: closeMultiple >= 10 ? 400_000 : null, coverageStatus: "complete", source: "dex", computedAt,
});

describe("trader ability evaluator", () => {
  it("keeps Solana evidence distinct when mint case differs", () => {
    const result = evaluateTraderAbility({
      samples: [sample("MintAbC"), sample("Mintabc")],
      outcomes: [outcome("MintAbC", 10), outcome("Mintabc", 10)],
      discoveries: [
        { chain: "solana", tokenAddress: "MintAbC", discoveryType: "market_cap_500k_10x", discoveredAt: NOW - 300_000 },
        { chain: "solana", tokenAddress: "Mintabc", discoveryType: "market_cap_500k_10x", discoveredAt: NOW - 200_000 },
      ],
      asOf: NOW,
      window: "30d",
      preferredHorizon: "24h",
    });

    expect(result.metrics.independentHighMultipleCases).toBe(2);
  });

  it("counts two milestone labels on one token as one independent high-multiple case", () => {
    const result = evaluateTraderAbility({
      samples: [sample("TokenA")], outcomes: [outcome("TokenA", 10)],
      discoveries: [
        { chain: "solana", tokenAddress: "TokenA", discoveryType: "market_cap_500k_10x", discoveredAt: NOW - 300_000 },
        { chain: "solana", tokenAddress: "TokenA", discoveryType: "million_token_10x", discoveredAt: NOW - 200_000 },
      ],
      asOf: NOW, window: "30d", preferredHorizon: "24h",
    });
    expect(result.metrics).toMatchObject({ totalSamples: 1, validSamples: 1, independentHighMultipleCases: 1, hit10xRate: 1, medianReturn: 10 });
  });

  it.each([[4, 0.35], [8, 0.5], [15, 0.7], [30, 0.85], [50, 1]])("uses the specified sample confidence for %i samples", (count, expected) => {
    expect(sampleConfidence(count)).toBe(expected);
  });

  it("excludes outcomes computed after the evaluation as-of time", () => {
    const result = evaluateTraderAbility({ samples: [sample("TokenA")], outcomes: [outcome("TokenA", 10, NOW + 1)], discoveries: [], asOf: NOW, window: "30d", preferredHorizon: "24h" });
    expect(result.metrics).toMatchObject({ totalSamples: 1, validSamples: 0, coverageRate: 0 });
  });

  it("uses confidence and coverage to shrink an otherwise perfect small sample", () => {
    const result = evaluateTraderAbility({ samples: [sample("TokenA")], outcomes: [outcome("TokenA", 10)], discoveries: [], asOf: NOW, window: "30d", preferredHorizon: "24h" });
    expect(result.score.sampleConfidence).toBe(0.35);
    expect(result.score.coverageConfidence).toBe(1);
    expect(result.score.adjustedQuality).toBeLessThan(result.score.rawQuality);
  });

  it("keeps excluded dust samples out of the scoring denominator", () => {
    const result = evaluateTraderAbility({ samples: [sample("TokenA", { sampleStatus: "dust", exclusionReason: "buy_amount_below_threshold" })], outcomes: [outcome("TokenA", 10)], discoveries: [], asOf: NOW, window: "30d", preferredHorizon: "24h" });
    expect(result.metrics).toMatchObject({ totalSamples: 0, validSamples: 0 });
  });

  it("deduplicates recomputed outcomes before coverage and confidence scoring", () => {
    const tokenAddresses = ["TokenA", "TokenB", "TokenC", "TokenD"];
    const result = evaluateTraderAbility({
      samples: tokenAddresses.map((tokenAddress) => sample(tokenAddress)),
      outcomes: tokenAddresses.flatMap((tokenAddress) => [outcome(tokenAddress, 2, NOW - 1), outcome(tokenAddress, 10, NOW)]),
      discoveries: [],
      asOf: NOW,
      window: "30d",
      preferredHorizon: "24h",
    });

    expect(result.metrics.validSamples).toBe(4);
    expect(result.metrics.coverageRate).toBe(1);
    expect(result.metrics.medianReturn).toBe(10);
    expect(result.score.sampleConfidence).toBe(0.35);
  });

  it("uses the later input outcome when recomputations have equal timestamps", () => {
    const result = evaluateTraderAbility({
      samples: [sample("TokenA")],
      outcomes: [outcome("TokenA", 2), outcome("TokenA", 3)],
      discoveries: [],
      asOf: NOW,
      window: "30d",
      preferredHorizon: "24h",
    });

    expect(result.metrics.medianReturn).toBe(3);
  });
});
