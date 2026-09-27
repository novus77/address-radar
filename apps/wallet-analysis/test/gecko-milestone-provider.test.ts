import { describe, expect, it } from "vitest";
import type { GeckoTerminalClient } from "@address-radar/collectors";
import { createGeckoMilestoneProvider } from "../src/gecko-milestone-provider.js";

describe("GeckoMilestoneProvider", () => {
  it("reconstructs first threshold crossings", async () => {
    const client: GeckoTerminalClient = {
      topPool: async () => ({ network: "base", poolAddress: "pool", tokenAddress: "0xToken", tokenSide: "base", tokenPriceUsd: 2, reserveUsd: 50_000, marketCapUsd: 200_000, fdvUsd: null, createdAt: null }),
      ohlcv: async () => [
        { timestamp: 200_000, open: 2, high: 6, low: 1, close: 5, volumeUsd: 1 },
        { timestamp: 100_000, open: 1, high: 3, low: 1, close: 2, volumeUsd: 1 },
      ],
    };
    const provider = createGeckoMilestoneProvider({ client, thresholdsUsd: [100_000, 300_000, 500_000] });
    await expect(provider.reconstruct({ chain: "base", tokenAddress: "0xToken", fromTimestamp: 0, toTimestamp: 300_000 })).resolves.toMatchObject({
      status: "available",
      supplyEstimate: 100_000,
      supplyBasis: "market_cap",
      candleCount: 2,
      milestones: [
        { thresholdUsd: 100_000, crossedAt: 100_000, estimatedMarketCapUsd: 300_000 },
        { thresholdUsd: 300_000, crossedAt: 100_000, estimatedMarketCapUsd: 300_000 },
        { thresholdUsd: 500_000, crossedAt: 200_000, estimatedMarketCapUsd: 600_000 },
      ],
    });
  });

  it("uses FDV for supply estimation while reporting missing price history", async () => {
    const client: GeckoTerminalClient = {
      topPool: async () => ({ network: "solana", poolAddress: "pool", tokenAddress: "token", tokenSide: "quote", tokenPriceUsd: 0.5, reserveUsd: null, marketCapUsd: null, fdvUsd: 500_000, createdAt: null }),
      ohlcv: async () => [],
    };
    const provider = createGeckoMilestoneProvider({ client });
    await expect(provider.reconstruct({ chain: "solana", tokenAddress: "token", fromTimestamp: 0, toTimestamp: 1 })).resolves.toMatchObject({ status: "insufficient_market_data", supplyEstimate: 1_000_000, supplyBasis: "fdv", milestones: [] });
  });

  it("returns not_found when no pool exists", async () => {
    const client: GeckoTerminalClient = { topPool: async () => null, ohlcv: async () => [] };
    const provider = createGeckoMilestoneProvider({ client });
    await expect(provider.reconstruct({ chain: "robinhood", tokenAddress: "0xToken", fromTimestamp: 0, toTimestamp: 1 })).resolves.toMatchObject({ status: "not_found", milestones: [] });
  });
});
