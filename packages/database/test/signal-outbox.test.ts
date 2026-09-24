import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";

const seedEvidence = (repository: ReturnType<typeof openAddressRadarRepository>, eventId: string) => {
  const accountId = `account-${eventId}`;
  const entityId = `entity-${eventId}`;
  repository.upsertFomoAccount({ accountId, handle: accountId, firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId, lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
  repository.insertTraderEvent({ eventId, accountId, entityId, chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 1_000, priceUsd: null, marketCapUsd: null, tokenAgeMs: null, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
};

const publicSignal = (sequence: number) => ({
  schemaVersion: "1" as const,
  signalId: "solana:TokenA",
  idempotencyKey: `solana:TokenA:broadcast:${sequence}`,
  token: { chain: "solana", contractAddress: "TokenA", symbol: null, name: null, imageUrl: null },
  category: "new_token_discovery" as const,
  broadcastSequence: sequence,
  score: 0.9,
  confidence: 0.9,
  marketCapUsd: null,
  priceUsd: null,
  triggeredAt: new Date(sequence * 1_000).toISOString(),
  expiresAt: new Date(sequence * 1_000 + 300_000).toISOString(),
  display: { title: "New token discovery", summary: "Qualified traders", reasonCodes: ["concurrent_qualified_entries"] },
});

const evaluation = (action: "broadcast" | "rebroadcast") => ({
  chain: "solana", tokenAddress: "TokenA", action, signalFamily: "NEW_TOKEN_DISCOVERY" as const,
  lifecycleStage: "created" as const, score: 0.9, participantCount: 3, totalBuyUsd: 3_000,
  sourceState: "FOMO_AND_ONCHAIN" as const, windowMs: 600_000, missingConditions: [] as const, updatedAt: 1_000,
});

describe("transactional signal outbox", () => {
  it("atomically persists evaluation, broadcast, economic consumption, and pending outbox", () => {
    const repository = openAddressRadarRepository(":memory:");
    seedEvidence(repository, "fomo-a");
    const signal = publicSignal(1);
    const result = repository.commitTokenBroadcast({
      chain: "solana", tokenAddress: "TokenA", expectedPreviousBroadcastCount: 0,
      strategyVersion: "address-v1", score: 0.9, triggeredAt: 1_000,
      evidenceIds: ["fomo-a"], economicKeys: ["economic-a"], evaluation: evaluation("broadcast"),
      payload: { kind: "radar_signal_evaluation", version: 1, publicSignal: signal, audit: {} }, publicSignal: signal,
    });

    expect(result).toEqual({ inserted: true, broadcastNumber: 1 });
    expect(repository.tokenEvaluationState("solana", "TokenA")?.action).toBe("broadcast");
    expect(repository.tokenAggregationState("solana", "TokenA")?.consumedEconomicKeys).toEqual(["economic-a"]);
    expect(repository.pendingSignalOutbox()).toEqual([expect.objectContaining({ tokenId: "solana:TokenA", broadcastSequence: 1, status: "pending", attemptCount: 0 })]);
    repository.close();
  });

  it("claims safely, blocks sequence two, and retains retry metadata", () => {
    const repository = openAddressRadarRepository(":memory:");
    seedEvidence(repository, "event-1"); seedEvidence(repository, "event-2");
    for (const sequence of [1, 2]) {
      const signal = publicSignal(sequence);
      repository.commitTokenBroadcast({ chain: "solana", tokenAddress: "TokenA", expectedPreviousBroadcastCount: sequence - 1, strategyVersion: "address-v1", score: 0.9, triggeredAt: sequence * 1_000, evidenceIds: [`event-${sequence}`], economicKeys: [`economic-${sequence}`], evaluation: evaluation(sequence === 1 ? "broadcast" : "rebroadcast"), payload: { kind: "radar_signal_evaluation", version: 1, publicSignal: signal, audit: {} }, publicSignal: signal });
    }
    const first = repository.claimSignalOutbox({ workerId: "worker-a", now: 3_000, leaseMs: 30_000 });
    expect(first?.broadcastSequence).toBe(1);
    expect(repository.claimSignalOutbox({ workerId: "worker-b", now: 3_000, leaseMs: 30_000 })).toBeNull();
    repository.failSignalOutbox({ outboxId: first!.outboxId, claimToken: first!.claimToken!, nextRetryAt: 4_000, error: "temporary" });
    expect(repository.pendingSignalOutbox()[0]).toMatchObject({ status: "pending", attemptCount: 1, nextRetryAt: 4_000, lastError: "temporary" });
    const retried = repository.claimSignalOutbox({ workerId: "worker-b", now: 4_000, leaseMs: 30_000 });
    repository.markSignalOutboxDelivered({ outboxId: retried!.outboxId, claimToken: retried!.claimToken!, deliveredAt: 4_001 });
    expect(repository.claimSignalOutbox({ workerId: "worker-b", now: 4_002, leaseMs: 30_000 })?.broadcastSequence).toBe(2);
    repository.close();
  });

  it("fences stale completion and failure after lease expiry and reclaim by the same worker", () => {
    const repository = openAddressRadarRepository(":memory:");
    seedEvidence(repository, "event-fenced");
    const signal = publicSignal(1);
    repository.commitTokenBroadcast({ chain: "solana", tokenAddress: "TokenA", expectedPreviousBroadcastCount: 0, strategyVersion: "address-v1", score: 0.9, triggeredAt: 1_000, evidenceIds: ["event-fenced"], economicKeys: ["economic-fenced"], evaluation: evaluation("broadcast"), payload: { kind: "radar_signal_evaluation", version: 1, publicSignal: signal, audit: {} }, publicSignal: signal });

    const stale = repository.claimSignalOutbox({ workerId: "same-worker", now: 2_000, leaseMs: 100 })!;
    const current = repository.claimSignalOutbox({ workerId: "same-worker", now: 2_101, leaseMs: 1_000 })!;
    expect(current.claimGeneration).toBe(stale.claimGeneration + 1);
    expect(current.claimToken).not.toBe(stale.claimToken);
    expect(current.leaseExpiresAt).toBe(3_101);
    expect(repository.markSignalOutboxDelivered({ outboxId: stale.outboxId, claimToken: stale.claimToken!, deliveredAt: 2_102 })).toBe(false);
    expect(repository.failSignalOutbox({ outboxId: stale.outboxId, claimToken: stale.claimToken!, nextRetryAt: 2_200, error: "stale" })).toBe(false);
    expect(repository.markSignalOutboxDelivered({ outboxId: current.outboxId, claimToken: current.claimToken!, deliveredAt: 2_103 })).toBe(true);
    repository.close();
  });

  it("rejects a late counterpart sharing a consumed economic key", () => {
    const repository = openAddressRadarRepository(":memory:");
    seedEvidence(repository, "fomo-a"); seedEvidence(repository, "onchain-a");
    const signal = publicSignal(1);
    repository.commitTokenBroadcast({ chain: "solana", tokenAddress: "TokenA", expectedPreviousBroadcastCount: 0, strategyVersion: "address-v1", score: 0.9, triggeredAt: 1_000, evidenceIds: ["fomo-a"], economicKeys: ["economic-a"], evaluation: evaluation("broadcast"), payload: { kind: "radar_signal_evaluation", version: 1, publicSignal: signal, audit: {} }, publicSignal: signal });
    expect(repository.commitTokenBroadcast({ chain: "solana", tokenAddress: "TokenA", expectedPreviousBroadcastCount: 1, strategyVersion: "address-v1", score: 0.9, triggeredAt: 2_000, evidenceIds: ["onchain-a"], economicKeys: ["economic-a"], evaluation: evaluation("rebroadcast"), payload: { kind: "radar_signal_evaluation", version: 1, publicSignal: publicSignal(2), audit: {} }, publicSignal: publicSignal(2) })).toEqual({ inserted: false, broadcastNumber: 1 });
    repository.close();
  });
});
