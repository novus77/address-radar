import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresTraderCapabilityAcceptance } from "../src/postgres-trader-capability-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("actual-driver forward capability projection", () => {
  const createRuntime = () => createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
    connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
  it("screens stored opportunities and preserves capability revisions without granting radar", async () => {
    const runtime = createRuntime();
    try {
      for (const now of [1700000000000, 1700000100000]) {
        expect(await verifyPostgresTraderCapabilityAcceptance(runtime, now)).toMatchObject({ versions: 4, intents: 4,
          historicalStableVersions: 2, observed100kRequired: true, stableDistinctTokenPolicyVerified: true,
          clockRefreshDeduplicated: true, sampleBudgetDeferred: true, olderDecisionRejected: true,
          legacyAdmissionUnchanged: true, noWalletRequired: true, noRadarAuthorizationGranted: true, cleanupVerified: true });
      }
    } finally { await runtime.close(); }
  });
  it("rolls back a capability head when its downstream intent fails", async () => {
    const runtime = createRuntime(), interruption = new Error("Fixture capability intent interruption");
    try {
      const interrupted = { probe: () => runtime.probe(), run: runtime.run.bind(runtime) };
      interrupted.run = (operation) => runtime.run((transaction) => operation({ query: async (sql, values) => {
        if (sql.startsWith("INSERT INTO forward_trader_capability_intents")) throw interruption;
        return transaction.query(sql, values);
      } }));
      await expect(verifyPostgresTraderCapabilityAcceptance(interrupted, 1700000000000)).rejects.toBe(interruption);
      const cleanup = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_trader_capability_heads') AS heads, to_regclass('pg_temp.forward_trader_capability_versions') AS versions"));
      expect(cleanup.rows[0]).toEqual({ heads: null, versions: null });
    } finally { await runtime.close(); }
  });
});
