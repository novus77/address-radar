import { describe, expect, it } from "vitest";

import { CANDIDATE_MILESTONES, evidenceAdmissionClass, strongestSatisfiedTier, type CandidateEvidenceTier, type CandidateEvidenceType } from "@address-radar/scoring";

describe("candidate tier policy", () => {
  it("defines the five approved candidate capability milestones", () => {
    expect(CANDIDATE_MILESTONES.map((milestone) => milestone.marketCapUsd)).toEqual([100_000, 200_000, 300_000, 500_000, 1_000_000]);
  });

  it.each([
    [100_000, 2.99, null], [100_000, 3, "market_cap_100k_3x"], [100_000, 4.99, "market_cap_100k_3x"], [100_000, 5, "market_cap_100k_5x"],
    [200_000, 2.99, null], [200_000, 3, "market_cap_200k_3x"], [200_000, 4.99, "market_cap_200k_3x"], [200_000, 5, "market_cap_200k_5x"],
    [300_000, 4.99, null], [300_000, 5, "market_cap_300k_5x"], [500_000, 4.99, null], [500_000, 5, "market_cap_500k_5x"],
    [500_000, 9.99, "market_cap_500k_5x"], [500_000, 10, "market_cap_500k_10x"], [1_000_000, 9.99, null],
    [1_000_000, 10, "market_cap_1m_10x"], [1_000_000, 19.99, "market_cap_1m_10x"], [1_000_000, 20, "market_cap_1m_20x"],
  ] as const)("selects the strongest tier at %d market cap and %d multiple", (marketCapUsd, multiple, expectedType) => {
    expect(strongestSatisfiedTier(marketCapUsd, multiple)?.type ?? null).toBe(expectedType);
  });

  it("returns no tier for an unsupported milestone", () => {
    expect(strongestSatisfiedTier(400_000, 100)).toBeNull();
  });

  it("assigns stable increasing operational ranks", () => {
    expect(CANDIDATE_MILESTONES.flatMap((milestone) => milestone.tiers).sort((left, right) => left.rank - right.rank).map((tier) => tier.type)).toEqual([
      "market_cap_100k_3x", "market_cap_100k_5x", "market_cap_200k_3x", "market_cap_200k_5x", "market_cap_300k_5x",
      "market_cap_500k_5x", "market_cap_500k_10x", "market_cap_1m_10x", "market_cap_1m_20x",
    ]);
  });

  it.each([
    ["market_cap_100k_3x", "early"], ["market_cap_100k_5x", "early"], ["market_cap_200k_3x", "early"], ["market_cap_200k_5x", "early"],
    ["market_cap_300k_5x", "strong"], ["market_cap_500k_5x", "strong"], ["market_cap_500k_10x", "strong"],
    ["market_cap_1m_10x", "strong"], ["market_cap_1m_20x", "strong"],
  ] satisfies ReadonlyArray<readonly [CandidateEvidenceType, "early" | "strong"]>)("classifies %s evidence as %s", (type, expectedClass) => {
    expect(evidenceAdmissionClass(type)).toBe(expectedClass);
  });

  it("freezes milestones, tier arrays, and tier display definitions", () => {
    const milestone = CANDIDATE_MILESTONES[0]!;
    const tier = milestone.tiers[0]!;

    expect(Object.isFrozen(CANDIDATE_MILESTONES)).toBe(true);
    expect(Object.isFrozen(milestone)).toBe(true);
    expect(Object.isFrozen(milestone.tiers)).toBe(true);
    expect(Object.isFrozen(tier)).toBe(true);
    expect(() => (milestone.tiers as CandidateEvidenceTier[]).pop()).toThrow(TypeError);
    expect(() => { (tier as { label: string }).label = "mutated"; }).toThrow(TypeError);
    expect(tier.label).toBe("100K / 3x");
  });
});
