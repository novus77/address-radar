import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { validatePostgresBusinessTarget, type PostgresBusinessTarget } from "./postgres-business-driver.js";
import type { PostgresBusinessRuntime } from "./postgres-business-driver.js";
import { POSTGRES_CAPTURE_INBOX_SCHEMA_SQL } from "./postgres-capture-inbox.js";
import { POSTGRES_CAPTURE_HEALTH_SCHEMA_SQL } from "./postgres-capture-health.js";
import { POSTGRES_NORMALIZATION_SCHEMA_SQL } from "./postgres-normalization-work.js";
import { POSTGRES_CONSUMER_WORK_SCHEMA_SQL } from "./postgres-consumer-work.js";
import { POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL } from "./postgres-forward-purchases.js";
import { POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL } from "./postgres-forward-token-watch.js";
import { POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL } from "./forward-opportunity-store.js";
import { POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL } from "./forward-opportunity-work.js";
import { POSTGRES_FORWARD_OPPORTUNITY_FANOUT_SCHEMA_SQL } from "./forward-opportunity-fanout.js";
import { POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL } from "./forward-trader-capability-store.js";
import { POSTGRES_FORWARD_TRADER_CAPABILITY_WORK_SCHEMA_SQL } from "./forward-trader-capability-work.js";
import { POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL } from "./forward-target-authorization-store.js";
import { POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL } from "./forward-target-revalidation.js";
import { POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL } from "./forward-target-refresh-coordinator.js";
import { POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL } from "./forward-signal-projection.js";

export type PostgresBusinessSchemaModuleId =
  | "capture-inbox" | "capture-health" | "normalization" | "consumer-work" | "forward-purchases"
  | "token-watch" | "opportunity" | "opportunity-work" | "opportunity-fanout" | "trader-capability"
  | "trader-capability-work" | "target-authorization" | "target-revalidation" | "target-refresh" | "signal";

export interface PostgresBusinessSchemaModule {
  readonly id: PostgresBusinessSchemaModuleId;
  readonly dependencies: readonly PostgresBusinessSchemaModuleId[];
  readonly sql: string;
}

const module = (id: PostgresBusinessSchemaModuleId, sql: string,
  dependencies: readonly PostgresBusinessSchemaModuleId[] = []): PostgresBusinessSchemaModule =>
  Object.freeze({ id, sql, dependencies: Object.freeze([...dependencies]) });

export const POSTGRES_BUSINESS_SCHEMA_MODULES: readonly PostgresBusinessSchemaModule[] = Object.freeze([
  module("capture-inbox", POSTGRES_CAPTURE_INBOX_SCHEMA_SQL),
  module("capture-health", POSTGRES_CAPTURE_HEALTH_SCHEMA_SQL),
  module("normalization", POSTGRES_NORMALIZATION_SCHEMA_SQL, ["capture-inbox"]),
  module("consumer-work", POSTGRES_CONSUMER_WORK_SCHEMA_SQL, ["normalization"]),
  module("forward-purchases", POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL, ["normalization"]),
  module("token-watch", POSTGRES_FORWARD_TOKEN_WATCH_SCHEMA_SQL, ["forward-purchases"]),
  module("opportunity", POSTGRES_FORWARD_OPPORTUNITY_SCHEMA_SQL, ["forward-purchases"]),
  module("opportunity-work", POSTGRES_FORWARD_OPPORTUNITY_WORK_SCHEMA_SQL, ["opportunity"]),
  module("opportunity-fanout", POSTGRES_FORWARD_OPPORTUNITY_FANOUT_SCHEMA_SQL, ["opportunity"]),
  module("trader-capability", POSTGRES_FORWARD_TRADER_CAPABILITY_SCHEMA_SQL, ["forward-purchases"]),
  module("trader-capability-work", POSTGRES_FORWARD_TRADER_CAPABILITY_WORK_SCHEMA_SQL, ["trader-capability"]),
  module("target-authorization", POSTGRES_FORWARD_TARGET_AUTHORIZATION_SCHEMA_SQL),
  module("target-revalidation", POSTGRES_FORWARD_TARGET_REVALIDATION_SCHEMA_SQL, ["target-authorization"]),
  module("target-refresh", POSTGRES_FORWARD_TARGET_REFRESH_COORDINATOR_SCHEMA_SQL, ["forward-purchases"]),
  module("signal", POSTGRES_FORWARD_SIGNAL_SCHEMA_SQL, ["forward-purchases", "target-revalidation"]),
]);

export interface PostgresBusinessSchemaTrustedModule {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly sql: string;
}

export interface PostgresBusinessSchemaPlanOptions {
  // Definitions come from reviewed application composition code, never a persisted plan or import manifest.
  readonly trustedModules?: readonly PostgresBusinessSchemaTrustedModule[];
}

const builtinRegistry: ReadonlyMap<string, PostgresBusinessSchemaTrustedModule> =
  new Map(POSTGRES_BUSINESS_SCHEMA_MODULES.map(entry => [entry.id, entry]));
const defaultSteps = Object.freeze([Object.freeze({ version: 1,
  modules: Object.freeze(POSTGRES_BUSINESS_SCHEMA_MODULES.map(entry => entry.id)),
})]);
const moduleIdentifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Split reviewed DDL without treating quoted defaults or comments as statements.
// This is a narrow CREATE TABLE/INDEX contract, not a general SQL authorization parser.
function trustedStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = "";
  let quote: string | undefined;
  let escaped = false;
  let dollar: string | undefined;
  let blockDepth = 0;
  let lineComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") { lineComment = false; statement += char; }
    } else if (blockDepth) {
      if (char === "/" && next === "*") { blockDepth += 1; index += 1; }
      else if (char === "*" && next === "/") { blockDepth -= 1; index += 1; }
    } else if (dollar) {
      if (sql.startsWith(dollar, index)) { statement += dollar; index += dollar.length - 1; dollar = undefined; }
      else statement += char;
    } else if (quote) {
      statement += char;
      if (escaped && char === "\\" && next !== undefined) { statement += next; index += 1; }
      else if (char === quote) {
        if (next === quote) { statement += next; index += 1; }
        else quote = undefined;
      }
    } else if (char === "-" && next === "-") { statement += " "; lineComment = true; index += 1;
    } else if (char === "/" && next === "*") { statement += " "; blockDepth = 1; index += 1;
    } else if (char === "'" || char === '"') {
      escaped = char === "'" && /(?:^|[^a-z0-9_])e$/i.test(statement);
      quote = char; statement += char;
    } else if (char === "$" && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(index))) {
      dollar = sql.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)![0];
      statement += dollar; index += dollar.length - 1;
    } else if (char === ";") {
      if (statement.trim()) statements.push(statement.trim());
      statement = "";
    } else statement += char;
  }
  if (quote || dollar || blockDepth) throw new Error("Trusted schema DDL contains an unterminated quote or comment");
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

function compileTrustedDdl(sql: string): string {
  const statements = trustedStatements(sql);
  if (!statements.length) throw new Error("Trusted schema module DDL must be nonempty");
  for (const statement of statements) {
    const declaration = statement.match(/^CREATE\s+(?:TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(|(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ON\s+([a-z_][a-z0-9_]*)\s*(?:USING\s+[a-z_][a-z0-9_]*\s*)?\()/);
    const name = declaration?.[1] ?? declaration?.[2];
    if (!name || name.length > 63 || (declaration?.[3]?.length ?? 0) > 63
      || ["business_schema_identity", "business_schema_ledger"].includes(name)) {
      throw new Error("Trusted schema DDL requires unqualified permanent CREATE TABLE/INDEX without reserved ledger names");
    }
  }
  return statements.map(statement => statement.replace(
    /^(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+)IF\s+NOT\s+EXISTS\s+/, "$1",
  )).join(";\n") + ";";
}

function buildRegistry(trustedModules: readonly PostgresBusinessSchemaTrustedModule[] = []): ReadonlyMap<string, PostgresBusinessSchemaTrustedModule> {
  if (!Array.isArray(trustedModules) || trustedModules.length > 64) {
    throw new Error("Trusted schema module definitions must be an explicit bounded array");
  }
  const registry = new Map(builtinRegistry);
  let sqlBytes = 0;
  for (const definition of trustedModules) {
    if (!definition || typeof definition.id !== "string" || !moduleIdentifier.test(definition.id) || definition.id.length > 63
      || registry.has(definition.id) || !Array.isArray(definition.dependencies) || definition.dependencies.length > 79
      || definition.dependencies.some((id: string) => typeof id !== "string" || !moduleIdentifier.test(id) || id.length > 63 || id === definition.id)
      || new Set(definition.dependencies).size !== definition.dependencies.length
      || typeof definition.sql !== "string" || !definition.sql.trim() || Buffer.byteLength(definition.sql) > 1_048_576) {
      throw new Error("Trusted schema module definition is invalid, duplicated or overwrites an existing ID");
    }
    sqlBytes += Buffer.byteLength(definition.sql);
    if (sqlBytes > 4_194_304) throw new Error("Trusted schema module DDL exceeds its resource budget");
    registry.set(definition.id, Object.freeze({ id: definition.id, dependencies: Object.freeze([...definition.dependencies]),
      sql: compileTrustedDdl(definition.sql) }));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    const entry = registry.get(id);
    if (!entry || visiting.has(id)) throw new Error("Trusted schema module dependency is unknown or cyclic");
    visiting.add(id);
    for (const dependency of entry.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of registry.keys()) visit(id);
  return registry;
}

const executableDdl = (entry: PostgresBusinessSchemaTrustedModule): string =>
  builtinRegistry.has(entry.id) ? strictDdl(entry.sql) : entry.sql;
const strictDdl = (sql: string): string => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/g, "");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL = `
CREATE TABLE business_schema_identity (
  singleton boolean PRIMARY KEY CHECK(singleton=true),
  ledger_format integer NOT NULL CHECK(ledger_format=1),
  database_name text NOT NULL, schema_name text NOT NULL, generation_id text NOT NULL,
  installed_by text NOT NULL, approval_ref text NOT NULL, installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE business_schema_ledger (
  version integer PRIMARY KEY CHECK(version>0), fingerprint text NOT NULL CHECK(fingerprint~'^[a-f0-9]{64}$'),
  previous_fingerprint text NOT NULL CHECK(previous_fingerprint~'^[a-f0-9]{64}$'),
  modules_json text NOT NULL, installed_by text NOT NULL, approval_ref text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;

export interface PostgresBusinessSchemaStep {
  readonly version: number;
  readonly modules: readonly string[];
}

export interface PostgresBusinessSchemaMigration extends PostgresBusinessSchemaStep {
  readonly previousFingerprint: string;
  readonly fingerprint: string;
}

export interface PostgresBusinessSchemaPlan {
  readonly version: number;
  readonly fingerprint: string;
  readonly migrations: readonly PostgresBusinessSchemaMigration[];
}

export function createPostgresBusinessSchemaPlan(
  steps: readonly PostgresBusinessSchemaStep[] = defaultSteps,
  options: PostgresBusinessSchemaPlanOptions = {},
): PostgresBusinessSchemaPlan {
  return composePlan(steps, buildRegistry(options.trustedModules));
}

function composePlan(
  steps: readonly PostgresBusinessSchemaStep[],
  registry: ReadonlyMap<string, PostgresBusinessSchemaTrustedModule>,
): PostgresBusinessSchemaPlan {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > registry.size) {
    throw new Error("PostgreSQL business schema requires a bounded ordered migration plan");
  }
  let previousFingerprint = digest({ ledgerFormat: 1, ledgerSql: POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL });
  const installed = new Set<string>();
  const includesBuiltin = steps.some(step => Array.isArray(step?.modules)
    && step.modules.some((id: string) => builtinRegistry.has(id)));
  const migrations = steps.map((step, index) => {
    if (!step || Object.hasOwn(step, "sql") || Object.hasOwn(step, "trustedModules")
      || step.version !== index + 1 || !Array.isArray(step.modules) || step.modules.length === 0
      || step.modules.length > registry.size) {
      throw new Error("PostgreSQL business schema versions must be contiguous and nonempty");
    }
    const modules = step.modules.map((id: string) => {
      const entry = registry.get(id);
      if (!entry || installed.has(id) || entry.dependencies.some(dependency => !installed.has(dependency))) {
        throw new Error("PostgreSQL business schema module is unknown, duplicated or out of dependency order");
      }
      if (includesBuiltin && index === 0 && !builtinRegistry.has(id)) {
        throw new Error("Trusted business extensions must append after version one");
      }
      installed.add(id);
      // Keep the original built-in hash tuples byte-for-byte; new tuples bind their dependency contract too.
      return builtinRegistry.has(id) ? [entry.id, executableDdl(entry)]
        : [entry.id, executableDdl(entry), entry.dependencies];
    });
    const fingerprint = digest({ previousFingerprint, version: step.version, modules });
    const migration = Object.freeze({ version: step.version, modules: Object.freeze([...step.modules]), previousFingerprint, fingerprint });
    previousFingerprint = fingerprint;
    return migration;
  });
  return Object.freeze({ version: migrations.length, fingerprint: previousFingerprint, migrations: Object.freeze(migrations) });
}

export const POSTGRES_BUSINESS_SCHEMA_PLAN = createPostgresBusinessSchemaPlan();

export interface PostgresBusinessProvisionedNamespaceReceipt {
  readonly version: 1;
  readonly purpose: "provisioned-empty-business-namespace";
  readonly receiptId: string;
  readonly signerKeyId: string;
  readonly approvalRef: string;
  readonly database: string;
  readonly databaseOid: string;
  readonly schema: string;
  readonly namespaceOid: string;
  readonly owner: string;
  readonly ownerOid: string;
  readonly generation: string;
  readonly service: "migration";
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly systemIdentifier: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface PostgresBusinessSignedNamespaceReceipt {
  readonly receipt: PostgresBusinessProvisionedNamespaceReceipt;
  readonly signatureBase64: string;
}

export interface PostgresBusinessNamespaceAuthority {
  // Install this key through independently approved authority configuration, never from the receipt or a plan manifest.
  readonly signerKeyId: string;
  readonly publicKeyPem: string;
  readonly maximumReceiptAgeMs: number;
  readonly clock: () => number;
}

const namespaceApprovalBrand: unique symbol = Symbol("authenticated-provisioned-business-namespace");
export interface PostgresBusinessProvisionedNamespaceApproval {
  readonly [namespaceApprovalBrand]: true;
}
interface NamespaceApprovalState {
  readonly receipt: Readonly<PostgresBusinessProvisionedNamespaceReceipt>;
  readonly clock: () => number;
  readonly maximumReceiptAgeMs: number;
}
const namespaceApprovals = new WeakMap<PostgresBusinessProvisionedNamespaceApproval, NamespaceApprovalState>();
const namespaceReceiptFields = Object.freeze([
  "version", "purpose", "receiptId", "signerKeyId", "approvalRef", "database", "databaseOid", "schema",
  "namespaceOid", "owner", "ownerOid", "generation", "service", "schemaVersion", "schemaFingerprint",
  "systemIdentifier", "issuedAt", "expiresAt",
] as const);
const approvalReference = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const oidPin = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value)
  && BigInt(value) <= 4_294_967_295n;

function namespaceReceipt(value: PostgresBusinessProvisionedNamespaceReceipt): Readonly<PostgresBusinessProvisionedNamespaceReceipt> {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join("\n") !== [...namespaceReceiptFields].sort().join("\n")) {
    refuse("Provisioned namespace receipt requires exact authenticated fields");
  }
  const receipt = Object.freeze({ ...value });
  if (receipt.version !== 1 || receipt.purpose !== "provisioned-empty-business-namespace" || receipt.service !== "migration"
    || typeof receipt.receiptId !== "string" || !approvalReference.test(receipt.receiptId)
    || typeof receipt.signerKeyId !== "string" || !approvalReference.test(receipt.signerKeyId)
    || typeof receipt.approvalRef !== "string" || !approvalReference.test(receipt.approvalRef)
    || !oidPin(receipt.databaseOid) || !oidPin(receipt.namespaceOid) || !oidPin(receipt.ownerOid)
    || typeof receipt.systemIdentifier !== "string" || !/^[1-9][0-9]{0,19}$/.test(receipt.systemIdentifier)
    || BigInt(receipt.systemIdentifier) > 18_446_744_073_709_551_615n
    || !Number.isSafeInteger(receipt.schemaVersion) || receipt.schemaVersion < 1 || receipt.schemaVersion > 79
    || typeof receipt.schemaFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.schemaFingerprint)
    || !Number.isSafeInteger(receipt.issuedAt) || receipt.issuedAt < 0
    || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= receipt.issuedAt) {
    refuse("Provisioned namespace receipt pins or scope are invalid");
  }
  validatePostgresBusinessTarget({ database: receipt.database, username: receipt.owner, schema: receipt.schema,
    generation: receipt.generation, service: receipt.service });
  return receipt;
}

/** Domain-separated signing bytes for an external provisioner/reviewer; this does not authenticate or authorize SQL. */
export function postgresBusinessNamespaceReceiptSigningPayload(receipt: PostgresBusinessProvisionedNamespaceReceipt): string {
  const validated = namespaceReceipt(receipt);
  return "address-radar:provisioned-business-namespace:v1\n" + JSON.stringify(
    Object.fromEntries(namespaceReceiptFields.map(field => [field, validated[field]])),
  );
}

function freshNamespaceApproval(state: NamespaceApprovalState): void {
  let now: number;
  try { now = state.clock(); } catch { refuse("Provisioned namespace authority clock is unavailable"); }
  if (!Number.isSafeInteger(now) || now < state.receipt.issuedAt || now >= state.receipt.expiresAt
    || now - state.receipt.issuedAt > state.maximumReceiptAgeMs
    || state.receipt.expiresAt - state.receipt.issuedAt > state.maximumReceiptAgeMs) {
    refuse("Provisioned namespace approval is expired, future-dated or exceeds its time budget");
  }
}

/** Authenticate outside installer manifests, then compose this capability with the migration runtime's independent gate. */
export function authenticatePostgresBusinessNamespaceReceipt(
  proof: PostgresBusinessSignedNamespaceReceipt,
  authority: PostgresBusinessNamespaceAuthority,
): PostgresBusinessProvisionedNamespaceApproval {
  if (!proof || Object.keys(proof).sort().join(",") !== "receipt,signatureBase64"
    || !authority || typeof authority.clock !== "function"
    || !Number.isSafeInteger(authority.maximumReceiptAgeMs) || authority.maximumReceiptAgeMs < 1
    || authority.maximumReceiptAgeMs > 900_000
    || typeof authority.publicKeyPem !== "string" || Buffer.byteLength(authority.publicKeyPem) > 16_384
    || typeof proof.signatureBase64 !== "string" || proof.signatureBase64.length !== 88) {
    refuse("Provisioned namespace approval requires a bounded external signature authority");
  }
  const receipt = namespaceReceipt(proof.receipt);
  if (authority.signerKeyId !== receipt.signerKeyId) refuse("Provisioned namespace signer is not the approved authority");
  let authenticated = false;
  try {
    const key = createPublicKey(authority.publicKeyPem);
    const signature = Buffer.from(proof.signatureBase64, "base64");
    authenticated = key.asymmetricKeyType === "ed25519" && signature.length === 64
      && signature.toString("base64") === proof.signatureBase64
      && verifySignature(null, Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(receipt)), key, signature);
  } catch { refuse("Provisioned namespace signature is invalid"); }
  if (!authenticated) refuse("Provisioned namespace signature is invalid");
  const state = Object.freeze({ receipt, clock: authority.clock, maximumReceiptAgeMs: authority.maximumReceiptAgeMs });
  freshNamespaceApproval(state);
  const capability: PostgresBusinessProvisionedNamespaceApproval = Object.freeze({ [namespaceApprovalBrand]: true as const });
  namespaceApprovals.set(capability, state);
  return capability;
}

export interface PostgresBusinessSchemaInstallerOptions extends PostgresBusinessSchemaPlanOptions {
  readonly target: PostgresBusinessTarget;
  readonly approval: "approved-new-business-schema" | "approved-isolated-business-schema" | "approved-provisioned-business-schema";
  readonly provisionedNamespaceApproval?: PostgresBusinessProvisionedNamespaceApproval;
  readonly approvalRef: string;
  readonly plan?: PostgresBusinessSchemaPlan;
}

export interface PostgresBusinessSchemaReceipt {
  readonly database: string;
  readonly schema: string;
  readonly generation: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly appliedVersions: readonly number[];
  readonly status: "installed" | "already-installed";
  readonly namespaceReceiptId?: string;
  readonly namespaceOid?: string;
}

export class PostgresBusinessSchemaRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresBusinessSchemaRefusalError";
  }
}

function refuse(message: string): never { throw new PostgresBusinessSchemaRefusalError(message); }

// The executor must be a dedicated migration-role unit of work, not the restricted business runtime.
// A commit-unknown error is propagated unchanged: reconnect and reconcile this ledger before retrying.
export async function installPostgresBusinessSchema(
  executor: Pick<PostgresBusinessRuntime, "run">,
  options: PostgresBusinessSchemaInstallerOptions,
): Promise<PostgresBusinessSchemaReceipt> {
  const target = validatePostgresBusinessTarget(options.target);
  if (!["approved-new-business-schema", "approved-isolated-business-schema", "approved-provisioned-business-schema"].includes(options.approval)
    || typeof options.approvalRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(options.approvalRef)) {
    refuse("PostgreSQL business schema installation requires explicit scoped approval");
  }
  const supplied = options.plan ?? POSTGRES_BUSINESS_SCHEMA_PLAN;
  // Snapshot the caller-owned registry before awaiting any SQL; plans carry IDs and hashes, never executable definitions.
  const registry = buildRegistry(options.trustedModules);
  const plan = composePlan(supplied.migrations, registry);
  if (supplied.version !== plan.version || supplied.fingerprint !== plan.fingerprint
    || supplied.migrations.some((entry, index) => entry.fingerprint !== plan.migrations[index]?.fingerprint
      || entry.previousFingerprint !== plan.migrations[index]?.previousFingerprint)) {
    refuse("PostgreSQL business schema plan fingerprint mismatch");
  }
  const approval = options.approval;
  const approvalRef = options.approvalRef;
  const provisioned = approval === "approved-provisioned-business-schema"
    ? namespaceApprovals.get(options.provisionedNamespaceApproval as PostgresBusinessProvisionedNamespaceApproval) : undefined;
  if (approval === "approved-provisioned-business-schema") {
    if (!provisioned) refuse("Provisioned namespace installation requires authenticated external approval");
    freshNamespaceApproval(provisioned);
    const receipt = provisioned.receipt;
    if (receipt.database !== target.database || receipt.schema !== target.schema || receipt.owner !== target.username
      || receipt.generation !== target.generation || receipt.service !== target.service || target.service !== "migration"
      || receipt.approvalRef !== approvalRef || receipt.schemaVersion !== plan.version || receipt.schemaFingerprint !== plan.fingerprint) {
      refuse("Provisioned namespace approval does not bind the exact installation scope");
    }
  } else if (options.provisionedNamespaceApproval !== undefined) {
    refuse("Provisioned namespace capability requires its explicit approval mode");
  }

  const schema = `"${target.schema}"`;
  const appliedVersions: number[] = [];
  return executor.run(async tx => {
    // All versions and generations for this namespace share one transaction-scoped lock.
    await tx.query("/* business-schema-lock */ SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`address-radar:business-schema:${target.database}:${target.schema}`]);
    const identity = (await tx.query(`/* business-schema-installer-identity */
      SELECT current_database() AS database,current_user AS username,session_user AS session_username,
        NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER')
          AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)) AS role_safe`)).rows[0];
    if (!identity || identity.database !== target.database || identity.username !== target.username
      || identity.session_username !== target.username || identity.role_safe !== true) {
      refuse("PostgreSQL business schema installer identity or migration role mismatch");
    }
    const namespaceSql = `/* business-schema-namespace */ SELECT n.oid,n.oid::text AS namespace_oid,
      n.nspowner::text AS namespace_owner_oid,r.rolname AS namespace_owner,d.oid::text AS database_oid
      FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
      JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE n.nspname=$1`;
    const namespace = (await tx.query(namespaceSql, [target.schema])).rows[0];
    const verifyProvisionedNamespace = async (observed: Record<string, unknown> | undefined): Promise<void> => {
      if (!provisioned) return;
      freshNamespaceApproval(provisioned);
      const receipt = provisioned.receipt;
      if (!observed || observed.namespace_oid !== receipt.namespaceOid || observed.namespace_owner_oid !== receipt.ownerOid
        || observed.namespace_owner !== receipt.owner || observed.database_oid !== receipt.databaseOid) {
        refuse("Provisioned namespace catalog owner or identity pins do not match external approval");
      }
      const cluster = (await tx.query(`/* business-schema-provisioned-cluster */ SELECT system_identifier::text AS system_identifier,
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(session_user,r.oid,'SET')
          AND pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')) AS database_create,
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(session_user,r.oid,'SET')
          AND pg_catalog.has_database_privilege(r.oid,current_database(),'TEMP')) AS database_temp
        FROM pg_catalog.pg_control_system()`)).rows[0];
      if (!cluster || cluster.system_identifier !== receipt.systemIdentifier
        || cluster.database_create !== false || cluster.database_temp !== false) {
        refuse("Provisioned namespace cluster pin or restricted database privileges do not match approval");
      }
    };
    await verifyProvisionedNamespace(namespace);
    if (!namespace) {
      await tx.query(`CREATE SCHEMA ${schema}`);
    }
    await tx.query("/* business-schema-search-path */ SELECT set_config('search_path',$1,true)", [`${schema},pg_catalog,pg_temp`]);
    const presence = (await tx.query(`/* business-schema-presence */ SELECT
      i.oid IS NOT NULL AS identity_exists,l.oid IS NOT NULL AS ledger_exists,
      COALESCE(i.relkind='r' AND i.relpersistence='p',false) AS identity_valid,
      COALESCE(l.relkind='r' AND l.relpersistence='p',false) AS ledger_valid
      FROM (VALUES(1)) AS singleton(value)
      LEFT JOIN pg_catalog.pg_class i ON i.oid=pg_catalog.to_regclass($1)
      LEFT JOIN pg_catalog.pg_class l ON l.oid=pg_catalog.to_regclass($2)`,
    [`${schema}.business_schema_identity`, `${schema}.business_schema_ledger`])).rows[0];
    if (!presence || ["identity_exists", "ledger_exists", "identity_valid", "ledger_valid"]
      .some(key => typeof presence[key] !== "boolean")) {
      refuse("PostgreSQL business schema catalog probe returned no evidence");
    }
    if ((presence.identity_exists && presence.identity_valid !== true)
      || (presence.ledger_exists && presence.ledger_valid !== true)) {
      refuse("PostgreSQL business schema reserved objects must be permanent ordinary tables");
    }
    if (presence.identity_exists !== presence.ledger_exists) refuse("PostgreSQL business schema ledger collision");
    const initialized = presence.identity_exists;
    if (!initialized) {
      const objects = await tx.query(`/* business-schema-empty */ SELECT 1 AS occupied FROM pg_namespace n
        WHERE n.nspname=$1 AND (EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid)
          OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid)
          OR EXISTS(SELECT 1 FROM pg_type t WHERE t.typnamespace=n.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_namespace'::regclass
            AND d.refobjid=n.oid)) LIMIT 1`, [target.schema]);
      if (objects.rows.length) refuse("PostgreSQL business schema is occupied without a matching ledger");
      if (namespace && approval === "approved-new-business-schema") refuse("New business schema approval cannot adopt an existing namespace");
      await tx.query(POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL);
      await tx.query(`INSERT INTO ${schema}.business_schema_identity
        (singleton,ledger_format,database_name,schema_name,generation_id,installed_by,approval_ref)
        VALUES(true,1,$1,$2,$3,$4,$5)`, [target.database,target.schema,target.generation,target.username,approvalRef]);
    }
    const header = (await tx.query(`/* business-schema-header */ SELECT singleton,ledger_format,database_name,schema_name,generation_id
      FROM ${schema}.business_schema_identity`)).rows;
    if (header.length !== 1 || header[0]?.singleton !== true || header[0]?.ledger_format !== 1
      || header[0]?.database_name !== target.database || header[0]?.schema_name !== target.schema
      || header[0]?.generation_id !== target.generation) refuse("PostgreSQL business schema identity or generation collision");
    const history = (await tx.query(`/* business-schema-history */ SELECT version,fingerprint,previous_fingerprint,modules_json
      FROM ${schema}.business_schema_ledger ORDER BY version`)).rows;
    if (history.length > plan.migrations.length || (initialized && history.length === 0)) {
      refuse("PostgreSQL business schema ledger is incomplete or newer than the approved plan");
    }
    for (let index = 0; index < history.length; index += 1) {
      const row = history[index]!;
      const expected = plan.migrations[index]!;
      if (row.version !== expected.version || row.fingerprint !== expected.fingerprint
        || row.previous_fingerprint !== expected.previousFingerprint || row.modules_json !== JSON.stringify(expected.modules)) {
        refuse("PostgreSQL business schema ordered fingerprint collision");
      }
    }
    for (const migration of plan.migrations.slice(history.length)) {
      for (const id of migration.modules) {
        const entry = registry.get(id)!;
        const sql = executableDdl(entry);
        const names = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/g)]
          .map(match => match[1]!);
        // Existing IF NOT EXISTS module DDL must never conceal a pre-existing object.
        const collisions = await tx.query(`/* business-schema-collisions */ SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`, [target.schema,names]);
        if (collisions.rows.length) refuse("PostgreSQL business schema module object collision");
        await tx.query(sql);
      }
      await tx.query(`INSERT INTO ${schema}.business_schema_ledger
        (version,fingerprint,previous_fingerprint,modules_json,installed_by,approval_ref) VALUES($1,$2,$3,$4,$5,$6)`,
      [migration.version,migration.fingerprint,migration.previousFingerprint,JSON.stringify(migration.modules),target.username,approvalRef]);
      appliedVersions.push(migration.version);
    }
    if (provisioned) await verifyProvisionedNamespace((await tx.query(namespaceSql, [target.schema])).rows[0]);
    return Object.freeze({ database: target.database, schema: target.schema, generation: target.generation,
      ...(provisioned ? { namespaceReceiptId: provisioned.receipt.receiptId, namespaceOid: provisioned.receipt.namespaceOid } : {}),
      version: plan.version, fingerprint: plan.fingerprint, appliedVersions: Object.freeze([...appliedVersions]),
      status: appliedVersions.length ? "installed" : "already-installed" });
  });
}
