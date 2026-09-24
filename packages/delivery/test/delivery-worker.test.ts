import { describe, expect, it, vi } from "vitest";

import { createGatewayDeliveryWorker, GatewayDeliveryError, retryDelayMs } from "../src/index.js";

const row = { outboxId: "outbox-1", broadcastId: "broadcast-1", tokenId: "solana:a", broadcastSequence: 1, payload: { schemaVersion: "1", signalId: "solana:a", idempotencyKey: "solana:a:1", token: { chain: "solana", contractAddress: "a", symbol: null, name: null, imageUrl: null }, category: "new_token_discovery", broadcastSequence: 1, score: 0.8, confidence: 0.8, marketCapUsd: null, priceUsd: null, triggeredAt: "2026-09-24T08:00:00.000Z", expiresAt: "2026-09-24T08:15:00.000Z", display: { title: "Signal", summary: "Summary", reasonCodes: ["reason"] } }, status: "processing" as const, attemptCount: 2, nextRetryAt: 0, lastError: null, claimedBy: "worker", claimedAt: 1, claimToken: "claim", claimGeneration: 1, leaseExpiresAt: 61_000, deliveredAt: null, createdAt: 1 };

describe("delivery worker", () => {
  it("marks accepted delivery and schedules retry without blocking", async () => {
    const repository = { claimSignalOutbox: vi.fn(() => row), markSignalOutboxDelivered: vi.fn(() => true), failSignalOutbox: vi.fn(() => true), deadLetterSignalOutbox: vi.fn(() => true) };
    const delivered = createGatewayDeliveryWorker({ repository, client: { deliver: vi.fn(async () => undefined) }, workerId: "worker", now: () => 1_000 });
    expect(await delivered.runOnce()).toMatchObject({ status: "delivered" });
    const retrying = createGatewayDeliveryWorker({ repository, client: { deliver: vi.fn(async () => { throw new GatewayDeliveryError("down", false, 500); }) }, workerId: "worker", now: () => 1_000, random: () => 0.5 });
    expect(await retrying.runOnce()).toMatchObject({ status: "retry_scheduled" });
    expect(repository.failSignalOutbox).toHaveBeenCalledWith(expect.objectContaining({ nextRetryAt: 5_000 }));
  });

  it("isolates permanent failures", async () => {
    const repository = { claimSignalOutbox: vi.fn(() => row), markSignalOutboxDelivered: vi.fn(() => true), failSignalOutbox: vi.fn(() => true), deadLetterSignalOutbox: vi.fn(() => true) };
    const worker = createGatewayDeliveryWorker({ repository, client: { deliver: vi.fn(async () => { throw new GatewayDeliveryError("bad", true, 400); }) }, workerId: "worker" });
    expect(await worker.runOnce()).toMatchObject({ status: "dead_letter" });
    expect(repository.deadLetterSignalOutbox).toHaveBeenCalledOnce();
  });

  it("uses bounded jittered exponential backoff", () => {
    expect(retryDelayMs(2, () => 0.5)).toBe(4_000);
    expect(retryDelayMs(20, () => 0.5)).toBe(256_000);
  });
});
