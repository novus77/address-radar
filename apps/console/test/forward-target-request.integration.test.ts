import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime, POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL } from "@address-radar/database";
import { verifyPostgresForwardTargetRequestAcceptance } from "../src/postgres-forward-target-request-acceptance.js";
import { readPostgresForwardTargetAuthorization, readPostgresForwardTargetRegistry } from "../../automation/src/forward-target-authorization.js";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL, seedCapabilityWorkFixture } from "../../automation/src/postgres-trader-capability-work-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("forward target independent HTTP transactions", () => {
  it("commits each command independently, rolls back failures and preserves immutable retries", async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!, maximumConnections: 1,
      connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 500 });
    try {
      const report = await verifyPostgresForwardTargetRequestAcceptance(runtime, { now: Date.now(),
        setup: async (transaction, now) => {
          await transaction.query(`${CAPABILITY_WORK_FIXTURE_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL}`.replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
          return (await seedCapabilityWorkFixture(transaction, now)).generationId;
        }, readAuthorization: readPostgresForwardTargetAuthorization, readRegistry: readPostgresForwardTargetRegistry });
      expect(report).toMatchObject({ status: "passed", committedCommands: 3, perRequestCommitVerified: true,
        commandRollbackVerified: true, retryIdempotencyVerified: true, unauthorizedNoMutationVerified: true,
        cleanupVerified: true, businessActivation: false, liveSourceCoverageVerified: false });
      expect(report.independentRequestTransactions).toBeGreaterThanOrEqual(6);
    } finally { await runtime.close(); }
  });
});
