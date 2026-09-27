import { DatabaseSync } from "node:sqlite";

import {
  createSourceLedgerStore,
  initializeSourceLedgerSchema,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

import { createCandidateSourceRecoveryPlanner } from "../src/candidate-source-recovery.js";

describe("candidate source recovery planner", () => {
  it("enqueues idempotent market and historical recovery jobs for a missing milestone", () => {
    const database = new DatabaseSync(":memory:");
    initializeSourceLedgerSchema(database);
    const ledger = createSourceLedgerStore(database);
    const planner = createCandidateSourceRecoveryPlanner({ ledger, now: () => 1_000 });

    const first = planner.plan({
      reasonCode: "missing_milestone",
      tokenId: "base:0xabc",
      chain: "base",
      tokenAddress: "0xabc",
    });
    const replay = planner.plan({
      reasonCode: "missing_milestone",
      tokenId: "base:0xabc",
      chain: "base",
      tokenAddress: "0xabc",
    });

    expect(first).toEqual({ recoveryJobIds: [
      "recovery:market_enrichment:base:0xabc",
      "recovery:historical_research:base:0xabc",
    ] });
    expect(replay).toEqual(first);
    expect(ledger.recoveryJob(first.recoveryJobIds[0]!)).toMatchObject({
      jobType: "market_enrichment",
      subjectKey: "base:0xabc",
      status: "pending",
    });
    expect(ledger.recoveryJob(first.recoveryJobIds[1]!)).toMatchObject({
      jobType: "historical_research",
      subjectKey: "base:0xabc",
      status: "pending",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM recovery_jobs").get()).toEqual({ count: 2 });
    database.close();
  });

  it("routes missing early trades to the milestone buyer recovery queue", () => {
    const database = new DatabaseSync(":memory:");
    initializeSourceLedgerSchema(database);
    const ledger = createSourceLedgerStore(database);
    const planner = createCandidateSourceRecoveryPlanner({ ledger, now: () => 2_000 });

    expect(planner.plan({
      reasonCode: "missing_early_trades",
      tokenId: "solana:Mint",
      chain: "solana",
      tokenAddress: "Mint",
    })).toEqual({ recoveryJobIds: ["recovery:milestone_early_buyers:solana:Mint"] });
    database.close();
  });
});
