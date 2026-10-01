import { openAddressRadarDatabase } from "../packages/database/src/connection.js";
import { migrateWalletExecutionBasis } from "../packages/database/src/wallet-execution-basis-schema.js";

const path = process.env.ADDRESS_RADAR_DATABASE_PATH?.trim();
if (!path) throw new Error("ADDRESS_RADAR_DATABASE_PATH is required");
const database = openAddressRadarDatabase(path);
try {
  migrateWalletExecutionBasis(database);
  console.log(JSON.stringify({ status: "ok", migration: "wallet-execution-basis-additive-v1" }));
} finally {
  database.close();
}
