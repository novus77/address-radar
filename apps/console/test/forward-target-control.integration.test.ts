import { describe, expect, it } from "vitest";
import { createPostgresAcceptanceRuntime, POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL } from "@address-radar/database";
import { readPostgresForwardTargetAuthorization, readPostgresForwardTargetRegistry } from "../../automation/src/forward-target-authorization.js";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL, seedCapabilityWorkFixture } from "../../automation/src/postgres-trader-capability-work-acceptance.js";
import { verifyPostgresForwardTargetControlAcceptance } from "../src/postgres-forward-target-control-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("actual-driver authenticated target controls", () => {
  it("hydrates real SQLite identity rows through protected HTTP and rolls back all PostgreSQL fixture writes", async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!,maximumConnections: 1,connectionTimeoutMs: 2000,idleTimeoutMs: 5000,statementTimeoutMs: 5000,lockTimeoutMs: 500 });
    try {
      const result = await verifyPostgresForwardTargetControlAcceptance(runtime,{ now: 1700000000000,
        setup: async (transaction,now) => { await transaction.query(`${CAPABILITY_WORK_FIXTURE_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL}`.replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE "));
          return (await seedCapabilityWorkFixture(transaction,now)).generationId; },
        readAuthorization: readPostgresForwardTargetAuthorization,readRegistry: readPostgresForwardTargetRegistry });
      expect(result).toMatchObject({ status: "passed",channelVersions: 6,manualEvents: 2,authenticatedHttpVerified: true,serverDerivedActorVerified: true,
        clientProofRejected: true,idempotentCommandsVerified: true,ownershipQuarantineVerified: true,cleanupVerified: true,businessActivation: false });
    } finally { await runtime.close(); }
  });
});
