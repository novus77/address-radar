import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createSourceLedgerStore, initializeSourceLedgerSchema } from "@address-radar/database";
import { createCandidateSourceRecoveryPlanner } from "../src/candidate-source-recovery.js";

describe("candidate source recovery", () => {
  it("dispatches current enrichment and historical prices for missing market history", () => {
    const database = new DatabaseSync(":memory:");
    initializeSourceLedgerSchema(database);
    const planner = createCandidateSourceRecoveryPlanner({ ledger: createSourceLedgerStore(database), now: () => 100 });

    const result = planner.plan({ reasonCode: "missing_market_history", tokenId: "base:0xabc", chain: "base", tokenAddress: "0xabc" });

    expect(result.recoveryJobIds).toEqual([
      "recovery:market_enrichment:base:0xabc",
      "recovery:market_history:base:0xabc",
    ]);
    database.close();
  });
});
