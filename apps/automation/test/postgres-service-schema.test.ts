import { generateKeyPairSync, sign } from "node:crypto";
import { authenticatePostgresBusinessNamespaceReceipt, postgresBusinessNamespaceReceiptSigningPayload, type PostgresBusinessProvisionedNamespaceReceipt } from "../../../packages/database/src/postgres-business-schema.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPostgresBusinessProvisioningPlan, postgresBusinessResourcePolicyFingerprint, POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES, type PostgresBusinessProvisioningOptions } from "../../../packages/database/src/postgres-business-provisioning.js";
import { MIGRATION_CUTOVER_TRANSITIONS_DDL, MIGRATION_CUTOVER_TRANSITIONS_V2_DDL, MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL, migrationCutoverProtocolV2Ddl, migrationCutoverTransitionsDdl } from "../../../packages/database/src/migration-cutover-coordinator.js";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresBusinessSchemaPlan, createPostgresUnitOfWork, installPostgresBusinessSchema, POSTGRES_BUSINESS_SCHEMA_PLAN, POSTGRES_BUSINESS_SCHEMA_MODULES,
  PostgresCommitUncertainError, type PostgresClient,
} from "@address-radar/database";
import { POSTGRES_WALLET_CHANNEL_SCHEMA_SQL } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL } from "../src/postgres-production-composition.js";
import { POSTGRES_SERVICE_FACT_SCHEMA_SQL } from "../src/postgres-service-fact-adapters.js";
import {
  POSTGRES_SERVICE_SCHEMA_PROTOCOL_V2_MODULES, createPostgresServiceSchema, installPostgresServiceSchema, createPostgresServiceSchemaGrantPlan, POSTGRES_SERVICE_SCHEMA_MODULES,
  type PostgresServiceSchemaInstallerOptions, type PostgresServiceSchemaGrantOptions,
} from "../src/postgres-service-schema.js";

const options: PostgresServiceSchemaInstallerOptions = {
  target: { database: "radar_business", username: "radar_migration", schema: "business_v1", generation: "generation-1", service: "migration" },
  approval: "approved-new-business-schema", approvalRef: "review/service-schema-v2",
};
const roles: PostgresServiceSchemaGrantOptions = { schema: "business_v1", migratorRole: "radar_migration", serviceRoles: {
  scanner: "radar_scanner", automation: "radar_automation", "wallet-monitor": "radar_wallet_monitor",
  "wallet-analysis": "radar_wallet_analysis", "historical-backfill": "radar_historical_backfill", console: "radar_console",
} };

// PostgreSQL catalog/transaction protocol fixture; this is not live database or ACL acceptance.
function fixture() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const releases: Array<Error | undefined> = [];
  let state = { namespace: false, objects: new Set<string>(), header: [] as Record<string, unknown>[], history: [] as Record<string, unknown>[] };
  let snapshot = structuredClone(state);
  let failure = "";
  const client: PostgresClient = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql === failure) throw new Error("injected schema failure");
      let rows: Record<string, unknown>[] = [];
      if (sql === "BEGIN") snapshot = structuredClone(state);
      else if (sql === "ROLLBACK") state = structuredClone(snapshot);
      else if (sql.includes("business-schema-installer-identity")) rows = [{ database: "radar_business", username: "radar_migration", session_username: "radar_migration", role_safe: true }];
      else if (sql.includes("business-schema-namespace")) rows = state.namespace ? [{ oid: 42, namespace_oid: "42", namespace_owner_oid: "64", namespace_owner: "radar_migration", database_oid: "32" }] : [];
      else if (sql.includes("business-schema-provisioned-cluster")) rows = [{ system_identifier: "7283888888", database_create: false, database_temp: false }];
      else if (sql.startsWith("CREATE SCHEMA")) state.namespace = true;
      else if (sql.includes("business-schema-presence")) rows = [{
        identity_exists: state.objects.has("business_schema_identity"), ledger_exists: state.objects.has("business_schema_ledger"),
        identity_valid: state.objects.has("business_schema_identity"), ledger_valid: state.objects.has("business_schema_ledger"),
      }];
      else if (sql.includes("business-schema-empty")) rows = state.objects.size ? [{ occupied: 1 }] : [];
      else if (sql.includes("business-schema-header")) rows = state.header;
      else if (sql.includes("business-schema-history")) rows = state.history;
      else if (sql.includes("business-schema-collisions")) rows = (values[1] as string[]).filter(name => state.objects.has(name)).map(relname => ({ relname }));
      else if (sql.startsWith('INSERT INTO "business_v1".business_schema_identity')) state.header.push({ singleton: true, ledger_format: 1,
        database_name: values[0], schema_name: values[1], generation_id: values[2] });
      else if (sql.startsWith('INSERT INTO "business_v1".business_schema_ledger')) state.history.push({ version: values[0], fingerprint: values[1],
        previous_fingerprint: values[2], modules_json: values[3] });
      else if (/^\s*CREATE TABLE/.test(sql)) for (const match of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+([a-z_][a-z0-9_]*)/g)) state.objects.add(match[1]!);
      return { rows, rowCount: rows.length };
    },
    release(error) { releases.push(error); },
  };
  const connect = vi.fn(async () => client);
  const work = createPostgresUnitOfWork({ connect }, { statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
  return { work, connect, statements, releases, state: () => state, fail(sql: string) { failure = sql; } };
}
const ddl = (statements: Array<{ sql: string }>) => statements.filter(entry => /^\s*CREATE\s/.test(entry.sql));

describe("reviewed PostgreSQL service schema", () => {
  it("binds the actual complete exported wallet/composition/fact adapter constants", () => {
    const definition = createPostgresServiceSchema();
    expect(definition.trustedModules.map(entry => [entry.id, entry.sql])).toEqual([
      ["wallet-channel", POSTGRES_WALLET_CHANNEL_SCHEMA_SQL],
      ["production-composition", POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL],
      ["service-fact-adapters", POSTGRES_SERVICE_FACT_SCHEMA_SQL],
      ["migration-cutover-transitions", MIGRATION_CUTOVER_TRANSITIONS_DDL],
    ]);
    expect(definition.supportTables).toHaveLength(17);
    for (const table of ["wallet_capture_generation_bindings", "wallet_forward_signal_wake_receipts", "wallet_forward_signal_wake_intents",
      "wallet_service_fact_inputs", "wallet_service_fact_attestations", "wallet_service_provider_budgets", "wallet_service_source_requests"]) {
      expect(definition.supportTables).toContain(table);
    }
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.trustedModules[0]?.dependencies)).toBe(true);
    expect(Object.isFrozen(definition.supportTables)).toBe(true);
  });

  it("appends only version two and preserves the exact approved version-one fingerprint", () => {
    const definition = createPostgresServiceSchema();
    expect(definition.plan.version).toBe(2);
    expect(definition.plan.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
    expect(definition.plan.migrations[0]?.fingerprint).toBe("9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22");
    expect(definition.plan.migrations[1]?.previousFingerprint).toBe(POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint);
    expect(definition.plan.migrations[1]?.modules).toEqual(["wallet-channel", "production-composition", "service-fact-adapters", "migration-cutover-transitions"]);
    expect(createPostgresServiceSchema()).toEqual(definition);
  });

  it("declares fixed ordered dependencies without database-to-app imports", () => {
    expect(POSTGRES_SERVICE_SCHEMA_MODULES.map(entry => entry.dependencies)).toEqual([
      ["forward-purchases", "capture-inbox"], ["wallet-channel", "signal"],
      ["forward-purchases", "wallet-channel", "target-authorization"], [],
    ]);
    const available = new Set(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]!.modules);
    for (const entry of POSTGRES_SERVICE_SCHEMA_MODULES) {
      expect(entry.dependencies.every(id => available.has(id))).toBe(true); available.add(entry.id);
    }
  });

  it("explicitly installs both ledger versions and all actual support tables under one UOW", async () => {
    const f = fixture();
    await expect(installPostgresServiceSchema(f.work, options)).resolves.toMatchObject({ version: 2, appliedVersions: [1, 2], status: "installed" });
    expect(f.state().history.map(row => row.version)).toEqual([1, 2]);
    expect(f.state().history[0]?.fingerprint).toBe(POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint);
    expect(f.state().history[1]?.fingerprint).toBe(createPostgresServiceSchema().plan.fingerprint);
    for (const table of createPostgresServiceSchema().supportTables) expect(f.state().objects.has(table)).toBe(true);
    expect(f.statements.at(-1)?.sql).toBe("COMMIT");
    expect(f.statements.filter(entry => entry.sql === "BEGIN")).toHaveLength(1);
    expect(f.statements.some(entry => /^\s*GRANT|^\s*ALTER ROLE/.test(entry.sql))).toBe(false);
  });

  it("upgrades an approved v1 without repeating its DDL or changing its ledger row", async () => {
    const f = fixture(); await installPostgresBusinessSchema(f.work, options);
    const before = structuredClone(f.state().history[0]); const length = f.statements.length;
    await expect(installPostgresServiceSchema(f.work, options)).resolves.toMatchObject({ appliedVersions: [2] });
    expect(f.state().history[0]).toEqual(before);
    expect(ddl(f.statements.slice(length))).toHaveLength(4);
    expect(f.statements.slice(length).some(entry => POSTGRES_BUSINESS_SCHEMA_MODULES.some(module => entry.sql === module.sql))).toBe(false);
  });

  it("reconciles an exact v2 retry without DDL or additional ledger writes", async () => {
    const f = fixture(); await installPostgresServiceSchema(f.work, options); const length = f.statements.length;
    await expect(installPostgresServiceSchema(f.work, options)).resolves.toMatchObject({ status: "already-installed", appliedVersions: [] });
    expect(ddl(f.statements.slice(length))).toHaveLength(0); expect(f.state().history).toHaveLength(2);
  });

  it("refuses pre-existing support objects instead of silently adopting them", async () => {
    const f = fixture(); await installPostgresBusinessSchema(f.work, options); f.state().objects.add("wallet_service_fact_inputs");
    await expect(installPostgresServiceSchema(f.work, options)).rejects.toThrow("module object collision");
    expect(f.state().history).toHaveLength(1); expect(f.state().objects.has("wallet_channel_collectors")).toBe(false);
  });

  it("rejects generation/header drift before applying support DDL", async () => {
    const f = fixture(); await installPostgresBusinessSchema(f.work, options); f.state().header[0]!.generation_id = "another-generation";
    const length = f.statements.length;
    await expect(installPostgresServiceSchema(f.work, options)).rejects.toThrow("identity or generation collision");
    expect(ddl(f.statements.slice(length))).toHaveLength(0);
  });

  it("rolls back both versions on a support DDL failure", async () => {
    const f = fixture();
    f.fail(POSTGRES_SERVICE_FACT_SCHEMA_SQL.trim().replace(/;\s*\n\s*/g, ";\n"));
    // Capture the exact normalized adapter DDL from a successful protocol run first.
    const reference = fixture(); await installPostgresServiceSchema(reference.work, options);
    const actual = reference.statements.find(entry => entry.sql.startsWith("CREATE TABLE wallet_service_import_ledger"))!.sql;
    f.fail(actual);
    await expect(installPostgresServiceSchema(f.work, options)).rejects.toThrow("injected schema failure");
    expect(f.state().namespace).toBe(false); expect(f.state().history).toHaveLength(0);
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("propagates commit uncertainty without replaying the installer", async () => {
    const f = fixture(); f.fail("COMMIT");
    await expect(installPostgresServiceSchema(f.work, options)).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.statements.filter(entry => entry.sql === "BEGIN")).toHaveLength(1);
    expect(f.releases[0]).toBeInstanceOf(PostgresCommitUncertainError);
  });

  it("cannot substitute manifest-supplied plans or DDL through the explicit installer helper", async () => {
    const f = fixture();
    const promise = installPostgresServiceSchema(f.work, { ...options, plan: POSTGRES_BUSINESS_SCHEMA_PLAN,
      trustedModules: [{ id: "manifest-evil", dependencies: [], sql: "DROP TABLE preserved_history;" }] } as PostgresServiceSchemaInstallerOptions);
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow("code-owned definitions");
    expect(f.state().history).toHaveLength(0);
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.statements.some(entry => entry.sql.includes("preserved_history"))).toBe(false);
  });

  it("creates only offline supplemental grants bound to the exact v2 fingerprint", () => {
    const grants = createPostgresServiceSchemaGrantPlan(roles);
    expect(grants).toMatchObject({ mode: "offline-supplemental-grants", automaticStartupExecution: false,
      requiresExistingRoleLockdown: true, schemaVersion: 2, schemaFingerprint: createPostgresServiceSchema().plan.fingerprint });
    expect(Object.isFrozen(grants.statements)).toBe(true);
    expect(grants.statements.every(sql => sql.startsWith("GRANT "))).toBe(true);
    expect(grants.statements.join("\n")).not.toMatch(/CREATE ROLE|CREATE DATABASE|ALTER ROLE|PASSWORD|ALL PRIVILEGES|TRUNCATE|REFERENCES|DELETE/);
  });

  it("grants console read access and never lets runtime roles mutate proof or schema ledgers", () => {
    const grants = createPostgresServiceSchemaGrantPlan(roles).statements;
    expect(grants[0]).toContain('"radar_console"');
    expect(grants[0]).toContain('"business_v1"."business_schema_ledger"');
    expect(grants[0]).toContain('"business_v1"."migration_cutover_transitions"');
    for (const role of Object.values(roles.serviceRoles)) expect(grants[0]).toContain(`"${role}"`);
    const mutations = grants.filter(sql => /^GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/.test(sql));
    expect(mutations.every(sql => !sql.includes('"radar_console"'))).toBe(true);
    for (const table of ["business_schema_identity", "business_schema_ledger", "wallet_service_import_ledger",
      "wallet_service_profile_cohort", "wallet_service_profile_versions", "wallet_service_fact_validators",
      "wallet_service_fact_inputs", "wallet_service_fact_attestations", "migration_cutover_transitions"]) {
      expect(mutations.some(sql => sql.includes(`"business_v1"."${table}"`))).toBe(false);
    }
  });

  it("allows only provider usage-counter column updates while preserving approved limits and provenance", () => {
    const grants = createPostgresServiceSchemaGrantPlan(roles).statements.filter(sql => sql.includes('ON TABLE "business_v1"."wallet_service_provider_budgets"'));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('GRANT UPDATE ("window_started_at", "requests_used", "cooldown_until")');
    expect(grants[0]).not.toMatch(/maximum_requests|maximum_concurrency|window_ms|origin|import_id|INSERT/);
  });

  it("requires explicit distinct six-service role identities and safe schema identifiers", () => {
    for (const value of [
      { ...roles, schema: "public" }, { ...roles, schema: "pg_catalog" }, { ...roles, schema: "business;DROP" },
      { ...roles, migratorRole: roles.serviceRoles.scanner },
      { ...roles, serviceRoles: { ...roles.serviceRoles, console: roles.serviceRoles.scanner } },
      { ...roles, serviceRoles: { scanner: "radar_scanner" } },
      { ...roles, serviceRoles: { ...roles.serviceRoles, automation: "address_radar_acceptance" } },
      { ...roles, serviceRoles: { ...roles.serviceRoles, unknown: "radar_unknown" } },
    ]) expect(() => createPostgresServiceSchemaGrantPlan(value as PostgresServiceSchemaGrantOptions)).toThrow();
  });
});


describe("cutover schema extension", () => {
  it("includes actual permanent cutover DDL in the v2 trusted registry and fingerprint", () => {
    const schema = createPostgresServiceSchema();
    const module = schema.trustedModules.find((entry) => entry.id === "migration-cutover-transitions");
    expect(module).toEqual({ id: "migration-cutover-transitions", dependencies: [], sql: MIGRATION_CUTOVER_TRANSITIONS_DDL });
    expect(schema.plan.migrations[1]?.modules).toContain("migration-cutover-transitions");
    expect(schema.supportTables).toContain("migration_cutover_transitions");
    expect(MIGRATION_CUTOVER_TRANSITIONS_DDL).toContain("CREATE TABLE migration_cutover_transitions");
    expect(MIGRATION_CUTOVER_TRANSITIONS_DDL).toContain("^[a-f0-9]{64}$");
    expect(MIGRATION_CUTOVER_TRANSITIONS_DDL).toContain("revision BETWEEN 1 AND 64");
    expect(migrationCutoverTransitionsDdl("business_v1")).toBe(MIGRATION_CUTOVER_TRANSITIONS_DDL.replace("CREATE TABLE migration_cutover_transitions", () => 'CREATE TABLE "business_v1"."migration_cutover_transitions"'));
    expect(() => migrationCutoverTransitionsDdl("public")).toThrow();
    expect(() => migrationCutoverTransitionsDdl("pg_catalog")).toThrow();
    expect(() => migrationCutoverTransitionsDdl('business_v1"; DROP TABLE x; --')).toThrow();
  });
});


it("fingerprints actual cutover DDL rather than hiding it as an import dependency", () => {
  const schema = createPostgresServiceSchema();
  const previousModules = schema.trustedModules.filter(entry => entry.id !== "migration-cutover-transitions");
  const previous = createPostgresBusinessSchemaPlan([
    ...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: previousModules.map(entry => entry.id) },
  ], { trustedModules: previousModules });
  expect(schema.plan.fingerprint).not.toBe(previous.fingerprint);
  const alteredModules = schema.trustedModules.map(entry => entry.id === "migration-cutover-transitions"
    ? { ...entry, sql: entry.sql.replace("revision BETWEEN 1 AND 64", () => "revision BETWEEN 1 AND 63") } : entry);
  const altered = createPostgresBusinessSchemaPlan(schema.plan.migrations, { trustedModules: alteredModules });
  expect(altered.fingerprint).not.toBe(schema.plan.fingerprint);
  expect(altered.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
});

it("rejects an existing cutover object without adopting it or partially upgrading v1", async () => {
  const f = fixture();
  await installPostgresBusinessSchema(f.work, options);
  f.state().objects.add("migration_cutover_transitions");
  await expect(installPostgresServiceSchema(f.work, options)).rejects.toThrow("module object collision");
  expect(f.state().history).toHaveLength(1);
  expect(f.state().objects.has("wallet_channel_collectors")).toBe(false);
  expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
});


it("grants only narrow live system-identity EXECUTE to all six service roles", () => {
  const statements = createPostgresServiceSchemaGrantPlan(roles).statements;
  const functions = statements.filter(sql => sql.startsWith("GRANT EXECUTE"));
  expect(functions).toHaveLength(1);
  expect(functions[0]).toMatch(/^GRANT EXECUTE ON FUNCTION pg_catalog\.pg_control_system\(\) TO /);
  for (const role of Object.values(roles.serviceRoles)) expect(functions[0]).toContain('"' + role + '"');
  expect(functions[0]).not.toContain('"radar_migration"');
  expect(statements.join("\n")).not.toMatch(/pg_monitor|ALL FUNCTIONS|ALL PRIVILEGES/);
});


it("binds the actual reviewed cooldown column without a silent migration default", () => {
  const column = POSTGRES_SERVICE_FACT_SCHEMA_SQL.match(/cooldown_until\s+bigint\s+NOT NULL\s+CHECK\s*\(\s*cooldown_until\s*>=\s*0\s*\)/i)?.[0];
  expect(column).toBeDefined();
  expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).not.toMatch(/cooldown_until\s+bigint[^,;\n]*DEFAULT/i);
});

interface RequiredSupportWrite {
  readonly table: string;
  readonly privilege: "INSERT" | "UPDATE";
  readonly columns: Set<string>;
}

// This is a source-query coverage check for the reviewed SQL forms, not a PostgreSQL ACL interpreter.
function assignmentColumns(sql: string): string[] {
  const fields: string[] = [];
  let depth = 0, start = 0, quote = "";
  for (let index = 0; index <= sql.length; index += 1) {
    const character = sql[index];
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth === 0 && (character === undefined || character === ";"
      || ((index === 0 || /\s/.test(sql[index - 1]!)) && /^(?:WHERE|FROM|RETURNING)\b/i.test(sql.slice(index))))) {
      fields.push(sql.slice(start, index));
      break;
    }
    if (character === "," && depth === 0) { fields.push(sql.slice(start, index)); start = index + 1; }
  }
  if (!fields.length || quote || depth !== 0) throw new Error("Unsupported reviewed runtime UPDATE expression");
  return fields.map(field => {
    const column = /^\s*([a-z_][a-z0-9_]*)\s*=/i.exec(field)?.[1];
    if (!column) throw new Error("Unsupported reviewed runtime UPDATE assignment");
    return column;
  });
}

interface RuntimeAstNode { readonly type: string; readonly [key: string]: unknown }
function runtimeAstNode(value: unknown): value is RuntimeAstNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function actualSupportWrites(): RequiredSupportWrite[] {
  // Reuse the existing Vitest/Vite parser dependency; TypeScript 7 no longer exposes a compiler AST API.
  const local = createRequire(import.meta.url);
  const vitest = createRequire(local.resolve("vitest/package.json"));
  const vite = createRequire(vitest.resolve("vite"));
  const parser = vite("rolldown/utils") as { parseSync(filename: string, source: string): { program: RuntimeAstNode; errors: readonly unknown[] } };
  const support = new Set(createPostgresServiceSchema().supportTables);
  const requirements = new Map<string, RequiredSupportWrite>();
  const add = (table: string, privilege: "INSERT" | "UPDATE", columns: string[]) => {
    if (!support.has(table)) return;
    if (!columns.length || columns.some(column => !/^[a-z_][a-z0-9_]*$/.test(column))) {
      throw new Error("Unsupported reviewed runtime write columns");
    }
    const key = table + "/" + privilege;
    const requirement = requirements.get(key) ?? { table, privilege, columns: new Set<string>() };
    for (const column of columns) requirement.columns.add(column);
    requirements.set(key, requirement);
  };
  for (const path of [
    new URL("../src/postgres-production-composition.ts", import.meta.url),
    new URL("../../wallet-monitor/src/postgres-wallet-channel.ts", import.meta.url),
    new URL("../src/postgres-service-fact-adapters.ts", import.meta.url),
  ]) {
    const source = parser.parseSync(path.pathname, readFileSync(path, "utf8"));
    expect(source.errors, path.pathname).toEqual([]);
    let queryCount = 0, forwardedQueries = 0, boundedPeakReadGuard = false;
    const visit = (node: RuntimeAstNode, enclosingFunction?: string): void => {
      const owner = node.type === "FunctionDeclaration" && runtimeAstNode(node.id) && typeof node.id.name === "string"
        ? node.id.name : enclosingFunction;
      if (owner === "boundPostgresOpportunityEvidence" && node.type === "CallExpression"
        && runtimeAstNode(node.callee) && node.callee.type === "MemberExpression"
        && runtimeAstNode(node.callee.object) && node.callee.object.name === "sql"
        && runtimeAstNode(node.callee.property) && node.callee.property.name === "startsWith"
        && Array.isArray(node.arguments) && runtimeAstNode(node.arguments[0])
        && node.arguments[0].value === "SELECT payload FROM forward_peak_evidence WHERE chain=") boundedPeakReadGuard = true;
      if (node.type === "CallExpression" && runtimeAstNode(node.callee) && node.callee.type === "MemberExpression"
        && runtimeAstNode(node.callee.property) && node.callee.property.name === "query") {
        queryCount += 1;
        const argument = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
        // This reviewed wrapper constructs no support DML: it forwards upstream SQL, or bounds one v1 SELECT.
        const passthrough = runtimeAstNode(argument) && argument.type === "Identifier" && argument.name === "sql";
        const limitedPeakRead = runtimeAstNode(argument) && argument.type === "TemplateLiteral"
          && Array.isArray(argument.expressions) && argument.expressions.length === 1
          && runtimeAstNode(argument.expressions[0]) && argument.expressions[0].type === "Identifier"
          && argument.expressions[0].name === "sql" && Array.isArray(argument.quasis) && argument.quasis.length === 2
          && runtimeAstNode(argument.quasis[0]) && runtimeAstNode(argument.quasis[1])
          && (argument.quasis[0].value as { cooked?: unknown }).cooked === ""
          && (argument.quasis[1].value as { cooked?: unknown }).cooked === " LIMIT $6";
        if (owner === "boundPostgresOpportunityEvidence" && (passthrough || limitedPeakRead)) { forwardedQueries += 1; return; }
        let literal: unknown;
        if (runtimeAstNode(argument) && argument.type === "Literal") literal = argument.value;
        else if (runtimeAstNode(argument) && argument.type === "TemplateLiteral"
          && Array.isArray(argument.expressions) && argument.expressions.length === 0
          && Array.isArray(argument.quasis) && argument.quasis.length === 1 && runtimeAstNode(argument.quasis[0])) {
          literal = (argument.quasis[0].value as { cooked?: unknown } | undefined)?.cooked;
        }
        if (typeof literal !== "string") throw new Error("Runtime query is not literal SQL; explicit grant review is required");
        const sql = literal.replace(/\/\*[\s\S]*?\*\//g, "");
        for (const insertion of sql.matchAll(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
          const table = insertion[1]!;
          add(table, "INSERT", insertion[2]!.split(",").map(column => column.trim()));
          if (support.has(table)) {
            const upsert = /\bDO\s+UPDATE\s+SET\s+([\s\S]*)/i.exec(sql.slice(insertion.index!));
            if (upsert) add(table, "UPDATE", assignmentColumns(upsert[1]!));
          }
        }
        for (const update of sql.matchAll(/\bUPDATE\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?\s+SET\s+/gi)) {
          if (support.has(update[1]!)) add(update[1]!, "UPDATE", assignmentColumns(sql.slice(update.index! + update[0].length)));
        }
        for (const deletion of sql.matchAll(/\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*)/gi)) {
          if (support.has(deletion[1]!)) throw new Error("Runtime support DELETE requires separate reviewed authority");
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const child of value) if (runtimeAstNode(child)) visit(child, owner); }
        else if (runtimeAstNode(value)) visit(value, owner);
      }
    };
    visit(source.program);
    expect(queryCount, path.pathname).toBeGreaterThan(0);
    expect(forwardedQueries, path.pathname).toBe(path.pathname.endsWith("postgres-production-composition.ts") ? 2 : 0);
    if (forwardedQueries) expect(boundedPeakReadGuard).toBe(true);
  }
  return [...requirements.values()];
}

function actualServiceProvisioning() {
  const definition = createPostgresServiceSchema();
  const resources: PostgresBusinessProvisioningOptions["resources"] = {
    pools: {
      scanner: { instances: 1, maximumConnections: 1 }, automation: { instances: 1, maximumConnections: 1 },
      "wallet-monitor": { instances: 1, maximumConnections: 1 }, "wallet-analysis": { instances: 1, maximumConnections: 1 },
      "historical-backfill": { instances: 1, maximumConnections: 1 }, console: { instances: 1, maximumConnections: 1 },
    },
    serverMaximumConnections: 32, postgresReservedConnections: 5, otherHostConnections: 1,
    migrationConnections: 1, operatorConnections: 1, backupConnections: 1,
    maximumPendingOperations: 4, connectionTimeoutMs: 1_000, idleTimeoutMs: 10_000,
    statementTimeoutMs: 5_000, lockTimeoutMs: 1_000, idleTransactionTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000, workMemKb: 1_024, maximumMeasurementAgeMs: 1_800_000,
  };
  // Synthetic resource measurements authorize only offline planning in this test, not production readiness.
  return createPostgresBusinessProvisioningPlan({
    database: options.target.database, schema: roles.schema, generation: options.target.generation,
    migratorRole: roles.migratorRole, serviceRoles: roles.serviceRoles, resources, now: "2026-10-04T04:00:00.000Z",
    schemaPlan: definition.plan, trustedModules: definition.trustedModules,
    capacity: { status: "measured", hostId: "isolated-host", measurementRef: "isolated-pressure/source-query-fixture",
      resourcePolicyFingerprint: postgresBusinessResourcePolicyFingerprint(resources),
      measuredAt: "2026-10-04T03:50:00.000Z", validUntil: "2026-10-04T04:10:00.000Z",
      availableRamBytes: "1000000000", measuredPeakRamBytes: "600000000", ramMarginBytes: "200000000",
      availableDiskBytes: "10000000000", measuredPeakDiskBytes: "4000000000",
      measuredPeakWalBytes: "1000000000", measuredPeakTempBytes: "500000000", diskMarginBytes: "2000000000" },
  });
}

it("production provisioning covers every actual support INSERT, UPDATE and upsert for all approved writer roles", () => {
  const requirements = actualSupportWrites();
  expect(requirements).toHaveLength(14);
  expect([...new Set(requirements.map(requirement => requirement.table))].sort()).toEqual([
    "wallet_channel_collectors", "wallet_capture_generation_bindings", "wallet_forward_signal_jobs",
    "wallet_forward_signal_wake_receipts", "wallet_forward_signal_wake_intents", "wallet_service_price_leases",
    "wallet_service_price_consumption", "wallet_service_provider_budgets", "wallet_service_provider_leases",
    "wallet_service_source_requests",
  ].sort());
  const plan = actualServiceProvisioning();
  const statements = plan.phases.find(phase => phase.id === "post-schema-grants")!.statements;
  const columnGrants = statements.flatMap(sql => {
    const match = /^GRANT (INSERT|UPDATE) \(([^)]+)\) ON TABLE "([^"]+)"\."([^"]+)" TO (.+);$/.exec(sql);
    return match ? [{ privilege: match[1], table: match[4],
      columns: new Set([...match[2]!.matchAll(/"([^"]+)"/g)].map(column => column[1])),
      roles: new Set([...match[5]!.matchAll(/"([^"]+)"/g)].map(role => role[1])) }] : [];
  });
  for (const requirement of requirements) {
    expect(POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES, requirement.table).not.toContain(requirement.table);
    expect(plan.runtimeWritableTables, requirement.table).not.toContain(requirement.table);
    const grant = columnGrants.find(grant => grant.table === requirement.table && grant.privilege === requirement.privilege);
    expect(grant, requirement.table + "/" + requirement.privilege).toBeDefined();
    if (!grant) throw new Error("Actual support write has no production column grant");
    for (const column of requirement.columns) expect(grant.columns, requirement.table + "/" + column).toContain(column);
    for (const role of plan.roles.filter(role => role.access === "runtime")) {
      expect(grant.roles, requirement.table + "/" + role.service).toContain(role.name);
    }
    expect(grant.roles).not.toContain(roles.serviceRoles.console);
    expect(grant.roles).not.toContain(roles.migratorRole);
  }
  for (const table of POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES) {
    expect(columnGrants.some(grant => grant.table === table), table).toBe(false);
  }
  expect(statements.filter(sql => /^GRANT /.test(sql)).join("\n")).not.toMatch(/ALL TABLES|ALL PRIVILEGES/);
});


it("captures every SET column after nested CASE/subqueries and function commas", () => {
  expect(assignmentColumns("status=CASE WHEN EXISTS(SELECT 1 FROM x WHERE id=$1) THEN 'pending' ELSE 'idle' END, reason_code=$2, cooldown_until=GREATEST(cooldown_until,$3::bigint) WHERE generation_id=$4"))
    .toEqual(["status", "reason_code", "cooldown_until"]);
});


// Catalog protocol evidence only: no real PostgreSQL, provisioning or activation.
const protocolV2 = { protocolVersion: 2 } as const;
function signedServiceNamespace(plan = createPostgresServiceSchema(protocolV2).plan) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const receipt: PostgresBusinessProvisionedNamespaceReceipt = {
    version: 1, purpose: "provisioned-empty-business-namespace", receiptId: "fixture/service-v3", signerKeyId: "fixture/independent-authority",
    approvalRef: options.approvalRef, database: options.target.database, databaseOid: "32", schema: options.target.schema,
    namespaceOid: "42", owner: options.target.username, ownerOid: "64", generation: options.target.generation, service: "migration",
    schemaVersion: plan.version, schemaFingerprint: plan.fingerprint, systemIdentifier: "7283888888", issuedAt: 1_000, expiresAt: 61_000,
  };
  return authenticatePostgresBusinessNamespaceReceipt({ receipt,
    signatureBase64: sign(null, Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(receipt)), privateKey).toString("base64") },
  { signerKeyId: receipt.signerKeyId, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(), maximumReceiptAgeMs: 60_000, clock: () => 1_000 });
}

describe("explicit protocol V2 physical schema three", () => {
  it("keeps immutable v1/v2 prefixes and binds the actual V2 exports and dependencies", () => {
    const legacy = createPostgresServiceSchema(), selected = createPostgresServiceSchema(protocolV2);
    expect(legacy.plan.fingerprint).toBe("cecbd7d9218d0a91022c221d1086244fcb5e91cb5de8ac2639e7378c19070ea6");
    expect(selected.plan.version).toBe(3);
    expect(selected.plan.fingerprint).toBe("b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383");
    expect(selected.plan.migrations.slice(0, 2)).toEqual(legacy.plan.migrations);
    expect(selected.plan.migrations[2]?.previousFingerprint).toBe(legacy.plan.fingerprint);
    expect(selected.trustedModules.slice(0, 4)).toEqual(POSTGRES_SERVICE_SCHEMA_MODULES);
    expect(selected.trustedModules.at(-1)).toEqual({ id: "migration-cutover-protocol-v2", dependencies: ["migration-cutover-transitions"],
      sql: MIGRATION_CUTOVER_TRANSITIONS_V2_DDL + "\n;\n" + MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL + "\n;" });
    expect(selected.supportTables).toHaveLength(19);
    expect(selected.supportTables.slice(0, 17)).toEqual(legacy.supportTables);
    expect(createPostgresBusinessSchemaPlan(selected.plan.migrations, { trustedModules: selected.trustedModules })).toEqual(selected.plan);
    process.stdout.write("TRUSTED_SERVICE_SCHEMA_V3_FINGERPRINT=" + selected.plan.fingerprint + "\n");
  });

  it("qualifies both permanent tables and the native-marker foreign key without rewriting legacy DDL", () => {
    const [ledger, marker] = migrationCutoverProtocolV2Ddl("business_v1");
    expect(ledger).toContain('CREATE TABLE "business_v1".migration_cutover_transitions_v2');
    expect(marker).toContain('REFERENCES "business_v1".migration_cutover_transitions_v2');
    for (const sql of [ledger, marker]) {
      expect(sql).toContain("COALESCE("); expect(sql).toContain("false))");
      expect(sql).not.toMatch(/\b(?:ALTER|DROP|GRANT|TEMP|UNLOGGED)\b/);
    }
    expect(ledger).toContain("state->'version'='2'::jsonb");
    expect(marker).toContain("marker->'version'='2'::jsonb");
    expect(marker).toContain("marker->>'sourceKey'=source_key");
    expect(MIGRATION_CUTOVER_TRANSITIONS_DDL).not.toContain("migration_cutover_first_write_markers");
  });

  it.each([{}, { protocolVersion: 1 }, { protocolVersion: 3 }, { protocolVersion: 2, sql: "DROP TABLE old" },
    { protocolVersion: 2, trustedModules: [] }, Object.create({ protocolVersion: 2 })])("refuses non-explicit or manifest-based factory selection %j", value => {
    expect(() => createPostgresServiceSchema(value as typeof protocolV2)).toThrow();
  });

  it("rejects inherited protocol selection in installer and grant helper before acquisition", async () => {
    const f = fixture(); const inherited = Object.assign(Object.create(protocolV2), options) as PostgresServiceSchemaInstallerOptions;
    await expect(installPostgresServiceSchema(f.work, inherited)).rejects.toThrow("Inherited protocol selection");
    expect(f.connect).not.toHaveBeenCalled();
    expect(() => createPostgresServiceSchemaGrantPlan(Object.assign(Object.create(protocolV2), roles))).toThrow("Inherited protocol selection");
  });

  it("installs all 79 code-owned tables with exact signed preprovisioned scope and no CREATE SCHEMA", async () => {
    const f = fixture(); f.state().namespace = true;
    const definition = createPostgresServiceSchema(protocolV2);
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2, approval: "approved-provisioned-business-schema",
      provisionedNamespaceApproval: signedServiceNamespace() })).resolves.toMatchObject({ version: 3, fingerprint: definition.plan.fingerprint, appliedVersions: [1, 2, 3] });
    expect(f.state().history.map(row => row.fingerprint)).toEqual(definition.plan.migrations.map(step => step.fingerprint));
    const tables = f.statements.flatMap(entry => [...entry.sql.matchAll(/CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)/g)].map(match => match[1]));
    const moduleTables = [...POSTGRES_BUSINESS_SCHEMA_MODULES, ...definition.trustedModules].flatMap(module =>
      [...module.sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/g)].map(match => match[1]));
    expect(tables).toEqual(["business_schema_identity", "business_schema_ledger", ...moduleTables]);
    expect(tables).toHaveLength(79); expect(new Set(tables).size).toBe(79);
    expect(f.statements.some(entry => /CREATE SCHEMA|^GRANT|^ALTER/.test(entry.sql))).toBe(false);
    expect(f.statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("does not reuse a signed physical v2 bootstrap receipt for physical v3", async () => {
    const f = fixture(); f.state().namespace = true;
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2, approval: "approved-provisioned-business-schema",
      provisionedNamespaceApproval: signedServiceNamespace(createPostgresServiceSchema().plan) })).rejects.toThrow("exact installation scope");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("appends only V2 tables to an explicitly approved v2 ledger, retries exactly, and refuses implicit downgrade", async () => {
    const f = fixture(); await installPostgresServiceSchema(f.work, options);
    const prefix = structuredClone(f.state().history), length = f.statements.length;
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2 })).resolves.toMatchObject({ appliedVersions: [3] });
    expect(f.state().history.slice(0, 2)).toEqual(prefix);
    const applied = ddl(f.statements.slice(length)); expect(applied).toHaveLength(1);
    expect(applied[0]?.sql.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(applied[0]?.sql).not.toMatch(/ALTER|DROP|CREATE TABLE migration_cutover_transitions \(/);
    const after = f.statements.length;
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2 })).resolves.toMatchObject({ appliedVersions: [], status: "already-installed" });
    expect(ddl(f.statements.slice(after))).toHaveLength(0);
    await expect(installPostgresServiceSchema(f.work, options)).rejects.toThrow();
  });

  it.each(["migration_cutover_transitions_v2", "migration_cutover_first_write_markers"])("refuses occupied V2 object %s", async table => {
    const f = fixture(); await installPostgresServiceSchema(f.work, options); f.state().objects.add(table);
    const length = f.statements.length;
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2 })).rejects.toThrow("module object collision");
    expect(f.state().history).toHaveLength(2); expect(ddl(f.statements.slice(length))).toHaveLength(0);
  });

  it("rolls back a V2 DDL failure without rewriting the old prefix", async () => {
    const reference = fixture(); await installPostgresServiceSchema(reference.work, { ...options, ...protocolV2 });
    const f = fixture(); await installPostgresServiceSchema(f.work, options); const prefix = structuredClone(f.state().history);
    f.fail(reference.statements.find(entry => entry.sql.startsWith("CREATE TABLE migration_cutover_transitions_v2"))!.sql);
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2 })).rejects.toThrow("injected schema failure");
    expect(f.state().history).toEqual(prefix); expect(f.state().objects.has("migration_cutover_transitions_v2")).toBe(false);
    expect(f.statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("reports physical commit uncertainty without automatic V2 replay", async () => {
    const f = fixture(); f.fail("COMMIT");
    await expect(installPostgresServiceSchema(f.work, { ...options, ...protocolV2 })).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.statements.filter(entry => entry.sql === "BEGIN")).toHaveLength(1);
    expect(f.releases[0]).toBeInstanceOf(PostgresCommitUncertainError);
  });

  it("grants only SELECT on new authority tables and keeps all legacy mutation grants unchanged", () => {
    const legacy = createPostgresServiceSchemaGrantPlan(roles), selected = createPostgresServiceSchemaGrantPlan({ ...roles, ...protocolV2 });
    expect(selected.schemaVersion).toBe(3); expect(selected.schemaFingerprint).toBe(createPostgresServiceSchema(protocolV2).plan.fingerprint);
    expect(selected.statements.slice(1)).toEqual(legacy.statements.slice(1));
    for (const table of ["migration_cutover_transitions_v2", "migration_cutover_first_write_markers"]) {
      expect(selected.statements.filter(sql => sql.includes('"' + table + '"'))).toHaveLength(1);
      expect(selected.statements[0]).toContain('"' + table + '"');
    }
    for (const role of Object.values(roles.serviceRoles)) expect(selected.statements[0]).toContain('"' + role + '"');
    expect(selected.statements[0]).toMatch(/^GRANT SELECT ON TABLE/);
  });
});
