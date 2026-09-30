import { describe, expect, it } from "vitest";
import { milestoneRecoveryGap } from "../src/milestone-recovery-policy.js";

describe("milestone recovery gaps", () => {
  it("distinguishes missing pools from missing supply", () => {
    expect(milestoneRecoveryGap({ poolFound: false, supplyAvailable: false, candleCount: 0 })).toBe("historical_milestone_pool_missing");
    expect(milestoneRecoveryGap({ poolFound: true, supplyAvailable: false, candleCount: 0 })).toBe("historical_milestone_supply_unavailable");
  });
  it("never treats an unverified scan as proof of no historical crossing", () => {
    expect(milestoneRecoveryGap({ poolFound: true, supplyAvailable: true, candleCount: 0 })).toBe("historical_milestone_coverage_missing");
    expect(milestoneRecoveryGap({ poolFound: true, supplyAvailable: true, candleCount: 100 })).toBe("historical_milestone_crossing_unverified");
  });
});
