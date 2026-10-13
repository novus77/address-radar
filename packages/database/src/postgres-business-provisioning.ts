import { createHash } from "node:crypto";
import {
  createPostgresBusinessSchemaPlan, POSTGRES_BUSINESS_SCHEMA_MODULES, POSTGRES_BUSINESS_SCHEMA_PLAN,
  type PostgresBusinessSchemaPlan, type PostgresBusinessSchemaTrustedModule,
} from "./postgres-business-schema.js";

import { POSTGRES_BUSINESS_SERVICES, type PostgresBusinessService } from "./postgres-service-dispatch.js";
export { POSTGRES_BUSINESS_SERVICES, type PostgresBusinessService } from "./postgres-service-dispatch.js";

// Fixed authority names reviewed against the application DDL, not caller-selected permission policy.
export const POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES = Object.freeze([
  "business_schema_identity", "business_schema_ledger", "migration_cutover_transitions",
  "wallet_service_import_ledger", "wallet_service_profile_cohort", "wallet_service_profile_versions",
  "wallet_service_fact_inputs", "wallet_service_fact_validators", "wallet_service_fact_attestations",
] as const);

export const POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY = frozen({
  wallet_channel_collectors: { insert: ["generation_id", "collector_id", "updated_at"],
    update: ["checkpoints_json", "claim_generation", "lease_owner", "lease_expires_at", "updated_at"] },
  wallet_capture_generation_bindings: { insert: ["generation_id", "source_namespace", "source_event_id", "semantic_fingerprint", "created_at"] },
  wallet_forward_signal_jobs: { insert: ["generation_id", "chain", "token_address", "next_attempt_at", "requested_at", "wake_generation"],
    update: ["status", "next_attempt_at", "requested_at", "claim_generation", "lease_owner", "lease_expires_at", "reason_code", "wake_generation"] },
  wallet_forward_signal_wake_receipts: { insert: ["generation_id", "source_kind", "source_key", "chain", "token_address", "dispatched_at"] },
  wallet_forward_signal_wake_intents: { insert: ["generation_id", "source_key", "chain", "token_address", "created_at"], update: ["status"] },
  wallet_service_price_leases: { update: ["claim_generation", "lease_owner", "lease_expires_at"] },
  wallet_service_price_consumption: { insert: ["generation_id", "fact_id", "consumed_at"] },
  // Window rotation is existing counter state; origin, import, window_ms and maxima remain immutable.
  wallet_service_provider_budgets: { update: ["window_started_at", "requests_used", "cooldown_until"] },
  wallet_service_provider_leases: { insert: ["lease_id", "generation_id", "provider_id", "owner_id", "expires_at"], update: ["released_at"] },
  wallet_service_source_requests: { insert: ["generation_id", "provider_id", "request_key", "kind", "subject_key", "requested_at", "status"] },
} as const);

export interface PostgresBusinessRuntimeColumnGrant {
  readonly table: string;
  readonly privilege: "INSERT" | "UPDATE";
  readonly columns: readonly string[];
}

export interface PostgresBusinessRuntimeResourceLimits {
  readonly maximumPendingOperations: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly workMemKb: number;
}
export interface PostgresBusinessProvisioningResources extends PostgresBusinessRuntimeResourceLimits {
  readonly pools: Readonly<Record<PostgresBusinessService, {
    readonly instances: number; readonly maximumConnections: number;
  }>>;
  readonly serverMaximumConnections: number;
  readonly postgresReservedConnections: number;
  readonly otherHostConnections: number;
  readonly migrationConnections: number;
  readonly operatorConnections: number;
  readonly backupConnections: number;
  readonly maximumMeasurementAgeMs: number;
}
export interface PostgresBusinessCapacityMeasurement {
  readonly status: "measured";
  readonly hostId: string;
  readonly measurementRef: string;
  readonly resourcePolicyFingerprint: string;
  readonly measuredAt: string;
  readonly validUntil: string;
  readonly availableRamBytes: string;
  readonly measuredPeakRamBytes: string;
  readonly ramMarginBytes: string;
  readonly availableDiskBytes: string;
  readonly measuredPeakDiskBytes: string;
  readonly measuredPeakWalBytes: string;
  readonly measuredPeakTempBytes: string;
  readonly diskMarginBytes: string;
}
export interface PostgresBusinessArchivePlan {
  readonly schema: string;
  readonly tablePrefix: string;
  readonly tables: readonly string[];
  readonly allowRuntimeRead?: boolean;
}
export interface PostgresBusinessProvisioningOptions {
  readonly database: string;
  readonly schema: string;
  readonly generation: string;
  readonly migratorRole: string;
  readonly serviceRoles: Readonly<Record<PostgresBusinessService, string>>;
  readonly resources: PostgresBusinessProvisioningResources;
  readonly capacity: PostgresBusinessCapacityMeasurement;
  readonly now: string;
  readonly schemaPlan?: PostgresBusinessSchemaPlan;
  /** Reviewed application definitions, supplied separately; never sourced from a saved plan or manifest. */
  readonly trustedModules?: readonly PostgresBusinessSchemaTrustedModule[];
  readonly archive?: PostgresBusinessArchivePlan;
}
export interface PostgresBusinessProvisioningPhase {
  readonly id: "cluster-roles" | "cluster-database" | "database-lockdown" | "post-schema-grants";
  readonly connectionDatabase: string | null;
  readonly transactional: boolean;
  readonly statements: readonly string[];
}
export interface PostgresBusinessProvisioningPlan {
  readonly mode: "offline-sql-plan";
  readonly productionMigrationReady: false;
  readonly database: string;
  readonly schema: string;
  readonly generation: string;
  readonly phases: readonly PostgresBusinessProvisioningPhase[];
  readonly roles: readonly {
    readonly name: string; readonly service: PostgresBusinessService | null;
    readonly access: "migration" | "runtime" | "read"; readonly connectionLimit: number;
  }[];
  readonly schemaInstallation: {
    readonly installer: "installPostgresBusinessSchema";
    readonly executorRole: string;
    readonly requiresAbsentNamespace: true;
    readonly automaticStartupExecution: false;
    readonly target: { readonly database: string; readonly username: string; readonly schema: string;
      readonly generation: string; readonly service: "migration" };
    readonly plan: PostgresBusinessSchemaPlan;
  };
  readonly businessTables: readonly string[];
  readonly runtimeWritableTables: readonly string[];
  readonly protectedTables: readonly string[];
  readonly runtimeColumnGrants: readonly PostgresBusinessRuntimeColumnGrant[];
  readonly archiveRuntimeReadAccess: "denied" | "explicit-select-only";
  readonly resources: PostgresBusinessProvisioningResources;
  readonly resourcePolicyFingerprint: string;
  readonly runtimeLimits: PostgresBusinessRuntimeResourceLimits;
  readonly connections: {
    readonly runtimeConnections: number; readonly databaseConnectionLimit: number;
    readonly hostRequiredConnections: number; readonly hostRemainingConnections: number;
  };
  readonly capacity: PostgresBusinessCapacityMeasurement & {
    readonly requiredRamBytes: string; readonly remainingRamBytes: string;
    readonly requiredDiskBytes: string; readonly remainingDiskBytes: string;
  };
  readonly credentials: {
    readonly mandatory: true; readonly delivery: "external-private";
    readonly passwordsEmbedded: false; readonly roles: readonly string[];
  };
  readonly proofs: {
    readonly isolatedPermissions: "unknown"; readonly liveCapacity: "unknown";
    readonly credentialProvisioning: "unknown";
  };
}

export class PostgresBusinessProvisioningRefusalError extends Error {
  constructor(code: string) {
    // Never interpolate input values: they may contain accidentally supplied credentials.
    super("PostgreSQL business provisioning refused: " + code);
    this.name = "PostgresBusinessProvisioningRefusalError";
  }
}
function requireThat(condition: unknown, code: string): asserts condition {
  if (!condition) throw new PostgresBusinessProvisioningRefusalError(code);
}
function record(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_OBJECT");
  return value as Record<string, unknown>;
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const object = record(value);
  requireThat(required.every(key => Object.hasOwn(object, key)) &&
    Object.keys(object).every(key => required.includes(key) || optional.includes(key)), "UNKNOWN_OR_MISSING_FIELD");
  return object;
}
function identifier(value: unknown): asserts value is string {
  requireThat(typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(value) &&
    !/(?:^|_)(?:acceptance|test)(?:_|$)/i.test(value) && !value.startsWith("pg_") &&
    !["postgres", "template0", "template1", "public", "information_schema"].includes(value), "INVALID_BUSINESS_IDENTIFIER");
}
function integer(value: unknown, minimum = 1, maximum = 2_147_483_647): asserts value is number {
  requireThat(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, "INVALID_RESOURCE_LIMIT");
}
function reference(value: unknown): asserts value is string {
  requireThat(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value), "INVALID_MEASUREMENT_REFERENCE");
}
function timestamp(value: unknown): number {
  requireThat(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), "INVALID_MEASUREMENT_TIME");
  const result = Date.parse(value);
  requireThat(Number.isFinite(result) && new Date(result).toISOString() === value, "INVALID_MEASUREMENT_TIME");
  return result;
}
function bytes(value: unknown, zeroAllowed = false): bigint {
  requireThat(typeof value === "string" && /^(0|[1-9][0-9]{0,39})$/.test(value), "UNKNOWN_OR_INVALID_CAPACITY");
  const result = BigInt(value);
  requireThat(zeroAllowed || result > 0n, "UNKNOWN_OR_INVALID_CAPACITY");
  return result;
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) frozen(nested);
    Object.freeze(value);
  }
  return value;
}
// Inspect only declaration heads: comments and quoted defaults must never expand the grant allowlist.
// This extracts names from already validated trusted DDL, not arbitrary SQL from a manifest.
function declaredTables(sql: string): string[] {
  const visible: string[] = [];
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith("--", index)) {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      visible.push(" ");
    } else if (sql.startsWith("/*", index)) {
      let depth = 1; index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith("/*", index)) { depth += 1; index += 2; }
        else if (sql.startsWith("*/", index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      visible.push(" ");
    } else if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index]!;
      const escaped = quote === "'" && /[eE]/.test(sql[index - 1] ?? "")
        && !/[a-zA-Z0-9_$]/.test(sql[index - 2] ?? "");
      index += 1;
      while (index < sql.length) {
        if (escaped && sql[index] === "\\") index += 2;
        else if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 2;
          else { index += 1; break; }
        } else index += 1;
      }
      visible.push(" ");
    } else {
      const tag = sql[index] === "$" ? /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(index))?.[0] : undefined;
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        requireThat(end !== -1, "UNSUPPORTED_TABLE_COMPOSITION");
        index = end + tag.length;
        visible.push(" ");
      } else { visible.push(sql[index]!); index += 1; }
    }
  }
  return [...visible.join("").matchAll(/(?:^|;)\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/g)]
    .map(match => match[1]!);
}
const quote = (name: string): string => '"' + name + '"';
const relation = (schema: string, table: string): string => quote(schema) + "." + quote(table);
const limitFields = [
  "maximumPendingOperations", "connectionTimeoutMs", "idleTimeoutMs", "statementTimeoutMs", "lockTimeoutMs",
  "idleTransactionTimeoutMs", "shutdownTimeoutMs", "workMemKb",
] as const;
const resourceFields = [
  ...limitFields, "pools", "serverMaximumConnections", "postgresReservedConnections", "otherHostConnections",
  "migrationConnections", "operatorConnections", "backupConnections", "maximumMeasurementAgeMs",
] as const;

function validatedResources(input: PostgresBusinessProvisioningResources): PostgresBusinessProvisioningResources {
  const value = fields(input, resourceFields);
  const pools = fields(value.pools, POSTGRES_BUSINESS_SERVICES);
  for (const service of POSTGRES_BUSINESS_SERVICES) {
    const pool = fields(pools[service], ["instances", "maximumConnections"]);
    integer(pool.instances); integer(pool.maximumConnections, 1, 64);
    integer((pool.instances as number) * (pool.maximumConnections as number));
  }
  for (const field of resourceFields.filter(field => field !== "pools")) {
    integer(value[field], field === "maximumPendingOperations" || field === "otherHostConnections" ? 0 : 1);
  }
  integer(value.maximumPendingOperations, 0, 10_000);
  integer(value.workMemKb, 64, 1_048_576);
  requireThat((value.lockTimeoutMs as number) <= (value.statementTimeoutMs as number), "INCOHERENT_TIMEOUTS");
  // Normalize ordering and detach every nested input before fingerprinting or exposing it.
  return {
    pools: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service => [service, {
      instances: input.pools[service].instances, maximumConnections: input.pools[service].maximumConnections,
    }])) as PostgresBusinessProvisioningResources["pools"],
    maximumPendingOperations: input.maximumPendingOperations, connectionTimeoutMs: input.connectionTimeoutMs,
    idleTimeoutMs: input.idleTimeoutMs, statementTimeoutMs: input.statementTimeoutMs, lockTimeoutMs: input.lockTimeoutMs,
    idleTransactionTimeoutMs: input.idleTransactionTimeoutMs, shutdownTimeoutMs: input.shutdownTimeoutMs,
    workMemKb: input.workMemKb, serverMaximumConnections: input.serverMaximumConnections,
    postgresReservedConnections: input.postgresReservedConnections, otherHostConnections: input.otherHostConnections,
    migrationConnections: input.migrationConnections, operatorConnections: input.operatorConnections,
    backupConnections: input.backupConnections, maximumMeasurementAgeMs: input.maximumMeasurementAgeMs,
  };
}
export function postgresBusinessResourcePolicyFingerprint(resources: PostgresBusinessProvisioningResources): string {
  return createHash("sha256").update(JSON.stringify(validatedResources(resources))).digest("hex");
}

/** Pure offline planning. No SQL execution, credential delivery, environment reads or readiness grant. */
export function createPostgresBusinessProvisioningPlan(input: PostgresBusinessProvisioningOptions): PostgresBusinessProvisioningPlan {
  fields(input, ["database", "schema", "generation", "migratorRole", "serviceRoles", "resources", "capacity", "now"],
    ["schemaPlan", "trustedModules", "archive"]);
  identifier(input.database); identifier(input.schema); identifier(input.migratorRole);
  requireThat(typeof input.generation === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.generation), "INVALID_GENERATION");
  fields(input.serviceRoles, POSTGRES_BUSINESS_SERVICES);
  const runtimeRoles = POSTGRES_BUSINESS_SERVICES.map(service => {
    const name = input.serviceRoles[service]; identifier(name); return name;
  });
  const allRoles = [input.migratorRole, ...runtimeRoles];
  requireThat(new Set(allRoles).size === allRoles.length, "ROLE_IDENTITY_COLLISION");
  const resources = validatedResources(input.resources);
  const resourcePolicyFingerprint = postgresBusinessResourcePolicyFingerprint(resources);
  const runtimeConnections = POSTGRES_BUSINESS_SERVICES.reduce((sum, service) =>
    sum + resources.pools[service].instances * resources.pools[service].maximumConnections, 0);
  const databaseConnectionLimit = runtimeConnections + resources.migrationConnections + resources.operatorConnections + resources.backupConnections;
  const hostRequiredConnections = databaseConnectionLimit + resources.postgresReservedConnections + resources.otherHostConnections;
  requireThat(hostRequiredConnections <= resources.serverMaximumConnections, "HOST_CONNECTION_BUDGET_EXCEEDED");

  const capacity = fields(input.capacity, [
    "status", "hostId", "measurementRef", "resourcePolicyFingerprint", "measuredAt", "validUntil",
    "availableRamBytes", "measuredPeakRamBytes", "ramMarginBytes", "availableDiskBytes",
    "measuredPeakDiskBytes", "measuredPeakWalBytes", "measuredPeakTempBytes", "diskMarginBytes",
  ]);
  requireThat(capacity.status === "measured", "CAPACITY_NOT_MEASURED");
  reference(capacity.hostId); reference(capacity.measurementRef);
  requireThat(capacity.resourcePolicyFingerprint === resourcePolicyFingerprint, "UNRELATED_CAPACITY_MEASUREMENT");
  const now = timestamp(input.now), measuredAt = timestamp(capacity.measuredAt), validUntil = timestamp(capacity.validUntil);
  requireThat(measuredAt <= now && now - measuredAt <= resources.maximumMeasurementAgeMs && validUntil > now, "STALE_OR_FUTURE_CAPACITY_MEASUREMENT");
  const availableRam = bytes(capacity.availableRamBytes);
  const requiredRam = bytes(capacity.measuredPeakRamBytes) + bytes(capacity.ramMarginBytes);
  const availableDisk = bytes(capacity.availableDiskBytes);
  const requiredDisk = bytes(capacity.measuredPeakDiskBytes) + bytes(capacity.measuredPeakWalBytes, true) +
    bytes(capacity.measuredPeakTempBytes, true) + bytes(capacity.diskMarginBytes);
  requireThat(availableRam >= requiredRam && availableDisk >= requiredDisk, "MEASURED_HEADROOM_INSUFFICIENT");

  const supplied = input.schemaPlan ?? POSTGRES_BUSINESS_SCHEMA_PLAN;
  let schemaPlan: PostgresBusinessSchemaPlan;
  let trustedModules: readonly PostgresBusinessSchemaTrustedModule[];
  try {
    const definitions = input.trustedModules === undefined ? [] : input.trustedModules;
    requireThat(Array.isArray(definitions) && definitions.length <= 64, "SCHEMA_PLAN_MISMATCH");
    trustedModules = definitions.map(module => {
      fields(module, ["id", "dependencies", "sql"]);
      return { id: module.id, dependencies: [...module.dependencies], sql: module.sql };
    });
    schemaPlan = createPostgresBusinessSchemaPlan(supplied.migrations, { trustedModules });
    requireThat(supplied.version === schemaPlan.version && supplied.fingerprint === schemaPlan.fingerprint &&
      supplied.migrations.every((step, index) => step.fingerprint === schemaPlan.migrations[index]?.fingerprint &&
        step.previousFingerprint === schemaPlan.migrations[index]?.previousFingerprint), "SCHEMA_PLAN_MISMATCH");
  } catch { throw new PostgresBusinessProvisioningRefusalError("SCHEMA_PLAN_MISMATCH"); }
  const registry = new Map<string, { readonly sql: string }>(
    [...POSTGRES_BUSINESS_SCHEMA_MODULES, ...trustedModules].map(module => [module.id, module]));
  const businessTables = schemaPlan.migrations.flatMap(step => step.modules.flatMap(id =>
    declaredTables(registry.get(id)!.sql)));
  requireThat(businessTables.length > 0 && new Set(businessTables).size === businessTables.length, "UNSUPPORTED_TABLE_COMPOSITION");
  const ledgerTables = ["business_schema_identity", "business_schema_ledger"];
  const protectedNames: ReadonlySet<string> = new Set(POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES);
  const builtinRegistry = new Map(POSTGRES_BUSINESS_SCHEMA_MODULES.map(module => [module.id, module]));
  const builtinTables = new Set(schemaPlan.migrations.flatMap(step => step.modules.flatMap(id =>
    builtinRegistry.has(id as typeof POSTGRES_BUSINESS_SCHEMA_MODULES[number]["id"])
      ? declaredTables(builtinRegistry.get(id as typeof POSTGRES_BUSINESS_SCHEMA_MODULES[number]["id"])!.sql) : [])));
  const runtimeWritableTables = businessTables.filter(table => builtinTables.has(table) && !protectedNames.has(table));
  const runtimeColumnGrants: PostgresBusinessRuntimeColumnGrant[] = [];
  const columnPolicies: Readonly<Record<string, { readonly insert?: readonly string[]; readonly update?: readonly string[] }>> =
    POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY;
  for (const table of businessTables) {
    if (protectedNames.has(table) || runtimeWritableTables.includes(table)) continue;
    const policy = columnPolicies[table];
    if (!policy) continue; // Unclassified extensions are SELECT-only until their implementation is reviewed.
    for (const privilege of ["INSERT", "UPDATE"] as const) {
      const columns = privilege === "INSERT" ? policy.insert : policy.update;
      if (columns) runtimeColumnGrants.push({ table, privilege, columns: [...columns] });
    }
  }
  const protectedTables = [...ledgerTables, ...businessTables.filter(table =>
    protectedNames.has(table) || (!runtimeWritableTables.includes(table) && !Object.hasOwn(columnPolicies, table)))];
  let archive: PostgresBusinessArchivePlan | undefined;
  if (input.archive !== undefined) {
    fields(input.archive, ["schema", "tablePrefix", "tables"], ["allowRuntimeRead"]);
    identifier(input.archive.schema); identifier(input.archive.tablePrefix);
    requireThat(input.archive.tablePrefix.endsWith("_") && Array.isArray(input.archive.tables) &&
      input.archive.tables.length > 0 && input.archive.tables.length <= 1000 &&
      new Set(input.archive.tables).size === input.archive.tables.length &&
      (input.archive.allowRuntimeRead === undefined || typeof input.archive.allowRuntimeRead === "boolean"), "INVALID_ARCHIVE_ALLOWLIST");
    for (const table of input.archive.tables) {
      identifier(table);
      requireThat(table.startsWith(input.archive.tablePrefix) && !ledgerTables.includes(table) &&
        !(input.archive.schema === input.schema && businessTables.includes(table)), "ARCHIVE_TABLE_COLLISION");
    }
    archive = { schema: input.archive.schema, tablePrefix: input.archive.tablePrefix,
      tables: [...input.archive.tables], allowRuntimeRead: input.archive.allowRuntimeRead === true };
  }

  const database = quote(input.database), migrator = quote(input.migratorRole);
  const runtimeList = runtimeRoles.map(quote).join(", ");
  const writers = POSTGRES_BUSINESS_SERVICES.filter(service => service !== "console").map(service => quote(input.serviceRoles[service])).join(", ");
  const schema = quote(input.schema);
  const roles: PostgresBusinessProvisioningPlan["roles"] = [
    { name: input.migratorRole, service: null, access: "migration", connectionLimit: resources.migrationConnections },
    ...POSTGRES_BUSINESS_SERVICES.map(service => ({ name: input.serviceRoles[service], service,
      access: service === "console" ? "read" as const : "runtime" as const,
      connectionLimit: resources.pools[service].instances * resources.pools[service].maximumConnections })),
  ];
  const clusterRoles = roles.map(role => "CREATE ROLE " + quote(role.name) +
    " NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT " + role.connectionLimit + ";");
  const lockdown = [
    "REVOKE ALL PRIVILEGES ON DATABASE " + database + " FROM PUBLIC;",
    "REVOKE CREATE, TEMPORARY ON DATABASE " + database + " FROM PUBLIC, " + runtimeList + ";",
    "REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, " + runtimeList + ";",
    "REVOKE " + migrator + " FROM " + runtimeList + ";",
  ];
  const grants = [
    "REVOKE ALL PRIVILEGES ON SCHEMA " + schema + " FROM PUBLIC, " + runtimeList + ";",
    "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA " + schema + " FROM PUBLIC, " + runtimeList + ";",
    "REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA " + schema + " FROM PUBLIC, " + runtimeList + ";",
    "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA " + schema + " FROM PUBLIC, " + runtimeList + ";",
    "ALTER DEFAULT PRIVILEGES FOR ROLE " + migrator + " IN SCHEMA " + schema + " REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, " + runtimeList + ";",
    "ALTER DEFAULT PRIVILEGES FOR ROLE " + migrator + " IN SCHEMA " + schema + " REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, " + runtimeList + ";",
    // Function EXECUTE is granted globally by default; revoke at the creating role's global scope.
    "ALTER DEFAULT PRIVILEGES FOR ROLE " + migrator + " REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    "GRANT CONNECT ON DATABASE " + database + " TO " + runtimeList + ";",
    "GRANT USAGE ON SCHEMA " + schema + " TO " + runtimeList + ";",
    "GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO " + runtimeList + ";",
    "GRANT SELECT ON TABLE " + [...businessTables, ...ledgerTables].map(table => relation(input.schema, table)).join(", ") + " TO " + runtimeList + ";",
    ...(runtimeWritableTables.length ? ["GRANT INSERT, UPDATE, DELETE ON TABLE " +
      runtimeWritableTables.map(table => relation(input.schema, table)).join(", ") + " TO " + writers + ";"] : []),
    ...runtimeColumnGrants.map(grant => "GRANT " + grant.privilege + " (" + grant.columns.map(quote).join(", ") +
      ") ON TABLE " + relation(input.schema, grant.table) + " TO " + writers + ";"),
  ];
  if (archive) {
    const archiveSchema = quote(archive.schema);
    const archiveRelations = archive.tables.map(table => relation(archive!.schema, table)).join(", ");
    if (archive.schema !== input.schema) grants.push("REVOKE ALL PRIVILEGES ON SCHEMA " + archiveSchema + " FROM PUBLIC, " + runtimeList + ";");
    grants.push(
      "REVOKE ALL PRIVILEGES ON TABLE " + archiveRelations + " FROM PUBLIC, " + runtimeList + ";",
      "ALTER DEFAULT PRIVILEGES FOR ROLE " + migrator + " IN SCHEMA " + archiveSchema + " REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, " + runtimeList + ";",
    );
    if (archive.allowRuntimeRead) {
      if (archive.schema !== input.schema) grants.push("GRANT USAGE ON SCHEMA " + archiveSchema + " TO " + runtimeList + ";");
      grants.push("GRANT SELECT ON TABLE " + archiveRelations + " TO " + runtimeList + ";");
    }
  }
  for (const service of POSTGRES_BUSINESS_SERVICES) {
    const prefix = "ALTER ROLE " + quote(input.serviceRoles[service]) + " IN DATABASE " + database + " SET ";
    grants.push(
      prefix + "search_path = pg_catalog, " + schema + ", pg_temp;",
      prefix + "default_transaction_read_only = " + (service === "console" ? "on;" : "off;"),
      prefix + "statement_timeout = '" + resources.statementTimeoutMs + "ms';",
      prefix + "lock_timeout = '" + resources.lockTimeoutMs + "ms';",
      prefix + "idle_in_transaction_session_timeout = '" + resources.idleTransactionTimeoutMs + "ms';",
      prefix + "work_mem = '" + resources.workMemKb + "kB';",
      prefix + "max_parallel_workers_per_gather = 0;",
      prefix + "synchronous_commit = on;",
    );
  }
  const runtimeLimits = Object.fromEntries(limitFields.map(field => [field, resources[field]])) as unknown as PostgresBusinessRuntimeResourceLimits;
  const capacityCopy = { ...input.capacity, requiredRamBytes: requiredRam.toString(),
    remainingRamBytes: (availableRam - requiredRam).toString(), requiredDiskBytes: requiredDisk.toString(),
    remainingDiskBytes: (availableDisk - requiredDisk).toString() };
  return frozen({
    mode: "offline-sql-plan", productionMigrationReady: false,
    database: input.database, schema: input.schema, generation: input.generation,
    phases: [
      { id: "cluster-roles", connectionDatabase: null, transactional: true, statements: clusterRoles },
      { id: "cluster-database", connectionDatabase: null, transactional: false,
        statements: ["CREATE DATABASE " + database + " OWNER " + migrator + " TEMPLATE template0 CONNECTION LIMIT " + databaseConnectionLimit + ";"] },
      { id: "database-lockdown", connectionDatabase: input.database, transactional: true, statements: lockdown },
      { id: "post-schema-grants", connectionDatabase: input.database, transactional: true, statements: grants },
    ],
    roles, schemaInstallation: { installer: "installPostgresBusinessSchema", executorRole: input.migratorRole,
      requiresAbsentNamespace: true, automaticStartupExecution: false,
      target: { database: input.database, username: input.migratorRole, schema: input.schema, generation: input.generation, service: "migration" },
      plan: schemaPlan },
    businessTables, runtimeWritableTables, protectedTables, runtimeColumnGrants, archiveRuntimeReadAccess: archive?.allowRuntimeRead ? "explicit-select-only" : "denied",
    resources, resourcePolicyFingerprint, runtimeLimits,
    connections: { runtimeConnections, databaseConnectionLimit, hostRequiredConnections,
      hostRemainingConnections: resources.serverMaximumConnections - hostRequiredConnections },
    capacity: capacityCopy, credentials: { mandatory: true, delivery: "external-private", passwordsEmbedded: false, roles: allRoles },
    proofs: { isolatedPermissions: "unknown", liveCapacity: "unknown", credentialProvisioning: "unknown" },
  });
}
