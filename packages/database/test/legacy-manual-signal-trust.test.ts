import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openAddressRadarDatabase } from "../src/connection.js";
import { openAddressRadarRepository } from "../src/repository.js";

function withLegacyIdentity(run: (fixture: {
  database: ReturnType<typeof openAddressRadarDatabase>;
  repository: ReturnType<typeof openAddressRadarRepository>;
}) => void) {
  const directory = mkdtempSync(join(tmpdir(), "legacy-manual-trust-"));
  const path = join(directory, "radar.sqlite");
  const repository = openAddressRadarRepository(path);
  const database = openAddressRadarDatabase(path);
  try {
    database.exec(`
      INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
      VALUES ('legacy-trader', 'probation', 0, 0, 1, 1);
      INSERT INTO entity_wallet_identities(entity_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
      VALUES ('legacy-trader', 'solana', 'LegacyCaseSensitiveWallet', 'high', 'legacy:fomolens_manual', 1, 1);
    `);
    run({ database, repository });
  } finally {
    database.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function attachLegacyFomo(database: ReturnType<typeof openAddressRadarDatabase>) {
  database.exec(`
    INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
    VALUES ('fomo-account', 'legacy-handle', 1, 1);
    INSERT INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at)
    VALUES ('legacy-trader', 'fomo-account', 'high', 'fomo', 1, 1);
    INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
    VALUES ('fomo-account', 'solana', 'LegacyCaseSensitiveWallet', 'high', 'fomolens_manual', 1, 1);
  `);
}

describe("legacy manual signal trust", () => {
  it("enables the approved manual mapping without promoting confidence or creating FOMO identity", () => {
    withLegacyIdentity(({ database, repository }) => {
      repository.updateTraderLifecycle("legacy-trader", "probation", 2);
      const profile = repository.traderSignalProfile("legacy-trader");
      expect(profile).toMatchObject({ mapped: true, monitoringEnabled: true, onchainMonitoringEnabled: true, fomoMonitoringEnabled: false });
      expect(database.prepare("SELECT confidence FROM entity_wallet_identities").get()).toEqual({ confidence: "high" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM entity_accounts").get()).toEqual({ count: 0 });
    });
  });

  it("enables an existing explicit FOMO link backed by historical manual wallet mapping", () => {
    withLegacyIdentity(({ database, repository }) => {
      attachLegacyFomo(database);
      repository.updateTraderLifecycle("legacy-trader", "probation", 2);
      expect(repository.traderSignalProfile("legacy-trader")).toMatchObject({ mapped: true, monitoringEnabled: true, onchainMonitoringEnabled: true, fomoMonitoringEnabled: true });
      expect(database.prepare("SELECT confidence FROM entity_accounts").get()).toEqual({ confidence: "high" });
      expect(database.prepare("SELECT confidence FROM wallet_identities").get()).toEqual({ confidence: "high" });
    });
  });

  it.each([['high', 'discovery'], ['medium', 'legacy:fomolens_manual'], ['low', 'legacy:fomolens_manual']])("does not trust %s identities from %s", (confidence, source) => {
    withLegacyIdentity(({ database, repository }) => {
      database.prepare("UPDATE entity_wallet_identities SET confidence=?, source=?").run(confidence, source);
      repository.updateTraderLifecycle("legacy-trader", "probation", 2);
      expect(repository.traderSignalProfile("legacy-trader")).toMatchObject({ mapped: false, monitoringEnabled: false, onchainMonitoringEnabled: false, fomoMonitoringEnabled: false });
    });
  });

  it("does not enable an ordinary candidate before admission", () => {
    withLegacyIdentity(({ repository }) => {
      repository.updateTraderLifecycle("legacy-trader", "candidate", 2);
      expect(repository.traderSignalProfile("legacy-trader")).toMatchObject({ monitoringEnabled: false });
    });
  });

  it.each([0, 1])("keeps suspended entities disabled even with manual=%i", (manual) => {
    withLegacyIdentity(({ database, repository }) => {
      database.prepare("UPDATE trader_entities SET manual=?").run(manual);
      repository.updateTraderLifecycle("legacy-trader", "suspended", 2);
      expect(repository.traderSignalProfile("legacy-trader")).toMatchObject({ monitoringEnabled: false, onchainMonitoringEnabled: false, fomoMonitoringEnabled: false });
      expect(database.prepare("SELECT lifecycle FROM trader_entities").get()).toEqual({ lifecycle: "suspended" });
    });
  });

  it("preserves an explicit monitoring-off policy", () => {
    withLegacyIdentity(({ database, repository }) => {
      database.exec("INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at) VALUES ('legacy-trader', 'off', 1)");
      repository.updateTraderLifecycle("legacy-trader", "probation", 2);
      expect(repository.traderSignalProfile("legacy-trader")).toMatchObject({ monitoringEnabled: false, onchainMonitoringEnabled: false, fomoMonitoringEnabled: false });
    });
  });
});
