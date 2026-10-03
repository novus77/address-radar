import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresTraderCapabilityWorkAcceptance } from "../apps/automation/dist/src/postgres-trader-capability-work-acceptance.js";

async function main() {
  if (process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") throw new Error("Gateway must remain disabled");
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString) throw new Error("Explicit acceptance database required");
  const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 1, connectionTimeoutMs: 2000,
    idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 500 });
  try {
    const report = await verifyPostgresTraderCapabilityWorkAcceptance(runtime, Date.now());
    console.log(JSON.stringify({ status: "passed", ...report, remainingProof: ["live_source_coverage", "runtime_activation",
      "candidate_admission_integration", "manual_authorization", "signal_projection", "business_cutover"] }));
  } finally { await runtime.close(); }
}
main().catch(() => { console.error("PostgreSQL capability work acceptance failed; connection details redacted"); process.exitCode = 1; });
