import { randomUUID } from "node:crypto";
import { probeSqliteWriterAdmission, SqliteAdmissionRejected } from "../packages/database/src/sqlite-writer-admission.js";

const args = process.argv.slice(2);
try {
  if (args.length !== 6 || args[0] !== "--writer-id" || args[2] !== "--generation" || args[4] !== "--source"
      || !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(args[1]!) || !/^[A-Za-z0-9_.:@/-]{1,256}$/.test(args[3]!)) {
    throw new SqliteAdmissionRejected("arguments-invalid");
  }
  const receipt = probeSqliteWriterAdmission(args[1]!, args[3]!, args[5]!);
  process.stdout.write(JSON.stringify({ version: 1, attemptId: randomUUID(), ...receipt }) + "\n");
  process.exitCode = receipt.result === "generation-rejected" ? 0 : 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 1, result: "unresolved", reason: error instanceof SqliteAdmissionRejected
    ? error.reason : "native-admission-unavailable", fenceEstablished: false }) + "\n");
  process.exitCode = 2;
}
