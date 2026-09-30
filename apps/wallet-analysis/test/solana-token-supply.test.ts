import { describe, expect, it, vi } from "vitest";

import { createSolanaTokenSupplyProvider } from "../src/solana-token-supply.js";

describe("Solana token supply provider", () => {
  it("resolves token supplies in JSON-RPC batches", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requests = JSON.parse(String(init?.body)) as { id: number; params: [string] }[];
      return Response.json(requests.map(request => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { value: { amount: request.params[0] === "MintA" ? "1000000" : "2500000", decimals: 3, uiAmountString: request.params[0] === "MintA" ? "1000" : "2500" } },
      })));
    });
    const provider = createSolanaTokenSupplyProvider({ endpoint: "https://solana.example", fetch, batchSize: 2 });

    const supplies = await provider.resolveMany(["MintA", "MintB", "MintA"], new AbortController().signal);

    expect([...supplies]).toEqual([["MintA", 1_000], ["MintB", 2_500]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
