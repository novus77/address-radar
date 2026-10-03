import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresOpportunityWorkerAcceptance } from "../src/postgres-opportunity-worker-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("actual-driver opportunity consumer", () => {
  const createRuntime = () => createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
    connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
  it("composes sample intents, factual peak wakeups, fenced evaluations and receipts", async () => {
    const runtime = createRuntime();
    try {
      for (const now of [1700000000000, 1700000100000]) {
        expect(await verifyPostgresOpportunityWorkerAcceptance(runtime, now)).toMatchObject({
          requests: 5, receipts: 3, evaluations: 3, downstreamIntents: 3,
          missingDataDeferredWithoutReceipt: true, requestReplacementFenced: true,
          expiredLeaseFenced: true, timestampRefreshDeduplicated: true, cleanupVerified: true,
          businessActivation: false,
        });
      }
    } finally { await runtime.close(); }
  });
  it("rolls back evaluations and intents when receipt persistence is interrupted", async () => {
    const runtime = createRuntime();
    const interruption = new Error("Fixture receipt interruption");
    try {
      const interrupted = { probe: () => runtime.probe(), run: runtime.run.bind(runtime) };
      interrupted.run = (operation) => runtime.run((transaction) => operation({ query: async (sql, values) => {
        if (sql.startsWith("INSERT INTO forward_opportunity_work_receipts")) throw interruption;
        return transaction.query(sql, values);
      } }));
      await expect(verifyPostgresOpportunityWorkerAcceptance(interrupted, 1700000000000)).rejects.toBe(interruption);
      const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_opportunity_evaluations') AS evaluations, to_regclass('pg_temp.forward_opportunity_work_receipts') AS receipts"));
      expect(cleanup.rows[0]).toEqual({ evaluations: null, receipts: null });
    } finally { await runtime.close(); }
  });
});
