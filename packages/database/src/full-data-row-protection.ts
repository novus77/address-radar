import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fullDataMigrationBaseline } from "./full-data-migration-baseline.js";

export type ProtectionKeyValue = string | number | bigint;
export interface ProtectionRowLocator {
  table: string;
  key: Readonly<Record<string, ProtectionKeyValue>>;
}
export interface RowProtectionRequest {
  roots: readonly {
    reference: string;
    reason: "trade_evidence" | "legacy_aggregate_preservation" | "unresolved_evidence" | "delivery_guard";
    row: ProtectionRowLocator;
  }[];
}
export type PreservedSqliteValue =
  | { storage: "null" }
  | { storage: "integer" | "real" | "text" | "blob"; value: string };
export interface ProtectedSourceRow {
  rowId: string;
  table: string;
  key: Readonly<Record<string, PreservedSqliteValue>>;
  values: Readonly<Record<string, PreservedSqliteValue>>;
  contentFingerprint: string;
}
export interface RowProtectionIssue {
  code: string;
  table: string;
  reference: string;
}
export interface RowProtectionBundle {
  version: 1;
  capturedAtMs: number;
  scope: "declared_legacy_rows_and_preservation_dependencies";
  rows: readonly ProtectedSourceRow[];
  edges: readonly { from: string; to: string; relation: string }[];
  roots: readonly { reference: string; reason: string; rowId: string | null }[];
  issues: readonly RowProtectionIssue[];
  declaredDependenciesComplete: boolean;
  globalDeliveryAndBudgetGuardsComplete: boolean;
  fingerprint: string;
  sourceBytesIncluded: number;
  newPurchaseSamplesCreated: 0;
  newEligibilityGranted: false;
  productionMigrationReady: false;
  unresolvedGates: readonly string[];
}
export interface RowProtectionReadLimits {
  maximumRows?: number;
  maximumBytes?: number;
}

export function readOnlyPurchaseDependencyBundle(
  databasePath: string, request: RowProtectionRequest, limits: RowProtectionReadLimits = {},
): RowProtectionBundle {
  const purchaseRoots = new Set(["wallet_monitor_observations", "wallet_monitor_execution_bases", "trader_execution_heads"]);
  if (!Array.isArray(request?.roots) || request.roots.length === 0 || request.roots.some(root =>
    root.reason !== "trade_evidence" || !root.row || !purchaseRoots.has(root.row.table))) {
    throw new Error("invalid_purchase_dependency_roots");
  }
  return readRowProtectionBundle(databasePath, request, limits, false);
}
type SourceRow = Record<string, string | number | bigint | Uint8Array | null>;
interface ForeignKeyGroup {
  parent: string;
  columns: readonly { from: string; to: string | null }[];
}
interface TableShape {
  columns: readonly string[];
  primaryKey: readonly string[];
  indexPrefixes: readonly (readonly string[])[];
  foreignKeys: readonly ForeignKeyGroup[];
}
const allowedTables = new Set(fullDataMigrationBaseline.map((table) => table.name));
const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordered = <T>(value: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const encode = (value: SourceRow[string]): PreservedSqliteValue => {
  if (value === null) return { storage: "null" };
  if (typeof value === "bigint") return { storage: "integer", value: value.toString() };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_source_value");
    return { storage: "real", value: Object.is(value, -0) ? "-0" : value.toString() };
  }
  if (typeof value === "string") return { storage: "text", value };
  return { storage: "blob", value: Buffer.from(value).toString("base64") };
};
const valueKey = (value: SourceRow[string]): ProtectionKeyValue | null =>
  value !== null && !(value instanceof Uint8Array) ? value : null;

const safetyTables = [
  "broadcast_records", "evidence_consumption", "economic_evidence_consumption",
  "outcome_observations", "signal_outbox", "signal_outbox_migration_review",
  "provider_budget_usage", "provider_request_gates", "historical_backfill_credit_usage",
] as const;

/**
 * Read an exact, bounded preservation slice. No source migration, registry,
 * importer, consumer or retention writer is invoked.
 */
export function readOnlyRowProtectionBundle(
  databasePath: string,
  request: RowProtectionRequest,
  limits: RowProtectionReadLimits = {},
): RowProtectionBundle {
  return readRowProtectionBundle(databasePath, request, limits, true);
}

function readRowProtectionBundle(
  databasePath: string, request: RowProtectionRequest, limits: RowProtectionReadLimits,
  includeGlobalGuards: boolean,
): RowProtectionBundle {
  const maximumRows = limits.maximumRows ?? 1000;
  const maximumBytes = limits.maximumBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 10_000 ||
      !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
    throw new Error("invalid_row_protection_limits");
  }
  if (!Array.isArray(request.roots) || request.roots.length === 0 || request.roots.length > maximumRows) {
    throw new Error("invalid_row_protection_roots");
  }
  const reasons = new Set(["trade_evidence", "legacy_aggregate_preservation", "unresolved_evidence", "delivery_guard"]);
  const references = new Set<string>();
  for (const root of request.roots) {
    if (!root.reference?.trim() || references.has(root.reference) || !reasons.has(root.reason) ||
        !root.row || !allowedTables.has(root.row.table) ||
        !root.row.key || Object.keys(root.row.key).length === 0 ||
        Object.values(root.row.key).some((value) => typeof value !== "string" && typeof value !== "bigint" &&
          !(typeof value === "number" && Number.isSafeInteger(value)))) {
      throw new Error("invalid_row_protection_root");
    }
    references.add(root.reference);
  }
  const path = realpathSync(databasePath);
  if (!statSync(path).isFile()) throw new Error("row_protection_source_not_regular_file");
  const database = new DatabaseSync(path, { readOnly: true });
  const rows = new Map<string, ProtectedSourceRow>();
  const edges = new Map<string, { from: string; to: string; relation: string }>();
  const shapes = new Map<string, TableShape>();
  const issues = new Map<string, RowProtectionIssue>();
  const queue: { row: SourceRow; node: ProtectedSourceRow }[] = [];
  let sourceBytesIncluded = 0;
  let truncated = false;
  const issue = (code: string, table: string, reference: string): void => {
    const value = { code, table, reference };
    issues.set(hash(value), value);
  };

  const shape = (table: string): TableShape | null => {
    if (!allowedTables.has(table)) { issue("unreviewed_dependency_table", table, "schema"); return null; }
    const cached = shapes.get(table);
    if (cached) return cached;
    const columns = database.prepare("PRAGMA table_info(" + quote(table) + ")").all();
    if (!columns.length) { issue("missing_dependency_table", table, "schema"); return null; }
    const primaryKey = columns.filter((column) => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk)).map((column) => String(column.name));
    if (!primaryKey.length) { issue("missing_replayable_primary_key", table, "schema"); return null; }
    const indexPrefixes: string[][] = [primaryKey];
    for (const index of database.prepare("PRAGMA index_list(" + quote(table) + ")").all()) {
      if (Number(index.partial)) continue;
      const parts = database.prepare("PRAGMA index_info(" + quote(String(index.name)) + ")").all();
      if (parts.every((part) => typeof part.name === "string")) indexPrefixes.push(parts.map((part) => String(part.name)));
    }
    const grouped = new Map<number, { parent: string; columns: { seq: number; from: string; to: string | null }[] }>();
    for (const key of database.prepare("PRAGMA foreign_key_list(" + quote(table) + ")").all()) {
      const group = grouped.get(Number(key.id)) ?? { parent: String(key.table), columns: [] };
      group.columns.push({ seq: Number(key.seq), from: String(key.from), to: key.to === null ? null : String(key.to) });
      grouped.set(Number(key.id), group);
    }
    const result: TableShape = {
      columns: columns.map((column) => String(column.name)), primaryKey, indexPrefixes,
      foreignKeys: [...grouped.values()].map((group) => ({
        parent: group.parent, columns: group.columns.sort((a, b) => a.seq - b.seq).map(({ from, to }) => ({ from, to })),
      })),
    };
    shapes.set(table, result);
    return result;
  };

  const add = (table: string, row: SourceRow): ProtectedSourceRow | null => {
    const metadata = shape(table);
    if (!metadata) return null;
    const keys = Object.fromEntries(metadata.primaryKey.map((column) => [column, row[column] ?? null]));
    if (Object.values(keys).some((value) => valueKey(value) === null)) {
      issue("unreplayable_source_key", table, "key"); return null;
    }
    const key = ordered(Object.fromEntries(Object.entries(keys).map(([column, value]) => [column, encode(value)])));
    const rowId = hash([table, key]);
    const existing = rows.get(rowId);
    if (existing) return existing;
    const values = ordered(Object.fromEntries(Object.entries(row).map(([column, value]) => [column, encode(value)])));
    const bytes = Buffer.byteLength(JSON.stringify(values));
    if (rows.size >= maximumRows || sourceBytesIncluded + bytes > maximumBytes) {
      truncated = true; issue("preservation_limit_reached", table, rowId); return null;
    }
    const node: ProtectedSourceRow = { rowId, table, key, values, contentFingerprint: hash([table, values]) };
    rows.set(rowId, node); sourceBytesIncluded += bytes; queue.push({ row, node });
    return node;
  };

  const select = (
    table: string, filter: Readonly<Record<string, ProtectionKeyValue>>,
    reference: string, required: boolean, allSafetyRows = false,
  ): ProtectedSourceRow[] => {
    if (truncated) return [];
    if (!includeGlobalGuards && safetyTables.includes(table as typeof safetyTables[number])) {
      issue("global_guard_dependency_requires_coherent_export", table, reference); return [];
    }
    const metadata = shape(table);
    if (!metadata) return [];
    const keys = Object.keys(filter);
    if (keys.some((key) => !metadata.columns.includes(key))) {
      issue("missing_lookup_column", table, reference); return [];
    }
    // Do not silently use a full scan for reverse semantic references.
    const indexed = keys.length === 0 ? allSafetyRows : metadata.indexPrefixes.some((index) =>
      keys.length <= index.length && keys.every((key) => index.slice(0, keys.length).includes(key)));
    if (!indexed) { issue("unindexed_dependency_lookup", table, reference); return []; }
    const sql = "SELECT * FROM " + quote(table) +
      (keys.length ? " WHERE " + keys.map((key) => quote(key) + "=?").join(" AND ") : "") + " LIMIT ?";
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    const result: ProtectedSourceRow[] = [];
    for (const row of statement.iterate(...keys.map((key) => filter[key]!), maximumRows + 1)) {
      const node = add(table, row as SourceRow);
      if (node) result.push(node);
      if (truncated) break;
    }
    if (!result.length && required && !truncated) issue("missing_required_dependency_row", table, reference);
    return result;
  };

  const link = (from: ProtectedSourceRow, targets: readonly ProtectedSourceRow[], relation: string): void => {
    for (const target of targets) {
      const edge = { from: from.rowId, to: target.rowId, relation };
      edges.set(hash(edge), edge);
    }
  };
  const related = (
    node: ProtectedSourceRow, table: string, filter: Readonly<Record<string, ProtectionKeyValue>>,
    relation: string, required = false,
  ): void => link(node, select(table, filter, node.rowId + ":" + relation, required), relation);
  const semantic = (node: ProtectedSourceRow, row: SourceRow): void => {
    const source = valueKey(row.source ?? null);
    const event = valueKey(row.event_id ?? null);
    if (node.table === "wallet_monitor_observations" && source !== null && event !== null) {
      related(node, "wallet_monitor_execution_bases", { source, event_id: event }, "execution_basis", true);
      related(node, "trader_execution_heads", { source, event_id: event }, "execution_head", row.projected_at !== null);
      if (row.projected_at !== null) {
        related(node, "trader_events", { event_id: event }, "projected_event", true);
        related(node, "raw_trader_observations", { observation_id: "observation:onchain:" + String(event) }, "onchain_raw_observation", true);
      }
      for (const [column, table] of [["entity_id", "trader_entities"], ["account_id", "fomo_accounts"]] as const) {
        const value = valueKey(row[column] ?? null);
        if (value !== null) related(node, table, { [column]: value }, "observation_identity", true);
      }
    }
    if (node.table === "trader_execution_heads" && source !== null && event !== null) {
      const revision = valueKey(row.revision ?? null);
      if (revision !== null && BigInt(String(revision)) > 0n) {
        related(node, "trader_execution_revisions", { source, event_id: event, revision }, "current_revision", true);
      }
      related(node, "trader_execution_revisions", { source, event_id: event }, "revision_history");
      related(node, "execution_revision_requests", { source, event_id: event }, "revision_consumers");
    }
    if (node.table === "trader_execution_revisions" && source !== null && event !== null) {
      related(node, "trader_execution_heads", { source, event_id: event }, "revision_head", true);
    }
    if (node.table === "raw_trader_observations") {
      const observation = valueKey(row.observation_id ?? null);
      if (observation !== null) related(node, "canonical_trader_event_observations",
        { observation_id: observation }, "canonical_reverse_link");
    }
    if (node.table === "canonical_trader_events") {
      const canonical = valueKey(row.canonical_event_id ?? null);
      if (canonical !== null) related(node, "canonical_trader_event_observations",
        { canonical_event_id: canonical }, "canonical_observation_links", true);
    }
    if (node.table === "source_observations") {
      const observation = valueKey(row.observation_id ?? null);
      if (observation !== null) {
        related(node, "source_observation_enrichments", { observation_id: observation }, "source_enrichments");
        related(node, "source_observation_conflicts", { observation_id: observation }, "source_conflicts");
      }
    }
    if (node.table === "source_observation_conflicts") {
      const observation = valueKey(row.observation_id ?? null);
      if (observation !== null) related(node, "source_observations", { observation_id: observation }, "conflicted_source", true);
    }
    if (node.table === "trader_token_samples") {
      issue("legacy_aggregate_requires_per_purchase_reconstruction", node.table, node.rowId);
    }
  };

  try {
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100; BEGIN;");
    const roots = request.roots.map((root) => {
      const metadata = shape(root.row.table);
      const keys = Object.keys(root.row.key);
      if (metadata && (keys.length !== metadata.primaryKey.length ||
          keys.some((key) => !metadata.primaryKey.includes(key)))) {
        issue("root_requires_complete_primary_key", root.row.table, root.reference);
        return { reference: root.reference, reason: root.reason, rowId: null };
      }
      const found = select(root.row.table, root.row.key, root.reference, true);
      if (found.length > 1) issue("ambiguous_root_key", root.row.table, root.reference);
      return { reference: root.reference, reason: root.reason, rowId: found.length === 1 ? found[0]!.rowId : null };
    });
    const issuesBeforeSafety = new Set(issues.keys());
    if (includeGlobalGuards) {
      for (const table of safetyTables) select(table, {}, "global_delivery_and_budget_guards", false, true);
    }
    const safetyFailed = !includeGlobalGuards || truncated || [...issues.keys()].some((key) => !issuesBeforeSafety.has(key));
    let cursor = 0;
    while (cursor < queue.length && !truncated) {
      const { row, node } = queue[cursor++]!;
      const metadata = shape(node.table)!;
      for (const group of metadata.foreignKeys) {
        // SQLite composite foreign keys are satisfied when any child component is NULL.
        if (group.columns.some((column) => row[column.from] === null)) continue;
        const parent = shape(group.parent);
        if (!parent) continue;
        const filter: Record<string, ProtectionKeyValue> = {};
        for (const [index, column] of group.columns.entries()) {
          const target = column.to ?? parent.primaryKey[index];
          const value = valueKey(row[column.from] ?? null);
          if (!target || value === null) {
            issue("unresolvable_foreign_key", node.table, node.rowId); continue;
          }
          filter[target] = value;
        }
        if (Object.keys(filter).length !== group.columns.length) continue;
        related(node, group.parent, filter, "foreign_key", true);
      }
      semantic(node, row);
    }
    const capturedAtMs = Date.now();
    const protectedRows = [...rows.values()].sort((a, b) => a.rowId.localeCompare(b.rowId));
    const protectedEdges = [...edges.values()].sort((a, b) => hash(a).localeCompare(hash(b)));
    const reportedIssues = [...issues.values()].sort((a, b) => hash(a).localeCompare(hash(b)));
    const unresolvedGates = [
      "full_schema_classification_and_target_ddl_review",
      "complete_semantic_reference_inventory_and_policy_provenance",
      "per_purchase_reconstruction_and_30_day_price_range_proof",
      "consistent_backup_delta_journal_and_replayable_rollback",
      "isolated_target_import_and_exact_storage_round_trip",
      "separate_production_migration_and_cutover_approval",
    ];
    if (!includeGlobalGuards) unresolvedGates.push("coherent_global_guard_export_and_target_round_trip");
    const fingerprint = includeGlobalGuards
      ? hash({ rows: protectedRows, edges: protectedEdges, roots, issues: reportedIssues })
      : hash({ scope: "purchase_dependencies_without_global_guard_export", rows: protectedRows,
        edges: protectedEdges, roots, issues: reportedIssues });
    database.exec("ROLLBACK;");
    return {
      version: 1, capturedAtMs, scope: "declared_legacy_rows_and_preservation_dependencies",
      rows: protectedRows, edges: protectedEdges, roots, issues: reportedIssues,
      declaredDependenciesComplete: reportedIssues.length === 0 && !truncated,
      globalDeliveryAndBudgetGuardsComplete: !safetyFailed && !truncated &&
        !reportedIssues.some((entry) => safetyTables.includes(entry.table as typeof safetyTables[number])),
      fingerprint,
      sourceBytesIncluded, newPurchaseSamplesCreated: 0, newEligibilityGranted: false,
      productionMigrationReady: false, unresolvedGates,
    };
  } finally { database.close(); }
}

export function summarizeRowProtectionBundle(bundle: RowProtectionBundle) {
  return {
    version: bundle.version, capturedAtMs: bundle.capturedAtMs, scope: bundle.scope,
    rowCount: bundle.rows.length, edgeCount: bundle.edges.length,
    tables: [...new Set(bundle.rows.map((row) => row.table))].sort(),
    roots: bundle.roots.map((root) => ({
      referenceFingerprint: hash(root.reference), reason: root.reason, rowId: root.rowId,
    })),
    issues: bundle.issues.map((entry) => ({
      code: entry.code, table: entry.table, referenceFingerprint: hash(entry.reference),
    })),
    declaredDependenciesComplete: bundle.declaredDependenciesComplete,
    globalDeliveryAndBudgetGuardsComplete: bundle.globalDeliveryAndBudgetGuardsComplete,
    fingerprint: bundle.fingerprint, sourceBytesIncluded: bundle.sourceBytesIncluded,
    newPurchaseSamplesCreated: bundle.newPurchaseSamplesCreated,
    newEligibilityGranted: bundle.newEligibilityGranted,
    productionMigrationReady: bundle.productionMigrationReady, unresolvedGates: bundle.unresolvedGates,
  };
}
