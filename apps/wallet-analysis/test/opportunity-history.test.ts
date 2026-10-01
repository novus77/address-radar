import { describe, expect, it } from "vitest";

import type { TraderEvent } from "@address-radar/domain";
import { evaluateTraderOpportunityHistory } from "../src/opportunity-history.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;

function buy(tokenAddress: string, eventId = tokenAddress): TraderEvent {
  return { eventId, accountId: "account", entityId: "entity", chain: "solana", tokenAddress,
    side: "buy", amountUsd: 100, priceUsd: 1, marketCapUsd: null, tokenAgeMs: null,
    occurredAt: NOW - 12 * DAY, collectedAt: NOW - 12 * DAY, source: "onchain_wallet" };
}

describe("opportunity history integration", () => {
  it("finds later opportunities directly from market history without any sale or fixed close", () => {
    const result = evaluateTraderOpportunityHistory({ events: [buy("A"), buy("B")], samples: [], outcomes: [], asOf: NOW,
      readObservations: () => [{ observedAt: NOW - DAY, priceUsd: 5, source: "market" }],
    });
    expect(result.labels).toEqual(["repeated_high_multiple_discovery"]);
    expect(result.metrics.hit5xTokens).toBe(2);
  });

  it("uses actual recent buys even when the position's first entry is older than the current cohort", () => {
    const result = evaluateTraderOpportunityHistory({ events: [buy("A")], samples: [{
      sampleId: "old", chain: "solana", tokenAddress: "A", firstBuyAt: NOW - 45 * DAY,
      sampleStatus: "included", weightedEntryPriceUsd: 20, totalBuyUsd: 100,
    }], outcomes: [], asOf: NOW, readObservations: () => [{ observedAt: NOW, priceUsd: 5, source: "market" }] });
    expect(result.metrics).toMatchObject({ currentTokens: 1, hit5xTokens: 1 });
  });

  it("accepts bounded, verified MFE but never substitutes a fixed close or captured return", () => {
    const samples = ["A", "B"].map(tokenAddress => ({ sampleId: tokenAddress, chain: "solana", tokenAddress,
      firstBuyAt: NOW - 12 * DAY, sampleStatus: "included", weightedEntryPriceUsd: 1, totalBuyUsd: 100 }));
    const result = evaluateTraderOpportunityHistory({ events: [], samples, outcomes: [
      { sampleId: "A", mfeMultiple: 5, observedAt: NOW - 11 * DAY, computedAt: NOW - 11 * DAY, source: "test", coverageStatus: "complete" },
      { sampleId: "B", mfeMultiple: null, observedAt: NOW - 11 * DAY, computedAt: NOW - 11 * DAY, source: "test", coverageStatus: "complete" },
    ], asOf: NOW, readObservations: () => [] });
    expect(result.metrics).toMatchObject({ hit5xTokens: 1, awaitingDataTokens: 1, missedTokens: 0 });
  });

  it("preserves case-distinct Solana assets and ignores unavailable future events", () => {
    const result = evaluateTraderOpportunityHistory({ events: [
      buy("MintAbC"), buy("Mintabc"), { ...buy("Future"), collectedAt: NOW + 1 },
    ], samples: [], outcomes: [], asOf: NOW,
      readObservations: () => [{ observedAt: NOW, priceUsd: 5, source: "market" }],
    });
    expect(result.metrics.currentTokens).toBe(2);
    expect(result.labels).toEqual(["repeated_high_multiple_discovery"]);
  });
});
