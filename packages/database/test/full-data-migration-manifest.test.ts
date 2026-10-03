import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fullDataMigrationBaseline } from "../src/full-data-migration-baseline.js";
import { createFullDataMigrationManifest } from "../src/full-data-migration-manifest.js";
import { readOnlyFullDataMigrationCatalog } from "../src/full-data-migration-preflight.js";

const at = 1_000_000;
const baseline = () => fullDataMigrationBaseline.map((table) => ({
  name: table.name, c: [...table.c], fk: [...table.fk], ix: [...table.ix],
}));

describe("full-data migration classification and protection", () => {
  it("maps all reviewed tables without granting eligibility or approving production", () => {
    const manifest = createFullDataMigrationManifest({ catalog: baseline(), capturedAtMs: at });
    expect(manifest.classificationValid).toBe(true);
    expect(manifest.mappings).toHaveLength(141);
    expect(manifest.productionMigrationReady).toBe(false);
    expect(Object.values(manifest.execution)).toEqual(Array(8).fill(false));
    expect(manifest.mappings.every((row) => row.sourceRetention === "preserve" &&
      !row.activateConsumers && !row.grantRadarEligibility)).toBe(true);
    expect(manifest.mappings.find((row) => row.sourceTable === "trader_token_samples")?.targetRoute)
      .toBe("legacy_preservation");
    expect(manifest.mappings.find((row) => row.sourceTable === "wallet_identities")?.targetRoute)
      .toBe("identity_review");
  });

  it("keeps source values and nullability as a staging proposal rather than inventing precision", () => {
    const manifest = createFullDataMigrationManifest({ catalog: baseline(), capturedAtMs: at });
    const column = manifest.mappings.find((row) => row.sourceTable === "market_observations")!
      .columns.find((row) => row.sourceColumn === "price_usd")!;
    expect(column.sourceType).toBe("REAL");
    expect(column.conversion).toBe("preserve_source_representation");
    expect(manifest.unresolvedGates).toContain("exact_target_types_constraints_and_foreign_key_mapping");
  });

  it("blocks unclassified, missing and duplicate source tables", () => {
    const rows = baseline();
    const missing = rows.shift()!;
    rows.push({ name: "unknown_table", c: ["id:INTEGER#1"], fk: [], ix: [] }, rows[0]!);
    const manifest = createFullDataMigrationManifest({ catalog: rows, capturedAtMs: at });
    expect(manifest.classificationValid).toBe(false);
    expect(manifest.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_source_table", table: missing.name }),
      expect.objectContaining({ code: "unclassified_source_table", table: "unknown_table" }),
      expect.objectContaining({ code: "duplicate_source_table" }),
    ]));
  });

  it("detects column, index and foreign-key drift without depending on index ordering", () => {
    const rows = baseline();
    for (const row of rows) { row.ix.reverse(); row.fk.reverse(); }
    expect(createFullDataMigrationManifest({ catalog: rows, capturedAtMs: at }).classificationValid).toBe(true);
    const row = rows.find((table) => table.name === "market_observations")!;
    row.c.push("new_field:TEXT");
    row.ix.push("I:new_field");
    row.fk.push("new_field->unknown_table.id:NO ACTION");
    const manifest = createFullDataMigrationManifest({ catalog: rows, capturedAtMs: at });
    expect(manifest.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source_schema_drift", table: row.name }),
      expect.objectContaining({ code: "missing_dependency_table", table: row.name }),
    ]));
  });

  it("preserves purchase proof dependencies transitively without claiming row coverage", () => {
    const manifest = createFullDataMigrationManifest({
      catalog: baseline(), capturedAtMs: at,
      protectedRoots: [{ table: "trader_token_samples", reference: "sample-review-1",
        reason: "unfinished_purchase_window", retainUntilMs: at + 30 * 86_400_000 }],
    });
    expect(manifest.protectedTables).toEqual(expect.arrayContaining([
      "trader_token_samples", "trader_events", "raw_trader_observations",
      "wallet_monitor_observations", "wallet_monitor_execution_bases", "market_observations",
      "trader_execution_revisions",
    ]));
    expect(manifest.protectionScope).toBe("table_dependency_review_not_row_coverage");
    expect(manifest.productionMigrationReady).toBe(false);
  });

  it("preserves audit, frozen delivery and budget guards even with no caller roots", () => {
    const manifest = createFullDataMigrationManifest({ catalog: baseline(), capturedAtMs: at });
    expect(manifest.protectedTables).toEqual(expect.arrayContaining([
      "operator_audit_log", "signal_outbox_migration_review", "economic_evidence_consumption",
      "broadcast_records", "provider_request_gates", "provider_budget_usage", "collector_dead_letters",
    ]));
    expect(manifest.execution.resumeFomo).toBe(false);
    expect(manifest.execution.resumeHistoricalMining).toBe(false);
  });

  it("rejects invalid clocks and expired obligations and reports unknown roots", () => {
    expect(() => createFullDataMigrationManifest({ catalog: baseline(), capturedAtMs: NaN })).toThrow("invalid_capture_clock");
    expect(() => createFullDataMigrationManifest({
      catalog: baseline(), capturedAtMs: at,
      protectedRoots: [{ table: "trader_token_samples", reference: "sample", reason: "unfinished_purchase_window", retainUntilMs: at - 1 }],
    })).toThrow("invalid_protection_root");
    expect(createFullDataMigrationManifest({
      catalog: baseline(), capturedAtMs: at,
      protectedRoots: [{ table: "missing", reference: "proof", reason: "unresolved_evidence", retainUntilMs: null }],
    }).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "unknown_protection_root" })]));
  });

  it("detaches caller obligations and produces a stable fingerprint for table ordering", () => {
    const roots = [{ table: "trader_token_samples", reference: "original",
      reason: "unfinished_purchase_window" as const, retainUntilMs: at + 1 }];
    const manifest = createFullDataMigrationManifest({ catalog: baseline(), capturedAtMs: at, protectedRoots: roots });
    roots[0]!.reference = "changed";
    expect(manifest.protectionRoots[0]!.reference).toBe("original");
    expect(createFullDataMigrationManifest({ catalog: baseline().reverse(), capturedAtMs: at }).catalogFingerprint)
      .toBe(manifest.catalogFingerprint);
  });
});

describe("isolated read-only SQLite catalog", () => {
  it("extracts metadata and leaves source bytes unchanged without reading business rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-migration-preflight-"));
    const path = join(directory, "fixture.sqlite");
    try {
      const database = new DatabaseSync(path);
      database.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE); CREATE INDEX child_partial ON child(parent_id) WHERE parent_id > 0; INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);");
      database.close();
      const before = readFileSync(path);
      const source = readOnlyFullDataMigrationCatalog(path);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(source.scope).toBe("schema_metadata_only");
      expect(source.dataCounts).toBe("not_collected");
      expect(source.readOnly).toBe(true);
      expect(source.catalog.find((row) => row.name === "child")).toEqual({
        name: "child", c: ["id:INTEGER#1", "parent_id:INTEGER!"],
        fk: ["parent_id->parent.id:CASCADE"], ix: ["I:P:parent_id"],
      });
      expect(source.ddlFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(createFullDataMigrationManifest(source).classificationValid).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects a nonexistent source instead of creating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-migration-absent-"));
    try {
      expect(() => readOnlyFullDataMigrationCatalog(join(directory, "missing.sqlite"))).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

