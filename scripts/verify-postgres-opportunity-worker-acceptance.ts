import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresOpportunityWorkerAcceptance } from "../apps/automation/dist/src/postgres-opportunity-worker-acceptance.js";

async function main() {
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") {
    throw new Error("Explicit isolated connection and disabled delivery required");
  }
  const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 1,
    connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
  try {
    console.log(JSON.stringify({ status: "passed", ...await verifyPostgresOpportunityWorkerAcceptance(runtime, Date.now()),
      gatewayDeliveryEnabled: false, remainingProof: ["live_source_coverage", "durable_acquisition_commit",
        "token_peak_fanout", "execution_revision_application", "stable_capability", "candidate_admission",
        "runtime_activation", "business_cutover"] }));
  } finally { await runtime.close(); }
}
void main().catch(() => {
  console.error("PostgreSQL synthetic opportunity consumer acceptance failed; business activation remains disabled");
  process.exitCode = 1;
});
