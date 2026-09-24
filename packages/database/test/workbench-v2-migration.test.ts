import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrateAddressRadarDatabase } from "@address-radar/database";

describe("workbench v2 migration", () => {
  it("creates normalized workbench tables and records the schema version idempotently", () => {
    const database = new DatabaseSync(":memory:");

    migrateAddressRadarDatabase(database);
    migrateAddressRadarDatabase(database);

    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "workbench_schema_versions",
      "trader_sources",
      "trader_abilities",
      "trader_lifecycle_audit",
      "candidate_evidence_v2",
      "sample_diagnostics",
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workbench_schema_versions WHERE version = 2").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("maps legacy source and ability tags without deleting the original tags", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    database.prepare(`
      INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
      VALUES ('trader-1', 'candidate', 1, 0, 10, 10)
    `).run();
    database.prepare(`
      INSERT INTO trader_tags(entity_id, category, tag, created_at)
      VALUES ('trader-1', 'source', 'source.manual', 10),
             ('trader-1', 'ability', 'ability.500k_10x', 11)
    `).run();

    migrateAddressRadarDatabase(database);

    expect(database.prepare("SELECT source_key FROM trader_sources WHERE entity_id = 'trader-1'").all())
      .toEqual([{ source_key: "manual" }]);
    expect(database.prepare("SELECT ability_key FROM trader_abilities WHERE entity_id = 'trader-1'").all())
      .toEqual([{ ability_key: "early_multiplier" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM trader_tags WHERE entity_id = 'trader-1'").get())
      .toEqual({ count: 2 });
    database.close();
  });
});
