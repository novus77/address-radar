import { MIGRATION_CUTOVER_TRANSITIONS_DDL, MIGRATION_CUTOVER_TRANSITIONS_V2_DDL, MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL } from "../src/migration-cutover-coordinator.js";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresClient } from "../src/postgres-unit-of-work.js";
import { authenticatePostgresBusinessNamespaceReceipt, postgresBusinessNamespaceReceiptSigningPayload,
  type PostgresBusinessProvisionedNamespaceReceipt, type PostgresBusinessNamespaceAuthority, type PostgresBusinessProvisionedNamespaceApproval,
  createPostgresBusinessSchemaPlan, installPostgresBusinessSchema, POSTGRES_BUSINESS_SCHEMA_MODULES,
  POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL, POSTGRES_BUSINESS_SCHEMA_PLAN, PostgresBusinessSchemaRefusalError,
  type PostgresBusinessSchemaInstallerOptions, type PostgresBusinessSchemaTrustedModule } from "../src/postgres-business-schema.js";
import { POSTGRES_CAPTURE_INBOX_SCHEMA_SQL } from "../src/postgres-capture-inbox.js";
import { POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL } from "../src/postgres-forward-token-watch.js";

const options: PostgresBusinessSchemaInstallerOptions = {
  target: { database: "radar_business", username: "radar_migration", schema: "business_v1", generation: "generation-1", service: "migration" },
  approval: "approved-new-business-schema", approvalRef: "migration-review/2026-10-04",
};

function fixture() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const releases: Array<Error | undefined> = [];
  const state = {
    namespacePins: { oid: 42, namespace_oid: "42", namespace_owner_oid: "64", namespace_owner: "radar_migration", database_oid: "32" },
    cluster: { system_identifier: "7283888888", database_create: false, database_temp: false } as Record<string, unknown>,
    duringDdl: undefined as (() => void) | undefined,
    namespace: false, identityExists: false, ledgerExists: false, occupied: false,
    identityKind: "r", identityPersistence: "p", ledgerKind: "r", ledgerPersistence: "p",
    header: [] as Array<Record<string, unknown>>, history: [] as Array<Record<string, unknown>>,
    collisions: [] as Array<Record<string, unknown>>, fail: "", rollbackFail: false,
    identity: { database: "radar_business", username: "radar_migration", session_username: "radar_migration", role_safe: true },
  };
  let before: { namespace: boolean; identityExists: boolean; ledgerExists: boolean;
    header: Array<Record<string, unknown>>; history: Array<Record<string, unknown>> };
  let concurrent = false;
  const client: PostgresClient = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === state.fail || (sql === "ROLLBACK" && state.rollbackFail)) throw new Error("injected failure");
      let rows: Array<Record<string, unknown>> = [];
      if (sql === "BEGIN") {
        if (concurrent) throw new Error("fixture cannot model concurrent server transactions");
        concurrent = true;
        before = { namespace: state.namespace, identityExists: state.identityExists, ledgerExists: state.ledgerExists,
          header: structuredClone(state.header), history: structuredClone(state.history) };
      } else if (sql === "ROLLBACK") { Object.assign(state, before!); concurrent = false;
      } else if (sql === "COMMIT") { concurrent = false;
      } else if (sql.includes("business-schema-installer-identity")) rows = [state.identity];
      else if (sql.includes("business-schema-namespace")) rows = state.namespace ? [{ ...state.namespacePins }] : [];
      else if (sql.includes("business-schema-provisioned-cluster")) rows = [{ ...state.cluster }];
      else if (sql.startsWith("CREATE SCHEMA")) state.namespace = true;
      else if (sql.includes("business-schema-presence")) rows = [{
        identity_exists: state.identityExists, ledger_exists: state.ledgerExists,
        identity_valid: state.identityExists && state.identityKind === "r" && state.identityPersistence === "p",
        ledger_valid: state.ledgerExists && state.ledgerKind === "r" && state.ledgerPersistence === "p",
      }];
      else if (sql.includes("business-schema-empty")) rows = state.occupied ? [{ occupied: 1 }] : [];
      else if (sql === POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL) { state.identityExists = true; state.ledgerExists = true; state.duringDdl?.(); }
      else if (sql.startsWith('INSERT INTO "business_v1".business_schema_identity')) {
        state.header.push({ singleton: true, ledger_format: 1, database_name: values[0], schema_name: values[1], generation_id: values[2] });
      } else if (sql.includes("business-schema-header")) rows = state.header;
      else if (sql.includes("business-schema-history")) rows = state.history;
      else if (sql.includes("business-schema-collisions")) rows = state.collisions;
      else if (sql.startsWith('INSERT INTO "business_v1".business_schema_ledger')) {
        state.history.push({ version: values[0], fingerprint: values[1], previous_fingerprint: values[2], modules_json: values[3] });
      }
      return { rows, rowCount: rows.length };
    },
    release(error) { releases.push(error); },
  };
  const work = createPostgresUnitOfWork({ async connect() { return client; } }, { statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
  return { state, statements, releases, work, install: (overrides: Partial<PostgresBusinessSchemaInstallerOptions> = {}) =>
    installPostgresBusinessSchema(work, { ...options, ...overrides }) };
}

const ddl = (statements: Array<{ sql: string }>) => statements.filter(entry => /^\s*CREATE\s/.test(entry.sql));

describe("PostgreSQL permanent business schema", () => {
  it("reuses all 15 module constants with their dependencies and exact SQL bytes", () => {
    expect(POSTGRES_BUSINESS_SCHEMA_MODULES).toHaveLength(15);
    expect(POSTGRES_BUSINESS_SCHEMA_MODULES.find(entry => entry.id === "capture-inbox")?.sql).toBe(POSTGRES_CAPTURE_INBOX_SCHEMA_SQL);
    expect(POSTGRES_BUSINESS_SCHEMA_MODULES.find(entry => entry.id === "token-watch")?.sql).toBe(POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL);
    const seen = new Set<string>();
    for (const entry of POSTGRES_BUSINESS_SCHEMA_MODULES) {
      expect(entry.dependencies.every(id => seen.has(id))).toBe(true); seen.add(entry.id);
      expect(entry.sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|ALTER)\b/);
      expect(entry.sql).not.toContain("CREATE TEMP");
    }
  });

  it("fingerprints exact ordered composition and version boundaries deterministically", () => {
    const a = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-inbox", "capture-health"] }]);
    expect(createPostgresBusinessSchemaPlan(a.migrations)).toEqual(a);
    const b = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-health", "capture-inbox"] }]);
    const c = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-inbox"] }, { version: 2, modules: ["capture-health"] }]);
    expect(a.fingerprint).not.toBe(b.fingerprint); expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(Object.isFrozen(a.migrations[0]?.modules)).toBe(true);
    expect(c.migrations[1]?.previousFingerprint).toBe(c.migrations[0]?.fingerprint);
  });

  it("rejects missing dependencies, duplicate modules, unknown modules and version gaps", () => {
    for (const steps of [[], [{ version: 2, modules: ["capture-inbox"] }], [{ version: 1, modules: ["normalization"] }],
      [{ version: 1, modules: ["capture-inbox", "capture-inbox"] }], [{ version: 1, modules: ["unknown"] }],
      [{ version: 1, modules: [] }], [{ version: 1, modules: ["capture-inbox"] }, { version: 3, modules: ["capture-health"] }]]) {
      expect(() => createPostgresBusinessSchemaPlan(steps as Parameters<typeof createPostgresBusinessSchemaPlan>[0])).toThrow();
    }
  });

  it("installs only after an advisory transaction lock and commits the exact ordered ledger", async () => {
    const f = fixture();
    const receipt = await f.install();
    expect(receipt).toMatchObject({ status: "installed", version: 1, fingerprint: POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint, appliedVersions: [1] });
    expect(f.statements[2]?.sql).toContain("pg_advisory_xact_lock");
    expect(f.statements[2]?.values).toEqual(["address-radar:business-schema:radar_business:business_v1"]);
    expect(f.statements.find(entry => entry.sql.includes("business-schema-search-path"))?.values).toEqual(['"business_v1",pg_catalog,pg_temp']);
    expect(f.statements.some(entry => entry.sql.includes("IF NOT EXISTS"))).toBe(false);
    expect(f.statements.at(-1)?.sql).toBe("COMMIT");
    expect(f.state.header[0]?.generation_id).toBe("generation-1");
    expect(f.state.history).toHaveLength(1);
    expect(f.state.history[0]?.modules_json).toBe(JSON.stringify(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]?.modules));
    expect(f.statements.filter(entry => POSTGRES_BUSINESS_SCHEMA_MODULES.some(module => entry.sql === module.sql.replace(/\bIF\s+NOT\s+EXISTS\s+/g, "")))).toHaveLength(15);
    expect(f.statements.some(entry => /\b(?:DROP|TRUNCATE|ALTER)\b/.test(entry.sql))).toBe(false);
  });

  it("reconciles an exact retry without repeating DDL or receipts", async () => {
    const f = fixture(); await f.install();
    const length = f.statements.length;
    await expect(f.install()).resolves.toMatchObject({ status: "already-installed", appliedVersions: [] });
    expect(ddl(f.statements.slice(length))).toHaveLength(0);
    expect(f.state.history).toHaveLength(1);
  });

  it("permits an explicitly approved empty isolated namespace", async () => {
    const f = fixture(); f.state.namespace = true;
    await expect(f.install({ approval: "approved-isolated-business-schema" })).resolves.toMatchObject({ status: "installed" });
    expect(f.statements.some(entry => entry.sql.startsWith("CREATE SCHEMA"))).toBe(false);
  });

  it("does not adopt an existing namespace with a new-schema approval", async () => {
    const f = fixture(); f.state.namespace = true;
    await expect(f.install()).rejects.toThrow("cannot adopt");
    expect(ddl(f.statements)).toHaveLength(0);
  });

  it("refuses occupied schemas and partial ledger collisions without destructive repair", async () => {
    for (const partial of [false, true]) {
      const f = fixture(); f.state.namespace = true; f.state.occupied = true; f.state.identityExists = partial;
      await expect(f.install({ approval: "approved-isolated-business-schema" })).rejects.toBeInstanceOf(PostgresBusinessSchemaRefusalError);
      expect(ddl(f.statements)).toHaveLength(0); expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  it.each([
    ["v", "p"], ["m", "p"], ["f", "p"], ["S", "p"], ["i", "p"], ["p", "p"], ["r", "u"], ["r", "t"],
  ])("protocol: refuses reserved relation kind=%s persistence=%s despite matching headers/history", async (kind, persistence) => {
    for (const name of ["identity", "ledger"] as const) {
      const f = fixture(); await f.install();
      // Counterfeit views return the exact approved header/history; only pg_class distinguishes them.
      if (name === "identity") { f.state.identityKind = kind; f.state.identityPersistence = persistence; }
      else { f.state.ledgerKind = kind; f.state.ledgerPersistence = persistence; }
      const length = f.statements.length;
      await expect(f.install()).rejects.toThrow("permanent ordinary tables");
      const attempted = f.statements.slice(length);
      expect(attempted.some(entry => entry.sql.includes("business-schema-header") || entry.sql.includes("business-schema-history"))).toBe(false);
      expect(ddl(attempted)).toHaveLength(0); expect(attempted.at(-1)?.sql).toBe("ROLLBACK");
    }
  });

  it("protocol: refuses two fake ledger views before evaluating either view", async () => {
    const f = fixture(); await f.install(); f.state.identityKind = "v"; f.state.ledgerKind = "v";
    const length = f.statements.length;
    await expect(f.install()).rejects.toThrow("permanent ordinary tables");
    expect(f.statements.slice(length).some(entry => entry.sql.includes("business-schema-header") || entry.sql.includes("business-schema-history"))).toBe(false);
    const catalog = f.statements.slice(length).find(entry => entry.sql.includes("business-schema-presence"))!;
    expect(catalog.sql).toContain("i.relkind='r' AND i.relpersistence='p'");
    expect(catalog.sql).toContain("l.relkind='r' AND l.relpersistence='p'");
    expect(catalog.sql).toContain("pg_catalog.pg_class");
  });

  it("refuses module object collisions even for IF NOT EXISTS module SQL", async () => {
    const f = fixture(); f.state.collisions = [{ relname: "forward_token_watches" }];
    await expect(f.install()).rejects.toThrow("module object collision");
    expect(f.state.namespace).toBe(false); expect(f.state.header).toHaveLength(0); expect(f.state.history).toHaveLength(0);
    expect(f.statements.some(entry => entry.sql === POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL)).toBe(false);
  });

  it.each(["database_name", "schema_name", "generation_id", "ledger_format", "singleton"])("refuses header %s drift on retry", async key => {
    const f = fixture(); await f.install(); f.state.header[0]![key] = "wrong";
    const length = f.statements.length;
    await expect(f.install()).rejects.toThrow("identity or generation collision");
    expect(ddl(f.statements.slice(length))).toHaveLength(0);
  });

  it.each(["version", "fingerprint", "previous_fingerprint", "modules_json"])("refuses exact ordered ledger %s drift", async key => {
    const f = fixture(); await f.install(); f.state.history[0]![key] = "wrong";
    const length = f.statements.length;
    await expect(f.install()).rejects.toThrow("ordered fingerprint collision");
    expect(ddl(f.statements.slice(length))).toHaveLength(0);
  });

  it("refuses an initialized empty ledger or an installed version newer than the plan", async () => {
    const f = fixture(); await f.install(); f.state.history = [];
    await expect(f.install()).rejects.toThrow("incomplete or newer");
    f.state.history = [{ version: 1 }, { version: 2 }];
    await expect(f.install()).rejects.toThrow("incomplete or newer");
  });

  it("appends approved versions only when their complete previous history matches", async () => {
    const f = fixture();
    const initial = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-inbox"] }]);
    await f.install({ plan: initial });
    const plan = createPostgresBusinessSchemaPlan([
      { version: 1, modules: ["capture-inbox"] }, { version: 2, modules: ["normalization", "consumer-work"] },
    ]);
    const length = f.statements.length;
    await expect(f.install({ plan })).resolves.toMatchObject({ version: 2, fingerprint: plan.fingerprint, appliedVersions: [2] });
    expect(f.statements.slice(length).some(entry => entry.sql === POSTGRES_CAPTURE_INBOX_SCHEMA_SQL)).toBe(false);
    expect(f.state.history.map(row => row.version)).toEqual([1, 2]);
    await expect(f.install({ plan: initial })).rejects.toThrow("incomplete or newer");
  });

  it("rejects reordered/replaced historical composition rather than silently installing it", async () => {
    const f = fixture();
    await f.install({ plan: createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-inbox", "capture-health"] }]) });
    const plan = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-health", "capture-inbox"] }]);
    await expect(f.install({ plan })).rejects.toThrow("ordered fingerprint collision");
  });

  it("validates approval and plan fingerprints before acquiring a connection", async () => {
    const f = fixture();
    await expect(f.install({ approvalRef: "" })).rejects.toThrow("explicit scoped approval");
    await expect(f.install({ approval: "unapproved" as PostgresBusinessSchemaInstallerOptions["approval"] })).rejects.toThrow("explicit scoped approval");
    await expect(f.install({ plan: { ...POSTGRES_BUSINESS_SCHEMA_PLAN, fingerprint: "b".repeat(64) } })).rejects.toThrow("plan fingerprint mismatch");
    expect(f.statements).toHaveLength(0);
  });

  it("validates the dedicated migration identity and refuses privileged roles before DDL", async () => {
    const f = fixture(); f.state.identity.role_safe = false;
    await expect(f.install()).rejects.toThrow("migration role mismatch");
    expect(ddl(f.statements)).toHaveLength(0);
  });

  it("rolls back all ledger and module DDL on failure and permits a clean explicit retry", async () => {
    const f = fixture(); f.state.fail = POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL.replace(/\bIF\s+NOT\s+EXISTS\s+/g, "");
    await expect(f.install()).rejects.toThrow("injected failure");
    expect(f.state.namespace).toBe(false); expect(f.state.history).toHaveLength(0);
    f.state.fail = "";
    await expect(f.install()).resolves.toMatchObject({ status: "installed" });
  });

  it("propagates commit uncertainty unchanged and never retries the transaction", async () => {
    const f = fixture(); f.state.fail = "COMMIT";
    await expect(f.install()).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.statements.filter(entry => entry.sql === "BEGIN")).toHaveLength(1);
    expect(f.releases[0]).toBeInstanceOf(PostgresCommitUncertainError);
  });

  it("keeps the approved fifteen-module version-one fingerprint exact even with unused trusted definitions", () => {
    const trustedModules: PostgresBusinessSchemaTrustedModule[] = [{ id: "runtime-support", dependencies: ["capture-inbox"],
      sql: "CREATE TABLE runtime_support (service_id text PRIMARY KEY);" }];
    const defaultPlan = createPostgresBusinessSchemaPlan(undefined, { trustedModules });
    expect(defaultPlan).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN);
    expect(defaultPlan.fingerprint).toBe("9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22");
    expect(POSTGRES_BUSINESS_SCHEMA_MODULES).toHaveLength(15);
  });

  it("appends reviewed runtime auxiliary and four preservation ledger tables as version two", async () => {
    const f = fixture(); await f.install();
    const trustedModules: PostgresBusinessSchemaTrustedModule[] = [
      { id: "wallet-channel", dependencies: ["capture-inbox"], sql: "CREATE TABLE wallet_channel_facts (fact_id text PRIMARY KEY);" },
      { id: "runtime-support", dependencies: ["wallet-channel"], sql: "CREATE TABLE runtime_support (service_id text PRIMARY KEY);" },
      { id: "preservation-ledgers", dependencies: ["runtime-support"], sql:
        "CREATE TABLE preservation_operations (operation_id text PRIMARY KEY);\n"
        + "CREATE TABLE preservation_chunks (chunk_id text PRIMARY KEY);\n"
        + "CREATE TABLE preservation_row_maps (row_id text PRIMARY KEY);\n"
        + "CREATE TABLE preservation_quarantine (quarantine_id text PRIMARY KEY);" },
    ];
    const steps = [...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations,
      { version: 2, modules: trustedModules.map(entry => entry.id) }];
    const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules });
    expect(plan.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
    expect(plan.migrations[1]?.previousFingerprint).toBe(POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint);
    const before = structuredClone(f.state.history[0]);
    const length = f.statements.length;
    await expect(f.install({ plan, trustedModules })).resolves.toMatchObject({ version: 2, appliedVersions: [2] });
    expect(f.state.history[0]).toEqual(before);
    const applied = ddl(f.statements.slice(length));
    expect(applied).toHaveLength(3);
    expect(applied.some(entry => POSTGRES_BUSINESS_SCHEMA_MODULES.some(module => entry.sql === module.sql))).toBe(false);
    expect(applied.at(-1)?.sql.match(/CREATE TABLE/g)).toHaveLength(4);
    const retry = f.statements.length;
    await expect(f.install({ plan, trustedModules })).resolves.toMatchObject({ status: "already-installed", appliedVersions: [] });
    expect(ddl(f.statements.slice(retry))).toHaveLength(0);
  });

  it("supports a separate preservation-only schema plan without importing business tables", async () => {
    const trustedModules: PostgresBusinessSchemaTrustedModule[] = [{ id: "preservation-only", dependencies: [],
      sql: "CREATE TABLE preservation_operations (operation_id text PRIMARY KEY);" }];
    const plan = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["preservation-only"] }], { trustedModules });
    const f = fixture();
    await expect(f.install({ plan, trustedModules })).resolves.toMatchObject({ version: 1 });
    expect(f.statements.some(entry => entry.sql === POSTGRES_CAPTURE_INBOX_SCHEMA_SQL)).toBe(false);
  });

  it("refuses built-in ID overrides and duplicate trusted IDs before acquisition", async () => {
    for (const trustedModules of [
      [{ id: "capture-inbox", dependencies: [], sql: "CREATE TABLE overwritten_inbox (id text);" }],
      [{ id: "aux", dependencies: [], sql: "CREATE TABLE aux_one (id text);" },
        { id: "aux", dependencies: [], sql: "CREATE TABLE aux_two (id text);" }],
    ]) {
      expect(() => createPostgresBusinessSchemaPlan(undefined, { trustedModules })).toThrow("overwrites an existing ID");
      const f = fixture();
      await expect(f.install({ trustedModules })).rejects.toThrow("overwrites an existing ID");
      expect(f.statements).toHaveLength(0);
    }
  });

  it("refuses unknown, cyclic, self or duplicated dependencies", () => {
    const ddl = "CREATE TABLE aux_table (id text);";
    for (const trustedModules of [
      [{ id: "aux", dependencies: ["unknown"], sql: ddl }],
      [{ id: "aux", dependencies: ["aux"], sql: ddl }],
      [{ id: "aux", dependencies: ["capture-inbox", "capture-inbox"], sql: ddl }],
      [{ id: "aux", dependencies: ["other"], sql: ddl }, { id: "other", dependencies: ["aux"], sql: ddl }],
    ]) expect(() => createPostgresBusinessSchemaPlan(undefined, { trustedModules })).toThrow();
  });

  it("requires trusted dependencies to occur earlier in the selected plan", () => {
    const trustedModules = [{ id: "aux", dependencies: ["runtime-support"], sql: "CREATE TABLE aux_table (id text);" },
      { id: "runtime-support", dependencies: [], sql: "CREATE TABLE runtime_support (id text);" }];
    expect(() => createPostgresBusinessSchemaPlan([
      ...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: ["aux", "runtime-support"] },
    ], { trustedModules })).toThrow("out of dependency order");
    expect(() => createPostgresBusinessSchemaPlan([
      ...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: ["aux"] },
    ], { trustedModules })).toThrow("out of dependency order");
  });

  it("does not admit extensions into the existing business version one", () => {
    const trustedModules = [{ id: "aux", dependencies: [], sql: "CREATE TABLE aux_table (id text);" }];
    expect(() => createPostgresBusinessSchemaPlan([{ version: 1,
      modules: [...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]!.modules, "aux"],
    }], { trustedModules })).toThrow("append after version one");
  });

  it("requires the installer to receive the trusted registry separately from serialized plan data", async () => {
    const trustedModules = [{ id: "aux", dependencies: [], sql: "CREATE TABLE aux_table (id text);" }];
    const plan = createPostgresBusinessSchemaPlan([
      ...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: ["aux"] },
    ], { trustedModules });
    const f = fixture();
    await expect(f.install({ plan })).rejects.toThrow("unknown");
    await expect(f.install({ plan: { ...plan, trustedModules } as typeof plan })).rejects.toThrow("unknown");
    expect(f.statements).toHaveLength(0);
    expect(JSON.stringify(plan)).not.toContain("CREATE TABLE");
  });

  it("refuses unknown manifest SQL and SQL embedded in migration steps", async () => {
    const f = fixture();
    const forged = { version: 2, fingerprint: "a".repeat(64), migrations: [
      ...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations,
      { version: 2, modules: ["manifest-sql"], sql: "CREATE TABLE injected (id text);" },
    ] };
    await expect(f.install({ plan: forged as typeof POSTGRES_BUSINESS_SCHEMA_PLAN })).rejects.toThrow();
    expect(() => createPostgresBusinessSchemaPlan([
      { version: 1, modules: ["capture-inbox"], sql: "DROP TABLE capture_event_identities" },
    ] as unknown as Parameters<typeof createPostgresBusinessSchemaPlan>[0])).toThrow();
    expect(f.statements).toHaveLength(0);
  });

  it("binds custom dependency definitions to the plan fingerprint", async () => {
    const original = { id: "aux", dependencies: ["capture-inbox"], sql: "CREATE TABLE aux_table (id text);" };
    const steps = [...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: ["aux"] }];
    const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules: [original] });
    const changed = { ...original, dependencies: ["capture-health"] };
    expect(createPostgresBusinessSchemaPlan(steps, { trustedModules: [changed] }).fingerprint).not.toBe(plan.fingerprint);
    const f = fixture();
    await expect(f.install({ plan, trustedModules: [changed] })).rejects.toThrow("plan fingerprint mismatch");
    expect(f.statements).toHaveLength(0);
  });

  it("refuses rewriting an installed custom version even when the caller rebuilds matching plan hashes", async () => {
    const original = { id: "aux", dependencies: [], sql: "CREATE TABLE aux_table (id text);" };
    const steps = [...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: ["aux"] }];
    const f = fixture();
    await f.install({ plan: createPostgresBusinessSchemaPlan(steps, { trustedModules: [original] }), trustedModules: [original] });
    const changed = { ...original, sql: "CREATE TABLE aux_table (id text, rewritten boolean);" };
    const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules: [changed] });
    const length = f.statements.length;
    await expect(f.install({ plan, trustedModules: [changed] })).rejects.toThrow("ordered fingerprint collision");
    expect(ddl(f.statements.slice(length))).toHaveLength(0);
    expect(f.state.history).toHaveLength(2);
  });

  it("rejects destructive, temporary, qualified or reserved trusted DDL", () => {
    for (const sql of ["DROP TABLE old_rows;", "CREATE TABLE aux (id text); DELETE FROM old_rows;",
      "CREATE TEMP TABLE aux (id text);", "CREATE UNLOGGED TABLE aux (id text);",
      "CREATE TABLE public.aux (id text);", "CREATE TABLE business_schema_ledger (id text);",
      "CREATE FUNCTION helpers() RETURNS void LANGUAGE sql AS $$DELETE FROM old_rows$$;",
      "CREATE TABLE aux (id text); /* outer /* nested */ */ TRUNCATE old_rows;",
      "CREATE TABLE aux (id text DEFAULT 'unterminated);"] ) {
      expect(() => createPostgresBusinessSchemaPlan(undefined, {
        trustedModules: [{ id: "aux", dependencies: [], sql }],
      })).toThrow();
    }
  });

  it("handles quoted defaults/comments without mistaking their semicolons for SQL and strips only DDL IF NOT EXISTS", async () => {
    const trustedModules = [{ id: "aux", dependencies: [], sql:
      "-- reviewed DDL; no action\nCREATE TABLE IF NOT EXISTS aux_table (value text DEFAULT 'IF NOT EXISTS ; DROP TABLE x;', other text DEFAULT $$a;b$$);\n"
      + "/* nested /* comment; */ retained */ CREATE INDEX IF NOT EXISTS aux_value ON aux_table(value);" }];
    const plan = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["aux"] }], { trustedModules });
    const f = fixture(); await f.install({ plan, trustedModules });
    const applied = ddl(f.statements).find(entry => entry.sql.includes("CREATE TABLE aux_table"))!;
    expect(applied.sql).toContain("DEFAULT 'IF NOT EXISTS ; DROP TABLE x;'");
    expect(applied.sql).toContain("DEFAULT $$a;b$$");
    expect(applied.sql).toContain("CREATE INDEX aux_value");
    expect(applied.sql).not.toContain("CREATE TABLE IF NOT EXISTS");
    expect(f.statements.find(entry => entry.sql.includes("business-schema-collisions"))?.values[1]).toEqual(["aux_table", "aux_value"]);
  });

  it("snapshots trusted definitions before transaction acquisition", async () => {
    const trustedModules = [{ id: "aux", dependencies: [] as string[], sql: "CREATE TABLE aux_table (id text);" }];
    const plan = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["aux"] }], { trustedModules });
    const f = fixture();
    const executor = { run: ((callback: Parameters<typeof f.work.run>[0]) => {
      trustedModules[0]!.sql = "CREATE TABLE changed_after_validation (id text);";
      trustedModules[0]!.dependencies.push("capture-health");
      return f.work.run(callback);
    }) as typeof f.work.run };
    await installPostgresBusinessSchema(executor, { ...options, plan, trustedModules });
    expect(f.statements.some(entry => entry.sql.includes("CREATE TABLE aux_table"))).toBe(true);
    expect(f.statements.some(entry => entry.sql.includes("changed_after_validation"))).toBe(false);
  });

  it("bounds trusted registry size and DDL memory", () => {
    const module = { id: "aux", dependencies: [], sql: "CREATE TABLE aux_table (id text);" };
    expect(() => createPostgresBusinessSchemaPlan(undefined, { trustedModules: Array.from({ length: 65 }, (_, index) =>
      ({ ...module, id: `aux-${index}` })) })).toThrow("bounded array");
    expect(() => createPostgresBusinessSchemaPlan(undefined, { trustedModules: [{ ...module,
      sql: " ".repeat(1_048_577) + module.sql }] })).toThrow("invalid");
  });

  it("preserves both schema failure and rollback failure", async () => {
    const f = fixture(); f.state.fail = POSTGRES_CAPTURE_INBOX_SCHEMA_SQL; f.state.rollbackFail = true;
    await expect(f.install()).rejects.toBeInstanceOf(AggregateError);
    expect(f.releases[0]).toBeInstanceOf(Error);
  });
});

function namespaceProof(overrides: Partial<PostgresBusinessProvisionedNamespaceReceipt> = {}, clock = () => 1_000) {
  // This synthetic independent signer is only fixture evidence, not an approved production authority.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receipt: PostgresBusinessProvisionedNamespaceReceipt = {
    version: 1, purpose: "provisioned-empty-business-namespace", receiptId: "provisioner/fixture-1", signerKeyId: "external-reviewer/key-1",
    approvalRef: options.approvalRef, database: options.target.database, databaseOid: "32", schema: options.target.schema,
    namespaceOid: "42", owner: options.target.username, ownerOid: "64", generation: options.target.generation, service: "migration",
    schemaVersion: 1, schemaFingerprint: POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint, systemIdentifier: "7283888888",
    issuedAt: 1_000, expiresAt: 61_000, ...overrides,
  };
  const authority: PostgresBusinessNamespaceAuthority = { signerKeyId: receipt.signerKeyId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), maximumReceiptAgeMs: 60_000, clock };
  const proof = { receipt, signatureBase64: sign(null, Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(receipt)), privateKey).toString("base64") };
  return { receipt, proof, authority, capability: authenticatePostgresBusinessNamespaceReceipt(proof, authority) };
}
const provisionedOptions = (capability: PostgresBusinessProvisionedNamespaceApproval): Partial<PostgresBusinessSchemaInstallerOptions> =>
  ({ approval: "approved-provisioned-business-schema", provisionedNamespaceApproval: capability });

describe("externally approved provisioned business namespace", () => {
  it("bootstraps an exactly owned pre-existing empty namespace without database CREATE/TEMP or CREATE SCHEMA", async () => {
    const f = fixture(); f.state.namespace = true; const proof = namespaceProof();
    await expect(f.install(provisionedOptions(proof.capability))).resolves.toMatchObject({ status: "installed", appliedVersions: [1],
      namespaceReceiptId: proof.receipt.receiptId, namespaceOid: "42" });
    expect(f.statements.some(entry => entry.sql.startsWith("CREATE SCHEMA") || /^\s*GRANT|^\s*ALTER ROLE|CREATE DATABASE/.test(entry.sql))).toBe(false);
    const probes = f.statements.filter(entry => entry.sql.includes("business-schema-provisioned-cluster"));
    expect(probes).toHaveLength(2); expect(probes[0]?.sql).toContain("pg_catalog.pg_control_system()");
    expect(probes[0]?.sql).toContain("pg_catalog.pg_has_role(session_user,r.oid,'SET')");
    expect(probes[0]?.sql).toContain("pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')");
    expect(probes[0]?.sql).toContain("pg_catalog.has_database_privilege(r.oid,current_database(),'TEMP')");
    expect(f.statements.at(-1)?.sql).toBe("COMMIT");
    expect(f.state.history[0]?.fingerprint).toBe("9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22");
  });

  it("composes with an independently gated migration executor and preserves exact retry semantics", async () => {
    const f = fixture(); f.state.namespace = true; const { capability } = namespaceProof();
    let gated = 0;
    const executor = { run: (async operation => { gated += 1; return f.work.run(operation); }) as typeof f.work.run };
    const scoped = { ...options, ...provisionedOptions(capability) };
    await installPostgresBusinessSchema(executor, scoped); const length = f.statements.length;
    await expect(installPostgresBusinessSchema(executor, scoped)).resolves.toMatchObject({ status: "already-installed", appliedVersions: [] });
    expect(gated).toBe(2); expect(ddl(f.statements.slice(length))).toHaveLength(0); expect(f.state.history).toHaveLength(1);
  });

  it("requires authenticated capability, not an empty schema, unsigned receipt or serialized capability", async () => {
    for (const capability of [undefined, {}, namespaceProof().receipt, JSON.parse(JSON.stringify(namespaceProof().capability))]) {
      const f = fixture(); f.state.namespace = true;
      await expect(f.install({ approval: "approved-provisioned-business-schema",
        provisionedNamespaceApproval: capability as PostgresBusinessProvisionedNamespaceApproval })).rejects.toThrow("authenticated external");
      expect(f.statements).toHaveLength(0);
    }
  });

  it("rejects unapproved signer keys, tampered signed pins and noncanonical signatures", () => {
    const valid = namespaceProof(), other = namespaceProof();
    expect(() => authenticatePostgresBusinessNamespaceReceipt(valid.proof, { ...valid.authority, publicKeyPem: other.authority.publicKeyPem })).toThrow("signature");
    expect(() => authenticatePostgresBusinessNamespaceReceipt(valid.proof, { ...valid.authority, signerKeyId: "unknown/key" })).toThrow("approved authority");
    expect(() => authenticatePostgresBusinessNamespaceReceipt({ ...valid.proof, receipt: { ...valid.receipt, namespaceOid: "43" } }, valid.authority)).toThrow("signature");
    expect(() => authenticatePostgresBusinessNamespaceReceipt({ ...valid.proof, signatureBase64: "!".repeat(88) }, valid.authority)).toThrow("signature");
  });

  it("rejects manifest extras, invalid OIDs and scope-free namespace receipts", () => {
    const valid = namespaceProof();
    for (const receipt of [
      { ...valid.receipt, sql: "CREATE SCHEMA adopted" }, { ...valid.receipt, namespaceOid: "0" },
      { ...valid.receipt, ownerOid: "4294967296" }, { ...valid.receipt, databaseOid: "032" },
      { ...valid.receipt, systemIdentifier: "18446744073709551616" }, { ...valid.receipt, purpose: "empty-only" },
      { ...valid.receipt, service: "console" }, { ...valid.receipt, schemaFingerprint: "not-a-fingerprint" },
    ]) expect(() => postgresBusinessNamespaceReceiptSigningPayload(receipt as PostgresBusinessProvisionedNamespaceReceipt)).toThrow();
  });

  it.each(["database", "schema", "owner", "generation", "approvalRef", "schemaFingerprint"] as const)
    ("binds external approval %s before opening the migration transaction", async field => {
      const changes = { [field]: field === "schemaFingerprint" ? "b".repeat(64) : "different_scope" };
      const proof = namespaceProof(changes); const f = fixture(); f.state.namespace = true;
      await expect(f.install(provisionedOptions(proof.capability))).rejects.toThrow("exact installation scope");
      expect(f.statements).toHaveLength(0);
    });

  it("binds the exact version-two registry and does not grant permission to a different plan", async () => {
    const trustedModules = [{ id: "bootstrap-support", dependencies: ["capture-inbox"], sql: "CREATE TABLE bootstrap_support (id text PRIMARY KEY);" }];
    const plan = createPostgresBusinessSchemaPlan([...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations,
      { version: 2, modules: ["bootstrap-support"] }], { trustedModules });
    const proof = namespaceProof({ schemaVersion: 2, schemaFingerprint: plan.fingerprint }); const f = fixture(); f.state.namespace = true;
    await expect(f.install(provisionedOptions(proof.capability))).rejects.toThrow("exact installation scope");
    expect(f.statements).toHaveLength(0);
    await expect(f.install({ ...provisionedOptions(proof.capability), plan, trustedModules })).resolves.toMatchObject({ appliedVersions: [1, 2], fingerprint: plan.fingerprint });
  });

  it.each(["namespace_oid", "namespace_owner_oid", "namespace_owner", "database_oid"] as const)
    ("refuses changed catalog pin %s before any DDL", async field => {
      const f = fixture(); f.state.namespace = true; f.state.namespacePins[field] = "999";
      await expect(f.install(provisionedOptions(namespaceProof().capability))).rejects.toThrow("catalog owner or identity pins");
      expect(ddl(f.statements)).toHaveLength(0); expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
    });

  it.each(["system_identifier", "database_create", "database_temp"] as const)("refuses unsafe cluster/privilege %s", async field => {
    const f = fixture(); f.state.namespace = true; f.state.cluster[field] = field === "system_identifier" ? "999" : true;
    await expect(f.install(provisionedOptions(namespaceProof().capability))).rejects.toThrow("cluster pin or restricted database");
    expect(ddl(f.statements)).toHaveLength(0);
  });

  it("refuses a missing namespace rather than creating it with provisioned approval", async () => {
    const f = fixture();
    await expect(f.install(provisionedOptions(namespaceProof().capability))).rejects.toThrow("catalog owner or identity pins");
    expect(ddl(f.statements)).toHaveLength(0);
  });

  it("refuses occupied namespaces despite a valid externally signed approval", async () => {
    const f = fixture(); f.state.namespace = true; f.state.occupied = true;
    await expect(f.install(provisionedOptions(namespaceProof().capability))).rejects.toThrow("occupied without a matching ledger");
    expect(ddl(f.statements)).toHaveLength(0);
    expect(f.statements.find(entry => entry.sql.includes("business-schema-empty"))?.sql).toContain("pg_catalog.pg_depend");
  });

  it("rechecks namespace ownership after DDL and rolls back drift", async () => {
    const f = fixture(); f.state.namespace = true; f.state.duringDdl = () => { f.state.namespacePins.namespace_owner = "other_owner"; };
    await expect(f.install(provisionedOptions(namespaceProof().capability))).rejects.toThrow("catalog owner or identity pins");
    expect(f.state.history).toHaveLength(0); expect(f.state.identityExists).toBe(false); expect(f.state.namespace).toBe(true);
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("checks authority freshness at authentication, before acquisition and before committing DDL", async () => {
    const valid = namespaceProof();
    for (const clock of [() => 999, () => 61_000, () => Number.NaN, () => { throw new Error("clock secret"); }]) {
      expect(() => authenticatePostgresBusinessNamespaceReceipt(valid.proof, { ...valid.authority, clock })).toThrow();
    }
    expect(() => authenticatePostgresBusinessNamespaceReceipt(valid.proof, { ...valid.authority, maximumReceiptAgeMs: 59_999 })).toThrow("time budget");
    expect(() => authenticatePostgresBusinessNamespaceReceipt(valid.proof, { ...valid.authority, maximumReceiptAgeMs: 900_001 })).toThrow("bounded external");
    let now = 1_000; const proof = namespaceProof({}, () => now); const f = fixture(); f.state.namespace = true;
    now = 61_000; await expect(f.install(provisionedOptions(proof.capability))).rejects.toThrow("expired");
    expect(f.statements).toHaveLength(0);
    now = 1_000; f.state.duringDdl = () => { now = 61_000; };
    await expect(f.install(provisionedOptions(proof.capability))).rejects.toThrow("expired");
    expect(f.state.history).toHaveLength(0); expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("snapshots signed pins and never treats another approval mode as capability adoption", async () => {
    const proof = namespaceProof(); (proof.receipt as { schema: string }).schema = "mutated_after_authentication";
    const f = fixture(); f.state.namespace = true;
    await expect(f.install({ approval: "approved-isolated-business-schema", provisionedNamespaceApproval: proof.capability })).rejects.toThrow("explicit approval mode");
    expect(f.statements).toHaveLength(0);
    await expect(f.install(provisionedOptions(proof.capability))).resolves.toMatchObject({ status: "installed" });
  });

  it("preserves commit uncertainty without replaying a provisioned namespace install", async () => {
    const f = fixture(); f.state.namespace = true; f.state.fail = "COMMIT";
    await expect(f.install(provisionedOptions(namespaceProof().capability))).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.statements.filter(entry => entry.sql === "BEGIN")).toHaveLength(1);
    expect(f.releases[0]).toBeInstanceOf(PostgresCommitUncertainError);
  });
});


describe("trusted additive protocol V2 schema ledger", () => {
  const legacyModule = { id: "migration-cutover-transitions", dependencies: [], sql: MIGRATION_CUTOVER_TRANSITIONS_DDL };
  const v2Module = { id: "migration-cutover-protocol-v2", dependencies: [legacyModule.id],
    sql: MIGRATION_CUTOVER_TRANSITIONS_V2_DDL + "\n;\n" + MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL + "\n;" };
  const trustedModules = [legacyModule, v2Module];
  const legacySteps = [...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: [legacyModule.id] }];
  const steps = [...legacySteps, { version: 3, modules: [v2Module.id] }];

  it("installs actual V2 DDL as a new immutable version without touching the previous ledger", async () => {
    const f = fixture(), legacy = createPostgresBusinessSchemaPlan(legacySteps, { trustedModules });
    await f.install({ plan: legacy, trustedModules }); const prefix = structuredClone(f.state.history), length = f.statements.length;
    const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules });
    await expect(f.install({ plan, trustedModules })).resolves.toMatchObject({ appliedVersions: [3], fingerprint: plan.fingerprint });
    expect(f.state.history.slice(0, 2)).toEqual(prefix); expect(plan.migrations.slice(0, 2)).toEqual(legacy.migrations);
    expect(ddl(f.statements.slice(length))).toHaveLength(1);
    expect(ddl(f.statements.slice(length))[0]?.sql).toContain("CREATE TABLE migration_cutover_first_write_markers");
    expect(ddl(f.statements.slice(length))[0]?.sql).not.toMatch(/ALTER|DROP/);
  });

  it("rejects a rewritten installed V2 module even with recomputed plan fingerprints", async () => {
    const f = fixture(); await f.install({ plan: createPostgresBusinessSchemaPlan(steps, { trustedModules }), trustedModules });
    const changed = [legacyModule, { ...v2Module, sql: v2Module.sql.replace("marker_sha256 text", "marker_sha256 varchar") }];
    const length = f.statements.length;
    await expect(f.install({ plan: createPostgresBusinessSchemaPlan(steps, { trustedModules: changed }), trustedModules: changed })).rejects.toThrow("ordered fingerprint collision");
    expect(ddl(f.statements.slice(length))).toHaveLength(0); expect(f.state.history).toHaveLength(3);
  });

  it("refuses serialized V2 plans without separately supplied trusted definitions", async () => {
    const f = fixture(); const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules });
    await expect(f.install({ plan: JSON.parse(JSON.stringify(plan)) })).rejects.toThrow("unknown");
    expect(f.statements).toHaveLength(0);
  });

  it("rejects duplicate IDs, missing legacy dependencies and destructive upgrade definitions", () => {
    expect(() => createPostgresBusinessSchemaPlan(steps, { trustedModules: [...trustedModules, v2Module] })).toThrow();
    expect(() => createPostgresBusinessSchemaPlan([...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: [v2Module.id] }], { trustedModules })).toThrow();
    expect(() => createPostgresBusinessSchemaPlan(steps, { trustedModules: [legacyModule, { ...v2Module, sql: "ALTER TABLE migration_cutover_transitions ADD COLUMN protocol integer;" }] })).toThrow();
    const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules });
    const changed = [legacyModule, { ...v2Module, dependencies: [] }];
    expect(createPostgresBusinessSchemaPlan(steps, { trustedModules: changed }).fingerprint).not.toBe(plan.fingerprint);
  });

  it("rejects dependency/plan mismatch before acquiring a transaction", async () => {
    const f = fixture(); const plan = createPostgresBusinessSchemaPlan(steps, { trustedModules });
    await expect(f.install({ plan, trustedModules: [legacyModule, { ...v2Module, dependencies: [] }] })).rejects.toThrow("plan fingerprint mismatch");
    expect(f.statements).toHaveLength(0);
  });
});
