import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresTraderCapabilityAcceptance } from "../apps/automation/dist/src/postgres-trader-capability-acceptance.js";

async function main() {
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") throw new Error("Explicit isolated connection and disabled delivery required");
  const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 1,
    connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
  try {
    console.log(JSON.stringify({ status: "passed", ...await verifyPostgresTraderCapabilityAcceptance(runtime, Date.now()),
      gatewayDeliveryEnabled: false, remainingProof: ["live_source_coverage", "runtime_activation", "capability_consumer_receipts",
        "candidate_admission_integration", "manual_authorization", "signal_projection", "business_cutover"] }));
  } finally { await runtime.close(); }
}
void main().catch(() => {
  console.error("PostgreSQL synthetic stable capability acceptance failed; no business activation performed");
  process.exitCode = 1;
});
