import { decideLifecycleWithReason, type LifecycleDecision, type TraderAbilitySnapshot, type TraderAbilityWindow, type TraderLifecycle, type TraderOutcomeHorizon, type TraderTokenOutcome, type TraderTokenSample } from "@address-radar/domain";

import { evaluateTraderAbility, type TraderDiscoveryEvidence } from "./trader-ability-evaluator.js";

export interface TraderPerformanceEvaluation {
  readonly snapshot: TraderAbilitySnapshot;
  readonly lifecycle: LifecycleDecision;
}

export function evaluateTraderPerformance(input: {
  readonly entityId: string;
  readonly currentLifecycle: TraderLifecycle;
  readonly locked: boolean;
  readonly previousBelowThresholdCount?: number;
  readonly samples: readonly TraderTokenSample[];
  readonly outcomes: readonly TraderTokenOutcome[];
  readonly discoveries: readonly TraderDiscoveryEvidence[];
  readonly asOf: number;
  readonly window: TraderAbilityWindow;
  readonly preferredHorizon: TraderOutcomeHorizon;
  readonly strategyVersion: string;
}): TraderPerformanceEvaluation {
  const evaluation = evaluateTraderAbility(input);
  const styles = deriveStyles(evaluation.metrics);
  const snapshot: TraderAbilitySnapshot = Object.freeze({
    snapshotId: `${input.entityId}:${input.window}:${input.asOf}:${input.strategyVersion}`,
    entityId: input.entityId,
    window: input.window,
    asOf: input.asOf,
    strategyVersion: input.strategyVersion,
    rawQuality: evaluation.score.rawQuality,
    adjustedQuality: evaluation.score.adjustedQuality,
    sampleConfidence: evaluation.score.sampleConfidence,
    coverageConfidence: evaluation.score.coverageConfidence,
    metrics: Object.freeze({ ...evaluation.metrics }),
    components: evaluation.score.components,
    styles,
    createdAt: input.asOf,
  });
  const lifecycle = decideLifecycleWithReason({
    current: input.currentLifecycle,
    quality: snapshot.adjustedQuality,
    independentHighMultipleCases: evaluation.metrics.independentHighMultipleCases,
    sampleCount: evaluation.metrics.validSamples,
    recentValidity: evaluation.metrics.recentValidity,
    locked: input.locked,
    ...(input.previousBelowThresholdCount === undefined ? {} : { previousBelowThresholdCount: input.previousBelowThresholdCount }),
  });
  return Object.freeze({ snapshot, lifecycle });
}

function deriveStyles(metrics: ReturnType<typeof evaluateTraderAbility>["metrics"]): TraderAbilitySnapshot["styles"] {
  return Object.freeze({
    EARLY_LAUNCH: round(metrics.earlyEntryRate),
    HIGH_MULTIPLE: round(0.5 * metrics.hit5xRate + 0.5 * metrics.hit10xRate),
    LARGE_CAP: round(1 - metrics.earlyEntryRate),
    OLD_TOKEN_MOMENTUM: 0,
  } satisfies TraderAbilitySnapshot["styles"]);
}

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}
