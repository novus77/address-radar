export interface HistoricalToken {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly imageUrl: string | null;
  readonly firstTradeAt: number | null;
  readonly firstReached1mAt: number;
  readonly peakMarketCapUsd: number;
  readonly source: string;
  readonly sourceQueryId: string | null;
  readonly provenance: unknown;
}

export type MilestonePrecision = "exact" | "estimated" | "unavailable";

export interface TokenMilestoneCrossing {
  readonly milestoneId: string;
  readonly tokenId: string;
  readonly marketCapUsd: number;
  readonly crossedAt: number | null;
  readonly precision: MilestonePrecision;
  readonly source: string;
  readonly sourceEventIds: readonly string[];
  readonly strategyVersion: string;
}

export interface CandidateEvidenceV3 {
  readonly evidenceId: string;
  readonly traderId: string;
  readonly tokenId: string;
  readonly milestoneId: string;
  readonly evidenceType: string;
  readonly admissionClass: "early" | "strong";
  readonly cumulativeBuyUsd: number;
  readonly weightedEntryMarketCapUsd: number;
  readonly theoreticalOpportunity: number;
  readonly capturableMultiple: number | null;
  readonly realizedMultiple: number | null;
  readonly evidenceAt: number;
  readonly sourceEventIds: readonly string[];
  readonly strategyVersion: string;
}

export interface PersistedCandidateAdmissionSnapshot {
  readonly snapshotId: string;
  readonly traderId: string;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly earlyDistinctTokenCount: number;
  readonly strongDistinctTokenCount: number;
  readonly historicalDistinctTokenCount: number;
  readonly currentAdmission: boolean;
  readonly historicalCapability: boolean;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly strategyVersion: string;
  readonly evaluatedAt: number;
}
