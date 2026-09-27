import type { DiscoveryChain, GeckoTerminalClient } from "@address-radar/collectors";

import type { HistoricalTradeEvidenceRow } from "./historical-evidence.js";

export interface RecoverEarlyTradesInput {
  chain: DiscoveryChain;
  tokenAddress: string;
  fromTimestamp: number;
  toTimestamp: number;
  signal?: AbortSignal;
}

export interface EarlyTradeRecoveryResult {
  status: "available" | "partial" | "not_found";
  poolAddress: string | null;
  coverageStartAt: number | null;
  coverageEndAt: number | null;
  trades: readonly HistoricalTradeEvidenceRow[];
}

export interface EarlyTradeProvider {
  recover(input: RecoverEarlyTradesInput): Promise<EarlyTradeRecoveryResult>;
}

export interface GeckoEarlyTradeProviderOptions {
  client: GeckoTerminalClient;
  now?: () => number;
  publicHistoryWindowMs?: number;
  maximumResultSize?: number;
  maxPools?: number;
}

export function createGeckoEarlyTradeProvider(options: GeckoEarlyTradeProviderOptions): EarlyTradeProvider {
  const now = options.now ?? Date.now;
  const publicHistoryWindowMs = options.publicHistoryWindowMs ?? 24 * 60 * 60 * 1000;
  const maximumResultSize = options.maximumResultSize ?? 300;
  const maxPools = options.maxPools ?? 3;

  return Object.freeze({
    async recover(input: RecoverEarlyTradesInput) {
      const top = await options.client.topPool(input.chain, input.tokenAddress, input.signal);
      const discovered = options.client.pools ? await options.client.pools(input.chain, input.tokenAddress, input.signal) : top ? [top] : [];
      const pools = [...new Map(discovered.map((pool) => [pool.poolAddress, pool])).values()].slice(0, maxPools);
      if (pools.length === 0) return Object.freeze({ status: "not_found" as const, poolAddress: null, coverageStartAt: null, coverageEndAt: null, trades: [] });
      const collected: HistoricalTradeEvidenceRow[] = [];
      let rawCount = 0;
      for (const pool of pools) {
        const supplyValue = pool.marketCapUsd ?? pool.fdvUsd;
        const supply = supplyValue !== null && pool.tokenPriceUsd > 0 ? supplyValue / pool.tokenPriceUsd : null;
        if (supply === null || !Number.isFinite(supply) || supply <= 0) continue;
        const raw = await options.client.trades(input.chain, pool.poolAddress, pool.tokenSide, input.signal);
        rawCount += raw.length;
        collected.push(...raw.filter((trade) => trade.occurredAt >= input.fromTimestamp && trade.occurredAt <= input.toTimestamp).map((trade): HistoricalTradeEvidenceRow => Object.freeze({ eventId: `gecko:${input.chain}:${trade.transactionHash}:${input.tokenAddress}`, economicKey: `${trade.transactionHash}:${input.tokenAddress}`, chain: input.chain, tokenAddress: input.tokenAddress, traderAddress: trade.traderAddress, side: trade.side, amountUsd: trade.volumeUsd, marketCapUsd: trade.tokenPriceUsd * supply, occurredAt: trade.occurredAt, source: `gecko_terminal:${pool.poolAddress}` })));
      }
      const trades = [...new Map(collected.map((trade) => [trade.economicKey, trade])).values()].sort((left, right) => left.occurredAt - right.occurredAt);
      const chronological = trades;
      const coverageStartAt = chronological[0]?.occurredAt ?? null;
      const coverageEndAt = chronological.at(-1)?.occurredAt ?? null;
      const requestWithinPublicWindow = input.fromTimestamp >= now() - publicHistoryWindowMs;
      const uncapped = rawCount < maximumResultSize * pools.length;
      const coversRequestedStart = coverageStartAt !== null && coverageStartAt <= input.fromTimestamp;
      const status = requestWithinPublicWindow && (uncapped || coversRequestedStart) ? "available" : "partial";
      return Object.freeze({ status, poolAddress: pools[0]!.poolAddress, coverageStartAt, coverageEndAt, trades: Object.freeze(trades) });
    },
  });
}
