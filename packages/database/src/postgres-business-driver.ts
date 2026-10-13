import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { createPostgresRetirementClient } from "./postgres-connection-retirement.js";
import {
  createPostgresUnitOfWork,
  type PostgresPool,
  type PostgresResult,
} from "./postgres-unit-of-work.js";

export interface PostgresBusinessTarget {
  readonly database: string;
  readonly username: string;
  readonly schema: string;
  readonly generation: string;
  readonly service: string;
}

export interface PostgresBusinessOptions {
  readonly connectionString: string;
  readonly target: PostgresBusinessTarget;
  readonly access: "read" | "runtime";
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly ssl: false | { readonly ca: string; readonly rejectUnauthorized: true };
  readonly maximumConnections: number;
  readonly serviceConnectionBudgets: Readonly<Record<string, number>>;
  readonly serverMaximumConnections: number;
  readonly reservedConnections: number;
  readonly maximumPendingOperations: number;
  readonly connectionTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly workMemKb: number;
}

export interface PostgresBusinessIdentity extends PostgresBusinessTarget {
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
}

export interface PostgresBusinessStatistics {
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly waitingConnections: number;
  readonly activeOperations: number;
  readonly idleErrorCount: number;
  readonly lastIdleSqlState: string | null;
  readonly state: "ready" | "closing" | "closed";
}

export interface PostgresBusinessRuntime {
  readonly run: ReturnType<typeof createPostgresUnitOfWork>["run"];
  probe(): Promise<PostgresBusinessIdentity>;
  statistics(): PostgresBusinessStatistics;
  close(): Promise<void>;
}

export class PostgresBusinessShutdownTimeoutError extends Error {
  constructor() {
    super("PostgreSQL business shutdown exceeded its budget; draining continues without acknowledging unfinished work");
    this.name = "PostgresBusinessShutdownTimeoutError";
  }
}

const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const isolated = /(?:^|_)(?:acceptance|test)(?:_|$)/i;

export function validatePostgresBusinessTarget(target: PostgresBusinessTarget): Readonly<PostgresBusinessTarget> {
  if (!target || [target.database, target.username, target.schema].some(value =>
    typeof value !== "string" || !identifier.test(value) || isolated.test(value) || value.startsWith("pg_"))
    || ["postgres", "template0", "template1"].includes(target.database)
    || target.username === "postgres"
    || ["public", "information_schema"].includes(target.schema)
    || typeof target.generation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(target.generation)
    || typeof target.service !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(target.service)) {
    throw new Error("PostgreSQL business requires an explicit non-acceptance database, role, schema, generation and service");
  }
  return Object.freeze({ database: target.database, username: target.username, schema: target.schema,
    generation: target.generation, service: target.service });
}

const positive = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;

// Inspect ACLs and inherited authority for every role reachable by SET ROLE.
// Callable user SECURITY DEFINER routines are refused because body inspection cannot prove confinement.
// Fixed reviewed authority boundary; caller options cannot widen these privileges.
const protectedAuthorityTables = Object.freeze(["business_schema_identity","business_schema_ledger","migration_cutover_transitions","wallet_service_import_ledger","wallet_service_profile_cohort","wallet_service_profile_versions","wallet_service_fact_inputs","wallet_service_fact_validators","wallet_service_fact_attestations","migration_cutover_transitions_v2","migration_cutover_first_write_markers"]);
const mutableProviderBudgetColumns = Object.freeze(["window_started_at","requests_used","cooldown_until"]);

const PRIVILEGE_PROBE_SQL = `/* business-privileges */
WITH set_roles AS MATERIALIZED (
  SELECT r.oid FROM pg_catalog.pg_roles r
  WHERE r.rolname=current_user OR pg_catalog.pg_has_role(session_user,r.oid,'SET')
)
SELECT
  NOT EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_roles r
    WHERE pg_catalog.pg_has_role(a.oid,r.oid,'USAGE')
    AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
      OR r.rolname IN ('pg_write_all_data','pg_read_all_data','pg_read_server_files',
        'pg_write_server_files','pg_execute_server_program','pg_signal_backend','pg_checkpoint'))) AS role_safe,
  EXISTS (SELECT 1 FROM set_roles a
    WHERE pg_catalog.has_database_privilege(a.oid,current_database(),'CREATE')) AS database_create,
  EXISTS (SELECT 1 FROM set_roles a
    WHERE pg_catalog.has_database_privilege(a.oid,current_database(),'TEMP')) AS database_temp,
  pg_catalog.has_schema_privilege(current_user,$1,'USAGE') AS schema_usage,
  EXISTS (SELECT 1 FROM set_roles a
    WHERE pg_catalog.has_schema_privilege(a.oid,$1,'CREATE')) AS schema_create,
  EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_namespace n WHERE n.nspname=$1
    AND pg_catalog.pg_has_role(a.oid,n.nspowner,'USAGE')) AS schema_owner,
  EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_namespace n
    WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND n.nspname<>$1
      AND pg_catalog.has_schema_privilege(a.oid,n.oid,'CREATE'))
  OR EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND n.nspname<>$1
    AND ((c.relkind IN ('r','p','v','m','f') AND
      (pg_catalog.has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'INSERT,UPDATE,REFERENCES')
        OR pg_catalog.pg_has_role(a.oid,c.relowner,'USAGE')))
      OR (c.relkind='S' AND pg_catalog.has_sequence_privilege(a.oid,c.oid,'USAGE,UPDATE')))) AS outside_write,
  EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND
      (pg_catalog.pg_has_role(a.oid,c.relowner,'USAGE')
        OR pg_catalog.has_table_privilege(a.oid,c.oid,'TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'REFERENCES')
        OR ($2::boolean AND (pg_catalog.has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE')
          OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'INSERT,UPDATE')))))
  OR EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='S' AND
      (pg_catalog.pg_has_role(a.oid,c.relowner,'USAGE') OR pg_catalog.has_sequence_privilege(a.oid,c.oid,'UPDATE')
        OR ($2::boolean AND pg_catalog.has_sequence_privilege(a.oid,c.oid,'USAGE'))))
  OR EXISTS (SELECT 1 FROM set_roles a WHERE
    pg_catalog.has_table_privilege(a.oid,$3,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(a.oid,$3,'INSERT,UPDATE,REFERENCES')
    OR pg_catalog.has_table_privilege(a.oid,$4,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR pg_catalog.has_any_column_privilege(a.oid,$4,'INSERT,UPDATE,REFERENCES'))
  OR EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND c.relname=ANY($5::text[])
      AND (pg_catalog.has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'INSERT,UPDATE,REFERENCES')))
  OR EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') AND c.relname='wallet_service_provider_budgets'
      AND (pg_catalog.has_table_privilege(a.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(a.oid,c.oid,'INSERT,REFERENCES')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute b
          WHERE b.attrelid=c.oid AND b.attnum>0 AND NOT b.attisdropped
            AND NOT (b.attname=ANY($6::text[]))
            AND pg_catalog.has_column_privilege(a.oid,c.oid,b.attnum,'UPDATE')))) AS unsafe_privileges,
  EXISTS (SELECT 1 FROM set_roles a CROSS JOIN pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' AND p.prosecdef
      AND pg_catalog.has_function_privilege(a.oid,p.oid,'EXECUTE')) AS unsafe_functions

`;
export function createPostgresBusinessRuntime(options: PostgresBusinessOptions): PostgresBusinessRuntime {
  const target = validatePostgresBusinessTarget(options.target);
  let endpoint: { host: string; port: number; password: string };
  try {
    const url = new URL(options.connectionString);
    const port = Number(url.port);
    const password = decodeURIComponent(url.password);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash
      || !url.hostname || !url.port || !Number.isSafeInteger(port) || port < 1 || port > 65_535
      || decodeURIComponent(url.pathname.slice(1)) !== target.database
      || decodeURIComponent(url.username) !== target.username || !password) throw new Error();
    endpoint = { host: url.hostname === "[::1]" ? "::1" : url.hostname, port, password };
  } catch {
    // Parser errors can contain the credential-bearing input.
    throw new Error("PostgreSQL business connection URL does not match its explicit identity");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.host);
  if ((!loopback && options.ssl === false) || (options.ssl !== false
    && (!options.ssl || options.ssl.rejectUnauthorized !== true || typeof options.ssl.ca !== "string" || !options.ssl.ca.trim()))) {
    throw new Error("PostgreSQL business requires explicit verified TLS outside loopback");
  }
  const budgets = options.serviceConnectionBudgets;
  const allocations = budgets && Object.entries(budgets);
  if (![options.maximumConnections, options.serverMaximumConnections, options.reservedConnections,
    options.connectionTimeoutMs, options.idleTimeoutMs, options.statementTimeoutMs, options.lockTimeoutMs,
    options.idleTransactionTimeoutMs, options.shutdownTimeoutMs, options.workMemKb].every(positive)
    || !Number.isSafeInteger(options.maximumPendingOperations) || options.maximumPendingOperations < 0
    || options.maximumPendingOperations > 10_000 || options.maximumConnections > 64
    || options.workMemKb < 64 || options.workMemKb > 1_048_576
    || options.lockTimeoutMs > options.statementTimeoutMs
    || !allocations?.length || allocations.length > 64
    || allocations.some(([name, value]) => !/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !positive(value) || value > 64)
    || !Object.hasOwn(budgets, target.service) || budgets[target.service] !== options.maximumConnections
    || allocations.reduce((sum, [, value]) => sum + value, options.reservedConnections) > options.serverMaximumConnections
    || !positive(options.schemaVersion) || !/^[a-f0-9]{64}$/.test(options.schemaFingerprint)
    || !["read", "runtime"].includes(options.access)) {
    throw new Error("PostgreSQL business resource limits and schema expectations must be explicit and bounded");
  }
  // Copy caller-owned values so later mutation cannot change the transaction contract.
  const limits = Object.freeze({ ...options, target, serviceConnectionBudgets: Object.freeze({ ...budgets }) });
  const applicationName = `${target.service}:${createHash("sha256").update(target.generation).digest("hex").slice(0,16)}`;
  const physical = createPostgresRetirementClient(limits.maximumConnections, limits.connectionTimeoutMs);
  const pool = new Pool({
    Client: physical.Client,
    host: endpoint.host, port: endpoint.port, database: target.database, user: target.username, password: endpoint.password,
    ssl: options.ssl === false ? false : { ca: options.ssl.ca, rejectUnauthorized: true },
    application_name: applicationName, max: limits.maximumConnections,
    connectionTimeoutMillis: limits.connectionTimeoutMs, idleTimeoutMillis: limits.idleTimeoutMs,
    options: `-c statement_timeout=${limits.statementTimeoutMs} -c lock_timeout=${limits.lockTimeoutMs}`
      + ` -c idle_in_transaction_session_timeout=${limits.idleTransactionTimeoutMs}`
      + ` -c work_mem=${limits.workMemKb}kB -c max_parallel_workers_per_gather=0 -c synchronous_commit=on`
      + ` -c search_path=pg_catalog,${target.schema},pg_temp`,
  });
  let state: PostgresBusinessStatistics["state"] = "ready";
  let activeOperations = 0;
  let idleErrorCount = 0;
  let lastIdleSqlState: string | null = null;
  let shutdown: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  pool.on("error", error => {
    idleErrorCount += 1;
    const code = (error as Error & { code?: unknown }).code;
    lastIdleSqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  });
  const adapter: PostgresPool = {
    async connect() {
      const client = await pool.connect();
      // Pool error listeners cover idle clients only. Poison a checked-out connection without throwing from its event handler.
      let connectionError: Error | undefined;
      const onError = (error: Error): void => { connectionError ??= error; };
      client.on("error", onError);
      return {
        async query(text: string, values?: unknown[]): Promise<PostgresResult> {
          if (connectionError) throw connectionError;
          const response = await client.query<Record<string, unknown>>(text, values);
          if (connectionError) throw connectionError;
          const result = Array.isArray(response) ? response.at(-1) : response;
          return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? null };
        },
        release(error?: Error) {
          // Hand control back to the pool before detaching so the healthy idle listener has no handoff gap.
          try { client.release(error ?? connectionError); }
          finally { client.removeListener("error", onError); }
        },
      };
    },
  };
  const work = createPostgresUnitOfWork(adapter, limits);
  const scope = new AsyncLocalStorage<PostgresBusinessIdentity>();
  const schema = `"${target.schema}"`;

  const run: PostgresBusinessRuntime["run"] = async operation => {
    if (scope.getStore()) return work.run(operation);
    if (state !== "ready") throw new Error("PostgreSQL business runtime is closing or closed");
    if (activeOperations >= limits.maximumConnections + limits.maximumPendingOperations) {
      throw new Error("PostgreSQL business pending operation budget exhausted");
    }
    activeOperations += 1;
    try {
      return await work.run(async tx => {
        if (limits.access === "read") await tx.query("SET TRANSACTION READ ONLY");
        await tx.query(`/* business-session */ SELECT
          set_config('search_path',$1,true), set_config('application_name',$2,true),
          set_config('idle_in_transaction_session_timeout',$3,true), set_config('work_mem',$4,true),
          set_config('max_parallel_workers_per_gather','0',true), set_config('synchronous_commit','on',true)`,
        [`pg_catalog,${schema},pg_temp`, applicationName, String(limits.idleTransactionTimeoutMs), `${limits.workMemKb}kB`]);
        const identity = (await tx.query(`/* business-identity */ SELECT current_database() AS database,
          current_user AS username, session_user AS session_username, host(inet_server_addr()) AS server_address,
          inet_server_port() AS server_port, current_setting('application_name') AS application_name`)).rows[0];
        if (!identity || identity.database !== target.database || identity.username !== target.username
          || identity.session_username !== target.username || identity.server_port !== endpoint.port
          || typeof identity.server_address !== "string" || !identity.server_address
          || (loopback && !["127.0.0.1", "::1"].includes(identity.server_address))
          || identity.application_name !== applicationName) {
          throw new Error("PostgreSQL business connection identity mismatch");
        }
        const ledgerKind = (await tx.query(`/* business-ledger-kind */ SELECT
          EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($1)
            AND c.relkind='r' AND c.relpersistence='p') AS identity_valid,
          EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($2)
            AND c.relkind='r' AND c.relpersistence='p') AS ledger_valid`,
        [`${schema}.business_schema_identity`,`${schema}.business_schema_ledger`])).rows[0];
        if (!ledgerKind || ledgerKind.identity_valid !== true || ledgerKind.ledger_valid !== true) {
          throw new Error("PostgreSQL business ledgers must be permanent ordinary tables");
        }
        const privileges = (await tx.query(PRIVILEGE_PROBE_SQL,
          [target.schema, limits.access === "read", `${schema}.business_schema_identity`, `${schema}.business_schema_ledger`,
            protectedAuthorityTables, mutableProviderBudgetColumns])).rows[0];
        if (!privileges || privileges.role_safe !== true || privileges.schema_usage !== true
          || ["database_create", "database_temp", "schema_create", "schema_owner", "outside_write", "unsafe_privileges", "unsafe_functions"]
            .some(key => privileges[key] !== false)) {
          throw new Error("PostgreSQL business role failed the least-privilege probe");
        }
        const ledger = (await tx.query(`/* business-ledger-probe */ SELECT i.database_name,i.schema_name,i.generation_id,
          i.ledger_format,l.version,l.fingerprint FROM ${schema}.business_schema_identity i
          CROSS JOIN ${schema}.business_schema_ledger l WHERE i.singleton=true ORDER BY l.version DESC LIMIT 1`)).rows[0];
        if (!ledger || ledger.database_name !== target.database || ledger.schema_name !== target.schema
          || ledger.generation_id !== target.generation || ledger.ledger_format !== 1
          || ledger.version !== limits.schemaVersion || ledger.fingerprint !== limits.schemaFingerprint) {
          throw new Error("PostgreSQL business schema version, fingerprint or generation mismatch");
        }
        const verified = Object.freeze({ ...target, serverAddress: identity.server_address, serverPort: endpoint.port,
          schemaVersion: limits.schemaVersion, schemaFingerprint: limits.schemaFingerprint });
        return scope.run(verified, () => operation(tx));
      });
    } finally {
      activeOperations -= 1;
      if (activeOperations === 0) drained?.();
    }
  };

  return Object.freeze({
    run,
    probe: () => run(async () => scope.getStore()!),
    statistics: () => Object.freeze({ totalConnections: pool.totalCount, idleConnections: pool.idleCount,
      waitingConnections: pool.waitingCount, activeOperations, idleErrorCount, lastIdleSqlState, state }),
    close(): Promise<void> {
      if (shutdown) return shutdown;
      state = "closing";
      const drain = activeOperations === 0 ? Promise.resolve() : new Promise<void>(resolve => { drained = resolve; });
      const completion = drain.then(() => pool.end()).then(async () => {
        // Pool bookkeeping can be empty while client.end is still in flight.
        await physical.drained();
        state = "closed";
      });
      shutdown = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new PostgresBusinessShutdownTimeoutError()), limits.shutdownTimeoutMs);
        void completion.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      return shutdown;
    },
  });
}
