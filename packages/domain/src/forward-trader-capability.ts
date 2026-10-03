import type { ForwardOpportunityEvaluation, ForwardOpportunitySample, ForwardPeakEvidence } from "./forward-opportunity-evidence.js";

export const FORWARD_TRADER_CAPABILITY_VERSION = "forward-trader-capability-v1";
export interface ForwardTraderCapabilityFact {
  readonly generationId: string;
  readonly sampleCreatedAt: number;
  readonly sample: ForwardOpportunitySample;
  readonly evaluationId: string | null;
  readonly evaluation: ForwardOpportunityEvaluation | null;
  readonly peak: ForwardPeakEvidence | null;
  readonly screening: { readonly observedAt: number; readonly knownAt: number; readonly evidenceRef: string } | null;
}
export interface ForwardTraderCapabilityProjection {
  readonly strategyVersion: typeof FORWARD_TRADER_CAPABILITY_VERSION;
  readonly generationId: string;
  readonly entityId: string;
  readonly asOf: number;
  readonly cohortStart: number;
  readonly cohortEnd: number;
  readonly observationStatus: "no_samples" | "awaiting_screening" | "observing" | "candidate_observed";
  readonly stableCapability: boolean;
  readonly cohortMaturity: "collecting" | "observation_period_elapsed";
  readonly labels: readonly ("repeated_discovery" | "repeated_high_multiple_discovery")[];
  readonly sampleIds: readonly string[];
  readonly metrics: {
    readonly samples: number; readonly distinctTokens: number; readonly screeningReadyTokens: number;
    readonly hit3xTokens: number; readonly hit5xTokens: number; readonly observingTokens: number;
    readonly awaitingScreeningTokens: number; readonly awaitingEvidenceTokens: number;
    readonly matureSamples: number; readonly estimatedAmountSamples: number;
  };
}
