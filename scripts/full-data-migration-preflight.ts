import { createFullDataMigrationManifest } from "../packages/database/src/full-data-migration-manifest.js";
import { readOnlyFullDataMigrationCatalog } from "../packages/database/src/full-data-migration-preflight.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--database") {
  process.stderr.write("Usage: tsx scripts/full-data-migration-preflight.ts --database /path/to/source.sqlite\n");
  process.exitCode = 2;
} else {
  try {
    const source = readOnlyFullDataMigrationCatalog(args[1]!);
    const manifest = createFullDataMigrationManifest(source);
    process.stdout.write(JSON.stringify({ sourceScope: source.scope, readOnly: source.readOnly,
      dataCounts: source.dataCounts, ddlFingerprint: source.ddlFingerprint, manifest }, null, 2) + "\n");
    process.exitCode = manifest.classificationValid ? 0 : 1;
  } catch {
    // Do not leak source paths, credentials or SQL payloads in operational logs.
    process.stderr.write("Read-only migration preflight failed. No import or cutover was attempted.\n");
    process.exitCode = 2;
  }
}

