import { describe, expect, it } from "vitest";

import { analyzeWalletPositions } from "@address-radar/domain";

describe("wallet analysis", () => {
  it("reports coverage, hit rates, and robust multiples", () => {
    const metrics = analyzeWalletPositions({
      requestedSamples: 4,
      positions: [
        { tokenId: "solana:A", enteredAt: 1, investedUsd: 100, realizedValueUsd: 200, remainingValueUsd: 0, peakValueUsd: 500, holdingDurationMs: 1_000, maximumDrawdownRatio: 0.2, earlyEntry: true, largeBuy: false },
        { tokenId: "solana:B", enteredAt: 2, investedUsd: 100, realizedValueUsd: 50, remainingValueUsd: 0, peakValueUsd: 120, holdingDurationMs: 3_000, maximumDrawdownRatio: 0.7, earlyEntry: false, largeBuy: true },
      ],
    });

    expect(metrics).toMatchObject({ requestedSamples: 4, validSamples: 2, coverageRate: 0.5, profitableRate: 0.5, hit2xRate: 0.5, hit5xRate: 0.5, medianPeakMultiple: 3.1, medianRealizedMultiple: 1.25, earlyEntryRate: 0.5, largeBuyRate: 0.5 });
  });

  it("rejects sample limits outside the supported range", () => {
    expect(() => analyzeWalletPositions({ requestedSamples: 301, positions: [] })).toThrow(/between 1 and 300/);
  });
});
