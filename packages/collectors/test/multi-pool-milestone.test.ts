import { describe, expect, it } from "vitest";
import { createGeckoMilestoneProvider } from "../src/gecko-milestone-provider.js";

describe("shared multi-pool milestone reconstruction", () => {
  it("discovers a crossing in an older pool and exposes the estimate basis", async () => {
    const provider = createGeckoMilestoneProvider({ thresholdsUsd: [500_000], client: {
      topPool: async () => { throw new Error("pool discovery should be shared"); },
      pools: async () => ["new", "old"].map(poolAddress => ({ network: "base", poolAddress, tokenAddress: "token", tokenSide: "base" as const, tokenPriceUsd: 1, reserveUsd: 1_000, marketCapUsd: 100_000, fdvUsd: null, createdAt: null })),
      ohlcv: async (_chain, pool) => [{ timestamp: 3_600_000, open: 1, high: pool === "old" ? 6 : 1, low: 1, close: 1, volumeUsd: 100 }],
      trades: async () => [],
    } });
    const result = await provider.reconstruct({ chain: "base", tokenAddress: "token", fromTimestamp: 0, toTimestamp: 7_200_000 });
    expect(result.milestones).toEqual([expect.objectContaining({ thresholdUsd: 500_000, poolAddress: "old", supplyBasis: "market_cap", bucketEndAt: 7_200_000, precision: "estimated_market_cap" })]);
  });
});
