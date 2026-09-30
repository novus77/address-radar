import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { openAddressRadarRepository } from "@address-radar/database";

import { openWalletMonitorStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("wallet observation projection", () => {
  it("projects persisted observations into the unified trader event ledger exactly once", () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-wallet-projection-"));
    directories.push(directory);
    const databasePath = join(directory, "radar.db");
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-1", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.upsertTraderEntity({ entityId: "entity-1", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
    repository.linkAccountToEntity({ accountId: "account-1", entityId: "entity-1", confidence: "confirmed", source: "test", observedAt: 1 });
    repository.close();
    const store = openWalletMonitorStore(databasePath);
    const observation = {
      source: "solana:mainnet",
      eventId: "signature:1",
      chainFamily: "solana" as const,
      chain: "solana",
      walletAddress: "Wallet111111111111111111111111111111111",
      tokenAddress: "Token1111111111111111111111111111111111",
      accountId: "account-1",
      entityId: "entity-1",
      side: "buy" as const,
      amountUsd: 250,
      priceUsd: 0.01,
      marketCapUsd: 100_000,
      occurredAt: 1_000,
      collectedAt: 1_100,
      sourceReference: "signature:1",
    };

    store.persist("solana:mainnet", "partition-1", [observation], "checkpoint-1", 1_100);
    store.persist("solana:mainnet", "partition-1", [observation], "checkpoint-2", 1_200);
    store.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM source_observations").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM trader_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_trader_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT projected_at AS projectedAt FROM wallet_monitor_observations").get()).toEqual({ projectedAt: 1_100 });
    database.close();
  });
});
