import { describe, expect, it } from "vitest";

import { createDefiLlamaPriceClient } from "../src/defillama-price-client.js";

describe("DefiLlamaPriceClient", () => {
  it("loads and normalizes hourly token prices", async () => {
    let requestedUrl = "";
    const client = createDefiLlamaPriceClient({
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          coins: {
            "ethereum:0xabc": {
              confidence: 0.97,
              prices: [
                { timestamp: 1_000, price: 1.25 },
                { timestamp: 4_600, price: 1.5 },
              ],
            },
          },
        }));
      },
    });

    await expect(client.chart("eth", "0xAbC", { fromAt: 1_000_000, toAt: 4_600_000 }))
      .resolves.toEqual({
        source: "defillama_chart",
        confidence: 0.97,
        prices: [
          { observedAt: 1_000_000, priceUsd: 1.25 },
          { observedAt: 4_600_000, priceUsd: 1.5 },
        ],
      });
    expect(requestedUrl).toContain("ethereum%3A0xabc");
    expect(requestedUrl).toContain("period=1h");
  });

  it("returns no coverage for unsupported chains without issuing a request", async () => {
    let called = false;
    const client = createDefiLlamaPriceClient({
      fetch: async () => {
        called = true;
        return new Response();
      },
    });

    await expect(client.chart("robinhood", "0xabc", { fromAt: 0, toAt: 1_000 }))
      .resolves.toEqual({ source: "defillama_chart", confidence: null, prices: [] });
    expect(called).toBe(false);
  });

  it("classifies provider throttling as retryable", async () => {
    const client = createDefiLlamaPriceClient({ fetch: async () => new Response("", { status: 429 }) });
    await expect(client.chart("base", "0xabc", { fromAt: 0, toAt: 1_000 }))
      .rejects.toMatchObject({ name: "DefiLlamaPriceError", status: 429, retryable: true });
  });
});
