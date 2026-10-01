import type { AddressRadarRepository } from "@address-radar/database";
import type {
  RepeatableTraderAbilityEvaluation,
  RepeatableTraderAbilityStage,
  RepeatableTraderAbilityWindow,
  TraderAbilitySnapshot,
  TraderEvent,
} from "@address-radar/domain";
import { normalizeAddressRadarTokenAddress } from "@address-radar/domain";
import { strongestCandidateEvidenceByToken } from "@address-radar/identity";
import { buildTraderTokenSample, evaluateScheduledTraderOutcomes, evaluateTraderPerformance, scheduleTraderOutcomes, type TraderOpportunityEvaluation } from "@address-radar/scoring";

import { evaluateTraderOpportunityHistory } from "./opportunity-history.js";

export function createTraderPerformanceRuntime(input: {
  readonly repository: AddressRadarRepository;
  readonly strategyVersion: string;
  readonly dustThresholdUsd: number;
  readonly maximumObservationDelayMs: number;
  readonly batchSize?: number;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const batchSize = input.batchSize ?? 10;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("batchSize must be a positive safe integer");
  return Object.freeze({
    async runOnce() {
      const asOf = now();
      let samplesCreated = 0;
      const entityIds = input.repository.traderEntityIdsRequiringPerformance(asOf, batchSize);
      for (const entityId of entityIds) {
        const entity = input.repository.traderEntity(entityId);
        if (!entity) continue;
        const availableEvents = input.repository.eventsForEntity(entityId).filter(event => event.collectedAt <= asOf);
        for (const events of groupEvents(availableEvents).values()) {
          for (const event of events) if (event.priceUsd !== null && event.priceUsd > 0) input.repository.saveMarketObservation(event.chain, event.tokenAddress, { observedAt: event.occurredAt, priceUsd: event.priceUsd, source: event.source });
          const launchCandidates = events.flatMap(event => event.tokenAgeMs === null ? [] : [Math.max(0, event.occurredAt - event.tokenAgeMs)]);
          const sample = buildTraderTokenSample({ events, launchAt: launchCandidates.length ? Math.min(...launchCandidates) : null, now: asOf, dustThresholdUsd: input.dustThresholdUsd });
          input.repository.upsertTraderTokenSample(sample);
          const persistedSample = input.repository.traderTokenSample(sample.entityId, sample.chain, sample.tokenAddress);
          if (!persistedSample) throw new Error(`Trader token sample was not persisted: ${sample.entityId}:${sample.chain}:${sample.tokenAddress}`);
          if (input.repository.traderTokenOutcomes(persistedSample.sampleId).length === 0) for (const outcome of scheduleTraderOutcomes(persistedSample, asOf)) input.repository.saveTraderTokenOutcome(outcome);
          const observations = input.repository.marketObservations(persistedSample.chain, persistedSample.tokenAddress, persistedSample.firstBuyAt, asOf);
          const capturedMultiple = persistedSample.totalBuyUsd > 0 ? (persistedSample.totalSellUsd + persistedSample.remainingCostUsd) / persistedSample.totalBuyUsd : null;
          for (const outcome of evaluateScheduledTraderOutcomes({ sample: persistedSample, observations, computedAt: asOf, maximumObservationDelayMs: input.maximumObservationDelayMs, capturedMultiple })) input.repository.saveTraderTokenOutcome(outcome);
          samplesCreated += 1;
        }
        const samples = input.repository.traderTokenSamples(entityId);
        const discoveries = strongestCandidateEvidenceByToken(input.repository.candidateDiscoveriesForEntity(entityId)).map(item => {
          const payload = parsePayload(item.discovery.payload);
          return { chain: payload.chain ?? "unknown", tokenAddress: payload.tokenAddress ?? item.discovery.discoveryId, discoveryType: item.discovery.discoveryType, discoveredAt: item.discovery.discoveredAt };
        });
        const outcomes = samples.flatMap(sample => input.repository.traderTokenOutcomes(sample.sampleId));
        const opportunities = evaluateTraderOpportunityHistory({
          events: availableEvents, samples, outcomes, asOf,
          readObservations: (chain, address, from, to) => input.repository.marketObservations(chain, address, from, to),
        });
        const evaluation = evaluateTraderPerformance({ entityId, currentLifecycle: entity.lifecycle, locked: entity.locked, samples, outcomes, discoveries, opportunities, asOf, window: "30d", preferredHorizon: "24h", strategyVersion: input.strategyVersion });
        const previousAbility = input.repository.latestTraderAbility(entityId, "30d");
        if (!previousAbility || !sameAbilitySnapshot(previousAbility, evaluation.snapshot)) {
          input.repository.saveTraderAbilitySnapshot(evaluation.snapshot);
        }
        if (evaluation.lifecycle.changed) {
          input.repository.recordLifecycleEvent({ lifecycleEventId: `${entityId}:${asOf}:${evaluation.lifecycle.next}`, entityId, previousState: entity.lifecycle, nextState: evaluation.lifecycle.next, reasons: evaluation.lifecycle.reasons, strategyVersion: input.strategyVersion, occurredAt: asOf });
          input.repository.updateTraderLifecycle(entityId, evaluation.lifecycle.next, asOf);
        }
      }
      return Object.freeze({ entities: entityIds.length, samples: samplesCreated });
    },
  });
}

function sameAbilitySnapshot(left: TraderAbilitySnapshot, right: TraderAbilitySnapshot): boolean {
  return left.strategyVersion === right.strategyVersion
    && left.rawQuality === right.rawQuality
    && left.adjustedQuality === right.adjustedQuality
    && left.sampleConfidence === right.sampleConfidence
    && left.coverageConfidence === right.coverageConfidence
    && JSON.stringify(left.metrics) === JSON.stringify(right.metrics)
    && JSON.stringify(left.components) === JSON.stringify(right.components)
    && JSON.stringify(left.styles) === JSON.stringify(right.styles);
}

function groupEvents(events: readonly TraderEvent[]): Map<string, TraderEvent[]> {
  const groups = new Map<string, TraderEvent[]>();
  for (const event of events) {
    const key = `${event.chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(event.chain, event.tokenAddress)}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return groups;
}

function parsePayload(payload: string): { readonly chain?: string; readonly tokenAddress?: string } {
  try { return JSON.parse(payload) as { readonly chain?: string; readonly tokenAddress?: string }; } catch { return {}; }
}

export interface RepeatableAbilitySample {
  readonly sampleId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly firstBuyAt: number;
  readonly sampleStatus: string;
}

export interface RepeatableAbilityOutcome {
  readonly sampleId: string;
  readonly closeMultiple: number | null;
  readonly coverageStatus: string;
  readonly computedAt: number;
}

export function evaluateRepeatableTraderAbility(input: {
  readonly samples: readonly RepeatableAbilitySample[];
  readonly outcomes: readonly RepeatableAbilityOutcome[];
  readonly asOf: number;
  readonly window: RepeatableTraderAbilityWindow;
  readonly previousStage?: RepeatableTraderAbilityStage | null;
  readonly opportunities?: TraderOpportunityEvaluation;
}): RepeatableTraderAbilityEvaluation {
  if (input.opportunities) return evaluateOpportunityRecurrence(input);
  const since = input.asOf - abilityWindowMs(input.window);
  const samples = input.samples.filter(sample => sample.sampleStatus === "included"
    && sample.firstBuyAt >= since
    && sample.firstBuyAt <= input.asOf);
  const sampleById = new Map(samples.map(sample => [sample.sampleId, sample]));
  const latestBySample = new Map<string, RepeatableAbilityOutcome>();
  for (const outcome of input.outcomes) {
    if (!sampleById.has(outcome.sampleId)
      || outcome.coverageStatus !== "complete"
      || outcome.closeMultiple === null
      || outcome.computedAt > input.asOf) continue;
    const current = latestBySample.get(outcome.sampleId);
    if (!current || outcome.computedAt >= current.computedAt) latestBySample.set(outcome.sampleId, outcome);
  }
  const valid = [...latestBySample.values()];
  const successfulTokens = new Set(valid.flatMap(outcome => {
    if ((outcome.closeMultiple ?? 0) <= 1) return [];
    const sample = sampleById.get(outcome.sampleId)!;
    return [`${sample.chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(sample.chain, sample.tokenAddress)}`];
  }));
  const validTimes = valid.map(outcome => sampleById.get(outcome.sampleId)!.firstBuyAt).sort((left, right) => left - right);
  const gains = valid.map(outcome => Math.max(0, (outcome.closeMultiple ?? 0) - 1));
  const totalGain = gains.reduce((sum, gain) => sum + gain, 0);
  const maximumSingleTokenProfitShare = totalGain <= 0 ? 1 : Math.max(...gains) / totalGain;
  const outcomeCoverageRate = samples.length === 0 ? 0 : valid.length / samples.length;
  const metrics = Object.freeze({
    totalSamples: samples.length,
    validSamples: valid.length,
    successfulDistinctTokens: successfulTokens.size,
    winRate: valid.length === 0 ? 0 : valid.filter(outcome => (outcome.closeMultiple ?? 0) > 1).length / valid.length,
    sampleSpanMs: validTimes.length < 2 ? 0 : validTimes.at(-1)! - validTimes[0]!,
    maximumSingleTokenProfitShare,
  });
  const stable = metrics.validSamples >= 8
    && outcomeCoverageRate >= 0.7
    && metrics.successfulDistinctTokens >= 3
    && metrics.sampleSpanMs >= 14 * 24 * 60 * 60_000
    && metrics.maximumSingleTokenProfitShare <= 0.5;
  const hadStableAbility = input.previousStage === "stable" || input.previousStage === "degraded";
  const stage: RepeatableTraderAbilityStage = stable
    ? "stable"
    : hadStableAbility
      ? "degraded"
      : metrics.validSamples === 0
        ? "discovered"
        : "candidate";
  const reasonCodes = stable
    ? ["repeatable_ability_confirmed"]
    : [
      ...(metrics.validSamples < 8 ? ["valid_samples_below_8"] : []),
      ...(outcomeCoverageRate < 0.7 ? ["outcome_coverage_below_70pct"] : []),
      ...(metrics.successfulDistinctTokens < 3 ? ["successful_tokens_below_3"] : []),
      ...(metrics.sampleSpanMs < 14 * 24 * 60 * 60_000 ? ["sample_span_below_14d"] : []),
      ...(metrics.maximumSingleTokenProfitShare > 0.5 ? ["single_token_profit_concentration"] : []),
    ];
  return Object.freeze({
    window: input.window,
    stage,
    stable,
    metrics,
    reasonCodes: Object.freeze(reasonCodes),
  });
}

function evaluateOpportunityRecurrence(input: {
  readonly asOf: number;
  readonly window: RepeatableTraderAbilityWindow;
  readonly previousStage?: RepeatableTraderAbilityStage | null;
  readonly opportunities?: TraderOpportunityEvaluation;
}): RepeatableTraderAbilityEvaluation {
  const opportunities = input.opportunities!;
  if (input.window !== "30d" || opportunities.asOf !== input.asOf) throw new Error("Opportunity recurrence requires a matching 30-day evaluation");
  const current = opportunities.purchases.filter(purchase => purchase.inCurrentWindow && purchase.status !== "excluded");
  const peaks = new Map<string, number>();
  for (const purchase of current) {
    if (purchase.maximumMultiple !== null) peaks.set(purchase.tokenKey, Math.max(peaks.get(purchase.tokenKey) ?? 0, purchase.maximumMultiple));
  }
  const gains = [...peaks.values()].map(value => Math.max(0, value - 1));
  const totalGain = gains.reduce((sum, gain) => sum + gain, 0);
  const times = current.filter(purchase => purchase.maximumMultiple !== null).map(purchase => purchase.boughtAt);
  const m = opportunities.metrics;
  const stable = opportunities.labels.length > 0;
  const decidedTokens = m.hit3xTokens + m.missedTokens;
  const reasonCodes = [
    ...opportunities.labels,
    ...(m.awaitingDataTokens > 0 ? ["opportunity_data_missing"] : []),
    ...(m.observingTokens > 0 ? ["opportunity_period_open"] : []),
    ...(!stable ? [input.previousStage === "stable" ? "awaiting_recent_recurrence" : "opportunity_recurrence_not_yet_confirmed"] : []),
  ];
  return Object.freeze({
    window: "30d",
    stage: stable ? "stable" : m.currentTokens === 0 ? "discovered" : "candidate",
    stable,
    metrics: Object.freeze({
      totalSamples: m.currentTokens,
      validSamples: m.measuredTokens,
      successfulDistinctTokens: m.hit3xTokens,
      winRate: decidedTokens === 0 ? 0 : m.hit3xTokens / decidedTokens,
      sampleSpanMs: times.length < 2 ? 0 : Math.max(...times) - Math.min(...times),
      maximumSingleTokenProfitShare: totalGain <= 0 ? 1 : Math.max(...gains) / totalGain,
    }),
    reasonCodes: Object.freeze(reasonCodes),
  });
}

function abilityWindowMs(window: RepeatableTraderAbilityWindow): number {
  if (window === "24h") return 24 * 60 * 60_000;
  return Number.parseInt(window, 10) * 24 * 60 * 60_000;
}
