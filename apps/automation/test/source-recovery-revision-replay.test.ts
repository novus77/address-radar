import { afterEach, describe, expect, it } from "vitest";
import { createAutomationJobStore, createTokenFactStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { createSourceFactRevisionReconciler } from "../src/source-fact-revision-reconciler.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
describe("source fact revision replay", () => {
  it("triggers a candidate revision once and ignores unrelated identity facts", () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const facts = createTokenFactStore(database);
    for (const factType of ["price_history", "token_identity"] as const) {
      facts.ensure("base:token", factType, "test", 1);
      facts.transition({ tokenId: "base:token", factType, status: "available", primarySource: "test", observedAt: 1, strategyVersion: "test", updatedAt: 1 });
    }
    const reconciler = createSourceFactRevisionReconciler({ database, jobs: createAutomationJobStore(database), now: () => 2 });
    expect(reconciler.runOnce()).toMatchObject({ processed: 1 });
    expect(reconciler.runOnce()).toMatchObject({ processed: 0 });
    expect(database.prepare("SELECT COUNT(*) count FROM candidate_evaluation_triggers").get()).toEqual({ count: 1 });
  });
});

function seedOwnedFact(database: ReturnType<typeof openAddressRadarDatabase>, token: string, trader: string, at: number) {
  database.prepare(`INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at)
    VALUES(?,'active',0,0,1,1)`).run(trader);
  database.prepare(`INSERT INTO canonical_trader_events(canonical_event_id,entity_id,chain,token_address,side,amount_usd,occurred_at,source_status,updated_at)
    VALUES(?,?,'base',?,'buy',60,1,'ONCHAIN_ONLY',1)`).run(`event:${token}`, trader, token);
  const facts = createTokenFactStore(database);
  facts.ensure(`base:${token}`, 'price_history', 'test', at);
  facts.transition({ tokenId: `base:${token}`, factType: 'price_history', status: 'available', primarySource: 'test', observedAt: at, strategyVersion: 'test', updatedAt: at });
}

describe('independent source fact consumer dispatch', () => {
  it('wakes candidates while retaining an ability obligation across an active job', () => {
    const database = openAddressRadarDatabase(':memory:');
    migrateAddressRadarDatabase(database); databases.push(database);
    seedOwnedFact(database, 'token', 'trader', 1);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue({ jobId: 'existing', idempotencyKey: 'existing', lane: 'trader_backfill', jobType: 'ability_evaluation', subjectKey: 'trader', priority: 76, cursor: null, nextAttemptAt: 1, payload: '{}', createdAt: 1 });
    const reconciler = createSourceFactRevisionReconciler({ database, jobs, now: () => 2 });
    expect(reconciler.runOnce()).toMatchObject({ processed: 1 });
    expect(database.prepare('SELECT COUNT(*) count FROM candidate_evaluation_triggers').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT dispatched_at FROM source_fact_ability_dispatches').get()).toEqual({ dispatched_at: null });
    database.prepare("UPDATE automation_jobs SET status='completed' WHERE job_id='existing'").run();
    expect(reconciler.runOnce()).toMatchObject({ abilityDispatched: 1 });
    expect(jobs.activeJobForSubject('ability_evaluation', 'trader')).not.toBeNull();
    expect(reconciler.runOnce()).toMatchObject({ processed: 0, abilityDispatched: 0 });
    expect(database.prepare('SELECT COUNT(*) count FROM candidate_evaluation_triggers').get()).toEqual({ count: 1 });
  });

  it('skips blocked ability owners before applying the dispatch batch limit', () => {
    const database = openAddressRadarDatabase(':memory:');
    migrateAddressRadarDatabase(database); databases.push(database);
    seedOwnedFact(database, 'old', 'blocked', 1);
    seedOwnedFact(database, 'new', 'free', 2);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue({ jobId: 'existing', idempotencyKey: 'existing', lane: 'trader_backfill', jobType: 'ability_evaluation', subjectKey: 'blocked', priority: 76, cursor: null, nextAttemptAt: 1, payload: '{}', createdAt: 1 });
    const reconciler = createSourceFactRevisionReconciler({ database, jobs, now: () => 3, batchSize: 1 });
    reconciler.runOnce();
    expect(reconciler.runOnce()).toMatchObject({ processed: 1, abilityDispatched: 1 });
    expect(jobs.activeJobForSubject('ability_evaluation', 'free')).not.toBeNull();
  });
});
