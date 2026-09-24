import { describe, expect, it, vi } from "vitest";
import { openAddressRadarRepository } from "@address-radar/database";
import { createSignalOutboxPublisher } from "../src/outbox-publisher.js";

describe("signal outbox publisher", () => {
  it("retains failed rows and marks acknowledged rows delivered", async () => {
    const repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "a", handle: "a", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-a", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "a", entityId: "entity-a", confidence: "confirmed", source: "test", observedAt: 1 });
    repository.insertTraderEvent({ eventId: "e", accountId: "a", entityId: "entity-a", chain: "solana", tokenAddress: "T", side: "buy", amountUsd: 1_000, priceUsd: null, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    const signal = { schemaVersion: "1" as const, signalId: "solana:T", idempotencyKey: "solana:T:broadcast:1", token: { chain: "solana", contractAddress: "T", symbol: null, name: null, imageUrl: null }, category: "new_token_discovery" as const, broadcastSequence: 1, score: 0.8, confidence: 0.8, marketCapUsd: null, priceUsd: null, triggeredAt: new Date(1_000).toISOString(), expiresAt: new Date(301_000).toISOString(), display: { title: "Title", summary: "Summary", reasonCodes: ["reason"] } };
    repository.commitTokenBroadcast({ chain: "solana", tokenAddress: "T", expectedPreviousBroadcastCount: 0, strategyVersion: "v", score: 0.8, triggeredAt: 1_000, evidenceIds: ["e"], economicKeys: ["k"], evaluation: { chain: "solana", tokenAddress: "T", action: "broadcast", signalFamily: "NEW_TOKEN_DISCOVERY", lifecycleStage: "created", score: 0.8, participantCount: 3, totalBuyUsd: 3_000, sourceState: "FOMO_ONLY", windowMs: 600_000, missingConditions: [], updatedAt: 1_000 }, payload: { kind: "radar_signal_evaluation", version: 1, publicSignal: signal, audit: {} }, publicSignal: signal });
    const sink = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    let now = 2_000;
    const publisher = createSignalOutboxPublisher({ repository, sink: { accept: sink }, workerId: "worker", now: () => now, retryDelayMs: () => 100 });
    await expect(publisher.publishNext()).resolves.toMatchObject({ status: "retry_scheduled" });
    now = 2_100;
    await expect(publisher.publishNext()).resolves.toMatchObject({ status: "delivered" });
    expect(repository.pendingSignalOutbox()).toEqual([]);
    repository.close();
  });
});
