import { createPostgresAcceptanceRuntime } from "@address-radar/database";
import { verifyPostgresTargetAuthorizationAcceptance } from "../apps/automation/dist/src/postgres-target-authorization-acceptance.js";
async function main() {
  if (process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") throw new Error("Gateway must remain disabled");
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString) throw new Error("Explicit acceptance database required");
  const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 1, connectionTimeoutMs: 2000,
    idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 500 });
  try { console.log(JSON.stringify({ status: "passed", ...await verifyPostgresTargetAuthorizationAcceptance(runtime, Date.now()),
    remainingProof: ["authenticated_registry_hydration", "console_authorization_wiring", "candidate_admission_integration", "signal_receipts",
      "live_source_coverage", "runtime_activation", "business_cutover"] })); }
  finally { await runtime.close(); }
}
main().catch(() => { console.error("PostgreSQL target authorization acceptance failed; connection details redacted"); process.exitCode = 1; });
