import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefiLlamaPriceClient } from "../src/defillama-price-client.js";

const HOUR = 3_600_000;
type Options = NonNullable<Parameters<typeof createDefiLlamaPriceClient>[0]> & {
  beforeRequest?: (signal?: AbortSignal) => Promise<void>;
  onRateLimit?: (delayMs: number) => void | Promise<void>;
};
const createClient = (options: Options) => createDefiLlamaPriceClient(options);
const emptyResponse = () => new Response(JSON.stringify({ coins: {} }));

afterEach(() => vi.useRealTimers());

describe("DefiLlama request boundaries", () => {
  it("does not spend the HTTP timeout while waiting for the shared gate", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return emptyResponse();
    });
    const gate = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    const client = createClient({ fetch, timeoutMs: 20, beforeRequest: gate });
    const result = client.chart("base", "0xabc", { fromAt: 0, toAt: HOUR });
    const assertion = expect(result).resolves.toMatchObject({ prices: [] });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(gate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gates every page and gives each HTTP request a fresh timeout", async () => {
    vi.useFakeTimers();
    const gate = vi.fn(async () => {});
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (init?.signal?.aborted) throw new Error("Request aborted");
      return emptyResponse();
    });
    const client = createClient({ fetch, timeoutMs: 20, beforeRequest: gate });
    const result = client.chart("bsc", "0xabc", { fromAt: 0, toAt: 501 * HOUR });
    const assertion = expect(result).resolves.toMatchObject({ prices: [] });
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it("publishes Retry-After cooldown before rejecting a throttled page", async () => {
    const cooldown = vi.fn(async () => {});
    const client = createClient({
      onRateLimit: cooldown,
      fetch: async () => new Response("", { status: 429, headers: { "Retry-After": "12" } }),
    });
    await expect(client.chart("eth", "0xabc", { fromAt: 0, toAt: HOUR }))
      .rejects.toMatchObject({ status: 429, retryable: true });
    expect(cooldown).toHaveBeenCalledExactlyOnceWith(12_000);
  });

  it("does not fetch when cancelled while waiting for the gate", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => emptyResponse());
    const gate = vi.fn(async () => { controller.abort(); });
    const client = createClient({ fetch, beforeRequest: gate });
    await expect(client.chart("solana", "CaseSensitive", { fromAt: 0, toAt: HOUR }, controller.signal))
      .rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
});
