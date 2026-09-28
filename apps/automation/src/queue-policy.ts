import type { AutomationQueueMetrics, AutomationJobStoreOptions } from "@address-radar/database";

export interface QueueTypePolicy {
  readonly highWaterMark: number;
  readonly concurrencyLimit: number;
  readonly retryBudget: number;
  readonly workload: "live" | "historical";
}

export const DEFAULT_QUEUE_TYPE_POLICIES = Object.freeze<Readonly<Record<string, QueueTypePolicy>>>({
  candidate_evidence: Object.freeze({ highWaterMark: 2_000, concurrencyLimit: 2, retryBudget: 8, workload: "live" }),
  ability_evaluation: Object.freeze({ highWaterMark: 1_000, concurrencyLimit: 2, retryBudget: 6, workload: "live" }),
  trader_lightweight_evaluation: Object.freeze({ highWaterMark: 1_000, concurrencyLimit: 1, retryBudget: 5, workload: "live" }),
  initial_wallet_backfill: Object.freeze({ highWaterMark: 500, concurrencyLimit: 1, retryBudget: 6, workload: "historical" }),
  token_partition: Object.freeze({ highWaterMark: 500, concurrencyLimit: 1, retryBudget: 5, workload: "historical" }),
  token_mining: Object.freeze({ highWaterMark: 1_000, concurrencyLimit: 1, retryBudget: 6, workload: "historical" }),
});

export interface QueuePolicyDecision {
  readonly admitHistorical: boolean;
  readonly converging: boolean;
  readonly reason: "healthy" | "high_water_mark" | "growing_backlog";
  readonly runnableDelta: number;
  readonly oldestRunnableAgeDeltaMs: number;
  readonly admissionRatePerMinute: number;
  readonly completionRatePerMinute: number;
}

export function automationJobStoreOptions(): AutomationJobStoreOptions {
  return Object.freeze({
    retryBudgetByJobType: Object.fromEntries(
      Object.entries(DEFAULT_QUEUE_TYPE_POLICIES).map(([jobType, policy]) => [jobType, policy.retryBudget]),
    ),
    concurrencyLimitByJobType: Object.fromEntries(
      Object.entries(DEFAULT_QUEUE_TYPE_POLICIES).map(([jobType, policy]) => [jobType, policy.concurrencyLimit]),
    ),
  });
}

export function createQueueAdmissionPolicy(input: {
  readonly policies?: Readonly<Record<string, QueueTypePolicy>>;
  readonly globalHistoricalHighWaterMark?: number;
  readonly growingWindowsBeforePause?: number;
} = {}) {
  const policies = input.policies ?? DEFAULT_QUEUE_TYPE_POLICIES;
  const globalHistoricalHighWaterMark = input.globalHistoricalHighWaterMark ?? 2_000;
  const growingWindowsBeforePause = input.growingWindowsBeforePause ?? 2;
  let previous: AutomationQueueMetrics | null = null;
  let consecutiveGrowth = 0;

  return Object.freeze({
    evaluate(current: AutomationQueueMetrics): QueuePolicyDecision {
      const runnableDelta = previous === null ? 0 : current.runnable - previous.runnable;
      const oldestRunnableAgeDeltaMs = previous === null
        ? 0
        : current.oldestRunnableAgeMs - previous.oldestRunnableAgeMs;
      consecutiveGrowth = runnableDelta > 0 ? consecutiveGrowth + 1 : 0;
      const historicalHighWater = Object.entries(policies).some(([jobType, policy]) =>
        policy.workload === "historical"
        && (current.byJobType[jobType]?.runnable ?? 0) >= policy.highWaterMark,
      );
      const totalHistorical = Object.entries(policies).reduce((total, [jobType, policy]) =>
        total + (policy.workload === "historical" ? current.byJobType[jobType]?.runnable ?? 0 : 0), 0);
      const growingBacklog = consecutiveGrowth >= growingWindowsBeforePause;
      const highWater = historicalHighWater || totalHistorical >= globalHistoricalHighWaterMark;
      const windowMinutes = Math.max(1 / 60, current.windowMs / 60_000);
      const decision = Object.freeze({
        admitHistorical: !highWater && !growingBacklog,
        converging: current.completed > current.admitted && oldestRunnableAgeDeltaMs <= 0,
        reason: highWater ? "high_water_mark" as const : growingBacklog ? "growing_backlog" as const : "healthy" as const,
        runnableDelta,
        oldestRunnableAgeDeltaMs,
        admissionRatePerMinute: current.admitted / windowMinutes,
        completionRatePerMinute: current.completed / windowMinutes,
      });
      previous = current;
      return decision;
    },
  });
}
