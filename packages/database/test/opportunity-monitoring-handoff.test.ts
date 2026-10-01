import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openAddressRadarDatabase } from "../src/connection.js";
import { openAddressRadarRepository } from "../src/repository.js";

describe("opportunity monitoring handoff", () => {
  it("enables a resolved observing wallet without an ability snapshot or fabricated FOMO identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "opportunity-handoff-"));
    const path = join(directory, "radar.sqlite");
    const repository = openAddressRadarRepository(path);
    const database = openAddressRadarDatabase(path);
    try {
      database.exec(`
        INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
        VALUES ('wallet-trader', 'candidate', 0, 0, 1, 1);
        INSERT INTO entity_wallet_identities(entity_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
        VALUES ('wallet-trader', 'solana', 'CaseSensitiveWallet', 'confirmed', 'test', 1, 1);
      `);
      repository.updateTraderLifecycle("wallet-trader", "probation", 2);
      expect(database.prepare(`SELECT monitoring_enabled AS enabled,
        onchain_monitoring_enabled AS onchain, fomo_monitoring_enabled AS fomo
        FROM trader_profiles WHERE entity_id = 'wallet-trader'`).get())
        .toEqual({ enabled: 1, onchain: 1, fomo: 0 });
      database.exec("INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at) VALUES ('wallet-trader', 'off', 3)");
      repository.updateTraderLifecycle("wallet-trader", "active", 4);
      expect(database.prepare(`SELECT monitoring_enabled AS enabled,
        onchain_monitoring_enabled AS onchain, fomo_monitoring_enabled AS fomo
        FROM trader_profiles WHERE entity_id = 'wallet-trader'`).get())
        .toEqual({ enabled: 0, onchain: 0, fomo: 0 });
    } finally {
      database.close();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
