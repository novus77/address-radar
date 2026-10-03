import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { PreservedSqliteValue } from "./full-data-row-protection.js";

export const GLOBAL_GUARD_LEDGER_TABLES = [
  "broadcast_records", "evidence_consumption", "economic_evidence_consumption",
  "outcome_observations", "signal_outbox", "signal_outbox_migration_review",
  "provider_budget_usage", "provider_request_gates", "historical_backfill_credit_usage",
] as const;

export interface GuardLedgerCell {
  name: string;
  value: PreservedSqliteValue;
}
export interface GuardLedgerRow {
  key: readonly GuardLedgerCell[];
  values: readonly GuardLedgerCell[];
  fingerprint: string;
}
export interface GuardLedgerPage {
  snapshotId: string;
  sequence: number;
  table: string;
  pageNumber: number;
  previousFingerprint: string | null;
  rows: readonly GuardLedgerRow[];
  fingerprint: string;
}
export interface GuardLedgerManifest {
  table: string;
  schemaFingerprint: string;
  primaryKey: readonly string[];
  columns: readonly string[];
  rows: number;
  pages: number;
  complete: boolean;
  contentFingerprint: string;
}
export interface GlobalGuardSnapshotReport {
  version: 1;
  scope: "global_guard_ledgers_not_purchase_dependencies";
  snapshotId: string;
  capturedAtMs: number;
  completedAtMs: number;
  status: "complete" | "blocked";
  sourceLedgerCoverageComplete: boolean;
  exportAcknowledged: boolean;
  rowCount: number;
  pageCount: number;
  bytesRead: number;
  ledgers: readonly GuardLedgerManifest[];
  issues: readonly { code: string; table: string }[];
  sourceFingerprint: string;
  targetRoundTripVerified: false;
  purchaseDependenciesVerified: false;
  newEligibilityGranted: false;
  productionMigrationReady: false;
}
export interface GlobalGuardSnapshotOptions {
  pageSize?: number;
  maximumRows?: number;
  maximumBytes?: number;
  maximumDurationMs?: number;
  pageSink?: (page: GuardLedgerPage, signal: AbortSignal) => string | Promise<string>;
}

const primaryKeys: Readonly<Record<string, readonly string[]>> = {
  broadcast_records: ["broadcast_id"], evidence_consumption: ["event_id"],
  economic_evidence_consumption: ["dedupe_key"], outcome_observations: ["broadcast_id", "horizon"],
  signal_outbox: ["outbox_id"], signal_outbox_migration_review: ["review_id"],
  provider_budget_usage: ["provider", "usage_window"], provider_request_gates: ["provider"],
  historical_backfill_credit_usage: ["usage_day"],
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
const validLimit = (value: number, maximum: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= maximum;

function preserve(value: unknown, storage: unknown): PreservedSqliteValue {
  let result: PreservedSqliteValue;
  if (storage === "null" && value === null) result = { storage: "null" };
  else if (storage === "integer" && typeof value === "bigint") result = { storage: "integer", value: value.toString() };
  else if (storage === "real" && typeof value === "number" && Number.isFinite(value)) {
    result = { storage: "real", value: Object.is(value, -0) ? "-0" : value.toString() };
  } else if (storage === "text" && typeof value === "string") result = { storage: "text", value };
  else if (storage === "blob" && value instanceof Uint8Array) result = { storage: "blob", value: Buffer.from(value).toString("base64") };
  else throw new Error("invalid_guard_storage_value");
  return Object.freeze(result);
}

/** One read transaction; complete ledger coverage is not purchase or target acceptance. */
export async function readOnlyGlobalGuardSnapshot(
  databasePath: string, options: GlobalGuardSnapshotOptions = {},
): Promise<GlobalGuardSnapshotReport> {
  const pageSize = options.pageSize ?? 256;
  const maximumRows = options.maximumRows ?? 100_000;
  const maximumBytes = options.maximumBytes ?? 32 * 1024 * 1024;
  const maximumDurationMs = options.maximumDurationMs ?? 5000;
  if (!validLimit(pageSize, 1000) || !validLimit(maximumRows, 1_000_000) ||
      !validLimit(maximumBytes, 64 * 1024 * 1024) || !validLimit(maximumDurationMs, 30_000)) {
    throw new Error("invalid_guard_snapshot_limits");
  }
  if (options.pageSink !== undefined && typeof options.pageSink !== "function") throw new Error("invalid_guard_snapshot_sink");
  const path = realpathSync(databasePath);
  if (!statSync(path).isFile()) throw new Error("guard_snapshot_source_not_regular_file");
  const startedAt = performance.now();
  const controller = new AbortController();
  const snapshotId = randomUUID();
  const issues: { code: string; table: string }[] = [];
  const ledgers: GuardLedgerManifest[] = [];
  let capturedAtMs = Date.now(), rowCount = 0, pageCount = 0, bytesRead = 0;
  let previousFingerprint: string | null = null;
  let currentTable = "source", transactionOpen = false;
  const database = new DatabaseSync(path, { readOnly: true });
  const addIssue = (code: string): void => { issues.push({ code, table: currentTable }); };
  const timeRemaining = (): number => maximumDurationMs - (performance.now() - startedAt);
  const checkTime = (): boolean => {
    if (timeRemaining() > 0) return true;
    addIssue("guard_time_budget_exhausted"); return false;
  };
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250; BEGIN");
    transactionOpen = true;
    // This first read pins the snapshot before any sink can await or another writer can commit.
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
    capturedAtMs = Date.now();
    for (const table of GLOBAL_GUARD_LEDGER_TABLES) {
      currentTable = table;
      const definition = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
      const columns = database.prepare("PRAGMA table_xinfo(" + quote(table) + ")").all();
      const key = columns.filter(column => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
      const names = columns.map(column => String(column.name));
      const schemaFingerprint = hash({ table, definition: definition?.sql ?? null, columns });
      ledgers.push({ table, schemaFingerprint, primaryKey: key, columns: names, rows: 0, pages: 0,
        complete: false, contentFingerprint: hash([table, schemaFingerprint]) });
      if (!definition || !columns.length) addIssue("missing_guard_ledger");
      else if (typeof definition.sql !== "string" || /^CREATE\s+VIRTUAL\s+TABLE/i.test(definition.sql) ||
        columns.some(column => Number(column.hidden) !== 0) || names.some(name => name.startsWith("__guard_"))) {
        addIssue("unsupported_guard_schema");
      } else if (JSON.stringify(key) !== JSON.stringify(primaryKeys[table])) addIssue("unsupported_guard_primary_key");
      else {
        const plan = database.prepare("EXPLAIN QUERY PLAN SELECT " + key.map(quote).join(",") +
          " FROM " + quote(table) + " ORDER BY " + key.map(quote).join(",") + " LIMIT 1").all();
        if (plan.some(row => String(row.detail).includes("USE TEMP B-TREE"))) addIssue("unindexed_guard_order");
      }
      if (!checkTime()) break;
    }
    if (issues.length === 0) {
      ledgerLoop: for (const ledger of ledgers) {
        currentTable = ledger.table;
        let cursor: SQLInputValue[] | null = null;
        let previousKeyFingerprint: string | null = null;
        const orderedKey = ledger.primaryKey.map(quote).join(",");
        const projections = ledger.columns.flatMap((name, index) => [
          quote(name), "typeof(" + quote(name) + ") AS " + quote("__guard_storage_" + index),
        ]).join(",");
        const sizeExpression = ledger.columns.map(name => "coalesce(length(CAST(" + quote(name) + " AS BLOB)),0)").join("+");
        while (checkTime()) {
          const remainingRows = maximumRows - rowCount;
          const limit = Math.min(pageSize, remainingRows + 1);
          const predicate = cursor ? " WHERE (" + orderedKey + ") > (" + cursor.map(() => "?").join(",") + ")" : "";
          const suffix = " FROM " + quote(ledger.table) + predicate + " ORDER BY " + orderedKey + " LIMIT ?";
          const bindings: SQLInputValue[] = [...(cursor ?? []), limit];
          // Inspect sizes before materializing raw payloads, not after allocating an oversized page.
          const sizeStatement = database.prepare("SELECT (" + sizeExpression + ") AS __guard_source_bytes" + suffix);
          sizeStatement.setReadBigInts(true);
          const sizes = sizeStatement.all(...bindings);
          if (sizes.length === 0) { ledger.complete = true; break; }
          if (sizes.length > remainingRows) { addIssue("guard_row_budget_exhausted"); break ledgerLoop; }
          let rawBytes = 0n;
          for (const size of sizes) {
            if (typeof size.__guard_source_bytes !== "bigint" || size.__guard_source_bytes < 0n) throw new Error("invalid_guard_storage_value");
            rawBytes += size.__guard_source_bytes;
          }
          if (rawBytes > BigInt(maximumBytes - bytesRead)) { addIssue("guard_byte_budget_exhausted"); break ledgerLoop; }
          if (!checkTime()) break ledgerLoop;
          const statement = database.prepare("SELECT " + projections + suffix);
          statement.setReadBigInts(true);
          const sourceRows = statement.all(...bindings);
          const rows: GuardLedgerRow[] = [];
          let pageBytes = 0;
          for (const sourceRow of sourceRows) {
            const values = Object.freeze(ledger.columns.map((name, index) => Object.freeze({
              name, value: preserve(sourceRow[name], sourceRow["__guard_storage_" + index]),
            })));
            const key = Object.freeze(ledger.primaryKey.map(name => values.find(cell => cell.name === name)!));
            if (key.some(cell => cell.value.storage === "null")) { addIssue("invalid_guard_primary_key"); break ledgerLoop; }
            const fingerprint = hash({ table: ledger.table, key, values });
            pageBytes += Buffer.byteLength(JSON.stringify({ key, values, fingerprint }));
            if (bytesRead + pageBytes > maximumBytes) { addIssue("guard_byte_budget_exhausted"); break ledgerLoop; }
            rows.push(Object.freeze({ key, values, fingerprint }));
          }
          const last = sourceRows[sourceRows.length - 1]!;
          const nextCursor = ledger.primaryKey.map(name => last[name] as SQLInputValue);
          const keyFingerprint = hash(rows[rows.length - 1]!.key);
          if (keyFingerprint === previousKeyFingerprint) { addIssue("non_advancing_guard_cursor"); break ledgerLoop; }
          const pageIdentity: Omit<GuardLedgerPage, "rows" | "fingerprint"> & { rows: readonly string[] } = {
            snapshotId, sequence: pageCount, table: ledger.table,
            pageNumber: ledger.pages, previousFingerprint, rows: rows.map(row => row.fingerprint) };
          const page: GuardLedgerPage = Object.freeze({ ...pageIdentity, rows: Object.freeze(rows), fingerprint: hash(pageIdentity) });
          if (!checkTime()) break ledgerLoop;
          if (options.pageSink) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const deadline = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error("guard_time_budget_exhausted")); }, Math.max(1, timeRemaining()));
              });
              const acknowledgement = await Promise.race([
                Promise.resolve().then(() => options.pageSink!(page, controller.signal)), deadline,
              ]);
              if (acknowledgement !== page.fingerprint) { addIssue("guard_page_acknowledgement_mismatch"); break ledgerLoop; }
            } catch (error) {
              addIssue(error instanceof Error && error.message === "guard_time_budget_exhausted" ?
                "guard_time_budget_exhausted" : "guard_page_sink_failed");
              break ledgerLoop;
            } finally { if (timer !== undefined) clearTimeout(timer); }
          }
          if (!checkTime()) break ledgerLoop;
          for (const row of rows) ledger.contentFingerprint = hash([ledger.contentFingerprint, row.fingerprint]);
          ledger.rows += rows.length; ledger.pages++;
          rowCount += rows.length; pageCount++; bytesRead += pageBytes;
          previousFingerprint = page.fingerprint;
          cursor = nextCursor; previousKeyFingerprint = keyFingerprint;
        }
        if (issues.length) break;
      }
    }
  } catch (error) {
    addIssue(error instanceof Error && error.message === "invalid_guard_storage_value" ?
      "invalid_guard_storage_value" : "guard_sqlite_read_failed");
  } finally {
    controller.abort();
    if (transactionOpen) {
      try { database.exec("ROLLBACK"); } catch { addIssue("guard_read_transaction_close_failed"); }
    }
    database.close();
  }
  const sourceLedgerCoverageComplete = issues.length === 0 && ledgers.length === GLOBAL_GUARD_LEDGER_TABLES.length &&
    ledgers.every(ledger => ledger.complete);
  return {
    version: 1, scope: "global_guard_ledgers_not_purchase_dependencies", snapshotId, capturedAtMs,
    completedAtMs: Date.now(), status: sourceLedgerCoverageComplete ? "complete" : "blocked",
    sourceLedgerCoverageComplete, exportAcknowledged: sourceLedgerCoverageComplete && options.pageSink !== undefined,
    rowCount, pageCount, bytesRead, ledgers, issues,
    sourceFingerprint: hash({ snapshotId, capturedAtMs, ledgers, issues, previousFingerprint }),
    targetRoundTripVerified: false, purchaseDependenciesVerified: false,
    newEligibilityGranted: false, productionMigrationReady: false,
  };
}
