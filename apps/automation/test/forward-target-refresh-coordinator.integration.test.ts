import { describe,it,expect } from "vitest";
import { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL } from "@address-radar/database";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL } from "../src/postgres-trader-capability-work-acceptance.js";
import { verifyPostgresTargetRefreshCoordinatorAcceptance } from "../src/postgres-target-refresh-coordinator-acceptance.js";
describe.skipIf(!process.env.ADDRESS_RADAR_POSTGRES_TEST_URL)("durable target refresh PostgreSQL acceptance",()=>{
  it("persists cursors and fences retries, expired leases, missing receipts and partial audits",async()=>{
    const runtime=createPostgresAcceptanceRuntime({connectionString:process.env.ADDRESS_RADAR_POSTGRES_TEST_URL!,maximumConnections:1,connectionTimeoutMs:2000,idleTimeoutMs:5000,statementTimeoutMs:5000,lockTimeoutMs:500});
    try {
      const result=await verifyPostgresTargetRefreshCoordinatorAcceptance(runtime,{now:Date.now(),setup:(CAPABILITY_WORK_FIXTURE_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL).replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE ")});
      expect(result.status).toBe("passed");expect(result.businessActivation).toBe(false);
    }finally {await runtime.close();}
  });
});
