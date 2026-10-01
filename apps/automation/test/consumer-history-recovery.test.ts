import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createFactDemandStore, createSourceLedgerStore, migrateAddressRadarDatabase, readConsumerMarketHistoryRange } from "@address-radar/database";
import { reconcileConsumerHistoryRecovery } from "../src/consumer-history-recovery.js";

const databases: DatabaseSync[] = [];
const fixture = () => {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  databases.push(database);
  return { database, ledger: createSourceLedgerStore(database), demands: createFactDemandStore(database) };
};
afterEach(() => { while (databases.length) databases.pop()!.close(); });
const demand = (id: string, tokenId = "base:0xabc", reasonCode = "market_range_missing") => ({
  demandId: id, consumerId: `trader:${id}`, purchaseId: `buy:${id}`, tokenId,
  strategyVersion: "trader-ability-v4-opportunity", purpose: "positive_hit" as const,
  requiredFrom: 1000, requiredTo: 5000, evaluatedAt: 10000, reasonCode, proof: null,
});

describe("consumer market history recovery", () => {
  it("coalesces wallet-only consumers into one bounded recovery job without inventing completion", () => {
    const { database, ledger, demands } = fixture();
    demands.record(demand("a")); demands.record(demand("b"));
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10000 })).toEqual({ examined: 1, enqueued: 1 });
    expect(ledger.recoveryJob("recovery:market_history:base:0xabc")).toMatchObject({ status: "pending", subjectKey: "base:0xabc" });
    expect(readConsumerMarketHistoryRange(database, "base:0xabc", 10000)).toEqual({ fromAt: 1000, toAt: 5000 });
    expect(demands.get("a")).toMatchObject({ status: "pending" });
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10001 })).toEqual({ examined: 0, enqueued: 0 });
  });

  it("does not reset active leases, failed backoff, completed jobs or dead letters", () => {
    const { database, ledger, demands } = fixture();
    for (const [id, status] of [["1", "running"], ["2", "failed"], ["3", "completed"], ["4", "dead_letter"]]) {
      const tokenId = `base:0x${id}`;
      demands.record(demand(id!, tokenId));
      ledger.enqueueRecoveryJob({ jobId: `recovery:market_history:${tokenId}`, jobType: "market_history", chain: "base", subjectKey: tokenId, priority: 25, cursor: "preserve", nextAttemptAt: 90000, createdAt: 1 });
      database.prepare("UPDATE recovery_jobs SET status=?, lease_expires_at=12345 WHERE subject_key=?").run(status!, tokenId);
    }
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10000 }).enqueued).toBe(0);
    expect(database.prepare("SELECT COUNT(*) n FROM recovery_jobs WHERE next_attempt_at=90000 AND cursor='preserve' AND lease_expires_at=12345").get()).toEqual({ n: 4 });
  });

  it("does not try to repair missing entry execution price or amount with market prices", () => {
    const { database, ledger, demands } = fixture();
    demands.record(demand("a", "base:0xa", "entry_price_missing"));
    demands.record(demand("b", "base:0xb", "purchase_amount_missing"));
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10000 }).enqueued).toBe(0);
    expect(readConsumerMarketHistoryRange(database, "base:0xa", 10000)).toBeNull();
  });

  it("uses Fomo recovery for Robinhood, preserves Solana case and respects the batch cap", () => {
    const { database, ledger, demands } = fixture();
    for (const token of ["robinhood:0xabc", "solana:Mint", "solana:mint"]) demands.record(demand(token, token));
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10000, limit: 2 }).enqueued).toBe(2);
    expect(ledger.recoveryJob("recovery:fomo_token_history:robinhood:0xabc")).not.toBeNull();
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10000, limit: 2 }).enqueued).toBe(1);
    expect(ledger.recoveryJob("recovery:market_history:solana:Mint")).not.toBeNull();
    expect(ledger.recoveryJob("recovery:market_history:solana:mint")).not.toBeNull();
  });

  it("includes complete-range needs but rejects future evaluations and unsupported chains", () => {
    const { database, ledger, demands } = fixture();
    demands.record({ ...demand("complete"), purpose: "complete_range" });
    demands.record({ ...demand("future", "base:0xf"), evaluatedAt: 20000 });
    demands.record(demand("unsupported", "monad:0x1"));
    expect(reconcileConsumerHistoryRecovery({ database, ledger, now: () => 10000 }).enqueued).toBe(1);
    expect(readConsumerMarketHistoryRange(database, "base:0xf", 10000)).toBeNull();
  });
});
