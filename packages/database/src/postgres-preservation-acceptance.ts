import { createHash } from "node:crypto";
import type { PostgresAcceptanceRuntime } from "./postgres-acceptance-driver.js";
import type { PostgresTransaction } from "./postgres-unit-of-work.js";
import type {
  PreservedSqliteValue, ProtectedSourceRow, RowProtectionBundle,
} from "./full-data-row-protection.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordered = <T>(value: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const int64Minimum = -(1n << 63n);
const int64Maximum = (1n << 63n) - 1n;
const maximumBundleBytes = 64 * 1024 * 1024;

export interface PreservationStorageCell {
  storage: PreservedSqliteValue["storage"];
  integerValue: string | null;
  realValue: string | null;
  byteValue: Buffer | null;
}
export interface PreservationRoundTripReport {
  status: "passed";
  scope: "isolated_preservation_staging_not_business_schema";
  sourceRows: number;
  sourceCells: number;
  sourceEdges: number;
  sourceRoots: number;
  sourceFingerprint: string;
  successCommitDropsTemporaryTables: true;
  partialFailureRollback: true;
  sameSessionCleanupVerified: true;
  exactObservedStorageValues: true;
  productionMigrationReady: false;
  businessActivation: false;
  gatewayDeliveryEnabled: false;
}

export function packPreservedSqliteValue(value: PreservedSqliteValue): PreservationStorageCell {
  if (!value || typeof value !== "object") throw new Error("invalid_preserved_value");
  const empty = { integerValue: null, realValue: null, byteValue: null };
  if (value.storage === "null") return { storage: "null", ...empty };
  if (typeof value.value !== "string") throw new Error("invalid_preserved_value");
  if (value.storage === "integer") {
    if (!/^-?(0|[1-9][0-9]*)$/.test(value.value)) throw new Error("invalid_preserved_integer");
    const number = BigInt(value.value);
    if (number < int64Minimum || number > int64Maximum || number.toString() !== value.value) {
      throw new Error("invalid_preserved_integer");
    }
    return { ...empty, storage: "integer", integerValue: value.value };
  }
  if (value.storage === "real") {
    const number = Number(value.value);
    if (!Number.isFinite(number) || (Object.is(number, -0) ? "-0" : number.toString()) !== value.value) {
      throw new Error("invalid_preserved_real");
    }
    return { ...empty, storage: "real", realValue: value.value };
  }
  if (value.storage === "text") {
    // BYTEA retains observed JavaScript text including NUL and isolated surrogates,
    // which cannot be stored unchanged as PostgreSQL TEXT or JSONB.
    return { ...empty, storage: "text", byteValue: Buffer.from(value.value, "utf16le") };
  }
  if (value.storage === "blob") {
    const bytes = Buffer.from(value.value, "base64");
    if (bytes.toString("base64") !== value.value) throw new Error("invalid_preserved_blob");
    return { ...empty, storage: "blob", byteValue: bytes };
  }
  throw new Error("invalid_preserved_storage");
}

export function unpackPreservedSqliteValue(row: Readonly<Record<string, unknown>>): PreservedSqliteValue {
  if (row.storage_type === "null") return { storage: "null" };
  if (row.storage_type === "integer" && typeof row.integer_value === "string") {
    const result: PreservedSqliteValue = { storage: "integer", value: row.integer_value };
    packPreservedSqliteValue(result); return result;
  }
  if (row.storage_type === "real" && typeof row.real_bits === "string" && /^[0-9a-f]{16}$/.test(row.real_bits)) {
    const number = Buffer.from(row.real_bits, "hex").readDoubleBE();
    const result: PreservedSqliteValue = { storage: "real", value: Object.is(number, -0) ? "-0" : number.toString() };
    packPreservedSqliteValue(result); return result;
  }
  if ((row.storage_type === "text" || row.storage_type === "blob") && Buffer.isBuffer(row.byte_value)) {
    if (row.storage_type === "text" && row.byte_value.length % 2 !== 0) throw new Error("invalid_preserved_text_bytes");
    return { storage: row.storage_type, value: row.byte_value.toString(row.storage_type === "text" ? "utf16le" : "base64") };
  }
  throw new Error("invalid_staged_value");
}

export function validatePreservationAcceptanceBundle(bundle: RowProtectionBundle): void {
  if (!bundle || bundle.version !== 1 || bundle.scope !== "declared_legacy_rows_and_preservation_dependencies" ||
      !bundle.declaredDependenciesComplete || !bundle.globalDeliveryAndBudgetGuardsComplete ||
      bundle.productionMigrationReady !== false || bundle.newEligibilityGranted !== false ||
      bundle.newPurchaseSamplesCreated !== 0 || !Array.isArray(bundle.issues) || bundle.issues.length ||
      !Array.isArray(bundle.rows) || bundle.rows.length < 1 || bundle.rows.length > 10_000 ||
      !Array.isArray(bundle.edges) || bundle.edges.length > 100_000 ||
      !Array.isArray(bundle.roots) || !bundle.roots.length || bundle.roots.length > 10_000 ||
      !Number.isSafeInteger(bundle.capturedAtMs) || bundle.capturedAtMs < 0) {
    throw new Error("preservation_bundle_not_ready_for_isolated_acceptance");
  }
  const ids = new Set<string>();
  let bytes = 0;
  const sourceRows: readonly ProtectedSourceRow[] = bundle.rows;
  for (const row of sourceRows) {
    if (!row || !identifier.test(row.table) || !row.values || !row.key || !Object.keys(row.key).length ||
        Object.keys(row.values).length > 1000 || ids.has(row.rowId)) throw new Error("invalid_preservation_row");
    for (const [column, value] of Object.entries(row.values)) {
      if (!identifier.test(column)) throw new Error("invalid_preservation_column");
      packPreservedSqliteValue(value);
    }
    for (const [column, value] of Object.entries(row.key)) {
      if (value.storage === "null" || JSON.stringify(value) !== JSON.stringify(row.values[column])) {
        throw new Error("invalid_preservation_key");
      }
    }
    if (row.rowId !== hash([row.table, ordered(row.key)]) ||
        row.contentFingerprint !== hash([row.table, ordered(row.values)])) {
      throw new Error("preservation_row_fingerprint_mismatch");
    }
    ids.add(row.rowId); bytes += Buffer.byteLength(JSON.stringify(row.values));
  }
  if (bytes > maximumBundleBytes || bytes !== bundle.sourceBytesIncluded) throw new Error("preservation_bundle_size_mismatch");
  const edgeIds = new Set<string>();
  for (const edge of bundle.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || !identifier.test(edge.relation) || edgeIds.has(hash(edge))) {
      throw new Error("invalid_preservation_edge");
    }
    edgeIds.add(hash(edge));
  }
  const rootReferences = new Set<string>();
  const reasons = new Set(["trade_evidence", "legacy_aggregate_preservation", "unresolved_evidence", "delivery_guard"]);
  for (const root of bundle.roots) {
    if (typeof root.reference !== "string" || !root.reference.trim() || rootReferences.has(root.reference) ||
        !reasons.has(root.reason) || !root.rowId || !ids.has(root.rowId)) throw new Error("invalid_preservation_root");
    rootReferences.add(root.reference);
  }
  if (bundle.fingerprint !== hash({ rows: bundle.rows, edges: bundle.edges, roots: bundle.roots, issues: bundle.issues })) {
    throw new Error("preservation_bundle_fingerprint_mismatch");
  }
}

const createTemporaryTables = async (transaction: PostgresTransaction): Promise<void> => {
  await transaction.query("CREATE TEMP TABLE preservation_acceptance_rows(row_id TEXT PRIMARY KEY,table_name TEXT NOT NULL,key_bytes BYTEA NOT NULL,content_fingerprint TEXT NOT NULL) ON COMMIT DROP");
  await transaction.query("CREATE TEMP TABLE preservation_acceptance_cells(row_id TEXT NOT NULL REFERENCES preservation_acceptance_rows(row_id),column_name TEXT NOT NULL,storage_type TEXT NOT NULL,integer_value BIGINT,real_value DOUBLE PRECISION,byte_value BYTEA,PRIMARY KEY(row_id,column_name),CHECK((storage_type='null' AND integer_value IS NULL AND real_value IS NULL AND byte_value IS NULL) OR (storage_type='integer' AND integer_value IS NOT NULL AND real_value IS NULL AND byte_value IS NULL) OR (storage_type='real' AND integer_value IS NULL AND real_value IS NOT NULL AND byte_value IS NULL) OR (storage_type IN ('text','blob') AND integer_value IS NULL AND real_value IS NULL AND byte_value IS NOT NULL))) ON COMMIT DROP");
  await transaction.query("CREATE TEMP TABLE preservation_acceptance_edges(from_id TEXT NOT NULL REFERENCES preservation_acceptance_rows(row_id),to_id TEXT NOT NULL REFERENCES preservation_acceptance_rows(row_id),relation TEXT NOT NULL,PRIMARY KEY(from_id,to_id,relation)) ON COMMIT DROP");
  await transaction.query("CREATE TEMP TABLE preservation_acceptance_roots(reference_bytes BYTEA PRIMARY KEY,reason TEXT NOT NULL,row_id TEXT NOT NULL REFERENCES preservation_acceptance_rows(row_id)) ON COMMIT DROP");
};
const insertRowHeader = async (transaction: PostgresTransaction, row: ProtectedSourceRow): Promise<void> => {
  await transaction.query("INSERT INTO pg_temp.preservation_acceptance_rows VALUES($1,$2,$3,$4)",
    [row.rowId, row.table, Buffer.from(JSON.stringify(ordered(row.key)), "utf16le"), row.contentFingerprint]);
};
const readBackend = async (transaction: PostgresTransaction): Promise<number> => {
  const pid = (await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) throw new Error("acceptance_backend_unavailable");
  return pid;
};
const cleanupVerified = async (runtime: PostgresAcceptanceRuntime, expectedPid: number): Promise<void> => {
  await runtime.run(async (transaction) => {
    if (await readBackend(transaction) !== expectedPid) throw new Error("acceptance_cleanup_session_changed");
    const row = (await transaction.query("SELECT to_regclass('pg_temp.preservation_acceptance_rows') AS rows_relation,to_regclass('pg_temp.preservation_acceptance_cells') AS cells_relation,to_regclass('pg_temp.preservation_acceptance_edges') AS edges_relation,to_regclass('pg_temp.preservation_acceptance_roots') AS roots_relation")).rows[0];
    if (!row || Object.values(row).some((relation) => relation !== null)) throw new Error("acceptance_temporary_relation_persisted");
  });
};

export async function verifyPostgresPreservationRoundTrip(
  runtime: PostgresAcceptanceRuntime, bundle: RowProtectionBundle,
): Promise<PreservationRoundTripReport> {
  validatePreservationAcceptanceBundle(bundle);
  await runtime.probe();
  const successPid = await runtime.run(async (transaction) => {
    const pid = await readBackend(transaction);
    await createTemporaryTables(transaction);
    for (const row of bundle.rows) {
      await insertRowHeader(transaction, row);
      const cells = Object.entries(row.values);
      const parameters: unknown[] = [];
      const placeholders = cells.map(([column, value], index) => {
        const packed = packPreservedSqliteValue(value);
        parameters.push(row.rowId, column, packed.storage, packed.integerValue, packed.realValue, packed.byteValue);
        return "(" + Array.from({ length: 6 }, (_, position) => "$" + (index * 6 + position + 1)).join(",") + ")";
      });
      await transaction.query("INSERT INTO pg_temp.preservation_acceptance_cells VALUES " + placeholders.join(","), parameters);
    }
    for (const edge of bundle.edges) {
      await transaction.query("INSERT INTO pg_temp.preservation_acceptance_edges VALUES($1,$2,$3)", [edge.from, edge.to, edge.relation]);
    }
    for (const root of bundle.roots) {
      await transaction.query("INSERT INTO pg_temp.preservation_acceptance_roots VALUES($1,$2,$3)",
        [Buffer.from(root.reference, "utf16le"), root.reason, root.rowId]);
    }
    const headers = (await transaction.query("SELECT row_id,table_name,key_bytes,content_fingerprint FROM pg_temp.preservation_acceptance_rows")).rows;
    const cells = (await transaction.query("SELECT row_id,column_name,storage_type,integer_value::text AS integer_value,encode(float8send(real_value),'hex') AS real_bits,byte_value FROM pg_temp.preservation_acceptance_cells")).rows;
    const restored = new Map<string, Record<string, PreservedSqliteValue>>();
    for (const cell of cells) {
      if (typeof cell.row_id !== "string" || typeof cell.column_name !== "string") throw new Error("invalid_staged_cell_identity");
      const values = restored.get(cell.row_id) ?? {};
      values[cell.column_name] = unpackPreservedSqliteValue(cell);
      restored.set(cell.row_id, values);
    }
    if (headers.length !== bundle.rows.length || cells.length !== bundle.rows.reduce((sum, row) => sum + Object.keys(row.values).length, 0)) {
      throw new Error("preservation_round_trip_count_mismatch");
    }
    const expected = new Map(bundle.rows.map((row) => [row.rowId, row]));
    for (const header of headers) {
      const row = expected.get(String(header.row_id));
      if (!row || header.table_name !== row.table || header.content_fingerprint !== row.contentFingerprint ||
          !Buffer.isBuffer(header.key_bytes) ||
          !header.key_bytes.equals(Buffer.from(JSON.stringify(ordered(row.key)), "utf16le")) ||
          hash([row.table, ordered(restored.get(row.rowId) ?? {})]) !== row.contentFingerprint) {
        throw new Error("preservation_round_trip_value_mismatch");
      }
    }
    const stagedEdges = (await transaction.query("SELECT from_id,to_id,relation FROM pg_temp.preservation_acceptance_edges")).rows
      .map((row) => ({ from: row.from_id, to: row.to_id, relation: row.relation }));
    if (JSON.stringify(stagedEdges.map(hash).sort()) !== JSON.stringify(bundle.edges.map(hash).sort())) {
      throw new Error("preservation_round_trip_edge_mismatch");
    }
    const stagedRoots = (await transaction.query("SELECT reference_bytes,reason,row_id FROM pg_temp.preservation_acceptance_roots")).rows
      .map((row) => {
        if (!Buffer.isBuffer(row.reference_bytes)) throw new Error("invalid_staged_root_reference");
        return { reference: row.reference_bytes.toString("utf16le"), reason: row.reason, rowId: row.row_id };
      });
    if (JSON.stringify(stagedRoots.map(hash).sort()) !== JSON.stringify(bundle.roots.map(hash).sort())) {
      throw new Error("preservation_round_trip_root_mismatch");
    }
    return pid;
  });
  await cleanupVerified(runtime, successPid);

  let rollbackPid: number | null = null;
  let duplicateFailed = false;
  try {
    await runtime.run(async (transaction) => {
      rollbackPid = await readBackend(transaction);
      await createTemporaryTables(transaction);
      await insertRowHeader(transaction, bundle.rows[0]!);
      // Deliberately fail after the first staged write. The unit of work must
      // discard that row and every temporary relation before session reuse.
      await insertRowHeader(transaction, bundle.rows[0]!);
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "23505") throw error;
    duplicateFailed = true;
  }
  if (!duplicateFailed || rollbackPid === null) throw new Error("acceptance_partial_failure_not_observed");
  await cleanupVerified(runtime, rollbackPid);
  return {
    status: "passed", scope: "isolated_preservation_staging_not_business_schema",
    sourceRows: bundle.rows.length, sourceCells: bundle.rows.reduce((sum, row) => sum + Object.keys(row.values).length, 0),
    sourceEdges: bundle.edges.length, sourceRoots: bundle.roots.length, sourceFingerprint: bundle.fingerprint,
    successCommitDropsTemporaryTables: true, partialFailureRollback: true, sameSessionCleanupVerified: true,
    exactObservedStorageValues: true, productionMigrationReady: false, businessActivation: false, gatewayDeliveryEnabled: false,
  };
}

/** Extreme synthetic storage values, not actual trades or a business acceptance claim. */
export function createSyntheticPreservationAcceptanceBundle(): RowProtectionBundle {
  const makeRow = (table: string, key: Record<string, PreservedSqliteValue>, values: Record<string, PreservedSqliteValue>): ProtectedSourceRow => ({
    table, key: ordered(key), values: ordered(values), rowId: hash([table, ordered(key)]),
    contentFingerprint: hash([table, ordered(values)]),
  });
  const text = (value: string): PreservedSqliteValue => ({ storage: "text", value });
  const integer = (value: string): PreservedSqliteValue => ({ storage: "integer", value });
  const real = (value: string): PreservedSqliteValue => ({ storage: "real", value });
  const observed = makeRow("source_observations", { observation_id: text("synthetic-observation") }, {
    observation_id: text("synthetic-observation"), source: text("synthetic-fixture"), source_event_id: text("synthetic-event"),
    chain: text("solana"), observed_at: integer("9223372036854775807"), collected_at: integer("-9223372036854775808"),
    payload_version: integer("1"), payload: text("Synthetic\u0000payload\uD83D\uDE80\uD800"),
    confidence: real(Number.MIN_VALUE.toString()), extraction_mode: text("synthetic"),
    provenance: { storage: "blob", value: Buffer.from([0, 255, 128, 1]).toString("base64") },
    content_fingerprint: text("fixture-only"), fingerprint_version: integer("1"),
  });
  const enrichment = makeRow("source_observation_enrichments",
    { observation_id: text("synthetic-observation"), revision: integer("1") }, {
      observation_id: text("synthetic-observation"), revision: integer("1"), amount_usd: { storage: "null" },
      price_usd: real("-0"), collected_at: integer("9007199254740993"), provenance_json: text("synthetic-only"),
      quality_score: real(Number.MAX_VALUE.toString()), created_at: integer("101"),
    });
  const rows = [observed, enrichment].sort((a, b) => a.rowId.localeCompare(b.rowId));
  const edges = [{ from: observed.rowId, to: enrichment.rowId, relation: "source_enrichments" }];
  const roots = [{ reference: "synthetic-storage-boundaries", reason: "unresolved_evidence", rowId: observed.rowId }];
  const issues: RowProtectionBundle["issues"] = [];
  return {
    version: 1, capturedAtMs: 0, scope: "declared_legacy_rows_and_preservation_dependencies",
    rows, edges, roots, issues, declaredDependenciesComplete: true, globalDeliveryAndBudgetGuardsComplete: true,
    fingerprint: hash({ rows, edges, roots, issues }), sourceBytesIncluded: rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.values)), 0),
    newPurchaseSamplesCreated: 0, newEligibilityGranted: false, productionMigrationReady: false,
    unresolvedGates: ["synthetic_not_real_business_evidence", "formal_business_schema_and_production_cutover"],
  };
}
