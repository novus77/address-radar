import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAutomationJobStore, createRecoveryFactLinkStore, createSourceLedgerStore, createTokenFactStore, migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";
import { reconcileMilestoneEarlyTradeFacts } from "../src/milestone-fact-reconciler.js";

describe("milestone fact reconciliation", () => {
  it("schedules market history before milestone recovery and remains idempotent", () => {
    const database = openAddressRadarDatabase(join(mkdtempSync(join(tmpdir(), "milestone-missing-")), "radar.sqlite")); migrateAddressRadarDatabase(database);
    database.prepare(`INSERT INTO token_market_snapshots(snapshot_id,token_id,source,observed_at,payload,content_fingerprint) VALUES ('s1','base:0xdef','test',100,'{}','fingerprint')`).run();
    const input = { database, jobs: createAutomationJobStore(database), ledger: createSourceLedgerStore(database), factLinks: createRecoveryFactLinkStore(database), facts: createTokenFactStore(database), now: () => 200 };
    const first = reconcileMilestoneEarlyTradeFacts(input);
    const second = reconcileMilestoneEarlyTradeFacts(input);
    expect(first).toMatchObject({ milestoneExamined: 1, milestoneScheduled: 1 });
    expect(second).toMatchObject({ milestoneExamined: 0, milestoneScheduled: 0 });
    expect(database.prepare("SELECT job_type AS jobType FROM recovery_jobs WHERE subject_key='base:0xdef' ORDER BY job_type").all()).toEqual([
      { jobType: "historical_research" },
      { jobType: "market_enrichment" },
      { jobType: "market_history" },
    ]);
    expect(database.prepare("SELECT COUNT(*) count FROM recovery_fact_links WHERE fact_type='milestone_crossings'").get()).toEqual({ count: 3 });
    database.close();
  });

  it("materializes a scheduled fact and recovery link", () => {
    const database = openAddressRadarDatabase(join(mkdtempSync(join(tmpdir(), "milestone-fact-")), "radar.sqlite")); migrateAddressRadarDatabase(database);
    database.prepare(`INSERT INTO token_milestone_crossings(milestone_id,token_id,market_cap_usd,crossed_at,precision,source,source_event_ids,strategy_version) VALUES ('m1','base:0xabc',100000,100,'exact','test','[]','test')`).run();
    const result = reconcileMilestoneEarlyTradeFacts({ database, jobs: createAutomationJobStore(database), ledger: createSourceLedgerStore(database), factLinks: createRecoveryFactLinkStore(database), facts: createTokenFactStore(database), now: () => 200 });
    expect(result).toMatchObject({ examined: 1, scheduled: 1 });
    expect(createTokenFactStore(database).fact("base:0xabc", "early_trades")).toMatchObject({ status: "scheduled" });
    expect(database.prepare("SELECT COUNT(*) count FROM recovery_fact_links WHERE fact_type='early_trades'").get()).toEqual({ count: 1 }); database.close();
  });
});
