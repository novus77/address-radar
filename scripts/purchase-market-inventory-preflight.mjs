import { readFileSync } from "node:fs";
import { readOnlyPurchaseMarketInventoryPreflight } from "../packages/database/dist/src/purchase-market-inventory-preflight.js";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--database" || args[2] !== "--request" || !args[1] || !args[3]) {
  console.error("usage: purchase-market-inventory-preflight --database SOURCE --request PRIVATE_JSON");
  process.exitCode = 2;
} else {
  try {
    const report = readOnlyPurchaseMarketInventoryPreflight(args[1], JSON.parse(readFileSync(args[3], "utf8")));
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "inspected" ? 0 : 1;
  } catch {
    console.error("purchase_market_inventory_input_or_source_failed");
    process.exitCode = 2;
  }
}
