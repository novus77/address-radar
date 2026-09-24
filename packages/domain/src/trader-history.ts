export const TRADER_OUTCOME_HORIZONS = Object.freeze(["60s", "5m", "15m", "1h", "6h", "24h", "3d", "7d"] as const);

export type TraderOutcomeHorizon = (typeof TRADER_OUTCOME_HORIZONS)[number];
export type TraderAbilityWindow = "7d" | "30d" | "90d" | "lifetime";
export type TraderSampleSourceState = "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN" | "UNKNOWN";
export type TraderSampleStatus = "included" | "dust" | "non_trade" | "identity_conflict";
export type OutcomeCoverageStatus = "complete" | "pending" | "unavailable";

export interface MarketObservation {
  readonly observedAt: number;
  readonly priceUsd: number;
  readonly source: string;
}

export interface TraderTokenSample {
  readonly sampleId: string;
  readonly entityId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly firstBuyAt: number;
  readonly lastActivityAt: number;
  readonly weightedEntryPriceUsd: number | null;
  readonly weightedEntryMarketCapUsd: number | null;
  readonly totalBuyUsd: number;
  readonly totalSellUsd: number;
  readonly realizedValueUsd: number;
  readonly remainingCostUsd: number;
  readonly launchAt: number | null;
  readonly lifecycleStageAtEntry: string;
  readonly sourceState: TraderSampleSourceState;
  readonly sampleStatus: TraderSampleStatus;
  readonly exclusionReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TraderTokenOutcome {
  readonly sampleId: string;
  readonly horizon: TraderOutcomeHorizon;
  readonly targetAt: number;
  readonly observedAt: number | null;
  readonly closeMultiple: number | null;
  readonly mfeMultiple: number | null;
  readonly maeMultiple: number | null;
  readonly capturedMultiple: number | null;
  readonly hit1_5x: boolean | null;
  readonly hit2x: boolean | null;
  readonly hit5x: boolean | null;
  readonly hit10x: boolean | null;
  readonly timeTo1_5xMs: number | null;
  readonly timeTo2xMs: number | null;
  readonly timeTo5xMs: number | null;
  readonly timeTo10xMs: number | null;
  readonly coverageStatus: OutcomeCoverageStatus;
  readonly source: string | null;
  readonly computedAt: number;
}

export interface TraderAbilitySnapshot {
  readonly snapshotId: string;
  readonly entityId: string;
  readonly window: TraderAbilityWindow;
  readonly asOf: number;
  readonly strategyVersion: string;
  readonly rawQuality: number;
  readonly adjustedQuality: number;
  readonly sampleConfidence: number;
  readonly coverageConfidence: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly components: Readonly<Record<string, number>>;
  readonly styles: Readonly<Record<string, number>>;
  readonly createdAt: number;
}

export type TraderBackfillStatus = "pending" | "running" | "completed" | "failed";

export interface TraderBackfillJob {
  readonly jobId: string;
  readonly entityId: string;
  readonly status: TraderBackfillStatus;
  readonly cursor: string | null;
  readonly attemptCount: number;
  readonly coverage: Readonly<Record<string, number>>;
  readonly lastError?: string | null;
  readonly nextAttemptAt: number;
  readonly completedAt?: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
