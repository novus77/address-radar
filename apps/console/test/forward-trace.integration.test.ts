import { fileURLToPath } from "node:url";
import { describe,it,expect } from "vitest";
import { createPostgresAcceptanceRuntime,POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL,POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL,POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL } from "@address-radar/database";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL,seedCapabilityWorkFixture } from "../../automation/src/postgres-trader-capability-work-acceptance.js";
import { verifyPostgresForwardTraceAcceptance } from "../src/postgres-forward-trace-acceptance.js";
describe.skipIf(!process.env.ADDRESS_RADAR_POSTGRES_TEST_URL)("forward trace PostgreSQL acceptance",()=>{
  it("serves a bounded authenticated read without mutating facts",async()=>{
    const runtime=createPostgresAcceptanceRuntime({connectionString:process.env.ADDRESS_RADAR_POSTGRES_TEST_URL!,maximumConnections:1,connectionTimeoutMs:2000,idleTimeoutMs:5000,statementTimeoutMs:5000,lockTimeoutMs:500});
    try {
      const result=await verifyPostgresForwardTraceAcceptance(runtime,{now:Date.now(),
        setup:(CAPABILITY_WORK_FIXTURE_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL+POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL+POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL).replace(/^CREATE TABLE /gm,"CREATE TEMP TABLE "),
        publicDirectory:fileURLToPath(new URL("../public/",import.meta.url)),seed:seedCapabilityWorkFixture});
      expect(result.status).toBe("passed");expect(result.businessActivation).toBe(false);
    } finally {await runtime.close();}
  });
});
