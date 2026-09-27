export interface BundleTrade {
  readonly eventId: string;
  readonly traderId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly occurredAt: number;
}

export interface BundlePairEvidence {
  readonly pairKey: string;
  readonly tokenId: string;
  readonly chain: string;
  readonly leftTraderId: string;
  readonly rightTraderId: string;
  readonly deltaMs: number;
  readonly proximity: "within_5s" | "within_10s";
  readonly observedAt: number;
}

export interface TraderBundleRisk {
  readonly traderId: string;
  readonly state: "none" | "single_cluster" | "bundle_risk";
  readonly distinctTokenCount: number;
  readonly within5sTokenCount: number;
  readonly within10sTokenCount: number;
}

export interface BundleRiskResult {
  readonly pairs: readonly BundlePairEvidence[];
  readonly traders: ReadonlyMap<string, TraderBundleRisk>;
  readonly bundleRiskTraderIds: readonly string[];
}

export function detectRepeatedBundleRisk(trades: readonly BundleTrade[]): BundleRiskResult {
  const byToken = new Map<string, BundleTrade[]>();
  for (const trade of trades) {
    const tokenId = `${trade.chain.toLowerCase()}:${trade.tokenAddress.toLowerCase()}`;
    byToken.set(tokenId, [...(byToken.get(tokenId) ?? []), trade]);
  }
  const pairEvidence = new Map<string, BundlePairEvidence>();
  for (const [tokenId, tokenTrades] of byToken) {
    const sorted = [...tokenTrades].sort((left, right) => left.occurredAt - right.occurredAt || left.eventId.localeCompare(right.eventId));
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      const left = sorted[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const right = sorted[rightIndex]!;
        const deltaMs = right.occurredAt - left.occurredAt;
        if (deltaMs > 10_000) break;
        if (left.traderId === right.traderId) continue;
        const [leftTraderId, rightTraderId] = [left.traderId, right.traderId].sort();
        const pairKey = `${leftTraderId}:${rightTraderId}`;
        const key = `${pairKey}:${tokenId}`;
        const candidate: BundlePairEvidence = Object.freeze({
          pairKey,
          tokenId,
          chain: left.chain.toLowerCase(),
          leftTraderId: leftTraderId!,
          rightTraderId: rightTraderId!,
          deltaMs,
          proximity: deltaMs <= 5_000 ? "within_5s" : "within_10s",
          observedAt: Math.max(left.occurredAt, right.occurredAt),
        });
        const current = pairEvidence.get(key);
        if (!current || candidate.deltaMs < current.deltaMs) pairEvidence.set(key, candidate);
      }
    }
  }

  const pairTokens = new Map<string, BundlePairEvidence[]>();
  for (const pair of pairEvidence.values()) pairTokens.set(pair.pairKey, [...(pairTokens.get(pair.pairKey) ?? []), pair]);
  const traderTokens = new Map<string, Set<string>>();
  const traderWithin5s = new Map<string, Set<string>>();
  const traderWithin10s = new Map<string, Set<string>>();
  for (const pairs of pairTokens.values()) {
    for (const pair of pairs) {
      for (const traderId of [pair.leftTraderId, pair.rightTraderId]) {
        const tokens = traderTokens.get(traderId) ?? new Set<string>();
        tokens.add(pair.tokenId);
        traderTokens.set(traderId, tokens);
        const bucket = pair.proximity === "within_5s" ? traderWithin5s : traderWithin10s;
        const bucketTokens = bucket.get(traderId) ?? new Set<string>();
        bucketTokens.add(pair.tokenId);
        bucket.set(traderId, bucketTokens);
      }
    }
  }
  const traders = new Map<string, TraderBundleRisk>();
  for (const [traderId, tokens] of traderTokens) {
    traders.set(traderId, Object.freeze({
      traderId,
      state: tokens.size >= 2 ? "bundle_risk" : "single_cluster",
      distinctTokenCount: tokens.size,
      within5sTokenCount: traderWithin5s.get(traderId)?.size ?? 0,
      within10sTokenCount: traderWithin10s.get(traderId)?.size ?? 0,
    }));
  }
  return Object.freeze({
    pairs: Object.freeze([...pairEvidence.values()].sort((left, right) => left.pairKey.localeCompare(right.pairKey) || left.tokenId.localeCompare(right.tokenId))),
    traders,
    bundleRiskTraderIds: Object.freeze([...traders.values()].filter(value => value.state === "bundle_risk").map(value => value.traderId).sort()),
  });
}

