import { readFileSync } from "node:fs";
import { readOnlyPurchaseDependencyCoveragePreflight } from "../packages/database/dist/src/purchase-dependency-coverage-preflight.js";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--database" || args[2] !== "--request" || !args[1] || !args[3]) {
  console.error("usage: purchase-dependency-coverage-preflight --database SOURCE --request PRIVATE_JSON");
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(readFileSync(args[3], "utf8"));
    const report = readOnlyPurchaseDependencyCoveragePreflight(args[1], input);
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "dependencies_available" ? 0 : 1;
  } catch {
    console.error("purchase_dependency_preflight_input_or_source_failed");
    process.exitCode = 2;
  }
}
