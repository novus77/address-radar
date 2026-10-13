const preservationUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type { createPostgresUnitOfWork, PostgresTransaction } from "./postgres-unit-of-work.js";

export interface FullDataPreservationLimits {
  readonly maxManifestBytes: number;
  readonly maxChunkBytes: number;
  readonly maxRowBytes: number;
  readonly maxTables: number;
  readonly maxChunks: number;
  readonly maxRows: number;
  readonly maxTotalBytes: number;
  readonly maxSnapshotBytes: number;
}
export const fullDataPreservationLimits: Readonly<FullDataPreservationLimits> = Object.freeze({
  maxManifestBytes: 64 * 1024 * 1024, maxChunkBytes: 16 * 1024 * 1024,
  maxRowBytes: 16 * 1024 * 1024, maxTables: 1000, maxChunks: 100_000,
  maxRows: 1_000_000_000_000, maxTotalBytes: 1024 ** 4, maxSnapshotBytes: 16 * 1024 ** 4,
});
type JsonObject = Record<string, unknown>;
export type FullDataPreservationCell = { readonly storage: "null" } |
  { readonly storage: "integer" | "real" | "text" | "blob"; readonly value: string; readonly encoding?: "base64" };
export interface FullDataPreservationRow { readonly values: readonly FullDataPreservationCell[] }
export interface FullDataPreservationChunkPlan {
  readonly file: string; readonly table: string; readonly ordinal: number;
  readonly startRow: number; readonly rowCount: number; readonly sha256: string;
}
export interface FullDataPreservationTablePlan {
  readonly name: string; readonly completed: true; readonly rowCount: number;
  readonly contentSha256: string; readonly chunks: readonly FullDataPreservationChunkPlan[];
}
export interface FullDataPreservationCatalog {
  readonly objects: readonly { readonly type: "table" | "index" | "view" | "trigger"; readonly name: string; readonly tbl_name: string; readonly sql: string | null }[];
  readonly tables: readonly { readonly name: string; readonly columns: readonly (readonly unknown[])[];
    readonly foreignKeys: readonly JsonObject[]; readonly indexes: readonly JsonObject[] }[];
  readonly sequences: readonly { readonly name: string; readonly seq: string }[];
  readonly pragmas: { readonly encoding: "UTF-8" | "UTF-16le" | "UTF-16be"; readonly user_version: number; readonly application_id: number };
}
export interface FullDataPreservationManifest {
  readonly version: 1; readonly operationId: string; readonly snapshotSha256: string; readonly snapshotBytes: number;
  readonly catalogFingerprint: string; readonly completed: true; readonly businessActivation: false;
  readonly limits: { readonly maximumChunkBytes: number; readonly rowsPerChunk: number };
  readonly catalog: FullDataPreservationCatalog; readonly tables: readonly FullDataPreservationTablePlan[];
}
export interface VerifiedFullDataPreservationManifest {
  readonly value: FullDataPreservationManifest; readonly body: Buffer; readonly manifestSha256: string;
  readonly totalRows: number; readonly totalChunks: number;
}
export interface VerifiedFullDataPreservationChunk {
  readonly body: Buffer; readonly rows: readonly FullDataPreservationRow[]; readonly rowBodies: readonly Buffer[];
  readonly plan: FullDataPreservationChunkPlan;
}
export type VerifiedOpaquePreservationChunk = Omit<VerifiedFullDataPreservationChunk, "rows">;
export interface VerifiedFullDataPreservationBundle {
  readonly directory: string; readonly manifest: VerifiedFullDataPreservationManifest;
  readonly totalRows: number; readonly totalChunks: number; readonly totalBytes: number;
  readonly readOnly: true; readonly grantsBusinessEligibility: false;
}
export interface FullDataPreservationTarget { readonly schema: string; readonly database: string; readonly role: string }
export interface FullDataPreservationExecutionBudget {
  readonly deadlineAtMs: number;
  readonly maximumTransactionMs: number;
  readonly maximumQueriesPerTransaction: number;
  readonly maximumTotalQueries: number;
  /** Explicit lower-memory mode; canonical original row bytes remain opaque and lossless. */
  readonly opaqueRowWindows?: { readonly maximumRows: number; readonly maximumBytes: number };
}
export type FullDataPreservationUnitOfWork = Pick<ReturnType<typeof createPostgresUnitOfWork>, "run">;
export interface FullDataPreservationImportResult {
  readonly operationId: string; readonly snapshotSha256: string; readonly manifestSha256: string;
  readonly totalTables: number; readonly totalChunks: number; readonly totalRows: number;
  readonly committedChunks: number; readonly resumedChunks: number; readonly completed: true;
  readonly grantsBusinessEligibility: false;
}

const fail = (reason: string): never => { throw new Error("full_data_preservation_" + reason); };
function requireThat(condition: unknown, reason: string): asserts condition { if (!condition) fail(reason); }
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
function limitsFor(input: Partial<FullDataPreservationLimits> = {}): FullDataPreservationLimits {
  const result = { ...fullDataPreservationLimits, ...input };
  for (const [key, value] of Object.entries(result)) {
    requireThat(Object.hasOwn(fullDataPreservationLimits, key) && Number.isSafeInteger(value) && value > 0 &&
      value <= fullDataPreservationLimits[key as keyof FullDataPreservationLimits], "invalid_limit");
  }
  return result;
}
function object(value: unknown, reason: string): JsonObject {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), reason);
  return value as JsonObject;
}
function keys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  requireThat(required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)), "unexpected_fields");
}
function array(value: unknown, maximum: number, reason: string): unknown[] {
  requireThat(Array.isArray(value) && value.length <= maximum, reason);
  return value;
}
function integer(value: unknown, maximum: number, reason: string, minimum = 0): number {
  requireThat(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, reason);
  return value;
}
function add(left: number, right: number, maximum: number, reason: string): number {
  requireThat(right <= maximum - left, reason);
  return left + right;
}
function string(value: unknown, maximum: number, reason: string): string {
  requireThat(typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), reason);
  return value;
}
function name(value: unknown): string {
  const result = string(value, 1024, "invalid_name");
  requireThat(result.length > 0 && !/[\x00-\x1f\x7f]/.test(result), "invalid_name");
  return result;
}
function hash(value: unknown): string {
  requireThat(typeof value === "string" && /^[0-9a-f]{64}$/.test(value), "invalid_digest");
  return value;
}
function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

// Only metadata canonicalization uses serialization. File and row digests use original bytes.
function pythonCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(pythonCanonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => pythonCanonicalJson(key) + ":" + pythonCanonicalJson(child)).join(",") + "}";
  return JSON.stringify(value).replace(/[\x7f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

function parseDocument(bytes: Uint8Array, maximum: number): { value: unknown; rows: Buffer[]; body: Buffer } {
  requireThat(bytes.byteLength <= maximum, "byte_limit");
  const body = Buffer.from(bytes);
  let text: string;
  let value: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); value = JSON.parse(text); }
  catch { return fail("invalid_json_or_utf8"); }
  let cursor = 0;
  const rows: Buffer[] = [];
  const space = () => { while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  function token(): string {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") { cursor += 2; continue; }
      if (text[cursor++] === '"') return text.slice(start, cursor);
    }
    return fail("invalid_json");
  }
  function visit(depth: number, path: readonly (string | number)[]): void {
    requireThat(depth <= 32, "json_depth_limit"); space();
    const start = cursor;
    if (text[cursor] === "{") {
      cursor++; space(); const seen = new Set<string>();
      while (text[cursor] !== "}") {
        const key = JSON.parse(token()) as string;
        requireThat(!seen.has(key), "duplicate_json_key"); seen.add(key); space(); cursor++;
        visit(depth + 1, [...path, key]); space();
        if (text[cursor] !== ",") break;
        cursor++; space();
      }
      cursor++;
    } else if (text[cursor] === "[") {
      cursor++; space(); let index = 0;
      while (text[cursor] !== "]") {
        visit(depth + 1, [...path, index++]); space();
        if (text[cursor] !== ",") break;
        cursor++; space();
      }
      cursor++;
    } else if (text[cursor] === '"') token();
    else while (cursor < text.length && !/[\s,\]}]/.test(text[cursor]!)) cursor++;
    if (path.length === 2 && path[0] === "rows" && typeof path[1] === "number") rows.push(Buffer.from(text.slice(start, cursor), "utf8"));
  }
  visit(0, []);
  return { value, rows, body };
}

function validateCatalog(input: unknown, limits: FullDataPreservationLimits): FullDataPreservationCatalog {
  const catalog = object(input, "invalid_catalog"); keys(catalog, ["objects", "tables", "sequences", "pragmas"]);
  const objects = array(catalog.objects, 100_000, "catalog_object_limit"); const objectNames = new Set<string>();
  const objectTables = new Set<string>();
  for (const item of objects) {
    const entry = object(item, "invalid_catalog_object"); keys(entry, ["type", "name", "tbl_name", "sql"]);
    requireThat(typeof entry.type === "string" && ["table", "index", "view", "trigger"].includes(entry.type), "invalid_catalog_object_type");
    const key = entry.type + ":" + name(entry.name); name(entry.tbl_name);
    requireThat(!objectNames.has(key), "duplicate_catalog_object"); objectNames.add(key);
    if (entry.sql !== null) string(entry.sql, limits.maxManifestBytes, "invalid_catalog_sql");
    if (entry.type === "table") { requireThat(entry.tbl_name === entry.name, "catalog_table_name_mismatch"); objectTables.add(entry.name as string); }
  }
  const tables = array(catalog.tables, limits.maxTables, "table_limit"); const names = new Set<string>();
  for (const item of tables) {
    const table = object(item, "invalid_catalog_table"); keys(table, ["name", "columns", "foreignKeys", "indexes"]);
    const tableName = name(table.name); requireThat(!names.has(tableName) && objectTables.has(tableName), "duplicate_or_unaccounted_catalog_table"); names.add(tableName);
    const columns = array(table.columns, 1000, "column_limit"); requireThat(columns.length > 0, "empty_columns");
    const columnNames = new Set<string>();
    for (const [ordinal, item] of columns.entries()) {
      const column = array(item, 7, "invalid_column"); requireThat(column.length === 7, "invalid_column");
      requireThat(integer(column[0], 1000, "invalid_column_ordinal") === ordinal, "invalid_column_ordinal");
      const columnName = name(column[1]); requireThat(!columnNames.has(columnName.toLowerCase()), "duplicate_column"); columnNames.add(columnName.toLowerCase());
      string(column[2], 1024, "invalid_column_type"); integer(column[3], 1, "invalid_nullability");
      if (column[4] !== null) string(column[4], limits.maxManifestBytes, "invalid_column_default");
      integer(column[5], columns.length, "invalid_primary_key_position"); integer(column[6], 3, "invalid_hidden_column");
    }
    const foreignKeys = array(table.foreignKeys, 100_000, "foreign_key_limit"); const foreignIds = new Set<number>();
    for (const item of foreignKeys) {
      const group = object(item, "invalid_foreign_key"); keys(group, ["id", "table", "onUpdate", "onDelete", "match", "columns"]);
      const id = integer(group.id, 100_000, "invalid_foreign_key_id"); requireThat(!foreignIds.has(id), "duplicate_foreign_key"); foreignIds.add(id);
      name(group.table); for (const key of ["onUpdate", "onDelete", "match"]) string(group[key], 128, "invalid_foreign_key_action");
      const parts = array(group.columns, 1000, "foreign_key_column_limit"); requireThat(parts.length > 0, "empty_foreign_key");
      for (const [sequence, item] of parts.entries()) {
        const part = object(item, "invalid_foreign_key_column"); keys(part, ["sequence", "from", "to"]);
        requireThat(integer(part.sequence, 1000, "invalid_foreign_key_sequence") === sequence, "invalid_foreign_key_sequence");
        name(part.from); if (part.to !== null) name(part.to);
      }
    }
    const indexes = array(table.indexes, 100_000, "index_limit"); const indexNames = new Set<string>();
    for (const item of indexes) {
      const index = object(item, "invalid_index"); keys(index, ["name", "unique", "origin", "partial", "sql", "columns"]);
      const indexName = name(index.name); requireThat(!indexNames.has(indexName), "duplicate_index"); indexNames.add(indexName);
      requireThat(typeof index.unique === "boolean" && typeof index.partial === "boolean" && typeof index.origin === "string" && ["c", "u", "pk"].includes(index.origin), "invalid_index_flags");
      if (index.sql !== null) string(index.sql, limits.maxManifestBytes, "invalid_index_sql");
      for (const [sequence, item] of array(index.columns, 1001, "index_column_limit").entries()) {
        const part = array(item, 6, "invalid_index_column"); requireThat(part.length === 6, "invalid_index_column");
        requireThat(integer(part[0], 1001, "invalid_index_sequence") === sequence, "invalid_index_sequence");
        integer(part[1], 1000, "invalid_index_column_id", -2); if (part[2] !== null) name(part[2]);
        integer(part[3], 1, "invalid_index_direction"); if (part[4] !== null) string(part[4], 1024, "invalid_index_collation"); integer(part[5], 1, "invalid_index_key");
      }
    }
  }
  requireThat(names.size === objectTables.size, "catalog_table_accounting_mismatch");
  const sequences = array(catalog.sequences, limits.maxTables, "sequence_limit"); const sequenceNames = new Set<string>();
  for (const item of sequences) {
    const sequence = object(item, "invalid_sequence"); keys(sequence, ["name", "seq"]);
    const sequenceName = name(sequence.name); requireThat(!sequenceNames.has(sequenceName), "duplicate_sequence"); sequenceNames.add(sequenceName);
    requireThat(typeof sequence.seq === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(sequence.seq) && BigInt(sequence.seq) <= 9223372036854775807n, "invalid_sequence_value");
  }
  const pragmas = object(catalog.pragmas, "invalid_pragmas"); keys(pragmas, ["encoding", "user_version", "application_id"]);
  requireThat(typeof pragmas.encoding === "string" && ["UTF-8", "UTF-16le", "UTF-16be"].includes(pragmas.encoding), "invalid_database_encoding");
  integer(pragmas.user_version, 2147483647, "invalid_user_version", -2147483648);
  integer(pragmas.application_id, 2147483647, "invalid_application_id", -2147483648);
  return catalog as unknown as FullDataPreservationCatalog;
}

/** Verifies internal integrity; binding to an approved source snapshot is the caller's duty. */
export function verifyFullDataPreservationManifest(bytes: Uint8Array, inputLimits: Partial<FullDataPreservationLimits> = {}): VerifiedFullDataPreservationManifest {
  const limits = limitsFor(inputLimits); const document = parseDocument(bytes, limits.maxManifestBytes);
  const manifest = object(document.value, "invalid_manifest");
  keys(manifest, ["version", "operationId", "snapshotSha256", "snapshotBytes", "catalogFingerprint", "completed", "businessActivation", "catalog", "limits", "tables"]);
  requireThat(manifest.version === 1 && manifest.completed === true && manifest.businessActivation === false, "incomplete_or_activating_manifest");
  requireThat(typeof manifest.operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(manifest.operationId), "invalid_operation_id");
  hash(manifest.snapshotSha256); hash(manifest.catalogFingerprint); integer(manifest.snapshotBytes, limits.maxSnapshotBytes, "snapshot_byte_limit");
  const declared = object(manifest.limits, "invalid_export_limits"); keys(declared, ["maximumChunkBytes", "rowsPerChunk"]);
  integer(declared.maximumChunkBytes, limits.maxChunkBytes, "chunk_byte_limit", 1024);
  integer(declared.rowsPerChunk, 4096, "chunk_row_limit", 1);
  const catalog = validateCatalog(manifest.catalog, limits);
  requireThat(sha256(pythonCanonicalJson(catalog)) === manifest.catalogFingerprint, "catalog_digest_mismatch");
  const tables = array(manifest.tables, limits.maxTables, "table_limit");
  requireThat(tables.length === catalog.tables.length, "table_accounting_mismatch");
  const seenTables = new Set<string>(); const paths = new Set<string>(); let totalRows = 0; let totalChunks = 0;
  for (const [tableOrdinal, item] of tables.entries()) {
    const table = object(item, "invalid_table_plan"); keys(table, ["name", "rowCount", "contentSha256", "chunks", "completed"]);
    const tableName = name(table.name); requireThat(!seenTables.has(tableName) && catalog.tables[tableOrdinal]!.name === tableName, "table_accounting_mismatch"); seenTables.add(tableName);
    requireThat(table.completed === true, "incomplete_table"); integer(table.rowCount, limits.maxRows, "row_count_limit"); hash(table.contentSha256);
    let startRow = 0; const chunks = array(table.chunks, Math.min(limits.maxChunks, 1_000_000), "chunk_count_limit");
    totalChunks = add(totalChunks, chunks.length, limits.maxChunks, "chunk_count_limit");
    for (const [ordinal, item] of chunks.entries()) {
      const chunk = object(item, "invalid_chunk_plan"); keys(chunk, ["file", "table", "ordinal", "startRow", "rowCount", "sha256"]);
      const expectedFile = "table-" + String(tableOrdinal).padStart(4, "0") + "-chunk-" + String(ordinal).padStart(6, "0") + ".json";
      requireThat(typeof chunk.file === "string" && /^table-[0-9]{4}-chunk-[0-9]{6}\.json$/.test(chunk.file) && chunk.file === expectedFile && !paths.has(chunk.file), "invalid_or_duplicate_chunk_path"); paths.add(chunk.file);
      requireThat(chunk.table === tableName && chunk.ordinal === ordinal && chunk.startRow === startRow, "chunk_sequence_mismatch");
      hash(chunk.sha256); const rowCount = integer(chunk.rowCount, declared.rowsPerChunk as number, "chunk_row_limit", 1);
      startRow = add(startRow, rowCount, limits.maxRows, "row_count_limit");
    }
    requireThat(startRow === table.rowCount, "table_row_accounting_mismatch");
    if (startRow === 0) requireThat(table.contentSha256 === sha256(""), "empty_table_content_digest_mismatch");
    totalRows = add(totalRows, startRow, limits.maxRows, "row_count_limit");
  }
  freezeJson(manifest);
  return Object.freeze({ value: manifest as unknown as FullDataPreservationManifest, body: document.body,
    manifestSha256: sha256(document.body), totalRows, totalChunks });
}

function validateCell(input: unknown, maximum: number): void {
  const cell = object(input, "invalid_cell");
  if (cell.storage === "null") { keys(cell, ["storage"]); return; }
  requireThat(typeof cell.storage === "string" && ["integer", "real", "text", "blob"].includes(cell.storage), "invalid_storage_class");
  keys(cell, ["storage", "value"], cell.storage === "text" || cell.storage === "blob" ? ["encoding"] : []);
  const value = string(cell.value, maximum, "cell_byte_limit");
  if (cell.storage === "integer") {
    requireThat(/^-?(?:0|[1-9][0-9]{0,18})$/.test(value) && value !== "-0", "invalid_integer");
    const number = BigInt(value); requireThat(number >= -9223372036854775808n && number <= 9223372036854775807n, "invalid_integer"); return;
  }
  if (cell.storage === "real") {
    if (value === "inf" || value === "-inf" || value === "0x0.0p+0" || value === "-0x0.0p+0") return;
    const parts = /^-?0x([01])\.([0-9a-f]{13})p([+-][0-9]{1,4})$/.exec(value);
    requireThat(parts, "invalid_real_hex"); const exponent = Number(parts[3]);
    requireThat(parts[3] === (exponent >= 0 ? "+" : "") + String(exponent) && exponent >= -1022 && exponent <= 1023 &&
      (parts[1] === "1" || (exponent === -1022 && parts[2] !== "0000000000000")), "invalid_real_hex"); return;
  }
  requireThat((cell.storage !== "text" || cell.encoding === "base64") && (cell.encoding === undefined || cell.encoding === "base64"), "invalid_byte_encoding");
  requireThat(value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.from(value, "base64").toString("base64") === value, "invalid_base64");
}

/** Verifies the pinned original chunk without allocating a whole-chunk JSON string/object tree.
 * Retains one bounded raw chunk and row byte views; only one row is parsed at a time.
 * This accepts the exporter's canonical envelope, not arbitrary alternate JSON encodings.
 */
export function verifyOpaqueFullDataPreservationChunk(bytes: Uint8Array, manifest: VerifiedFullDataPreservationManifest,
  tableName: string, ordinal: number, inputLimits: Partial<FullDataPreservationLimits> = {}): VerifiedOpaquePreservationChunk {
  const limits = limitsFor(inputLimits), tableIndex = manifest.value.tables.findIndex(t => t.name === tableName);
  requireThat(tableIndex >= 0 && Number.isSafeInteger(ordinal) && ordinal >= 0, "unplanned_chunk");
  const plan = manifest.value.tables[tableIndex]!.chunks[ordinal]; requireThat(plan, "unplanned_chunk");
  requireThat(bytes.byteLength <= Math.min(limits.maxChunkBytes, manifest.value.limits.maximumChunkBytes), "chunk_byte_limit");
  requireThat(sha256(bytes) === plan.sha256, "chunk_digest_mismatch");
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const prefix = Buffer.from('{"operationId":' + pythonCanonicalJson(manifest.value.operationId) + ',"ordinal":' + ordinal + ',"rows":[');
  const suffix = Buffer.from('],"snapshotSha256":' + pythonCanonicalJson(manifest.value.snapshotSha256) + ',"startRow":' + plan.startRow + ',"table":' + pythonCanonicalJson(tableName) + ',"version":1}');
  requireThat(body.subarray(0,prefix.length).equals(prefix) && body.subarray(body.length-suffix.length).equals(suffix), "chunk_metadata_mismatch");
  const end = body.length-suffix.length, rows: Buffer[] = []; let cursor = prefix.length;
  while (cursor < end) {
    requireThat(rows.length < plan.rowCount && body[cursor] === 123, "invalid_row");
    const start = cursor; let depth = 0, quoted = false, escaped = false;
    for (; cursor < end; cursor++) {
      const byte = body[cursor]!;
      if (quoted) { if (escaped) escaped = false; else if (byte === 92) escaped = true; else if (byte === 34) quoted = false; }
      else if (byte === 34) quoted = true;
      else if (byte === 123 || byte === 91) { depth++; requireThat(depth <= 32, "json_depth_limit"); }
      else if (byte === 125 || byte === 93) { depth--; if (depth === 0) { cursor++; break; } requireThat(depth > 0, "invalid_json"); }
    }
    requireThat(depth === 0 && !quoted && cursor <= end, "invalid_json");
    const rowBody = body.subarray(start,cursor); requireThat(rowBody.length <= limits.maxRowBytes, "row_byte_limit");
    let value: unknown; try { value = JSON.parse(preservationUtf8Decoder.decode(rowBody)); } catch { return fail("invalid_json_or_utf8"); }
    const row = object(value,"invalid_row"); keys(row,["values"]);
    const cells = array(row.values,1000,"row_width_limit");
    requireThat(cells.length === manifest.value.catalog.tables[tableIndex]!.columns.length,"row_width_mismatch");
    for (const cell of cells) validateCell(cell,limits.maxRowBytes);
    requireThat(rowBody.equals(Buffer.from(pythonCanonicalJson(row))),"noncanonical_row_body"); rows.push(rowBody);
    if (cursor < end) { requireThat(body[cursor++] === 44 && cursor < end,"invalid_json"); }
  }
  requireThat(rows.length === plan.rowCount && cursor === end,"chunk_row_accounting_mismatch");
  return Object.freeze({body,rowBodies:Object.freeze(rows),plan});
}

export function preservationRowByteWindows(bodies: readonly Buffer[], maximumRows: number, maximumBytes: number) {
  integer(maximumRows,4096,"invalid_row_window_budget",1); integer(maximumBytes,2*1024**2,"invalid_row_window_budget",1);
  const windows: { start: number; end: number }[] = [];
  for (let start = 0; start < bodies.length;) {
    let end = start, bytes = 0;
    while (end < bodies.length && end-start < maximumRows && (end === start || bytes+bodies[end]!.length <= maximumBytes)) bytes += bodies[end++]!.length;
    windows.push({start,end}); start = end;
  }
  return windows;
}

export function verifyFullDataPreservationChunk(bytes: Uint8Array, manifest: VerifiedFullDataPreservationManifest,
  tableName: string, ordinal: number, inputLimits: Partial<FullDataPreservationLimits> = {}): VerifiedFullDataPreservationChunk {
  const limits = limitsFor(inputLimits); const tableIndex = manifest.value.tables.findIndex(table => table.name === tableName);
  requireThat(tableIndex >= 0 && Number.isSafeInteger(ordinal) && ordinal >= 0, "unplanned_chunk");
  const plan = manifest.value.tables[tableIndex]!.chunks[ordinal]; requireThat(plan, "unplanned_chunk");
  requireThat(bytes.byteLength <= Math.min(limits.maxChunkBytes, manifest.value.limits.maximumChunkBytes), "chunk_byte_limit");
  requireThat(sha256(bytes) === plan.sha256, "chunk_digest_mismatch");
  const document = parseDocument(bytes, Math.min(limits.maxChunkBytes, manifest.value.limits.maximumChunkBytes));
  const chunk = object(document.value, "invalid_chunk"); keys(chunk, ["version", "operationId", "snapshotSha256", "table", "ordinal", "startRow", "rows"]);
  requireThat(chunk.version === 1 && chunk.operationId === manifest.value.operationId && chunk.snapshotSha256 === manifest.value.snapshotSha256,
    "chunk_lineage_mismatch");
  requireThat(chunk.table === tableName && chunk.ordinal === plan.ordinal && chunk.startRow === plan.startRow, "chunk_metadata_mismatch");
  const rows = array(chunk.rows, manifest.value.limits.rowsPerChunk, "chunk_row_limit");
  requireThat(rows.length === plan.rowCount && document.rows.length === rows.length, "chunk_row_accounting_mismatch");
  for (const [index, input] of rows.entries()) {
    const row = object(input, "invalid_row"); keys(row, ["values"]);
    const cells = array(row.values, 1000, "row_width_limit");
    requireThat(cells.length === manifest.value.catalog.tables[tableIndex]!.columns.length, "row_width_mismatch");
    requireThat(document.rows[index]!.byteLength <= limits.maxRowBytes, "row_byte_limit");
    for (const cell of cells) validateCell(cell, limits.maxRowBytes);
    // The exporter hashes compact, sorted, ASCII-escaped row objects followed by LF.
    // Refuse a second representation rather than silently rewriting archived bytes.
    requireThat(document.rows[index]!.equals(Buffer.from(pythonCanonicalJson(row))), "noncanonical_row_body");
  }
  freezeJson(rows);
  return Object.freeze({ body: document.body, rows: rows as unknown as readonly FullDataPreservationRow[],
    rowBodies: Object.freeze(document.rows), plan });
}

async function readBoundedFile(directory: string, file: string, maximum: number): Promise<Buffer> {
  const injected = preservationSourceReaders.getStore();
  if (injected) return injected.read(directory, file, maximum);
  requireThat(file === "manifest.json" || /^table-[0-9]{4}-chunk-[0-9]{6}\.json$/.test(file), "invalid_chunk_path");
  const handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    requireThat(before.isFile() && before.size <= BigInt(maximum), "file_byte_limit_or_not_regular");
    const body = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < body.length) {
      const read = await handle.read(body, offset, body.length - offset, offset);
      if (!read.bytesRead) break; offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    requireThat(offset === Number(before.size) && before.dev === after.dev && before.ino === after.ino &&
      before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "artifact_changed_during_read");
    return body.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function readFullDataPreservationBundle(bundleDirectory: string, inputLimits: Partial<FullDataPreservationLimits> = {}, checkpoint: (releasedChunk?: boolean) => void = () => {}): Promise<VerifiedFullDataPreservationBundle> {
  return await readPreservationBundle(bundleDirectory,inputLimits,checkpoint,false);
}
export async function readOpaqueFullDataPreservationBundle(bundleDirectory: string, inputLimits: Partial<FullDataPreservationLimits> = {}, checkpoint: (releasedChunk?: boolean) => void = () => {}): Promise<VerifiedFullDataPreservationBundle> {
  return await readPreservationBundle(bundleDirectory,inputLimits,checkpoint,true);
}
async function readPreservationBundle(bundleDirectory: string, inputLimits: Partial<FullDataPreservationLimits>, checkpoint: (releasedChunk?: boolean) => void, opaque: boolean): Promise<VerifiedFullDataPreservationBundle> {
  checkpoint();
  const limits = limitsFor(inputLimits); const root = await lstat(bundleDirectory);
  requireThat(root.isDirectory() && !root.isSymbolicLink(), "invalid_bundle_directory");
  const directory = await realpath(bundleDirectory);
  const manifest = verifyFullDataPreservationManifest(await readBoundedFile(directory, "manifest.json", limits.maxManifestBytes), limits);
  let totalBytes = add(0, manifest.body.byteLength, limits.maxTotalBytes, "total_byte_limit");
  for (const table of manifest.value.tables) {
    const content = createHash("sha256"); let totalRows = 0;
    async function verifyAndHashChunk(plan: FullDataPreservationChunkPlan): Promise<{ bytes: number; rows: number }> {
      const bytes = await readBoundedFile(directory, plan.file, manifest.value.limits.maximumChunkBytes);
      const chunk = (opaque ? verifyOpaqueFullDataPreservationChunk : verifyFullDataPreservationChunk)(bytes, manifest, table.name, plan.ordinal, limits);
      for (const row of chunk.rowBodies) { content.update(row); content.update("\n"); }
      // Only counts escape this frame; the caller can reclaim raw bytes and row views before the next read.
      return { bytes: bytes.byteLength, rows: chunk.rowBodies.length };
    }
    for (const plan of table.chunks) {
      checkpoint();
      const verified = await verifyAndHashChunk(plan);
      totalBytes = add(totalBytes, verified.bytes, limits.maxTotalBytes, "total_byte_limit");
      totalRows += verified.rows;
      checkpoint(true);
    }
    requireThat(totalRows === table.rowCount && content.digest("hex") === table.contentSha256, "table_content_digest_mismatch");
  }
  return Object.freeze({ directory, manifest, totalRows: manifest.totalRows, totalChunks: manifest.totalChunks,
    totalBytes, readOnly: true, grantsBusinessEligibility: false });
}

// These statements are opt-in provisioning material. The importer never runs DDL.
export const fullDataPreservationSchemaSql: readonly string[] = Object.freeze([
  `CREATE TABLE __SCHEMA__.full_data_preservation_operations (
    operation_id TEXT PRIMARY KEY, snapshot_sha256 TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
    manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    catalog_fingerprint TEXT NOT NULL CHECK (catalog_fingerprint ~ '^[0-9a-f]{64}$'), manifest_body BYTEA NOT NULL,
    planned_tables BIGINT NOT NULL CHECK (planned_tables >= 0), planned_chunks BIGINT NOT NULL CHECK (planned_chunks >= 0),
    planned_rows BIGINT NOT NULL CHECK (planned_rows >= 0), completed BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (operation_id, snapshot_sha256, manifest_sha256)
  )`,
  `CREATE TABLE __SCHEMA__.full_data_preservation_tables (
    operation_id TEXT NOT NULL, table_name TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
    row_count BIGINT NOT NULL CHECK (row_count >= 0), chunk_count BIGINT NOT NULL CHECK (chunk_count >= 0),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    verified_manifest_sha256 TEXT, verified_row_count BIGINT, verified_chunk_count BIGINT,
    CHECK ((verified_manifest_sha256 IS NULL AND verified_row_count IS NULL AND verified_chunk_count IS NULL) OR
      (verified_manifest_sha256 IS NOT NULL AND verified_row_count IS NOT NULL AND verified_chunk_count IS NOT NULL
        AND verified_manifest_sha256=manifest_sha256 AND verified_row_count=row_count AND verified_chunk_count=chunk_count)),
    PRIMARY KEY (operation_id, table_name), UNIQUE (operation_id, table_name, snapshot_sha256, manifest_sha256),
    FOREIGN KEY (operation_id, snapshot_sha256, manifest_sha256)
      REFERENCES __SCHEMA__.full_data_preservation_operations (operation_id, snapshot_sha256, manifest_sha256)
  )`,
  `CREATE TABLE __SCHEMA__.full_data_preservation_chunks (
    operation_id TEXT NOT NULL, table_name TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
    ordinal BIGINT NOT NULL CHECK (ordinal >= 0), file TEXT NOT NULL, start_row BIGINT NOT NULL CHECK (start_row >= 0),
    row_count BIGINT NOT NULL CHECK (row_count > 0), sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), chunk_body BYTEA NOT NULL,
    verified_manifest_sha256 TEXT, verified_chunk_sha256 TEXT, verified_row_count BIGINT,
    CHECK ((verified_manifest_sha256 IS NULL AND verified_chunk_sha256 IS NULL AND verified_row_count IS NULL) OR
      (verified_manifest_sha256 IS NOT NULL AND verified_chunk_sha256 IS NOT NULL AND verified_row_count IS NOT NULL
        AND verified_manifest_sha256=manifest_sha256 AND verified_chunk_sha256=sha256 AND verified_row_count=row_count)),
    PRIMARY KEY (operation_id, table_name, ordinal), UNIQUE (operation_id, file),
    UNIQUE (operation_id, table_name, ordinal, snapshot_sha256, manifest_sha256),
    FOREIGN KEY (operation_id, table_name, snapshot_sha256, manifest_sha256)
      REFERENCES __SCHEMA__.full_data_preservation_tables (operation_id, table_name, snapshot_sha256, manifest_sha256)
  )`,
  `CREATE TABLE __SCHEMA__.full_data_preservation_rows (
    operation_id TEXT NOT NULL, table_name TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
    row_ordinal BIGINT NOT NULL CHECK (row_ordinal >= 0), row_body BYTEA NOT NULL, chunk_ordinal BIGINT NOT NULL CHECK (chunk_ordinal >= 0),
    PRIMARY KEY (operation_id, table_name, row_ordinal),
    FOREIGN KEY (operation_id, table_name, chunk_ordinal, snapshot_sha256, manifest_sha256)
      REFERENCES __SCHEMA__.full_data_preservation_chunks (operation_id, table_name, ordinal, snapshot_sha256, manifest_sha256)
      DEFERRABLE INITIALLY DEFERRED
  )`,
]);
export const fullDataPreservationSql = Object.freeze({
  targetIdentity: `/* preservation:targetIdentity */ SELECT current_database() AS database, current_user::text AS role, n.nspname AS schema FROM pg_namespace n WHERE n.nspname = $1`,
  lockOperation: `/* preservation:lockOperation */ SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
  queryTimeout: `/* preservation:queryTimeout */ SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)`,
  insertOperation: `/* preservation:insertOperation */ INSERT INTO __SCHEMA__.full_data_preservation_operations
    (operation_id,snapshot_sha256,manifest_sha256,catalog_fingerprint,manifest_body,planned_tables,planned_chunks,planned_rows)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (operation_id) DO NOTHING`,
  selectOperation: `/* preservation:selectOperation */ SELECT operation_id,snapshot_sha256,manifest_sha256,catalog_fingerprint,
    CASE WHEN octet_length(manifest_body) <= $2 THEN manifest_body ELSE NULL END AS manifest_body,
    planned_tables::text,planned_chunks::text,planned_rows::text,completed FROM __SCHEMA__.full_data_preservation_operations WHERE operation_id=$1 FOR UPDATE`,
  insertTable: `/* preservation:insertTable */ INSERT INTO __SCHEMA__.full_data_preservation_tables
    (operation_id,table_name,snapshot_sha256,manifest_sha256,row_count,chunk_count,content_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (operation_id,table_name) DO NOTHING`,
  selectTables: `/* preservation:selectTables */ SELECT operation_id,table_name,snapshot_sha256,manifest_sha256,row_count::text,chunk_count::text,content_sha256,
    verified_manifest_sha256,verified_row_count::text,verified_chunk_count::text
    FROM __SCHEMA__.full_data_preservation_tables WHERE operation_id=$1 ORDER BY table_name COLLATE "C" LIMIT $2`,
  selectChunk: `/* preservation:selectChunk */ SELECT operation_id,table_name,snapshot_sha256,manifest_sha256,ordinal::text,file,start_row::text,row_count::text,sha256,
    verified_manifest_sha256,verified_chunk_sha256,verified_row_count::text,
    octet_length(chunk_body)::text AS chunk_bytes,
    CASE WHEN octet_length(chunk_body) <= $4 THEN chunk_body ELSE NULL END AS chunk_body
    FROM __SCHEMA__.full_data_preservation_chunks WHERE operation_id=$1 AND table_name=$2 AND ordinal=$3`,
  selectChunkBodySlice: `/* preservation:selectChunkBodySlice */ SELECT substring(chunk_body FROM $4 FOR $5) AS body
    FROM __SCHEMA__.full_data_preservation_chunks WHERE operation_id=$1 AND table_name=$2 AND ordinal=$3`,
  selectChunks: `/* preservation:selectChunks */ SELECT operation_id,table_name,snapshot_sha256,manifest_sha256,ordinal::text,file,start_row::text,row_count::text,sha256,
    verified_manifest_sha256,verified_chunk_sha256,verified_row_count::text
    FROM __SCHEMA__.full_data_preservation_chunks AS preserved_chunks WHERE operation_id=$1 AND table_name=$2 ORDER BY preserved_chunks.ordinal LIMIT $3`,
  insertRow: `/* preservation:insertRow */ INSERT INTO __SCHEMA__.full_data_preservation_rows
    (operation_id,table_name,snapshot_sha256,manifest_sha256,row_ordinal,row_body,chunk_ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  insertRows: `/* preservation:insertRows */ INSERT INTO __SCHEMA__.full_data_preservation_rows
    (operation_id,table_name,snapshot_sha256,manifest_sha256,row_ordinal,row_body,chunk_ordinal)
    SELECT $1,$2,$3,$4,input.row_ordinal,input.row_body,$7 FROM unnest($5::bigint[],$6::bytea[]) AS input(row_ordinal,row_body)`,
  insertChunk: `/* preservation:insertChunk */ INSERT INTO __SCHEMA__.full_data_preservation_chunks
    (operation_id,table_name,snapshot_sha256,manifest_sha256,ordinal,file,start_row,row_count,sha256,chunk_body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  selectRows: `/* preservation:selectRows */ SELECT operation_id,table_name,snapshot_sha256,manifest_sha256,row_ordinal::text,chunk_ordinal::text,
    CASE WHEN octet_length(row_body) <= $5 THEN row_body ELSE NULL END AS row_body
    FROM __SCHEMA__.full_data_preservation_rows AS preserved_rows WHERE operation_id=$1 AND table_name=$2 AND row_ordinal >= $3 AND row_ordinal < $4 ORDER BY preserved_rows.row_ordinal LIMIT $6`,
  countRows: `/* preservation:countRows */ SELECT count(*)::text AS row_count FROM __SCHEMA__.full_data_preservation_rows WHERE operation_id=$1 AND table_name=$2`,
  verifyChunk: `/* preservation:verifyChunk */ UPDATE __SCHEMA__.full_data_preservation_chunks
    SET verified_manifest_sha256=$3,verified_chunk_sha256=$4,verified_row_count=$5
    WHERE operation_id=$1 AND table_name=$2 AND ordinal=$6 AND manifest_sha256=$3 AND sha256=$4 AND row_count=$5 RETURNING ordinal::text`,
  verifyTable: `/* preservation:verifyTable */ UPDATE __SCHEMA__.full_data_preservation_tables
    SET verified_manifest_sha256=$3,verified_row_count=$4,verified_chunk_count=$5
    WHERE operation_id=$1 AND table_name=$2 AND manifest_sha256=$3 AND row_count=$4 AND chunk_count=$5 RETURNING table_name`,
  countVerifiedChunks: `/* preservation:countVerifiedChunks */ SELECT count(*)::text AS chunk_count,COALESCE(sum(row_count),0)::text AS row_count,
    COALESCE(bool_and(verified_manifest_sha256 IS NOT NULL AND verified_manifest_sha256=$2 AND
      verified_chunk_sha256 IS NOT NULL AND verified_chunk_sha256=sha256 AND verified_row_count IS NOT NULL AND verified_row_count=row_count),TRUE) AS all_verified
    FROM __SCHEMA__.full_data_preservation_chunks WHERE operation_id=$1`,
  completeOperation: `/* preservation:completeOperation */ UPDATE __SCHEMA__.full_data_preservation_operations SET completed=TRUE
    WHERE operation_id=$1 AND snapshot_sha256=$2 AND manifest_sha256=$3 RETURNING operation_id`,
});

function schemaIdentifier(schema: string): string {
  requireThat(typeof schema === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(schema) &&
    schema !== "public" && schema !== "information_schema" && !schema.startsWith("pg_"), "invalid_target_schema");
  return '"' + schema + '"';
}
export function createFullDataPreservationSchemaSql(schema: string): readonly string[] {
  const identifier = schemaIdentifier(schema);
  return Object.freeze(fullDataPreservationSchemaSql.map(statement => statement.replaceAll("__SCHEMA__", identifier)));
}
function ledgerNumber(value: unknown): number {
  requireThat(typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)), "invalid_ledger_count");
  return Number(value);
}
function equalBytes(value: unknown, expected: Buffer): boolean { return Buffer.isBuffer(value) && value.equals(expected); }
function assertLineage(row: JsonObject, manifest: VerifiedFullDataPreservationManifest): void {
  requireThat(row.operation_id === manifest.value.operationId && row.snapshot_sha256 === manifest.value.snapshotSha256 &&
    row.manifest_sha256 === manifest.manifestSha256, "ledger_lineage_mismatch");
}
function assertOperation(row: JsonObject | undefined, manifest: VerifiedFullDataPreservationManifest): void {
  requireThat(row, "missing_operation"); assertLineage(row, manifest);
  requireThat(row.catalog_fingerprint === manifest.value.catalogFingerprint && equalBytes(row.manifest_body, manifest.body) &&
    ledgerNumber(row.planned_tables) === manifest.value.tables.length && ledgerNumber(row.planned_chunks) === manifest.totalChunks &&
    ledgerNumber(row.planned_rows) === manifest.totalRows && typeof row.completed === "boolean", "operation_lineage_or_plan_mismatch");
}
function assertTablePlans(rows: readonly JsonObject[], manifest: VerifiedFullDataPreservationManifest): void {
  requireThat(rows.length === manifest.value.tables.length, "table_plan_accounting_mismatch");
  const seen = new Set<string>();
  for (const row of rows) {
    assertLineage(row, manifest); const table = manifest.value.tables.find(table => table.name === row.table_name);
    requireThat(table && !seen.has(table.name), "table_plan_accounting_mismatch"); seen.add(table.name);
    requireThat(ledgerNumber(row.row_count) === table.rowCount && ledgerNumber(row.chunk_count) === table.chunks.length &&
      row.content_sha256 === table.contentSha256, "table_plan_mismatch");
  }
}
function assertReceiptPlan(row: JsonObject, manifest: VerifiedFullDataPreservationManifest, plan: FullDataPreservationChunkPlan): void {
  assertLineage(row, manifest);
  requireThat(row.table_name === plan.table && ledgerNumber(row.ordinal) === plan.ordinal && row.file === plan.file &&
    ledgerNumber(row.start_row) === plan.startRow && ledgerNumber(row.row_count) === plan.rowCount && row.sha256 === plan.sha256, "chunk_receipt_mismatch");
}
function assertReceipt(row: JsonObject, manifest: VerifiedFullDataPreservationManifest, chunk: VerifiedOpaquePreservationChunk): void {
  assertReceiptPlan(row, manifest, chunk.plan);
  requireThat(equalBytes(row.chunk_body, chunk.body), "chunk_receipt_body_mismatch");
}
function assertChunkProof(row: JsonObject, manifest: VerifiedFullDataPreservationManifest, plan: FullDataPreservationChunkPlan): void {
  assertReceiptPlan(row, manifest, plan);
  requireThat(row.verified_manifest_sha256 === manifest.manifestSha256 && row.verified_chunk_sha256 === plan.sha256 &&
    ledgerNumber(row.verified_row_count) === plan.rowCount, "chunk_verification_proof_mismatch");
}
function assertTableProof(row: JsonObject, manifest: VerifiedFullDataPreservationManifest, table: FullDataPreservationTablePlan): void {
  requireThat(row.verified_manifest_sha256 === manifest.manifestSha256 && ledgerNumber(row.verified_row_count) === table.rowCount &&
    ledgerNumber(row.verified_chunk_count) === table.chunks.length, "table_verification_proof_mismatch");
}

/** Requires a top-level UOW runner and an explicitly pre-provisioned preservation schema.
 * Caller authorization and trusted-source binding belong to the parent migration gate.
 * The gate must enforce exclusive ownership of these preservation ledgers: persisted verification
 * proofs do not attest to subsequent writes by a non-cooperating database actor.
 * Raw chunks plus raw rows use roughly twice the exported chunk bytes, before indexes and WAL.
 * This API grants no business eligibility.
 * Do not invoke inside another UOW callback: nested UOW scopes cannot commit per-chunk receipts.
 */
export interface FullDataPreservationImportInput {
  readonly bundleDirectory: string; readonly unitOfWork: FullDataPreservationUnitOfWork;
  readonly target: FullDataPreservationTarget; readonly executionBudget: FullDataPreservationExecutionBudget;
  readonly limits?: Partial<FullDataPreservationLimits>;
  /** Caller resource/cancellation check, including released source-chunk boundaries. Throws abort before further work. */
  readonly checkpoint?: (releasedChunk?: boolean, allocationBytes?: number) => void;
}
export interface FullDataPreservationSegmentOptions {
  readonly sessionId: string;
  readonly selection: { readonly startChunkIndex: number; readonly endChunkIndexExclusive: number };
  readonly closeReserveMs: number;
}
export interface FullDataPreservationSegmentResult {
  readonly sessionId: string;
  readonly selection: FullDataPreservationSegmentOptions["selection"];
  readonly status: "segment_imported" | "yielded_before_transaction";
  readonly operationId: string; readonly snapshotSha256: string; readonly manifestSha256: string;
  readonly totalTables: number; readonly totalChunks: number; readonly totalRows: number;
  readonly committedChunks: number; readonly resumedChunks: number; readonly nextChunkIndex: number;
  readonly completed: false; readonly parityComplete: false; readonly grantsBusinessEligibility: false;
}

export function importFullDataPreservationBundle(input: FullDataPreservationImportInput): Promise<FullDataPreservationImportResult> {
  return runFullDataPreservationImport(input);
}

/** Shared import mechanism. Segment mode never performs table verification or completion.
 * Segment acknowledgements attest only the selected work in this invocation, not target immutability.
 */
export function runFullDataPreservationImport(input: FullDataPreservationImportInput): Promise<FullDataPreservationImportResult>;
export function runFullDataPreservationImport(input: FullDataPreservationImportInput, segment: FullDataPreservationSegmentOptions): Promise<FullDataPreservationSegmentResult>;
export async function runFullDataPreservationImport(input: FullDataPreservationImportInput, segment?: FullDataPreservationSegmentOptions): Promise<FullDataPreservationImportResult | FullDataPreservationSegmentResult> {
  const selection = segment ? Object.freeze({ ...segment.selection }) : undefined;
  const sessionId = segment?.sessionId;
  const closeReserveMs = segment?.closeReserveMs;
  if (segment) {
    requireThat(typeof sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId), "invalid_session_id");
    integer(selection!.startChunkIndex, Number.MAX_SAFE_INTEGER, "invalid_selection");
    integer(selection!.endChunkIndexExclusive, Number.MAX_SAFE_INTEGER, "invalid_selection", selection!.startChunkIndex + 1);
    integer(closeReserveMs, Number.MAX_SAFE_INTEGER, "invalid_close_reserve", 1);
  }
  const budget = Object.freeze({ ...input.executionBudget });
  integer(budget.deadlineAtMs, Number.MAX_SAFE_INTEGER, "invalid_execution_budget", 1);
  integer(budget.maximumTransactionMs, 60_000, "invalid_execution_budget", 1);
  integer(budget.maximumQueriesPerTransaction, 100_000, "invalid_execution_budget", 1);
  integer(budget.maximumTotalQueries, 100_000_000, "invalid_execution_budget", 1);
  const windows = budget.opaqueRowWindows;
  if (windows) { integer(windows.maximumRows,4096,"invalid_row_window_budget",1); integer(windows.maximumBytes,2*1024**2,"invalid_row_window_budget",1); }
  let totalQueries = 0;
  const checkpoint = (releasedChunk = false) => {
    requireThat(Date.now() < budget.deadlineAtMs, "execution_deadline_exceeded");
    input.checkpoint?.(releasedChunk);
  };
  checkpoint();
  const limits = limitsFor(input.limits); const target = Object.freeze({ ...input.target }); const identifier = schemaIdentifier(target.schema);
  name(target.database); name(target.role);
  const sql = Object.fromEntries(Object.entries(fullDataPreservationSql).map(([key, value]) => [key, value.replaceAll("__SCHEMA__", identifier)])) as typeof fullDataPreservationSql;
  // Complete filesystem validation precedes the first connection or ledger write.
  const bundle = await (windows ? readOpaqueFullDataPreservationBundle : readFullDataPreservationBundle)(input.bundleDirectory, limits, checkpoint); const manifest = bundle.manifest;
  const operationId = manifest.value.operationId; const lineage = [manifest.value.snapshotSha256, manifest.manifestSha256];
  if (selection) requireThat(selection.endChunkIndexExclusive <= manifest.totalChunks, "invalid_selection");
  let committedChunks = 0; let resumedChunks = 0;
  const admitsTransaction = () => Date.now() + budget.maximumTransactionMs + closeReserveMs! < budget.deadlineAtMs;
  const segmentResult = (status: FullDataPreservationSegmentResult["status"]): FullDataPreservationSegmentResult => Object.freeze({
    sessionId: sessionId!, selection: selection!, status, operationId, snapshotSha256: manifest.value.snapshotSha256,
    manifestSha256: manifest.manifestSha256, totalTables: manifest.value.tables.length, totalChunks: manifest.totalChunks,
    totalRows: manifest.totalRows, committedChunks, resumedChunks,
    nextChunkIndex: selection!.startChunkIndex + committedChunks + resumedChunks,
    completed: false, parityComplete: false, grantsBusinessEligibility: false,
  });
  if (segment && !admitsTransaction()) return segmentResult("yielded_before_transaction");
  async function locked<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    checkpoint();
    if (segment) requireThat(admitsTransaction(), "transaction_admission_budget");
    return await input.unitOfWork.run(async rawTransaction => {
      const expiresAt = Math.min(budget.deadlineAtMs, Date.now() + budget.maximumTransactionMs);
      let transactionQueries = 0;
      const transaction: PostgresTransaction = { async query(text, values = []) {
        checkpoint();
        const remaining = expiresAt - Date.now();
        requireThat(remaining > 0, "transaction_deadline_exceeded");
        requireThat(transactionQueries + 2 <= budget.maximumQueriesPerTransaction && totalQueries + 2 <= budget.maximumTotalQueries, "query_budget_exceeded");
        transactionQueries += 2; totalQueries += 2;
        await rawTransaction.query(sql.queryTimeout, [String(remaining)]);
        checkpoint(); requireThat(Date.now() < expiresAt, "transaction_deadline_exceeded");
        const result = await rawTransaction.query(text, values);
        checkpoint(); requireThat(Date.now() < expiresAt, "transaction_deadline_exceeded");
        return result;
      } };
      const identity = await transaction.query(sql.targetIdentity, [target.schema]);
      requireThat(identity.rows.length === 1 && identity.rows[0]!.database === target.database && identity.rows[0]!.role === target.role &&
        identity.rows[0]!.schema === target.schema, "target_identity_mismatch");
      await transaction.query(sql.lockOperation, [target.schema + ":" + operationId]);
      return await operation(transaction);
    });
  }
  async function checkOperation(transaction: PostgresTransaction): Promise<void> {
    const result = await transaction.query(sql.selectOperation, [operationId, limits.maxManifestBytes]);
    requireThat(result.rows.length === 1, "operation_accounting_mismatch"); assertOperation(result.rows[0], manifest);
  }
  async function checkRows(transaction: PostgresTransaction, chunk: VerifiedOpaquePreservationChunk): Promise<void> {
    const plan = chunk.plan;
    const pages = windows ? preservationRowByteWindows(chunk.rowBodies,windows.maximumRows,windows.maximumBytes) : [{start:0,end:plan.rowCount}];
    for (const page of pages) {
      const result = await transaction.query(sql.selectRows, [operationId, plan.table, plan.startRow+page.start, plan.startRow+page.end, limits.maxRowBytes, page.end-page.start+1]);
      requireThat(result.rows.length === page.end-page.start, "durable_row_accounting_mismatch");
      for (const [index, row] of result.rows.entries()) {
        assertLineage(row, manifest);
        requireThat(row.table_name === plan.table && ledgerNumber(row.row_ordinal) === plan.startRow+page.start+index &&
          ledgerNumber(row.chunk_ordinal) === plan.ordinal && equalBytes(row.row_body, chunk.rowBodies[page.start+index]!), "durable_row_body_mismatch");
      }
    }
  }
  async function recordChunkProof(transaction: PostgresTransaction, chunk: VerifiedOpaquePreservationChunk): Promise<void> {
    const plan = chunk.plan;
    const proof = await transaction.query(sql.verifyChunk, [operationId, plan.table, manifest.manifestSha256, plan.sha256, plan.rowCount, plan.ordinal]);
    requireThat(proof.rowCount === 1, "chunk_verification_proof_write_failed");
  }
  await locked(async transaction => {
    await transaction.query(sql.insertOperation, [operationId, ...lineage, manifest.value.catalogFingerprint, manifest.body,
      manifest.value.tables.length, manifest.totalChunks, manifest.totalRows]);
    await checkOperation(transaction);
    for (const table of manifest.value.tables) await transaction.query(sql.insertTable, [operationId, table.name, ...lineage, table.rowCount, table.chunks.length, table.contentSha256]);
    const plans = await transaction.query(sql.selectTables, [operationId, manifest.value.tables.length + 1]);
    assertTablePlans(plans.rows, manifest);
  });
  // Only the acknowledgement escapes this frame. Source views and transaction closures
  // must be unreachable before the caller forces collection or reads the next chunk.
  async function importChunk(table: FullDataPreservationTablePlan, plan: FullDataPreservationChunkPlan): Promise<boolean> {
    const bytes = await readBoundedFile(bundle.directory, plan.file, manifest.value.limits.maximumChunkBytes);
    const chunk = (windows ? verifyOpaqueFullDataPreservationChunk : verifyFullDataPreservationChunk)(bytes, manifest, table.name, plan.ordinal, limits);
    return await locked(async transaction => {
      await checkOperation(transaction);
      const receipt = await transaction.query(sql.selectChunk, [operationId, table.name, plan.ordinal, windows ? 0 : limits.maxChunkBytes]);
      requireThat(receipt.rows.length <= 1, "duplicate_chunk_receipt");
      if (receipt.rows.length === 1) {
        if (windows) {
          assertReceiptPlan(receipt.rows[0]!,manifest,plan);
          requireThat(ledgerNumber(receipt.rows[0]!.chunk_bytes) === chunk.body.length,"chunk_receipt_body_mismatch");
          for (let offset=0; offset<chunk.body.length; offset+=windows.maximumBytes) {
            const length=Math.min(windows.maximumBytes,chunk.body.length-offset);
            const slice=await transaction.query(sql.selectChunkBodySlice,[operationId,table.name,plan.ordinal,offset+1,length]);
            requireThat(slice.rows.length===1 && equalBytes(slice.rows[0]!.body,chunk.body.subarray(offset,offset+length)),"chunk_receipt_body_mismatch");
          }
        } else assertReceipt(receipt.rows[0]!, manifest, chunk);
        await checkRows(transaction, chunk);
        if (receipt.rows[0]!.verified_manifest_sha256 !== null && receipt.rows[0]!.verified_manifest_sha256 !== undefined) assertChunkProof(receipt.rows[0]!, manifest, plan);
        else await recordChunkProof(transaction, chunk);
        return true;
      }
      const operation = await transaction.query(sql.selectOperation, [operationId, limits.maxManifestBytes]);
      requireThat(operation.rows[0]!.completed === false, "completed_operation_missing_receipt");
      for (const page of windows ? preservationRowByteWindows(chunk.rowBodies,windows.maximumRows,windows.maximumBytes) : [{start:0,end:plan.rowCount}]) {
        const bodies=chunk.rowBodies.slice(page.start,page.end);
        // BYTEA[] preparation expands each row into hex text before Bind encoding.
        input.checkpoint?.(false, bodies.reduce((bytes, body) => bytes + body.length * 2, 0));
        await transaction.query(sql.insertRows, [operationId, table.name, ...lineage,
          bodies.map((_body,index)=>plan.startRow+page.start+index), bodies, plan.ordinal]);
      }
      // Deferred row->chunk FKs ensure that no row can commit without its receipt.
      // The driver copies the full BYTEA into a Bind packet while this source frame is live.
      // Request collection before that allocation without claiming the frame was released.
      input.checkpoint?.(false, chunk.body.length);
      await transaction.query(sql.insertChunk, [operationId, table.name, ...lineage, plan.ordinal, plan.file, plan.startRow, plan.rowCount, plan.sha256, chunk.body]);
      await checkRows(transaction, chunk);
      await recordChunkProof(transaction, chunk);
      return false;
    });
  }
  let chunkIndex = 0;
  let yielded = false;
  chunks:
  for (const table of manifest.value.tables) {
    for (const plan of table.chunks) {
      const index = chunkIndex++;
      if (selection && (index < selection.startChunkIndex || index >= selection.endChunkIndexExclusive)) continue;
      checkpoint();
      if (segment && !admitsTransaction()) { yielded = true; break chunks; }
      const resumed = await importChunk(table, plan);
      // A returned acknowledgement means UOW.run awaited COMMIT successfully.
      if (resumed) resumedChunks++; else committedChunks++;
      checkpoint(true);
    }
  }
  if (segment) {
    checkpoint();
    requireThat(sha256(await readBoundedFile(bundle.directory, "manifest.json", limits.maxManifestBytes)) === manifest.manifestSha256, "manifest_lineage_changed");
    return segmentResult(yielded ? "yielded_before_transaction" : "segment_imported");
  }
  // Table verification checkpoints commit independently; no final transaction reads row bodies.
  for (const table of manifest.value.tables) {
    await locked(async transaction => {
      await checkOperation(transaction);
      const receipts = await transaction.query(sql.selectChunks, [operationId, table.name, table.chunks.length + 1]);
      requireThat(receipts.rows.length === table.chunks.length, "chunk_receipt_accounting_mismatch");
      for (const [index, plan] of table.chunks.entries()) assertChunkProof(receipts.rows[index]!, manifest, plan);
      const count = await transaction.query(sql.countRows, [operationId, table.name]);
      requireThat(count.rows.length === 1 && ledgerNumber(count.rows[0]!.row_count) === table.rowCount, "table_row_accounting_mismatch");
      const verified = await transaction.query(sql.verifyTable, [operationId, table.name, manifest.manifestSha256, table.rowCount, table.chunks.length]);
      requireThat(verified.rowCount === 1, "table_verification_proof_write_failed");
    });
  }
  checkpoint();
  requireThat(sha256(await readBoundedFile(bundle.directory, "manifest.json", limits.maxManifestBytes)) === manifest.manifestSha256, "manifest_lineage_changed");
  await locked(async transaction => {
    await checkOperation(transaction);
    const plans = await transaction.query(sql.selectTables, [operationId, manifest.value.tables.length + 1]); assertTablePlans(plans.rows, manifest);
    for (const row of plans.rows) assertTableProof(row, manifest, manifest.value.tables.find(table => table.name === row.table_name)!);
    const verifiedChunks = await transaction.query(sql.countVerifiedChunks, [operationId, manifest.manifestSha256]);
    requireThat(verifiedChunks.rows.length === 1 && ledgerNumber(verifiedChunks.rows[0]!.chunk_count) === manifest.totalChunks &&
      ledgerNumber(verifiedChunks.rows[0]!.row_count) === manifest.totalRows && verifiedChunks.rows[0]!.all_verified === true, "final_accounting_mismatch");
    const complete = await transaction.query(sql.completeOperation, [operationId, ...lineage]);
    requireThat(complete.rowCount === 1 && complete.rows.length === 1 && complete.rows[0]!.operation_id === operationId, "completion_receipt_mismatch");
  });
  return Object.freeze({ operationId, snapshotSha256: manifest.value.snapshotSha256, manifestSha256: manifest.manifestSha256,
    totalTables: manifest.value.tables.length, totalRows: manifest.totalRows, totalChunks: manifest.totalChunks,
    committedChunks, resumedChunks, completed: true, grantsBusinessEligibility: false });
}

export interface FullDataPreservationSourceReader { read(directory: string, file: string, maximum: number): Promise<Buffer>; }
const preservationSourceReaders = new AsyncLocalStorage<FullDataPreservationSourceReader>();
/** Fixture I/O port only. All manifest/chunk/table digest validation remains mandatory. */
export function withFullDataPreservationSourceReader<T>(reader: FullDataPreservationSourceReader, operation: () => Promise<T>): Promise<T> {
  return preservationSourceReaders.run(reader, operation);
}
export const readFullDataPreservationSourceFile = readBoundedFile;
