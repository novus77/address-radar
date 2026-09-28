import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrateAddressRadarDatabase } from "../src/migrations.js";

describe("console query indexes", () => {
  it("creates indexes for latest trader scores, closed-loop operations, and reconciliation", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);

    const indexes = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'trader_score_snapshots_entity_latest', 'trader_ability_snapshots_as_of',
          'automation_job_outcomes_type_time', 'recovery_fact_links_unresolved',
          'wallet_chain_coverage_status', 'source_observation_enrichments_latest'
        )
      ORDER BY name
    `).all().map(row => String(row.name));

    expect(indexes).toEqual([
      "automation_job_outcomes_type_time",
      "recovery_fact_links_unresolved",
      "source_observation_enrichments_latest",
      "trader_ability_snapshots_as_of",
      "trader_score_snapshots_entity_latest",
      "wallet_chain_coverage_status",
    ]);
    database.close();
  });
});
