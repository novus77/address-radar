import { createPostgresAcceptanceRuntime, POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL } from "@address-radar/database";
import { verifyPostgresForwardTargetRequestAcceptance } from "../apps/console/dist/src/postgres-forward-target-request-acceptance.js";
import { readPostgresForwardTargetAuthorization, readPostgresForwardTargetRegistry } from "../apps/automation/dist/src/forward-target-authorization.js";
import { CAPABILITY_WORK_FIXTURE_SCHEMA_SQL, seedCapabilityWorkFixture } from "../apps/automation/dist/src/postgres-trader-capability-work-acceptance.js";
const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") throw new Error("Explicit isolated acceptance URL and disabled gateway are required");
const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 1, connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 500 });
try {
  const report = await verifyPostgresForwardTargetRequestAcceptance(runtime, { now: Date.now(),
    setup: async (transaction, now) => {
      await transaction.query(`${CAPABILITY_WORK_FIXTURE_SCHEMA_SQL}\n${POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL}`.replace(/^CREATE TABLE /gm, "CREATE TEMP TABLE "));
      return (await seedCapabilityWorkFixture(transaction, now)).generationId;
    }, readAuthorization: readPostgresForwardTargetAuthorization, readRegistry: readPostgresForwardTargetRegistry });
  console.log(JSON.stringify({ ...report, remainingProof: ["real_operator_browser_interactions", "continuous_identity_change_hydration", "multi_client_http_concurrency", "signal_receipts", "live_source_coverage", "permanent_schema_activation", "business_cutover"] }));
} catch {
  console.error(JSON.stringify({ status: "failed", error: "forward_target_request_acceptance_failed", businessActivation: false, gatewayDeliveryEnabled: false }));
  process.exitCode = 1;
} finally { await runtime.close(); }
