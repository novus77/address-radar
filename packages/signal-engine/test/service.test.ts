import { afterEach, describe, expect, it } from "vitest";

import { openAddressRadarRepository, type AddressRadarRepository } from "@address-radar/database";
import type { AddressSignalEvidence } from "@address-radar/aggregation";
import { createTokenSignalService } from "../src/index.js";

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
      repository.insertTraderEvent({ eventId, accountId, entityId, chain: "solana", tokenAddress: "TokenA", side: "buy", amountUsd: 1_000, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: 60_000, occurredAt: 1_000, collectedAt: 1_000, source: "fomo_stream" });
    }
    const service = createTokenSignalService({ repository, threshold: 0.7, strategyVersion: "address-v1", now: () => 3_000 });

    const first = service.evaluate("solana", "TokenA", [evidence("a", "entity-0"), evidence("b", "entity-1")]);
    const second = service.evaluate("solana", "TokenA", [evidence("c", "entity-2"), evidence("d", "entity-3")]);

    expect(first.candidate).toMatchObject({ signalId: "solana:TokenA", broadcastSequence: 1, action: "new" });
    expect(second.candidate).toMatchObject({ signalId: "solana:TokenA", broadcastSequence: 2, action: "update" });
    expect(repository.broadcasts("solana:TokenA")).toHaveLength(2);
  });
});
