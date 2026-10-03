import { readFileSync, statSync } from "node:fs";
import {
  readOnlyRowProtectionBundle, summarizeRowProtectionBundle, type RowProtectionRequest,
} from "../packages/database/src/full-data-row-protection.js";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--database" || args[2] !== "--request") {
  process.stderr.write("Usage: tsx scripts/full-data-row-protection-preflight.ts --database /path/to/source.sqlite --request /path/to/request.json\n");
  process.exitCode = 2;
} else {
  try {
    if (statSync(args[3]!).size > 256 * 1024) throw new Error("request_too_large");
    const request = JSON.parse(readFileSync(args[3]!, "utf8")) as RowProtectionRequest;
    const bundle = readOnlyRowProtectionBundle(args[1]!, request);
    process.stdout.write(JSON.stringify(summarizeRowProtectionBundle(bundle), null, 2) + "\n");
    process.exitCode = bundle.declaredDependenciesComplete ? 0 : 1;
  } catch {
    process.stderr.write("Read-only row protection preflight failed. No import, deletion or cutover was attempted.\n");
    process.exitCode = 2;
  }
}
