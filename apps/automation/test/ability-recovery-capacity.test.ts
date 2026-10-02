import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createAutomationJobStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { createTraderAbilityWorker, enqueueTraderAbilityDispatcher } from "../src/trader-ability-worker.js";

it("reserves admission capacity for fact-triggered ability recomputation", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateAddressRadarDatabase(database);
    const jobs = createAutomationJobStore(database);
    database.prepare(`INSERT INTO trader_entities(entity_id,lifecycle,manual,locked,created_at,updated_at)
      VALUES('eligible','active',0,0,1,1)`).run();
    database.prepare(`INSERT INTO trader_token_samples(sample_id,entity_id,chain,token_address,first_buy_at,last_activity_at,
      total_buy_usd,total_sell_usd,realized_value_usd,remaining_cost_usd,lifecycle_stage_at_entry,
      source_state,sample_status,created_at,updated_at)
      VALUES('sample','eligible','base','0xabc',1,1,60,0,0,60,'unknown','confirmed','included',1,1)`).run();
    for (let i = 0; i < 900; i++) jobs.enqueue({
      jobId: `active-${i}`, idempotencyKey: `active-${i}`, lane: "trader_backfill",
      jobType: "ability_evaluation", subjectKey: `other-${i}`, priority: 76,
      cursor: null, nextAttemptAt: 1, payload: "{}", createdAt: 1,
    });
    enqueueTraderAbilityDispatcher(jobs, 10000);
    const worker = createTraderAbilityWorker({ database, jobs, now: () => 10000 });
    const result = await worker.execute(jobs.activeJobForSubject("ability_evaluation", "trader-ability-dispatcher")!, new AbortController().signal);
    expect(result).toMatchObject({ status: "checkpoint", retryAt: 310000 });
    expect(jobs.activeJobForSubject("ability_evaluation", "eligible")).toBeNull();
    database.prepare("UPDATE automation_jobs SET status='completed' WHERE job_id='active-0'").run();
    await worker.execute(jobs.activeJobForSubject("ability_evaluation", "trader-ability-dispatcher")!, new AbortController().signal);
    expect(jobs.activeJobForSubject("ability_evaluation", "eligible")).not.toBeNull();
  } finally { database.close(); }
});
