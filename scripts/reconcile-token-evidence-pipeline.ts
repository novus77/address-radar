import { DatabaseSync } from "node:sqlite";

import { reconcileTokenEvidencePipelineV1 } from "../apps/automation/src/migrations/reconcile-token-evidence-pipeline-v1.js";

const databasePath = process.argv.find((value, index) => index > 1 && !value.startsWith("--"))
  ?? process.env.ADDRESS_RADAR_DATABASE_PATH;
const dryRun = !process.argv.includes("--apply");
const batchArgument = process.argv.find((value) => value.startsWith("--batch-size="));
const batchSize = batchArgument ? Number(batchArgument.split("=", 2)[1]) : 250;
if (!databasePath) throw new Error("Database path is required as an argument or ADDRESS_RADAR_DATABASE_PATH");

const database = new DatabaseSync(databasePath);
try {
  const summary = reconcileTokenEvidencePipelineV1({ database, dryRun, batchSize });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  database.close();
}
