import { normalizeAddressRadarTokenAddress, type MarketObservation } from "@address-radar/domain";

export const OPPORTUNITY_STRATEGY_VERSION = "trader-opportunity-v1";
export const OPPORTUNITY_WINDOW_MS = 30 * 86_400_000;

export type OpportunityLabel = "repeated_discovery" | "repeated_high_multiple_discovery";
export type OpportunityStatus = "hit" | "observing" | "awaiting_data" | "missed" | "excluded";

export interface OpportunityCoverage {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  readonly verifiedAt: number;
}

export interface OpportunityPeakEvidence {
  readonly from: number;
  readonly to: number;
  readonly maximumMultiple: number;
  readonly source: string;
  readonly computedAt: number;
}

export interface OpportunityPurchase {
  readonly purchaseId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly boughtAt: number;
  readonly buyUsd: number | null;
  readonly entryPriceUsd: number | null;
  readonly collectedAt?: number;
  readonly observations: readonly (MarketObservation & { readonly collectedAt?: number })[];
  readonly coverage?: readonly OpportunityCoverage[];
  readonly peakEvidence?: readonly OpportunityPeakEvidence[];
}

export interface PurchaseOpportunity {
  readonly purchaseId: string;
  readonly tokenKey: string;
  readonly boughtAt: number;
  readonly observationEndAt: number;
  readonly observationOpen: boolean;
  readonly inCurrentWindow: boolean;
  readonly rangeCovered: boolean;
  readonly maximumMultiple: number | null;
  readonly maximumEvidence: OpportunityPeakEvidence | null;
  readonly status: OpportunityStatus;
  readonly reasonCode: string;
}

export interface TraderOpportunityMetrics {
  readonly currentTokens: number;
  readonly measuredTokens: number;
  readonly hit3xTokens: number;
  readonly hit5xTokens: number;
  readonly hit10xTokens: number;
  readonly observingTokens: number;
  readonly awaitingDataTokens: number;
  readonly missedTokens: number;
  readonly rangeCoverageRate: number;
}

export interface TraderOpportunityEvaluation {
  readonly strategyVersion: typeof OPPORTUNITY_STRATEGY_VERSION;
  readonly asOf: number;
  readonly purchases: readonly PurchaseOpportunity[];
  readonly labels: readonly OpportunityLabel[];
  readonly metrics: TraderOpportunityMetrics;
}

export function evaluateTraderOpportunities(input: {
  readonly purchases: readonly OpportunityPurchase[];
  readonly asOf: number;
}): TraderOpportunityEvaluation {
  if (!validTime(input.asOf)) throw new Error("asOf must be a non-negative safe integer");
  const unique = new Map<string, OpportunityPurchase>();
  for (const purchase of input.purchases) {
    const current = unique.get(purchase.purchaseId);
    if (current && (tokenKey(current) !== tokenKey(purchase)
      || current.boughtAt !== purchase.boughtAt
      || !Object.is(current.entryPriceUsd, purchase.entryPriceUsd)
      || !Object.is(current.buyUsd, purchase.buyUsd))) {
      throw new Error(`Conflicting opportunity purchase: ${purchase.purchaseId}`);
    }
    if (!current) unique.set(purchase.purchaseId, purchase);
    else unique.set(purchase.purchaseId, {
      ...current,
      collectedAt: Math.min(current.collectedAt ?? current.boughtAt, purchase.collectedAt ?? purchase.boughtAt),
      observations: [...current.observations, ...purchase.observations],
      coverage: [...(current.coverage ?? []), ...(purchase.coverage ?? [])],
      peakEvidence: [...(current.peakEvidence ?? []), ...(purchase.peakEvidence ?? [])],
    });
  }
  const purchases = [...unique.values()].map(purchase => evaluatePurchase(purchase, input.asOf));
  const groups = new Map<string, PurchaseOpportunity[]>();
  for (const purchase of purchases) {
    if (!purchase.inCurrentWindow || purchase.status === "excluded") continue;
    const group = groups.get(purchase.tokenKey) ?? [];
    group.push(purchase);
    groups.set(purchase.tokenKey, group);
  }
  const tokens = [...groups.values()];
  const hit = (threshold: number): number => tokens.filter(group => group.some(p => (p.maximumMultiple ?? 0) >= threshold)).length;
  const unresolved = tokens.filter(group => !group.some(p => p.status === "hit"));
  const hit3xTokens = hit(3);
  const hit5xTokens = hit(5);
  const metrics: TraderOpportunityMetrics = Object.freeze({
    currentTokens: tokens.length,
    measuredTokens: tokens.filter(group => group.some(p => p.maximumMultiple !== null)).length,
    hit3xTokens,
    hit5xTokens,
    hit10xTokens: hit(10),
    observingTokens: unresolved.filter(group => !group.some(p => p.status === "awaiting_data") && group.some(p => p.status === "observing")).length,
    awaitingDataTokens: unresolved.filter(group => group.some(p => p.status === "awaiting_data")).length,
    missedTokens: unresolved.filter(group => group.every(p => p.status === "missed")).length,
    rangeCoverageRate: tokens.length === 0 ? 0 : tokens.filter(group => group.every(p => p.rangeCovered)).length / tokens.length,
  });
  const labels: OpportunityLabel[] = [];
  if (hit3xTokens >= 3) labels.push("repeated_discovery");
  if (hit5xTokens >= 2) labels.push("repeated_high_multiple_discovery");
  return Object.freeze({
    strategyVersion: OPPORTUNITY_STRATEGY_VERSION,
    asOf: input.asOf,
    purchases: Object.freeze(purchases),
    labels: Object.freeze(labels),
    metrics,
  });
}

function evaluatePurchase(purchase: OpportunityPurchase, asOf: number): PurchaseOpportunity {
  let maximumEvidence: OpportunityPeakEvidence | null = null;
  const end = purchase.boughtAt + OPPORTUNITY_WINDOW_MS;
  const observedUntil = Math.min(end, asOf);
  const base = {
    purchaseId: purchase.purchaseId,
    tokenKey: tokenKey(purchase),
    boughtAt: purchase.boughtAt,
    observationEndAt: end,
    observationOpen: asOf < end,
    inCurrentWindow: purchase.boughtAt >= asOf - OPPORTUNITY_WINDOW_MS && purchase.boughtAt <= asOf,
  };
  const result = (status: OpportunityStatus, reasonCode: string, maximumMultiple: number | null = null, rangeCovered = false): PurchaseOpportunity =>
    Object.freeze({ ...base, status, reasonCode, maximumMultiple, maximumEvidence, rangeCovered });
  if (!purchase.purchaseId.trim() || !purchase.chain.trim() || !purchase.tokenAddress.trim()
    || !validTime(purchase.boughtAt) || !validTime(end) || purchase.boughtAt > asOf
    || !validTime(purchase.collectedAt ?? purchase.boughtAt) || (purchase.collectedAt ?? purchase.boughtAt) > asOf) {
    return result("excluded", "purchase_not_available");
  }
  if (purchase.buyUsd !== null && Number.isFinite(purchase.buyUsd) && purchase.buyUsd < 50) {
    return result("excluded", "purchase_below_50_usd");
  }
  if (purchase.buyUsd === null || !Number.isFinite(purchase.buyUsd)) return result("awaiting_data", "purchase_amount_missing");
  if (purchase.entryPriceUsd === null || !Number.isFinite(purchase.entryPriceUsd) || purchase.entryPriceUsd <= 0) {
    return result("awaiting_data", "entry_price_missing");
  }
  const evidenceCandidates: OpportunityPeakEvidence[] = purchase.observations.flatMap(observation => {
    if (!validTime(observation.observedAt) || observation.observedAt < purchase.boughtAt
      || observation.observedAt > observedUntil || !observation.source.trim()
      || !validTime(observation.collectedAt ?? observation.observedAt)
      || (observation.collectedAt ?? observation.observedAt) > asOf
      || !Number.isFinite(observation.priceUsd) || observation.priceUsd <= 0) return [];
    const multiple = observation.priceUsd / purchase.entryPriceUsd!;
    return Number.isFinite(multiple) ? [{
      from: purchase.boughtAt, to: observation.observedAt, maximumMultiple: multiple,
      source: observation.source, computedAt: observation.collectedAt ?? asOf,
    }] : [];
  });
  for (const evidence of purchase.peakEvidence ?? []) {
    if (validTime(evidence.from) && validTime(evidence.to) && validTime(evidence.computedAt)
      && evidence.from >= purchase.boughtAt && evidence.to >= evidence.from
      && evidence.to <= observedUntil && evidence.computedAt >= evidence.to
      && evidence.computedAt <= asOf && evidence.source.trim()
      && Number.isFinite(evidence.maximumMultiple) && evidence.maximumMultiple > 0) {
      evidenceCandidates.push(evidence);
    }
  }
  for (const evidence of evidenceCandidates) {
    if (!maximumEvidence || evidence.maximumMultiple > maximumEvidence.maximumMultiple) maximumEvidence = evidence;
  }
  const maximumMultiple = maximumEvidence?.maximumMultiple ?? null;
  const rangeCovered = coversRange(purchase.coverage ?? [], purchase.boughtAt, observedUntil, asOf);
  if ((maximumMultiple ?? 0) >= 3) return result("hit", "verified_opportunity", maximumMultiple, rangeCovered);
  if (maximumMultiple === null || !rangeCovered) return result("awaiting_data", "market_range_missing", maximumMultiple);
  return base.observationOpen
    ? result("observing", "observation_period_open", maximumMultiple, true)
    : result("missed", "complete_period_without_3x", maximumMultiple, true);
}

function coversRange(coverage: readonly OpportunityCoverage[], from: number, to: number, asOf: number): boolean {
  if (from === to) return false;
  const ranges = coverage.filter(range => validTime(range.from) && validTime(range.to)
    && range.to >= range.from && validTime(range.verifiedAt) && range.verifiedAt >= range.to
    && range.verifiedAt <= asOf && range.source.trim()).sort((left, right) => left.from - right.from);
  let coveredUntil = from;
  for (const range of ranges) {
    if (range.to < coveredUntil) continue;
    if (range.from > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, range.to);
    if (coveredUntil >= to) return true;
  }
  return false;
}

function tokenKey(purchase: Pick<OpportunityPurchase, "chain" | "tokenAddress">): string {
  const chain = purchase.chain.trim().toLowerCase();
  return `${chain}:${normalizeAddressRadarTokenAddress(chain, purchase.tokenAddress.trim())}`;
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
