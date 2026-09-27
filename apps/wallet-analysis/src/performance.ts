import type { AddressRadarRepository } from "@address-radar/database";
import type {
  RepeatableTraderAbilityEvaluation,
  RepeatableTraderAbilityStage,
  RepeatableTraderAbilityWindow,
  TraderEvent,
} from "@address-radar/domain";
import { strongestCandidateEvidenceByToken } from "@address-radar/identity";
import { buildTraderTokenSample, evaluateScheduledTraderOutcomes, evaluateTraderPerformance, scheduleTraderOutcomes } from "@address-radar/scoring";

export function createTraderPerformanceRuntime(input: {
  readonly repository: AddressRadarRepository;
  readonly strategyVersion: string;
  readonly dustThresholdUsd: number;
  readonly maximumObservationDelayMs: number;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  return Object.freeze({
    async runOnce() {
      const asOf = now();
      let samplesCreated = 0;
      for (const entityId of input.repository.traderEntityIdsWithEvents()) {
        const entity = input.repository.traderEntity(entityId);
        if (!entity) continue;
        for (const events of groupEvents(input.repository.eventsForEntity(entityId)).values()) {
          for (const event of events) if (event.priceUsd !== null && event.priceUsd > 0) input.repository.saveMarketObservation(event.chain, event.tokenAddress, { observedAt: event.occurredAt, priceUsd: event.priceUsd, source: event.source });
          const launchCandidates = events.flatMap(event => event.tokenAgeMs === null ? [] : [Math.max(0, event.occurredAt - event.tokenAgeMs)]);
          const sample = buildTraderTokenSample({ events, launchAt: launchCandidates.length ? Math.min(...launchCandidates) : null, now: asOf, dustThresholdUsd: input.dustThresholdUsd });
          input.repository.upsertTraderTokenSample(sample);
          if (input.repository.traderTokenOutcomes(sample.sampleId).length === 0) for (const outcome of scheduleTraderOutcomes(sample, asOf)) input.repository.saveTraderTokenOutcome(outcome);
          const observations = input.repository.marketObservations(sample.chain, sample.tokenAddress, sample.firstBuyAt, asOf);
          const capturedMultiple = sample.totalBuyUsd > 0 ? (sample.totalSellUsd + sample.remainingCostUsd) / sample.totalBuyUsd : null;
          for (const outcome of evaluateScheduledTraderOutcomes({ sample, observations, computedAt: asOf, maximumObservationDelayMs: input.maximumObservationDelayMs, capturedMultiple })) input.repository.saveTraderTokenOutcome(outcome);
          samplesCreated += 1;
        }
        const samples = input.repository.traderTokenSamples(entityId);
        const discoveries = strongestCandidateEvidenceByToken(input.repository.candidateDiscoveriesForEntity(entityId)).map(item => {
          const payload = parsePayload(item.discovery.payload);
          return { chain: payload.chain ?? "unknown", tokenAddress: payload.tokenAddress ?? item.discovery.discoveryId, discoveryType: item.discovery.discoveryType, discoveredAt: item.discovery.discoveredAt };
        });
        const evaluation = evaluateTraderPerformance({ entityId, currentLifecycle: entity.lifecycle, locked: entity.locked, samples, outcomes: samples.flatMap(sample => input.repository.traderTokenOutcomes(sample.sampleId)), discoveries, asOf, window: "30d", preferredHorizon: "24h", strategyVersion: input.strategyVersion });
        if (input.repository.latestTraderAbility(entityId, "30d")?.snapshotId !== evaluation.snapshot.snapshotId) {
          input.repository.saveTraderAbilitySnapshot(evaluation.snapshot);
        }
        if (evaluation.lifecycle.changed) {
          input.repository.recordLifecycleEvent({ lifecycleEventId: `${entityId}:${asOf}:${evaluation.lifecycle.next}`, entityId, previousState: entity.lifecycle, nextState: evaluation.lifecycle.next, reasons: evaluation.lifecycle.reasons, strategyVersion: input.strategyVersion, occurredAt: asOf });
          input.repository.updateTraderLifecycle(entityId, evaluation.lifecycle.next, asOf);
        }
      }
      return Object.freeze({ entities: input.repository.traderEntityIdsWithEvents().length, samples: samplesCreated });
    },
  });
}

function groupEvents(events: readonly TraderEvent[]): Map<string, TraderEvent[]> {
  const groups = new Map<string, TraderEvent[]>();
  for (const event of events) {
    const key = `${event.chain.toLowerCase()}:${event.tokenAddress.toLowerCase()}`;
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
}): RepeatableTraderAbilityEvaluation {
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
    return [`${sample.chain.toLowerCase()}:${sample.tokenAddress.toLowerCase()}`];
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

function abilityWindowMs(window: RepeatableTraderAbilityWindow): number {
  if (window === "24h") return 24 * 60 * 60_000;
  return Number.parseInt(window, 10) * 24 * 60 * 60_000;
}
