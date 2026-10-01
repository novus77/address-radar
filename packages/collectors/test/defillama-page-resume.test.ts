import { describe, expect, it, vi } from "vitest";
import { createDefiLlamaPriceClient } from "../src/defillama-price-client.js";

const HOUR = 3_600_000;
const page = (fromAt: number, toAt: number) => ({
  source: "defillama_chart" as const,
  confidence: 0.9,
  prices: Array.from({ length: (toAt - fromAt) / HOUR + 1 }, (_, i) => ({ observedAt: fromAt + i * HOUR, priceUsd: 2 })),
});

describe("DefiLlama page resume", () => {
  it("reuses a complete first page before gating the missing page", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => new Response(JSON.stringify({ coins: { "ethereum:0xabc": { confidence: 0.8, prices: [{ timestamp: 500 * HOUR / 1000, price: 3 }] } } })));
    const beforeRequest = vi.fn(async () => {});
    const onPage = vi.fn();
    const readPage = vi.fn(({ fromAt, toAt }: { fromAt: number; toAt: number }) => fromAt === 0 ? page(fromAt, toAt) : null);
    const client = createDefiLlamaPriceClient({ fetch, beforeRequest });
    const result = await client.chart("eth", "0xAbC", { fromAt: HOUR, toAt: 501 * HOUR }, undefined, onPage, readPage);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`start=${500 * HOUR / 1000}`);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(result.prices).toHaveLength(501);
    expect(result.confidence).toBe(0.8);
  });

  it.each(["sparse", "wrong_source", "missing_quality"])("refetches %s cache results", async (kind) => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => new Response(JSON.stringify({ coins: {} })));
    const cached = page(0, 2 * HOUR);
    const readPage = () => kind === "sparse" ? { ...cached, prices: cached.prices.slice(1) } : kind === "wrong_source" ? { ...cached, source: "other" } : { ...cached, confidence: null };
    await createDefiLlamaPriceClient({ fetch }).chart("eth", "0xabc", { fromAt: HOUR, toAt: 2 * HOUR }, undefined, undefined, readPage as never);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("matches the accepted grid for fractional-second bounds", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => new Response(JSON.stringify({ coins: {} })));
    const readPage = vi.fn(({ fromAt, toAt }: { fromAt: number; toAt: number }) => page(fromAt, toAt));
    const result = await createDefiLlamaPriceClient({ fetch }).chart("eth", "0xabc", { fromAt: HOUR + 1500, toAt: 2 * HOUR + 1500 }, undefined, undefined, readPage);
    expect(readPage).toHaveBeenCalledWith({ fromAt: HOUR + 1000, toAt: 2 * HOUR + 1000 });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.prices.map(p => p.observedAt)).toEqual([HOUR + 1000, 2 * HOUR + 1000]);
  });
});
