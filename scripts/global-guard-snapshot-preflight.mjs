import { readOnlyGlobalGuardSnapshot } from "../packages/database/dist/src/global-guard-snapshot-preflight.js";

const supported = new Map([
  ["--page-size", "pageSize"], ["--max-rows", "maximumRows"],
  ["--max-bytes", "maximumBytes"], ["--max-duration-ms", "maximumDurationMs"],
]);
try {
  const args = process.argv.slice(2);
  let databasePath;
  const options = {};
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || seen.has(flag)) throw new Error("invalid_guard_snapshot_arguments");
    seen.add(flag);
    if (flag === "--database") databasePath = value;
    else if (supported.has(flag) && /^\d+$/.test(value)) options[supported.get(flag)] = Number(value);
    else throw new Error("invalid_guard_snapshot_arguments");
  }
  if (!databasePath) throw new Error("invalid_guard_snapshot_arguments");
  // No sink is installed: stdout is a manifest, not a restorable ledger export.
  const result = await readOnlyGlobalGuardSnapshot(databasePath, options);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.status === "complete" ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^invalid_guard_snapshot_/.test(error.message) ?
    error.message : "guard_snapshot_failed";
  process.stderr.write(JSON.stringify({ status: "error", code, productionMigrationReady: false }) + "\n");
  process.exitCode = 2;
}
