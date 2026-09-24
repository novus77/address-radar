import { describe, expect, it } from "vitest";

import { evaluateTraderTokenOutcome } from "@address-radar/scoring";

describe("trader token outcome evaluator", () => {
  it("computes close, MFE, MAE and first hit times without using future observations", () => {
    const result = evaluateTraderTokenOutcome({
      sampleId: "entity:solana:token", horizon: "5m", entryAt: 1_000, entryPriceUsd: 1,
      targetAt: 301_000, maximumObservationDelayMs: 120_000,
      observations: [
        { observedAt: 61_000, priceUsd: 0.8, source: "dex" },
        { observedAt: 121_000, priceUsd: 2.1, source: "dex" },
        { observedAt: 301_000, priceUsd: 1.5, source: "dex" },
        { observedAt: 400_000, priceUsd: 10, source: "dex" },
      ],
      capturedMultiple: null, computedAt: 500_000,
    });
    expect(result).toMatchObject({ closeMultiple: 1.5, mfeMultiple: 2.1, maeMultiple: 0.8, hit1_5x: true, hit2x: true, hit5x: false, hit10x: false, timeTo1_5xMs: 120_000, timeTo2xMs: 120_000, coverageStatus: "complete", source: "dex" });
  });

  it("returns unavailable when no observation falls inside the horizon tolerance", () => {
    const result = evaluateTraderTokenOutcome({ sampleId: "sample-unavailable", horizon: "60s", entryAt: 0, entryPriceUsd: 1, targetAt: 60_000, maximumObservationDelayMs: 30_000, observations: [{ observedAt: 100_000, priceUsd: 2, source: "dex" }], capturedMultiple: null, computedAt: 100_000 });
    expect(result).toMatchObject({ coverageStatus: "unavailable", observedAt: null, closeMultiple: null, mfeMultiple: null, maeMultiple: null });
  });

  it("keeps an immature horizon pending", () => {
    const result = evaluateTraderTokenOutcome({ sampleId: "sample-pending", horizon: "1h", entryAt: 0, entryPriceUsd: 1, targetAt: 3_600_000, maximumObservationDelayMs: 900_000, observations: [], capturedMultiple: null, computedAt: 3_000_000 });
    expect(result.coverageStatus).toBe("pending");
  });

  it("rejects a non-positive entry price", () => {
    expect(() => evaluateTraderTokenOutcome({ sampleId: "sample-invalid", horizon: "60s", entryAt: 0, entryPriceUsd: 0, targetAt: 60_000, maximumObservationDelayMs: 30_000, observations: [], capturedMultiple: null, computedAt: 100_000 })).toThrow("entryPriceUsd must be positive");
  });
});
