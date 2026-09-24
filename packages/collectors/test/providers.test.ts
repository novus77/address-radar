import { describe, expect, it, vi } from "vitest";

import {
  JsonRpcRateLimitError,
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
});

describe("Dex Screener client", () => {
  it("degrades a missing market to null", async () => {
    const provider = createDexScreenerClient({
      fetch: async () => Response.json({ pairs: null }),
      now: () => 1_000,
    });

    await expect(provider.lookup("solana", "CaseSensitiveMint")).resolves.toBeNull();
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
});
