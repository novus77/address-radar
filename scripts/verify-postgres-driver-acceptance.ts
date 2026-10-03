import { createPostgresAcceptanceRuntime } from "@address-radar/database";

async function main() {
  const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_URL;
  if (!connectionString || process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED !== "false") {
    throw new Error("Explicit acceptance connection and disabled gateway delivery are required");
  }
  const runtime = createPostgresAcceptanceRuntime({ connectionString, maximumConnections: 2,
    connectionTimeoutMs: 2_000, idleTimeoutMs: 5_000, statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
  try {
    const identity = await runtime.probe();
    const numeric = await runtime.run(async tx =>
      (await tx.query("SELECT 9007199254740993::bigint AS large_integer, 0.000000000000000000001::numeric AS exact_decimal")).rows[0]);
    if (numeric?.large_integer !== "9007199254740993" || numeric.exact_decimal !== "0.000000000000000000001") {
      throw new Error("Exact numeric representation failed");
    }
    const rollback = new Error("acceptance rollback marker");
    try {
      await runtime.run(async tx => {
        await tx.query("CREATE TEMP TABLE acceptance_driver_probe(id integer PRIMARY KEY) ON COMMIT DROP");
        await tx.query("INSERT INTO acceptance_driver_probe VALUES (1)");
        throw rollback;
      });
      throw new Error("Rollback marker was not propagated");
    } catch (error) { if (error !== rollback) throw error; }
    const relation = await runtime.run(async tx =>
      (await tx.query("SELECT to_regclass('pg_temp.acceptance_driver_probe') AS relation")).rows[0]?.relation);
    if (relation !== null) throw new Error("Temporary rollback probe persisted");
    console.log(JSON.stringify({ status: "passed", identity, exactNumeric: true, rollback: true,
      pool: runtime.statistics(), businessMigration: false, gatewayDeliveryEnabled: false }));
  } finally { await runtime.close(); }
}
void main().catch(() => {
  console.error("PostgreSQL acceptance driver verification failed; no business activation was performed");
  process.exitCode = 1;
});
