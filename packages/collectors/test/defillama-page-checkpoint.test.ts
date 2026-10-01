import { describe, expect, it } from "vitest";
import { createDefiLlamaPriceClient, type HistoricalTokenPriceClient, type HistoricalTokenPriceResult } from "../src/defillama-price-client.js";
const HOUR = 3_600_000;
type Checkpoint = (page: HistoricalTokenPriceResult) => void | Promise<void>;
function chart(client: HistoricalTokenPriceClient, checkpoint: Checkpoint, signal?: AbortSignal) {
  return (client.chart as (...args: [...Parameters<HistoricalTokenPriceClient["chart"]>, Checkpoint?]) => ReturnType<HistoricalTokenPriceClient["chart"]>)("base", "0xabc", { fromAt: HOUR, toAt: 501 * HOUR }, signal, checkpoint);
}
const response = () => new Response(JSON.stringify({ coins: { "base:0xabc": { confidence: 0.9, prices: [{ timestamp: 3600, price: 2 }] } } }));

describe("DefiLlama per-page checkpoints", () => {
  it("awaits a committed page checkpoint before requesting the next page", async () => {
    const checkpoints: HistoricalTokenPriceResult[] = [];
    let requests = 0;
    let checkpointVisibleBeforeSecondRequest = false;
    const client = createDefiLlamaPriceClient({ fetch: async () => {
      if (++requests === 1) return response();
      checkpointVisibleBeforeSecondRequest = checkpoints.length === 1;
      return new Response("", { status: 503 });
    } });
    await expect(chart(client, async page => { await Promise.resolve(); checkpoints.push(page); }))
      .rejects.toMatchObject({ status: 503 });
    expect(checkpointVisibleBeforeSecondRequest).toBe(true);
    expect(checkpoints).toEqual([{ source: "defillama_chart", confidence: 0.9, prices: [{ observedAt: HOUR, priceUsd: 2 }] }]);
    expect(Object.isFrozen(checkpoints[0]?.prices)).toBe(true);
    expect(Object.isFrozen(checkpoints[0]?.prices[0])).toBe(true);
  });

  it("does not checkpoint an empty page as coverage", async () => {
    let checkpoints = 0;
    const client = createDefiLlamaPriceClient({ fetch: async () => new Response(JSON.stringify({ coins: {} })) });
    await expect(chart(client, () => { checkpoints += 1; })).resolves.toMatchObject({ prices: [] });
    expect(checkpoints).toBe(0);
  });

  it("stops pagination when persistence fails", async () => {
    let requests = 0;
    const client = createDefiLlamaPriceClient({ fetch: async () => { requests += 1; return response(); } });
    await expect(chart(client, () => { throw new Error("Checkpoint failed"); }))
      .rejects.toMatchObject({ message: "Checkpoint failed", retryable: true });
    expect(requests).toBe(1);
  });
});
