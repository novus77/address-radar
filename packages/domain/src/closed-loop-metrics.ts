export const CLOSED_LOOP_STAGES = [
  "token_discovery",
  "market_history",
  "milestone_confirmation",
  "early_trade_recovery",
  "identity_resolution",
  "candidate_evidence",
  "ability_evaluation",
  "candidate_admission",
  "wallet_monitoring",
  "token_aggregation",
  "signal_readiness",
] as const;

export type ClosedLoopStage = (typeof CLOSED_LOOP_STAGES)[number];

export interface StageProgressMetric {
  stage: ClosedLoopStage;
  discovered: number;
  eligible: number;
  pending: number;
  blocked: number;
  completed: number;
  terminal: number;
  producedFacts: number;
  oldestPendingAt: string | null;
  lastProgressAt: string | null;
}

const COUNTER_KEYS = [
  "discovered",
  "eligible",
  "pending",
  "blocked",
  "completed",
  "terminal",
  "producedFacts",
] as const satisfies readonly (keyof StageProgressMetric)[];

export function isClosedLoopStage(value: string): value is ClosedLoopStage {
  return (CLOSED_LOOP_STAGES as readonly string[]).includes(value);
}

export function assertValidStageProgressMetric(metric: StageProgressMetric): void {
  if (!isClosedLoopStage(metric.stage)) {
    throw new Error(`Unknown closed-loop stage: ${metric.stage}`);
  }

  for (const key of COUNTER_KEYS) {
    const value = metric[key];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${key} counter for ${metric.stage}: ${value}`);
    }
  }

  if (metric.completed > metric.eligible) {
    throw new Error(`Completed count exceeds eligible count for ${metric.stage}`);
  }
}

export function assertCompleteClosedLoopMetrics(metrics: readonly StageProgressMetric[]): void {
  const seen = new Set<ClosedLoopStage>();

  for (const metric of metrics) {
    assertValidStageProgressMetric(metric);
    if (seen.has(metric.stage)) {
      throw new Error(`Duplicate closed-loop stage: ${metric.stage}`);
    }
    seen.add(metric.stage);
  }

  const missing = CLOSED_LOOP_STAGES.filter((stage) => !seen.has(stage));
  if (missing.length > 0) {
    throw new Error(`Missing closed-loop stages: ${missing.join(", ")}`);
  }
}
