import { describe, expect, it } from "vitest";

import { evaluateTraderOpportunities, type OpportunityPurchase } from "@address-radar/scoring";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function purchase(tokenAddress: string, overrides: Partial<OpportunityPurchase> = {}): OpportunityPurchase {
  return {
    purchaseId: tokenAddress,
    chain: "solana",
    tokenAddress,
    boughtAt: NOW - 12 * DAY,
    buyUsd: 100,
    entryPriceUsd: 1,
    observations: [{ observedAt: NOW - DAY, priceUsd: 5, source: "test" }],
    ...overrides,
  };
}

describe("approved trader opportunity rules", () => {
  it("recognizes an unsold 5x opportunity after retracement without an exit measurement", () => {
    const result = evaluateTraderOpportunities({ purchases: [purchase("Mint", {
      observations: [
        { observedAt: NOW - 2 * DAY, priceUsd: 5, source: "test" },
        { observedAt: NOW, priceUsd: 0.8, source: "test" },
      ],
    })], asOf: NOW });
    expect(result.purchases[0]).toMatchObject({ status: "hit", maximumMultiple: 5, observationOpen: true });
    expect(result.metrics).toMatchObject({ hit3xTokens: 1, hit5xTokens: 1, missedTokens: 0 });
  });

  it("excludes pre-entry, future, late-collected and post-30-day prices", () => {
    const result = evaluateTraderOpportunities({ purchases: [purchase("Mint", {
      boughtAt: NOW - 35 * DAY,
      observations: [
        { observedAt: NOW - 36 * DAY, priceUsd: 100, source: "test" },
        { observedAt: NOW - 6 * DAY, priceUsd: 3, source: "test" },
        { observedAt: NOW - 4 * DAY, priceUsd: 20, source: "test" },
        { observedAt: NOW + DAY, priceUsd: 30, source: "test" },
        { observedAt: NOW - 10 * DAY, priceUsd: 50, source: "test", collectedAt: NOW + 1 },
      ],
    })], asOf: NOW });
    expect(result.purchases[0]).toMatchObject({ maximumMultiple: 3, inCurrentWindow: false, observationOpen: false });
    expect(result.metrics.hit3xTokens).toBe(0);
  });

  it("leaves unfinished observations open instead of recording a miss", () => {
    const result = evaluateTraderOpportunities({ purchases: [purchase("Mint", {
      observations: [{ observedAt: NOW, priceUsd: 2, source: "test" }],
      coverage: [{ from: NOW - 12 * DAY, to: NOW, source: "test", verifiedAt: NOW }],
    })], asOf: NOW });
    expect(result.purchases[0]?.status).toBe("observing");
    expect(result.metrics).toMatchObject({ observingTokens: 1, missedTokens: 0 });
  });

  it("keeps missing entry and sparse historical prices awaiting data", () => {
    const result = evaluateTraderOpportunities({ purchases: [
      purchase("NoEntry", { entryPriceUsd: null }),
      purchase("Sparse", { boughtAt: NOW - 30 * DAY, observations: [{ observedAt: NOW, priceUsd: 2, source: "test" }] }),
    ], asOf: NOW });
    expect(result.purchases.map(item => item.status)).toEqual(["awaiting_data", "awaiting_data"]);
    expect(result.metrics).toMatchObject({ awaitingDataTokens: 2, missedTokens: 0 });
  });

  it("records a mature non-hit only with continuous verified coverage", () => {
    const result = evaluateTraderOpportunities({ purchases: [purchase("Mint", {
      boughtAt: NOW - 30 * DAY,
      observations: [{ observedAt: NOW, priceUsd: 2, source: "test" }],
      coverage: [
        { from: NOW - 30 * DAY, to: NOW - 10 * DAY, source: "test", verifiedAt: NOW },
        { from: NOW - 10 * DAY, to: NOW, source: "test", verifiedAt: NOW },
      ],
    })], asOf: NOW });
    expect(result.purchases[0]).toMatchObject({ status: "missed", maximumMultiple: 2, rangeCovered: true });
    expect(result.metrics.missedTokens).toBe(1);
  });

  it("does not treat gapped or future-verified coverage as complete", () => {
    const result = evaluateTraderOpportunities({ purchases: [purchase("Mint", {
      boughtAt: NOW - 30 * DAY,
      observations: [{ observedAt: NOW, priceUsd: 2, source: "test" }],
      coverage: [
        { from: NOW - 30 * DAY, to: NOW - 10 * DAY - 1, source: "test", verifiedAt: NOW },
        { from: NOW - 10 * DAY, to: NOW, source: "test", verifiedAt: NOW },
        { from: NOW - 30 * DAY, to: NOW, source: "test", verifiedAt: NOW + 1 },
      ],
    })], asOf: NOW });
    expect(result.purchases[0]?.status).toBe("awaiting_data");
  });

  it("recognizes three distinct 3x tokens without sample-count, coverage or activity-span gates", () => {
    const result = evaluateTraderOpportunities({ purchases: ["A", "B", "C"].map(token => purchase(token, {
      boughtAt: NOW - DAY,
      observations: [{ observedAt: NOW, priceUsd: 3, source: "test" }],
    })), asOf: NOW });
    expect(result.labels).toEqual(["repeated_discovery"]);
    expect(result.metrics).toMatchObject({ currentTokens: 3, hit3xTokens: 3, rangeCoverageRate: 0 });
  });

  it("recognizes two distinct 5x tokens independently and allows both labels", () => {
    expect(evaluateTraderOpportunities({ purchases: [purchase("A"), purchase("B")], asOf: NOW }).labels)
      .toEqual(["repeated_high_multiple_discovery"]);
    expect(evaluateTraderOpportunities({ purchases: [purchase("A"), purchase("B"), purchase("C")], asOf: NOW }).labels)
      .toEqual(["repeated_discovery", "repeated_high_multiple_discovery"]);
  });

  it("counts repeat purchases and duplicate IDs once per token while preserving Solana mint case", () => {
    const result = evaluateTraderOpportunities({ purchases: [
      purchase("MintAbC"), purchase("MintAbC", { purchaseId: "second-buy" }),
      purchase("Mintabc"), purchase("Mintabc"),
    ], asOf: NOW });
    expect(result.purchases).toHaveLength(3);
    expect(result.metrics).toMatchObject({ currentTokens: 2, hit5xTokens: 2 });
    expect(result.labels).toEqual(["repeated_high_multiple_discovery"]);
  });

  it("normalizes EVM token case without combining chains", () => {
    const result = evaluateTraderOpportunities({ purchases: [
      purchase("0xAbC", { chain: "eth", purchaseId: "eth-1" }),
      purchase("0xabc", { chain: "eth", purchaseId: "eth-2" }),
      purchase("0xabc", { chain: "base", purchaseId: "base-1" }),
    ], asOf: NOW });
    expect(result.metrics.currentTokens).toBe(2);
  });

  it("keeps aged evidence visible without counting it as recent recurrence", () => {
    const result = evaluateTraderOpportunities({ purchases: [purchase("Mint", {
      boughtAt: NOW - 31 * DAY,
      observations: [{ observedAt: NOW - 2 * DAY, priceUsd: 10, source: "test" }],
    })], asOf: NOW });
    expect(result.purchases[0]?.maximumMultiple).toBe(10);
    expect(result.metrics.currentTokens).toBe(0);
    expect(result.labels).toEqual([]);
  });

  it("excludes dust, invalid prices and purchases not yet known at evaluation time", () => {
    const result = evaluateTraderOpportunities({ purchases: [
      purchase("Dust", { buyUsd: 49.99 }),
      purchase("Future", { collectedAt: NOW + 1 }),
      purchase("BadPrice", { entryPriceUsd: Number.NaN }),
      purchase("InvalidObservations", { observations: [
        { observedAt: NOW, priceUsd: Number.POSITIVE_INFINITY, source: "test" },
        { observedAt: NOW, priceUsd: -1, source: "test" },
      ] }),
    ], asOf: NOW });
    expect(result.purchases.map(item => item.status)).toEqual(["excluded", "excluded", "awaiting_data", "awaiting_data"]);
    expect(result.labels).toEqual([]);
  });
});
