import { afterEach, describe, expect, it } from "vitest";

import { openAddressRadarRepository, type AddressRadarRepository } from "@address-radar/database";
import type { AddressSignalEvidence } from "@address-radar/aggregation";
import { createTokenSignalService, replayRadarSignalV1 } from "../src/index.js";

const evidence = (eventId: string, entityId: string): AddressSignalEvidence => ({
  eventId,
  entityId,
  contribution: 0.8,
  occurredAt: 1_000,
  source: "fomo",
  side: "buy",
  amountUsd: 1_000,
  lifecycleStage: "launched_0_2h",
  traderTags: ["HIGH_MULTIPLE"],
});

describe("token signal service", () => {
  let repository: AddressRadarRepository | undefined;
  afterEach(() => { repository?.close(); repository = undefined; });

  it("persists one deterministic signal identity and increments its broadcast sequence", () => {
    repository = openAddressRadarRepository(":memory:");
    for (const [index, eventId] of ["a", "b", "c", "d"].entries()) {
      const accountId = `account-${index}`;
      const entityId = `entity-${index}`;
      repository.upsertFomoAccount({ accountId, handle: `trader-${index}`, firstSeenAt: 1, lastSeenAt: 1 });
      repository.upsertTraderEntity({ entityId, lifecycle: "elite", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      repository.linkAccountToEntity({ accountId, entityId, confidence: "confirmed", source: "test", observedAt: 1 });
      repository.upsertTraderSignalProfile({ entityId, monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: true, updatedAt: 1 });
      repository.insertTraderEvent({ eventId, accountId, entityId, chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 1_000, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: 60_000, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    }
    const service = createTokenSignalService({ repository, threshold: 0.7, strategyVersion: "address-v1", now: () => 3_000 });

    const first = service.evaluate("solana", "TokenA", [evidence("a", "entity-0"), evidence("b", "entity-1")], {
      symbol: "TOK", name: "Token A", imageUrl: null, marketCapUsd: 100_000, priceUsd: 0.01,
    });
    const second = service.evaluate("solana", "TokenA", [evidence("c", "entity-2"), evidence("d", "entity-3")]);

    expect(first.candidate).toMatchObject({ signalId: "solana:TokenA", broadcastSequence: 1 });
    expect(second.candidate).toMatchObject({ signalId: "solana:TokenA", broadcastSequence: 2 });
    expect(repository.broadcasts("solana:TokenA")).toHaveLength(2);
    expect(replayRadarSignalV1(repository.broadcasts("solana:TokenA")[0]?.payload)).toEqual(first.candidate);
    expect(first.candidate).toMatchObject({
      schemaVersion: "1", signalId: "solana:TokenA", idempotencyKey: "solana:TokenA:broadcast:1",
      token: { chain: "solana", contractAddress: "TokenA", symbol: "TOK", name: "Token A", imageUrl: null },
      marketCapUsd: 100_000, priceUsd: 0.01,
      triggeredAt: new Date(3_000).toISOString(), expiresAt: new Date(303_000).toISOString(),
      display: { reasonCodes: ["concurrent_qualified_entries"] },
    });
    expect(Object.keys(first.candidate!)).toEqual([
      "schemaVersion", "signalId", "idempotencyKey", "token", "category", "broadcastSequence",
      "score", "confidence", "marketCapUsd", "priceUsd", "triggeredAt", "expiresAt", "display",
    ]);
    expect(Object.keys(first.candidate!.token)).toEqual(["chain", "contractAddress", "symbol", "name", "imageUrl"]);
    expect(Object.keys(first.candidate!.display)).toEqual(["title", "summary", "reasonCodes"]);
  });

  it("rejects corrupted or public-contract-polluted replay payloads", () => {
    expect(() => replayRadarSignalV1({ publicSignal: { schemaVersion: "1" }, audit: {} })).toThrow(/corrupt/i);
    expect(() => replayRadarSignalV1({
      publicSignal: {
        schemaVersion: "1", signalId: "id", idempotencyKey: "key",
        token: { chain: "solana", contractAddress: "Token", symbol: null, name: null, imageUrl: null },
        category: "new_token_discovery", broadcastSequence: 1, score: 0.9, confidence: 0.9,
        marketCapUsd: null, priceUsd: null, triggeredAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(),
        display: { title: "Title", summary: "Summary", reasonCodes: [] }, entityIds: ["internal"],
      },
      audit: {},
    })).toThrow(/corrupt/i);
  });

  it("enforces mapped monitored lifecycle eligibility and degraded discount", () => {
    repository = openAddressRadarRepository(":memory:");
    const setup = (entityId: string, lifecycle: "candidate" | "probation" | "active" | "elite" | "degraded" | "suspended", mapped: boolean, confidence: "high" | "confirmed" = "confirmed") => {
      const accountId = `account-${entityId}`;
      repository!.upsertFomoAccount({ accountId, handle: accountId, firstSeenAt: 1, lastSeenAt: 1 });
      repository!.upsertTraderEntity({ entityId, lifecycle, manual: false, locked: false, createdAt: 1, updatedAt: 1 });
      if (mapped) repository!.linkAccountToEntity({ accountId, entityId, confidence, source: "test", observedAt: 1 });
      repository!.upsertTraderSignalProfile({ entityId, monitoringEnabled: true, fomoMonitoringEnabled: true, onchainMonitoringEnabled: true, updatedAt: 1 });
      repository!.insertTraderEvent({ eventId: entityId, accountId, entityId, chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 1_000, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: 60_000, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    };
    setup("active", "active", true); setup("degraded", "degraded", true); setup("candidate", "candidate", true);
    setup("probation", "probation", true); setup("suspended", "suspended", true); setup("unmapped", "elite", false);
    setup("high-confidence", "elite", true, "high");
    const service = createTokenSignalService({ repository, threshold: 0.7, strategyVersion: "address-v1", now: () => 3_000 });
    const result = service.evaluate("solana", "TokenA", [
      evidence("active", "active"), evidence("degraded", "degraded"), evidence("candidate", "candidate"),
      evidence("probation", "probation"), evidence("suspended", "suspended"), evidence("unmapped", "unmapped"), evidence("high-confidence", "high-confidence"),
    ]);
    expect(result.decision.participantCount).toBe(2);
    expect(result.decision.score).toBeCloseTo(0.912);
    expect(result.candidate).not.toHaveProperty("evidenceSummary");
  });
});
