import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrateAddressRadarDatabase } from "@address-radar/database";

describe("database migration barrier", () => {
  it("skips runtime migration when the barrier owns schema changes", () => {
    const database = new DatabaseSync(":memory:");

    migrateAddressRadarDatabase(database, {
      environment: { ADDRESS_RADAR_RUNTIME_MIGRATIONS: "false" },
    });

    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'
    `).get()).toEqual({ count: 0 });
    database.close();
  });

  it("forces migration from the dedicated barrier and records its version", () => {
    const database = new DatabaseSync(":memory:");

    migrateAddressRadarDatabase(database, {
      force: true,
      environment: { ADDRESS_RADAR_RUNTIME_MIGRATIONS: "false" },
    });

    expect(database.prepare(`
      SELECT schema_version AS schemaVersion
      FROM address_radar_schema_state
      WHERE singleton = 1
    `).get()).toEqual({ schemaVersion: "2026-09-28-write-stability-v1" });
    database.close();
  });
});
