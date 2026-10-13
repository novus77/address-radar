import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportPostgresV3PhysicalReference, acceptPostgresV3PhysicalSchema, type PhysicalCatalogPort } from "../src/postgres-schema-v3-physical-acceptance.js";

const fingerprint = "a".repeat(64);
const table = () => ({ table: "samples", kind: "r", persistence: "p", columns: [
  { name: "id", position: 1, type: "text", notNull: true, default: null, identity: "", generated: "", collation: "pg_catalog.default" },
], constraints: [
  { name: "samples_pkey", type: "p", definition: "PRIMARY KEY (id)", validated: true, deferrable: false, deferred: false },
  { name: "samples_check", type: "c", definition: "CHECK ((length(id) > 0))", validated: true, deferrable: false, deferred: false },
  { name: "samples_unique", type: "u", definition: "UNIQUE (id)", validated: true, deferrable: false, deferred: false },
  { name: "samples_fk", type: "f", definition: "FOREIGN KEY (id) REFERENCES parents(id)", validated: true, deferrable: false, deferred: false },
], indexes: [{ name: "samples_pkey", definition: "CREATE UNIQUE INDEX samples_pkey ON samples USING btree (id)", valid: true, ready: true, live: true }] });
function port(objects: unknown[] = [table()], version = "170006", shadow = false) {
  const calls: string[] = [];
  const paths: unknown[] = [];
  let safePath = false;
  let shadowCalls = 0;
  const reader: PhysicalCatalogPort = { run: async work => work({ query: async (sql: string, values: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("set_config")) {
      paths.push(values[0]);
      safePath = values[0] === 'pg_catalog,"isolated_reference",pg_temp' || values[0] === 'pg_catalog,"target",pg_temp';
    }
    if (sql.includes("physical-v3-environment")) return { rows: [{ schema_exists: true, server_version: version }] };
    if (sql.includes("physical-v3-catalog") && shadow && !safePath) { shadowCalls++; throw new Error("shadow_catalog_function_invoked"); }
    if (sql.includes("physical-v3-catalog")) return { rows: objects.map(object => ({ object })) };
    return { rows: [] };
  } }) };
  return { reader, calls, paths, shadowCalls: () => shadowCalls };
}
async function fixture() {
  const reference = port();
  const manifest = await exportPostgresV3PhysicalReference({ port: reference.reader, schema: "isolated_reference", planFingerprint: fingerprint, maximumTables: 200, maximumBytes: 100000 });
  const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return { manifest, manifestSha256, reference, approval: { planFingerprint: fingerprint, manifestSha256, verifyReference: async () => true } };
}
describe("independent v3 physical acceptance", () => {
  it("prevents target catalog-function shadows and places temporary lookup last", async () => {
    const f = await fixture(), target = port([table()], "170006", true);
    await expect(acceptPostgresV3PhysicalSchema({ ...f, approval: f.approval, port: target.reader, schema: "target", maximumTables: 200, maximumBytes: 100000 })).resolves.toMatchObject({ status: "physical_schema_accepted" });
    expect(target.paths).toEqual(['pg_catalog,"target",pg_temp']);
    expect(target.shadowCalls()).toBe(0);
  });
  it("exports reference under the same protected lookup policy", async () => {
    const reference = port([table()], "170006", true);
    await expect(exportPostgresV3PhysicalReference({ port: reference.reader, schema: "isolated_reference", planFingerprint: fingerprint, maximumTables: 200, maximumBytes: 100000 })).resolves.toMatchObject({ schemaVersion: 3 });
    expect(reference.paths).toEqual(['pg_catalog,"isolated_reference",pg_temp']);
    expect(reference.shadowCalls()).toBe(0);
  });
  it("accepts exact definitions using read-only repeatable snapshot, without DDL or ledger trust", async () => {
    const f = await fixture(), target = port();
    await expect(acceptPostgresV3PhysicalSchema({ ...f, approval: f.approval, port: target.reader, schema: "target", maximumTables: 200, maximumBytes: 100000 })).resolves.toMatchObject({ status: "physical_schema_accepted", schemaVersion: 3, manifestSha256: f.manifestSha256 });
    expect(target.calls[0]).toBe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(target.calls.join("\n")).not.toMatch(/CREATE |ALTER |DROP |INSERT |DELETE |UPDATE /);
    expect(target.calls.join("\n")).toContain("pg_get_indexdef");
    expect(target.calls.join("\n")).toContain("pg_get_constraintdef");
  });
  for (const kind of ["column", "p", "f", "u", "c", "index", "invalid", "unvalidated", "missing", "extra", "ledger-only"] as const) {
    it(`rejects ${kind} drift, including equal object counts`, async () => {
      const f = await fixture(), changed = table(); let objects: unknown[] = [changed];
      if (kind === "column") changed.columns[0]!.notNull = false;
      else if (["p", "f", "u", "c"].includes(kind)) changed.constraints.find(c => c.type === kind)!.definition += " DRIFT";
      else if (kind === "index") changed.indexes[0]!.definition += " WHERE false";
      else if (kind === "invalid") changed.indexes[0]!.valid = false;
      else if (kind === "unvalidated") changed.constraints[0]!.validated = false;
      else if (kind === "extra") objects.push({ ...table(), table: "extra" });
      else if (kind === "missing") objects = [];
      else if (kind === "ledger-only") objects = [{ ...table(), table: "business_schema_ledger" }];
      await expect(acceptPostgresV3PhysicalSchema({ ...f, approval: f.approval, port: port(objects).reader, schema: "target", maximumTables: 200, maximumBytes: 100000 })).rejects.toThrow();
    });
  }
  it("rejects self-proclaimed reference trust before target queries", async () => {
    const f = await fixture(), target = port();
    await expect(acceptPostgresV3PhysicalSchema({ ...f, approval: { ...f.approval, verifyReference: async () => false }, port: target.reader, schema: "target", maximumTables: 200, maximumBytes: 100000 })).rejects.toThrow("reference_not_trusted");
    expect(target.calls).toEqual([]);
  });
  it("rejects changed manifest, version mismatch and exceeded bounds", async () => {
    const f = await fixture();
    await expect(acceptPostgresV3PhysicalSchema({ ...f, approval: { ...f.approval, manifestSha256: "b".repeat(64) }, port: port().reader, schema: "target", maximumTables: 200, maximumBytes: 100000 })).rejects.toThrow();
    await expect(acceptPostgresV3PhysicalSchema({ ...f, approval: f.approval, port: port([table()], "180001").reader, schema: "target", maximumTables: 200, maximumBytes: 100000 })).rejects.toThrow();
    await expect(exportPostgresV3PhysicalReference({ port: port([table(), table()]).reader, schema: "target", planFingerprint: fingerprint, maximumTables: 1, maximumBytes: 100000 })).rejects.toThrow();
    await expect(exportPostgresV3PhysicalReference({ port: port().reader, schema: "target", planFingerprint: fingerprint, maximumTables: 200, maximumBytes: 1 })).rejects.toThrow();
  });
});
