import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";
import { openMonitoringRegistry } from "../src/monitoring-registry.js";

describe("FOMO registry trust parity", () => {
  it.each([['high','high','fomolens_manual',true],['high','high','discovery',false],['high','confirmed','test',false],['confirmed','confirmed','test',true]] as const)
  ("preserves existing association %s and wallet %s from %s", (association, confidence, source, eligible) => {
    const directory = mkdtempSync(join(tmpdir(),"fomo-parity-"));
    const path = join(directory,"radar.sqlite");
    const repository = openAddressRadarRepository(path);
    const db = openAddressRadarDatabase(path);
    const registry = openMonitoringRegistry(path);
    try {
      db.exec(`
        INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at) VALUES ('trader','probation',0,0,1,1);
        INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES ('account','alpha',1,1);
      `);
      db.prepare("INSERT INTO entity_accounts(entity_id,account_id,confidence,source,first_observed_at,last_observed_at) VALUES ('trader','account',?,'fomo',1,1)").run(association);
      db.prepare("INSERT INTO wallet_identities(account_id,chain_family,address,confidence,source,first_observed_at,last_observed_at) VALUES ('account','solana','Wallet',?,?,1,1)").run(confidence,source);
      repository.updateTraderLifecycle("trader","probation",2);
      expect(repository.traderSignalProfile("trader")?.fomoMonitoringEnabled).toBe(eligible);
      expect(registry.fomoAccounts?.()).toHaveLength(eligible ? 1 : 0);
      expect(db.prepare("SELECT confidence FROM entity_accounts").get()).toEqual({confidence:association});
    } finally { registry.close(); db.close(); repository.close(); rmSync(directory,{recursive:true,force:true}); }
  });
});
