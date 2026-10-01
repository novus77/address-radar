import { openAddressRadarDatabase } from "../packages/database/src/connection.js";
import { migrateWalletExecutionBasis } from "../packages/database/src/wallet-execution-basis-schema.js";
import { initializeFactDemandSchema } from "../packages/database/src/fact-demand-store.js";
import { withAddressRadarWriteTransaction } from "../packages/database/src/connection.js";

const path = process.env.ADDRESS_RADAR_DATABASE_PATH?.trim();
if (!path) throw new Error("ADDRESS_RADAR_DATABASE_PATH is required");
const database = openAddressRadarDatabase(path);
try {
  migrateWalletExecutionBasis(database);
  withAddressRadarWriteTransaction(database, () => initializeFactDemandSchema(database));
  console.log(JSON.stringify({ status: "ok", migrations: ["wallet-execution-basis-additive-v1", "consumer-fact-demands-additive-v1"] }));
} finally {
  database.close();
}
