import { createPostgresAcceptanceRuntime } from "../packages/database/dist/src/postgres-acceptance-driver.js";
import { verifyPostgresGlobalGuardRoundTrip } from "../packages/database/dist/src/postgres-global-guard-acceptance.js";

let runtime;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--database" || !args[1]) throw new Error("invalid_guard_acceptance_arguments");
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_TEST_URL;
  if (!connectionString) throw new Error("guard_acceptance_test_url_required");
  runtime = createPostgresAcceptanceRuntime({
    connectionString, maximumConnections: 1, connectionTimeoutMs: 3000,
    idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 250,
  });
  const report = await verifyPostgresGlobalGuardRoundTrip(runtime, args[1]);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  const code = error instanceof Error && /^(?:invalid_guard_|guard_)/.test(error.message) ? error.message : "guard_acceptance_failed";
  process.stderr.write(JSON.stringify({ status: "failed", code, productionMigrationReady: false }) + "\n");
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close();
}
