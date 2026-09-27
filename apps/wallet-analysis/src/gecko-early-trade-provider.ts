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
}

export function createGeckoEarlyTradeProvider(options: GeckoEarlyTradeProviderOptions): EarlyTradeProvider {
  const now = options.now ?? Date.now;
  const publicHistoryWindowMs = options.publicHistoryWindowMs ?? 24 * 60 * 60 * 1000;
  const maximumResultSize = options.maximumResultSize ?? 300;

  return Object.freeze({
    async recover(input: RecoverEarlyTradesInput) {
      const pool = await options.client.topPool(input.chain, input.tokenAddress, input.signal);
      if (!pool) return Object.freeze({ status: "not_found" as const, poolAddress: null, coverageStartAt: null, coverageEndAt: null, trades: [] });
      const supplyValue = pool.marketCapUsd ?? pool.fdvUsd;
      const supply = supplyValue !== null && pool.tokenPriceUsd > 0 ? supplyValue / pool.tokenPriceUsd : null;
      if (supply === null || !Number.isFinite(supply) || supply <= 0) {
        return Object.freeze({ status: "not_found" as const, poolAddress: pool.poolAddress, coverageStartAt: null, coverageEndAt: null, trades: [] });
      }
      const raw = await options.client.trades(input.chain, pool.poolAddress, pool.tokenSide, input.signal);
      const chronological = raw.slice().sort((left, right) => left.occurredAt - right.occurredAt);
      const coverageStartAt = chronological[0]?.occurredAt ?? null;
      const coverageEndAt = chronological.at(-1)?.occurredAt ?? null;
      const trades = chronological
        .filter((trade) => trade.occurredAt >= input.fromTimestamp && trade.occurredAt <= input.toTimestamp)
        .map((trade): HistoricalTradeEvidenceRow => Object.freeze({
          eventId: `gecko:${input.chain}:${trade.transactionHash}:${input.tokenAddress}`,
          economicKey: `${trade.transactionHash}:${input.tokenAddress}`,
          chain: input.chain,
          tokenAddress: input.tokenAddress,
          traderAddress: trade.traderAddress,
          side: trade.side,
          amountUsd: trade.volumeUsd,
          marketCapUsd: trade.tokenPriceUsd * supply,
          occurredAt: trade.occurredAt,
          source: `gecko_terminal:${pool.poolAddress}`,
        }));
      const requestWithinPublicWindow = input.fromTimestamp >= now() - publicHistoryWindowMs;
      const uncapped = raw.length < maximumResultSize;
      const coversRequestedStart = coverageStartAt !== null && coverageStartAt <= input.fromTimestamp;
      const status = requestWithinPublicWindow && (uncapped || coversRequestedStart) ? "available" : "partial";
      return Object.freeze({ status, poolAddress: pool.poolAddress, coverageStartAt, coverageEndAt, trades: Object.freeze(trades) });
    },
  });
}
