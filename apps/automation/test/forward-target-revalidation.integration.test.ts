import { describe,expect,it } from "vitest";
import { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL } from "@address-radar/database";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL,seedCapabilityWorkFixture } from "../src/postgres-trader-capability-work-acceptance.js";
import { verifyPostgresTargetRevalidationAcceptance } from "../src/postgres-target-revalidation-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("forward target fresh identity qualification",() => {
  it("blocks missing, stale and revoked identity proofs while keeping channels independent",async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!,maximumConnections: 1,connectionTimeoutMs: 2000,idleTimeoutMs: 5000,statementTimeoutMs: 5000,lockTimeoutMs: 500 });
    try {
      const report = await verifyPostgresTargetRevalidationAcceptance(runtime,{ now: Date.now(),setup: async (transaction,now) => {
        await transaction.query(`${CAPABILITY_WORK_FIXTURE_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL}`.replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE "));
        return (await seedCapabilityWorkFixture(transaction,now)).generationId;
      } });
      expect(report).toMatchObject({ status: "passed",sourceFailureClosedVerified: true,identityReceiptAtomicityVerified: true,revocationFenceVerified: true,
        assessmentClockFenceVerified: true,independentChannelsVerified: true,ownershipAmbiguityVerified: true,cleanupVerified: true,businessActivation: false });
    } finally { await runtime.close(); }
  });
});
