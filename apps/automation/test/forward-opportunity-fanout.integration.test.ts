import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresOpportunityFanoutAcceptance } from "../src/postgres-opportunity-fanout-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("actual-driver opportunity fanout and reconciliation", () => {
  const createRuntime = () => createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
    connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
  it("pages durable wakeups, resumes a cursor and repairs facts without timestamp churn", async () => {
    const runtime = createRuntime();
    try {
      for (const now of [1700000000000, 1700000100000]) {
        expect(await verifyPostgresOpportunityFanoutAcceptance(runtime, now)).toMatchObject({ completedFanouts: 2,
          samples: 5, requests: 13, receipts: 9, evaluations: 9, downstreamIntents: 9, durableCursorVerified: true,
          expiredLeaseRejected: true, lostWakeupRepaired: true, lateSampleVerified: true,
          timestampRefreshDeduplicated: true, cleanupVerified: true, businessActivation: false });
      }
    } finally { await runtime.close(); }
  });
  it("rolls back staged work when cursor persistence is interrupted", async () => {
    const runtime = createRuntime();
    const interruption = new Error("Fixture cursor interruption");
    try {
      const interrupted = { probe: () => runtime.probe(), run: runtime.run.bind(runtime) };
      interrupted.run = (operation) => runtime.run((transaction) => operation({ query: async (sql, values) => {
        if (sql.startsWith("UPDATE forward_peak_fanout_jobs SET last_sample_id=")) throw interruption;
        return transaction.query(sql, values);
      } }));
      await expect(verifyPostgresOpportunityFanoutAcceptance(interrupted, 1700000000000)).rejects.toBe(interruption);
      const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_peak_fanout_jobs') AS fanouts, to_regclass('pg_temp.forward_opportunity_requests') AS requests"));
      expect(cleanup.rows[0]).toEqual({ fanouts: null, requests: null });
    } finally { await runtime.close(); }
  });
});
