import { createPostgresAcceptanceRuntime } from "../packages/database/src/postgres-acceptance-driver.js";
import { createSyntheticPreservationAcceptanceBundle, verifyPostgresPreservationRoundTrip } from "../packages/database/src/postgres-preservation-acceptance.js";

async function main() {
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") {
    throw new Error("Explicit isolated acceptance connection and disabled delivery are required");
  }
  const runtime = createPostgresAcceptanceRuntime({
    connectionString, maximumConnections: 1, connectionTimeoutMs: 2000,
    idleTimeoutMs: 5000, statementTimeoutMs: 5000, lockTimeoutMs: 500,
  });
  try {
    const report = await verifyPostgresPreservationRoundTrip(runtime, createSyntheticPreservationAcceptanceBundle());
    process.stdout.write(JSON.stringify({ ...report, sourceData: "synthetic_only" }) + "\n");
  } finally { await runtime.close(); }
}
void main().catch(() => {
  process.stderr.write("Isolated PostgreSQL preservation acceptance failed; no business migration or activation was performed.\n");
  process.exitCode = 1;
});
