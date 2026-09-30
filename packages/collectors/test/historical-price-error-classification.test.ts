import { describe, expect, it } from "vitest";
import { createDefiLlamaPriceClient } from "../src/defillama-price-client.js";

describe("historical price provider limits", () => {
  it("splits sixty days into bounded requests without losing the final interval", async () => {
    const urls: URL[] = [];
    const client = createDefiLlamaPriceClient({ fetch: async input => {
      const url = new URL(String(input)); urls.push(url);
      const span = Number(url.searchParams.get("span"));
      if (span > 500) return Response.json({ message: "Requested 1442 data points exceeds the maximum of 500." }, { status: 400 });
      const start = Number(url.searchParams.get("start"));
      return Response.json({ coins: { "ethereum:0xabc": { confidence: 0.9, prices: Array.from({ length: span }, (_, i) => ({ timestamp: start + i * 3600, price: 1 })) } } });
    } });
    const fromAt = 3600000, toAt = fromAt + 60 * 86400000;
    const result = await client.chart("eth", "0xabc", { fromAt, toAt });
    expect(urls).toHaveLength(3);
    expect(urls.every(url => Number(url.searchParams.get("span")) <= 500)).toBe(true);
    expect(result.prices.at(-1)?.observedAt).toBe(toAt);
    expect(new Set(result.prices.map(point => point.observedAt)).size).toBe(result.prices.length);
  });
  it.each([[400, false], [404, false], [429, true], [503, true]] as const)("classifies HTTP %s", async (status, retryable) => {
    const client = createDefiLlamaPriceClient({ fetch: async () => Response.json({ message: "provider response" }, { status }) });
    if (status === 404) await expect(client.chart("eth", "0xabc", { fromAt: 0, toAt: 1000 })).resolves.toMatchObject({ prices: [] });
    else await expect(client.chart("eth", "0xabc", { fromAt: 0, toAt: 1000 })).rejects.toMatchObject({ status, retryable });
  });
});
