import { describe, expect, it, vi } from "vitest";
import { createGeckoTerminalClient } from "../src/gecko-terminal-client.js";
import { createGeckoMilestoneProvider } from "../src/gecko-milestone-provider.js";
import { createDexScreenerClient } from "../src/dex-screener-client.js";

describe("recovery source integrity", () => {
  it("does not promote FDV into circulating market cap", async () => {
    const client = createDexScreenerClient({ fetch: async () => new Response(JSON.stringify({ pairs: [{ chainId: "base", baseToken: { address: "0xtoken" }, priceUsd: "2", fdv: 200000 }] })) });
    await expect(client.lookup("base", "0xtoken")).resolves.toMatchObject({ priceUsd: 2, marketCapUsd: null, marketCapBasis: "unavailable" });
  });

  it("does not apply base-token prices to a requested quote token", async () => {
    const client = createDexScreenerClient({ fetch: async () => new Response(JSON.stringify({ pairs: [{ chainId: "base", baseToken: { address: "0xother" }, quoteToken: { address: "0xtoken" }, priceUsd: "2", marketCap: 200000 }] })) });
    await expect(client.lookup("base", "0xtoken")).resolves.toBeNull();
  });

  it("coordinates actual HTTP requests and publishes rate-limit cooldown", async () => {
    const beforeRequest = vi.fn(async () => {}), onRateLimit = vi.fn();
    const client = createGeckoTerminalClient({ minimumRequestIntervalMs: 0, beforeRequest, onRateLimit, fetch: async () => new Response("", { status: 429, headers: { "retry-after": "3" } }) });
    await expect(client.topPool("base", "0xtoken")).rejects.toMatchObject({ status: 429 });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(onRateLimit).toHaveBeenCalledWith(3000);
  });

  it("uses proven snapshot supply without disguising its provenance", async () => {
    const provider = createGeckoMilestoneProvider({
      client: { topPool: async () => ({ network: "base", tokenAddress: "0xtoken", poolAddress: "pool", tokenSide: "base", tokenPriceUsd: 2, reserveUsd: null, marketCapUsd: null, fdvUsd: 1e9, createdAt: null }), ohlcv: async () => [{ timestamp: 1000, open: 1, high: 3, low: 1, close: 2, volumeUsd: 10 }], trades: async () => [] },
      thresholdsUsd: [100000], resolveSupply: async () => ({ supply: 100000, source: "local_market_snapshot", snapshotId: "trusted", observedAt: 2000 }),
    });
    await expect(provider.reconstruct({ chain: "base", tokenAddress: "0xtoken", fromTimestamp: 0, toTimestamp: 3000 })).resolves.toMatchObject({ supplyEstimate: 100000, supplyBasis: "market_cap", milestones: [{ estimatedMarketCapUsd: 300000, supplyEvidence: { snapshotId: "trusted" } }] });
  });
});

 it("releases the local request queue when cancelled after shared permission", async () => {
  const controller = new AbortController();
  let grants = 0;
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
  const client = createGeckoTerminalClient({ minimumRequestIntervalMs: 0, fetch, beforeRequest: async () => { if (++grants === 1) controller.abort(); } });
  await expect(client.topPool("base", "0xfirst", controller.signal)).rejects.toThrow();
  await expect(client.topPool("base", "0xsecond")).resolves.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
 });
