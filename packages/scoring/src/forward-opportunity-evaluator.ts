import {
  assessForwardOpportunity, canonicalForwardPeak, forwardDecimal, forwardQualifyingBuyAmount,
  forwardEvidenceIdentifier, forwardEvidenceTime, FORWARD_OPPORTUNITY_WINDOW_MS,
  FORWARD_OPPORTUNITY_EVIDENCE_VERSION, normalizeAddressRadarTokenAddress,
  type ForwardOpportunitySample, type ForwardPeakEvidence, type ForwardOpportunityEvaluation,
} from "@address-radar/domain";

function higher(left: string, right: string): boolean {
  const [lw = "", lf = ""] = forwardDecimal(left).split(".");
  const [rw = "", rf = ""] = forwardDecimal(right).split(".");
  return BigInt(lw + lf) * 10n ** BigInt(rf.length) > BigInt(rw + rf) * 10n ** BigInt(lf.length);
}
export function evaluateForwardOpportunity(input: {
  readonly sample: ForwardOpportunitySample; readonly peaks: readonly ForwardPeakEvidence[]; readonly asOf: number;
}): ForwardOpportunityEvaluation {
  const { sample, asOf } = input;
  [sample.sampleId, sample.executionFingerprint, sample.entityId, sample.chain, sample.tokenAddress].forEach(forwardEvidenceIdentifier);
  forwardEvidenceTime(sample.boughtAt); forwardEvidenceTime(asOf);
  const expiresAt = sample.boughtAt + FORWARD_OPPORTUNITY_WINDOW_MS;
  forwardEvidenceTime(expiresAt);
  if (sample.boughtAt > asOf) throw new Error("Forward purchase is not yet available");
  const result = (status: ForwardOpportunityEvaluation["status"], reasonCode: string, tier: 0 | 3 | 5 = 0,
    peak: ForwardPeakEvidence | null = null): ForwardOpportunityEvaluation => Object.freeze({
    strategyVersion: FORWARD_OPPORTUNITY_EVIDENCE_VERSION, sampleId: sample.sampleId,
    executionFingerprint: sample.executionFingerprint, status, tier, reasonCode,
    peakId: peak?.peakId ?? null, peakRevisionId: peak?.revisionId ?? null,
    amountEstimated: sample.amountEstimated, expiresAt, computedAt: asOf,
  });
  if (!forwardQualifyingBuyAmount(sample.amountUsd)) return result("excluded", "purchase_below_50_usd");
  if (!sample.entryBasisVerified || !sample.entryPriceUsd || !sample.executionEvidenceRef?.trim()) {
    return result("awaiting_verification", "missing_execution_basis");
  }
  const chain = sample.chain.trim().toLowerCase();
  const address = normalizeAddressRadarTokenAddress(chain, sample.tokenAddress.trim());
  let best: ForwardPeakEvidence | null = null;
  let overlapping = false;
  for (const raw of input.peaks) {
    const peak = canonicalForwardPeak(raw);
    if (peak.chain !== chain || peak.tokenAddress !== address || peak.knownAt > asOf || peak.verification !== "validated") continue;
    const from = peak.kind === "trade" ? peak.occurredAt : peak.openedAt;
    const to = peak.kind === "trade" ? peak.occurredAt : peak.closedAt;
    if (peak.kind === "candle" && from < sample.boughtAt && to > sample.boughtAt) overlapping = true;
    if (from < sample.boughtAt || from >= expiresAt || to > asOf || to > expiresAt) continue;
    const key = JSON.stringify([peak.peakId, peak.revisionId]);
    if (!best || higher(peak.priceUsd, best.priceUsd)
      || (peak.priceUsd === best.priceUsd && key < JSON.stringify([best.peakId, best.revisionId]))) best = peak;
  }
  if (!best) return result(asOf >= expiresAt ? "insufficient_coverage" : "awaiting_verification",
    overlapping ? "entry_overlapping_candle" : "missing_valid_peak");
  // A full post-entry candle proves the high occurred inside its interval, not at an invented exact tick.
  const assessed = assessForwardOpportunity({ boughtAt: sample.boughtAt, now: asOf,
    entryPriceUsd: sample.entryPriceUsd, entryBasisVerified: true,
    peak: { priceUsd: best.priceUsd, occurredAt: best.kind === "trade" ? best.occurredAt : best.openedAt, verification: "validated" } });
  if (assessed.status === "confirmed") return result("hit", "verified_opportunity", assessed.tier, best);
  if (asOf >= expiresAt) return result("insufficient_coverage", "complete_non_hit_proof_unconfigured", 0, best);
  return result("observing", "observation_period_open", 0, best);
}
