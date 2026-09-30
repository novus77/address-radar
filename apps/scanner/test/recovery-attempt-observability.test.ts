import { afterEach, describe, expect, it } from "vitest";
import { createSourceLedgerStore, createTokenFactStore, openAddressRadarDatabase, migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime, RetryableRecoveryError } from "../src/recovery-runtime.js";

const databases: ReturnType<typeof openAddressRadarDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("recovery attempt observability", () => {
  it("separates execution time from retry time and redacts error details", async () => {
    const database = openAddressRadarDatabase(":memory:");
    migrateAddressRadarDatabase(database);
    databases.push(database);
    const ledger = createSourceLedgerStore(database);
    const tokenFacts = createTokenFactStore(database);
    ledger.enqueueRecoveryJob({ jobId: "market", jobType: "market_enrichment", chain: "base", subjectKey: "base:token", priority: 20, cursor: null, nextAttemptAt: 10_000, createdAt: 10_000 });
    const runtime = createRecoveryRuntime({ ledger, tokenFacts, clock: { now: () => 10_000 }, retryBaseMs: 500, handlers: {
      market_enrichment: () => { throw new RetryableRecoveryError("provider_timeout https://private.example?secret=hidden"); },
    } });
    await expect(runtime.runOnce()).resolves.toMatchObject({ outcome: "retry" });
    expect(ledger.recoveryJob("market")).toMatchObject({ updatedAt: 10_000, nextAttemptAt: 10_500 });
    const attempt = database.prepare("SELECT * FROM token_fact_attempts").get();
    expect(attempt).toMatchObject({ started_at: 10_000, finished_at: 10_000, retry_at: 10_500, outcome: "failed", facts_written: 0, message: "provider_timeout" });
    expect(JSON.stringify(attempt)).not.toContain("hidden");
  });
});
