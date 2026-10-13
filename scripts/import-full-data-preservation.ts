import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFullDataPreservationBundle } from "../packages/database/src/postgres-full-data-import.js";

export async function runFullDataPreservationValidationCli(args: readonly string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("Usage: pnpm exec tsx scripts/import-full-data-preservation.ts --bundle <directory> [--dry-run]\nValidation only. Apply requires the parent migration authorization gate.\n");
    return;
  }
  let directory: string | undefined; let dryRun = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--apply") throw new Error("Apply is unavailable; use the parent migration authorization gate");
    if (argument === "--bundle" && directory === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--bundle requires a directory");
      directory = value;
    } else if (argument === "--dry-run" && !dryRun) dryRun = true;
    else throw new Error("Unknown or duplicate argument: " + argument);
  }
  if (directory === undefined) throw new Error("--bundle is required");
  const bundle = await readFullDataPreservationBundle(directory);
  process.stdout.write(JSON.stringify({ mode: "dry-run", preservationVerified: true,
    operationId: bundle.manifest.value.operationId, snapshotSha256: bundle.manifest.value.snapshotSha256,
    manifestSha256: bundle.manifest.manifestSha256, catalogFingerprint: bundle.manifest.value.catalogFingerprint,
    databaseEncoding: bundle.manifest.value.catalog.pragmas.encoding, tables: bundle.manifest.value.tables.length,
    rows: bundle.totalRows, chunks: bundle.totalChunks, verifiedBytes: bundle.totalBytes,
    databaseWrites: false, sourceWrites: false, businessActivation: false, grantsBusinessEligibility: false,
    productionMigrationReady: false }) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runFullDataPreservationValidationCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(JSON.stringify({ status: "failed", reason: error instanceof Error ? error.message : "Validation failed",
      databaseWrites: false, sourceWrites: false, businessActivation: false }) + "\n");
    process.exitCode = 1;
  });
}
