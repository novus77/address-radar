import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";
import { openMonitoringRegistry } from "../src/monitoring-registry.js";

function fixture(run: (db: ReturnType<typeof openAddressRadarDatabase>, registry: ReturnType<typeof openMonitoringRegistry>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "fomo-targets-"));
  const path = join(directory, "radar.sqlite");
  const repository = openAddressRadarRepository(path);
  const db = openAddressRadarDatabase(path);
  const registry = openMonitoringRegistry(path);
  try {
    db.exec(`
      INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at) VALUES ('trader','probation',0,0,1,1);
      INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES ('account','alpha',1,1);
      INSERT INTO entity_accounts(entity_id,account_id,confidence,source,first_observed_at,last_observed_at) VALUES ('trader','account','confirmed','manual',1,1);
      INSERT INTO trader_profiles(entity_id,display_name,priority,notes,monitoring_enabled,fomo_monitoring_enabled,onchain_monitoring_enabled,created_at,updated_at) VALUES ('trader','Alpha','normal','',1,1,0,1,1);
    `);
    run(db, registry);
  } finally { registry.close(); db.close(); repository.close(); rmSync(directory,{recursive:true,force:true}); }
}

describe("FOMO monitoring targets", () => {
  it("rejects a second owner without replacing the confirmed account", () => {
    fixture((db, registry) => {
      db.exec("INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at) VALUES ('other','probation',0,0,1,1)");
      expect(() => db.exec("INSERT INTO entity_accounts(entity_id,account_id,confidence,source,first_observed_at,last_observed_at) VALUES ('other','account','high','history',1,1)"))
        .toThrow(/UNIQUE constraint/);
      expect(registry.fomoAccounts?.()).toEqual([{accountId:"account",handle:"alpha",entityId:"trader",lifecycle:"probation"}]);
    });
  });

  it("includes a confirmed admitted account without a wallet", () => {
    fixture((_db, registry) => {
      expect(registry.fomoAccounts?.()).toEqual([{accountId:"account",handle:"alpha",entityId:"trader",lifecycle:"probation"}]);
      expect(registry.wallets("solana")).toEqual([]);
    });
  });
  it.each([
    "UPDATE entity_accounts SET confidence='high'",
    "UPDATE trader_entities SET lifecycle='candidate'",
    "UPDATE trader_entities SET lifecycle='suspended'",
    "UPDATE trader_profiles SET monitoring_enabled=0",
    "UPDATE trader_profiles SET fomo_monitoring_enabled=0",
    "INSERT INTO trader_monitoring_policy(trader_id,policy,updated_at) VALUES ('trader','off',2)",
  ])("excludes targets violating ownership or monitoring: %s", (sql) => {
    fixture((db, registry) => { db.exec(sql); expect(registry.fomoAccounts?.()).toEqual([]); });
  });
});
