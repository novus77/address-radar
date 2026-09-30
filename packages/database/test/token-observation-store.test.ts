import { afterEach, describe, expect, it } from "vitest";

import {
  createSourceLedgerStore,
  initializeSourceLedgerSchema,
  openAddressRadarDatabase,
} from "@address-radar/database";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];

function setup() {
  const database = openAddressRadarDatabase(":memory:");
  databases.push(database);
  initializeSourceLedgerSchema(database);
  return createSourceLedgerStore(database);
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("token observation state", () => {
  it("updates identity, market, Fomo, milestone, and evidence dimensions independently", () => {
    const store = setup();
    store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_000 });
    store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_100, identityStatus: "resolved", symbol: "ABC" });
    store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_200, marketStatus: "resolved", marketCapUsd: 500_000 });
    store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_300, fomoStatus: "confirmed" });
    store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_400, milestoneStatus: "observed", milestoneObservedAt: 1_400 });
    store.saveTokenObservation({ tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc", observedAt: 1_500, evidenceStatus: "qualified" });

    expect(store.tokenObservation("base:0xabc")).toMatchObject({
      firstObservedAt: 1_000,
      lastObservedAt: 1_500,
      identityStatus: "resolved",
      marketStatus: "resolved",
      fomoStatus: "confirmed",
      milestoneStatus: "observed",
      milestoneObservedAt: 1_400,
      evidenceStatus: "qualified",
      symbol: "ABC",
      marketCapUsd: 500_000,
      quarantined: false,
    });
  });

  it("keeps unsupported-chain tokens as quarantined observations", () => {
    const store = setup();
    store.saveTokenObservation({
      tokenId: "monad:0xabc",
      chain: "monad",
      tokenAddress: "0xabc",
      observedAt: 2_000,
      quarantined: true,
      quarantineReason: "unsupported_chain",
    });
    expect(store.tokenObservation("monad:0xabc")).toMatchObject({ quarantined: true, quarantineReason: "unsupported_chain" });
  });

  it("stores append-only market snapshots separately from token progression", () => {
    const store = setup();
    store.saveTokenMarketSnapshot({
      snapshotId: "snapshot-1",
      tokenId: "base:0xabc",
      source: "dexscreener",
      observedAt: 3_000,
      priceUsd: 0.1,
      marketCapUsd: 100_000,
      liquidityUsd: 20_000,
      payload: { pair: "0xpair" },
    });
    expect(store.tokenMarketSnapshots("base:0xabc")).toEqual([
      expect.objectContaining({ snapshotId: "snapshot-1", marketCapUsd: 100_000, payload: { pair: "0xpair" } }),
    ]);
  });
});
