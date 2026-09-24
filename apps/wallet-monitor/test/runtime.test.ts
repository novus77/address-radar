import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openAddressRadarRepository } from "@address-radar/database";
import { openMonitoringRegistry } from "@address-radar/identity";
import { createWalletMonitorRuntime, openWalletMonitorStore } from "../src/index.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "address-radar-monitor-"));
  const databasePath = join(directory, "radar.sqlite");
  const repository = openAddressRadarRepository(databasePath);
  repository.upsertFomoAccount({ accountId: "account-1", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId: "entity-1", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId: "account-1", entityId: "entity-1", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.attachWallet({ accountId: "account-1", chainFamily: "evm", address: "0x1111111111111111111111111111111111111111", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.close();
  return databasePath;
}

describe("wallet monitor runtime", () => {
  it("reloads the persisted registry by version and isolates provider degradation", async () => {
    const databasePath = await fixture();
    const registry = openMonitoringRegistry(databasePath);
    const store = openWalletMonitorStore(databasePath);
    const seen: string[][] = [];
    const runtime = createWalletMonitorRuntime({
      registry,
      store,
      collectors: [
        { name: "evm", chainFamily: "evm", collect: async ({ wallets }) => {
          seen.push(wallets.map(wallet => wallet.address));
          return { events: [{ eventId: "event-1", chain: "BASE", walletAddress: wallets[0]!.address.toUpperCase(), tokenAddress: "0xABC", side: "buy", amountUsd: 12, priceUsd: 2, marketCapUsd: 100_000, occurredAt: 10, cursor: "101", sourceReference: "rpc:block:101" }] };
        } },
        { name: "solana", chainFamily: "solana", collect: async () => { throw new Error("solana unavailable"); } },
      ],
      consumer: "wallet-monitor",
      now: () => 20,
    });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ accepted: 1, providerFailures: 1 });
    const repository = openAddressRadarRepository(databasePath);
    repository.upsertFomoAccount({ accountId: "account-2", handle: "beta", firstSeenAt: 2, lastSeenAt: 2 });
    repository.upsertTraderEntity({ entityId: "entity-2", lifecycle: "candidate", manual: false, locked: false, createdAt: 2, updatedAt: 2 });
    repository.linkAccountToEntity({ accountId: "account-2", entityId: "entity-2", confidence: "confirmed", source: "test", observedAt: 2 });
    repository.attachWallet({ accountId: "account-2", chainFamily: "evm", address: "0x2222222222222222222222222222222222222222", confidence: "confirmed", source: "test", observedAt: 2 });
    repository.close();
    const registryDatabase = new DatabaseSync(databasePath);
    registryDatabase.prepare("UPDATE monitoring_registry_state SET version = version + 1, updated_at = ? WHERE singleton = 1").run(2);
    registryDatabase.close();
    await runtime.pollOnce();

    expect(seen.at(-1)).toHaveLength(2);
    expect(store.observations()).toEqual([expect.objectContaining({ eventId: "event-1", chain: "base", tokenAddress: "0xabc", source: "evm", sourceReference: "rpc:block:101" })]);
    const database = new DatabaseSync(databasePath);
    expect(database.prepare("SELECT applied_version AS version FROM monitoring_registry_consumers WHERE consumer = ?").get("wallet-monitor")).toEqual({ version: registry.version() });
    database.close();
    store.close();
    registry.close();
  });

  it("recovers cursors after restart and deduplicates replayed observations", async () => {
    const databasePath = await fixture();
    const run = async () => {
      const registry = openMonitoringRegistry(databasePath);
      const store = openWalletMonitorStore(databasePath);
      const cursors: Array<string | null> = [];
      const runtime = createWalletMonitorRuntime({ registry, store, consumer: "wallet-monitor", now: () => 20, collectors: [{
        name: "evm", chainFamily: "evm", collect: async ({ cursor }) => {
          cursors.push(cursor);
          return { events: [{ eventId: "same-event", chain: "base", walletAddress: "0x1111111111111111111111111111111111111111", tokenAddress: "0xABC", side: "buy", amountUsd: null, priceUsd: null, marketCapUsd: null, occurredAt: 10, cursor: "102", sourceReference: "rpc:block:102" }] };
        },
      }] });
      const result = await runtime.pollOnce();
      const count = store.observations().length;
      store.close();
      registry.close();
      return { result, count, cursors };
    };

    expect(await run()).toMatchObject({ result: { accepted: 1 }, count: 1, cursors: [null] });
    expect(await run()).toMatchObject({ result: { accepted: 0 }, count: 1, cursors: ["102"] });
  });
});
