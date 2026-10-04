import { createHash } from "node:crypto";
import type { PostgresAcceptanceRuntime } from "./postgres-acceptance-driver.js";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";
import {
  GLOBAL_GUARD_LEDGER_TABLES, readOnlyGlobalGuardSnapshot,
  type GlobalGuardSnapshotOptions, type GlobalGuardSnapshotReport, type GuardLedgerPage,
  type GuardLedgerCell, type GuardLedgerRow,
} from "./global-guard-snapshot-preflight.js";

export interface GuardLedgerRoundTripSummary {
  sourceRows: number;
  sourcePages: number;
  sourceFingerprint: string;
  snapshotId: string;
  purchaseDependenciesVerified: false;
  productionMigrationReady: false;
}
export interface PostgresGlobalGuardAcceptanceReport extends GuardLedgerRoundTripSummary {
  status: "passed";
  scope: "isolated_guard_page_round_trip_not_business_schema";
  ledgerCount: 9;
  targetRoundTripVerified: true;
  successCommitDropsTemporaryTables: true;
  partialFailureRollback: true;
  sameSessionCleanupVerified: true;
  exactObservedStorageValues: true;
  businessActivation: false;
  gatewayDeliveryEnabled: false;
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const tables = new Set<string>(GLOBAL_GUARD_LEDGER_TABLES);
const maximumPayloadBytes = 64 * 1024 * 1024 + 65536;

function validateCell(cell: GuardLedgerCell): void {
  if (!cell || typeof cell.name !== "string" || !cell.name.trim() || !cell.value || typeof cell.value !== "object") {
    throw new Error("invalid_guard_storage_cell");
  }
  const value = cell.value;
  let valid = false;
  if (value.storage === "null") valid = Object.keys(value).length === 1;
  else if (typeof value.value === "string" && Object.keys(value).length === 2) {
    if (value.storage === "text") valid = true;
    else if (value.storage === "blob") valid = Buffer.from(value.value, "base64").toString("base64") === value.value;
    else if (value.storage === "integer" && /^-?(?:0|[1-9]\d*)$/.test(value.value)) {
      const integer = BigInt(value.value);
      valid = integer >= -9223372036854775808n && integer <= 9223372036854775807n;
    } else if (value.storage === "real") {
      valid = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.value) && Number.isFinite(Number(value.value));
    }
  }
  if (!valid) throw new Error("invalid_guard_storage_cell");
}

function validatePage(page: GuardLedgerPage): void {
  if (!page || typeof page !== "object" || typeof page.snapshotId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(page.snapshotId) ||
      !count(page.sequence) || !count(page.pageNumber) || !tables.has(page.table) ||
      !Array.isArray(page.rows) || !page.rows.length || page.rows.length > 1000 ||
      !(page.previousFingerprint === null || digest(page.previousFingerprint)) || !digest(page.fingerprint)) {
    throw new Error("invalid_guard_page_payload");
  }
  const rows: readonly GuardLedgerRow[] = page.rows;
  for (const row of rows) {
    if (!row || !Array.isArray(row.key) || !row.key.length || !Array.isArray(row.values) || !row.values.length || !digest(row.fingerprint)) {
      throw new Error("invalid_guard_page_payload");
    }
    const values: readonly GuardLedgerCell[] = row.values;
    const key: readonly GuardLedgerCell[] = row.key;
    const names = new Set<string>();
    for (const cell of values) {
      validateCell(cell);
      if (names.has(cell.name)) throw new Error("invalid_guard_storage_cell");
      names.add(cell.name);
    }
    const keyNames = new Set<string>();
    for (const cell of key) {
      validateCell(cell);
      if (cell.value.storage === "null" || keyNames.has(cell.name) ||
          JSON.stringify(values.find(value => value.name === cell.name)) !== JSON.stringify(cell)) {
        throw new Error("invalid_guard_row_key");
      }
      keyNames.add(cell.name);
    }
    if (hash({ table: page.table, key, values }) !== row.fingerprint) throw new Error("guard_row_fingerprint_mismatch");
  }
  if (hash({ snapshotId: page.snapshotId, sequence: page.sequence, table: page.table,
    pageNumber: page.pageNumber, previousFingerprint: page.previousFingerprint,
    rows: rows.map(row => row.fingerprint) }) !== page.fingerprint) throw new Error("guard_page_fingerprint_mismatch");
}

/** Opaque BYTEA staging preserves observed values; it is not target business typing. */
export function encodeGuardLedgerPage(page: GuardLedgerPage): Buffer {
  validatePage(page);
  const payload = Buffer.from(JSON.stringify(page), "utf8");
  if (payload.length > maximumPayloadBytes) throw new Error("guard_page_payload_too_large");
  return payload;
}
export function decodeGuardLedgerPage(payload: Buffer): GuardLedgerPage {
  if (!Buffer.isBuffer(payload) || payload.length > maximumPayloadBytes) throw new Error("invalid_guard_page_payload");
  let page: GuardLedgerPage;
  try { page = JSON.parse(payload.toString("utf8")) as GuardLedgerPage; }
  catch { throw new Error("invalid_guard_page_payload"); }
  validatePage(page);
  if (!payload.equals(Buffer.from(JSON.stringify(page), "utf8"))) throw new Error("guard_page_serialization_mismatch");
  return page;
}

export function verifyGuardLedgerRoundTrip(
  source: GlobalGuardSnapshotReport, pages: readonly GuardLedgerPage[],
): GuardLedgerRoundTripSummary {
  if (source.version !== 1 || source.scope !== "global_guard_ledgers_not_purchase_dependencies" ||
      source.status !== "complete" || !source.sourceLedgerCoverageComplete || !source.exportAcknowledged ||
      !Array.isArray(source.issues) || source.issues.length || !count(source.rowCount) || !count(source.pageCount) ||
      !count(source.bytesRead) || !count(source.capturedAtMs) || !count(source.completedAtMs) ||
      source.completedAtMs < source.capturedAtMs || !digest(source.sourceFingerprint)) {
    throw new Error("guard_source_not_fully_exported");
  }
  if (source.ledgers.length !== 9 || source.ledgers.some((ledger, index) =>
    ledger.table !== GLOBAL_GUARD_LEDGER_TABLES[index] || !ledger.complete || !count(ledger.rows) || !count(ledger.pages) ||
    !digest(ledger.schemaFingerprint) || !digest(ledger.contentFingerprint) || !Array.isArray(ledger.primaryKey) ||
    !ledger.primaryKey.length || !Array.isArray(ledger.columns) || new Set(ledger.columns).size !== ledger.columns.length)) {
    throw new Error("guard_ledger_manifest_mismatch");
  }
  if (pages.length !== source.pageCount) throw new Error("guard_page_count_mismatch");
  const observed = new Map(source.ledgers.map(ledger => [ledger.table, {
    rows: 0, pages: 0, fingerprint: hash([ledger.table, ledger.schemaFingerprint]),
  }]));
  let previousFingerprint: string | null = null, lastTableIndex = -1, rowCount = 0, bytesRead = 0;
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    if (page.sequence !== index) throw new Error("guard_page_sequence_mismatch");
    if (page.snapshotId !== source.snapshotId) throw new Error("guard_snapshot_identity_mismatch");
    validatePage(page);
    if (page.previousFingerprint !== previousFingerprint) throw new Error("guard_page_chain_mismatch");
    const tableIndex = source.ledgers.findIndex(ledger => ledger.table === page.table);
    const ledger = source.ledgers[tableIndex]!;
    const current = observed.get(page.table)!;
    if (tableIndex < lastTableIndex || page.pageNumber !== current.pages) throw new Error("guard_ledger_order_mismatch");
    for (const row of page.rows) {
      if (JSON.stringify(row.key.map(cell => cell.name)) !== JSON.stringify(ledger.primaryKey) ||
          JSON.stringify(row.values.map(cell => cell.name)) !== JSON.stringify(ledger.columns)) {
        throw new Error("guard_ledger_schema_mismatch");
      }
      current.fingerprint = hash([current.fingerprint, row.fingerprint]);
      current.rows++; rowCount++;
      bytesRead += Buffer.byteLength(JSON.stringify({ key: row.key, values: row.values, fingerprint: row.fingerprint }));
    }
    current.pages++;
    previousFingerprint = page.fingerprint; lastTableIndex = tableIndex;
  }
  for (const ledger of source.ledgers) {
    const current = observed.get(ledger.table)!;
    if (current.rows !== ledger.rows || current.pages !== ledger.pages || current.fingerprint !== ledger.contentFingerprint) {
      throw new Error("guard_ledger_manifest_mismatch");
    }
  }
  if (rowCount !== source.rowCount || bytesRead !== source.bytesRead) throw new Error("guard_ledger_manifest_mismatch");
  if (hash({ snapshotId: source.snapshotId, capturedAtMs: source.capturedAtMs,
    ledgers: source.ledgers, issues: source.issues, previousFingerprint }) !== source.sourceFingerprint) {
    throw new Error("guard_source_fingerprint_mismatch");
  }
  return { sourceRows: rowCount, sourcePages: pages.length, sourceFingerprint: source.sourceFingerprint,
    snapshotId: source.snapshotId, purchaseDependenciesVerified: false, productionMigrationReady: false };
}

async function cleanSession(transaction: PostgresTransaction, expectedPid?: number): Promise<number> {
  const result = await transaction.query(`SELECT pg_backend_pid() AS backend_pid,
    current_database() AS database_name, current_user AS username,
    to_regclass('pg_temp.address_radar_guard_pages_acceptance')::text AS pages_table,
    to_regclass('pg_temp.address_radar_guard_manifest_acceptance')::text AS manifest_table`);
  const row = result.rows[0];
  if (!row || row.database_name !== "address_radar_acceptance_test" || row.username !== "address_radar_acceptance" ||
      !count(row.backend_pid) || row.backend_pid === 0 || (expectedPid !== undefined && row.backend_pid !== expectedPid)) {
    throw new Error("guard_acceptance_session_scope_mismatch");
  }
  if (row.pages_table !== null || row.manifest_table !== null) throw new Error("guard_acceptance_temporary_tables_not_clean");
  return row.backend_pid;
}

async function createTemporaryTables(transaction: PostgresTransaction): Promise<void> {
  await transaction.query(`CREATE TEMP TABLE address_radar_guard_pages_acceptance (
    sequence INTEGER PRIMARY KEY, payload BYTEA NOT NULL
  ) ON COMMIT DROP`);
  await transaction.query(`CREATE TEMP TABLE address_radar_guard_manifest_acceptance (
    singleton BOOLEAN PRIMARY KEY CHECK (singleton), payload BYTEA NOT NULL
  ) ON COMMIT DROP`);
}

export async function verifyPostgresGlobalGuardRoundTrip(
  runtime: PostgresAcceptanceRuntime, databasePath: string,
  options: Omit<GlobalGuardSnapshotOptions, "pageSink"> = {},
): Promise<PostgresGlobalGuardAcceptanceReport> {
  const identity = await runtime.probe();
  if (identity.database !== "address_radar_acceptance_test" || identity.username !== "address_radar_acceptance" ||
      !["127.0.0.1", "::1"].includes(identity.serverAddress) || runtime.statistics().totalConnections !== 1) {
    throw new Error("guard_acceptance_requires_isolated_single_connection");
  }
  const success = await runtime.run(async transaction => {
    const backendPid = await cleanSession(transaction);
    await createTemporaryTables(transaction);
    const sinkState: { pending: Promise<string> | null } = { pending: null };
    const source = await readOnlyGlobalGuardSnapshot(databasePath, {
      ...options,
      pageSink: (page, signal) => {
        const operation = (async (): Promise<string> => {
          if (signal.aborted) throw new Error("guard_target_sink_aborted");
          await transaction.query("INSERT INTO pg_temp.address_radar_guard_pages_acceptance(sequence,payload) VALUES($1,$2)",
            [page.sequence, encodeGuardLedgerPage(page)]);
          if (signal.aborted) throw new Error("guard_target_sink_aborted");
          return page.fingerprint;
        })();
        sinkState.pending = operation;
        void operation.then(() => { if (sinkState.pending === operation) sinkState.pending = null; }, () => { if (sinkState.pending === operation) sinkState.pending = null; });
        return operation;
      },
    });
    // A timed-out source sink can still have a bounded PG query in flight. Settle it before rollback.
    const residual = sinkState.pending;
    if (residual) await residual.catch(() => undefined);
    if (!source.sourceLedgerCoverageComplete || !source.exportAcknowledged) throw new Error("guard_source_export_incomplete");
    const manifestPayload = Buffer.from(JSON.stringify(source), "utf8");
    await transaction.query("INSERT INTO pg_temp.address_radar_guard_manifest_acceptance(singleton,payload) VALUES(true,$1)", [manifestPayload]);
    const storedManifest = await transaction.query("SELECT payload FROM pg_temp.address_radar_guard_manifest_acceptance");
    if (storedManifest.rows.length !== 1 || !Buffer.isBuffer(storedManifest.rows[0]?.payload) ||
        !storedManifest.rows[0].payload.equals(manifestPayload)) throw new Error("guard_target_manifest_mismatch");
    const restoredPages: GuardLedgerPage[] = [];
    for (let sequence = 0; sequence < source.pageCount; sequence++) {
      const result = await transaction.query("SELECT payload FROM pg_temp.address_radar_guard_pages_acceptance WHERE sequence=$1", [sequence]);
      if (result.rows.length !== 1 || !Buffer.isBuffer(result.rows[0]?.payload)) throw new Error("guard_target_page_missing");
      restoredPages.push(decodeGuardLedgerPage(result.rows[0].payload));
    }
    const targetCount = await transaction.query("SELECT count(*)::text AS page_count FROM pg_temp.address_radar_guard_pages_acceptance");
    if (targetCount.rows[0]?.page_count !== String(source.pageCount)) throw new Error("guard_target_page_count_mismatch");
    const summary = verifyGuardLedgerRoundTrip(source, restoredPages);
    return { backendPid, summary, manifestPayload };
  });
  await runtime.run(transaction => cleanSession(transaction, success.backendPid));

  let failedPid: number | null = null, partialWriteObserved = false;
  try {
    await runtime.run(async transaction => {
      failedPid = await cleanSession(transaction, success.backendPid);
      await createTemporaryTables(transaction);
      await transaction.query("INSERT INTO pg_temp.address_radar_guard_manifest_acceptance(singleton,payload) VALUES(true,$1)", [success.manifestPayload]);
      const prefix = await transaction.query("SELECT count(*)::text AS rows_written FROM pg_temp.address_radar_guard_manifest_acceptance");
      partialWriteObserved = prefix.rows[0]?.rows_written === "1";
      if (!partialWriteObserved) throw new Error("guard_failure_prefix_not_observed");
      await transaction.query("INSERT INTO pg_temp.address_radar_guard_manifest_acceptance(singleton,payload) VALUES(true,$1)", [success.manifestPayload]);
      throw new Error("guard_forced_failure_did_not_fail");
    });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "23505" ||
        !partialWriteObserved || failedPid !== success.backendPid) throw new Error("guard_partial_rollback_probe_failed");
  }
  await runtime.run(transaction => cleanSession(transaction, success.backendPid));
  return { ...success.summary, status: "passed", scope: "isolated_guard_page_round_trip_not_business_schema",
    ledgerCount: 9, targetRoundTripVerified: true, successCommitDropsTemporaryTables: true,
    partialFailureRollback: true, sameSessionCleanupVerified: true, exactObservedStorageValues: true,
    businessActivation: false, gatewayDeliveryEnabled: false };
}
