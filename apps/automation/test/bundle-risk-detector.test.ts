import { describe, expect, it } from "vitest";

import { detectRepeatedBundleRisk, type BundleTrade } from "../src/bundle-risk-detector.js";

const trade = (eventId: string, traderId: string, tokenAddress: string, occurredAt: number): BundleTrade => ({
  eventId,
  traderId,
  chain: "solana",
  tokenAddress,
  occurredAt,
});

describe("bundle risk detector", () => {
  it("records 5-second and 10-second clusters without rejecting a single token", () => {
    const within5s = detectRepeatedBundleRisk([
      trade("a", "trader-a", "token-a", 1_000),
      trade("b", "trader-b", "token-a", 5_900),
    ]);
    expect(within5s.pairs[0]).toMatchObject({ proximity: "within_5s", deltaMs: 4_900 });
    expect(within5s.traders.get("trader-a")).toMatchObject({ state: "single_cluster", distinctTokenCount: 1 });

    const within10s = detectRepeatedBundleRisk([
      trade("a", "trader-a", "token-a", 1_000),
      trade("b", "trader-b", "token-a", 10_500),
    ]);
    expect(within10s.pairs[0]).toMatchObject({ proximity: "within_10s", deltaMs: 9_500 });
  });

  it("promotes bundle risk only after synchronization repeats across distinct tokens", () => {
    const result = detectRepeatedBundleRisk([
      trade("a1", "trader-a", "token-a", 1_000),
      trade("b1", "trader-b", "token-a", 3_000),
      trade("a2", "trader-a", "token-b", 20_000),
      trade("b2", "trader-b", "token-b", 27_000),
    ]);
    expect(result.bundleRiskTraderIds).toEqual(["trader-a", "trader-b"]);
    expect(result.traders.get("trader-a")).toMatchObject({ state: "bundle_risk", distinctTokenCount: 2 });
  });

  it("does not create a bundle pair from simultaneous trades in unrelated tokens", () => {
    const result = detectRepeatedBundleRisk([
      trade("a", "trader-a", "token-a", 1_000),
      trade("b", "trader-b", "token-b", 1_000),
    ]);
    expect(result.pairs).toEqual([]);
    expect(result.bundleRiskTraderIds).toEqual([]);
  });
});

