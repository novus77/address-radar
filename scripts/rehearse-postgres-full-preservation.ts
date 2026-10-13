import { readFullDataPreservationSourceFile } from "../packages/database/src/postgres-full-data-import.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, readFile, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPostgresMigrationRuntime, type PostgresMigrationTarget, type PostgresMigrationRuntimeOptions } from "../packages/database/src/postgres-migration-runtime.js";
import { importFullDataPreservationBundle, readOpaqueFullDataPreservationBundle, verifyOpaqueFullDataPreservationChunk, verifyFullDataPreservationManifest, preservationRowByteWindows,
  type VerifiedFullDataPreservationManifest, type VerifiedFullDataPreservationChunk, type VerifiedOpaquePreservationChunk, type FullDataPreservationRow } from "../packages/database/src/postgres-full-data-import.js";
import { PostgresCommitUncertainError, type PostgresPool, type PostgresClient, type PostgresTransaction } from "../packages/database/src/postgres-unit-of-work.js";
import { PreservationImportYield, withPreservationImportAdmission } from "./preservation-import-boundary.js";

const gib = 1024 ** 3;
const digest = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
function ensure(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error("preservation_rehearsal_" + reason); }
export interface PreservationRehearsalConfig {
  version: 1; stage: "interrupt" | "import" | "resume" | "parity";
  bundleDirectory: string; evidenceDirectory: string; storagePath: string;
  authorityModule: string; authorityModuleSha256: string; approvalRef: string; deadlineAtMs: number;
  expected: { manifestSha256: string; snapshotSha256: string; catalogFingerprint: string; tables: number; rows: number; chunks: number };
  target: PostgresMigrationTarget;
  resources: { reserveBytes: number; maximumTargetGrowthBytes: number; minimumAvailableMemoryBytes: number; maximumRssBytes: number; maximumMemoryPsiAvg10: number; maximumResidentChunkBytes: number };
  maximumTotalQueries: number; maximumTransactionMs: number; maximumQueriesPerTransaction: number;
  interruptAfterCommittedChunks: number;
}
export interface PreservationResourceMeasurement { freeBytes: number; availableMemoryBytes: number; rssBytes: number; memoryPsiAvg10: number }
export interface PreservationFixturePorts {
  /** A fresh dedicated pool for each CLI process. Credentials remain inside this externally reviewed module. */
  pool: PostgresPool & { end(): Promise<void> };
  assertAuthorized: PostgresMigrationRuntimeOptions["assertAuthorized"];
  residentChunkAllowance?: { manifestSha256: string; chunkSha256: string; chunkBytes: number; measuredPeakRssBytes: number; maximumRssBytes: number; rollbackObserved: boolean };
}
function forwardErrorPorts<T extends object>(native: T, wrapped: T): T {
  for (const name of ["on", "removeListener"]) {
    const method: unknown = Reflect.get(native, name);
    if (typeof method === "function") Object.defineProperty(wrapped, name, { value: method.bind(native) });
  }
  return wrapped;
}

export interface PreservationSqlMetrics {
  rawSql: number; commitAttempts: number; acknowledgedCommits: number;
  rollbackAttempts: number; acknowledgedRollbacks: number; failedRollbacks: number;
}
/** Admission remains closed after pressure. Only exact transaction cleanup may bypass it. */
export function createPreservationGuardedClient(client: PostgresClient, guard: {
  checkpoint(): void; deadlineAtMs: number; maximumTotalQueries: number; metrics: PreservationSqlMetrics;
}): PostgresClient {
  return forwardErrorPorts(client, {
    async query(sql, values) {
      const cleanup = sql === "ROLLBACK";
      if (cleanup) ensure(Date.now() < guard.deadlineAtMs, "deadline");
      else guard.checkpoint();
      ensure(guard.metrics.rawSql + 1 <= guard.maximumTotalQueries, "physical_sql_budget");
      guard.metrics.rawSql++;
      if (sql === "COMMIT") guard.metrics.commitAttempts++;
      if (cleanup) guard.metrics.rollbackAttempts++;
      try {
        const result = await client.query(sql, values);
        if (sql === "COMMIT") guard.metrics.acknowledgedCommits++;
        if (cleanup) guard.metrics.acknowledgedRollbacks++;
        return result;
      } catch (error) {
        if (cleanup) guard.metrics.failedRollbacks++;
        throw error;
      }
    },
    release: error => client.release(error),
  });
}
/** Sticky process peak is never reset. Released frames force GC even inside the throttle interval. */
export function createPreservationResourceCheckpoint(config: Pick<PreservationRehearsalConfig, "deadlineAtMs" | "resources">,
  metrics: { peakRssBytes: number }, pressureError: () => unknown): (releasedChunk?: boolean, allocationBytes?: number) => void {
  let lastCollectionAt = 0;
  return (releasedChunk = false, allocationBytes = 0) => {
    const pressure = pressureError(); if (pressure) throw pressure;
    ensure(Date.now() < config.deadlineAtMs, "deadline");
    if (typeof global.gc === "function" && (releasedChunk || allocationBytes >= 256 * 1024 || Date.now() - lastCollectionAt >= 250)) {
      global.gc(); lastCollectionAt = Date.now();
    }
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, process.resourceUsage().maxRSS * 1024);
    ensure(metrics.peakRssBytes <= config.resources.maximumRssBytes, "rss_limit");
  };
}

function exact(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "object");
  ensure(Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), "fields");
}
function positive(value: unknown, maximum: number, minimum = 1): void { ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, "limit"); }
export function validatePreservationRehearsalConfig(value: unknown, allowance?: PreservationFixturePorts["residentChunkAllowance"]): PreservationRehearsalConfig {
  exact(value, ["version", "stage", "bundleDirectory", "evidenceDirectory", "storagePath", "authorityModule", "authorityModuleSha256", "approvalRef", "deadlineAtMs", "expected", "target", "resources", "maximumTotalQueries", "maximumTransactionMs", "maximumQueriesPerTransaction", "interruptAfterCommittedChunks"]);
  ensure(value.version === 1 && ["interrupt", "import", "resume", "parity"].some(stage => value.stage === stage), "stage");
  for (const name of ["bundleDirectory", "evidenceDirectory", "storagePath", "authorityModule"]) ensure(typeof value[name] === "string" && isAbsolute(value[name] as string), "path");
  ensure(typeof value.approvalRef === "string" && value.approvalRef.length > 0 && value.approvalRef.length <= 512, "authority");
  positive(value.deadlineAtMs, Date.now() + 3_600_000, Date.now() + 1);
  if (value.stage === "import") positive(value.deadlineAtMs, Date.now() + 900_000, Date.now() + 1);
  exact(value.expected, ["manifestSha256", "snapshotSha256", "catalogFingerprint", "tables", "rows", "chunks"]);
  for (const hash of [value.authorityModuleSha256, value.expected.manifestSha256, value.expected.snapshotSha256, value.expected.catalogFingerprint]) ensure(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash), "pin");
  positive(value.expected.tables, 1000, 0); positive(value.expected.rows, 100_000_000, 0); positive(value.expected.chunks, 100_000, 0);
  exact(value.target, ["database", "schema", "username", "serverAddress", "serverPort", "systemIdentifier", "schemaVersion", "schemaFingerprint", "generation", "service"]);
  const nonce = /^radar_rehearsal_([a-f0-9]{16})(?:_[a-z]+)?$/;
  const databaseNonce = typeof value.target.database === "string" ? nonce.exec(value.target.database)?.[1] : undefined;
  ensure(databaseNonce && typeof value.target.schema === "string" && nonce.exec(value.target.schema)?.[1] === databaseNonce,
    "nonce_target");
  const target = value.target;
  ensure(target.serverPort === 5434 && ["127.0.0.1", "::1"].some(address => address === target.serverAddress), "private_endpoint");
  exact(value.resources, ["reserveBytes", "maximumTargetGrowthBytes", "minimumAvailableMemoryBytes", "maximumRssBytes", "maximumMemoryPsiAvg10", "maximumResidentChunkBytes"]);
  positive(value.resources.reserveBytes, 1024 * gib, 5 * gib); positive(value.resources.maximumTargetGrowthBytes, 1024 * gib);
  positive(value.resources.minimumAvailableMemoryBytes, 1024 * gib, gib); positive(value.resources.maximumRssBytes, 256 * 1024 ** 2);
  positive(value.resources.maximumResidentChunkBytes, 16 * 1024 ** 2);
  if ((value.resources.maximumResidentChunkBytes as number)>2*1024**2) ensure(allowance && allowance.rollbackObserved === true && allowance.manifestSha256 === value.expected.manifestSha256 &&
    /^[a-f0-9]{64}$/.test(allowance.chunkSha256) && allowance.chunkBytes === value.resources.maximumResidentChunkBytes &&
    Number.isSafeInteger(allowance.measuredPeakRssBytes) && allowance.measuredPeakRssBytes>0 && allowance.measuredPeakRssBytes<=allowance.maximumRssBytes &&
    allowance.maximumRssBytes===value.resources.maximumRssBytes,"measured_chunk_allowance");
  ensure(typeof value.resources.maximumMemoryPsiAvg10 === "number" && Number.isFinite(value.resources.maximumMemoryPsiAvg10) && value.resources.maximumMemoryPsiAvg10 >= 0 && value.resources.maximumMemoryPsiAvg10 <= 10, "psi_limit");
  positive(value.maximumTransactionMs, 60_000); positive(value.maximumQueriesPerTransaction, 100_000);
  positive(value.maximumTotalQueries, 1_000_000); positive(value.interruptAfterCommittedChunks, Math.max(1, value.expected.chunks as number));
  return structuredClone(value) as unknown as PreservationRehearsalConfig;
}
export function assertPreservationResources(config: PreservationRehearsalConfig, measured: PreservationResourceMeasurement, initial: boolean): void {
  ensure(Object.values(measured).every(value => Number.isFinite(value) && value >= 0), "unknown_resource");
  ensure(measured.freeBytes >= config.resources.reserveBytes + (initial ? config.resources.maximumTargetGrowthBytes : 0), "disk_reserve");
  ensure(measured.availableMemoryBytes >= config.resources.minimumAvailableMemoryBytes && measured.rssBytes <= config.resources.maximumRssBytes && measured.memoryPsiAvg10 <= config.resources.maximumMemoryPsiAvg10, "memory_pressure");
}
export async function readPrivatePreservationFile(path: string, maximum: number): Promise<Buffer> {
  ensure(isAbsolute(path) && resolve(path) === path, "canonical_path");
  let ancestor = dirname(path);
  for (;;) {
    const info = await lstat(ancestor);
    ensure(info.isDirectory() && !info.isSymbolicLink() && ((info.mode & 0o022) === 0 || (info.mode & 0o1000) !== 0), "unsafe_ancestor");
    if (ancestor === dirname(ancestor)) break; ancestor = dirname(ancestor);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    ensure(before.isFile() && (Number(before.mode) & 0o077) === 0 && before.size <= BigInt(maximum), "private_file");
    const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat({ bigint: true });
    ensure(offset === Number(before.size) && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "file_changed");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
async function measureResources(storagePath: string): Promise<PreservationResourceMeasurement> {
  const [mem, status, psi, disk] = await Promise.all([readFile("/proc/meminfo", "utf8"), readFile("/proc/self/status", "utf8"), readFile("/proc/pressure/memory", "utf8"), statfs(storagePath)]);
  return { freeBytes: disk.bavail * disk.bsize, availableMemoryBytes: Number(/^MemAvailable:\s+(\d+) kB$/m.exec(mem)?.[1]) * 1024,
    rssBytes: Number(/^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1]) * 1024,
    memoryPsiAvg10: Number(/^some avg10=([0-9.]+)/m.exec(psi)?.[1]) };
}
export function verifyPreservationParityChunk(manifest: VerifiedFullDataPreservationManifest, chunk: VerifiedFullDataPreservationChunk | VerifiedOpaquePreservationChunk,
  records: readonly Record<string, unknown>[]) {
  ensure(records.length === chunk.plan.rowCount, "parity_count");
  const result = { rows: records.length, cells: { integer: 0, real: 0, text: 0, blob: 0, null: 0 }, integersBeyondSafeRange: 0, blobBytes: 0, textBytes: 0, rowBytes: 0 };
  for (const [index, record] of records.entries()) {
    const lineageChecks={operation_id:record.operation_id===manifest.value.operationId,snapshot_sha256:record.snapshot_sha256===manifest.value.snapshotSha256,
      manifest_sha256:record.manifest_sha256===manifest.manifestSha256,table_name:record.table_name===chunk.plan.table,
      row_ordinal:record.row_ordinal===String(chunk.plan.startRow+index),chunk_ordinal:record.chunk_ordinal===String(chunk.plan.ordinal)};
    ensure(Object.values(lineageChecks).every(Boolean),"parity_lineage_"+Object.keys(lineageChecks).filter(key=>!lineageChecks[key as keyof typeof lineageChecks]).join("_"));
    ensure(Buffer.isBuffer(record.row_body) && record.row_body.equals(chunk.rowBodies[index]!), "parity_body");
    result.rowBytes += record.row_body.length;
    const sourceRow: FullDataPreservationRow = "rows" in chunk ? chunk.rows[index]! : JSON.parse(chunk.rowBodies[index]!.toString("utf8"));
    for (const cell of sourceRow.values) {
      result.cells[cell.storage]++;
      if (cell.storage === "integer" && (BigInt(cell.value) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(cell.value) < BigInt(Number.MIN_SAFE_INTEGER))) result.integersBeyondSafeRange++;
      if (cell.storage === "blob") result.blobBytes += Buffer.from(cell.value, "base64").length;
      if (cell.storage === "text") result.textBytes += Buffer.from(cell.value, "base64").length;
    }
  }
  return result;
}
class RestartAfterCommit extends Error {}
const safeRehearsalReasons = new Set("object fields limit stage path authority pin nonce_target private_endpoint measured_chunk_allowance psi_limit unknown_resource disk_reserve memory_pressure canonical_path unsafe_ancestor private_file file_changed parity_count parity_body private_directory evidence_not_source deadline physical_sql_budget rss_limit database_size target_growth resident_chunk_budget allowance_source_chunk source_pins_or_counts sizing_or_chunk_rows restart_lineage restart_accounting interruption_not_exercised parity_receipt parity_receipt_slice parity_table_digest parity_table_accounting parity_completion arguments external_config_pin external_module_pin authority_adapter".split(" "));
function directSafeError(error: unknown): string | undefined {
  if (error instanceof RestartAfterCommit) return "INTERRUPTED_AFTER_DURABLE_COMMIT";
  if (!(error instanceof Error)) return undefined;
  const rehearsal = /^preservation_rehearsal_([a-z_]+)$/.exec(error.message)?.[1];
  if (rehearsal && safeRehearsalReasons.has(rehearsal)) return "preservation_rehearsal_" + rehearsal;
  if (/^preservation_rehearsal_parity_lineage_(?:operation_id|snapshot_sha256|manifest_sha256|table_name|row_ordinal|chunk_ordinal)(?:_(?:operation_id|snapshot_sha256|manifest_sha256|table_name|row_ordinal|chunk_ordinal))*$/.test(error.message)) return "preservation_rehearsal_parity_lineage";
  if (/^source_reader_[a-z_]{1,64}$/.test(error.message)) return "source_reader_failed";
  const known = /\b(row_byte_limit|chunk_byte_limit|execution_deadline_exceeded|transaction_deadline_exceeded|query_budget_exceeded|chunk_digest_mismatch|table_content_digest_mismatch|chunk_receipt_body_mismatch|durable_row_body_mismatch)\b/.exec(error.message);
  if (known) return "preservation_import_" + known[1];
  if (error.name === "PostgresMigrationDeadlineError") return "migration_runtime_deadline";
  const code = Reflect.get(error, "code");
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return "postgres_sqlstate_" + code;
  return undefined;
}
/** Bounded, non-secret diagnostic only; an observed rollback ACK cannot disprove an uncertain COMMIT. */
export function classifyPreservationFailure(error: unknown): {
  reason: string; primaryCategory: string; commitUncertaintyObserved: boolean; cleanupFailureObserved: boolean;
} {
  const unknown = "FAILED_OR_COMMIT_UNKNOWN_RECONCILE_BEFORE_RETRY";
  let primaryCategory: string | undefined, commitUncertaintyObserved = false, cleanupFailureObserved = false;
  const seen = new Set<unknown>(), pending: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }];
  while (pending.length && seen.size < 16) {
    const entry = pending.pop(); if (!entry || seen.has(entry.value)) continue;
    seen.add(entry.value);
    primaryCategory ??= directSafeError(entry.value);
    if (entry.value instanceof PostgresCommitUncertainError) commitUncertaintyObserved = true;
    if (entry.value instanceof AggregateError && entry.value.message === "PostgreSQL operation and rollback failed") cleanupFailureObserved = true;
    if (entry.depth >= 4 || !(entry.value instanceof Error)) continue;
    const cause = Object.getOwnPropertyDescriptor(entry.value, "cause");
    if (cause && "value" in cause) pending.push({ value: cause.value, depth: entry.depth + 1 });
    if (entry.value instanceof AggregateError && Array.isArray(entry.value.errors))
      for (const child of entry.value.errors.slice(0, 8).reverse()) pending.push({ value: child, depth: entry.depth + 1 });
  }
  return { reason: commitUncertaintyObserved ? unknown : primaryCategory ?? unknown, primaryCategory: primaryCategory ?? unknown,
    commitUncertaintyObserved, cleanupFailureObserved };
}
function safeError(error: unknown): string { return classifyPreservationFailure(error).reason; }

/** Linux-only operator tooling. No DDL, source writes, business runtime, activation, selection or fencing. */
export async function runFullPreservationRehearsal(configInput: unknown, ports: PreservationFixturePorts) {
  let closing: Promise<void> | undefined;
  const end = () => closing ??= ports.pool.end();
  try { return await runPreservationCore(configInput, { ...ports, pool: forwardErrorPorts(ports.pool, { connect: () => ports.pool.connect(), end }) }); }
  finally { await end(); }
}
async function runPreservationCore(configInput: unknown, ports: PreservationFixturePorts) {
  const config = validatePreservationRehearsalConfig(configInput,ports.residentChunkAllowance), startedAt = Date.now(), runId = randomUUID();
  for (const path of [config.bundleDirectory, config.evidenceDirectory, config.storagePath]) {
    const info = await lstat(path); ensure(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && await realpath(path) === path, "private_directory");
  }
  ensure(config.evidenceDirectory !== config.bundleDirectory && !config.evidenceDirectory.startsWith(config.bundleDirectory + "/"), "evidence_not_source");
  let last = await measureResources(config.storagePath); assertPreservationResources(config, last, config.stage!=="parity");
  const metrics = { transactions: 0, commitAttempts: 0, acknowledgedCommits: 0, rollbackAttempts: 0, acknowledgedRollbacks: 0, failedRollbacks: 0, rawSql: 0, maximumTransactionMs: 0, peakRssBytes: last.rssBytes,
    minimumAvailableMemoryBytes: last.availableMemoryBytes, minimumFreeBytes: last.freeBytes, maximumMemoryPsiAvg10: last.memoryPsiAvg10 };
  let pressureError: unknown, measuring = false, baselineSize = 0, peakDatabaseGrowthBytes = 0;
  const refresh = async () => {
    last = await measureResources(config.storagePath);
    metrics.peakRssBytes = Math.max(metrics.peakRssBytes, last.rssBytes); metrics.minimumAvailableMemoryBytes = Math.min(metrics.minimumAvailableMemoryBytes, last.availableMemoryBytes);
    metrics.minimumFreeBytes = Math.min(metrics.minimumFreeBytes, last.freeBytes); metrics.maximumMemoryPsiAvg10 = Math.max(metrics.maximumMemoryPsiAvg10, last.memoryPsiAvg10);
    assertPreservationResources(config,last,false);
  };
  const checkpoint = createPreservationResourceCheckpoint(config, metrics, () => pressureError);
  const timer = setInterval(() => { if (!measuring) { measuring = true; void refresh().catch(error => { pressureError = error; }).finally(() => { measuring = false; }); } }, 1000); timer.unref();
  const pool = forwardErrorPorts(ports.pool, { async connect(): Promise<PostgresClient> {
    checkpoint(); await refresh(); const client = await ports.pool.connect();
    return createPreservationGuardedClient(client, { checkpoint, deadlineAtMs: config.deadlineAtMs,
      maximumTotalQueries: config.maximumTotalQueries, metrics });
  }, end: () => ports.pool.end() });
  let runtime: ReturnType<typeof createPostgresMigrationRuntime>;
  try { runtime = createPostgresMigrationRuntime({ pool, target: config.target, capability: { mode: "isolated", purpose: "schema_install",
    approvalRef: config.approvalRef, planSha256: config.expected.manifestSha256, expiresAtMs: config.deadlineAtMs },
    assertAuthorized: ports.assertAuthorized, clock: Date.now,
    limits: { operationTimeoutMs: config.maximumTransactionMs, connectionTimeoutMs: Math.min(5000, config.maximumTransactionMs),
      statementTimeoutMs: Math.min(30_000, config.maximumTransactionMs), lockTimeoutMs: Math.min(1000, config.maximumTransactionMs),
      maximumSqlStatements: config.maximumQueriesPerTransaction, workMemKb: 1024, closeTimeoutMs: 5000 } }); }
  catch (error) { clearInterval(timer); throw error; }
  const schema = '"' + config.target.schema + '"';
  const run = async <T>(operation: (tx: PostgresTransaction) => Promise<T>): Promise<T> => {
    checkpoint(); const began = Date.now(); metrics.transactions++;
    try { return await runtime.run(operation); }
    finally { metrics.maximumTransactionMs = Math.max(metrics.maximumTransactionMs, Date.now() - began); }
  };
  const databaseSize = async () => {
    const row = await run(async tx => (await tx.query("SELECT pg_database_size(current_database())::text bytes")).rows[0]);
    ensure(row && typeof row.bytes === "string" && /^[0-9]+$/.test(row.bytes) && BigInt(row.bytes) <= BigInt(Number.MAX_SAFE_INTEGER), "database_size");
    const size = Number(row.bytes); peakDatabaseGrowthBytes = Math.max(peakDatabaseGrowthBytes, size - baselineSize);
    if (baselineSize !== 0) ensure(size - baselineSize <= config.resources.maximumTargetGrowthBytes, "target_growth");
    return size;
  };
  let evidence: Record<string, unknown>;
  const progress={phase:"manifest_preflight",previouslyCommittedChunks:0,resumedChunks:0,newlyCommittedChunks:0,newlyCommittedRows:0,parityChunks:0,parityRows:0,sourceVerifiedAtMs:0,lastAcknowledgedAtMs:0};
  try {
    // Size-only preflight precedes parsing. This low-memory runner refuses oversized resident chunks,
    // rather than silently raising heap/RSS or changing the immutable export.
    const manifestBytes = await readFullDataPreservationSourceFile(config.bundleDirectory, "manifest.json", 8 * 1024 ** 2);
    const manifestPlan = verifyFullDataPreservationManifest(manifestBytes, { maxManifestBytes: 8 * 1024 ** 2, maxRows: 100_000_000 });
    let totalSourceBytes=manifestBytes.length;
    for (const table of manifestPlan.value.tables) for (const chunk of table.chunks) {
      checkpoint(); const info = await lstat(join(config.bundleDirectory, chunk.file));
      ensure(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size <= config.resources.maximumResidentChunkBytes, "resident_chunk_budget");
      totalSourceBytes+=info.size;
    }
    if (ports.residentChunkAllowance) ensure(manifestPlan.value.tables.some(t=>t.chunks.some(c=>c.sha256===ports.residentChunkAllowance!.chunkSha256)),"allowance_source_chunk");
    // Import performs complete filesystem/content verification before its first ledger write.
    // Avoid an additional full 6M-row pass here; parity validates its own source chunk/table digests.
    const bundle={directory:config.bundleDirectory,manifest:manifestPlan,totalRows:manifestPlan.totalRows,totalChunks:manifestPlan.totalChunks,totalBytes:totalSourceBytes},manifest=manifestPlan;
    ensure(manifest.manifestSha256 === config.expected.manifestSha256 && manifest.value.snapshotSha256 === config.expected.snapshotSha256 && manifest.value.catalogFingerprint === config.expected.catalogFingerprint && manifest.value.tables.length === config.expected.tables && bundle.totalRows === config.expected.rows && bundle.totalChunks === config.expected.chunks, "source_pins_or_counts");
    ensure(bundle.totalBytes * 2 <= config.resources.maximumTargetGrowthBytes && manifest.value.limits.rowsPerChunk <= 4096, "sizing_or_chunk_rows");
    baselineSize = await databaseSize(); peakDatabaseGrowthBytes = 0;
    const prior = await run(async tx => {
      const operation = (await tx.query(`SELECT snapshot_sha256,manifest_sha256,completed FROM ${schema}.full_data_preservation_operations WHERE operation_id=$1 LIMIT 2`, [manifest.value.operationId])).rows;
      ensure(operation.length <= 1 && operation.every(row => row.snapshot_sha256 === manifest.value.snapshotSha256 && row.manifest_sha256 === manifest.manifestSha256), "restart_lineage");
      const count = (await tx.query(`SELECT count(*)::text chunks FROM (SELECT ordinal FROM ${schema}.full_data_preservation_chunks WHERE operation_id=$1 LIMIT $2) bounded`, [manifest.value.operationId, bundle.totalChunks + 1])).rows[0];
      ensure(count && typeof count.chunks === "string" && /^[0-9]+$/.test(count.chunks) && Number(count.chunks) <= bundle.totalChunks, "restart_accounting");
      return { chunks: Number(count.chunks), completed: operation[0]?.completed === true };
    });
    let newlyCommitted = 0;
    progress.previouslyCommittedChunks=prior.chunks;progress.phase="import_source_verification";
    const importRunner = { run: async <T>(operation: (tx: PostgresTransaction) => Promise<T>): Promise<T> => {
      let insertedChunk = false, insertedRows=0, existingReceipt=false;
      if(!progress.sourceVerifiedAtMs)progress.sourceVerifiedAtMs=Date.now();progress.phase="import_chunks";
      const result = await withPreservationImportAdmission(config, () => run(tx => operation({ query: async (sql, values) => {
        if (sql.includes("/* preservation:insertChunk */")){ insertedChunk = true; insertedRows=Number(values?.[7]); }
        const rows=await tx.query(sql,values);if(sql.includes("/* preservation:selectChunk */")&&rows.rows.length===1)existingReceipt=true;return rows;
      } })));
      if (insertedChunk){ newlyCommitted++;progress.newlyCommittedChunks=newlyCommitted;progress.newlyCommittedRows+=insertedRows;progress.lastAcknowledgedAtMs=Date.now(); }
      else if(existingReceipt)progress.resumedChunks++;
      if (metrics.transactions % 25 === 0) await databaseSize();
      if (config.stage === "interrupt" && newlyCommitted >= config.interruptAfterCommittedChunks) throw new RestartAfterCommit();
      return result;
    } };
    let imported: unknown = null;
    if (config.stage !== "parity") {
      try { imported = await importFullDataPreservationBundle({ bundleDirectory: config.bundleDirectory, unitOfWork: importRunner, checkpoint,
        target: { schema: config.target.schema, database: config.target.database, role: config.target.username },
        executionBudget: { deadlineAtMs: config.deadlineAtMs, maximumTransactionMs: config.maximumTransactionMs,
          maximumQueriesPerTransaction: Math.max(1, config.maximumQueriesPerTransaction - 8), maximumTotalQueries: config.maximumTotalQueries,
          opaqueRowWindows: {maximumRows:64,maximumBytes:512*1024} }, limits: { maxRows: 100_000_000,maxRowBytes:2*1024**2 } }); }
      catch (error) { if (!(error instanceof RestartAfterCommit) && !(error instanceof PreservationImportYield)) throw error;
        evidence = { status: error instanceof PreservationImportYield ? "yielded_before_transaction" : "interrupted_after_durable_commit", previouslyCommittedChunks: prior.chunks, newlyCommittedChunks: newlyCommitted,
          reconciliationRequired: true, parityComplete: false }; imported = evidence;
      }
    }
    if (config.stage === "interrupt") { ensure(newlyCommitted >= config.interruptAfterCommittedChunks, "interruption_not_exercised"); evidence = imported as Record<string, unknown>; }
    else if (config.stage === "import") {
      const result = imported as Record<string, unknown>;
      evidence = result.status === "yielded_before_transaction" ? result : {
        status: "import_completed_pending_parity", imported, previouslyCommittedChunks: prior.chunks,
        reconciliationRequired: true, parityComplete: false,
      };
    }
    else {
      progress.phase="independent_parity";
      const totals = { rows: 0, chunks: 0, cells: { integer: 0, real: 0, text: 0, blob: 0, null: 0 }, integersBeyondSafeRange: 0, blobBytes: 0, textBytes: 0, rowBytes: 0 };
      for (const table of manifest.value.tables) {
        const content = createHash("sha256");
        for (const plan of table.chunks) {
          checkpoint(); const bytes = await readFullDataPreservationSourceFile(bundle.directory, plan.file, config.resources.maximumResidentChunkBytes);
          const chunk = verifyOpaqueFullDataPreservationChunk(bytes, manifest, table.name, plan.ordinal,{maxRowBytes:2*1024**2});
          const measured = await run(async tx => {
            const receipt = (await tx.query(`SELECT sha256,snapshot_sha256,manifest_sha256,octet_length(chunk_body)::text chunk_bytes FROM ${schema}.full_data_preservation_chunks WHERE operation_id=$1 AND table_name=$2 AND ordinal=$3 LIMIT 2`, [manifest.value.operationId, table.name, plan.ordinal])).rows;
            ensure(receipt.length === 1 && receipt[0]!.snapshot_sha256 === manifest.value.snapshotSha256 && receipt[0]!.manifest_sha256 === manifest.manifestSha256 && receipt[0]!.sha256 === plan.sha256 && receipt[0]!.chunk_bytes===String(bytes.length), "parity_receipt");
            for(let offset=0;offset<bytes.length;offset+=512*1024){
              const slice=(await tx.query(`SELECT substring(chunk_body FROM $4 FOR $5) body FROM ${schema}.full_data_preservation_chunks WHERE operation_id=$1 AND table_name=$2 AND ordinal=$3`,[manifest.value.operationId,table.name,plan.ordinal,offset+1,Math.min(512*1024,bytes.length-offset)])).rows;
              ensure(slice.length===1 && Buffer.isBuffer(slice[0]!.body) && slice[0]!.body.equals(bytes.subarray(offset,offset+512*1024)),"parity_receipt_slice");
            }
            // PK ordinal range bounds work; window sum caps the entire wire payload, not only each row.
            const measured={rows:0,cells:{integer:0,real:0,text:0,blob:0,null:0},integersBeyondSafeRange:0,blobBytes:0,textBytes:0,rowBytes:0};
            for(const page of preservationRowByteWindows(chunk.rowBodies,64,512*1024)){
            const bodies=chunk.rowBodies.slice(page.start,page.end);
            const rows = (await tx.query(`SELECT operation_id,table_name,snapshot_sha256,manifest_sha256,row_ordinal::text,chunk_ordinal::text,
              CASE WHEN sum(octet_length(row_body)) OVER() <= $5 THEN row_body END row_body
              FROM ${schema}.full_data_preservation_rows AS preserved_rows WHERE operation_id=$1 AND table_name=$2 AND row_ordinal >= $3 AND row_ordinal < $4 ORDER BY preserved_rows.row_ordinal LIMIT $6`,
            [manifest.value.operationId, table.name, plan.startRow+page.start, plan.startRow+page.end, config.resources.maximumResidentChunkBytes, bodies.length+1])).rows;
            const part=verifyPreservationParityChunk(manifest,{...chunk,rowBodies:bodies,plan:{...plan,startRow:plan.startRow+page.start,rowCount:bodies.length}},rows);
            for(const key of ["rows","integersBeyondSafeRange","blobBytes","textBytes","rowBytes"] as const)measured[key]+=part[key];
            for(const key of ["integer","real","text","blob","null"] as const)measured.cells[key]+=part.cells[key];
            }
            return measured;
          });
          totals.chunks++; for (const key of ["rows", "integersBeyondSafeRange", "blobBytes", "textBytes", "rowBytes"] as const) totals[key] += measured[key];
          progress.parityChunks=totals.chunks;progress.parityRows=totals.rows;
          for (const key of ["integer", "real", "text", "blob", "null"] as const) totals.cells[key] += measured.cells[key];
          for (const body of chunk.rowBodies) { content.update(body); content.update("\n"); }
          if (totals.chunks % 25 === 0) await databaseSize();
        }
        ensure(content.digest("hex") === table.contentSha256, "parity_table_digest");
        const count = await run(async tx => (await tx.query(`SELECT count(*)::text rows FROM (SELECT row_ordinal FROM ${schema}.full_data_preservation_rows WHERE operation_id=$1 AND table_name=$2 LIMIT $3) bounded`, [manifest.value.operationId, table.name, table.rowCount + 1])).rows[0]);
        ensure(count?.rows === String(table.rowCount), "parity_table_accounting");
      }
      const completed = await run(async tx => (await tx.query(`SELECT completed FROM ${schema}.full_data_preservation_operations WHERE operation_id=$1 AND snapshot_sha256=$2 AND manifest_sha256=$3 LIMIT 2`, [manifest.value.operationId, manifest.value.snapshotSha256, manifest.manifestSha256])).rows);
      ensure(completed.length === 1 && completed[0]!.completed === true && totals.rows === bundle.totalRows && totals.chunks === bundle.totalChunks, "parity_completion");
      evidence = { status: "completed", imported, previouslyCommittedChunks: prior.chunks, restartReconciliationObserved: prior.chunks > 0,
        parityComplete: true, typedBytes: totals, databaseEncoding: manifest.value.catalog.pragmas.encoding };
    }
    await databaseSize(); await refresh(); checkpoint();
  } catch (error) { evidence = { status: "failed", reason: safeError(error), failure: classifyPreservationFailure(error), parityComplete: false, reconciliationRequired: true }; }
  finally { clearInterval(timer); await runtime.close(); }
  const report = { version: 1, runId, stage: config.stage, expected: config.expected, target: config.target, ...evidence,
    status: evidence.status, parityComplete: evidence.parityComplete,
    elapsedMs: Date.now() - startedAt, metrics, progress,
    acknowledgedRowsPerSecond:progress.sourceVerifiedAtMs && progress.newlyCommittedRows ? progress.newlyCommittedRows/Math.max(0.001,(progress.lastAcknowledgedAtMs-progress.sourceVerifiedAtMs)/1000):0,
    peakDatabaseGrowthBytes, baselineDatabaseBytes: baselineSize,
    sourceWrites: false, businessActivation: false, productionAuthorized: false, grantsBusinessEligibility: false,
    limitations: ["backup-derived rehearsal, not a fenced production snapshot", "raw chunks plus row bodies duplicate payload before indexes/WAL", "no business/cohort/fresh-chain projection", "exclusive preservation-role authority required"] };
  await writeFile(join(config.evidenceDirectory, runId + ".json"), JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    ensure(process.argv.length === 6 && process.argv[2] === "--config" && process.argv[4] === "--config-sha256", "arguments");
    const bytes = await readPrivatePreservationFile(resolve(process.argv[3]!), 64 * 1024);
    ensure(digest(bytes) === process.argv[5], "external_config_pin");
    const config = validatePreservationRehearsalConfig(JSON.parse(bytes.toString("utf8")));
    const moduleBytes = await readPrivatePreservationFile(config.authorityModule, 1024 * 1024);
    ensure(digest(moduleBytes) === config.authorityModuleSha256, "external_module_pin");
    const adapter = await import(pathToFileURL(config.authorityModule).href) as { createPreservationFixturePorts?: (config: PreservationRehearsalConfig) => Promise<PreservationFixturePorts> };
    ensure(typeof adapter.createPreservationFixturePorts === "function", "authority_adapter");
    const report = await runFullPreservationRehearsal(config, await adapter.createPreservationFixturePorts(config));
    process.stdout.write(JSON.stringify({ runId: report.runId, status: report.status, parityComplete: report.parityComplete, productionAuthorized: false }) + "\n");
    process.exitCode = report.status === "failed" ? 1 : 0;
  } catch (error) { process.stderr.write(JSON.stringify({ status: "blocked", reason: safeError(error), productionAuthorized: false }) + "\n"); process.exitCode = 1; }
}
