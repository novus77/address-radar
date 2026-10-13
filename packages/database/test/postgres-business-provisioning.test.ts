import { POSTGRES_SERVICE_FACT_SCHEMA_SQL } from "../../../apps/automation/src/postgres-service-fact-adapters.js";
import { POSTGRES_WALLET_CHANNEL_SCHEMA_SQL } from "../../../apps/wallet-monitor/src/postgres-wallet-channel.js";
import { POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES, POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY } from "../src/postgres-business-provisioning.js";
import { POSTGRES_BUSINESS_SERVICES as DISPATCH_SERVICES } from "../src/postgres-service-dispatch.js";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_BUSINESS_SCHEMA_PLAN, createPostgresBusinessSchemaPlan } from "../src/postgres-business-schema.js";
import {
  createPostgresBusinessProvisioningPlan, postgresBusinessResourcePolicyFingerprint,
  POSTGRES_BUSINESS_SERVICES, type PostgresBusinessProvisioningOptions,
} from "../src/postgres-business-provisioning.js";

vi.mock("pg", async importOriginal => ({ ...(await importOriginal<typeof import("pg")>()), Pool: class {
  constructor() { throw new Error("Offline planning must not open PostgreSQL connections"); }
} }));

function fixture(): PostgresBusinessProvisioningOptions {
  const resources = {
    pools: {
      scanner: { instances: 2, maximumConnections: 3 },
      automation: { instances: 1, maximumConnections: 3 },
      "wallet-monitor": { instances: 2, maximumConnections: 2 },
      "wallet-analysis": { instances: 1, maximumConnections: 2 },
      "historical-backfill": { instances: 1, maximumConnections: 2 },
      console: { instances: 1, maximumConnections: 1 },
    },
    serverMaximumConnections: 64, postgresReservedConnections: 5, otherHostConnections: 3,
    migrationConnections: 2, operatorConnections: 2, backupConnections: 2,
    maximumPendingOperations: 4, connectionTimeoutMs: 1_000, idleTimeoutMs: 10_000,
    statementTimeoutMs: 5_000, lockTimeoutMs: 1_000, idleTransactionTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000, workMemKb: 1_024, maximumMeasurementAgeMs: 1_800_000,
  };
  return {
    database: "radar_business", schema: "business_v1", generation: "generation-1",
    migratorRole: "radar_migrator",
    serviceRoles: { scanner: "radar_scanner", automation: "radar_automation",
      "wallet-monitor": "radar_monitor", "wallet-analysis": "radar_analysis",
      "historical-backfill": "radar_backfill", console: "radar_console" },
    resources, now: "2026-10-04T04:00:00.000Z",
    capacity: { status: "measured", hostId: "isolated-host", measurementRef: "isolated-pressure/fixture-1",
      resourcePolicyFingerprint: postgresBusinessResourcePolicyFingerprint(resources),
      measuredAt: "2026-10-04T03:50:00.000Z", validUntil: "2026-10-04T04:10:00.000Z",
      availableRamBytes: "1000000000", measuredPeakRamBytes: "600000000", ramMarginBytes: "200000000",
      availableDiskBytes: "10000000000", measuredPeakDiskBytes: "4000000000",
      measuredPeakWalBytes: "1000000000", measuredPeakTempBytes: "500000000", diskMarginBytes: "2000000000" },
  };
}
const sql = (plan: ReturnType<typeof createPostgresBusinessProvisioningPlan>): string[] =>
  plan.phases.flatMap(phase => phase.statements);
const changed = (input: unknown) => input as PostgresBusinessProvisioningOptions;
const refusal = (input: unknown) => expect(() => createPostgresBusinessProvisioningPlan(changed(input))).toThrow();

describe("offline PostgreSQL business provisioning", () => {
  it("creates a secret-free review plan without connecting or claiming readiness", () => {
    const input = fixture(); const before = JSON.stringify(input);
    const plan = createPostgresBusinessProvisioningPlan(input);
    expect(plan.mode).toBe("offline-sql-plan");
    expect(plan.productionMigrationReady).toBe(false);
    expect(plan.proofs).toEqual({ isolatedPermissions: "unknown", liveCapacity: "unknown", credentialProvisioning: "unknown" });
    expect(plan.credentials).toMatchObject({ mandatory: true, delivery: "external-private", passwordsEmbedded: false });
    expect(plan.credentials.roles).toHaveLength(7);
    expect(sql(plan).join("\n")).not.toMatch(/PASSWORD|CREATE TABLE|DROP|TRUNCATE/);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(plan.phases[0]?.statements)).toBe(true);
  });

  it("uses seven distinct fresh NOLOGIN roles and a dedicated template0 database", () => {
    const plan = createPostgresBusinessProvisioningPlan(fixture());
    const statements = sql(plan); const creates = statements.filter(line => line.startsWith("CREATE ROLE"));
    expect(creates).toHaveLength(7);
    for (const statement of creates) {
      expect(statement).toContain("NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    }
    expect(statements.find(line => line.startsWith("CREATE DATABASE"))).toBe(
      'CREATE DATABASE "radar_business" OWNER "radar_migrator" TEMPLATE template0 CONNECTION LIMIT 24;');
    expect(plan.phases.find(phase => phase.id === "cluster-database")?.transactional).toBe(false);
    expect(statements.some(line => /IF NOT EXISTS|GRANT "radar_migrator"/.test(line))).toBe(false);
  });

  it("preserves the typed schema fingerprint and leaves creation to the explicit installer", () => {
    const plan = createPostgresBusinessProvisioningPlan(fixture());
    expect(plan.schemaInstallation.plan).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN);
    expect(plan.schemaInstallation).toMatchObject({
      executorRole: "radar_migrator", requiresAbsentNamespace: true, automaticStartupExecution: false,
    });
    expect(sql(plan).some(line => line.startsWith("CREATE SCHEMA"))).toBe(false);
    const partial = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["capture-inbox"] }]);
    const subset = createPostgresBusinessProvisioningPlan({ ...fixture(), schemaPlan: partial });
    expect(subset.schemaInstallation.plan.fingerprint).toBe(partial.fingerprint);
    expect(subset.businessTables).toContain("capture_raw_payloads");
    expect(subset.businessTables).not.toContain("forward_purchase_samples");
    refusal({ ...fixture(), schemaPlan: { ...partial, fingerprint: "a".repeat(64) } });
  });

  it("revokes PUBLIC CREATE/TEMP and role memberships and grants only named active tables", () => {
    const plan = createPostgresBusinessProvisioningPlan(fixture()); const statements = sql(plan);
    expect(statements).toContain('REVOKE ALL PRIVILEGES ON DATABASE "radar_business" FROM PUBLIC;');
    expect(statements.some(line => line.startsWith('REVOKE CREATE, TEMPORARY ON DATABASE "radar_business" FROM PUBLIC,'))).toBe(true);
    expect(statements.some(line => line.startsWith('REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC,'))).toBe(true);
    expect(statements.some(line => line.startsWith('REVOKE "radar_migrator" FROM '))).toBe(true);
    const writes = statements.filter(line => line.startsWith("GRANT INSERT, UPDATE, DELETE"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("business_schema_identity");
    expect(writes[0]).not.toContain("business_schema_ledger");
    expect(writes[0]).not.toContain("radar_console");
    expect(writes[0]).toContain('"business_v1"."capture_event_identities"');
    expect(statements.filter(line => line.startsWith("GRANT ")).join("\n")).not.toMatch(/ALL TABLES|GRANT CREATE|GRANT .*SEQUENCES|GRANT .*REFERENCES|GRANT .*TRIGGER/);
    expect(statements.some(line => line.includes("ALTER DEFAULT PRIVILEGES") && line.includes("REVOKE ALL PRIVILEGES ON TABLES"))).toBe(true);
    expect(statements.some(line => line.includes("REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"))).toBe(true);
    expect(statements).toContain('ALTER ROLE "radar_console" IN DATABASE "radar_business" SET default_transaction_read_only = on;');
  });

  it("denies archive reads by default and permits only explicit prefix-matching SELECT grants", () => {
    const archive = { schema: "legacy_history", tablePrefix: "preserved_", tables: ["preserved_rows", "preserved_chunks"] };
    const denied = createPostgresBusinessProvisioningPlan({ ...fixture(), archive });
    expect(denied.archiveRuntimeReadAccess).toBe("denied");
    expect(sql(denied).some(line => line.startsWith("GRANT SELECT") && line.includes('"legacy_history"'))).toBe(false);
    expect(sql(denied).some(line => line.startsWith("REVOKE ALL PRIVILEGES ON TABLE") && line.includes('"legacy_history"."preserved_rows"'))).toBe(true);
    const allowed = createPostgresBusinessProvisioningPlan({ ...fixture(), archive: { ...archive, allowRuntimeRead: true } });
    expect(allowed.archiveRuntimeReadAccess).toBe("explicit-select-only");
    expect(sql(allowed).filter(line => line.startsWith("GRANT ") && line.includes('"legacy_history"')).join("\n"))
      .not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALL TABLES/);
    refusal({ ...fixture(), archive: { ...archive, tables: ["another_rows"] } });
    refusal({ ...fixture(), archive: { ...archive, tablePrefix: "", allowRuntimeRead: true } });
    refusal({ ...fixture(), archive: { ...archive, allowRuntimeRead: "yes" } });
    refusal({ ...fixture(), archive: { schema: "business_v1", tablePrefix: "business_", tables: ["business_schema_ledger"] } });
  });

  it("allows denied archives in the business namespace without removing business USAGE", () => {
    const plan = createPostgresBusinessProvisioningPlan({ ...fixture(),
      archive: { schema: "business_v1", tablePrefix: "preserved_", tables: ["preserved_rows"] } });
    const statements = sql(plan);
    const usage = statements.findIndex(line => line.startsWith('GRANT USAGE ON SCHEMA "business_v1"'));
    expect(usage).toBeGreaterThan(-1);
    expect(statements.slice(usage + 1).some(line => line.startsWith('REVOKE ALL PRIVILEGES ON SCHEMA "business_v1"'))).toBe(false);
  });

  it("accounts for every instance and all host reserves without production defaults", () => {
    const plan = createPostgresBusinessProvisioningPlan(fixture());
    expect(plan.connections).toMatchObject({ runtimeConnections: 18, databaseConnectionLimit: 24,
      hostRequiredConnections: 32, hostRemainingConnections: 32 });
    expect(plan.roles.find(role => role.service === "scanner")?.connectionLimit).toBe(6);
    expect(sql(plan).find(line => line.startsWith('CREATE ROLE "radar_scanner"'))).toContain("CONNECTION LIMIT 6");
    expect(plan.runtimeLimits).toMatchObject({ maximumPendingOperations: 4, shutdownTimeoutMs: 5_000, workMemKb: 1_024 });
    expect(plan.resources.pools.console.maximumConnections).toBe(1);
  });

  it("rejects missing or extra services, duplicate roles and incoherent connection budgets", () => {
    const input = fixture();
    const { console: _console, ...pools } = input.resources.pools;
    refusal({ ...input, resources: { ...input.resources, pools } });
    refusal({ ...input, serviceRoles: { ...input.serviceRoles, extra: "extra_role" } });
    refusal({ ...input, serviceRoles: { ...input.serviceRoles, console: input.serviceRoles.scanner } });
    refusal({ ...input, migratorRole: input.serviceRoles.scanner });
    const resources = { ...input.resources, serverMaximumConnections: 31 };
    refusal({ ...input, resources, capacity: { ...input.capacity, resourcePolicyFingerprint: postgresBusinessResourcePolicyFingerprint(resources) } });
  });

  it.each(["database", "schema", "migratorRole"])("rejects acceptance/test identifiers and injection in %s", key => {
    for (const value of ["radar_acceptance", "radar_test", "pg_internal", "radar;DROP"]) refusal({ ...fixture(), [key]: value });
    refusal({ ...fixture(), database: "postgres" });
    refusal({ ...fixture(), schema: "public" });
    refusal({ ...fixture(), serviceRoles: { ...fixture().serviceRoles, scanner: "radar_acceptance" } });
  });

  it("fails closed for unknown, stale, future, expired or unrelated capacity measurements", () => {
    const input = fixture();
    for (const capacity of [undefined, { ...input.capacity, status: "unknown" },
      { ...input.capacity, measuredAt: "2026-10-04T04:01:00.000Z" },
      { ...input.capacity, measuredAt: "2026-10-03T04:00:00.000Z" },
      { ...input.capacity, validUntil: input.now },
      { ...input.capacity, resourcePolicyFingerprint: "b".repeat(64) },
      { ...input.capacity, measurementRef: "" }]) refusal({ ...input, capacity });
  });

  it("enforces exact RAM and combined disk/WAL/temp headroom with explicit margins", () => {
    const input = fixture();
    refusal({ ...input, capacity: { ...input.capacity, availableRamBytes: "799999999" } });
    refusal({ ...input, capacity: { ...input.capacity, availableDiskBytes: "7499999999" } });
    refusal({ ...input, capacity: { ...input.capacity, ramMarginBytes: "0" } });
    refusal({ ...input, capacity: { ...input.capacity, measuredPeakWalBytes: undefined } });
    refusal({ ...input, capacity: { ...input.capacity, measuredPeakTempBytes: "unknown" } });
    const exact = createPostgresBusinessProvisioningPlan({ ...input, capacity: { ...input.capacity,
      availableRamBytes: "9007199254740993", measuredPeakRamBytes: "9007199254740992", ramMarginBytes: "1" } });
    expect(exact.capacity.requiredRamBytes).toBe("9007199254740993");
    expect(exact.capacity.remainingRamBytes).toBe("0");
    const zero = createPostgresBusinessProvisioningPlan({ ...input, capacity: { ...input.capacity,
      measuredPeakWalBytes: "0", measuredPeakTempBytes: "0" } });
    expect(zero.capacity.requiredDiskBytes).toBe("6000000000");
  });

  it.each(["maximumPendingOperations", "connectionTimeoutMs", "idleTimeoutMs", "statementTimeoutMs",
    "lockTimeoutMs", "idleTransactionTimeoutMs", "shutdownTimeoutMs", "workMemKb", "maximumMeasurementAgeMs"] as const)
  ("rejects invalid resource policy %s", key => {
    for (const value of [-1, 1.5, Number.NaN, Infinity]) refusal({ ...fixture(), resources: { ...fixture().resources, [key]: value } });
  });

  it("binds measurements to the complete resource policy and preserves no input aliases", () => {
    const input = fixture(); const resources = { ...input.resources, workMemKb: 2_048 };
    expect(postgresBusinessResourcePolicyFingerprint(resources)).not.toBe(input.capacity.resourcePolicyFingerprint);
    refusal({ ...input, resources });
    const plan = createPostgresBusinessProvisioningPlan(input);
    (input.resources.pools.scanner as { instances: number }).instances = 10;
    expect(plan.resources.pools.scanner.instances).toBe(2);
    expect(plan.connections.runtimeConnections).toBe(18);
    expect(POSTGRES_BUSINESS_SERVICES).toHaveLength(6);
  });

  it("rejects credential-bearing or unknown fields without echoing their content", () => {
    const secret = "sentinel-private-password";
    for (const input of [{ ...fixture(), password: secret },
      { ...fixture(), connectionString: "postgresql://user:" + secret + "@host/db" },
      { ...fixture(), database: secret + ";" }]) {
      let error: unknown;
      try { createPostgresBusinessProvisioningPlan(changed(input)); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
    }
  });
});


describe("PostgreSQL provisioning shared services and trusted extensions", () => {
  const trustedModules = [{ id: "app-support", dependencies: ["capture-inbox"], sql:
    "/* CREATE TABLE phantom_comment (id text); */ CREATE TABLE IF NOT EXISTS app_support (id text PRIMARY KEY, "
    + "value text DEFAULT 'CREATE TABLE phantom_string (id text);', other text DEFAULT $$; CREATE TABLE phantom_dollar (id text);$$);\n"
    + "CREATE INDEX IF NOT EXISTS app_support_value ON app_support(value);\n"
    + "CREATE TABLE service_support (service_id text PRIMARY KEY);" }];
  const steps = [...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations, { version: 2, modules: ["app-support"] }];
  const extended = () => createPostgresBusinessSchemaPlan(steps, { trustedModules });

  it("re-exports the dispatcher service binding without a second declaration", () => {
    expect(POSTGRES_BUSINESS_SERVICES).toBe(DISPATCH_SERVICES);
  });

  it("keeps version one and unused extension definitions out of the runtime allowlist", () => {
    const plan = createPostgresBusinessProvisioningPlan({ ...fixture(), trustedModules });
    expect(plan.schemaInstallation.plan).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN);
    expect(plan.schemaInstallation.plan.fingerprint).toBe("9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22");
    expect(plan.businessTables).not.toContain("app_support");
    expect(sql(plan).join("\n")).not.toContain('"business_v1"."app_support"');
  });

  it("accepts reviewed version two and defaults unclassified tables to SELECT-only", () => {
    const schemaPlan = extended();
    const plan = createPostgresBusinessProvisioningPlan({ ...fixture(), schemaPlan, trustedModules });
    expect(plan.schemaInstallation.plan).toEqual(schemaPlan);
    expect(plan.schemaInstallation.plan.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
    expect(plan.businessTables).toContain("app_support");
    expect(plan.businessTables).toContain("service_support");
    for (const name of ["app_support_value", "phantom_comment", "phantom_string", "phantom_dollar"]) {
      expect(plan.businessTables).not.toContain(name);
    }
    const statements = sql(plan);
    const writes = statements.find(line => line.startsWith("GRANT INSERT, UPDATE, DELETE"))!;
    expect(writes).not.toContain('"business_v1"."app_support"');
    expect(writes).not.toContain('"business_v1"."service_support"');
    expect(plan.protectedTables).toContain("app_support");
    expect(writes).not.toMatch(/radar_console|business_schema_identity|business_schema_ledger/);
    expect(statements.find(line => line.startsWith("GRANT SELECT") && line.includes('"business_v1"."app_support"'))).toContain('"radar_console"');
    expect(plan.proofs.isolatedPermissions).toBe("unknown");
    expect(plan.productionMigrationReady).toBe(false);
  });

  it("rejects missing, changed or manifest-embedded trusted definitions", () => {
    const schemaPlan = extended();
    refusal({ ...fixture(), schemaPlan });
    refusal({ ...fixture(), schemaPlan: { ...schemaPlan, trustedModules } });
    refusal({ ...fixture(), schemaPlan, trustedModules: [{ ...trustedModules[0]!, sql: "CREATE TABLE app_support (changed text);" }] });
    refusal({ ...fixture(), schemaPlan, trustedModules: [{ ...trustedModules[0]!, dependencies: ["capture-health"] }] });
    refusal({ ...fixture(), schemaPlan, trustedModules: null });
  });

  it("rejects built-in overrides and duplicate table declarations", () => {
    refusal({ ...fixture(), trustedModules: [{ id: "capture-inbox", dependencies: [], sql: "CREATE TABLE replacement (id text);" }] });
    const duplicates = [{ id: "app-support", dependencies: ["capture-inbox"],
      sql: "CREATE TABLE capture_raw_payloads (id text);" }];
    const schemaPlan = createPostgresBusinessSchemaPlan(steps, { trustedModules: duplicates });
    refusal({ ...fixture(), schemaPlan, trustedModules: duplicates });
  });
});


describe("PostgreSQL reviewed authority and counter ACL classification", () => {
  const trustedModules = [
    { id: "wallet-channel", dependencies: ["capture-inbox", "forward-purchases"], sql: POSTGRES_WALLET_CHANNEL_SCHEMA_SQL },
    { id: "service-facts", dependencies: ["wallet-channel"], sql: POSTGRES_SERVICE_FACT_SCHEMA_SQL },
    { id: "cutover-authority", dependencies: [], sql: "CREATE TABLE migration_cutover_transitions (operation_id text PRIMARY KEY);" },
  ];
  const plan = () => {
    const schemaPlan = createPostgresBusinessSchemaPlan([...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations,
      { version: 2, modules: trustedModules.map(module => module.id) }], { trustedModules });
    return createPostgresBusinessProvisioningPlan({ ...fixture(), schemaPlan, trustedModules });
  };

  it("never grants runtime writes to reviewed authority, validation or cohort tables", () => {
    const result = plan();
    const writes = sql(result).filter(line => /^GRANT (?:INSERT|UPDATE|DELETE)/.test(line)).join("\n");
    for (const table of POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES) {
      expect(writes).not.toContain('"business_v1"."' + table + '"');
      expect(result.protectedTables).toContain(table);
    }
    expect(writes).not.toContain("radar_console");
    expect(result.schemaInstallation.plan.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
  });

  it("grants only actual budget counter and window-rotation UPDATE columns", () => {
    const result = plan();
    const budget = result.runtimeColumnGrants.filter(grant => grant.table === "wallet_service_provider_budgets");
    expect(budget).toEqual([{ table: "wallet_service_provider_budgets", privilege: "UPDATE",
      columns: ["window_started_at", "requests_used", "cooldown_until"] }]);
    const writes = sql(result).filter(line => /^GRANT (?:INSERT|UPDATE|DELETE)/.test(line)
      && line.includes('"business_v1"."wallet_service_provider_budgets"'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('GRANT UPDATE ("window_started_at", "requests_used", "cooldown_until") ON TABLE');
    expect(writes[0]).not.toMatch(/origin|import_id|window_ms|maximum_requests|maximum_concurrency|generation_id|provider_id|radar_console/);
    expect(Object.isFrozen(POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY.wallet_service_provider_budgets.update)).toBe(true);
  });

  it("preserves mutable worker state without allowing lease or consumption deletion", () => {
    const result = plan();
    const columns = (table: string, privilege: "INSERT" | "UPDATE") =>
      result.runtimeColumnGrants.find(grant => grant.table === table && grant.privilege === privilege)?.columns;
    expect(columns("wallet_service_price_leases", "UPDATE")).toEqual(["claim_generation", "lease_owner", "lease_expires_at"]);
    expect(columns("wallet_service_price_consumption", "INSERT")).toEqual(["generation_id", "fact_id", "consumed_at"]);
    expect(columns("wallet_service_provider_leases", "UPDATE")).toEqual(["released_at"]);
    expect(columns("wallet_service_source_requests", "INSERT")).toContain("request_key");
    expect(columns("wallet_channel_collectors", "UPDATE")).toContain("checkpoints_json");
    expect(columns("wallet_capture_generation_bindings", "INSERT")).toContain("semantic_fingerprint");
    for (const table of Object.keys(POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY)) {
      expect(result.runtimeWritableTables).not.toContain(table);
    }
    expect(result.productionMigrationReady).toBe(false);
    expect(result.proofs.isolatedPermissions).toBe("unknown");
  });

  it("cannot obtain built-in CRUD grants merely by reusing a table name in a trusted-only plan", () => {
    const trustedModules = [{ id: "standalone", dependencies: [], sql: "CREATE TABLE capture_raw_payloads (id text);" }];
    const schemaPlan = createPostgresBusinessSchemaPlan([{ version: 1, modules: ["standalone"] }], { trustedModules });
    const result = createPostgresBusinessProvisioningPlan({ ...fixture(), schemaPlan, trustedModules });
    expect(result.runtimeWritableTables).toEqual([]);
    expect(sql(result).some(line => line.startsWith("GRANT INSERT"))).toBe(false);
  });
});


it("grants only the narrow instance-identity function to all six service roles", () => {
  const statements = sql(createPostgresBusinessProvisioningPlan(fixture()));
  const functions = statements.filter(line => line.startsWith("GRANT EXECUTE"));
  expect(functions).toHaveLength(1);
  expect(functions[0]).toContain("ON FUNCTION pg_catalog.pg_control_system()");
  for (const role of Object.values(fixture().serviceRoles)) expect(functions[0]).toContain('"' + role + '"');
  expect(statements.join("\n")).not.toContain("pg_monitor");
});

it("grants the actual full v2 composition mutations without broadening authority or console writes", async () => {
  const { createPostgresServiceSchema } = await import("../../../apps/automation/src/postgres-service-schema.js");
  const definition = createPostgresServiceSchema();
  const input = fixture();
  const plan = createPostgresBusinessProvisioningPlan({ ...input, schemaPlan: definition.plan, trustedModules: definition.trustedModules });
  expect(definition.supportTables).toHaveLength(17);
  const expected = {
    wallet_forward_signal_jobs: { INSERT: ["generation_id", "chain", "token_address", "next_attempt_at", "requested_at", "wake_generation"],
      UPDATE: ["status", "next_attempt_at", "requested_at", "claim_generation", "lease_owner", "lease_expires_at", "reason_code", "wake_generation"] },
    wallet_forward_signal_wake_receipts: { INSERT: ["generation_id", "source_kind", "source_key", "chain", "token_address", "dispatched_at"] },
    wallet_forward_signal_wake_intents: { INSERT: ["generation_id", "source_key", "chain", "token_address", "created_at"], UPDATE: ["status"] },
  };
  for (const [table, privileges] of Object.entries(expected)) {
    expect(plan.runtimeWritableTables).not.toContain(table);
    expect(plan.runtimeColumnGrants.filter(grant => grant.table === table)).toEqual(
      Object.entries(privileges).map(([privilege, columns]) => ({ table, privilege, columns })));
    for (const statement of sql(plan).filter(statement => statement.startsWith("GRANT") && statement.includes('"' + table + '"') && !statement.startsWith("GRANT SELECT"))) {
      expect(statement).not.toContain('"radar_console"');
      expect(statement).not.toMatch(/DELETE|GRANT ALL/);
    }
  }
  expect(plan.protectedTables).toEqual(expect.arrayContaining([...POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES]));
  expect(plan.schemaInstallation.plan.migrations[0]).toEqual(POSTGRES_BUSINESS_SCHEMA_PLAN.migrations[0]);
});
