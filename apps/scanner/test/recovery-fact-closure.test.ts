import { DatabaseSync } from "node:sqlite";

import {
  createRecoveryFactLinkStore,
  createSourceLedgerStore,
  migrateAddressRadarDatabase,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

import { createRecoveryRuntime } from "../src/recovery-runtime.js";

describe("recovery fact closure", () => {
  it("does not complete a recovery job until its canonical fact exists", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const ledger = createSourceLedgerStore(database);
    const factLinks = createRecoveryFactLinkStore(database);
    ledger.enqueueRecoveryJob({
      jobId: "recovery:market_history:base:0xabc", jobType: "market_history",
      chain: "base", subjectKey: "base:0xabc", priority: 1,
      cursor: null, nextAttemptAt: 0, createdAt: 1,
    });
    const runtime = createRecoveryRuntime({
      ledger,
      factLinks,
      clock: { now: () => 100 },
      retryBaseMs: 10,
      handlers: {
        market_history: async () => ({
          postcondition: {
            factType: "price_history",
            factKey: "base:0xabc",
            verify: () => ({ status: "deferred", reasonCode: "fact_not_ready:price_history" }),
          },
        }),
      },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
    expect(ledger.recoveryJob("recovery:market_history:base:0xabc")).toMatchObject({ status: "failed" });
    expect(factLinks.get("recovery:market_history:base:0xabc", "price_history", "base:0xabc"))
      .toMatchObject({ status: "pending" });
    database.close();
  });

  it("completes and links a verified canonical fact", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    const ledger = createSourceLedgerStore(database);
    const factLinks = createRecoveryFactLinkStore(database);
    ledger.enqueueRecoveryJob({
      jobId: "recovery:market_history:base:0xdef", jobType: "market_history",
      chain: "base", subjectKey: "base:0xdef", priority: 1,
      cursor: null, nextAttemptAt: 0, createdAt: 1,
    });
    const runtime = createRecoveryRuntime({
      ledger,
      factLinks,
      clock: { now: () => 100 },
      handlers: {
        market_history: async () => ({
          postcondition: {
            factType: "price_history",
            factKey: "base:0xdef",
            verify: () => ({ status: "satisfied", producedCount: 1 }),
          },
        }),
      },
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "completed" });
    expect(factLinks.get("recovery:market_history:base:0xdef", "price_history", "base:0xdef"))
      .toMatchObject({ status: "satisfied", verifiedAt: 100 });
    database.close();
  });
});
