export const OUTCOME_HORIZONS = ["1h", "6h", "24h", "3d", "7d"] as const;
export type OutcomeHorizon = typeof OUTCOME_HORIZONS[number];

const horizonMs: Readonly<Record<OutcomeHorizon, number>> = Object.freeze({
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
});

export interface OutcomeBroadcast {
  readonly broadcastId: string;
  readonly triggeredAt: number;
  readonly priceUsd: number;
  readonly marketCapUsd: number;
}

export interface OutcomePricePoint {
  readonly observedAt: number;
  readonly priceUsd: number;
  readonly marketCapUsd: number;
}

export interface OutcomeObservation {
  readonly broadcastId: string;
  readonly horizon: OutcomeHorizon;
  readonly entryPriceUsd: number;
  readonly entryMarketCapUsd: number;
  readonly priceAtHorizonUsd: number;
  readonly maxReturn: number;
  readonly maxDrawdown: number;
  readonly timeTo2xMs: number | null;
  readonly timeTo5xMs: number | null;
  readonly timeTo10xMs: number | null;
  readonly peakMarketCapUsd: number;
  readonly observedThrough: number;
  readonly freshnessMs: number;
  readonly complete: boolean;
}

const firstThresholdTime = (
  points: readonly OutcomePricePoint[],
  entryPrice: number,
  multiple: number,
  triggeredAt: number,
): number | null => {
  const point = points.find(item => item.priceUsd >= entryPrice * multiple);
  return point ? point.observedAt - triggeredAt : null;
};

export const evaluateBroadcast = (
  broadcast: OutcomeBroadcast,
  priceSeries: readonly OutcomePricePoint[],
): readonly OutcomeObservation[] => {
  if (!(broadcast.priceUsd > 0) || !(broadcast.marketCapUsd >= 0)) throw new Error("Broadcast entry values must be valid");
  const ordered = [...priceSeries]
    .filter(point => point.observedAt >= broadcast.triggeredAt && point.priceUsd > 0 && point.marketCapUsd >= 0)
    .sort((left, right) => left.observedAt - right.observedAt);
  const latestObservedAt = ordered.at(-1)?.observedAt ?? broadcast.triggeredAt;

  return Object.freeze(OUTCOME_HORIZONS.map(horizon => {
    const deadline = broadcast.triggeredAt + horizonMs[horizon];
    const eligible = ordered.filter(point => point.observedAt <= deadline);
    const last = eligible.at(-1);
    const returns = eligible.map(point => point.priceUsd / broadcast.priceUsd - 1);
    return Object.freeze({
      broadcastId: broadcast.broadcastId,
      horizon,
      entryPriceUsd: broadcast.priceUsd,
      entryMarketCapUsd: broadcast.marketCapUsd,
      priceAtHorizonUsd: last?.priceUsd ?? broadcast.priceUsd,
      maxReturn: returns.length > 0 ? Math.max(0, ...returns) : 0,
      maxDrawdown: returns.length > 0 ? Math.min(0, ...returns) : 0,
      timeTo2xMs: firstThresholdTime(eligible, broadcast.priceUsd, 2, broadcast.triggeredAt),
      timeTo5xMs: firstThresholdTime(eligible, broadcast.priceUsd, 5, broadcast.triggeredAt),
      timeTo10xMs: firstThresholdTime(eligible, broadcast.priceUsd, 10, broadcast.triggeredAt),
      peakMarketCapUsd: eligible.length > 0 ? Math.max(broadcast.marketCapUsd, ...eligible.map(point => point.marketCapUsd)) : broadcast.marketCapUsd,
      observedThrough: Math.min(latestObservedAt, deadline),
      freshnessMs: Math.max(0, deadline - latestObservedAt),
      complete: latestObservedAt >= deadline,
    });
  }));
};
