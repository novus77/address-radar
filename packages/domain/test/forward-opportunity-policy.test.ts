import { describe, expect, it } from "vitest";
import {
  assessForwardOpportunity, forwardDecimal, forwardExtendedCaptureDeadline, forwardInitialCaptureDeadline,
  forwardQualifyingBuyAmount, forwardReachedMarketCapTiers, FORWARD_CAPTURE_EXTENSION_MS, FORWARD_OPPORTUNITY_WINDOW_MS,
} from "../src/forward-opportunity-policy.js";

describe("forward opportunity policy", () => {
  it("starts capture at discovery independently of the 100K screening threshold", () => {
    expect(forwardInitialCaptureDeadline(1000)).toBe(1000 + FORWARD_CAPTURE_EXTENSION_MS);
    expect(forwardReachedMarketCapTiers("99999.999999999999999999")).toEqual([]);
    expect(forwardReachedMarketCapTiers("100000")).toEqual([100000]);
  });
  it("extends from event time without shortening a window", () => {
    const initial = forwardInitialCaptureDeadline(1000);
    expect(forwardExtendedCaptureDeadline(initial, 500)).toBe(initial);
    expect(forwardExtendedCaptureDeadline(initial, 2000)).toBe(initial + 1000);
  });
  it("preserves exact nominal dollar boundary comparisons", () => {
    expect(forwardQualifyingBuyAmount("49.9999999999999999999999")).toBe(false);
    expect(forwardQualifyingBuyAmount("50.0000000000000000000001")).toBe(true);
    expect(forwardDecimal("00050.000")).toBe("50");
    expect(() => forwardDecimal("5e1")).toThrow();
  });
  it("recognizes every first reached market-cap tier without floating-point rounding", () => {
    expect(forwardReachedMarketCapTiers("300000.5")).toEqual([100000, 200000, 300000]);
    expect(forwardReachedMarketCapTiers("1000000")).toEqual([100000, 200000, 300000, 500000, 1000000]);
  });
  it("requires real entry evidence even when the reported peak appears profitable", () => {
    expect(assessForwardOpportunity({ boughtAt: 1000, now: 2000, entryPriceUsd: "1", entryBasisVerified: false,
      peak: { priceUsd: "100", occurredAt: 1500, verification: "validated" } })).toEqual({ status: "deferred", reasonCode: "missing_execution_basis" });
  });
  it("does not confirm pending-review peaks", () => {
    expect(assessForwardOpportunity({ boughtAt: 1000, now: 2000, entryPriceUsd: "1", entryBasisVerified: true,
      peak: { priceUsd: "5", occurredAt: 1500, verification: "pending_review" } })).toEqual({ status: "deferred", reasonCode: "price_pending_review" });
  });
  it("confirms exact 3x and 5x opportunity without requiring a sale", () => {
    const input = { boughtAt: 1000, now: 2000, entryPriceUsd: "0.000000000000000000001", entryBasisVerified: true };
    expect(assessForwardOpportunity({ ...input, peak: { priceUsd: "0.000000000000000000003", occurredAt: 1500, verification: "validated" } }))
      .toEqual({ status: "confirmed", tier: 3 });
    expect(assessForwardOpportunity({ ...input, peak: { priceUsd: "0.000000000000000000005", occurredAt: 1500, verification: "validated" } }))
      .toEqual({ status: "confirmed", tier: 5 });
  });
  it("excludes pre-buy and deadline-or-later peaks", () => {
    const input = { boughtAt: 1000, now: 1000 + FORWARD_OPPORTUNITY_WINDOW_MS, entryPriceUsd: "1", entryBasisVerified: true };
    expect(assessForwardOpportunity({ ...input, peak: { priceUsd: "5", occurredAt: 999, verification: "validated" } }).status).toBe("deferred");
    expect(assessForwardOpportunity({ ...input, peak: { priceUsd: "5", occurredAt: input.now, verification: "validated" } }).status).toBe("deferred");
  });
  it("keeps confirmed within-window evidence after the window elapses", () => {
    expect(assessForwardOpportunity({ boughtAt: 1000, now: 1001 + FORWARD_OPPORTUNITY_WINDOW_MS,
      entryPriceUsd: "1", entryBasisVerified: true, peak: { priceUsd: "5", occurredAt: 2000, verification: "validated" } }))
      .toEqual({ status: "confirmed", tier: 5 });
  });
  it("never treats elapsed time or a partial non-hit peak as proof of failure", () => {
    const input = { boughtAt: 1000, now: 1000 + FORWARD_OPPORTUNITY_WINDOW_MS, entryPriceUsd: "1", entryBasisVerified: true };
    expect(assessForwardOpportunity({ ...input, peak: null })).toEqual({ status: "deferred", reasonCode: "window_elapsed_unverified" });
    expect(assessForwardOpportunity({ ...input, peak: { priceUsd: "2", occurredAt: 2000, verification: "validated" } }))
      .toEqual({ status: "deferred", reasonCode: "window_elapsed_unverified" });
  });
});
