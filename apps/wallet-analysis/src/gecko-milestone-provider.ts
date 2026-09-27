import type { DiscoveryChain, GeckoTerminalClient, GeckoTerminalOhlcvCandle } from "@address-radar/collectors";

export const DEFAULT_MARKET_CAP_THRESHOLDS_USD = [100_000, 200_000, 300_000, 500_000, 1_000_000] as const;

export interface ReconstructedMilestone {
  thresholdUsd: number;
  crossedAt: number;
  estimatedMarketCapUsd: number;
  source: "gecko_terminal_ohlcv";
  precision: "estimated_market_cap";
}

export interface MilestoneReconstructionResult {
  status: "available" | "not_found" | "insufficient_market_data";
  poolAddress: string | null;
  supplyEstimate: number | null;
  supplyBasis: "market_cap" | "fdv" | null;
  milestones: ReconstructedMilestone[];
  candleCount: number;
}

export interface GeckoMilestoneProviderOptions {
  client: GeckoTerminalClient;
  thresholdsUsd?: readonly number[];
  maxPages?: number;
  pageSize?: number;
}

export interface ReconstructMilestonesInput {
  chain: DiscoveryChain;
  tokenAddress: string;
  fromTimestamp: number;
  toTimestamp: number;
  signal?: AbortSignal;
}

export interface GeckoMilestoneProvider {
  reconstruct(input: ReconstructMilestonesInput): Promise<MilestoneReconstructionResult>;
}

function uniqueChronological(candles: GeckoTerminalOhlcvCandle[]): GeckoTerminalOhlcvCandle[] {
  return [...new Map(candles.map((candle) => [candle.timestamp, candle])).values()]
    .sort((left, right) => left.timestamp - right.timestamp);
}

export function createGeckoMilestoneProvider(options: GeckoMilestoneProviderOptions): GeckoMilestoneProvider {
  const thresholds = [...(options.thresholdsUsd ?? DEFAULT_MARKET_CAP_THRESHOLDS_USD)].sort((a, b) => a - b);
  const maxPages = options.maxPages ?? 4;
  const pageSize = options.pageSize ?? 1000;

  return {
    async reconstruct(input) {
      const pool = await options.client.topPool(input.chain, input.tokenAddress, input.signal);
      if (!pool) return { status: "not_found", poolAddress: null, supplyEstimate: null, supplyBasis: null, milestones: [], candleCount: 0 };

      const currentValue = pool.marketCapUsd ?? pool.fdvUsd;
      const supplyBasis = pool.marketCapUsd !== null ? "market_cap" : pool.fdvUsd !== null ? "fdv" : null;
      const supplyEstimate = currentValue !== null && pool.tokenPriceUsd > 0 ? currentValue / pool.tokenPriceUsd : null;
      if (supplyEstimate === null || !Number.isFinite(supplyEstimate) || supplyEstimate <= 0) {
        return { status: "insufficient_market_data", poolAddress: pool.poolAddress, supplyEstimate: null, supplyBasis, milestones: [], candleCount: 0 };
      }

      const candles: GeckoTerminalOhlcvCandle[] = [];
      let beforeTimestamp = Math.floor(input.toTimestamp);
      for (let page = 0; page < maxPages; page += 1) {
        const batch = await options.client.ohlcv(input.chain, pool.poolAddress, {
          timeframe: "hour",
          tokenSide: pool.tokenSide,
          aggregate: 1,
          beforeTimestamp,
          limit: pageSize,
        }, input.signal);
        if (batch.length === 0) break;
        candles.push(...batch.filter((candle) => candle.timestamp >= input.fromTimestamp && candle.timestamp <= input.toTimestamp));
        const oldest = Math.min(...batch.map((candle) => candle.timestamp));
        if (oldest <= input.fromTimestamp || batch.length < pageSize) break;
        beforeTimestamp = oldest - 1;
      }

      const chronological = uniqueChronological(candles);
      const milestones = thresholds.flatMap((thresholdUsd): ReconstructedMilestone[] => {
        const crossing = chronological.find((candle) => candle.high * supplyEstimate >= thresholdUsd);
        return crossing ? [{
          thresholdUsd,
          crossedAt: crossing.timestamp,
          estimatedMarketCapUsd: crossing.high * supplyEstimate,
          source: "gecko_terminal_ohlcv",
          precision: "estimated_market_cap",
        }] : [];
      });
      return { status: "available", poolAddress: pool.poolAddress, supplyEstimate, supplyBasis, milestones, candleCount: chronological.length };
    },
  };
}
