import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fullDataMigrationBaseline } from "../src/full-data-migration-baseline.js";
import { createFullDataMigrationManifest } from "../src/full-data-migration-manifest.js";
import { createMigrationProjectionCrosswalk, migrationProjectionRoutingFingerprint,
  type MigrationProjectionRoutingBaseline, type MigrationSemanticReferenceRule } from "../src/migration-projection-crosswalk.js";
import type { FullDataPreservationCell } from "../src/postgres-full-data-import.js";

const sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => canonical(key) + ":" + canonical(child)).join(",") + "}";
  return JSON.stringify(value).replace(/[\x7f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
type SourceRow = Record<string, string | FullDataPreservationCell | null>;
function fixture(sourceRows: Record<string, SourceRow[]> = {}, semanticReferences: MigrationSemanticReferenceRule[] = [], encoding: "UTF-8" | "UTF-16le" | "UTF-16be" = "UTF-8") {
  const baseline: MigrationProjectionRoutingBaseline = { reviewId: "external-reviewed-141", mappings: createFullDataMigrationManifest({
    capturedAtMs: 1, catalog: fullDataMigrationBaseline,
  }).mappings, semanticReferences, semanticFields: [{ table: "wallet_monitor_execution_bases", column: "basis_json" }] };
  const tables = fullDataMigrationBaseline.map(shape => ({ name: shape.name, columns: shape.c.map((column, index) => {
    const match = /^([^:]+):([^!#]*)(!)?(?:#([0-9]+))?$/.exec(column)!;
    return [index, match[1]!, match[2]!, match[3] ? 1 : 0, null, match[4] ? Number(match[4]) : 0, 0];
  }), foreignKeys: [] as { id: number; table: string; onUpdate: string; onDelete: string; match: string; columns: { sequence: number; from: string; to: string | null }[] }[], indexes: [] }));
  tables.find(table => table.name === "wallet_monitor_execution_bases")!.foreignKeys.push({ id: 0, table: "wallet_monitor_observations", onUpdate: "NO ACTION", onDelete: "NO ACTION", match: "NONE",
    columns: [{ sequence: 0, from: "source", to: "source" }, { sequence: 1, from: "event_id", to: "event_id" }] });
  const catalog = { tables, objects: tables.map(table => ({ type: "table", name: table.name, tbl_name: table.name, sql: "CREATE TABLE " + table.name + " (fixture TEXT)" })),
    sequences: [], pragmas: { encoding, user_version: 0, application_id: 0 } };
  function cell(value: SourceRow[string] | undefined): FullDataPreservationCell {
    if (value === undefined || value === null) return { storage: "null" };
    if (typeof value !== "string") return value;
    const bytes = Buffer.from(value, encoding === "UTF-8" ? "utf8" : "utf16le"); if (encoding === "UTF-16be") bytes.swap16();
    return { storage: "text", encoding: "base64", value: bytes.toString("base64") };
  }
  const chunks: { table: string; ordinal: number; body: Buffer }[] = [];
  const plans = tables.map((table, tableIndex) => {
    const rows = (sourceRows[table.name] ?? []).map(row => ({ values: table.columns.map(column => cell(row[column[1] as string])) }));
    const body = Buffer.from(canonical({ version: 1, operationId: "crosswalk-1", snapshotSha256: "a".repeat(64), table: table.name, ordinal: 0, startRow: 0, rows }));
    if (rows.length) chunks.push({ table: table.name, ordinal: 0, body });
    return { name: table.name, rowCount: rows.length, completed: true, contentSha256: sha(rows.map(row => canonical(row) + "\n").join("")),
      chunks: rows.length ? [{ table: table.name, ordinal: 0, startRow: 0, rowCount: rows.length, sha256: sha(body), file: "table-" + String(tableIndex).padStart(4, "0") + "-chunk-000000.json" }] : [] };
  });
  const manifest = Buffer.from(canonical({ version: 1, operationId: "crosswalk-1", snapshotSha256: "a".repeat(64), snapshotBytes: 4096,
    catalogFingerprint: sha(canonical(catalog)), completed: true, businessActivation: false, catalog,
    limits: { maximumChunkBytes: 16384, rowsPerChunk: 4096 }, tables: plans }));
  return { manifest, chunks, reviewedRoutingBaseline: baseline, trustedSource: { operationId: "crosswalk-1", snapshotSha256: "a".repeat(64),
    catalogFingerprint: sha(canonical(catalog)), manifestSha256: sha(manifest), reviewedRoutingSha256: migrationProjectionRoutingFingerprint(baseline) } };
}
const integer = (value: string): FullDataPreservationCell => ({ storage: "integer", value });
const entity = (id: string, lifecycle = "active") => ({ entity_id: id, lifecycle, manual: integer("0"), locked: integer("1") });
const profile = (id: string) => ({ entity_id: id, monitoring_enabled: integer("1"), fomo_monitoring_enabled: integer("0"), onchain_monitoring_enabled: integer("1") });
const address = "0x" + "aB".repeat(20);

describe("bounded historical migration projection crosswalk", () => {
  it.each(["operationId", "snapshotSha256", "catalogFingerprint", "manifestSha256", "reviewedRoutingSha256"])("requires independent trusted %s binding", field => {
    const input = fixture();
    const trustedSource = { ...input.trustedSource, [field]: "untrusted" };
    expect(() => createMigrationProjectionCrosswalk({ ...input, trustedSource })).toThrow(/trusted_source|reviewed_routing/);
  });

  it("rejects a structurally forged manifest instead of trusting a supplied verification object", () => {
    const input = fixture(); input.manifest[0] = 0xff;
    expect(() => createMigrationProjectionCrosswalk(input)).toThrow();
  });

  it("requires the reviewed 141-table baseline and unchanged preservation-only routing", () => {
    const input = fixture();
    const reduced = { ...input.reviewedRoutingBaseline, mappings: input.reviewedRoutingBaseline.mappings.slice(1) };
    expect(() => createMigrationProjectionCrosswalk({ ...input, reviewedRoutingBaseline: reduced })).toThrow("baseline_shape");
    const baseline = { ...input.reviewedRoutingBaseline, mappings: input.reviewedRoutingBaseline.mappings.map(mapping => mapping.family === "legacy_results" ? { ...mapping, targetRoute: "validated_fact_staging" as const } : mapping) };
    expect(() => createMigrationProjectionCrosswalk({ ...input, reviewedRoutingBaseline: baseline, trustedSource: { ...input.trustedSource, reviewedRoutingSha256: migrationProjectionRoutingFingerprint(baseline) } })).toThrow("legacy_results_route");
  });

  it("keeps flags, suspension and confidence as historical evidence and retains EVM source case", () => {
    const input = fixture({ trader_entities: [entity("e1", "suspended")], trader_profiles: [profile("e1")], fomo_accounts: [{ account_id: "a1" }],
      entity_accounts: [{ entity_id: "e1", account_id: "a1", confidence: "high" }],
      entity_wallet_identities: [{ entity_id: "e1", chain_family: "evm", address, confidence: "medium" }],
      wallet_identities: [{ account_id: "a1", chain_family: "evm", address: address.toLowerCase(), confidence: "confirmed" }] });
    const output = createMigrationProjectionCrosswalk(input); const cohort = output.identityCohorts[0]!;
    expect(cohort).toMatchObject({ entityId: "e1", lifecycle: "suspended", suspended: true, manual: false, locked: true,
      profileFlags: { monitoring_enabled: true, fomo_monitoring_enabled: false, onchain_monitoring_enabled: true }, status: "historical_coherent", grantsBusinessEligibility: false });
    expect(cohort.wallets).toHaveLength(1);
    expect(cohort.wallets[0]!.sourceAddresses).toEqual([address, address.toLowerCase()]);
    expect(cohort.wallets[0]!.confidenceEvidence.map(value => value.recognized)).toEqual(["medium", "confirmed"]);
    expect(output.coverage).toMatchObject({ completeSemanticCoverage: false, cohortCountsAreDiagnostic: true });
    expect(output.rows.every(row => !row.grantsBusinessEligibility)).toBe(true);
    expect(Object.isFrozen(output.identityCohorts)).toBe(true);
  });

  it.each(["UTF-16le", "UTF-16be"] as const)("interprets reviewed identity text in %s while retaining original opaque cells", encoding => {
    const input = fixture({ trader_entities: [entity("e1")], trader_profiles: [profile("e1")] }, [], encoding);
    const result = createMigrationProjectionCrosswalk(input);
    expect(result.identityCohorts[0]!.entityId).toBe("e1");
    expect(result.rows.find(row => row.table === "trader_entities")!.values.entity_id).toEqual({ storage: "text", encoding: "base64", value: encoding === "UTF-16le" ? "ZQAxAA==" : "AGUAMQ==" });
  });

  it("does not case-fold Solana wallet addresses", () => {
    const input = fixture({ trader_entities: [entity("e1"), entity("e2")], trader_profiles: [profile("e1"), profile("e2")],
      entity_wallet_identities: [{ entity_id: "e1", chain_family: "solana", address: "A".repeat(32), confidence: "high" },
        { entity_id: "e2", chain_family: "solana", address: "a".repeat(32), confidence: "high" }] });
    const result = createMigrationProjectionCrosswalk(input);
    expect(result.identityCohorts.map(cohort => cohort.status)).toEqual(["historical_coherent", "historical_coherent"]);
    expect(result.identityCohorts.map(cohort => cohort.wallets[0]!.comparisonAddress)).toEqual(["A".repeat(32), "a".repeat(32)]);
  });

  it("quarantines multiple account or case-equivalent wallet owners without merging", () => {
    const input = fixture({ trader_entities: [entity("e1"), entity("e2")], trader_profiles: [profile("e1"), profile("e2")], fomo_accounts: [{ account_id: "a1" }],
      entity_accounts: [{ entity_id: "e1", account_id: "a1", confidence: "high" }, { entity_id: "e2", account_id: "a1", confidence: "confirmed" }],
      entity_wallet_identities: [{ entity_id: "e1", chain_family: "evm", address, confidence: "high" }, { entity_id: "e2", chain_family: "evm", address: address.toLowerCase(), confidence: "confirmed" }] });
    const result = createMigrationProjectionCrosswalk(input);
    expect(result.identityCohorts).toHaveLength(2);
    expect(result.identityCohorts.every(cohort => cohort.status === "quarantined" && cohort.wallets.length === 0)).toBe(true);
    expect(result.issues.some(issue => issue.code === "multiple_owners")).toBe(true);
  });

  it("does not resolve an unknown wallet owner through another row with the same address", () => {
    const input = fixture({ trader_entities: [entity("e1")], trader_profiles: [profile("e1")],
      entity_wallet_identities: [{ entity_id: "e1", chain_family: "evm", address, confidence: "high" }, { entity_id: "missing", chain_family: "evm", address, confidence: "high" }] });
    const result = createMigrationProjectionCrosswalk(input);
    expect(result.identityCohorts[0]!.wallets).toEqual([]);
    expect(result.identityCohorts[0]!.status).toBe("quarantined");
    expect(result.issues.some(issue => issue.code === "unknown_owner")).toBe(true);
  });

  it("does not choose lifecycle or flags from duplicate entity rows", () => {
    const result = createMigrationProjectionCrosswalk(fixture({ trader_entities: [entity("e1", "active"), entity("e1", "suspended")], trader_profiles: [profile("e1")] }));
    expect(result.identityCohorts[0]).toMatchObject({ status: "quarantined", lifecycle: null, suspended: null, manual: null, locked: null });
  });

  it("quarantines an account owner's cohort when wallet address semantics are unknown", () => {
    const result = createMigrationProjectionCrosswalk(fixture({ trader_entities: [entity("e1")], trader_profiles: [profile("e1")],
      fomo_accounts: [{ account_id: "a1" }], entity_accounts: [{ entity_id: "e1", account_id: "a1", confidence: "high" }],
      wallet_identities: [{ account_id: "a1", chain_family: "unreviewed", address, confidence: "high" }] }));
    expect(result.identityCohorts[0]!.status).toBe("quarantined");
    expect(result.identityCohorts[0]!.wallets).toEqual([]);
  });

  it("preserves unknown profile flags, confidence and missing numeric facts without inventing zeros", () => {
    const input = fixture({ trader_entities: [entity("e1", "unreviewed-state")], trader_profiles: [{ ...profile("e1"), monitoring_enabled: "true" }],
      entity_wallet_identities: [{ entity_id: "e1", chain_family: "evm", address, confidence: "unreviewed-confidence" }],
      trader_token_samples: [{ sample_id: "legacy", entity_id: "e1", profit_multiple: null }] });
    const result = createMigrationProjectionCrosswalk(input); const cohort = result.identityCohorts[0]!;
    expect(cohort.suspended).toBeNull(); expect(cohort.profileFlags.monitoring_enabled).toBeNull();
    expect(cohort.status).toBe("quarantined");
    const legacy = result.rows.find(row => row.table === "trader_token_samples")!;
    expect(legacy.targetRoute).toBe("legacy_preservation");
    expect(Object.values(legacy.values).filter(cell => cell.storage === "null").length).toBeGreaterThan(0);
    expect(result.grantsBusinessEligibility).toBe(false);
  });

  it("resolves composite PK/FK references using all typed components", () => {
    const input = fixture({ wallet_monitor_observations: [{ source: "s1", event_id: "same" }, { source: "s2", event_id: "same" }],
      wallet_monitor_execution_bases: [{ source: "s2", event_id: "same", basis_json: "{}" }] });
    const result = createMigrationProjectionCrosswalk(input);
    const reference = result.rows.find(row => row.table === "wallet_monitor_execution_bases")!.references[0]!;
    expect(reference.status).toBe("resolved_exact_storage"); expect(reference.values).toHaveLength(2);
    expect(reference.candidates).toEqual([{ table: "wallet_monitor_observations", rowOrdinal: 1 }]);
    expect(result.issues.some(issue => issue.code === "sqlite_affinity_and_collation_not_evaluated")).toBe(true);
  });

  it("retains lossless large integer keys and reports missing typed references as unknown", () => {
    const input = fixture({ wallet_monitor_observations: [{ source: "s", event_id: integer("9223372036854775807") }],
      wallet_monitor_execution_bases: [{ source: "s", event_id: "9223372036854775807", basis_json: "{}" }] });
    const result = createMigrationProjectionCrosswalk(input);
    expect(result.rows.find(row => row.table === "wallet_monitor_observations")!.primaryKey![1]).toEqual(integer("9223372036854775807"));
    expect(result.rows.find(row => row.table === "wallet_monitor_execution_bases")!.references[0]!.status).toBe("unresolved");
  });

  const semanticRule: MigrationSemanticReferenceRule = { table: "wallet_monitor_execution_bases", column: "basis_json", path: ["event"],
    targetTable: "wallet_monitor_observations", targetColumns: ["source", "event_id"], storageClasses: ["text", "text"] };
  it("resolves only explicitly reviewed semantic JSON reference paths", () => {
    const input = fixture({ wallet_monitor_observations: [{ source: "s", event_id: "e" }],
      wallet_monitor_execution_bases: [{ source: "s", event_id: "e", basis_json: '{"event":["s","e"],"unreviewed":"keep"}' }] }, [semanticRule]);
    const result = createMigrationProjectionCrosswalk(input);
    expect(result.rows.find(row => row.table === "wallet_monitor_execution_bases")!.references.find(reference => reference.kind === "semantic_json")!.status).toBe("resolved_exact_storage");
    expect(result.coverage.completeSemanticCoverage).toBe(false);
    expect(result.issues.some(issue => issue.code === "partial_semantic_field_coverage" && issue.field === "basis_json")).toBe(true);
  });

  it.each(['{"event":["s","e"],"event":["s","other"]}', '{"event":9007199254740993}', '{"other":["s","e"]}', '{"event":false}'])("keeps unsupported JSON opaque and marks reference unknown: %s", basis_json => {
    const input = fixture({ wallet_monitor_observations: [{ source: "s", event_id: "e" }], wallet_monitor_execution_bases: [{ source: "s", event_id: "e", basis_json }] }, [semanticRule]);
    const result = createMigrationProjectionCrosswalk(input); const row = result.rows.find(row => row.table === "wallet_monitor_execution_bases")!;
    expect(row.references.find(reference => reference.kind === "semantic_json")!.status).toBe("unknown");
    expect(row.values.basis_json).toEqual({ storage: "text", encoding: "base64", value: Buffer.from(basis_json).toString("base64") });
  });

  it("reports unprovided identity coverage and unsupported semantic fields honestly", () => {
    const input = fixture({ trader_entities: [entity("e1")], trader_profiles: [profile("e1")] });
    const chunks = input.chunks.filter(chunk => chunk.table !== "trader_profiles");
    const result = createMigrationProjectionCrosswalk({ ...input, chunks });
    expect(result.identityCohorts[0]!.status).toBe("quarantined");
    expect(result.issues.some(issue => issue.code === "partial_identity_cohort_input")).toBe(true);
    expect(result.issues.some(issue => issue.code === "unknown_semantic_field" && issue.field === "basis_json")).toBe(true);
    expect(result.issues.some(issue => issue.code === "unsupported_identity_metadata_adapter")).toBe(true);
  });

  it("rejects duplicate chunks and enforces rows, bytes, index and issue quotas", () => {
    const input = fixture({ trader_entities: [entity("e1"), entity("e2")], trader_profiles: [profile("e1"), profile("e2")] });
    expect(() => createMigrationProjectionCrosswalk({ ...input, chunks: [...input.chunks, input.chunks[0]!] })).toThrow("duplicate_chunk");
    expect(() => createMigrationProjectionCrosswalk({ ...input, limits: { maximumRows: 1 } })).toThrow("row_limit");
    expect(() => createMigrationProjectionCrosswalk({ ...input, limits: { maximumBytes: 1 } })).toThrow("input_limit");
    expect(() => createMigrationProjectionCrosswalk({ ...input, limits: { maximumIndexEntries: 1 } })).toThrow("index_entry_limit");
    expect(() => createMigrationProjectionCrosswalk({ ...input, limits: { maximumIssues: 1 } })).toThrow("issue_limit");
  });
});
