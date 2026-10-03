import { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL,verifyPostgresTargetRefreshCoordinatorAcceptance } from "../apps/automation/dist/src/postgres-target-refresh-coordinator-acceptance.js";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL } from "../apps/automation/dist/src/postgres-trader-capability-work-acceptance.js";
const connectionString=process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
if(!connectionString||process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED!=="false")throw new Error("Explicit isolated URL and disabled delivery required");
const runtime=createPostgresAcceptanceRuntime({connectionString,maximumConnections:1,connectionTimeoutMs:2000,idleTimeoutMs:5000,statementTimeoutMs:5000,lockTimeoutMs:500});
try {
  console.log(JSON.stringify(await verifyPostgresTargetRefreshCoordinatorAcceptance(runtime,{now:Date.now(),
    setup:(CAPABILITY_WORK_FIXTURE_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL).replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE ")})));
}catch(error){console.error(JSON.stringify({status:"failed",code:error&&typeof error==="object"&&"code" in error ? String(error.code) : "refresh_coordinator_acceptance_failed"}));process.exitCode=1;}
finally {await runtime.close();}
