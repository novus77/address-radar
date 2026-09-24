import { describe, expect, it } from "vitest";

import {
  CANDIDATE_ADMISSION_WINDOW_MS,
  evaluateCandidateAdmission,
  type CandidateEvidenceFact,
  type CandidateEvidenceType,
} from "@address-radar/scoring";

const DAY_MS = 24 * 60 * 60 * 1_000;
const evaluatedAt = 40 * DAY_MS;

function evidence(
  tokenKey: string,
  evidenceType: CandidateEvidenceType,
  evidenceAt: number,
): CandidateEvidenceFact {
  return { tokenKey, evidenceType, evidenceAt };
}

describe("candidate admission policy", () => {
  it("admits two distinct non-consecutive Early tokens inside 30 days", () => {
    const result = evaluateCandidateAdmission([
      evidence("solana:token-a", "market_cap_100k_3x", evaluatedAt - 20 * DAY_MS),
      evidence("base:token-b", "market_cap_200k_5x", evaluatedAt - DAY_MS),
    ], evaluatedAt);

    expect(CANDIDATE_ADMISSION_WINDOW_MS).toBe(30 * DAY_MS);
    expect(result).toMatchObject({
      currentAdmission: true,
      earlyDistinctTokenCount: 2,
      strongDistinctTokenCount: 0,
      status: "current_admitted",
    });
  });

  it("keeps one Early token waiting for a second independent token", () => {
    const result = evaluateCandidateAdmission([
      evidence("solana:token-a", "market_cap_100k_5x", evaluatedAt - DAY_MS),
    ], evaluatedAt);

    expect(result).toMatchObject({
      currentAdmission: false,
      earlyDistinctTokenCount: 1,
      status: "awaiting_second_early_token",
    });
  });

  it("admits one Strong token inside 30 days", () => {
    const result = evaluateCandidateAdmission([
      evidence("bsc:token-a", "market_cap_500k_10x", evaluatedAt - DAY_MS),
    ], evaluatedAt);

    expect(result).toMatchObject({
      currentAdmission: true,
      strongDistinctTokenCount: 1,
      status: "current_admitted",
    });
  });

  it("preserves expired evidence as historical capability", () => {
    const result = evaluateCandidateAdmission([
      evidence("solana:token-a", "market_cap_100k_5x", evaluatedAt - 31 * DAY_MS),
      evidence("base:token-b", "market_cap_200k_5x", evaluatedAt - 32 * DAY_MS),
    ], evaluatedAt);

    expect(result).toMatchObject({
      currentAdmission: false,
      historicalCapability: true,
      historicalDistinctTokenCount: 2,
      earlyDistinctTokenCount: 0,
      status: "awaiting_recent_confirmation",
    });
  });

  it("counts multiple tiers on one token only once", () => {
    const result = evaluateCandidateAdmission([
      evidence("solana:token-a", "market_cap_100k_3x", evaluatedAt - 2 * DAY_MS),
      evidence("solana:token-a", "market_cap_200k_5x", evaluatedAt - DAY_MS),
    ], evaluatedAt);

    expect(result).toMatchObject({
      currentAdmission: false,
      earlyDistinctTokenCount: 1,
      historicalDistinctTokenCount: 1,
    });
  });
});
