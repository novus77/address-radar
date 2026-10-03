import { createHash } from "node:crypto";
import { fullDataDispositionGroups, fullDataMigrationBaseline } from "./full-data-migration-baseline.js";

export interface MigrationCatalogTable {
  name: string;
  c: readonly string[];
  fk: readonly string[];
  ix: readonly string[];
}
export interface MigrationProtectionRoot {
  table: string;
  reference: string;
  reason: "unfinished_purchase_window" | "unresolved_evidence" | "delivery_deduplication";
  retainUntilMs: number | null;
}
export interface MigrationManifestInput {
  catalog: readonly MigrationCatalogTable[];
  capturedAtMs: number;
  protectedRoots?: readonly MigrationProtectionRoot[];
}
export interface MigrationIssue {
  code: string;
  table: string | null;
  detail: string;
}
export interface MigrationTableMapping {
  sourceTable: string;
  family: string;
  disposition: string;
  targetRoute: "identity_review" | "validated_fact_staging" | "legacy_preservation";
  columns: readonly {
    sourceColumn: string;
    targetField: string;
    sourceType: string;
    notNull: boolean;
    primaryKeyPosition: number | null;
    conversion: "preserve_source_representation";
  }[];
  sourceRetention: "preserve";
  activateConsumers: false;
  grantRadarEligibility: false;
}
export interface FullDataMigrationManifest {
  version: 1;
  capturedAtMs: number;
  catalogFingerprint: string;
  classificationValid: boolean;
  productionMigrationReady: false;
  mappings: readonly MigrationTableMapping[];
  issues: readonly MigrationIssue[];
  protectedTables: readonly string[];
  protectionScope: "table_dependency_review_not_row_coverage";
  protectionRoots: readonly MigrationProtectionRoot[];
  unresolvedGates: readonly string[];
  execution: {
    databaseWrites: false;
    sourceDeletion: false;
    serviceCutover: false;
    gatewayDelivery: false;
    resumeFomo: false;
    resumeHistoricalMining: false;
    reuseLegacyEligibility: false;
    resetExternalBudgets: false;
  };
}

const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const fingerprint = (tables: readonly MigrationCatalogTable[]): string => createHash("sha256")
  .update(JSON.stringify([...tables].sort((a, b) => a.name.localeCompare(b.name))
    .map((table) => ({ name: table.name, c: [...table.c], fk: [...table.fk].sort(), ix: [...table.ix].sort() }))))
  .digest("hex");

// These conservative preservation edges cover references not enforced as foreign keys.
// They do not prove which rows support a purchase or that a price range is complete.
const semanticParents: Readonly<Record<string, readonly string[]>> = {
  trader_token_samples: ["trader_events", "wallet_monitor_execution_bases", "trader_execution_heads",
    "trader_execution_revisions", "market_observations", "token_market_snapshots"],
  candidate_evidence_v3: ["trader_token_samples", "source_observations", "token_milestone_crossings"],
  canonical_trader_events: ["canonical_trader_event_observations"],
  trader_events: ["canonical_trader_events", "raw_trader_observations"],
  wallet_monitor_execution_bases: ["wallet_monitor_observations"],
  trader_execution_revisions: ["trader_events", "source_observations"],
  consumer_fact_demands: ["recovery_fact_links", "token_fact_status", "token_fact_dependencies"],
  token_fact_status: ["token_fact_watermarks", "token_fact_attempts"],
  collector_dead_letters: ["source_observations", "fomo_live_inbox"],
  source_observation_conflicts: ["source_observations"],
  broadcast_records: ["address_signal_evidence", "source_observations", "wallet_monitor_observations"],
};

function decodeColumn(encoded: string): MigrationTableMapping["columns"][number] {
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*):([^!#]*)(!)?(?:#([1-9][0-9]*))?$/.exec(encoded);
  if (!match) throw new Error("invalid_catalog_column");
  return {
    sourceColumn: match[1]!, targetField: match[1]!, sourceType: match[2]!,
    notNull: match[3] === "!", primaryKeyPosition: match[4] ? Number(match[4]) : null,
    conversion: "preserve_source_representation",
  };
}

export function createFullDataMigrationManifest(input: MigrationManifestInput): FullDataMigrationManifest {
  if (!Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 0) {
    throw new Error("invalid_capture_clock");
  }
  const issues: MigrationIssue[] = [];
  const byName = new Map<string, MigrationCatalogTable>();
  const baseline = new Map(fullDataMigrationBaseline.map((table) => [table.name, table]));
  const classifications = new Map<string, { key: string; action: string }>();
  for (const group of fullDataDispositionGroups) {
    for (const name of group.tables) {
      if (classifications.has(name)) throw new Error("duplicate_baseline_classification");
      classifications.set(name, group);
    }
  }
  for (const table of input.catalog) {
    if (!identifier.test(table.name)) throw new Error("invalid_catalog_table");
    if (byName.has(table.name)) {
      issues.push({ code: "duplicate_source_table", table: table.name, detail: "Each table must occur once." });
      continue;
    }
    byName.set(table.name, table);
    for (const column of table.c) decodeColumn(column);
    const expected = baseline.get(table.name);
    if (!expected || !classifications.has(table.name)) {
      issues.push({ code: "unclassified_source_table", table: table.name, detail: "Review the new table before planning any import." });
    } else if (fingerprint([table]) !== fingerprint([expected])) {
      issues.push({ code: "source_schema_drift", table: table.name, detail: "Columns, foreign-key edges or index shapes differ from the reviewed snapshot." });
    }
  }
  for (const name of baseline.keys()) {
    if (!byName.has(name)) issues.push({ code: "missing_source_table", table: name, detail: "A reviewed source table is absent." });
  }

  const parents = new Map<string, Set<string>>();
  for (const table of byName.values()) {
    const dependencies = new Set<string>(semanticParents[table.name] ?? []);
    for (const encoded of table.fk) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*->([a-zA-Z_][a-zA-Z0-9_]*)\.[^:]*:.*$/.exec(encoded);
      if (!match) throw new Error("invalid_catalog_foreign_key");
      dependencies.add(match[1]!);
    }
    for (const parent of dependencies) {
      if (!byName.has(parent)) issues.push({
        code: "missing_dependency_table", table: table.name, detail: "Required preserved parent: " + parent + ".",
      });
    }
    parents.set(table.name, dependencies);
  }

  const roots = (input.protectedRoots ?? []).map((root) => ({ ...root }));
  const rootReasons = new Set(["unfinished_purchase_window", "unresolved_evidence", "delivery_deduplication"]);
  for (const root of roots) {
    if (!root.reference.trim() || !rootReasons.has(root.reason) ||
        (root.retainUntilMs !== null && (!Number.isSafeInteger(root.retainUntilMs) || root.retainUntilMs < input.capturedAtMs))) {
      throw new Error("invalid_protection_root");
    }
    if (!byName.has(root.table)) issues.push({
      code: "unknown_protection_root", table: root.table, detail: "A protection obligation must resolve to a source table.",
    });
  }
  const alwaysProtected = fullDataDispositionGroups
    .filter((group) => ["identity_audit", "delivery_safety", "protected_errors", "budgets"].includes(group.key))
    .flatMap((group) => [...group.tables]);
  const protectedTables = new Set<string>();
  const pending = [...alwaysProtected, ...roots.map((root) => root.table)];
  while (pending.length > 0) {
    const table = pending.pop()!;
    if (protectedTables.has(table) || !byName.has(table)) continue;
    protectedTables.add(table);
    pending.push(...(parents.get(table) ?? []));
  }

  const mappings: MigrationTableMapping[] = [];
  for (const table of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const group = classifications.get(table.name);
    if (!group) continue;
    mappings.push({
      sourceTable: table.name, family: group.key, disposition: group.action,
      targetRoute: group.key === "identity" ? "identity_review" :
        ["source_facts", "market_facts"].includes(group.key) ? "validated_fact_staging" : "legacy_preservation",
      columns: table.c.map(decodeColumn),
      sourceRetention: "preserve", activateConsumers: false, grantRadarEligibility: false,
    });
  }
  return {
    version: 1, capturedAtMs: input.capturedAtMs, catalogFingerprint: fingerprint(input.catalog),
    classificationValid: issues.length === 0, productionMigrationReady: false, mappings, issues,
    protectedTables: [...protectedTables].sort(), protectionScope: "table_dependency_review_not_row_coverage",
    protectionRoots: roots,
    unresolvedGates: [
      "explicit_production_migration_and_cutover_approval",
      "business_postgres_driver_schema_roles_and_capacity",
      "consistent_data_snapshot_and_single_writer_boundary",
      "row_level_purchase_proof_dependency_and_30_day_window_validation",
      "exact_target_types_constraints_and_foreign_key_mapping",
      "identity_conflict_and_manual_authorization_review",
      "legacy_policy_provenance_and_generation_separation",
      "real_purchase_coverage_receipts_and_delivery_disabled_acceptance",
      "post_cutover_write_journal_and_replayable_rollback",
      "approved_archive_destination_and_retention_policy_before_any_purge",
    ],
    execution: {
      databaseWrites: false, sourceDeletion: false, serviceCutover: false, gatewayDelivery: false,
      resumeFomo: false, resumeHistoricalMining: false, reuseLegacyEligibility: false, resetExternalBudgets: false,
    },
  };
}

