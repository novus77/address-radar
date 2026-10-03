import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresPipelineAcceptance } from "../apps/scanner/dist/src/postgres-pipeline-acceptance.js";

async function main() {
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") {
    throw new Error("Explicit acceptance connection and disabled gateway delivery are required");
  }
  const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 1,
    connectionTimeoutMs: 2000, idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 500 });
  try {
    const report = await verifyPostgresPipelineAcceptance(runtime, Date.now());
    console.log(JSON.stringify({ status: "passed", ...report, gatewayDeliveryEnabled: false,
      remainingProof: ["live_source_coverage", "durable_acquisition_commit", "opportunity_evidence",
        "stable_capability", "candidate_admission", "signal_projection", "business_cutover"] }));
  } finally { await runtime.close(); }
}
void main().catch(() => {
  console.error("PostgreSQL synthetic pipeline acceptance failed; no business activation was performed");
  process.exitCode = 1;
});
