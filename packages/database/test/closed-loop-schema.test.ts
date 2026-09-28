import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrateAddressRadarDatabase } from "../src/index.js";

describe("closed-loop schema", () => {
  it("creates all additive closed-loop tables idempotently", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    migrateAddressRadarDatabase(database);

    const names = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'automation_job_outcomes', 'recovery_fact_links',
        'wallet_chain_coverage', 'source_observation_enrichments'
      ) ORDER BY name
    `).all().map((row) => String((row as { name: string }).name));

    expect(names).toEqual([
      "automation_job_outcomes",
      "recovery_fact_links",
      "source_observation_enrichments",
      "wallet_chain_coverage",
    ]);
    database.close();
  });
});
