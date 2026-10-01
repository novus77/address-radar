import { expect, it, vi } from "vitest";
import { openAddressRadarRepository } from "@address-radar/database";
import { createScannerRuntime } from "../src/runtime.js";

it("does not backdate a current market quote to a replayed purchase", async () => {
  const repository = openAddressRadarRepository(":memory:");
  try {
    repository.upsertFomoAccount({ accountId: "a", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "e", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "e", accountId: "a", confidence: "confirmed", source: "test", observedAt: 1 });
    const inserted = vi.fn(repository.insertTraderEvent);
    const snapshot = vi.fn();
    const callback = vi.fn();
    const observation = vi.fn();
    const runtime = createScannerRuntime({
      repository: { ...repository, insertTraderEvent: inserted }, clock: { now: () => 100_000 },
      collectors: [{ collect: async () => [{ event: { eventId: "buy", accountId: "a", entityId: "e", chain: "solana", tokenAddress: "Token", side: "buy", amountUsd: 100, priceUsd: 1, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 100_000, source: "fomo_stream" } }] }],
      marketProvider: { lookup: async () => ({ chain: "solana", tokenAddress: "Token", priceUsd: 5, marketCapUsd: 500_000, liquidityUsd: 100_000, observedAt: new Date(99_000).toISOString() }) },
      tokenStateStore: { saveTokenObservation: observation, saveTokenMarketSnapshot: snapshot, enqueueRecoveryJob: vi.fn() },
      onTokenMarketObserved: callback,
      config: { strategyVersion: "test", signalThreshold: 0.7, minimumPurchaseUsd: 50, minimumAggregateBuyUsd: 100, allowedChains: ["solana"], excludedTokenIds: [] },
    });
    await runtime.runOnce();
    expect(snapshot).toHaveBeenCalledWith(expect.objectContaining({ observedAt: 99_000 }));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ observedAt: 99_000 }));
    expect(observation).toHaveBeenCalledWith(expect.objectContaining({ milestoneObservedAt: 99_000 }));
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: 1_000, priceUsd: 1 }));
  } finally { repository.close(); }
});
