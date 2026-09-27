export type TraderCoverageState =
  | "unseen"
  | "queued"
  | "backfilling"
  | "current"
  | "degraded"
  | "stale";

export type TraderMonitoringPolicy = "realtime" | "periodic" | "lightweight" | "off";

export type TraderAutomationTier = "T0" | "T1" | "T2" | "T3";

export interface TraderAutomationState {
  readonly traderId: string;
  readonly tier: TraderAutomationTier;
  readonly coverageState: TraderCoverageState;
  readonly monitoringPolicy: TraderMonitoringPolicy;
  readonly lastCoveredAt: number | null;
  readonly nextEvaluationAt: number;
  readonly strategyVersion: string;
}

export type RepeatableTraderAbilityWindow = "24h" | "7d" | "30d";

export type RepeatableTraderAbilityStage = "discovered" | "candidate" | "stable" | "degraded";

export type TraderBundleRiskState = "none" | "single_cluster" | "bundle_risk";

export interface RepeatableTraderAbilityMetrics {
  readonly totalSamples: number;
  readonly validSamples: number;
  readonly successfulDistinctTokens: number;
  readonly winRate: number;
  readonly sampleSpanMs: number;
  readonly maximumSingleTokenProfitShare: number;
}

export interface RepeatableTraderAbilityEvaluation {
  readonly window: RepeatableTraderAbilityWindow;
  readonly stage: RepeatableTraderAbilityStage;
  readonly stable: boolean;
  readonly metrics: RepeatableTraderAbilityMetrics;
  readonly reasonCodes: readonly string[];
}
