import { afterEach, describe, expect, it, vi } from "vitest";

import { openAddressRadarRepository, type AddressRadarRepository } from "@address-radar/database";
import { createScannerRuntime } from "../src/runtime.js";

describe("scanner runtime", () => {
  let repository: AddressRadarRepository | undefined;
  afterEach(() => { repository?.close(); repository = undefined; });

  it("injects collectors and sink while applying chain, token, and purchase filters", async () => {
    repository = openAddressRadarRepository(":memory:");
    for (const [index, eventId] of ["accepted-a", "accepted-b", "small", "blocked-chain"].entries()) {
      const accountId = `account-${index}`;
      const entityId = `entity-${index}`;
      repository.upsertFomoAccount({ accountId, handle: `trader-${index}`, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId, lifecycle: "elite", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
      repository.insertTraderEvent({ eventId, accountId, entityId, chain: index === 3 ? "base" : "solana", tokenAddress: "TokenA", side: "buy", amountUsd: index === 2 ? 10 : 1_000, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: 60_000, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    }
    const accepted = vi.fn();
    const runtime = createScannerRuntime({
      repository,
      collectors: [{
        collect: async () => [
          { chain: "solana", tokenAddress: "TokenA", evidence: { eventId: "accepted-a", entityId: "entity-0", contribution: 0.8, occurredAt: 1_000, side: "buy", amountUsd: 1_000, lifecycleStage: "launched_0_2h", traderTags: ["EARLY_LAUNCH"] } },
          { chain: "solana", tokenAddress: "TokenA", evidence: { eventId: "accepted-b", entityId: "entity-1", contribution: 0.8, occurredAt: 1_001, side: "buy", amountUsd: 1_000, lifecycleStage: "launched_0_2h", traderTags: ["HIGH_MULTIPLE"] } },
          { chain: "solana", tokenAddress: "TokenA", evidence: { eventId: "small", entityId: "entity-2", contribution: 0.9, occurredAt: 1_002, side: "buy", amountUsd: 10, lifecycleStage: "launched_0_2h" } },
          { chain: "base", tokenAddress: "TokenA", evidence: { eventId: "blocked-chain", entityId: "entity-3", contribution: 0.9, occurredAt: 1_003, side: "buy", amountUsd: 1_000, lifecycleStage: "launched_0_2h" } },
        ],
      }],
      signalSink: { accept: accepted },
      clock: { now: () => 3_000 },
      config: {
        strategyVersion: "address-v1",
        signalThreshold: 0.7,
        minimumPurchaseUsd: 100,
        minimumAggregateBuyUsd: 100,
        allowedChains: ["solana"],
        excludedTokenIds: [],
      },
    });

    const result = await runtime.runOnce();

    expect(result).toMatchObject({ collected: 4, accepted: 2, rejected: 2, candidateCount: 1 });
    expect(accepted).toHaveBeenCalledWith([expect.objectContaining({ signalId: "solana:TokenA", broadcastSequence: 1 })]);
  });
});
