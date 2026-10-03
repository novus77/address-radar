import { describe,expect,it } from "vitest";
import { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL,POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL } from "@address-radar/database";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL,seedCapabilityWorkFixture } from "../src/postgres-trader-capability-work-acceptance.js";
import { verifyPostgresForwardSignalAcceptance } from "../src/postgres-forward-signal-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
describe.skipIf(!connectionString)("forward signal projection and receipts",() => {
  it("requires current proof, counts distinct economic buys once and atomically fences readiness",async () => {
    const runtime = createPostgresAcceptanceRuntime({ connectionString: connectionString!,maximumConnections: 1,connectionTimeoutMs: 2000,idleTimeoutMs: 5000,statementTimeoutMs: 5000,lockTimeoutMs: 500 });
    try { const report = await verifyPostgresForwardSignalAcceptance(runtime,{ now: Date.now(),setup: async (transaction,now) => {
      await transaction.query(`${CAPABILITY_WORK_FIXTURE_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL}\n${POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL}`.replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE "));
      return (await seedCapabilityWorkFixture(transaction,now)).generationId;
    } }); expect(report).toMatchObject({ status: "passed",signalReceiptAtomicityVerified: true,economicDeduplicationVerified: true,
      missingProofNoReceiptVerified: true,revocationCancellationVerified: true,cleanupVerified: true,liveSourceCoverageVerified: false,gatewayDeliveryEnabled: false }); }
    finally { await runtime.close(); }
  });
});
