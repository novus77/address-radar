import { describe, expect, it } from "vitest";
import { hasHistoricalPriceCoverage, mergeHistoricalPrices } from "../src/price-recovery-coverage.js";

const HOUR = 3_600_000;
describe("historical price coverage", () => {
  it("does not treat an entry quote as complete multi-day coverage", () => {
    expect(hasHistoricalPriceCoverage([[HOUR, 1]], { fromAt: HOUR, toAt: HOUR * 72 })).toBe(false);
  });
  it("rejects interior gaps despite matching endpoints", () => {
    expect(hasHistoricalPriceCoverage([[HOUR, 1], [HOUR * 4, 2]], { fromAt: HOUR, toAt: HOUR * 4 })).toBe(false);
  });
  it("preserves primary prices when a fallback is empty", () => {
    expect(mergeHistoricalPrices([[HOUR, 1]], [], { fromAt: HOUR, toAt: HOUR })).toEqual([[HOUR, 1]]);
  });
  it("rejects future and invalid fallback points", () => {
    expect(mergeHistoricalPrices([[HOUR, 1]], [[HOUR * 2, 10], [HOUR, 0]], { fromAt: HOUR, toAt: HOUR })).toEqual([[HOUR, 1]]);
  });
  it("accepts continuous hourly coverage", () => {
    expect(hasHistoricalPriceCoverage([[HOUR, 1], [HOUR * 2, 2], [HOUR * 3, 3]], { fromAt: HOUR, toAt: HOUR * 3 })).toBe(true);
  });
});
