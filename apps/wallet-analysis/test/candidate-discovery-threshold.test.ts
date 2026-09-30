import { describe, expect, it } from "vitest";

import type { AddressRadarRepository } from "@address-radar/database";
import { createCandidateDiscoveryService } from "../src/candidate-discovery.js";

function repositoryForBuy(amountUsd: number) {
  const discoveries: unknown[] = [];
  const repository = {
    recordTokenMilestone() {
      return { inserted: true };
    },
    eventsForToken() {
      return [{
        eventId: "buy-1",
        accountId: "account-1",
        entityId: "entity-1",
        chain: "solana",
        tokenAddress: "token-1",
        side: "buy",
        amountUsd,
        priceUsd: 1,
        marketCapUsd: 20_000,
        tokenAgeMs: 1,
        occurredAt: 500,
        collectedAt: 500,
        source: "fomo",
      }];
    },
    saveCandidateDiscovery(discovery: unknown) {
      discoveries.push(discovery);
    },
    candidateDiscoveries() {
      return [];
    },
  } as unknown as AddressRadarRepository;
  return { repository, discoveries };
}

describe("candidate discovery buy threshold", () => {
  it("accepts a cumulative buy of exactly 50 USD", () => {
    const { repository, discoveries } = repositoryForBuy(50);
    const service = createCandidateDiscoveryService({ repository });

    service.observe({
      chain: "solana",
      tokenAddress: "token-1",
      marketCapUsd: 100_000,
      reachedAt: 1_000,
      provenance: { source: "test", sourceEventIds: ["milestone-1"] },
    });

    expect(discoveries).toHaveLength(1);
  });

  it("rejects a cumulative buy below 50 USD", () => {
    const { repository, discoveries } = repositoryForBuy(49.99);
    const service = createCandidateDiscoveryService({ repository });

    service.observe({
      chain: "solana",
      tokenAddress: "token-1",
      marketCapUsd: 100_000,
      reachedAt: 1_000,
      provenance: { source: "test", sourceEventIds: ["milestone-1"] },
    });

    expect(discoveries).toHaveLength(0);
  });
});
