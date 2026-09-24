import { describe, expect, it, vi } from "vitest";

import {
  JsonRpcRateLimitError,
  DexScreenerProviderError,
  RADAR_DISCOVERY_CHAINS,
  createRadarChainDiscoveryConfiguration,
  createRadarRpcDiscoveryProvider,
  createDexScreenerClient,
  createJsonRpcClient,
} from "@address-radar/collectors";

describe("JSON-RPC client", () => {
  it("returns successful provider results", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x2a" });
    });
    const client = createJsonRpcClient({ endpoint: "https://rpc.example", fetch });

    await expect(client.request<string>("eth_blockNumber", [])).resolves.toBe("0x2a");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports rate limiting after bounded fallback attempts", async () => {
    const fetch = vi.fn(async () => new Response("limited", { status: 429 }));
    const client = createJsonRpcClient({
      endpoint: "https://primary.example",
      fallbackEndpoint: "https://fallback.example",
      fetch,
      timeoutMs: 100,
    });

    await expect(client.request("eth_blockNumber", [])).rejects.toBeInstanceOf(JsonRpcRateLimitError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed provider data", async () => {
    const client = createJsonRpcClient({
      endpoint: "https://rpc.example",
      fetch: async () => Response.json({ jsonrpc: "2.0", result: "0x2a" }),
    });

    await expect(client.request("eth_blockNumber", [])).rejects.toThrow("Malformed JSON-RPC response");
  });

  it("falls back on provider rate-limit errors", async () => {
    const urls: string[] = [];
    const client = createJsonRpcClient({
      endpoint: "https://primary.example",
      fallbackEndpoint: "https://fallback.example",
      fetch: async (input, init) => {
        urls.push(String(input));
        const { id } = JSON.parse(String(init?.body)) as { id: number };
        return String(input).includes("primary")
          ? Response.json({ jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } })
          : Response.json({ jsonrpc: "2.0", id, result: "0x2a" });
      },
    });

    await expect(client.request("eth_blockNumber", [])).resolves.toBe("0x2a");
    expect(urls).toEqual(["https://primary.example", "https://fallback.example"]);
  });

  it("does not retry non-retryable provider errors", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "invalid params" } });
    });
    const client = createJsonRpcClient({ endpoint: "https://primary.example", fallbackEndpoint: "https://fallback.example", fetch });

    await expect(client.request("bad_method", [])).rejects.toThrow("invalid params");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Dex Screener client", () => {
  it("degrades a missing market to null", async () => {
    const provider = createDexScreenerClient({
      fetch: async () => Response.json({ pairs: null }),
      now: () => 1_000,
    });

    await expect(provider.lookup("solana", "CaseSensitiveMint")).resolves.toBeNull();
  });

  it("returns null for a definitive not-found response", async () => {
    const provider = createDexScreenerClient({ fetch: async () => new Response(null, { status: 404 }) });
    await expect(provider.lookup("base", "0xabc")).resolves.toBeNull();
  });

  it("throws a typed retryable error for server failures", async () => {
    const provider = createDexScreenerClient({ fetch: async () => new Response("unavailable", { status: 503 }) });
    await expect(provider.lookup("base", "0xabc")).rejects.toMatchObject({ name: "DexScreenerProviderError", retryable: true, status: 503 });
    await expect(provider.lookup("base", "0xabc")).rejects.toBeInstanceOf(DexScreenerProviderError);
  });

  it("selects the deepest matching market and normalizes numeric fields", async () => {
    const provider = createDexScreenerClient({
      fetch: async () => Response.json({
        pairs: [
          { chainId: "base", baseToken: { address: "0xABC" }, priceUsd: "1", liquidity: { usd: 10 }, marketCap: 100 },
          { chainId: "base", baseToken: { address: "0xabc" }, priceUsd: "2.5", liquidity: { usd: 500 }, fdv: 250 },
        ],
      }),
      now: () => 1_000,
    });

    await expect(provider.lookup("base", "0xAbC")).resolves.toEqual({
      chain: "base",
      tokenAddress: "0xabc",
      priceUsd: 2.5,
      marketCapUsd: 250,
      liquidityUsd: 500,
      observedAt: "1970-01-01T00:00:01.000Z",
    });
  });

  it("treats pair creation as launch evidence only", async () => {
    const provider = createDexScreenerClient({
      fetch: async () => Response.json({ pairs: [{ chainId: "solana", baseToken: { address: "Mint" }, priceUsd: "1", liquidity: { usd: 1 }, pairCreatedAt: 500 }] }),
      now: () => 1_000,
    });
    const result = await provider.lookup("solana", "Mint");
    expect(result).toMatchObject({ launchedAt: 500 });
    expect(result).not.toHaveProperty("createdAt");
  });

  it.each([
    ["eth", "ethereum"],
    ["bnb", "bsc"],
    ["bsc", "bsc"],
    ["monad", "monad"],
    ["robinhood", "robinhood"],
    ["base", "base"],
    ["solana", "solana"],
    ["sol", "solana"],
  ])("maps internal %s to Dex Screener %s", async (chain, providerChain) => {
    const provider = createDexScreenerClient({
      fetch: async () => Response.json({
        pairs: [{ chainId: providerChain, baseToken: { address: chain === "sol" || chain === "solana" ? "MintCase" : "0xabc" }, priceUsd: "1", liquidity: { usd: 1 }, marketCap: 1 }],
      }),
    });

    await expect(provider.lookup(chain, chain === "sol" || chain === "solana" ? "MintCase" : "0xAbC")).resolves.toMatchObject({ chain });
  });
});

describe("RPC discovery contract", () => {
  it("preserves supported-chain configuration invariants", () => {
    expect(RADAR_DISCOVERY_CHAINS).toEqual(["eth", "bsc", "monad", "robinhood", "base", "solana"]);
    expect(createRadarChainDiscoveryConfiguration({
      chain: "base",
      version: "v1",
      coreVenueIds: ["dex", "dex"],
      coreContractAddresses: ["0x1", "0x1"],
      minimumLiquidityUsd: 1,
    })).toMatchObject({ coreVenueIds: ["dex"], coreContractAddresses: ["0x1"] });
  });

  it("delegates subscription lifecycle and filters block-range trades idempotently", async () => {
    let closed = false;
    const added: string[][] = [];
    const provider = createRadarRpcDiscoveryProvider({
      live: {
        async subscribe() {
          return {
            async addContractAddresses(addresses) { added.push([...addresses]); },
            async close() { closed = true; },
          };
        },
      },
      backfill: {
        async loadTrades() {
          const event = { eventId: "event-1", chain: "base" as const, tokenAddress: "0xtoken", marketAddress: "0xmarket", venueId: "dex", buyerAddress: "0xbuyer", priceUsd: 1, amountUsd: 2, liquidityUsd: 3, blockNumber: 11, occurredAt: 4 };
          return [event, event, { ...event, eventId: "outside", blockNumber: 99 }];
        },
      },
    });
    const signal = new AbortController().signal;
    const subscription = await provider.subscribe({ chain: "solana", contractAddresses: ["Pool"], signal, async onTrade() {} });
    await subscription.addContractAddresses?.(["Pool2"]);
    await subscription.close();

    expect(added).toEqual([["Pool2"]]);
    expect(closed).toBe(true);
    await expect(provider.tradesInBlockRange({ chain: "base", contractAddresses: ["0xmarket"], fromBlock: 10, toBlock: 12, signal })).resolves.toEqual([expect.objectContaining({ eventId: "event-1" })]);
  });

  it("drops invalid and out-of-scope backfill trades with chain-aware address matching", async () => {
    const base = { eventId: "valid", chain: "base" as const, tokenAddress: " 0xToken ", marketAddress: " 0xAaA ", venueId: "dex", buyerAddress: " 0xBuyer ", priceUsd: 1, amountUsd: 2, liquidityUsd: 3, blockNumber: 11, occurredAt: 4 };
    const provider = createRadarRpcDiscoveryProvider({
      live: { async subscribe() { return { async close() {} }; } },
      backfill: { async loadTrades() { return [base, { ...base, eventId: "outside", marketAddress: "0xbbb" }, { ...base, eventId: "invalid", priceUsd: Number.NaN }]; } },
    });
    await expect(provider.tradesInBlockRange({ chain: "base", contractAddresses: ["0xaaa"], fromBlock: 10, toBlock: 12, signal: new AbortController().signal })).resolves.toEqual([
      expect.objectContaining({ eventId: "valid", tokenAddress: "0xtoken", marketAddress: "0xaaa", buyerAddress: "0xbuyer" }),
    ]);

    const solana = createRadarRpcDiscoveryProvider({
      live: { async subscribe() { return { async close() {} }; } },
      backfill: { async loadTrades() { return [{ ...base, eventId: "sol", chain: "solana" as const, tokenAddress: " Mint ", marketAddress: " PoolCase ", buyerAddress: " Buyer " }]; } },
    });
    await expect(solana.tradesInBlockRange({ chain: "solana", contractAddresses: ["poolcase"], fromBlock: 10, toBlock: 12, signal: new AbortController().signal })).resolves.toEqual([]);
  });
});
