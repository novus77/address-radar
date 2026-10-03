import { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL } from "@address-radar/database";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL,seedCapabilityWorkFixture } from "../apps/automation/dist/src/postgres-trader-capability-work-acceptance.js";
import { verifyPostgresTargetRevalidationAcceptance } from "../apps/automation/dist/src/postgres-target-revalidation-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") throw new Error("Explicit isolated URL and disabled gateway required");
const runtime = createPostgresAcceptanceRuntime({ connectionString,maximumConnections: 1,connectionTimeoutMs: 2000,idleTimeoutMs: 5000,statementTimeoutMs: 5000,lockTimeoutMs: 500 });
try {
  console.log(JSON.stringify(await verifyPostgresTargetRevalidationAcceptance(runtime,{ now: Date.now(),setup: async (transaction,now) => {
    await transaction.query(`${CAPABILITY_WORK_FIXTURE_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL}`.replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE "));
    return (await seedCapabilityWorkFixture(transaction,now)).generationId;
  } })));
} catch { console.error(JSON.stringify({ status: "failed",error: "target_revalidation_acceptance_failed",businessActivation: false,gatewayDeliveryEnabled: false })); process.exitCode = 1; }
finally { await runtime.close(); }
