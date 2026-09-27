import type { DiscoveryChain, GeckoTerminalClient, GeckoTerminalOhlcvCandle, GeckoTerminalPool } from "@address-radar/collectors";

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
  poolAddresses?: readonly string[];
}

export interface GeckoMilestoneProviderOptions {
  client: GeckoTerminalClient;
  thresholdsUsd?: readonly number[];
  maxPages?: number;
  pageSize?: number;
  maxPools?: number;
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
  const maxPools = options.maxPools ?? 3;

  return {
    async reconstruct(input) {
      const top = await options.client.topPool(input.chain, input.tokenAddress, input.signal);
      const discovered = options.client.pools ? await options.client.pools(input.chain, input.tokenAddress, input.signal) : top ? [top] : [];
      const pools = [...new Map(discovered.map((pool) => [pool.poolAddress, pool])).values()].slice(0, maxPools);
      if (pools.length === 0) return { status: "not_found", poolAddress: null, supplyEstimate: null, supplyBasis: null, milestones: [], candleCount: 0, poolAddresses: [] };

      let primary: { pool: GeckoTerminalPool; supply: number; basis: "market_cap" | "fdv" } | null = null;
      let candleCount = 0;
      const crossings = new Map<number, ReconstructedMilestone>();
      const coveredPools: string[] = [];
      for (const pool of pools) {
        const currentValue = pool.marketCapUsd ?? pool.fdvUsd;
        const basis = pool.marketCapUsd !== null ? "market_cap" : pool.fdvUsd !== null ? "fdv" : null;
        const supply = currentValue !== null && pool.tokenPriceUsd > 0 ? currentValue / pool.tokenPriceUsd : null;
        if (supply === null || basis === null || !Number.isFinite(supply) || supply <= 0) continue;
        primary ??= { pool, supply, basis };
        const candles: GeckoTerminalOhlcvCandle[] = [];
        let beforeTimestamp = Math.floor(input.toTimestamp);
        for (let page = 0; page < maxPages; page += 1) {
          const batch = await options.client.ohlcv(input.chain, pool.poolAddress, { timeframe: "hour", tokenSide: pool.tokenSide, aggregate: 1, beforeTimestamp, limit: pageSize }, input.signal);
          if (batch.length === 0) break;
          candles.push(...batch.filter((candle) => candle.timestamp >= input.fromTimestamp && candle.timestamp <= input.toTimestamp));
          const oldest = Math.min(...batch.map((candle) => candle.timestamp));
          if (oldest <= input.fromTimestamp || batch.length < pageSize) break;
          beforeTimestamp = oldest - 1;
        }
        const chronological = uniqueChronological(candles);
        if (chronological.length === 0) continue;
        coveredPools.push(pool.poolAddress);
        candleCount += chronological.length;
        for (const thresholdUsd of thresholds) {
          const candle = chronological.find((item) => item.high * supply >= thresholdUsd);
          if (!candle) continue;
          const crossing: ReconstructedMilestone = { thresholdUsd, crossedAt: candle.timestamp, estimatedMarketCapUsd: candle.high * supply, source: "gecko_terminal_ohlcv", precision: "estimated_market_cap" };
          const existing = crossings.get(thresholdUsd);
          if (!existing || crossing.crossedAt < existing.crossedAt) crossings.set(thresholdUsd, crossing);
        }
      }
      const selectedPrimary = primary as { pool: GeckoTerminalPool; supply: number; basis: "market_cap" | "fdv" } | null;
      if (!selectedPrimary || candleCount === 0) return { status: "insufficient_market_data", poolAddress: selectedPrimary?.pool.poolAddress ?? pools[0]!.poolAddress, supplyEstimate: selectedPrimary?.supply ?? null, supplyBasis: selectedPrimary?.basis ?? null, milestones: [], candleCount: 0, poolAddresses: coveredPools };
      return { status: "available", poolAddress: selectedPrimary.pool.poolAddress, supplyEstimate: selectedPrimary.supply, supplyBasis: selectedPrimary.basis, milestones: [...crossings.values()].sort((left, right) => left.thresholdUsd - right.thresholdUsd), candleCount, poolAddresses: coveredPools };
    },
  };
}
