import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { readCurrentOpportunityAbilityProgress } from "../src/current-opportunity-ability-progress.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE trader_entities(entity_id TEXT PRIMARY KEY);
    CREATE TABLE trader_token_samples(entity_id TEXT);
    CREATE TABLE candidate_evidence_v3(trader_id TEXT);
    CREATE TABLE candidate_admission_snapshots(trader_id TEXT);
    CREATE TABLE automation_jobs(job_type TEXT, subject_key TEXT, status TEXT);
    CREATE TABLE trader_repeatable_ability_snapshots(
      entity_id TEXT, window TEXT, strategy_version TEXT, evaluated_at INTEGER
    );
  `);
  return database;
}

function snapshot(database: DatabaseSync, traderId: string, at: number, strategy = "trader-ability-v4-opportunity", window = "30d"): void {
  database.prepare("INSERT INTO trader_repeatable_ability_snapshots VALUES (?, ?, ?, ?)").run(traderId, window, strategy, at);
}

describe("current opportunity ability progress", () => {
  it("counts current-version traders instead of legacy traders or repeated snapshots", () => {
    const database = fixture();
    database.exec("INSERT INTO trader_entities VALUES ('a'),('b'),('c'); INSERT INTO candidate_evidence_v3 VALUES ('a'),('b'); INSERT INTO trader_token_samples VALUES ('c');");
    snapshot(database, "a", 500);
    snapshot(database, "a", 700);
    snapshot(database, "b", 600, "legacy-v1");
    snapshot(database, "c", 600, "trader-ability-v4-opportunity", "7d");
    expect(readCurrentOpportunityAbilityProgress(database, 1_000)).toMatchObject({
      discovered: 3, eligible: 3, completed: 1, pending: 2,
      producedFacts: 1, completed15m: 1, strategyVersion: "trader-ability-v4-opportunity", unit: "trader",
    });
  });

  it("does not count repeat evaluations as newly completed traders", () => {
    const database = fixture();
    const now = 4 * 24 * 60 * 60_000;
    database.exec("INSERT INTO trader_entities VALUES ('a'),('b'); INSERT INTO candidate_evidence_v3 VALUES ('a'),('b');");
    snapshot(database, "a", now - 2 * 24 * 60 * 60_000);
    snapshot(database, "a", now - 1_000);
    snapshot(database, "b", now - 500);
    expect(readCurrentOpportunityAbilityProgress(database, now)).toMatchObject({
      completed: 2, completed15m: 1, completed1h: 1, completed24h: 1,
      evaluatedTraders1h: 2, lastProgressAt: new Date(now - 500).toISOString(),
    });
  });

  it("includes previously evaluated traders but rejects future and orphan snapshots", () => {
    const database = fixture();
    database.exec("INSERT INTO trader_entities VALUES ('a'),('b'),('c'); INSERT INTO candidate_admission_snapshots VALUES ('b');");
    snapshot(database, "a", 500);
    snapshot(database, "b", 2_000);
    snapshot(database, "deleted-trader", 500);
    expect(readCurrentOpportunityAbilityProgress(database, 1_000)).toMatchObject({
      discovered: 3, eligible: 2, completed: 1, pending: 1, lastProgressAt: new Date(500).toISOString(),
    });
  });

  it("returns null progress for an empty current-version cohort", () => {
    const database = fixture();
    database.exec("INSERT INTO trader_entities VALUES ('a'); INSERT INTO trader_token_samples VALUES ('a');");
    snapshot(database, "a", 700, "legacy-v1");
    expect(readCurrentOpportunityAbilityProgress(database, 1_000)).toMatchObject({
      eligible: 1, completed: 0, pending: 1, completed1h: 0, evaluatedTraders1h: 0, lastProgressAt: null,
    });
  });
});

describe("current opportunity ability task classification", () => {
  it("deduplicates blocked traders and allows an active retry to override an old terminal job", () => {
    const database = fixture();
    database.exec(`
      INSERT INTO trader_entities VALUES ('a'),('b'),('c'),('d');
      INSERT INTO candidate_evidence_v3 VALUES ('a'),('b'),('c'),('d');
      INSERT INTO automation_jobs VALUES
        ('ability_evaluation','a','blocked_source'),
        ('ability_evaluation','a','waiting_source'),
        ('ability_evaluation','b','terminal'),
        ('ability_evaluation','c','terminal'),
        ('ability_evaluation','c','pending'),
        ('ability_evaluation','d','cancelled');
    `);
    expect(readCurrentOpportunityAbilityProgress(database, 1_000)).toMatchObject({
      eligible: 4, completed: 0, blocked: 1, terminal: 1, pending: 2,
    });
  });
});
