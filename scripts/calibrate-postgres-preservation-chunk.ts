import { readFullDataPreservationSourceFile } from "../packages/database/src/postgres-full-data-import.js";
import { createHash } from "node:crypto";
import { lstat, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { createPostgresMigrationRuntime } from "../packages/database/src/postgres-migration-runtime.js";
import { createFullDataPreservationSchemaSql, fullDataPreservationSql, verifyFullDataPreservationManifest, verifyOpaqueFullDataPreservationChunk } from "../packages/database/src/postgres-full-data-import.js";
import { preservationPreparationPins } from "./postgres-preservation-fixture-authority.js";
import { readPrivatePreservationFile, assertPreservationResources, verifyPreservationParityChunk, type PreservationRehearsalConfig, type PreservationFixturePorts } from "./rehearse-postgres-full-preservation.js";

export const largestPreservationChunk = Object.freeze({ file: "table-0044-chunk-000000.json", bytes: 16775058,
  sha256: "1328e4403d467c4aa7f7ef4cee43a85ea59347263caf0250b4f76be36fb6f8b3" });
export async function measurePreservationFixtureResources(storagePath: string) {
  const [mem, psi, disk] = await Promise.all([readFile("/proc/meminfo", "utf8"), readFile("/proc/pressure/memory", "utf8"), statfs(storagePath)]);
  return { freeBytes: disk.bavail * disk.bsize, availableMemoryBytes: Number(/^MemAvailable:\s+(\d+) kB$/m.exec(mem)?.[1]) * 1024,
    rssBytes: process.resourceUsage().maxRSS * 1024, memoryPsiAvg10: Number(/^some avg10=([0-9.]+)/m.exec(psi)?.[1]) };
}
export function preservationRowWindows(bodies: readonly Buffer[], maximumRows = 64, maximumBytes = 512 * 1024) {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 4096 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2 * 1024 ** 2) throw new Error("invalid_row_window_budget");
  const windows: { start: number; end: number; bytes: number }[] = [];
  for (let start = 0; start < bodies.length;) {
    let end = start, bytes = 0;
    while (end < bodies.length && end - start < maximumRows && (end === start || bytes + bodies[end]!.length <= maximumBytes)) bytes += bodies[end++]!.length;
    windows.push({ start, end, bytes }); start = end;
  }
  return windows;
}
class CalibrationRollback extends Error {}
/** Largest actual source chunk, real SQL and codec round trip, then unconditional rollback. Never installs source/business objects. */
export async function calibratePreservationChunk(config: PreservationRehearsalConfig, ports: PreservationFixturePorts) {
  const startedAt = Date.now(), initial = await measurePreservationFixtureResources(config.storagePath);
  assertPreservationResources(config, initial, true);
  const check = async () => { if (Date.now() >= config.deadlineAtMs) throw new Error("calibration_deadline"); assertPreservationResources(config, await measurePreservationFixtureResources(config.storagePath), false); };
  for (const file of ["manifest.json", largestPreservationChunk.file]) {
    const info = await lstat(join(config.bundleDirectory, file)); if (info.uid !== 0 || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("source_owner_or_kind");
  }
  const manifest = verifyFullDataPreservationManifest(await readFullDataPreservationSourceFile(config.bundleDirectory, "manifest.json", 545010), { maxRows: 100_000_000 });
  if (manifest.manifestSha256 !== preservationPreparationPins.manifestSha256 || manifest.value.snapshotSha256 !== preservationPreparationPins.snapshotSha256 || manifest.value.catalogFingerprint !== preservationPreparationPins.catalogFingerprint) throw new Error("calibration_source_pin");
  const table = manifest.value.tables.find(t => t.chunks.some(c => c.file === largestPreservationChunk.file)), plan = table?.chunks.find(c => c.file === largestPreservationChunk.file);
  if (!table || !plan || plan.sha256 !== largestPreservationChunk.sha256) throw new Error("calibration_chunk_pin");
  const bytes = await readFullDataPreservationSourceFile(config.bundleDirectory, plan.file, largestPreservationChunk.bytes);
  if (bytes.length !== largestPreservationChunk.bytes) throw new Error("calibration_size");
  const chunk = verifyOpaqueFullDataPreservationChunk(bytes, manifest, table.name, plan.ordinal,{maxRowBytes:2*1024**2}); await check();
  const runtime = createPostgresMigrationRuntime({ pool: ports.pool, target: config.target,
    capability: { mode: "isolated", purpose: "schema_install", approvalRef: config.approvalRef, planSha256: manifest.manifestSha256, expiresAtMs: config.deadlineAtMs },
    assertAuthorized: ports.assertAuthorized, clock: Date.now,
    limits: { operationTimeoutMs: 60000, connectionTimeoutMs: 3000, statementTimeoutMs: 30000, lockTimeoutMs: 500, maximumSqlStatements: 10000, workMemKb: 1024, closeTimeoutMs: 5000 } });
  const schema = '"' + config.target.schema + '"', sql = Object.fromEntries(Object.entries(fullDataPreservationSql).map(([k,v]) => [k,v.replaceAll("__SCHEMA__",schema)]));
  let rowBytes = 0, rawStatements = 0, rollbackObserved = false, baselineDatabaseBytes=0, finalDatabaseBytes=0;
  try {
    await runtime.run(async tx => { for (const statement of createFullDataPreservationSchemaSql(config.target.schema)) await tx.query(statement); });
    baselineDatabaseBytes=Number((await runtime.run(async tx=>(await tx.query("SELECT pg_database_size(current_database())::text bytes")).rows[0]))?.bytes);
    try {
      await runtime.run(async tx => {
        const query = async (statement: string, values: readonly unknown[] = []) => { await check(); rawStatements++; const result = await tx.query(statement, values); await check(); return result; };
        const op = manifest.value.operationId, lineage = [manifest.value.snapshotSha256, manifest.manifestSha256];
        await query(sql.insertOperation!, [op,...lineage,manifest.value.catalogFingerprint,manifest.body,manifest.value.tables.length,manifest.totalChunks,manifest.totalRows]);
        await query(sql.insertTable!, [op,table.name,...lineage,table.rowCount,table.chunks.length,table.contentSha256]);
        await query(sql.insertChunk!, [op,table.name,...lineage,plan.ordinal,plan.file,plan.startRow,plan.rowCount,plan.sha256,bytes]);
        for (const window of preservationRowWindows(chunk.rowBodies)) {
          const bodies = chunk.rowBodies.slice(window.start,window.end);
          await query(sql.insertRows!, [op,table.name,...lineage,bodies.map((_,i)=>plan.startRow+window.start+i),bodies,plan.ordinal]);
          const rows = (await query(sql.selectRows!, [op,table.name,plan.startRow+window.start,plan.startRow+window.end,16*1024**2,bodies.length+1])).rows;
          rowBytes += verifyPreservationParityChunk(manifest,{...chunk,rowBodies:bodies,plan:{...plan,startRow:plan.startRow+window.start,rowCount:bodies.length}},rows).rowBytes;
        }
        for (let offset = 0; offset < bytes.length; offset += 512*1024) {
          const receipt = (await query(`SELECT substring(chunk_body FROM $4 FOR $5) body FROM ${schema}.full_data_preservation_chunks WHERE operation_id=$1 AND table_name=$2 AND ordinal=$3`, [op,table.name,plan.ordinal,offset+1,Math.min(512*1024,bytes.length-offset)])).rows;
          if (receipt.length !== 1 || !Buffer.isBuffer(receipt[0]!.body) || !receipt[0]!.body.equals(bytes.subarray(offset,offset+512*1024))) throw new Error("calibration_receipt_parity");
        }
        throw new CalibrationRollback();
      });
    } catch (error) { if (!(error instanceof CalibrationRollback)) throw error; rollbackObserved = true; }
    const remains = await runtime.run(async tx => (await tx.query(`SELECT count(*)::text count FROM ${schema}.full_data_preservation_operations`)).rows[0]);
    if (!rollbackObserved || remains?.count !== "0") throw new Error("calibration_rollback_not_proven");
    finalDatabaseBytes=Number((await runtime.run(async tx=>(await tx.query("SELECT pg_database_size(current_database())::text bytes")).rows[0]))?.bytes);
    const final = await measurePreservationFixtureResources(config.storagePath); assertPreservationResources(config,final,false);
    return { version: 1, status: "calibrated", manifestSha256: manifest.manifestSha256, ...largestPreservationChunk,
      measuredPeakRssBytes: final.rssBytes, maximumRssBytes: config.resources.maximumRssBytes,
      rows: plan.rowCount, rowBytes, maximumRowBytes: Math.max(...chunk.rowBodies.map(b=>b.length)), rawStatements,
      baselineDatabaseBytes,finalDatabaseBytes,databaseGrowthBytes:finalDatabaseBytes-baselineDatabaseBytes,
      rollbackObserved, initial, final, elapsedMs: Date.now()-startedAt, sourceWrites:false, productionAuthorized:false,
      proofSha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await runtime.close(); }
}
