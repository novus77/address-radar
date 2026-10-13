import { describe, expect, it } from "vitest";
import { createPostgresMigrationRuntime, type PostgresMigrationRuntimeOptions } from "../src/postgres-migration-runtime.js";

const options = (database: string, schema: string): PostgresMigrationRuntimeOptions => ({
  pool: { async connect() { throw new Error("Constructor must not connect"); }, async end() {} },
  target: { database, schema, username: "radar_migrator", generation: "isolated-generation", service: "migration",
    serverAddress: "127.0.0.1", serverPort: 5434, schemaVersion: 2, schemaFingerprint: "a".repeat(64), systemIdentifier: "123456789" },
  capability: { mode: "isolated", purpose: "business_import", approvalRef: "isolated-fixture",
    planSha256: "b".repeat(64), expiresAtMs: Date.now() + 60000 },
  limits: { operationTimeoutMs: 1000, connectionTimeoutMs: 100, statementTimeoutMs: 100, lockTimeoutMs: 50,
    maximumSqlStatements: 100, workMemKb: 1024, closeTimeoutMs: 100 },
  clock: Date.now, async assertAuthorized() { throw new Error("No runtime authorization supplied"); },
});
describe("migration isolation naming", () => {
  it("accepts the same exact private rehearsal nonce used by the actual PG fixture", () => {
    expect(() => createPostgresMigrationRuntime(options("radar_rehearsal_0123456789abcdef", "radar_rehearsal_0123456789abcdef_schema"))).not.toThrow();
  });
  it.each([
    ["radar_rehearsal_0123456789abcdef", "radar_rehearsal_fedcba9876543210_schema"],
    ["radar_rehearsal", "radar_rehearsal_schema"],
    ["radar_rehearsal_0123456789abcde", "radar_rehearsal_0123456789abcde_schema"],
    ["radar_rehearsal_0123456789abcdef0", "radar_rehearsal_0123456789abcdef0_schema"],
    ["radar_rehearsal_0123456789abcdeg", "radar_rehearsal_0123456789abcdeg_schema"],
    ["radar_rehearsal_0123456789abcdef_test", "radar_rehearsal_fedcba9876543210_test"],
    ["radar_rehearsal_0123456789abcdef_test", "radar_acceptance_schema"],
    ["radar_rehearsal_0123456789abcde_test", "radar_rehearsal_0123456789abcde_test"],
    ["radar_business", "radar_rehearsal_0123456789abcdef_schema"],
    ["radar_rehearsal_0123456789abcdef", "radar_business"],
  ])("refuses unpinned or mismatched rehearsal names: %s / %s", (database, schema) => {
    expect(() => createPostgresMigrationRuntime(options(database, schema))).toThrow("isolated_target_required");
  });
});

it.each(["0", "01", "18446744073709551616", "not-a-cluster"])("refuses invalid uint64 system identifier %s", systemIdentifier => {
  const value = options("radar_rehearsal_0123456789abcdef", "radar_rehearsal_0123456789abcdef_schema");
  expect(() => createPostgresMigrationRuntime({ ...value, target: { ...value.target, systemIdentifier } })).toThrow("invalid_target");
});

it("rejects uppercase nonce identifiers at the target gate", () => {
  expect(() => createPostgresMigrationRuntime(options("radar_rehearsal_0123456789ABCDEF", "radar_rehearsal_0123456789ABCDEF_schema"))).toThrow("invalid_target");
});
