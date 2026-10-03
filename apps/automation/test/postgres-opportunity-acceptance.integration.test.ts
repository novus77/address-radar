import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresOpportunityAcceptance } from "../src/postgres-opportunity-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("actual-driver opportunity acceptance", () => {
  it("preserves evidence versions and semantic work identities across rolled-back runs", async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
      connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
    try {
      for (const now of [1700000000000, 1700000100000]) {
        expect(await verifyPostgresOpportunityAcceptance(runtime, now)).toMatchObject({
          peakRevisions: 3, evaluations: 3, downstreamIntents: 2, currentTier: 5,
          timestampRefreshDeduplicated: true, staleExecutionRejected: true,
          immutableConflictRejected: true, unsupportedTierRejected: true,
          provenHeadRetained: true, cleanupVerified: true, businessActivation: false,
        });
      }
    } finally { await runtime.close(); }
  });
  it("rolls back fixture tables when a final assertion query is interrupted", async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
      connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
    const interruption = new Error("Fixture interruption");
    try {
      const interrupted = { probe: () => runtime.probe(), run: runtime.run.bind(runtime) };
      interrupted.run = (operation) => runtime.run((transaction) => operation({
        ...transaction,
        query: async (sql, values) => {
          if (sql.startsWith("SELECT (SELECT count(*) FROM forward_peak_evidence)")) throw interruption;
          return transaction.query(sql, values);
        },
      }));
      await expect(verifyPostgresOpportunityAcceptance(interrupted, 1700000000000)).rejects.toBe(interruption);
      const result = await runtime.run((transaction) => transaction.query("SELECT to_regclass('pg_temp.forward_opportunity_evaluations') AS remaining"));
      expect(result.rows[0]?.remaining).toBeNull();
    } finally { await runtime.close(); }
  });
});
