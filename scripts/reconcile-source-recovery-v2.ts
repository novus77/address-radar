import { DatabaseSync } from "node:sqlite";
import { reconcileSourceRecoveryV2 } from "../apps/automation/src/migrations/reconcile-source-recovery-v2.js";
const path = process.argv[2];
if (!path || path.startsWith("--")) throw new Error("Database path required");
const apply = process.argv.includes("--apply");
const jobIds = process.argv.filter(arg => arg.startsWith("--job-id=")).map(arg => arg.slice(9));
const db = new DatabaseSync(path, { readOnly: !apply });
try {
  if (!apply) db.exec("PRAGMA query_only=ON");
  console.log(JSON.stringify(reconcileSourceRecoveryV2({ database: db, jobIds, dryRun: !apply }), null, 2));
} finally { db.close(); }
