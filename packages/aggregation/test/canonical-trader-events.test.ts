import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { applyWalletBundleGroups, detectTemporalBundlePairs } from "../src/index.js";

describe("canonical trader events", () => {
  it("merges matching Fomo and on-chain observations into one economic event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "canonical-trader-event-"));
    const databasePath = join(directory, "address.sqlite");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-1", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-1", lifecycle: "probation", manual: true, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ entityId: "entity-1", accountId: "account-1", confidence: "confirmed", source: "test", observedAt: 1 });
    const common = { accountId: "account-1", entityId: "entity-1", chain: "bsc", tokenAddress: "0x1111111111111111111111111111111111111111", side: "buy" as const, priceUsd: 0.01, marketCapUsd: 100_000, tokenAgeMs: 1_000 };
    repository.insertTraderEvent({ ...common, eventId: "fomo-1", amountUsd: 1_000, occurredAt: 10_000, collectedAt: 10_100, source: "fomo_stream" });
    repository.insertTraderEvent({ ...common, eventId: "chain-1", amountUsd: 1_030, occurredAt: 20_000, collectedAt: 20_100, source: "onchain_wallet" });
    repository.close();

    const database = new DatabaseSync(databasePath);
    const canonical = database.prepare("SELECT source_status AS sourceStatus FROM canonical_trader_events").all();
    const observations = database.prepare("SELECT COUNT(*) AS count FROM canonical_trader_event_observations").get() as { count: number };
    database.close();

    expect(canonical).toEqual([{ sourceStatus: "FOMO_AND_ONCHAIN" }]);
    expect(observations.count).toBe(2);
  });
});

describe("wallet bundle evidence", () => {
  const evidence = (entityId: string, occurredAt: number) => ({ eventId: `${entityId}-${occurredAt}`, entityId, contribution: 0.8, occurredAt, side: "buy" as const, amountUsd: 1_000 });

  it("detects temporal pairs and assigns one independence key", () => {
    const events = [evidence("a", 1_000), evidence("b", 6_000), evidence("c", 20_000)];
    const pairs = detectTemporalBundlePairs(events);
    const grouped = applyWalletBundleGroups({ evidence: events, temporalPairs: pairs });
    expect(pairs).toEqual([expect.objectContaining({ pairKey: "a::b", deltaMs: 5_000 })]);
    expect(grouped.slice(0, 2)).toEqual([expect.objectContaining({ independenceKey: "bundle:a+b", bundleRisk: "strong" }), expect.objectContaining({ independenceKey: "bundle:a+b", bundleRisk: "strong" })]);
    expect(grouped[2]).not.toHaveProperty("independenceKey");
  });

  it("confirms a recurring pair only after two distinct tokens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-bundle-"));
    const repository = openAddressRadarRepository(join(directory, "address.sqlite"));
    const pair = detectTemporalBundlePairs([evidence("a", 1_000), evidence("b", 2_000)]);
    repository.recordWalletBundlePairs?.("solana", "TokenA", pair);
    expect(repository.walletBundleRelations?.(["a", "b"])).toEqual([expect.objectContaining({ distinctTokenCount: 1, recurring: false })]);
    repository.recordWalletBundlePairs?.("solana", "TokenB", pair);
    expect(repository.walletBundleRelations?.(["a", "b"])).toEqual([expect.objectContaining({ distinctTokenCount: 2, recurring: true })]);
    repository.close();
  });
});
