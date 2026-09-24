import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { initializeAddressRadarSchema, migrateAddressRadarDatabase, openAddressRadarRepository } from "../src/index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("legacy duplicate account mappings are deterministically quarantined before uniqueness is enforced", () => {
  const directory = mkdtempSync(join(tmpdir(), "entity-account-migration-"));
  directories.push(directory);
  const path = join(directory, "radar.sqlite");
  const legacy = new DatabaseSync(path);
  initializeAddressRadarSchema(legacy);
  legacy.exec(`
    INSERT INTO fomo_accounts VALUES ('account', 'handle', 1, 10);
    INSERT INTO trader_entities VALUES ('entity-old', 'candidate', 0, 0, 1, 1);
    INSERT INTO trader_entities VALUES ('entity-confirmed', 'candidate', 0, 0, 1, 1);
    INSERT INTO entity_accounts VALUES ('entity-old', 'account', 'high', 'legacy', 1, 10);
    INSERT INTO entity_accounts VALUES ('entity-confirmed', 'account', 'confirmed', 'legacy', 5, 10);
  `);
  migrateAddressRadarDatabase(legacy);
  migrateAddressRadarDatabase(legacy);
  expect(legacy.prepare("SELECT entity_id AS entityId FROM entity_accounts WHERE account_id = 'account'").all()).toEqual([{ entityId: "entity-confirmed" }]);
  expect(legacy.prepare("SELECT canonical_entity_id AS canonicalEntityId, removed_entity_id AS removedEntityId FROM entity_account_mapping_conflicts").all()).toEqual([{ canonicalEntityId: "entity-confirmed", removedEntityId: "entity-old" }]);
  expect(() => legacy.prepare("INSERT INTO entity_accounts VALUES ('entity-old', 'account', 'confirmed', 'test', 20, 20)").run()).toThrow();
  legacy.close();

  const repository = openAddressRadarRepository(path);
  expect(() => repository.linkAccountToEntity({ entityId: "entity-old", accountId: "account", confidence: "confirmed", source: "test", observedAt: 20 })).toThrow(/already linked|conflict/i);
  repository.close();
});
