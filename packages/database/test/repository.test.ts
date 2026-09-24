import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  migrateAddressRadarDatabase,
  openAddressRadarRepository,
  type AddressRadarRepository,
} from "@address-radar/database";

describe("address radar database compatibility", () => {
  let repository: AddressRadarRepository | undefined;

  afterEach(() => {
    repository?.close();
    repository = undefined;
  });

  it("opens a pre-extraction database without renaming or losing production data", () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "address-radar-db-")), "address.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE fomo_accounts (
        account_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
      VALUES ('legacy-account', 'legacytrader', 10, 20);
    `);
    legacy.close();

    repository = openAddressRadarRepository(databasePath);

    expect(repository.account("legacy-account")).toMatchObject({
      accountId: "legacy-account",
      handle: "legacytrader",
      firstSeenAt: 10,
      lastSeenAt: 20,
    });
    repository.close();
    repository = undefined;

    const inspected = new DatabaseSync(databasePath);
    migrateAddressRadarDatabase(inspected);
    migrateAddressRadarDatabase(inspected);
    const columns = inspected.prepare("PRAGMA table_info(fomo_accounts)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "account_id",
      "handle",
      "first_seen_at",
      "last_seen_at",
    ]);
    expect(inspected.prepare("SELECT handle FROM fomo_accounts WHERE account_id = ?").get("legacy-account"))
      .toEqual({ handle: "legacytrader" });
    inspected.close();
  });

  it("preserves Solana case while canonicalizing EVM addresses", () => {
    repository = openAddressRadarRepository(":memory:");
    repository.upsertFomoAccount({ accountId: "account-1", handle: "Alpha", firstSeenAt: 1, lastSeenAt: 1 });
    repository.attachWallet({ accountId: "account-1", chainFamily: "solana", address: "AbCdEf123456789ABCDEFGHJKLMNPQRSTUV", confidence: "high", source: "test", observedAt: 2 });
    repository.attachWallet({ accountId: "account-1", chainFamily: "evm", address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", confidence: "high", source: "test", observedAt: 2 });

    expect(repository.account("account-1")?.wallets.map((wallet) => wallet.address)).toEqual([
      "AbCdEf123456789ABCDEFGHJKLMNPQRSTUV",
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    ]);
  });
});
