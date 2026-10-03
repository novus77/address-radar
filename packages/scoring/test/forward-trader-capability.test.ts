import { describe, expect, it } from "vitest";
import type { ForwardTraderCapabilityFact } from "@address-radar/domain";
import { evaluateForwardOpportunity } from "../src/forward-opportunity-evaluator.js";
import { evaluateForwardTraderCapability } from "../src/forward-trader-capability.js";

const DAY = 86400000, NOW = 100 * DAY;
function fact(token: string, multiple = "3", overrides: Partial<ForwardTraderCapabilityFact> = {}): ForwardTraderCapabilityFact {
  const sample = { sampleId: `sample:${token}`, executionFingerprint: "execution-v1", entityId: "entity", chain: "base",
    tokenAddress: token, boughtAt: NOW - DAY, amountUsd: "50", amountEstimated: true, entryPriceUsd: "1",
    entryBasisVerified: true, executionEvidenceRef: "fixture:execution" };
  const peak = { peakId: `peak:${token}`, revisionId: "v1", kind: "trade" as const, chain: "base", tokenAddress: token,
    priceUsd: multiple, verification: "validated" as const, evidenceRef: "fixture:market", occurredAt: NOW - 1, knownAt: NOW - 1 };
  return { generationId: "generation", sampleCreatedAt: NOW - DAY, sample, peak,
    evaluationId: `evaluation:${token}`, evaluation: evaluateForwardOpportunity({ sample, peaks: [peak], asOf: NOW }),
    screening: { observedAt: NOW - 1, knownAt: NOW, evidenceRef: "fixture:100k" }, ...overrides };
}
const evaluate = (facts: readonly ForwardTraderCapabilityFact[], asOf = NOW) => evaluateForwardTraderCapability({
  generationId: "generation", entityId: "entity", activatedAt: NOW - 20 * DAY, asOf, facts });

describe("approved forward stable capability", () => {
  it("requires three distinct 3x tokens, without requiring a sale or a mature cohort", () => {
    expect(evaluate([fact("0xa"), fact("0xb"), fact("0xc")])).toMatchObject({ stableCapability: true,
      cohortMaturity: "collecting", metrics: { hit3xTokens: 3, hit5xTokens: 0 } });
  });
  it("accepts two distinct 5x tokens independently", () => {
    expect(evaluate([fact("0xa", "5"), fact("0xb", "5")])).toMatchObject({ stableCapability: true,
      metrics: { hit3xTokens: 2, hit5xTokens: 2 } });
  });
  it("keeps two 3x tokens below stable capability even if legacy Early admission differs", () => {
    expect(evaluate([fact("0xa"), fact("0xb")])).toMatchObject({ stableCapability: false, observationStatus: "candidate_observed" });
  });
  it("does not count repeat purchases or 3x/5x tiers as distinct tokens", () => {
    const first = fact("0xa", "5");
    const second = { ...first, sample: { ...first.sample, sampleId: "second" }, evaluationId: "second-result",
      evaluation: { ...first.evaluation!, sampleId: "second" } };
    expect(evaluate([first, first, second])).toMatchObject({ stableCapability: false, metrics: { samples: 2, distinctTokens: 1, hit5xTokens: 1 } });
  });
  it("normalizes EVM identity while preserving Solana mint case", () => {
    const upper = fact("0xABC", "5"), lower = fact("0xabc", "5");
    expect(evaluate([upper, lower]).metrics.distinctTokens).toBe(1);
    const solana = [fact("MintA", "5"), fact("Minta", "5")].map(value => ({ ...value,
      sample: { ...value.sample, chain: "solana" }, peak: { ...value.peak!, chain: "solana" } }));
    expect(evaluate(solana).metrics.distinctTokens).toBe(2);
  });
  it("waits for observed available 100K evidence, then screens already stored buys", () => {
    const original = fact("0xa", "5");
    expect(evaluate([{ ...original, screening: null }])).toMatchObject({ stableCapability: false,
      observationStatus: "awaiting_screening", metrics: { awaitingScreeningTokens: 1, hit3xTokens: 0 } });
    expect(evaluate([original]).metrics.hit5xTokens).toBe(1);
    expect(evaluate([{ ...original, screening: { ...original.screening!, knownAt: NOW + 1 } }]).metrics.hit5xTokens).toBe(0);
  });
  it("keeps missing data in the denominator without calling it a failed trade", () => {
    expect(evaluate([fact("0xa", "5"), fact("0xb", "5"), fact("0xc", "3", { evaluation: null, evaluationId: null, peak: null })]))
      .toMatchObject({ stableCapability: true, metrics: { distinctTokens: 3, awaitingEvidenceTokens: 1, estimatedAmountSamples: 3 } });
  });
  it("excludes legacy generations and unavailable or out-of-cohort samples", () => {
    const original = fact("0xa");
    expect(evaluate([{ ...original, generationId: "legacy" }, { ...fact("0xb"), sampleCreatedAt: NOW + 1 }]).metrics.samples).toBe(0);
    expect(evaluate([original], NOW + 30 * DAY).metrics.samples).toBe(0);
  });
  it("checks actual execution and peak evidence rather than trusting a claimed hit", () => {
    const original = fact("0xa", "5");
    expect(evaluate([{ ...original, sample: { ...original.sample, entryBasisVerified: false } }]).metrics.hit5xTokens).toBe(0);
    expect(evaluate([{ ...original, peak: { ...original.peak!, verification: "pending_review" } }]).metrics.hit5xTokens).toBe(0);
    expect(evaluate([{ ...original, evaluation: { ...original.evaluation!, executionFingerprint: "obsolete" } }]).metrics.hit5xTokens).toBe(0);
  });
  it("rejects conflicting sample identities and wrong owners", () => {
    const original = fact("0xa");
    expect(() => evaluate([original, { ...original, sample: { ...original.sample, amountUsd: "51" } }])).toThrow("Conflicting");
    expect(() => evaluate([{ ...original, sample: { ...original.sample, entityId: "other" } }])).toThrow("identity");
  });
  it("excludes amounts below 50 without losing the estimate marker", () => {
    const original = fact("0xa");
    expect(evaluate([{ ...original, sample: { ...original.sample, amountUsd: "49.999" } }]).metrics.samples).toBe(0);
    expect(evaluate([original]).metrics.estimatedAmountSamples).toBe(1);
  });
});
