import { describe, expect, it } from "vitest";
import { createGeckoTerminalClient } from "../src/gecko-terminal-client.js";

describe("GeckoTerminalClient", () => {
  it("selects the deepest pool and resolves the requested token side", async () => {
    const client = createGeckoTerminalClient({ fetch: async () => new Response(JSON.stringify({ data: [
      { attributes: { address: "shallow", base_token_price_usd: "2", reserve_in_usd: "100", market_cap_usd: "200000" }, relationships: { base_token: { data: { id: "base_0xToken" } }, quote_token: { data: { id: "base_0xQuote" } } } },
      { attributes: { address: "deep", quote_token_price_usd: "4", reserve_in_usd: "500", fdv_usd: "400000" }, relationships: { base_token: { data: { id: "base_0xQuote" } }, quote_token: { data: { id: "base_0xToken" } } } },
    ] })) });
    await expect(client.topPool("base", "0xToken")).resolves.toMatchObject({ poolAddress: "deep", tokenSide: "quote", tokenPriceUsd: 4, reserveUsd: 500 });
  });

  it("parses OHLCV rows and bounds query parameters", async () => {
    let requestedUrl = "";
    const client = createGeckoTerminalClient({ fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[100, 1, 2, 0.5, 1.5, 99]] } } }));
    } });
    await expect(client.ohlcv("solana", "pool", { timeframe: "hour", tokenSide: "base", beforeTimestamp: 200_000, limit: 5000 }))
      .resolves.toEqual([{ timestamp: 100_000, open: 1, high: 2, low: 0.5, close: 1.5, volumeUsd: 99 }]);
    expect(requestedUrl).toContain("limit=1000");
    expect(requestedUrl).toContain("before_timestamp=200");
    expect(requestedUrl).toContain("token=base");
  });

  it("classifies rate limits as retryable", async () => {
    const client = createGeckoTerminalClient({ fetch: async () => new Response("", { status: 429 }) });
    await expect(client.topPool("eth", "0xToken")).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it("degrades unsupported chains without a request", async () => {
    let called = false;
    const client = createGeckoTerminalClient({ fetch: async () => { called = true; return new Response(); } });
    await expect(client.topPool("robinhood", "0xToken")).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it("normalizes pool trades relative to the requested token side", async () => {
    const client = createGeckoTerminalClient({ fetch: async () => new Response(JSON.stringify({ data: [{ attributes: {
      kind: "buy",
      tx_hash: "0xtx",
      tx_from_address: "0xwallet",
      volume_in_usd: "125",
      price_to_in_usd: "0.25",
      block_timestamp: "2026-09-27T10:00:00.000Z",
    } }] })) });

    await expect(client.trades("base", "pool", "base")).resolves.toEqual([{
      transactionHash: "0xtx",
      traderAddress: "0xwallet",
      side: "buy",
      tokenPriceUsd: 0.25,
      volumeUsd: 125,
      occurredAt: Date.parse("2026-09-27T10:00:00.000Z"),
    }]);
    await expect(client.trades("base", "pool", "quote")).resolves.toEqual([expect.objectContaining({ side: "sell" })]);
  });

  it("caches pool metadata to protect the public rate limit", async () => {
    let requests = 0;
    const client = createGeckoTerminalClient({
      minimumRequestIntervalMs: 0,
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({ data: [] }));
      },
    });

    await client.topPool("base", "0xtoken");
    await client.topPool("base", "0xtoken");
    expect(requests).toBe(1);
  });
});
