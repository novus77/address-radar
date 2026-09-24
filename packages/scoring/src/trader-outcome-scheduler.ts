import { TRADER_OUTCOME_HORIZONS, type MarketObservation, type TraderOutcomeHorizon, type TraderTokenOutcome, type TraderTokenSample } from "@address-radar/domain";

import { evaluateTraderTokenOutcome } from "./trader-outcome-evaluator.js";

const HORIZON_MS: Readonly<Record<TraderOutcomeHorizon, number>> = Object.freeze({
  "60s": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
});

export function scheduleTraderOutcomes(sample: TraderTokenSample, computedAt: number): readonly TraderTokenOutcome[] {
  return evaluateScheduledTraderOutcomes({
    sample,
    observations: [],
    computedAt,
    maximumObservationDelayMs: 0,
    capturedMultiple: null,
  });
}

export function evaluateScheduledTraderOutcomes(input: {
  readonly sample: TraderTokenSample;
  readonly observations: readonly MarketObservation[];
  readonly computedAt: number;
  readonly maximumObservationDelayMs: number;
  readonly capturedMultiple: number | null;
}): readonly TraderTokenOutcome[] {
  const { sample } = input;
  if (sample.sampleStatus !== "included" || sample.weightedEntryPriceUsd === null || sample.weightedEntryPriceUsd <= 0) return Object.freeze([]);

  return Object.freeze(TRADER_OUTCOME_HORIZONS.map(horizon => evaluateTraderTokenOutcome({
    sampleId: sample.sampleId,
    horizon,
    entryAt: sample.firstBuyAt,
    entryPriceUsd: sample.weightedEntryPriceUsd!,
    targetAt: sample.firstBuyAt + HORIZON_MS[horizon],
    maximumObservationDelayMs: input.maximumObservationDelayMs,
    observations: input.observations,
    capturedMultiple: input.capturedMultiple,
    computedAt: input.computedAt,
  })));
}
