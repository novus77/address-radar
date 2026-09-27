import { describe, expect, it } from "vitest";

import type { GeckoTerminalClient } from "@address-radar/collectors";
import { createGeckoEarlyTradeProvider } from "../src/gecko-early-trade-provider.js";

describe("GeckoEarlyTradeProvider", () => {
  it("creates priced wallet evidence for a recent complete trade window", async () => {
    const client: GeckoTerminalClient = {
      topPool: async () => ({ network: "base", poolAddress: "pool", tokenAddress: "0xtoken", tokenSide: "base", tokenPriceUsd: 1, reserveUsd: 10_000, marketCapUsd: 1_000_000, fdvUsd: null, createdAt: null }),
      ohlcv: async () => [],
      trades: async () => [{ transactionHash: "0xtx", traderAddress: "0xwallet", side: "buy", tokenPriceUsd: 0.2, volumeUsd: 150, occurredAt: 9_500 }],
    };
    const provider = createGeckoEarlyTradeProvider({ client, now: () => 10_000, publicHistoryWindowMs: 2_000 });

    await expect(provider.recover({ chain: "base", tokenAddress: "0xtoken", fromTimestamp: 9_000, toTimestamp: 10_000 })).resolves.toMatchObject({
      status: "available",
      trades: [{ traderAddress: "0xwallet", side: "buy", amountUsd: 150, marketCapUsd: 200_000 }],
    });
  });

  it("marks older requests partial instead of pretending complete coverage", async () => {
    const client: GeckoTerminalClient = {
      topPool: async () => ({ network: "base", poolAddress: "pool", tokenAddress: "0xtoken", tokenSide: "base", tokenPriceUsd: 1, reserveUsd: null, marketCapUsd: null, fdvUsd: 1_000_000, createdAt: null }),
      ohlcv: async () => [],
      trades: async () => [],
    };
    const provider = createGeckoEarlyTradeProvider({ client, now: () => 100_000, publicHistoryWindowMs: 10_000 });

    await expect(provider.recover({ chain: "base", tokenAddress: "0xtoken", fromTimestamp: 1_000, toTimestamp: 2_000 })).resolves.toMatchObject({ status: "partial", trades: [] });
  });
});

