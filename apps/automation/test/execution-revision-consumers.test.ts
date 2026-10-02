import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as databaseExports from "@address-radar/database";
import { createTraderAbilityWorker, enqueueTraderAbilityEvaluation } from "../src/trader-ability-worker.js";

import { reconcileExecutionRevisionRequests } from "../src/execution-revision-consumers.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "radar-revision-consumer-")); directories.push(dir);
  const path = join(dir, "radar.db"); const repository = databaseExports.openAddressRadarRepository(path);
  repository.upsertFomoAccount({ accountId: "account", handle: "alpha", firstSeenAt: 1, lastSeenAt: 1 });
  repository.upsertTraderEntity({ entityId: "entity", lifecycle: "active", manual: false, locked: false, createdAt: 1, updatedAt: 1 });
  repository.linkAccountToEntity({ accountId: "account", entityId: "entity", confidence: "confirmed", source: "test", observedAt: 1 });
  repository.insertTraderEvent({ eventId: "sig:1", accountId: "account", entityId: "entity", chain: "solana",
    tokenAddress: "TokenCase", side: "buy", amountUsd: 60, priceUsd: 0.6, marketCapUsd: null,
    tokenAgeMs: null, occurredAt: 100, collectedAt: 200, source: "onchain_wallet" });
  repository.close();
  const db = new DatabaseSync(path);
  db.prepare(`INSERT INTO wallet_monitor_observations(source,event_id,chain_family,chain,wallet_address,
    token_address,account_id,entity_id,side,amount_usd,price_usd,occurred_at,collected_at,source_reference)
    VALUES('solana','sig:1','solana','solana','WalletCase','TokenCase','account','entity','buy',90,0.9,100,300,'solana:sig')`).run();
  const basis = JSON.stringify({ status: "estimated", reason: "nominal_stablecoin_usd", tokenAddress: "TokenCase", side: "buy",
    tokenQuantity: 100, quoteAsset: "verified-usdc", quoteQuantity: 90, amountUsd: 90, priceUsd: 0.9, amountBasis: "nominal_stablecoin" });
  db.prepare("INSERT INTO wallet_monitor_execution_bases(source,event_id,basis_json,updated_at) VALUES('solana','sig:1',?,300)").run(basis);
  db.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES('solana','TokenCase',110,3,'test')").run();
  return { db, basis };
}

describe("audited execution consumer context", () => {
  it("recomputes opportunity proofs under the exact applied execution revision", async () => {
    const { db, basis } = setup();
    try {
      expect(typeof databaseExports.createExecutionRevisionStore).toBe("function");
      const revisions = databaseExports.createExecutionRevisionStore(db);
      expect(revisions.apply({ eventId: "sig:1", accountId: "account", entityId: "entity", chain: "solana",
        tokenAddress: "TokenCase", side: "buy", amountUsd: 90, priceUsd: 0.9, marketCapUsd: null,
        tokenAgeMs: null, occurredAt: 100, collectedAt: 300, source: "onchain_wallet" }, "solana", basis, 300)).toBe("applied");
      const jobs = databaseExports.createAutomationJobStore(db);
      const worker = createTraderAbilityWorker({ database: db, jobs, now: () => 1_000 });
      enqueueTraderAbilityEvaluation(jobs, "entity", 1_000, 1_000, "execution-test");
      const job = jobs.activeJobForSubject("ability_evaluation", "entity")!;
      await worker.execute(job, new AbortController().signal);
      const proof = db.prepare("SELECT payload FROM consumer_fact_demands WHERE purchase_id='sig:1' AND purpose='positive_hit'").get() as { payload: string };
      expect(JSON.parse(proof.payload)).toMatchObject({ executionRevision: 1, status: "satisfied", proof: { executionRevision: 1 } });
      const request = db.prepare("SELECT desired_revision,applied_revision FROM execution_revision_requests WHERE consumer_type='ability_evaluation'").get();
      expect(request).toEqual({ desired_revision: 1, applied_revision: 1 });
    } finally { db.close(); }
  });
});

function requestRevision(db: DatabaseSync, eventId: string, consumer: string, subject: string, requestedAt: number): void {
  db.prepare(`INSERT INTO execution_revision_requests(
    source,event_id,consumer_type,subject_key,entity_id,token_id,desired_revision,requested_at
  ) VALUES('solana',?,?,?,?, 'solana:TokenCase',1,?)`)
    .run(eventId,consumer,subject,'entity',requestedAt);
}

describe("execution revision dispatch fairness", () => {
  it("dispatches candidate revisions behind an older blocked consumer backlog", () => {
    const { db } = setup();
    try {
      const jobs = databaseExports.createAutomationJobStore(db);
      for (let i=0;i<100;i++) requestRevision(db,`blocked-${i}`,"signal_projection",`solana:blocked-${i}`,1);
      requestRevision(db,"sig:1","candidate_evidence","solana:TokenCase",2);
      const result = reconcileExecutionRevisionRequests({ database: db,jobs,now: () => 1_000,limit: 100 });
      expect(result.examined).toBe(100);
      expect(result.dispatched).toBe(1);
      expect(jobs.activeJobForSubject("candidate_evidence","solana:TokenCase")).not.toBeNull();
      expect(db.prepare("SELECT dispatched_revision,applied_revision FROM execution_revision_requests WHERE consumer_type='candidate_evidence'").get())
        .toEqual({ dispatched_revision: 1,applied_revision: 0 });
    } finally { db.close(); }
  });

  it("skips active ability subjects without starving later subjects or duplicate dispatching", () => {
    const { db } = setup();
    try {
      const jobs = databaseExports.createAutomationJobStore(db);
      enqueueTraderAbilityEvaluation(jobs,"entity",1_000,1_000,"existing");
      for (let i=0;i<100;i++) requestRevision(db,`active-${i}`,"ability_evaluation","entity",1);
      requestRevision(db,"free-event","ability_evaluation","free-trader",2);
      const result = reconcileExecutionRevisionRequests({ database: db,jobs,now: () => 1_000,limit: 100 });
      expect(result).toEqual({ examined: 1,dispatched: 1,deferred: 0 });
      expect(jobs.activeJobForSubject("ability_evaluation","free-trader")).not.toBeNull();
      expect(reconcileExecutionRevisionRequests({ database: db,jobs,now: () => 1_001,limit: 100 }))
        .toEqual({ examined: 0,dispatched: 0,deferred: 0 });
      expect(db.prepare("SELECT sum(applied_revision) n FROM execution_revision_requests").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
