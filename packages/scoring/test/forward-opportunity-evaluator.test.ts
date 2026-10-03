import { describe, expect, it } from "vitest";
import * as evaluator from "../src/forward-opportunity-evaluator.js";
import type { ForwardOpportunitySample, ForwardPeakEvidence } from "@address-radar/domain";
const now = Date.parse("2026-10-03T00:00:00Z");
const sample = (changes: Partial<ForwardOpportunitySample> = {}): ForwardOpportunitySample => ({
  sampleId: "sample-1", executionFingerprint: "execution-v1", entityId: "entity-1", chain: "base", tokenAddress: "0xabc",
  boughtAt: now, amountUsd: "50", amountEstimated: true, entryPriceUsd: "0.01", entryBasisVerified: true,
  executionEvidenceRef: "execution:1", ...changes,
});
const peak = (changes: Partial<ForwardPeakEvidence> = {}): ForwardPeakEvidence => ({
  peakId: "peak-1", revisionId: "peak-v1", chain: "base", tokenAddress: "0xabc", priceUsd: "0.03",
  verification: "validated", evidenceRef: "market:1", knownAt: now + 1000, kind: "trade", occurredAt: now + 1000,
  ...changes,
} as ForwardPeakEvidence);
const evaluate = (entry = sample(), peaks: readonly ForwardPeakEvidence[] = [peak()], asOf = now + 2000) =>
  evaluator.evaluateForwardOpportunity({ sample: entry, peaks, asOf });
describe("forward opportunity evaluation", () => {
  it("exports an execution-based forward evaluator", () => {
    expect((evaluator as Record<string, unknown>).evaluateForwardOpportunity).toBeTypeOf("function");
  });
  it("excludes amounts below 50 while retaining nominal stablecoin estimation", () => {
    expect(evaluate(sample({ amountUsd: "49.999" })).status).toBe("excluded");
    expect(evaluate()).toMatchObject({ status: "hit", tier: 3, amountEstimated: true });
  });
  it("evaluates exactly 3x and 5x without a realized sale", () => {
    expect(evaluate().tier).toBe(3);
    expect(evaluate(sample(), [peak({ priceUsd: "0.05" })]).tier).toBe(5);
  });
  it("does not round tiny decimals across an opportunity threshold", () => {
    const entry = sample({ entryPriceUsd: "0.000000000000000001" });
    expect(evaluate(entry, [peak({ priceUsd: "0.000000000000000002999999999999999999" })]).status).toBe("observing");
    expect(evaluate(entry, [peak({ priceUsd: "0.000000000000000003" })]).tier).toBe(3);
  });
  it("does not treat a source-reported price as executed entry evidence", () => {
    expect(evaluate(sample({ entryBasisVerified: false })).status).toBe("awaiting_verification");
    expect(evaluate(sample({ entryPriceUsd: null })).status).toBe("awaiting_verification");
    expect(evaluate(sample({ executionEvidenceRef: null })).status).toBe("awaiting_verification");
  });
  it("rejects pre-entry and unavailable future peaks", () => {
    expect(evaluate(sample(), [peak({ occurredAt: now - 1 })]).status).toBe("awaiting_verification");
    expect(evaluate(sample(), [peak({ knownAt: now + 3000, occurredAt: now + 3000 })]).status).toBe("awaiting_verification");
  });
  it("does not use entry-overlapping candle highs", () => {
    const candle: ForwardPeakEvidence = { ...peak(), kind: "candle", openedAt: now - 1000, closedAt: now + 1000 };
    expect(evaluate(sample(), [candle])).toMatchObject({ status: "awaiting_verification", reasonCode: "entry_overlapping_candle" });
  });
  it("accepts a validated candle entirely inside the sample interval", () => {
    const candle: ForwardPeakEvidence = { ...peak(), kind: "candle", openedAt: now, closedAt: now + 1000 };
    expect(evaluate(sample(), [candle])).toMatchObject({ status: "hit", tier: 3 });
  });
  it("keeps low-quality and unrelated-token observations out of evidence", () => {
    expect(evaluate(sample(), [peak({ verification: "pending_review" })]).status).toBe("awaiting_verification");
    expect(evaluate(sample(), [peak({ chain: "eth" })]).status).toBe("awaiting_verification");
  });
  it("does not call an expired sparse sample a failed opportunity", () => {
    expect(evaluate(sample(), [peak({ priceUsd: "0.02" })], now + 30 * 86400000)).toMatchObject({
      status: "insufficient_coverage", reasonCode: "complete_non_hit_proof_unconfigured", tier: 0,
    });
  });
  it("preserves a positive proven hit despite unrelated coverage gaps", () => {
    expect(evaluate(sample(), [peak()], now + 30 * 86400000)).toMatchObject({ status: "hit", tier: 3 });
  });
  it("rejects invalid decimal evidence and future purchases", () => {
    expect(() => evaluate(sample(), [peak({ priceUsd: "0" })])).toThrow("positive");
    expect(() => evaluate(sample({ boughtAt: now + 3000 }))).toThrow("purchase");
  });
});
