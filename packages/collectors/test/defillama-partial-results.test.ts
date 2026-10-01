import { describe, expect, it } from "vitest";
import { createDefiLlamaPriceClient } from "../src/defillama-price-client.js";

const HOUR = 3_600_000;

describe("DefiLlama partial results", () => {
  it("retains successful prices when the next page is throttled", async () => {
    let requests = 0;
    const client = createDefiLlamaPriceClient({ fetch: async () => ++requests === 1
      ? new Response(JSON.stringify({ coins: { "base:0xabc": {
        confidence: 0.9, prices: [{ timestamp: 3_600, price: 2 }],
      } } }))
      : new Response("", { status: 429 }) });
    await expect(client.chart("base", "0xAbC", { fromAt: HOUR, toAt: 501 * HOUR }))
      .rejects.toMatchObject({ status: 429, retryable: true, partialResult: {
        source: "defillama_chart", confidence: 0.9,
        prices: [{ observedAt: HOUR, priceUsd: 2 }],
      } });
    expect(requests).toBe(2);
  });

  it("does not invent partial coverage when no successful prices exist", async () => {
    const client = createDefiLlamaPriceClient({ fetch: async () => new Response("", { status: 503 }) });
    try {
      await client.chart("eth", "0xabc", { fromAt: 0, toAt: HOUR });
      throw new Error("Expected request failure");
    } catch (error) {
      expect(error).toMatchObject({ status: 503, retryable: true });
      expect((error as { partialResult?: unknown }).partialResult).toBeUndefined();
    }
  });

  it("retains completed pages when cancelled before the next request", async () => {
    const controller = new AbortController();
    let gates = 0;
    const client = createDefiLlamaPriceClient({
      beforeRequest: async () => { if (++gates === 2) controller.abort(); },
      fetch: async () => new Response(JSON.stringify({ coins: { "solana:Mint": {
        prices: [{ timestamp: 3_600, price: 2 }],
      } } })),
    });
    await expect(client.chart("solana", "Mint", { fromAt: HOUR, toAt: 501 * HOUR }, controller.signal))
      .rejects.toMatchObject({ status: null, retryable: true, partialResult: {
        source: "defillama_chart", prices: [{ observedAt: HOUR, priceUsd: 2 }],
      } });
  });
});
