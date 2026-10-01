import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createAutomationJobStore, createRecoveryFactLinkStore, createSourceLedgerStore, createTokenFactStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { reconcileMilestoneEarlyTradeFacts } from "../src/milestone-fact-reconciler.js";
import { createCandidateEvidenceWorker } from "../src/candidate-evidence-worker.js";

function setup() {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  const input = { database, jobs: createAutomationJobStore(database), ledger: createSourceLedgerStore(database),
    factLinks: createRecoveryFactLinkStore(database), facts: createTokenFactStore(database), now: () => 200 };
  return { database, input };
}
function snapshot(database: DatabaseSync) {
  database.prepare("INSERT INTO token_market_snapshots(snapshot_id,token_id,source,observed_at,payload,content_fingerprint) VALUES ('s','base:token','test',100,'{}','f')").run();
}
function priceFact(input: ReturnType<typeof setup>["input"]) {
  input.facts.ensure("base:token", "price_history", "test", 100);
  input.facts.transition({ tokenId: "base:token", factType: "price_history", status: "partial", primarySource: "defillama_chart", observedAt: 100, knownAt: 100, strategyVersion: "test", updatedAt: 100 });
}
function crossing(database: DatabaseSync, precision: string, crossedAt: number | null, source = "test") {
  database.prepare("INSERT INTO token_milestone_crossings VALUES ('m','base:token',100000,?,?,?,'[]','test')").run(crossedAt, precision, source);
}

describe("price-to-milestone recovery handoff", () => {
  it("schedules a price-fact-only token once without asserting a crossing", () => {
    const { database, input } = setup();
    try {
      priceFact(input);
      expect(reconcileMilestoneEarlyTradeFacts(input)).toMatchObject({ milestoneExamined: 1, milestoneScheduled: 1 });
      expect(reconcileMilestoneEarlyTradeFacts(input)).toMatchObject({ milestoneExamined: 0, milestoneScheduled: 0 });
      expect(database.prepare("SELECT COUNT(*) n FROM recovery_jobs WHERE subject_key='base:token'").get()).toEqual({ n: 3 });
      expect(database.prepare("SELECT COUNT(*) n FROM token_milestone_crossings").get()).toEqual({ n: 0 });
    } finally { database.close(); }
  });
  it("deduplicates snapshot and price-fact inventory", () => {
    const { database, input } = setup();
    try {
      snapshot(database); priceFact(input);
      expect(reconcileMilestoneEarlyTradeFacts(input)).toMatchObject({ milestoneExamined: 1, milestoneScheduled: 1 });
    } finally { database.close(); }
  });
  it.each([["unavailable", null, "test"], ["estimated", 300, "test"], ["estimated", 100, " "]] as const)(
    "does not accept %s/%s/%s as a usable crossing", (precision, time, source) => {
      const { database, input } = setup();
      try {
        snapshot(database); crossing(database, precision, time, source);
        expect(reconcileMilestoneEarlyTradeFacts(input)).toMatchObject({ milestoneScheduled: 1, examined: 0, available: 0, scheduled: 0 });
      } finally { database.close(); }
    });
  it.each([["unavailable", null, "test"], ["estimated", 300, "test"], ["estimated", 100, " "]] as const)(
    "candidate evaluation defers unusable %s/%s/%s milestones", async (precision, time, source) => {
      const { database } = setup();
      try {
        crossing(database, precision, time, source);
        const worker = createCandidateEvidenceWorker({ database, now: () => 200 });
        await expect(worker.execute({ payload: JSON.stringify({ tokenId: "base:token" }), cursor: null } as never,
          new AbortController().signal)).resolves.toMatchObject({ status: "waiting_source", sourceBlock: { reasonCode: "missing_milestone" } });
      } finally { database.close(); }
    });
  it("does not derive a milestone from a future market-cap event", async () => {
    const { database } = setup();
    try {
      database.prepare("INSERT INTO fomo_accounts(account_id,handle,first_seen_at,last_seen_at) VALUES ('a','future',1,1)").run();
      database.prepare("INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at) VALUES ('t','candidate',0,0,1,1)").run();
      database.prepare(`INSERT INTO trader_events(event_id,account_id,entity_id,chain,token_address,side,amount_usd,price_usd,market_cap_usd,token_age_ms,occurred_at,collected_at,source)
        VALUES ('e','a','t','base','token','buy',60,5,300000,NULL,300,300,'fomo_stream')`).run();
      const worker = createCandidateEvidenceWorker({ database, now: () => 200 });
      await expect(worker.execute({ payload: JSON.stringify({ tokenId: "base:token" }), cursor: null } as never,
        new AbortController().signal)).resolves.toMatchObject({ status: "waiting_source", sourceBlock: { reasonCode: "missing_milestone" } });
      expect(database.prepare("SELECT COUNT(*) n FROM token_milestone_crossings").get()).toEqual({ n: 0 });
    } finally { database.close(); }
  });
});
