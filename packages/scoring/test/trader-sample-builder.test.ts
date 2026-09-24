import { describe, expect, it } from "vitest";

import type { TraderEvent } from "@address-radar/domain";
import { buildTraderTokenSample } from "@address-radar/scoring";

const event = (overrides: Partial<TraderEvent> = {}): TraderEvent => ({
  eventId: "event-1", accountId: "account-1", entityId: "entity-1", chain: "solana", tokenAddress: "TokenA",
  side: "buy", amountUsd: 100, priceUsd: 0.01, marketCapUsd: 500_000, tokenAgeMs: 60_000,
  occurredAt: 1_000, collectedAt: 1_100, source: "fomo_stream", ...overrides,
});

describe("trader token sample builder", () => {
  it("preserves case-sensitive Solana mints in sample identities", () => {
    const upper = buildTraderTokenSample({ events: [event({ tokenAddress: "MintAbC" })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });
    const lower = buildTraderTokenSample({ events: [event({ tokenAddress: "Mintabc" })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });

    expect(upper.sampleId).not.toBe(lower.sampleId);
    expect(upper.sampleId).toBe("entity-1:solana:MintAbC");
    expect(lower.sampleId).toBe("entity-1:solana:Mintabc");
  });

  it("normalizes case-insensitive EVM addresses in sample identities", () => {
    const upper = buildTraderTokenSample({ events: [event({ chain: "ethereum", tokenAddress: "0xAbCd" })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });
    const lower = buildTraderTokenSample({ events: [event({ chain: "ethereum", tokenAddress: "0xabcd" })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });

    expect(upper.sampleId).toBe(lower.sampleId);
    expect(upper.sampleId).toBe("entity-1:ethereum:0xabcd");
  });

  it("folds a trader token history into one weighted sample", () => {
    const result = buildTraderTokenSample({
      events: [
        event(),
        event({ eventId: "event-2", amountUsd: 300, priceUsd: 0.03, marketCapUsd: 900_000, occurredAt: 2_000, source: "onchain_wallet" }),
        event({ eventId: "event-3", side: "sell", amountUsd: 200, priceUsd: 0.04, marketCapUsd: 1_200_000, occurredAt: 3_000, source: "onchain_wallet" }),
      ],
      launchAt: 500, now: 4_000, dustThresholdUsd: 25,
    });
    expect(result).toEqual(expect.objectContaining({ entityId: "entity-1", chain: "solana", tokenAddress: "TokenA", firstBuyAt: 1_000, lastActivityAt: 3_000, weightedEntryPriceUsd: 0.025, weightedEntryMarketCapUsd: 800_000, totalBuyUsd: 400, totalSellUsd: 200, remainingCostUsd: 200, sourceState: "FOMO_AND_ONCHAIN", sampleStatus: "included" }));
  });

  it("marks dust and non-trade observations without turning them into ability evidence", () => {
    const dust = buildTraderTokenSample({ events: [event({ amountUsd: 10 })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });
    const nonTrade = buildTraderTokenSample({ events: [event({ side: "sell" })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });
    expect(dust).toEqual(expect.objectContaining({ sampleStatus: "dust", exclusionReason: "below_dust_threshold" }));
    expect(nonTrade).toEqual(expect.objectContaining({ sampleStatus: "non_trade", exclusionReason: "no_valid_buy" }));
  });

  it("rejects mixed trader or token event sets", () => {
    expect(() => buildTraderTokenSample({ events: [event(), event({ eventId: "event-2", tokenAddress: "TokenB" })], launchAt: null, now: 2_000, dustThresholdUsd: 25 })).toThrow("same entity and token");
  });

  it.each(["fomo_stream", "fomo_profile", "fomo_leaderboard", "fomo_token_history"] as const)("maps %s to FOMO_ONLY", (source) => {
    const result = buildTraderTokenSample({ events: [event({ source })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });
    expect(result.sourceState).toBe("FOMO_ONLY");
  });

  it.each(["onchain_wallet"] as const)("does not map %s to a Fomo source", (source) => {
    const result = buildTraderTokenSample({ events: [event({ source })], launchAt: null, now: 2_000, dustThresholdUsd: 25 });
    expect(result.sourceState).toBe("ONCHAIN_ONLY");
  });
});
