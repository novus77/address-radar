import { describe, expect, it } from "vitest";

import { decideLifecycleWithReason } from "@address-radar/domain";
import { classifyTraderStyles, scoreTrader } from "@address-radar/scoring";

describe("trader scoring and lifecycle", () => {
  it("shrinks a two-win trader below elite confidence", () => {
    const score = scoreTrader({ samples: 2, wins: 2, medianReturn: 3, tenXCases: 0, recentLosses: 0, earlyEntryRate: 0.5, maxDrawdown: 0.2, leaderRate: 0.5, singleWinDependency: 0.8 });
    expect(score.quality).toBeLessThan(0.8);
    expect(score.components.profitQuality).toBeLessThan(0.8);
  });

  it("promotes repeated independent high-multiple performance", () => {
    expect(decideLifecycleWithReason({ current: "probation", quality: 0.78, independentHighMultipleCases: 3, sampleCount: 20, recentValidity: 0.8, locked: false })).toMatchObject({ next: "active", changed: true });
  });

  it("requires two consecutive weak evaluations before automatic degradation", () => {
    expect(decideLifecycleWithReason({ current: "active", quality: 0.3, independentHighMultipleCases: 3, sampleCount: 30, recentValidity: 0.2, locked: false, previousBelowThresholdCount: 0 })).toMatchObject({ next: "active", changed: false });
    expect(decideLifecycleWithReason({ current: "active", quality: 0.3, independentHighMultipleCases: 3, sampleCount: 30, recentValidity: 0.2, locked: false, previousBelowThresholdCount: 1 })).toMatchObject({ next: "degraded", changed: true });
  });

  it("warns but does not degrade a locked manual trader", () => {
    expect(decideLifecycleWithReason({ current: "active", quality: 0.3, independentHighMultipleCases: 3, sampleCount: 30, recentValidity: 0.2, locked: true })).toMatchObject({ next: "active", changed: false, warning: "locked_trader_underperforming" });
  });

  it("classifies early leaders with probabilistic multi-label scores", () => {
    const styles = classifyTraderStyles({ medianEntryMarketCapUsd: 120_000, medianTokenAgeMs: 20 * 60_000, medianHoldingMs: 8 * 60 * 60_000, relativePositionSize: 0.6, leaderRate: 0.9, momentumEntryRate: 0.2, narrativeEntryRate: 0.3 });
    expect(styles.EARLY_LAUNCH).toBeGreaterThan(0.8);
    expect(styles.LEADER).toBe(0.9);
    expect(styles.SWING).toBeGreaterThan(styles.SCALPER);
  });

  it("classifies high-multiple, large-cap, and old-token behavior", () => {
    const styles = classifyTraderStyles({ medianEntryMarketCapUsd: 6_000_000, medianTokenAgeMs: 2 * 24 * 60 * 60_000, medianHoldingMs: 24 * 60 * 60_000, relativePositionSize: 0.7, leaderRate: 0.5, momentumEntryRate: 0.4, narrativeEntryRate: 0.2, highMultipleRate: 0.8, oldTokenEntryRate: 0.9 });
    expect(styles.HIGH_MULTIPLE).toBe(0.8);
    expect(styles.LARGE_CAP).toBe(1);
    expect(styles.OLD_TOKEN_MOMENTUM).toBe(0.9);
  });
});
