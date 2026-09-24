import { normalizeAddressRadarTokenAddress, type TraderEvent, type TraderSampleSourceState, type TraderTokenSample } from "@address-radar/domain";

export interface BuildTraderTokenSampleInput {
  readonly events: readonly TraderEvent[];
  readonly launchAt: number | null;
  readonly now: number;
  readonly dustThresholdUsd: number;
}

export function buildTraderTokenSample(input: BuildTraderTokenSampleInput): TraderTokenSample {
  const first = input.events[0];
  if (!first) throw new Error("At least one event is required");
  if (!input.events.every(event => event.entityId === first.entityId && event.chain === first.chain && event.tokenAddress === first.tokenAddress)) {
    throw new Error("Events must belong to the same entity and token");
  }

  const ordered = [...input.events].sort((left, right) => left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId));
  const buys = ordered.filter(event => event.side === "buy" && event.amountUsd !== null && event.amountUsd > 0);
  const sells = ordered.filter(event => event.side === "sell" && event.amountUsd !== null && event.amountUsd > 0);
  const totalBuyUsd = sumAmounts(buys);
  const totalSellUsd = sumAmounts(sells);
  const sampleStatus = buys.length === 0 ? "non_trade" : totalBuyUsd < input.dustThresholdUsd ? "dust" : "included";
  const firstBuyAt = buys[0]?.occurredAt ?? ordered[0]!.occurredAt;

  return Object.freeze({
    sampleId: traderTokenSampleId(first.entityId, first.chain, first.tokenAddress),
    entityId: first.entityId,
    chain: first.chain,
    tokenAddress: first.tokenAddress,
    firstBuyAt,
    lastActivityAt: ordered.at(-1)!.occurredAt,
    weightedEntryPriceUsd: weightedAverage(buys, event => event.priceUsd),
    weightedEntryMarketCapUsd: weightedAverage(buys, event => event.marketCapUsd),
    totalBuyUsd,
    totalSellUsd,
    realizedValueUsd: totalSellUsd,
    remainingCostUsd: Math.max(0, totalBuyUsd - totalSellUsd),
    launchAt: input.launchAt,
    lifecycleStageAtEntry: lifecycleStage(firstBuyAt, input.launchAt),
    sourceState: sourceState(ordered),
    sampleStatus,
    exclusionReason: sampleStatus === "dust" ? "below_dust_threshold" : sampleStatus === "non_trade" ? "no_valid_buy" : null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function traderTokenSampleId(entityId: string, chain: string, tokenAddress: string): string {
  return `${entityId}:${chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(chain, tokenAddress)}`;
}

function sumAmounts(events: readonly TraderEvent[]): number {
  return events.reduce((sum, event) => sum + (event.amountUsd ?? 0), 0);
}

function weightedAverage(events: readonly TraderEvent[], value: (event: TraderEvent) => number | null): number | null {
  const usable = events.filter(event => event.amountUsd !== null && event.amountUsd > 0 && value(event) !== null);
  if (usable.length === 0) return null;
  const weight = sumAmounts(usable);
  return usable.reduce((sum, event) => sum + value(event)! * event.amountUsd!, 0) / weight;
}

function sourceState(events: readonly TraderEvent[]): TraderSampleSourceState {
  const hasFomo = events.some(event => isFomoSource(event.source));
  const hasOnchain = events.some(event => event.source === "onchain_wallet");
  if (hasFomo && hasOnchain) return "FOMO_AND_ONCHAIN";
  if (hasFomo) return "FOMO_ONLY";
  if (hasOnchain) return "ONCHAIN_ONLY";
  return "UNKNOWN";
}

function isFomoSource(source: TraderEvent["source"]): boolean {
  switch (source) {
    case "fomo_stream":
    case "fomo_profile":
    case "fomo_leaderboard":
    case "fomo_token_history":
      return true;
    case "onchain_wallet":
      return false;
  }
}

function lifecycleStage(firstBuyAt: number, launchAt: number | null): string {
  if (launchAt === null) return "unknown";
  const ageMs = Math.max(0, firstBuyAt - launchAt);
  if (ageMs <= 6 * 60 * 60_000) return "new_launch";
  if (ageMs <= 7 * 24 * 60 * 60_000) return "established";
  return "old_token";
}
