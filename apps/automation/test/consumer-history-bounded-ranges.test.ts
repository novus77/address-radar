import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFactDemandStore, createSourceLedgerStore, migrateAddressRadarDatabase,
  readConsumerMarketHistoryRange,
} from "@address-radar/database";
import * as databaseApi from "@address-radar/database";
import { reconcileConsumerHistoryRanges } from "../src/consumer-history-ranges.js";

const DAY = 24 * 60 * 60_000;
const databases: DatabaseSync[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });
function fixture() {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  databases.push(database);
  const demands = createFactDemandStore(database);
  const ledger = createSourceLedgerStore(database);
  const tokenId = "base:0xabc";
  const jobId = `recovery:market_history:${tokenId}`;
  const now = 200 * DAY;
  const record = (id: string, from: number, to: number) => demands.record({
    demandId: id, consumerId: id, purchaseId: id, tokenId,
    strategyVersion: "trader-ability-v4-opportunity", purpose: "complete_range",
    requiredFrom: from, requiredTo: to, evaluatedAt: now,
    reasonCode: "market_range_missing", proof: null,
  });
  ledger.enqueueRecoveryJob({ jobId, jobType: "market_history", chain: "base",
    subjectKey: tokenId, priority: 25, cursor: "preserve", nextAttemptAt: 1, createdAt: 1 });
  const resolve = (at = now) => {
    const resolver = (databaseApi as unknown as { resolveConsumerMarketHistoryRequestRange?:
      (db: DatabaseSync, token: string, at: number) => { fromAt: number; toAt: number } | null
    }).resolveConsumerMarketHistoryRequestRange;
    expect(resolver).toBeTypeOf("function");
    return resolver!(database, tokenId, at);
  };
  return { database, demands, ledger, tokenId, jobId, now, record, resolve };
}

describe("bounded consumer history requests", () => {
  it("does not merge disjoint purchases into a multi-month envelope", () => {
    const f = fixture();
    f.record("a", 60 * DAY, 90 * DAY);
    f.record("b", 120 * DAY, 150 * DAY);
    expect(readConsumerMarketHistoryRange(f.database, f.tokenId, f.now))
      .toEqual({ fromAt: 60 * DAY, toAt: 90 * DAY });
  });

  it("freezes a running request through new demands and retry scheduling", () => {
    const f = fixture();
    f.record("a", 60 * DAY, 80 * DAY);
    f.ledger.claimRecoveryJob(f.now, 10000);
    expect(f.resolve()).toEqual({ fromAt: 60 * DAY, toAt: 80 * DAY });
    f.record("a", 60 * DAY, 90 * DAY);
    f.record("b", 30 * DAY, 50 * DAY);
    expect(f.resolve()).toEqual({ fromAt: 60 * DAY, toAt: 80 * DAY });
    f.ledger.failRecoveryJob(f.jobId, "rate_limited", f.now + DAY, false, f.now);
    expect(f.resolve()).toEqual({ fromAt: 60 * DAY, toAt: 80 * DAY });
    expect(f.ledger.recoveryJob(f.jobId)).toMatchObject({ status: "failed", cursor: "preserve", nextAttemptAt: f.now + DAY });
    expect(f.demands.get("a")?.status).toBe("pending");
  });

  it("advances disjoint requests without repeating attempted windows or claiming complete coverage", () => {
    const f = fixture();
    f.record("a", 60 * DAY, 90 * DAY);
    f.record("b", 120 * DAY, 150 * DAY);
    f.ledger.completeRecoveryJob(f.jobId, 2);
    expect(reconcileConsumerHistoryRanges({ database: f.database, now: () => f.now }).requeued).toBe(1);
    f.ledger.completeRecoveryJob(f.jobId, f.now + 1);
    expect(reconcileConsumerHistoryRanges({ database: f.database, now: () => f.now + 31 * 60_000 }).requeued).toBe(1);
    expect(f.resolve(f.now + 31 * 60_000)).toEqual({ fromAt: 120 * DAY, toAt: 150 * DAY });
    f.ledger.completeRecoveryJob(f.jobId, f.now + 32 * 60_000);
    expect(reconcileConsumerHistoryRanges({ database: f.database, now: () => f.now + 62 * 60_000 }).requeued).toBe(0);
    expect(f.database.prepare("SELECT COUNT(*) n FROM consumer_history_recovery_audits WHERE action='expand_completed'").get()).toEqual({ n: 2 });
    expect(f.demands.get("a")?.status).toBe("pending");
    expect(f.demands.get("b")?.status).toBe("pending");
  });

  it("replaces an oversized active legacy envelope with an audited bounded request", () => {
    const f = fixture();
    f.record("a", 60 * DAY, 90 * DAY);
    f.record("b", 120 * DAY, 150 * DAY);
    f.database.prepare(`INSERT INTO consumer_history_recovery_requests VALUES(?,?,?,?,?,?)`)
      .run(f.jobId, 60 * DAY, 150 * DAY, f.now - 1, f.now - 1, f.now + DAY);
    f.database.prepare(`INSERT INTO consumer_history_recovery_audits(
      job_id,token_id,previous_status,previous_error,previous_updated_at,previous_fact_links,
      action,requested_from,requested_to,recorded_at
    ) VALUES(?,?,'completed',NULL,1,'[]','expand_completed',?,?,?)`)
      .run(f.jobId, f.tokenId, 60 * DAY, 150 * DAY, f.now - 1);
    expect(f.resolve()).toEqual({ fromAt: 60 * DAY, toAt: 90 * DAY });
    expect(f.database.prepare("SELECT action FROM consumer_history_recovery_audits WHERE action='bound_request'").get())
      .toEqual({ action: "bound_request" });
    expect(f.ledger.recoveryJob(f.jobId)).toMatchObject({ status: "pending", cursor: "preserve" });
  });

  it("skips actual coarse-covered windows without satisfying their strict demands", () => {
    const f = fixture();
    f.record("a", 60 * DAY, 60 * DAY + 60 * 60_000);
    f.record("b", 120 * DAY, 150 * DAY);
    for (const at of [60 * DAY, 60 * DAY + 60 * 60_000]) {
      f.database.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES('base','0xabc',?,1,'test')").run(at);
    }
    expect(readConsumerMarketHistoryRange(f.database, f.tokenId, f.now))
      .toEqual({ fromAt: 120 * DAY, toAt: 150 * DAY });
    expect(f.demands.get("a")?.status).toBe("pending");
  });
});
