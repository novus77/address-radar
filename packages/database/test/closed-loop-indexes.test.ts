import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { migrateAddressRadarDatabase } from "../src/index.js";
it("uses strategy and time covering indexes for closure statistics", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateAddressRadarDatabase(db);
    const plan = (sql: string) => JSON.stringify(db.prepare("EXPLAIN QUERY PLAN " + sql).all());
    expect(plan("SELECT entity_id,min(evaluated_at),max(evaluated_at) FROM trader_repeatable_ability_snapshots WHERE strategy_version='trader-ability-v4-opportunity' AND window='30d' GROUP BY entity_id"))
      .toContain("trader_repeatable_ability_strategy_coverage");
    expect(plan("SELECT count(*) FROM automation_job_outcomes WHERE created_at>=1000"))
      .toContain("automation_job_outcomes_closure_time");
  } finally { db.close(); }
});
