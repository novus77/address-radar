import type { TraderLifecycle } from "./model.js";

export interface LifecycleInput {
  readonly current: TraderLifecycle;
  readonly quality: number;
  readonly independentHighMultipleCases: number;
  readonly sampleCount: number;
  readonly recentValidity: number;
  readonly locked: boolean;
  readonly previousBelowThresholdCount?: number;
}

export interface LifecycleDecision {
  readonly next: TraderLifecycle;
  readonly changed: boolean;
  readonly reasons: readonly string[];
  readonly warning?: string;
}

export function decideLifecycleWithReason(input: LifecycleInput): LifecycleDecision {
  let proposed = input.current;
  const reasons: string[] = [];
  const underperforming = (input.current === "active" || input.current === "elite") && (input.quality < 0.4 || input.recentValidity < 0.35);
  if (underperforming && (input.previousBelowThresholdCount ?? 0) >= 1) {
    proposed = "degraded";
    reasons.push("recent_performance_degraded");
  } else if (underperforming) {
    reasons.push("performance_below_threshold");
  } else if (input.current === "degraded" && input.quality < 0.3 && input.recentValidity < 0.25 && (input.previousBelowThresholdCount ?? 0) >= 1) {
    proposed = "suspended";
    reasons.push("sustained_underperformance");
  } else if ((input.current === "candidate" || input.current === "probation") && input.quality >= 0.7 && input.independentHighMultipleCases >= 3 && input.sampleCount >= 20 && input.recentValidity >= 0.6) {
    proposed = "active";
    reasons.push("repeatable_high_alpha");
  } else if (input.current === "candidate" && (input.sampleCount >= 10 || input.independentHighMultipleCases >= 2)) {
    proposed = "probation";
    reasons.push("sufficient_observation_sample");
  } else if (input.current === "active" && input.quality >= 0.8 && input.independentHighMultipleCases >= 5 && input.sampleCount >= 50 && input.recentValidity >= 0.7) {
    proposed = "elite";
    reasons.push("elite_repeatability");
  } else if ((input.current === "degraded" || input.current === "suspended") && input.quality >= 0.65 && input.recentValidity >= 0.6) {
    proposed = "probation";
    reasons.push("performance_recovery");
  }
  if (input.locked && (proposed !== input.current || underperforming)) return Object.freeze({ next: input.current, changed: false, reasons: Object.freeze(reasons), warning: "locked_trader_underperforming" });
  return Object.freeze({ next: proposed, changed: proposed !== input.current, reasons: Object.freeze(reasons) });
}
