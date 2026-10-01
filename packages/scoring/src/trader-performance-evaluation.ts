import { decideLifecycleWithReason, type LifecycleDecision, type TraderAbilitySnapshot, type TraderAbilityWindow, type TraderLifecycle, type TraderOutcomeHorizon, type TraderTokenOutcome, type TraderTokenSample } from "@address-radar/domain";

import { evaluateTraderAbility, type TraderDiscoveryEvidence } from "./trader-ability-evaluator.js";
import { classifyTraderStyles } from "./style-classifier.js";
import type { TraderOpportunityEvaluation } from "./trader-opportunity-evaluator.js";

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
  readonly opportunities?: TraderOpportunityEvaluation;
}): TraderPerformanceEvaluation {
  if (input.opportunities && (input.opportunities.asOf !== input.asOf || input.window !== "30d")) {
    throw new Error("Opportunity snapshots require a matching 30-day evaluation");
  }
  const evaluation = evaluateTraderAbility(input);
  const strategyVersion = input.opportunities ? `${input.strategyVersion}:${input.opportunities.strategyVersion}` : input.strategyVersion;
  const since = input.window === "lifetime" ? 0 : input.asOf - Number.parseInt(input.window, 10) * 24 * 60 * 60_000;
  const styleSamples = input.samples.filter(sample => sample.firstBuyAt >= since && sample.firstBuyAt <= input.asOf);
  const styles = deriveStyles(evaluation.metrics, styleSamples);
  const snapshot: TraderAbilitySnapshot = Object.freeze({
    snapshotId: `${input.entityId}:${input.window}:${input.asOf}:${strategyVersion}`,
    entityId: input.entityId,
    window: input.window,
    asOf: input.asOf,
    strategyVersion,
    rawQuality: evaluation.score.rawQuality,
    adjustedQuality: evaluation.score.adjustedQuality,
    sampleConfidence: evaluation.score.sampleConfidence,
    coverageConfidence: evaluation.score.coverageConfidence,
    metrics: Object.freeze({
      ...evaluation.metrics,
      ...(input.opportunities ? {
        opportunityTokens: input.opportunities.metrics.currentTokens,
        opportunityMeasuredTokens: input.opportunities.metrics.measuredTokens,
        opportunityHit3xTokens: input.opportunities.metrics.hit3xTokens,
        opportunityHit5xTokens: input.opportunities.metrics.hit5xTokens,
        opportunityHit10xTokens: input.opportunities.metrics.hit10xTokens,
        opportunityObservingTokens: input.opportunities.metrics.observingTokens,
        opportunityAwaitingDataTokens: input.opportunities.metrics.awaitingDataTokens,
        opportunityMissedTokens: input.opportunities.metrics.missedTokens,
        opportunityRangeCoverageRate: input.opportunities.metrics.rangeCoverageRate,
        repeatedDiscovery: Number(input.opportunities.labels.includes("repeated_discovery")),
        repeatedHighMultipleDiscovery: Number(input.opportunities.labels.includes("repeated_high_multiple_discovery")),
      } : {}),
    }),
    components: evaluation.score.components,
    styles,
    createdAt: input.asOf,
  });
  // Opportunity labels must not inherit unapproved promotion weights or return-based demotion gates.
  const lifecycle = input.opportunities
    ? Object.freeze({ next: input.currentLifecycle, changed: false, reasons: Object.freeze(["opportunity_labels_evaluated"]) })
    : decideLifecycleWithReason({
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

function deriveStyles(metrics: ReturnType<typeof evaluateTraderAbility>["metrics"], samples: readonly TraderTokenSample[]): TraderAbilitySnapshot["styles"] {
  const included = samples.filter(sample => sample.sampleStatus === "included");
  const marketCaps = included.flatMap(sample => sample.weightedEntryMarketCapUsd === null ? [] : [sample.weightedEntryMarketCapUsd]);
  const tokenAges = included.flatMap(sample => sample.launchAt === null ? [] : [Math.max(0, sample.firstBuyAt - sample.launchAt)]);
  const holdings = included.map(sample => Math.max(0, sample.lastActivityAt - sample.firstBuyAt));
  const totalBuy = included.reduce((sum, sample) => sum + sample.totalBuyUsd, 0);
  return classifyTraderStyles({
    ...(marketCaps.length ? { medianEntryMarketCapUsd: median(marketCaps) } : {}),
    ...(tokenAges.length ? { medianTokenAgeMs: median(tokenAges) } : {}),
    ...(holdings.length ? { medianHoldingMs: median(holdings) } : {}),
    ...(totalBuy > 0 ? { relativePositionSize: Math.max(...included.map(sample => sample.totalBuyUsd)) / totalBuy } : {}),
    highMultipleRate: Math.max(metrics.hit5xRate, metrics.hit10xRate),
    oldTokenEntryRate: included.length === 0 ? 0 : included.filter(sample => sample.lifecycleStageAtEntry === "old_token").length / included.length,
  });
}

function median(values: readonly number[]): number { const ordered = [...values].sort((a, b) => a - b); const middle = Math.floor(ordered.length / 2); return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2; }

function round(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}
