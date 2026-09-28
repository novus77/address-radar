import { afterEach, describe, expect, it } from "vitest";

import {
  createSourceLedgerStore,
  initializeSourceLedgerSchema,
  openAddressRadarDatabase,
  type AddressRadarRepository,
} from "@address-radar/database";
import { createScannerRuntime } from "../src/runtime.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];

function setup() {
  const database = openAddressRadarDatabase(":memory:");
  databases.push(database);
  initializeSourceLedgerSchema(database);
  const ledger = createSourceLedgerStore(database);
  const repository = {
    latestRuntimeQualitySnapshot: () => null,
    entityForAccount: () => null,
    latestTraderAbility: () => null,
    insertTraderEvent: () => ({ inserted: true }),
    claimEventProjection: () => "claimed",
    completeEventProjection: () => true,
    failEventProjection: () => true,
    saveRuntimeQualitySnapshot: () => undefined,
  } as unknown as AddressRadarRepository;
  return { ledger, repository };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("scanner token progression", () => {
  it("persists raw state and queues independent Fomo and market enrichment", async () => {
    const { ledger, repository } = setup();
    const runtime = createScannerRuntime({
      repository,
      sourceLedger: ledger,
      tokenStateStore: ledger,
      collectors: [{ async collect() { return [{ event: {
        eventId: "chain-1", accountId: "account-1", entityId: "entity-1", chain: "base",
        tokenAddress: "0xabc", side: "buy", amountUsd: 25, priceUsd: 0.1, marketCapUsd: null,
        tokenAgeMs: null, occurredAt: 2_000, collectedAt: 2_100, source: "onchain_wallet",
      } }]; } }],
      marketProvider: { async lookup() { throw new Error("market unavailable"); } },
      clock: { now: () => 3_000 },
      config: { signalThreshold: 0.7, minimumAggregateBuyUsd: 100, strategyVersion: "test", allowedChains: ["base"], excludedTokenIds: [], minimumPurchaseUsd: 100 } as never,
    });

    await runtime.runOnce();
    expect(ledger.tokenObservation("base:0xabc")).toMatchObject({ identityStatus: "resolved", marketStatus: "pending", fomoStatus: "pending", quarantined: false });
    expect(ledger.recoveryJob("recovery:fomo_token_history:base:0xabc")?.status).toBe("pending");
    expect(ledger.recoveryJob("recovery:market_enrichment:base:0xabc")?.status).toBe("pending");
  });

  it("records market and milestone facts without overwriting Fomo confirmation", async () => {
    const { ledger, repository } = setup();
    const runtime = createScannerRuntime({
      repository,
      sourceLedger: ledger,
      tokenStateStore: ledger,
      collectors: [{ async collect() { return [{ event: {
        eventId: "fomo-1", accountId: "account-1", entityId: "entity-1", chain: "base",
        tokenAddress: "0xabc", side: "buy", amountUsd: 25, priceUsd: 0.1, marketCapUsd: 500_000,
        tokenAgeMs: null, occurredAt: 2_000, collectedAt: 2_100, source: "fomo_stream",
      } }]; } }],
      marketProvider: { async lookup() { return { chain: "base", tokenAddress: "0xabc", symbol: "ABC", name: "Alpha", imageUrl: null, priceUsd: 0.2, marketCapUsd: 600_000, liquidityUsd: 50_000, createdAt: 1_000, launchedAt: 1_500, observedAt: new Date(3_000).toISOString() }; } },
      clock: { now: () => 3_000 },
      config: { signalThreshold: 0.7, minimumAggregateBuyUsd: 100, strategyVersion: "test", allowedChains: ["base"], excludedTokenIds: [], minimumPurchaseUsd: 100 } as never,
    });

    await runtime.runOnce();
    expect(ledger.tokenObservation("base:0xabc")).toMatchObject({ fomoStatus: "confirmed", marketStatus: "resolved", milestoneStatus: "observed", milestoneObservedAt: 2_000, marketCapUsd: 600_000 });
    expect(ledger.tokenMarketSnapshots("base:0xabc")).toHaveLength(1);
  });

  it("quarantines unsupported chains while retaining the raw token", async () => {
    const { ledger, repository } = setup();
    const runtime = createScannerRuntime({
      repository,
      sourceLedger: ledger,
      tokenStateStore: ledger,
      collectors: [{ async collect() { return [{ event: {
        eventId: "unsupported-1", accountId: "account-1", entityId: "entity-1", chain: "monad",
        tokenAddress: "0xabc", side: "buy", amountUsd: 25, priceUsd: null, marketCapUsd: null,
        tokenAgeMs: null, occurredAt: 2_000, collectedAt: 2_100, source: "onchain_wallet",
      } as never }]; } }],
      clock: { now: () => 3_000 },
      config: { signalThreshold: 0.7, minimumAggregateBuyUsd: 100, strategyVersion: "test", allowedChains: ["base"], excludedTokenIds: [], minimumPurchaseUsd: 100 } as never,
    });

    await runtime.runOnce();
    expect(ledger.tokenObservation("monad:0xabc")).toMatchObject({ quarantined: true, quarantineReason: "unsupported_chain" });
  });
});
