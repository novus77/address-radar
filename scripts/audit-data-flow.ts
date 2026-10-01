import { DatabaseSync } from "node:sqlite";
import { readDataFlowProgress } from "../apps/console/src/data-flow-progress.js";

const path = process.argv[2] ?? process.env.ADDRESS_RADAR_DATABASE_PATH;
if (!path) throw new Error("A database path is required");
const database = new DatabaseSync(path, { readOnly: true });
try {
  console.log(JSON.stringify(readDataFlowProgress(database), null, 2));
} finally { database.close(); }
