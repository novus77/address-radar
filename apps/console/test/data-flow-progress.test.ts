import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readDataFlowProgress } from "../src/data-flow-progress.js";
import { createAddressConsoleApplication } from "../src/application.js";

describe("read-only data flow diagnostics", () => {
  it("reports missing schemas without initializing tables", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const before = database.prepare("SELECT total_changes() AS changes").get();
      const result = readDataFlowProgress(database, 100);
      expect(result.ability).toMatchObject({ available: false, coverage: null });
      expect(result.sources.available).toBe(false);
      expect(database.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally { database.close(); }
  });
  it("counts latest opportunity traders without mixing legacy or future snapshots", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE trader_repeatable_ability_snapshots (
        snapshot_id TEXT,entity_id TEXT,ability_stage TEXT,evaluated_at INTEGER,
        strategy_version TEXT,window TEXT);
        INSERT INTO trader_repeatable_ability_snapshots VALUES
        ('a1','a','candidate',10,'trader-ability-v4-opportunity','30d'),
        ('a2','a','stable',20,'trader-ability-v4-opportunity','30d'),
        ('b1','b','stable',20,'v3','30d'),
        ('c1','c','stable',200,'trader-ability-v4-opportunity','30d');`);
      expect(readDataFlowProgress(database, 100).ability).toMatchObject({
        evaluatedTraders: 1, coverage: null, states: [{ state: "stable", traders: 1, lastEvaluationAt: 20 }],
      });
    } finally { database.close(); }
  });
  it("exposes the additive endpoint without changing existing routes", () => {
    const application = createAddressConsoleApplication();
    try {
      expect(application.handle("GET", "/api/v2/operations/data-flow")).toMatchObject({
        status: 200, body: { schemaVersion: "data-flow-v1", ability: { coverage: null } },
      });
    } finally { application.close(); }
  });
});
