import type { AddressRadarRepository } from "@address-radar/database";
import type { TraderEvent } from "@address-radar/domain";
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
