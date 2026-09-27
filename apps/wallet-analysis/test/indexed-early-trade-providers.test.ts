import { describe, expect, it } from "vitest";

import type { GeckoTerminalClient } from "@address-radar/collectors";
import { createBlockscoutEarlyTradeProvider, createFallbackEarlyTradeProvider } from "../src/indexed-early-trade-providers.js";

const gecko: GeckoTerminalClient = {
  topPool: async () => ({ network: "base", poolAddress: "0xpool", tokenAddress: "0xtoken", tokenSide: "base", tokenPriceUsd: 1, reserveUsd: null, marketCapUsd: 1_000_000, fdvUsd: null, createdAt: null }),
  ohlcv: async () => [{ timestamp: 1_000, open: 0.1, high: 0.2, low: 0.1, close: 0.1, volumeUsd: 1 }],
  trades: async () => [],
};

describe("indexed early-trade providers", () => {
  it("accepts only transfers involving the confirmed pool", async () => {
    const provider = createBlockscoutEarlyTradeProvider({
      gecko,
      endpoints: { base: "https://base.example" },
      fetch: async () => new Response(JSON.stringify({ items: [
        { from: { hash: "0xpool" }, to: { hash: "0xbuyer" }, tx_hash: "0xtx", timestamp: "1970-01-01T00:00:02.000Z", total: { value: "1000000000000000000000", decimals: "18" } },
        { from: { hash: "0xother" }, to: { hash: "0xwallet" }, tx_hash: "0xtransfer", timestamp: "1970-01-01T00:00:02.000Z", total: { value: "1", decimals: "0" } },
      ], next_page_params: null })),
    });

    await expect(provider.recover({ chain: "base", tokenAddress: "0xtoken", fromTimestamp: 1_000, toTimestamp: 3_000 })).resolves.toMatchObject({
      status: "available",
      trades: [{ traderAddress: "0xbuyer", side: "buy", amountUsd: 100, marketCapUsd: 100_000 }],
    });
  });

  it("merges partial primary evidence with an indexed fallback", async () => {
    const trade = { eventId: "fallback", economicKey: "tx", chain: "base", tokenAddress: "0xtoken", traderAddress: "0xbuyer", side: "buy" as const, amountUsd: 100, marketCapUsd: 100_000, occurredAt: 2_000, source: "fallback" };
    const provider = createFallbackEarlyTradeProvider({
      primary: { recover: async () => ({ status: "partial", poolAddress: "pool", coverageStartAt: null, coverageEndAt: null, trades: [] }) },
      fallbackByChain: { base: { recover: async () => ({ status: "available", poolAddress: "pool", coverageStartAt: 1_000, coverageEndAt: 3_000, trades: [trade] }) } },
    });

    await expect(provider.recover({ chain: "base", tokenAddress: "0xtoken", fromTimestamp: 1_000, toTimestamp: 3_000 })).resolves.toMatchObject({ status: "available", trades: [trade] });
  });
});

