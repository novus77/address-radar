import { describe, expect, it, vi } from "vitest";

import type { HistoricalMilestoneProvider } from "../src/historical-provider-router.js";
import { createHistoricalProviderRouter } from "../src/historical-provider-router.js";

const input = {
  chain: "base" as const,
  tokenAddress: "0xToken",
  fromTimestamp: 0,
  toTimestamp: 1,
};

const unavailable = {
  status: "not_found" as const,
  poolAddress: null,
  supplyEstimate: null,
  supplyBasis: null,
  milestones: [],
  candleCount: 0,
};

const available = {
  status: "available" as const,
  poolAddress: "pool",
  supplyEstimate: 1_000_000,
  supplyBasis: "market_cap" as const,
  milestones: [],
  candleCount: 10,
};

describe("HistoricalProviderRouter", () => {
  it("returns the primary result without calling fallback", async () => {
    const fallback = vi.fn(async () => available);
    const router = createHistoricalProviderRouter({
      primary: { id: "gecko_terminal", provider: { reconstruct: async () => available } },
      fallback: { id: "dune", provider: { reconstruct: fallback } },
    });

    await expect(router.reconstruct(input)).resolves.toMatchObject({ provider: "gecko_terminal" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the optional fallback when primary data is unavailable", async () => {
    const router = createHistoricalProviderRouter({
      primary: { id: "gecko_terminal", provider: { reconstruct: async () => unavailable } },
      fallback: { id: "dune", provider: { reconstruct: async () => available } },
    });

    await expect(router.reconstruct(input)).resolves.toMatchObject({
      provider: "dune",
      result: { status: "available" },
      attempts: [
        { provider: "gecko_terminal", outcome: "not_found" },
        { provider: "dune", outcome: "available" },
      ],
    });
  });

  it("opens the fallback circuit after a quota error", async () => {
    let now = 1_000;
    const fallback: HistoricalMilestoneProvider = {
      reconstruct: vi.fn(async () => { throw new Error("Dune credit limit reached"); }),
    };
    const router = createHistoricalProviderRouter({
      primary: { id: "gecko_terminal", provider: { reconstruct: async () => unavailable } },
      fallback: { id: "dune", provider: fallback },
      now: () => now,
      fallbackCircuitCooldownMs: 5_000,
    });

    await router.reconstruct(input);
    expect(router.fallbackCircuit()).toEqual({ open: true, retryAt: 6_000 });
    const second = await router.reconstruct(input);
    expect(second.attempts.at(-1)).toMatchObject({ provider: "dune", outcome: "circuit_open" });
    expect(fallback.reconstruct).toHaveBeenCalledTimes(1);

    now = 6_001;
    await router.reconstruct(input);
    expect(fallback.reconstruct).toHaveBeenCalledTimes(2);
  });

  it("keeps operating when fallback is disabled", async () => {
    const router = createHistoricalProviderRouter({
      primary: { id: "gecko_terminal", provider: { reconstruct: async () => unavailable } },
      fallback: { id: "dune", enabled: false, provider: { reconstruct: async () => available } },
    });

    await expect(router.reconstruct(input)).resolves.toMatchObject({
      provider: "gecko_terminal",
      result: { status: "not_found" },
      attempts: [{ provider: "gecko_terminal", outcome: "not_found" }],
    });
  });

  it("preserves retryable primary failures when fallback is disabled", async () => {
    const rateLimit = Object.assign(new Error("GeckoTerminal request failed with status 429"), { retryable: true });
    const router = createHistoricalProviderRouter({
      primary: { id: "gecko_terminal", provider: { reconstruct: async () => { throw rateLimit; } } },
    });

    await expect(router.reconstruct(input)).rejects.toBe(rateLimit);
  });

  it("classifies ordinary rate-limit and server errors as retryable", async () => {
    for (const message of ["request failed with status 429", "request failed with status 503", "request timed out"]) {
      const error = new Error(message);
      const router = createHistoricalProviderRouter({
        primary: { id: "gecko_terminal", provider: { reconstruct: async () => { throw error; } } },
      });
      await expect(router.reconstruct(input)).rejects.toBe(error);
    }
  });
});
