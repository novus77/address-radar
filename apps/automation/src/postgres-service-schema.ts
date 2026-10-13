import { MIGRATION_CUTOVER_TRANSITIONS_V2_DDL, MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL } from "../../../packages/database/src/migration-cutover-coordinator.js";
import { MIGRATION_CUTOVER_TRANSITIONS_DDL } from "../../../packages/database/src/migration-cutover-coordinator.js";
import {
  createPostgresBusinessSchemaPlan, installPostgresBusinessSchema, POSTGRES_BUSINESS_SCHEMA_PLAN,
  type PostgresBusinessSchemaInstallerOptions, type PostgresBusinessSchemaPlan,
  type PostgresBusinessSchemaReceipt, type PostgresBusinessSchemaTrustedModule, type PostgresBusinessRuntime,
} from "@address-radar/database";
import { POSTGRES_BUSINESS_SERVICES, type PostgresBusinessService } from "../../../packages/database/src/postgres-business-provisioning.js";
import { POSTGRES_WALLET_CHANNEL_SCHEMA_SQL } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL } from "./postgres-production-composition.js";
import { POSTGRES_SERVICE_FACT_SCHEMA_SQL } from "./postgres-service-fact-adapters.js";

const trustedModule = (id: string, dependencies: readonly string[], sql: string): PostgresBusinessSchemaTrustedModule =>
  Object.freeze({ id, dependencies: Object.freeze([...dependencies]), sql });

// These definitions are code-owned. Serialized plans and manifests cannot supply replacements.
export const POSTGRES_SERVICE_SCHEMA_MODULES: readonly PostgresBusinessSchemaTrustedModule[] = Object.freeze([
  trustedModule("wallet-channel", ["forward-purchases", "capture-inbox"], POSTGRES_WALLET_CHANNEL_SCHEMA_SQL),
  trustedModule("production-composition", ["wallet-channel", "signal"], POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL),
  trustedModule("service-fact-adapters", ["forward-purchases", "wallet-channel", "target-authorization"], POSTGRES_SERVICE_FACT_SCHEMA_SQL),
  Object.freeze({ id: "migration-cutover-transitions", dependencies: Object.freeze([]), sql: MIGRATION_CUTOVER_TRANSITIONS_DDL }),
]);

export interface PostgresServiceSchemaDefinition {
  readonly plan: PostgresBusinessSchemaPlan;
  readonly trustedModules: readonly PostgresBusinessSchemaTrustedModule[];
  readonly supportTables: readonly string[];
}

/** Pure composition: does not connect, install tables, activate a generation or seed factual proofs. */
function legacyPostgresServiceSchema(): PostgresServiceSchemaDefinition {
  const trustedModules = POSTGRES_SERVICE_SCHEMA_MODULES;
  const plan = createPostgresBusinessSchemaPlan([
    ...POSTGRES_BUSINESS_SCHEMA_PLAN.migrations,
    { version: 2, modules: trustedModules.map(entry => entry.id) },
  ], { trustedModules });
  const supportTables = trustedModules.flatMap(entry =>
    [...entry.sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/g)].map(match => match[1]!));
  if (!supportTables.length || new Set(supportTables).size !== supportTables.length) {
    throw new Error("Reviewed PostgreSQL service schema contains duplicate or missing support tables");
  }
  return Object.freeze({ plan, trustedModules, supportTables: Object.freeze(supportTables) });
}

export type PostgresServiceSchemaInstallerOptions = Omit<PostgresBusinessSchemaInstallerOptions, "plan" | "trustedModules"> & { readonly protocolVersion?: 2 };

/** Explicit migration-role installation only; factories and service startup never call this helper. */
function legacyInstallPostgresServiceSchema(
  executor: Pick<PostgresBusinessRuntime, "run">,
  options: PostgresServiceSchemaInstallerOptions,
): Promise<PostgresBusinessSchemaReceipt> {
  const definition = createPostgresServiceSchema(serviceSchemaProtocolOptions(options));
  return installPostgresBusinessSchema(executor, { ...options, plan: definition.plan, trustedModules: definition.trustedModules });
}

export interface PostgresServiceSchemaGrantOptions {
  readonly protocolVersion?: 2;
  readonly schema: string;
  readonly migratorRole: string;
  readonly serviceRoles: Readonly<Record<PostgresBusinessService, string>>;
}

export interface PostgresServiceSchemaGrantPlan {
  readonly mode: "offline-supplemental-grants";
  readonly automaticStartupExecution: false;
  readonly requiresExistingRoleLockdown: true;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly statements: readonly string[];
}

interface MutationGrant {
  readonly table: string;
  readonly insert?: readonly string[];
  readonly update?: readonly string[];
}

// Fact/provenance/cohort/validator rows stay producer-owned. Runtime ports only mutate leases,
// consumption receipts, source requests and the usage counters of pre-approved provider contracts.
const mutationGrants: readonly MutationGrant[] = Object.freeze([
  { table: "wallet_channel_collectors", insert: ["generation_id", "collector_id", "updated_at"],
    update: ["checkpoints_json", "claim_generation", "lease_owner", "lease_expires_at", "updated_at"] },
  { table: "wallet_capture_generation_bindings", insert: ["generation_id", "source_namespace", "source_event_id", "semantic_fingerprint", "created_at"] },
  { table: "wallet_forward_signal_jobs", insert: ["generation_id", "chain", "token_address", "next_attempt_at", "requested_at", "wake_generation"],
    update: ["status", "next_attempt_at", "requested_at", "claim_generation", "lease_owner", "lease_expires_at", "reason_code", "wake_generation"] },
  { table: "wallet_forward_signal_wake_receipts", insert: ["generation_id", "source_kind", "source_key", "chain", "token_address", "dispatched_at"] },
  { table: "wallet_forward_signal_wake_intents", insert: ["generation_id", "source_key", "chain", "token_address", "created_at"], update: ["status"] },
  { table: "wallet_service_price_leases", update: ["claim_generation", "lease_owner", "lease_expires_at"] },
  { table: "wallet_service_price_consumption", insert: ["generation_id", "fact_id", "consumed_at"] },
  { table: "wallet_service_provider_budgets", update: ["window_started_at", "requests_used", "cooldown_until"] },
  { table: "wallet_service_provider_leases", insert: ["lease_id", "generation_id", "provider_id", "owner_id", "expires_at"], update: ["released_at"] },
  { table: "wallet_service_source_requests", insert: ["generation_id", "provider_id", "request_key", "kind", "subject_key", "requested_at", "status"] },
]);

const validIdentifier = (value: unknown): value is string => typeof value === "string"
  && /^[a-z_][a-z0-9_]{0,62}$/.test(value) && !value.startsWith("pg_")
  && !/(?:^|_)(?:acceptance|test)(?:_|$)/i.test(value)
  && !["postgres", "template0", "template1", "public", "information_schema"].includes(value);
const quote = (value: string): string => `"${value}"`;

/** Offline supplemental grants after approved schema installation and the existing role-lockdown phase.
 * This does not revoke pre-existing table/column grants or memberships, and is not a provisioning approval.
 */
function legacyPostgresServiceSchemaGrantPlan(options: PostgresServiceSchemaGrantOptions): PostgresServiceSchemaGrantPlan {
  const roles = options?.serviceRoles;
  if (!validIdentifier(options?.schema) || !validIdentifier(options?.migratorRole) || !roles
    || Object.keys(roles).length !== POSTGRES_BUSINESS_SERVICES.length
    || POSTGRES_BUSINESS_SERVICES.some(service => !Object.hasOwn(roles, service) || !validIdentifier(roles[service]))) {
    throw new Error("Explicit PostgreSQL service schema and six distinct restricted roles required");
  }
  const roleNames = POSTGRES_BUSINESS_SERVICES.map(service => roles[service]);
  if (new Set([options.migratorRole, ...roleNames]).size !== roleNames.length + 1) {
    throw new Error("PostgreSQL service role identity collision");
  }
  const definition = createPostgresServiceSchema(serviceSchemaProtocolOptions(options));
  const relation = (table: string): string => `${quote(options.schema)}.${quote(table)}`;
  const readers = roleNames.map(quote).join(", ");
  const writers = POSTGRES_BUSINESS_SERVICES.filter(service => service !== "console").map(service => quote(roles[service])).join(", ");
  const statements = [
    `GRANT SELECT ON TABLE ${[...definition.supportTables, "business_schema_identity", "business_schema_ledger"].map(relation).join(", ")} TO ${readers};`,
  ];
  for (const grant of mutationGrants) {
    if (!definition.supportTables.includes(grant.table)) throw new Error("Reviewed service mutation grant references an absent table");
    for (const privilege of ["insert", "update"] as const) {
      const columns = grant[privilege];
      if (columns) statements.push(`GRANT ${privilege.toUpperCase()} (${columns.map(quote).join(", ")}) ON TABLE ${relation(grant.table)} TO ${writers};`);
    }
  }
  return Object.freeze({ mode: "offline-supplemental-grants", automaticStartupExecution: false, requiresExistingRoleLockdown: true,
    schemaVersion: definition.plan.version, schemaFingerprint: definition.plan.fingerprint, statements: Object.freeze([...statements, `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${Object.values(options.serviceRoles).map(role => `"${role}"`).join(", ")};`]) });
}

export interface PostgresServiceProtocolV2SchemaOptions {
  readonly protocolVersion: 2;
}

export const POSTGRES_SERVICE_SCHEMA_PROTOCOL_V2_MODULES: readonly PostgresBusinessSchemaTrustedModule[] = Object.freeze([
  ...POSTGRES_SERVICE_SCHEMA_MODULES,
  Object.freeze({ id: "migration-cutover-protocol-v2", dependencies: Object.freeze(["migration-cutover-transitions"]),
    sql: `${MIGRATION_CUTOVER_TRANSITIONS_V2_DDL}\n;\n${MIGRATION_CUTOVER_FIRST_WRITE_MARKERS_V2_DDL}\n;` }),
]);

function serviceSchemaProtocolOptions(options: object): PostgresServiceProtocolV2SchemaOptions | undefined {
  const protocolVersion = (options as { readonly protocolVersion?: unknown }).protocolVersion;
  if (!Object.hasOwn(options, "protocolVersion") && protocolVersion !== undefined) {
    throw new Error("Inherited protocol selection is not explicit authorization");
  }
  if (protocolVersion === undefined) return undefined;
  if (protocolVersion !== 2) throw new Error("Service schema protocol selection must explicitly request version two");
  return Object.freeze({ protocolVersion });
}

/** Zero arguments retain the immutable legacy plan for audit; V2 evidence requires an explicit additive plan selection. */
export function createPostgresServiceSchema(options?: PostgresServiceProtocolV2SchemaOptions): ReturnType<typeof legacyPostgresServiceSchema> {
  const legacy = legacyPostgresServiceSchema();
  if (options === undefined) return legacy;
  if (!options || Object.keys(options).join(",") !== "protocolVersion" || options.protocolVersion !== 2) {
    throw new Error("Service schema protocol selection rejects untrusted module definitions or implicit upgrades");
  }
  if (legacy.plan.version !== 2) throw new Error("Protocol V2 must append to the reviewed immutable physical schema version two");
  const plan = createPostgresBusinessSchemaPlan([...legacy.plan.migrations,
    { version: 3, modules: ["migration-cutover-protocol-v2"] }], { trustedModules: POSTGRES_SERVICE_SCHEMA_PROTOCOL_V2_MODULES });
  const addedTables = [...POSTGRES_SERVICE_SCHEMA_PROTOCOL_V2_MODULES.at(-1)!.sql.matchAll(/CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)/g)].map(match => match[1]!);
  if (addedTables.join(",") !== "migration_cutover_transitions_v2,migration_cutover_first_write_markers") {
    throw new Error("Protocol V2 authority table contract changed without a reviewed schema version");
  }
  return Object.freeze({ ...legacy, plan, trustedModules: POSTGRES_SERVICE_SCHEMA_PROTOCOL_V2_MODULES,
    supportTables: Object.freeze([...legacy.supportTables, ...addedTables]) });
}

export async function installPostgresServiceSchema(
  executor: Parameters<typeof legacyInstallPostgresServiceSchema>[0],
  options: Parameters<typeof legacyInstallPostgresServiceSchema>[1] & { readonly protocolVersion?: 2 },
): ReturnType<typeof legacyInstallPostgresServiceSchema> {
  if (["plan", "trustedModules", "sql"].some(key => Object.hasOwn(options, key))) {
    throw new Error("Service schema installation requires code-owned definitions, not manifest SQL");
  }
  return legacyInstallPostgresServiceSchema(executor, options);
}

export function createPostgresServiceSchemaGrantPlan(
  options: Parameters<typeof legacyPostgresServiceSchemaGrantPlan>[0] & { readonly protocolVersion?: 2 },
): ReturnType<typeof legacyPostgresServiceSchemaGrantPlan> {
  return legacyPostgresServiceSchemaGrantPlan(options);
}
