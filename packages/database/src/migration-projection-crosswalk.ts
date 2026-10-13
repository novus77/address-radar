import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { MigrationTableMapping } from "./full-data-migration-manifest.js";
import { verifyFullDataPreservationChunk, verifyFullDataPreservationManifest,
  type FullDataPreservationCell, type FullDataPreservationCatalog } from "./postgres-full-data-import.js";

export interface MigrationProjectionTrustedSource {
  readonly operationId: string; readonly snapshotSha256: string; readonly catalogFingerprint: string;
  readonly manifestSha256: string; readonly reviewedRoutingSha256: string;
}
export interface MigrationSemanticReferenceRule {
  readonly table: string; readonly column: string; readonly path: readonly (string | number)[];
  readonly targetTable: string; readonly targetColumns: readonly string[];
  readonly storageClasses: readonly ("text" | "integer" | "real" | "blob")[];
}
export interface MigrationProjectionRoutingBaseline {
  readonly reviewId: string; readonly mappings: readonly MigrationTableMapping[];
  readonly semanticReferences: readonly MigrationSemanticReferenceRule[];
  readonly semanticFields: readonly { readonly table: string; readonly column: string }[];
}
export interface MigrationProjectionLimits {
  readonly maximumRows: number; readonly maximumChunks: number; readonly maximumBytes: number;
  readonly maximumIndexEntries: number; readonly maximumReferences: number; readonly maximumIssues: number;
  readonly maximumKeyBytes: number; readonly maximumJsonBytes: number; readonly maximumJsonNodes: number;
}
export const migrationProjectionLimits: Readonly<MigrationProjectionLimits> = Object.freeze({
  maximumRows: 100_000, maximumChunks: 10_000, maximumBytes: 64 * 1024 * 1024,
  maximumIndexEntries: 500_000, maximumReferences: 500_000, maximumIssues: 100_000,
  maximumKeyBytes: 16_384, maximumJsonBytes: 1024 * 1024, maximumJsonNodes: 10_000,
});
export const migrationIdentityMetadataAdapters = Object.freeze({
  trader_entities: ["entity_id", "lifecycle", "manual", "locked"],
  trader_profiles: ["entity_id", "monitoring_enabled", "fomo_monitoring_enabled", "onchain_monitoring_enabled"],
  fomo_accounts: ["account_id"], entity_accounts: ["entity_id", "account_id", "confidence"],
  entity_wallet_identities: ["entity_id", "chain_family", "address", "confidence"],
  wallet_identities: ["account_id", "chain_family", "address", "confidence"],
} as const);
export interface MigrationProjectionIssue {
  readonly code: string; readonly table: string; readonly rowOrdinal: number | null; readonly field: string | null;
}
export interface MigrationProjectionRowLocation { readonly table: string; readonly rowOrdinal: number }
export interface MigrationProjectionReference {
  readonly kind: "foreign_key" | "semantic_json"; readonly field: string; readonly targetTable: string;
  readonly targetColumns: readonly string[]; readonly values: readonly FullDataPreservationCell[];
  readonly status: "resolved_exact_storage" | "null_reference" | "unresolved" | "ambiguous" | "unknown";
  readonly candidateCount: number; readonly candidates: readonly MigrationProjectionRowLocation[];
}
export interface MigrationProjectionRow extends MigrationProjectionRowLocation {
  readonly rowBodySha256: string; readonly targetRoute: MigrationTableMapping["targetRoute"];
  readonly values: Readonly<Record<string, FullDataPreservationCell>>;
  readonly primaryKey: readonly FullDataPreservationCell[] | null;
  readonly references: readonly MigrationProjectionReference[];
  readonly status: "historical" | "quarantined"; readonly grantsBusinessEligibility: false;
}
export interface MigrationProjectionIdentityCohort {
  readonly entityId: string | null; readonly entityKey: string;
  readonly lifecycle: string | null; readonly suspended: boolean | null;
  readonly manual: boolean | null; readonly locked: boolean | null;
  readonly profileFlags: Readonly<Record<string, boolean | null>>;
  readonly accounts: readonly FullDataPreservationCell[];
  readonly wallets: readonly { readonly family: string; readonly comparisonAddress: string; readonly sourceAddresses: readonly string[];
    readonly confidenceEvidence: readonly { readonly source: MigrationProjectionRowLocation; readonly value: FullDataPreservationCell; readonly recognized: string | null }[] }[];
  readonly status: "historical_coherent" | "quarantined"; readonly grantsBusinessEligibility: false;
}
export interface MigrationProjectionCrosswalk {
  readonly operationId: string; readonly snapshotSha256: string; readonly catalogFingerprint: string; readonly reviewedRoutingSha256: string;
  readonly rows: readonly MigrationProjectionRow[]; readonly identityCohorts: readonly MigrationProjectionIdentityCohort[];
  readonly issues: readonly MigrationProjectionIssue[];
  readonly coverage: { readonly plannedTables: number; readonly plannedRows: number; readonly providedRows: number; readonly providedChunks: number;
    readonly supportedIdentityTables: readonly string[]; readonly semanticReferenceRules: number; readonly completeSemanticCoverage: false;
    readonly cohortCountsAreDiagnostic: true };
  readonly historicalOnly: true; readonly grantsBusinessEligibility: false; readonly sourceWrites: false; readonly databaseWrites: false;
}

const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const requireThat = (condition: unknown, reason: string): void => { if (!condition) throw new Error("migration_projection_" + reason); };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => canonical(key) + ":" + canonical(child)).join(",") + "}";
  const body = JSON.stringify(value); requireThat(typeof body === "string", "invalid_review_value");
  return body!.replace(/[\x7f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function label(value: unknown): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\x00-\x1f]/.test(value); }

/** This digest binds the complete externally reviewed routing and semantic rule document. */
export function migrationProjectionRoutingFingerprint(baseline: MigrationProjectionRoutingBaseline): string {
  return digest(canonical(baseline));
}

type CatalogTable = FullDataPreservationCatalog["tables"][number];
type MutableRow = Omit<MigrationProjectionRow, "references" | "status"> & { references: MigrationProjectionReference[]; status: "historical" | "quarantined" };
type Cohort = Omit<MigrationProjectionIdentityCohort, "accounts" | "wallets" | "status"> & {
  accounts: FullDataPreservationCell[]; wallets: Array<MigrationProjectionIdentityCohort["wallets"][number]>; status: "historical_coherent" | "quarantined";
};

/** Pure, bounded diagnostics for selected verified chunks. Never creates an active identity or fact.
 * Expected digests must come from an independent approved artifact, not from the untrusted bundle.
 * Exact storage keys do not emulate SQLite affinity/collation. Unprovided rows remain unknown.
 */
export function createMigrationProjectionCrosswalk(input: {
  readonly manifest: Uint8Array; readonly trustedSource: MigrationProjectionTrustedSource;
  readonly reviewedRoutingBaseline: MigrationProjectionRoutingBaseline;
  readonly chunks: readonly { readonly table: string; readonly ordinal: number; readonly body: Uint8Array }[];
  readonly limits?: Partial<MigrationProjectionLimits>;
}): MigrationProjectionCrosswalk {
  const limits = { ...migrationProjectionLimits, ...input.limits };
  for (const [key, value] of Object.entries(limits)) requireThat(Object.hasOwn(migrationProjectionLimits, key) && Number.isSafeInteger(value) && value > 0 && value <= migrationProjectionLimits[key as keyof MigrationProjectionLimits], "invalid_limit");
  requireThat(input.manifest.byteLength <= limits.maximumBytes && input.chunks.length <= limits.maximumChunks, "input_limit");
  const manifest = verifyFullDataPreservationManifest(input.manifest);
  const trusted = input.trustedSource;
  requireThat(trusted.operationId === manifest.value.operationId && trusted.snapshotSha256 === manifest.value.snapshotSha256 &&
    trusted.catalogFingerprint === manifest.value.catalogFingerprint && trusted.manifestSha256 === manifest.manifestSha256, "trusted_source_mismatch");
  const baseline = input.reviewedRoutingBaseline;
  requireThat(label(baseline.reviewId) && baseline.mappings.length === 141 && manifest.value.tables.length === 141 &&
    baseline.semanticReferences.length <= 1000 && baseline.semanticFields.length <= 10_000, "reviewed_baseline_shape_mismatch");
  requireThat(/^[0-9a-f]{64}$/.test(trusted.reviewedRoutingSha256) && migrationProjectionRoutingFingerprint(baseline) === trusted.reviewedRoutingSha256, "reviewed_routing_mismatch");
  const catalog = new Map(manifest.value.catalog.tables.map(table => [table.name, table]));
  const routes = new Map<string, MigrationTableMapping>();
  for (const mapping of baseline.mappings) {
    const table = catalog.get(mapping.sourceTable);
    requireThat(table && !routes.has(mapping.sourceTable) && typeof mapping.targetRoute === "string" &&
      ["identity_review", "validated_fact_staging", "legacy_preservation"].includes(mapping.targetRoute) &&
      mapping.sourceRetention === "preserve" && mapping.activateConsumers === false && mapping.grantRadarEligibility === false &&
      label(mapping.family) && label(mapping.disposition) && mapping.columns.length === table.columns.length, "invalid_reviewed_mapping");
    if (!table) throw new Error("migration_projection_missing_reviewed_table");
    if (mapping.family === "legacy_results") requireThat(mapping.targetRoute === "legacy_preservation", "legacy_results_route_mismatch");
    for (const [index, column] of mapping.columns.entries()) {
      const source = table.columns[index]!;
      requireThat(column.sourceColumn === source[1] && column.sourceType === source[2] && column.notNull === (source[3] === 1) &&
        column.primaryKeyPosition === (source[5] === 0 ? null : source[5]) && label(column.targetField) &&
        column.conversion === "preserve_source_representation", "reviewed_column_mismatch");
    }
    routes.set(mapping.sourceTable, mapping);
  }
  requireThat(routes.size === catalog.size, "reviewed_table_accounting_mismatch");
  const issues: MigrationProjectionIssue[] = []; const rows: MutableRow[] = [];
  const byTable = new Map<string, MutableRow[]>(); const seenChunks = new Set<string>();
  let bytes = input.manifest.byteLength; let referenceCount = 0; let indexEntries = 0;
  function issue(code: string, table: string, rowOrdinal: number | null, field: string | null = null): void {
    requireThat(issues.length < limits.maximumIssues, "issue_limit"); issues.push({ code, table, rowOrdinal, field });
  }
  function quarantine(row: MutableRow, code: string, field: string | null = null): void { row.status = "quarantined"; issue(code, row.table, row.rowOrdinal, field); }
  function tuple(cells: readonly FullDataPreservationCell[]): string | null {
    const key = canonical(cells); return Buffer.byteLength(key) <= limits.maximumKeyBytes ? key : null;
  }
  function primaryColumns(table: CatalogTable): string[] {
    return table.columns.filter(column => Number(column[5]) > 0).sort((a, b) => Number(a[5]) - Number(b[5])).map(column => column[1] as string);
  }
  for (const entry of input.chunks) {
    bytes += entry.body.byteLength; requireThat(bytes <= limits.maximumBytes, "byte_limit");
    const key = canonical([entry.table, entry.ordinal]); requireThat(!seenChunks.has(key), "duplicate_chunk"); seenChunks.add(key);
    const chunk = verifyFullDataPreservationChunk(entry.body, manifest, entry.table, entry.ordinal);
    const table = catalog.get(entry.table)!;
    for (const [index, source] of chunk.rows.entries()) {
      requireThat(rows.length < limits.maximumRows, "row_limit");
      const values = Object.fromEntries(table.columns.map((column, position) => [column[1] as string, source.values[position]!])) as Record<string, FullDataPreservationCell>;
      const columns = primaryColumns(table);
      const row: MutableRow = { table: entry.table, rowOrdinal: chunk.plan.startRow + index, rowBodySha256: digest(chunk.rowBodies[index]!),
        targetRoute: routes.get(entry.table)!.targetRoute, values, primaryKey: columns.length ? columns.map(column => values[column]!) : null,
        references: [], status: "historical", grantsBusinessEligibility: false };
      rows.push(row); const bucket = byTable.get(row.table) ?? []; bucket.push(row); byTable.set(row.table, bucket);
      if (row.primaryKey === null) quarantine(row, "unknown_primary_key");
      else if (row.primaryKey.some(cell => cell.storage === "null")) quarantine(row, "nullable_primary_key");
    }
  }
  const indexes = new Map<string, Map<string, MutableRow[]>>();
  function getIndex(tableName: string, columns: readonly string[]): Map<string, MutableRow[]> | null {
    const shape = catalog.get(tableName);
    if (!shape || !columns.length || columns.some(column => !shape.columns.some(source => source[1] === column))) return null;
    const id = canonical([tableName, columns]); const existing = indexes.get(id); if (existing) return existing;
    const index = new Map<string, MutableRow[]>();
    for (const row of byTable.get(tableName) ?? []) {
      const cells = columns.map(column => row.values[column]!); if (cells.some(cell => cell.storage === "null")) continue;
      const key = tuple(cells); if (key === null) { quarantine(row, "unsupported_large_reference_key"); continue; }
      requireThat(++indexEntries <= limits.maximumIndexEntries, "index_entry_limit");
      const bucket = index.get(key) ?? []; bucket.push(row); index.set(key, bucket);
    }
    indexes.set(id, index); return index;
  }
  for (const table of catalog.values()) {
    const columns = primaryColumns(table); const index = getIndex(table.name, columns);
    if (index) for (const bucket of index.values()) if (bucket.length > 1) for (const row of bucket) quarantine(row, "duplicate_primary_key");
  }
  function reference(row: MutableRow, kind: MigrationProjectionReference["kind"], field: string, targetTable: string, targetColumns: readonly string[], cells: readonly FullDataPreservationCell[] | null): void {
    requireThat(++referenceCount <= limits.maximumReferences, "reference_limit");
    const index = getIndex(targetTable, targetColumns); const key = cells ? tuple(cells) : null;
    const nullable = cells?.some(cell => cell.storage === "null") ?? false;
    const candidates = cells && key !== null && !nullable && index ? index.get(key) ?? [] : [];
    const status = cells === null || key === null || !index ? "unknown" : nullable ? "null_reference" :
      candidates.length === 1 ? "resolved_exact_storage" : candidates.length > 1 ? "ambiguous" : "unresolved";
    row.references.push({ kind, field, targetTable, targetColumns: [...targetColumns], values: cells ?? [], status,
      candidateCount: candidates.length, candidates: candidates.slice(0, 20).map(candidate => ({ table: candidate.table, rowOrdinal: candidate.rowOrdinal })) });
    if (status === "unknown" || status === "unresolved" || status === "ambiguous") quarantine(row, status + "_" + kind, field);
  }
  for (const [tableName, bucket] of byTable) {
    const table = catalog.get(tableName)!;
    for (const foreignKey of table.foreignKeys) {
      issue("sqlite_affinity_and_collation_not_evaluated", tableName, null, "foreign_key:" + String(foreignKey.id));
      const parts = foreignKey.columns as readonly { sequence: number; from: string; to: string | null }[];
      const parent = catalog.get(foreignKey.table as string);
      const targetColumns = parts.every(part => part.to === null) && parent ? primaryColumns(parent) : parts.map(part => part.to ?? "");
      for (const row of bucket) reference(row, "foreign_key", "foreign_key:" + String(foreignKey.id), foreignKey.table as string, targetColumns,
        parts.every(part => row.values[part.from] !== undefined) && parts.length === targetColumns.length ? parts.map(part => row.values[part.from]!) : null);
    }
  }
  function text(cell: FullDataPreservationCell | undefined): string | null {
    if (!cell || cell.storage !== "text" || cell.encoding !== "base64") return null;
    try { return new TextDecoder(manifest.value.catalog.pragmas.encoding, { fatal: true, ignoreBOM: true }).decode(Buffer.from(cell.value, "base64")); }
    catch { return null; }
  }
  function parseSemanticJson(cell: FullDataPreservationCell): unknown {
    requireThat(cell.storage === "text" && cell.value.length <= Math.ceil(limits.maximumJsonBytes / 3) * 4, "semantic_json_byte_limit");
    const body = text(cell); requireThat(body !== null, "semantic_json_encoding_unknown");
    const parsed: unknown = JSON.parse(body!); let nodes = 0;
    function walk(value: unknown, depth: number): void {
      requireThat(++nodes <= limits.maximumJsonNodes && depth <= 16, "semantic_json_structure_limit");
      if (typeof value === "number") requireThat(Number.isSafeInteger(value), "semantic_json_number_unknown");
      if (value !== null && typeof value === "object") for (const child of Object.values(value)) walk(child, depth + 1);
    }
    walk(parsed, 0);
    // JSON.parse discards duplicate object keys. Detect them before using semantic fields.
    let position = 0; const space = () => { while (/\s/.test(body![position] ?? "") && position < body!.length) position++; };
    function token(): string { const start = position++; while (position < body!.length) { if (body![position] === "\\") { position += 2; continue; } if (body![position++] === '"') return body!.slice(start, position); } throw new Error("invalid_json"); }
    function scan(): void {
      space(); if (body![position] === "{") { position++; space(); const seen = new Set<string>();
        while (body![position] !== "}") { const key = JSON.parse(token()) as string; requireThat(!seen.has(key), "duplicate_semantic_json_key"); seen.add(key); space(); position++; scan(); space(); if (body![position] !== ",") break; position++; space(); } position++;
      } else if (body![position] === "[") { position++; space(); while (body![position] !== "]") { scan(); space(); if (body![position] !== ",") break; position++; space(); } position++; }
      else if (body![position] === '"') token(); else while (position < body!.length && !/[\s,\]}]/.test(body![position]!)) position++;
    }
    scan(); return parsed;
  }
  function jsonCell(value: unknown, storage: MigrationSemanticReferenceRule["storageClasses"][number]): FullDataPreservationCell | null {
    if (value === null) return { storage: "null" };
    if (storage === "integer") {
      const decimal = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
      if (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(decimal) || decimal === "-0" || BigInt(decimal) < -9223372036854775808n || BigInt(decimal) > 9223372036854775807n) return null;
      return { storage, value: decimal };
    }
    if (typeof value !== "string") return null;
    if (storage === "text") {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return null;
      const encoding = manifest.value.catalog.pragmas.encoding; const bytes = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le");
      if (encoding === "UTF-16be") bytes.swap16(); return { storage, encoding: "base64", value: bytes.toString("base64") };
    }
    if (storage === "blob" && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.from(value, "base64").toString("base64") === value) return { storage, value };
    // Floating point values are opaque legacy facts; they are not semantic identity keys.
    return null;
  }
  const semanticFields = new Set<string>();
  for (const field of baseline.semanticFields) {
    requireThat(label(field.table) && label(field.column) && catalog.get(field.table)?.columns.some(column => column[1] === field.column), "invalid_reviewed_semantic_field");
    semanticFields.add(canonical([field.table, field.column]));
  }
  const mappedFields = new Set<string>(); const seenRules = new Set<string>();
  for (const rule of baseline.semanticReferences) {
    const shape = catalog.get(rule.table); const targetShape = catalog.get(rule.targetTable);
    requireThat(shape && targetShape && shape.columns.some(column => column[1] === rule.column) && Array.isArray(rule.path) && rule.path.length <= 16 &&
      rule.path.every(part => typeof part === "string" || (typeof part === "number" && Number.isSafeInteger(part) && part >= 0)) &&
      Array.isArray(rule.targetColumns) && rule.targetColumns.length > 0 && rule.targetColumns.length <= 1000 &&
      rule.targetColumns.every(column => typeof column === "string" && targetShape.columns.some(source => source[1] === column)) &&
      Array.isArray(rule.storageClasses) && rule.storageClasses.length === rule.targetColumns.length &&
      rule.storageClasses.every(storage => typeof storage === "string" && ["text", "integer", "real", "blob"].includes(storage)), "invalid_semantic_reference_rule");
    const ruleKey = canonical(rule); requireThat(!seenRules.has(ruleKey), "duplicate_semantic_rule"); seenRules.add(ruleKey);
    const fieldKey = canonical([rule.table, rule.column]);
    if (!mappedFields.has(fieldKey)) issue("partial_semantic_field_coverage", rule.table, null, rule.column);
    mappedFields.add(fieldKey);
    for (const row of byTable.get(rule.table) ?? []) {
      let cells: FullDataPreservationCell[] | null = null;
      try {
        let value = parseSemanticJson(row.values[rule.column]!);
        for (const part of rule.path) { requireThat(value !== null && typeof value === "object" && Object.hasOwn(value, part), "semantic_path_unknown"); value = (value as Record<string | number, unknown>)[part]; }
        const components = rule.targetColumns.length === 1 ? [value] : Array.isArray(value) ? value : [];
        if (components.length === rule.targetColumns.length) {
          const values = components.map((component, index) => jsonCell(component, rule.storageClasses[index]!));
          if (values.every(cell => cell !== null)) cells = values as FullDataPreservationCell[];
        }
      } catch { /* Preserve the original cell and report unknown semantics below. */ }
      reference(row, "semantic_json", rule.column + ":" + canonical(rule.path), rule.targetTable, rule.targetColumns, cells);
    }
  }
  for (const table of catalog.values()) for (const column of table.columns) {
    const field = column[1] as string; const key = canonical([table.name, field]);
    if ((semanticFields.has(key) || /(?:^payload$|^policy$|^metrics$|^components$|^styles$|^reasons$|_json$)/.test(field)) && !mappedFields.has(key)) issue("unknown_semantic_field", table.name, null, field);
  }
  for (const mapping of routes.values()) if (mapping.targetRoute === "identity_review" && !Object.hasOwn(migrationIdentityMetadataAdapters, mapping.sourceTable)) issue("unsupported_identity_metadata_adapter", mapping.sourceTable, null);

  function flag(row: MutableRow | undefined, field: string): boolean | null {
    const cell = row?.values[field]; if (cell?.storage === "integer" && (cell.value === "0" || cell.value === "1")) return cell.value === "1";
    if (row) quarantine(row, "unknown_profile_flag", field); return null;
  }
  const cohorts = new Map<string, Cohort>(); const entityRows = new Map<string, MutableRow[]>();
  function entityKey(cell: FullDataPreservationCell | undefined): string | null { return cell && cell.storage !== "null" ? tuple([cell]) : null; }
  for (const row of byTable.get("trader_entities") ?? []) {
    const key = entityKey(row.values.entity_id); if (key === null) { quarantine(row, "unknown_entity_id"); continue; }
    const bucket = entityRows.get(key) ?? []; bucket.push(row); entityRows.set(key, bucket);
  }
  for (const [key, bucket] of entityRows) {
    const row = bucket[0]!; const lifecycle = bucket.length === 1 ? text(row.values.lifecycle) : null;
    const recognized = lifecycle !== null && ["active", "candidate", "suspended", "retired", "archived"].includes(lifecycle);
    const manual = bucket.length === 1 ? flag(row, "manual") : null; const locked = bucket.length === 1 ? flag(row, "locked") : null;
    const cohort: Cohort = { entityId: text(row.values.entity_id), entityKey: key, lifecycle,
      suspended: recognized ? lifecycle === "suspended" : null, manual, locked, profileFlags: {}, accounts: [], wallets: [],
      status: bucket.length === 1 && recognized && manual !== null && locked !== null && text(row.values.entity_id) !== null ? "historical_coherent" : "quarantined", grantsBusinessEligibility: false };
    if (!recognized) quarantine(row, "unknown_lifecycle"); cohorts.set(key, cohort);
  }
  const profiles = new Map<string, MutableRow[]>();
  for (const row of byTable.get("trader_profiles") ?? []) {
    const key = entityKey(row.values.entity_id);
    if (key === null || !cohorts.has(key)) { quarantine(row, "unknown_owner", "entity_id"); continue; }
    const bucket = profiles.get(key) ?? []; bucket.push(row); profiles.set(key, bucket);
  }
  for (const [key, cohort] of cohorts) {
    const bucket = profiles.get(key) ?? []; const profile = bucket.length === 1 ? bucket[0] : undefined;
    const flags = Object.fromEntries(["monitoring_enabled", "fomo_monitoring_enabled", "onchain_monitoring_enabled"].map(field => [field, flag(profile, field)]));
    Object.assign(cohort, { profileFlags: flags });
    if (!profile || Object.values(flags).some(value => value === null) || profile.status === "quarantined") {
      cohort.status = "quarantined"; issue(bucket.length > 1 ? "multiple_profiles" : !profile ? "missing_profile" : "unknown_profile_flags", "trader_profiles", profile?.rowOrdinal ?? null, "entity_id");
    }
  }
  const accountOwners = new Map<string, Set<string>>(); const unknownAccounts = new Set<string>(); const accountRows = byTable.get("entity_accounts") ?? [];
  const knownAccounts = getIndex("fomo_accounts", ["account_id"]);
  for (const row of accountRows) {
    const owner = entityKey(row.values.entity_id); const account = entityKey(row.values.account_id);
    if (owner === null || account === null || !cohorts.has(owner) || knownAccounts?.get(account)?.length !== 1) { quarantine(row, "unknown_owner", "account_id"); if (account !== null) unknownAccounts.add(account); if (owner !== null && cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined"; continue; }
    const owners = accountOwners.get(account) ?? new Set<string>(); owners.add(owner); accountOwners.set(account, owners);
    cohorts.get(owner)!.accounts.push(row.values.account_id!);
  }
  for (const row of accountRows) {
    const key = entityKey(row.values.account_id); const owners = key === null ? undefined : accountOwners.get(key);
    if (key !== null && unknownAccounts.has(key)) { quarantine(row, "unknown_owner", "account_id"); for (const owner of owners ?? []) if (cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined"; }
    if (owners && owners.size > 1) { quarantine(row, "multiple_owners", "account_id"); for (const owner of owners) cohorts.get(owner)!.status = "quarantined"; }
    const confidence = text(row.values.confidence);
    if (confidence === null || !["low", "medium", "high", "confirmed"].includes(confidence)) { quarantine(row, "unknown_confidence", "confidence"); const owner = entityKey(row.values.entity_id); if (owner && cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined"; }
  }
  const walletClaims = new Map<string, { family: string; comparisonAddress: string; owners: Set<string>; rows: MutableRow[]; addresses: Set<string>; hasUnknownOwner: boolean }>();
  for (const tableName of ["entity_wallet_identities", "wallet_identities"]) for (const row of byTable.get(tableName) ?? []) {
    const family = text(row.values.chain_family); const address = text(row.values.address);
    if (family === null || address === null || !["evm", "solana"].includes(family) ||
      (family === "evm" && !/^0x[0-9a-fA-F]{40}$/.test(address)) || (family === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))) {
      quarantine(row, "unknown_address_semantics", "address"); const owner = entityKey(row.values.entity_id); if (owner && cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined";
      const account = entityKey(row.values.account_id); for (const owner of account !== null ? accountOwners.get(account) ?? [] : []) if (cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined";
      continue;
    }
    const direct = entityKey(row.values.entity_id); const account = entityKey(row.values.account_id);
    const owners = tableName === "entity_wallet_identities" ? new Set(direct !== null && cohorts.has(direct) ? [direct] : []) : account !== null && !unknownAccounts.has(account) ? accountOwners.get(account) ?? new Set<string>() : new Set<string>();
    if (owners.size !== 1) { quarantine(row, owners.size > 1 ? "multiple_owners" : "unknown_owner", tableName === "wallet_identities" ? "account_id" : "entity_id"); for (const owner of owners) if (cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined"; }
    const comparisonAddress = family === "evm" ? address.toLowerCase() : address;
    const key = canonical([family, comparisonAddress]); const claim = walletClaims.get(key) ?? { family, comparisonAddress, owners: new Set<string>(), rows: [], addresses: new Set<string>(), hasUnknownOwner: false };
    if (owners.size === 0) claim.hasUnknownOwner = true;
    for (const owner of owners) claim.owners.add(owner); claim.rows.push(row); claim.addresses.add(address); walletClaims.set(key, claim);
  }
  for (const claim of walletClaims.values()) {
    if (claim.owners.size !== 1 || claim.hasUnknownOwner) { for (const row of claim.rows) quarantine(row, claim.owners.size > 1 ? "multiple_owners" : "unknown_owner", "address"); for (const owner of claim.owners) cohorts.get(owner)!.status = "quarantined"; continue; }
    const owner = [...claim.owners][0]!; const confidenceEvidence = claim.rows.map(row => {
      const confidence = text(row.values.confidence); const recognized = confidence !== null && ["low", "medium", "high", "confirmed"].includes(confidence) ? confidence : null;
      if (recognized === null) { quarantine(row, "unknown_confidence", "confidence"); cohorts.get(owner)!.status = "quarantined"; }
      if (row.status === "quarantined") cohorts.get(owner)!.status = "quarantined";
      return { source: { table: row.table, rowOrdinal: row.rowOrdinal }, value: row.values.confidence!, recognized };
    });
    cohorts.get(owner)!.wallets.push({ family: claim.family, comparisonAddress: claim.comparisonAddress, sourceAddresses: [...claim.addresses], confidenceEvidence });
  }
  for (const row of rows) if (row.status === "quarantined") { const owner = entityKey(row.values.entity_id); if (owner && cohorts.has(owner)) cohorts.get(owner)!.status = "quarantined"; }
  const partialIdentityInput = Object.keys(migrationIdentityMetadataAdapters).some(tableName =>
    (byTable.get(tableName)?.length ?? 0) !== manifest.value.tables.find(table => table.name === tableName)?.rowCount);
  if (partialIdentityInput) {
    issue("partial_identity_cohort_input", "trader_entities", null);
    for (const cohort of cohorts.values()) cohort.status = "quarantined";
  }
  return deepFreeze({ operationId: manifest.value.operationId, snapshotSha256: manifest.value.snapshotSha256, catalogFingerprint: manifest.value.catalogFingerprint,
    reviewedRoutingSha256: trusted.reviewedRoutingSha256, rows, identityCohorts: [...cohorts.values()], issues,
    coverage: { plannedTables: manifest.value.tables.length, plannedRows: manifest.totalRows, providedRows: rows.length, providedChunks: input.chunks.length,
      supportedIdentityTables: Object.keys(migrationIdentityMetadataAdapters), semanticReferenceRules: baseline.semanticReferences.length,
      completeSemanticCoverage: false, cohortCountsAreDiagnostic: true },
    historicalOnly: true, grantsBusinessEligibility: false, sourceWrites: false, databaseWrites: false });
}
