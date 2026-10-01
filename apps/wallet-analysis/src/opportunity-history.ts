import { normalizeAddressRadarTokenAddress, type MarketObservation, type TraderEvent } from "@address-radar/domain";
import {
  evaluateTraderOpportunities, OPPORTUNITY_WINDOW_MS,
  type OpportunityPurchase, type TraderOpportunityEvaluation,
} from "@address-radar/scoring";

export interface OpportunityHistorySample {
  readonly sampleId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly firstBuyAt: number;
  readonly sampleStatus: string;
  readonly weightedEntryPriceUsd: number | null;
  readonly totalBuyUsd: number | null;
}

export interface OpportunityHistoryOutcome {
  readonly sampleId: string;
  readonly mfeMultiple: number | null;
  readonly observedAt: number | null;
  readonly computedAt: number;
  readonly source: string | null;
  readonly coverageStatus: string;
}

export function evaluateTraderOpportunityHistory(input: {
  readonly events: readonly TraderEvent[];
  readonly samples: readonly OpportunityHistorySample[];
  readonly outcomes: readonly OpportunityHistoryOutcome[];
  readonly asOf: number;
  readonly readObservations: (chain: string, tokenAddress: string, from: number, to: number) => readonly MarketObservation[];
}): TraderOpportunityEvaluation {
  const since = Math.max(0, input.asOf - 2 * OPPORTUNITY_WINDOW_MS);
  const events = input.events.filter(event => event.collectedAt <= input.asOf && event.occurredAt <= input.asOf);
  const purchases: OpportunityPurchase[] = [];
  const eventTokens = new Set<string>();
  const markets = new Map<string, readonly MarketObservation[]>();
  const observations = (chain: string, tokenAddress: string): readonly MarketObservation[] => {
    const key = tokenKey(chain, tokenAddress);
    const cached = markets.get(key);
    if (cached) return cached;
    const prices = [
      ...input.readObservations(chain.toLowerCase(), normalizeAddressRadarTokenAddress(chain, tokenAddress), since, input.asOf),
      ...events.filter(event => tokenKey(event.chain, event.tokenAddress) === key && event.priceUsd !== null)
        .map(event => ({ observedAt: event.occurredAt, priceUsd: event.priceUsd!, source: event.source, collectedAt: event.collectedAt })),
    ];
    markets.set(key, prices);
    return prices;
  };
  for (const event of events) {
    if (event.side !== "buy" || event.occurredAt < since) continue;
    eventTokens.add(tokenKey(event.chain, event.tokenAddress));
    purchases.push({
      purchaseId: event.eventId,
      chain: event.chain,
      tokenAddress: event.tokenAddress,
      boughtAt: event.occurredAt,
      buyUsd: event.amountUsd,
      entryPriceUsd: event.priceUsd,
      collectedAt: event.collectedAt,
      observations: observations(event.chain, event.tokenAddress),
    });
  }
  for (const sample of input.samples) {
    if (sample.sampleStatus !== "included" || sample.firstBuyAt < since
      || eventTokens.has(tokenKey(sample.chain, sample.tokenAddress))) continue;
    purchases.push({
      purchaseId: `sample:${sample.sampleId}`,
      chain: sample.chain,
      tokenAddress: sample.tokenAddress,
      boughtAt: sample.firstBuyAt,
      buyUsd: sample.totalBuyUsd,
      entryPriceUsd: sample.weightedEntryPriceUsd,
      observations: observations(sample.chain, sample.tokenAddress),
      peakEvidence: input.outcomes.filter(outcome => outcome.sampleId === sample.sampleId
        && outcome.coverageStatus === "complete" && outcome.mfeMultiple !== null && outcome.observedAt !== null
        && outcome.source !== null).map(outcome => ({
          from: sample.firstBuyAt,
          to: outcome.observedAt!,
          maximumMultiple: outcome.mfeMultiple!,
          source: outcome.source!,
          computedAt: outcome.computedAt,
        })),
    });
  }
  return evaluateTraderOpportunities({ purchases, asOf: input.asOf });
}

function tokenKey(chain: string, address: string): string {
  return `${chain.toLowerCase()}:${normalizeAddressRadarTokenAddress(chain, address)}`;
}
