import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTraderAutomationStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

import { openMonitoringRegistry } from "../src/monitoring-registry.js";

const setup = () => {
  const path = join(mkdtempSync(join(tmpdir(), "monitoring-policy-")), "radar.sqlite");
  const database = openAddressRadarDatabase(path);
  migrateAddressRadarDatabase(database);
  const insertTrader = database.prepare(`
    INSERT INTO trader_entities(
      entity_id, lifecycle, manual, locked, created_at, updated_at
    ) VALUES (?, ?, 0, 0, 1, 1)
  `);
  const insertWallet = database.prepare(`
    INSERT INTO entity_wallet_identities(
      entity_id, chain_family, address, confidence, source,
      first_observed_at, last_observed_at
    ) VALUES (?, 'evm', ?, 'confirmed', 'test', 1, 1)
  `);
  insertTrader.run("trader-lightweight", "suspended");
  insertTrader.run("trader-realtime", "suspended");
  insertTrader.run("trader-off", "elite");
  insertWallet.run("trader-lightweight", "0x0000000000000000000000000000000000000001");
  insertWallet.run("trader-realtime", "0x0000000000000000000000000000000000000002");
  insertWallet.run("trader-off", "0x0000000000000000000000000000000000000003");
  const store = createTraderAutomationStore(database);
  const save = (traderId: string, monitoringPolicy: "realtime" | "lightweight" | "off") =>
    store.saveState({
      traderId,
      tier: "T1",
      coverageState: "current",
      monitoringPolicy,
      lastCoveredAt: 1,
      nextEvaluationAt: 2,
      strategyVersion: "test-v1",
      updatedAt: 1,
    });
  save("trader-lightweight", "lightweight");
  save("trader-realtime", "realtime");
  save("trader-off", "off");
  database.close();
  return path;
};

describe("monitoring registry policy", () => {
  it("loads a suspended trader wallet when policy is realtime", () => {
    const registry = openMonitoringRegistry(setup());
    expect(registry.wallets("evm")).toEqual([
      expect.objectContaining({ entityId: "trader-realtime" }),
    ]);
    registry.close();
  });

  it("does not load a qualified trader when policy is off", () => {
    const registry = openMonitoringRegistry(setup());
    expect(registry.wallets("evm").map((wallet) => wallet.entityId)).not.toContain("trader-off");
    registry.close();
  });
});
