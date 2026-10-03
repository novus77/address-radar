import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime, type PostgresTransaction } from "@address-radar/database";
import { verifyPostgresPipelineAcceptance } from "../src/postgres-pipeline-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const now = Date.parse("2026-10-03T00:00:00Z");
const create = () => createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
  connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });

describe.skipIf(!connectionString)("PostgreSQL actual-driver pipeline acceptance", () => {
  it("reconciles capture, independent consumers, 100K screening and deferred receipts without activating business", async () => {
    const runtime = create();
    try {
      expect(await verifyPostgresPipelineAcceptance(runtime, now)).toEqual({
        fixtureScope: "synthetic_transaction_rollback", captureIdentities: 2, rawRevisions: 3,
        normalizedEvents: 3, consumerReceipts: 3, deferredConsumers: 3, economicTrades: 1,
        purchaseSamples: 1, tokenWatches: 1, amountEstimated: true,
        opportunityWindowMs: 30 * 24 * 60 * 60 * 1000, screeningEnabled: true,
        cleanupVerified: true, businessActivation: false, liveSourceCoverageVerified: false,
      });
    } finally { await runtime.close(); }
  });

  it("runs twice on the same pool without retaining temporary fixture rows", async () => {
    const runtime = create();
    try {
      const first = await verifyPostgresPipelineAcceptance(runtime, now);
      const second = await verifyPostgresPipelineAcceptance(runtime, now + 10000);
      expect(second).toEqual(first);
    } finally { await runtime.close(); }
  });

  it("rolls back partial pipeline writes when acceptance fails", async () => {
    const runtime = create();
    const failure = new Error("fixture acceptance interruption");
    const interrupted = {
      probe: runtime.probe,
      run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
        return runtime.run(transaction => operation({
          async query(text, values) {
            if (text.includes("AS samples") && text.includes("AS identities")) throw failure;
            return transaction.query(text, values);
          },
        }));
      },
    };
    try {
      await expect(verifyPostgresPipelineAcceptance(interrupted, now)).rejects.toBe(failure);
      expect(await runtime.run(async transaction =>
        (await transaction.query("SELECT to_regclass('pg_temp.capture_event_identities') AS relation")).rows[0]?.relation)).toBeNull();
      expect((await verifyPostgresPipelineAcceptance(runtime, now)).cleanupVerified).toBe(true);
    } finally { await runtime.close(); }
  });
});
