import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL, POSTGRES_BUSINESS_SCHEMA_MODULES } from "../../packages/database/src/postgres-business-schema.js";

import { createPostgresServiceSchema } from "../../apps/automation/src/postgres-service-schema.js";

// Explicitly opt in: this creates only session-local test tables and rolls back.
const enabled = process.env.ADDRESS_RADAR_RUN_SSH_POSTGRES_REHEARSAL === "1";
describe.skipIf(!enabled)("real isolated PostgreSQL migration SQL rehearsal", () => {
  it("demonstrates column-only and non-inherited SET-role write permissions without retaining changes", () => {
    const role = "radar_acl_rehearsal_" + randomBytes(6).toString("hex");
    const sql = `BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s';
CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE TEMP TABLE migration_acl_rehearsal(generation_id text);
GRANT SELECT, UPDATE(generation_id) ON migration_acl_rehearsal TO address_radar_acceptance;
GRANT UPDATE(generation_id) ON migration_acl_rehearsal TO ${role};
GRANT ${role} TO address_radar_acceptance WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE address_radar_acceptance;
SELECT json_build_object('tableUpdate',has_table_privilege(current_user,'migration_acl_rehearsal','UPDATE'),
  'columnUpdate',has_any_column_privilege(current_user,'migration_acl_rehearsal','UPDATE'),
  'setReachable',pg_has_role(current_user,'${role}','SET'),
  'reachableColumnUpdate',has_any_column_privilege('${role}','migration_acl_rehearsal','UPDATE'));
ROLLBACK;`;
    const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "ubuntu@152.32.185.240",
      "sudo -n -u postgres psql -X -p 5433 -d address_radar_acceptance_test -At -v ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.split("\n").find(line => line.startsWith("{")) ?? "null"))
      .toEqual({ tableUpdate: false, columnUpdate: true, setReachable: true, reachableColumnUpdate: true });
    expect(result.stdout.trim().endsWith("ROLLBACK")).toBe(true);
  }, 35_000);
  it("accepts the full ordered business DDL in a restricted temporary namespace", () => {
    const ddl = [POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL, ...POSTGRES_BUSINESS_SCHEMA_MODULES.map(module => module.sql)]
      .join("\n").replace(/CREATE TABLE\b/g, "CREATE TEMP TABLE");
    const sql = `BEGIN;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL work_mem='2MB';
SET LOCAL ROLE address_radar_acceptance; SET LOCAL search_path=pg_temp;
${ddl}
SELECT json_build_object('temporaryTables',(SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relkind='r'),
  'permanentApplicationTables',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relpersistence='p' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'));
ROLLBACK;
`;
    const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "ubuntu@152.32.185.240",
      "sudo -n -u postgres psql -X -p 5433 -d address_radar_acceptance_test -At -v ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.split("\n").find(line => line.startsWith("{")) ?? "null");
    expect(receipt).not.toBeNull(); expect(receipt.temporaryTables).toBeGreaterThan(20);
    expect(receipt.permanentApplicationTables).toBe(0);
    expect(result.stdout.trim().endsWith("ROLLBACK")).toBe(true);
  }, 35_000);
});

interface TemporaryColumnShape {
  readonly table: string;
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly default: string | null;
}

// Split trusted table definitions without mistaking CHECK/default expression commas for columns.
function trustedTableFields(sql: string, bodyStart: number): string[] {
  const fields: string[] = [];
  let depth = 1;
  let start = bodyStart;
  let quote = "";
  for (let index = bodyStart; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else quote = "";
      }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline < 0) throw new Error("Unterminated trusted table definition");
      index = newline;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated trusted DDL comment");
      index = end + 1;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) { fields.push(sql.slice(start, index)); return fields; }
    } else if (character === "," && depth === 1) {
      fields.push(sql.slice(start, index));
      start = index + 1;
    }
  }
  throw new Error("Unterminated trusted table definition");
}

function trustedSupportColumnShapes(modules: readonly { readonly sql: string }[]): Map<string, Array<{ name: string; type: string }>> {
  const tables = new Map<string, Array<{ name: string; type: string }>>();
  for (const module of modules) for (const header of module.sql.matchAll(/\bCREATE\s+TABLE\s+([a-z_][a-z0-9_]*)\s*\(/g)) {
    const fields = trustedTableFields(module.sql, header.index! + header[0].length);
    const columns: Array<{ name: string; type: string }> = [];
    for (const field of fields) {
      const declaration = field.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").trim();
      if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE)\b/i.test(declaration)) continue;
      const column = /^([a-z_][a-z0-9_]*)\s+(text|bigint|integer|boolean|jsonb|numeric(?:\s*\(\s*\d+\s*,\s*\d+\s*\))?)\b/i.exec(declaration);
      if (!column) throw new Error("Unsupported reviewed support column shape");
      columns.push({ name: column[1]!, type: column[2]!.toLowerCase().replace(/\s+/g, "") });
    }
    if (!columns.length || tables.has(header[1]!)) throw new Error("Missing or duplicate reviewed support table");
    tables.set(header[1]!, columns);
  }
  return tables;
}

describe.skipIf(!enabled)("real restricted PostgreSQL version-two TEMP/ROLLBACK rehearsal", () => {
  it("accepts the full ordered version-two service DDL and verifies actual auxiliary column shapes", () => {
    const definition = createPostgresServiceSchema();
    const registry = new Map([...POSTGRES_BUSINESS_SCHEMA_MODULES, ...definition.trustedModules]
      .map(module => [module.id, module.sql] as const));
    const orderedIds = definition.plan.migrations.flatMap(migration => migration.modules);
    expect(orderedIds).toEqual([...POSTGRES_BUSINESS_SCHEMA_MODULES.map(module => module.id),
      ...definition.trustedModules.map(module => module.id)]);
    expect(definition.plan.migrations[0]?.fingerprint)
      .toBe("9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22");
    expect(definition.plan.version).toBe(2);
    const orderedSql = orderedIds.map(id => {
      const sql = registry.get(id);
      if (!sql) throw new Error("Version-two plan references an unregistered trusted module");
      return sql;
    });
    const ddl = [POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL, ...orderedSql]
      .map(sql => sql + "\n;").join("\n")
      .replace(/\bCREATE TABLE\b/g, "CREATE TEMP TABLE");
    const tableNames = [...ddl.matchAll(/\bCREATE TEMP TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/g)]
      .map(match => match[1]!);
    expect(new Set(tableNames).size).toBe(tableNames.length);
    const expectedColumns = trustedSupportColumnShapes(definition.trustedModules);
    expect([...expectedColumns.keys()].sort()).toEqual([...definition.supportTables].sort());
    expect(expectedColumns.size).toBe(17);
    // The selected runner never creates roles, grants privileges, installs a permanent schema or writes business rows.
    const sql = `BEGIN;
SET LOCAL ROLE address_radar_acceptance;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'; SET LOCAL work_mem='2MB';
SET LOCAL search_path=pg_catalog,pg_temp;
${ddl}
SELECT json_build_object(
  'role',current_user,'database',current_database(),'port',current_setting('port')::integer,
  'tables',(SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_catalog.pg_class c
    WHERE c.relnamespace=pg_catalog.pg_my_temp_schema() AND c.relkind='r' AND c.relpersistence='t'),
  'nonTemporaryRelations',(SELECT count(*) FROM pg_catalog.pg_class c
    WHERE c.relnamespace=pg_catalog.pg_my_temp_schema() AND c.relpersistence<>'t'),
  'permanentApplicationTables',(SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relpersistence='p'
      AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'),
  'columns',(SELECT json_agg(json_build_object('table',c.relname,'name',a.attname,
    'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
    'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.relnamespace=pg_catalog.pg_my_temp_schema() AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT json_agg(json_build_object('table',c.relname,'definition',pg_catalog.pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    WHERE c.relnamespace=pg_catalog.pg_my_temp_schema()
      AND c.relname IN ('wallet_service_provider_budgets','migration_cutover_transitions')));
ROLLBACK;
`;
    const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "ubuntu@152.32.185.240",
      "sudo -n -u postgres psql -X -p 5433 -d address_radar_acceptance_test -At -v ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout.split("\n").find(line => line.startsWith("{")) ?? "null") as {
      role: string; database: string; port: number; tables: string[]; nonTemporaryRelations: number;
      permanentApplicationTables: number; columns: TemporaryColumnShape[];
      constraints: Array<{ table: string; definition: string }>;
    } | null;
    expect(receipt).not.toBeNull();
    if (!receipt) throw new Error("Missing TEMP rehearsal receipt");
    expect(receipt.role).toBe("address_radar_acceptance");
    expect(receipt.database).toBe("address_radar_acceptance_test");
    expect(receipt.port).toBe(5433);
    expect(receipt.tables).toEqual([...tableNames].sort());
    expect(receipt.nonTemporaryRelations).toBe(0);
    expect(receipt.permanentApplicationTables).toBe(0);
    for (const [table, columns] of expectedColumns) {
      const actual = receipt.columns.filter(column => column.table === table);
      expect(actual.map(({ name, type }) => ({ name, type })), table).toEqual(columns);
    }
    const cooldown = receipt.columns.find(column => column.table === "wallet_service_provider_budgets" && column.name === "cooldown_until");
    expect(cooldown).toMatchObject({ type: "bigint", notNull: true, default: null });
    const budgetChecks = receipt.constraints.filter(constraint => constraint.table === "wallet_service_provider_budgets")
      .map(constraint => constraint.definition).join("\n");
    expect(budgetChecks).toMatch(/cooldown_until\s*>=\s*0/);
    expect(receipt.columns.filter(column => column.table === "migration_cutover_transitions")
      .map(({ name, type, notNull, default: defaultValue }) => ({ name, type, notNull, default: defaultValue }))).toEqual([
      { name: "source_key", type: "text", notNull: true, default: null },
      { name: "revision", type: "bigint", notNull: true, default: null },
      { name: "state", type: "jsonb", notNull: true, default: null },
    ]);
    const cutoverChecks = receipt.constraints.filter(constraint => constraint.table === "migration_cutover_transitions")
      .map(constraint => constraint.definition).join("\n");
    expect(cutoverChecks).toContain("^[a-f0-9]{64}$");
    expect(cutoverChecks).toMatch(/revision\s*>=\s*1/);
    expect(cutoverChecks).toMatch(/revision\s*<=\s*64/);
    for (const key of ["version", "revision", "phase", "binding", "policySha256", "planSha256", "activationEnabled",
      "preparation", "snapshotTables", "firstPostgresWrite", "journal", "false", "array"]) expect(cutoverChecks).toContain(key);
    expect(result.stdout.trim().endsWith("ROLLBACK")).toBe(true);
  }, 35_000);
});
