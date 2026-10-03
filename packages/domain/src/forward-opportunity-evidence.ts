import { forwardDecimal } from "./forward-opportunity-policy.js";
import { normalizeAddressRadarTokenAddress } from "./rebroadcast.js";

export const FORWARD_OPPORTUNITY_EVIDENCE_VERSION = "forward-opportunity-v1";
export interface ForwardOpportunitySample {
  readonly sampleId: string;
  readonly executionFingerprint: string;
  readonly entityId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly boughtAt: number;
  readonly amountUsd: string;
  readonly amountEstimated: boolean;
  readonly entryPriceUsd: string | null;
  readonly entryBasisVerified: boolean;
  readonly executionEvidenceRef: string | null;
}
interface PeakBasis {
  readonly peakId: string;
  readonly revisionId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly priceUsd: string;
  readonly knownAt: number;
  readonly verification: "validated" | "pending_review";
  readonly evidenceRef: string;
}
export type ForwardPeakEvidence = PeakBasis & (
  | { readonly kind: "trade"; readonly occurredAt: number }
  | { readonly kind: "candle"; readonly openedAt: number; readonly closedAt: number }
);
export interface ForwardOpportunityEvaluation {
  readonly strategyVersion: typeof FORWARD_OPPORTUNITY_EVIDENCE_VERSION;
  readonly sampleId: string;
  readonly executionFingerprint: string;
  readonly status: "hit" | "observing" | "awaiting_verification" | "insufficient_coverage" | "excluded";
  readonly tier: 0 | 3 | 5;
  readonly reasonCode: string;
  readonly peakId: string | null;
  readonly peakRevisionId: string | null;
  readonly amountEstimated: boolean;
  readonly expiresAt: number;
  readonly computedAt: number;
}
export function forwardEvidenceIdentifier(value: string): void {
  if (!value.trim() || value.length > 512) throw new Error("Forward evidence identifier is invalid");
}
export function forwardEvidenceTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Forward evidence timestamp is invalid");
}
export function canonicalForwardPeak(input: ForwardPeakEvidence): ForwardPeakEvidence {
  [input.peakId, input.revisionId, input.chain, input.tokenAddress, input.evidenceRef].forEach(forwardEvidenceIdentifier);
  forwardEvidenceTime(input.knownAt);
  if (!["validated", "pending_review"].includes(input.verification)) throw new Error("Forward peak quality is invalid");
  const priceUsd = forwardDecimal(input.priceUsd);
  if (priceUsd === "0") throw new Error("Forward peak price must be positive");
  const chain = input.chain.trim().toLowerCase();
  const common = { peakId: input.peakId, revisionId: input.revisionId, chain,
    tokenAddress: normalizeAddressRadarTokenAddress(chain, input.tokenAddress.trim()), priceUsd,
    knownAt: input.knownAt, verification: input.verification, evidenceRef: input.evidenceRef };
  if (input.kind === "trade") {
    forwardEvidenceTime(input.occurredAt);
    if (input.knownAt < input.occurredAt) throw new Error("Forward peak availability precedes observation");
    return Object.freeze({ ...common, kind: "trade", occurredAt: input.occurredAt });
  }
  if (input.kind !== "candle") throw new Error("Forward peak kind is invalid");
  forwardEvidenceTime(input.openedAt); forwardEvidenceTime(input.closedAt);
  if (input.closedAt <= input.openedAt || input.knownAt < input.closedAt) throw new Error("Forward candle interval is invalid");
  return Object.freeze({ ...common, kind: "candle", openedAt: input.openedAt, closedAt: input.closedAt });
}
