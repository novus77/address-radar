import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { PostgresBusinessIdentity } from "./postgres-business-driver.js";
import {
  createPostgresUnitOfWork, type PostgresClient, type PostgresPool,
  type PostgresResult, type PostgresTransaction,
} from "./postgres-unit-of-work.js";

export interface PostgresMigrationCapability {
  readonly mode: "isolated" | "approved_cutover";
  readonly purpose: "schema_install" | "business_import";
  readonly approvalRef: string;
  readonly planSha256: string;
  readonly expiresAtMs: number;
}
export interface PostgresMigrationTarget extends PostgresBusinessIdentity {
  readonly systemIdentifier: string;
}
export interface PostgresMigrationLimits {
  readonly operationTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly maximumSqlStatements: number;
  readonly workMemKb: number;
  readonly closeTimeoutMs: number;
}
export interface PostgresMigrationRuntimeOptions {
  /** A dedicated migration pool, never one shared with a business service. */
  readonly pool: PostgresPool & { end(): Promise<void> };
  readonly target: PostgresMigrationTarget;
  readonly capability: PostgresMigrationCapability;
  readonly limits: PostgresMigrationLimits;
  /** Authenticate external approval, current cutover phase and the exact reviewed plan. */
  readonly assertAuthorized: (request: {
    readonly target: PostgresMigrationTarget;
    readonly capability: PostgresMigrationCapability;
  }) => Promise<void>;
  readonly clock: () => number;
}
export class PostgresMigrationDeadlineError extends Error {
  constructor() { super("PostgreSQL migration deadline exceeded"); this.name = "PostgresMigrationDeadlineError"; }
}
const claimedPools = new WeakSet<object>();
interface ErrorEventPort {
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}
function attachErrorListener(value: object, listener: (error: Error) => void): () => void {
  const port = value as Partial<ErrorEventPort>;
  if (port.on === undefined && port.removeListener === undefined) return () => {};
  if (typeof port.on !== "function" || typeof port.removeListener !== "function") return fail("invalid_error_event_port");
  const remove = port.removeListener.bind(value);
  port.on("error", listener);
  return () => { remove("error", listener); };
}
const identifier = (value: unknown): value is string => typeof value === "string"
  && /^[a-z_][a-z0-9_]{0,62}$/.test(value) && !value.startsWith("pg_")
  && !["public", "information_schema", "postgres", "template0", "template1"].includes(value);
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const positive = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value)
  && (value as number) > 0 && (value as number) <= maximum;
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = (reason: string): never => { throw new Error(`PostgreSQL migration rejected: ${reason}`); };

/** Explicit operator adapter. It never creates roles, connects automatically, selects a backend or activates a generation.
 * A schema owner is allowed only for the exact approved schema; business startup uses a different, restricted driver.
 * Injected pools and authorization callbacks are trusted ports: retaining raw pools or aliasing them defeats exclusivity.
 * Catalog checks are snapshots, not a SQL sandbox or proof of trigger/extension/remote-system isolation.
 */
export function createPostgresMigrationRuntime(options: PostgresMigrationRuntimeOptions) {
  const target = Object.freeze({ ...options.target });
  const capability = Object.freeze({ ...options.capability });
  const limits = Object.freeze({ ...options.limits });
  if (![target.database, target.username, target.schema].every(identifier)
    || !label(target.service) || !label(target.generation)
    || !["127.0.0.1", "::1"].includes(target.serverAddress)
    || !positive(target.serverPort, 65535) || !positive(target.schemaVersion, 1000)
    || !sha(target.schemaFingerprint) || typeof target.systemIdentifier !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(target.systemIdentifier) || BigInt(target.systemIdentifier) > 18_446_744_073_709_551_615n) fail("invalid_target");
  if (!["isolated", "approved_cutover"].includes(capability.mode)
    || !["schema_install", "business_import"].includes(capability.purpose)
    || !label(capability.approvalRef) || !sha(capability.planSha256)
    || !positive(capability.expiresAtMs, Number.MAX_SAFE_INTEGER)) fail("invalid_capability");
  if (capability.mode === "isolated") {
    const names = [target.database, target.schema];
    const testNames = names.every(value => /(?:^|_)(?:test|acceptance)(?:_|$)/.test(value));
    const nonces = names.map(value => /^radar_rehearsal_([a-f0-9]{16})(?:_[a-z]+)?$/.exec(value)?.[1]);
    if (names.some(value => value.startsWith("radar_rehearsal_"))
      ? (!nonces[0] || nonces[0] !== nonces[1]) : !testNames) fail("isolated_target_required");
  }
  const maxima: Record<keyof PostgresMigrationLimits, number> = {
    operationTimeoutMs: 60000, connectionTimeoutMs: 10000, statementTimeoutMs: 30000,
    lockTimeoutMs: 5000, maximumSqlStatements: 100000, workMemKb: 4096, closeTimeoutMs: 10000,
  };
  if (Object.keys(limits).length !== Object.keys(maxima).length
    || Object.entries(maxima).some(([key, maximum]) => !positive(limits[key as keyof PostgresMigrationLimits], maximum))
    || limits.lockTimeoutMs > limits.statementTimeoutMs || limits.statementTimeoutMs > limits.operationTimeoutMs
    || limits.connectionTimeoutMs > limits.operationTimeoutMs) fail("invalid_limits");
  if (typeof options.clock !== "function" || typeof options.assertAuthorized !== "function"
    || typeof options.pool?.connect !== "function" || typeof options.pool.end !== "function") fail("missing_verified_ports");
  const clock = options.clock, authorize = options.assertAuthorized, pool = options.pool;
  if (claimedPools.has(pool)) fail("dedicated_pool_already_owned");
  const connectPool = pool.connect.bind(pool), endPool = pool.end.bind(pool);
  const authorizationRequest = Object.freeze({ target, capability });
  const scope = new AsyncLocalStorage<{
    readonly deadline: number;
    readonly startedAt: number;
    readonly monotonicDeadline: number;
    lastObservedAt: number;
    statements: number;
    identity: PostgresBusinessIdentity | null;
    failure: Error | null;
  }>();
  let state: "ready" | "closing" | "closed" = "ready", busy = false;
  let poisoned = false;
  let poolError: Error | undefined;
  const detachPoolError = attachErrorListener(pool, error => { poolError ??= error; poisoned = true; });
  claimedPools.add(pool);
  let closePromise: Promise<void> | undefined;
  let drained: (() => void) | undefined;
  const now = (): number => {
    const value = clock();
    if (!positive(value, Number.MAX_SAFE_INTEGER)) fail("invalid_clock");
    return value;
  };
  const remaining = (): number => {
    const current = scope.getStore();
    if (!current) return fail("missing_operation_scope");
    if (current.failure) throw current.failure;
    if (poolError) throw poolError;
    const at = now();
    if (at < current.lastObservedAt) return fail("clock_moved_backwards");
    current.lastObservedAt = at;
    const value = Math.min(Math.min(current.deadline, capability.expiresAtMs) - at, current.monotonicDeadline - performance.now());
    if (value <= 0) throw new PostgresMigrationDeadlineError();
    return value;
  };
  async function bounded<T>(operation: () => Promise<T>, maximumMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = Math.min(remaining(), maximumMs);
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PostgresMigrationDeadlineError()), timeout); }),
      ]);
    } catch (error) {
      if (error instanceof PostgresMigrationDeadlineError) {
        // Promise races cannot cancel native SQL, acquisitions or user callbacks. Never admit overlapping follow-up work.
        poisoned = true;
        const current = scope.getStore();
        if (current) current.failure ??= error;
      }
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const work = createPostgresUnitOfWork({
    async connect(): Promise<PostgresClient> {
      const request = Promise.resolve().then(connectPool).then(native => {
        let released = false;
        let connectionError: Error | undefined;
        const releaseNative = native.release.bind(native);
        let detach: () => void;
        let queryNative: PostgresClient["query"];
        try {
          detach = attachErrorListener(native, error => { connectionError ??= error; poisoned = true; });
          queryNative = native.query.bind(native);
        } catch (error) {
          releaseNative(error instanceof Error ? error : new Error("PostgreSQL migration client port rejected"));
          throw error;
        }
        return {
          async query(sql: string, values?: unknown[]): Promise<PostgresResult> {
            if (released) return fail("connection_already_released");
            if (connectionError) throw connectionError;
            const current = scope.getStore();
            if (!current || ++current.statements > limits.maximumSqlStatements) return fail("sql_statement_budget");
            const result = await bounded(() => queryNative(sql, values), limits.operationTimeoutMs);
            if (connectionError) throw connectionError;
            return result;
          },
          release(error?: Error) {
            if (released) return;
            released = true;
            try { releaseNative(error ?? connectionError ?? scope.getStore()?.failure ?? undefined); }
            finally { detach(); }
          },
        } satisfies PostgresClient;
      });
      let client: PostgresClient | undefined;
      try {
        client = await bounded(() => request, limits.connectionTimeoutMs);
        // The UOW's first settings query uses unqualified built-ins; establish a safe session before BEGIN.
        await client.query(`/* migration-runtime-bootstrap */ SELECT
          pg_catalog.set_config('search_path','pg_catalog',false),
          pg_catalog.set_config('statement_timeout',$1,false),pg_catalog.set_config('lock_timeout',$2,false),
          pg_catalog.set_config('idle_in_transaction_session_timeout',$3,false),pg_catalog.set_config('work_mem',$4,false),
          pg_catalog.set_config('max_parallel_workers_per_gather','0',false),pg_catalog.set_config('synchronous_commit','on',false)`,
        [String(limits.statementTimeoutMs),String(limits.lockTimeoutMs),String(limits.operationTimeoutMs),`${limits.workMemKb}kB`]);
        return client;
      } catch (error) {
        const discarded = error instanceof Error ? error : new Error("PostgreSQL migration connection discarded");
        if (client) client.release(discarded);
        else {
          // A late connection belongs to this failed operation, never to a future caller.
          void request.then(late => late.release(discarded), () => {}).catch(() => {});
        }
        throw error;
      }
    },
  }, limits);
  const schema = `"${target.schema}"`;
  async function verify(tx: PostgresTransaction): Promise<PostgresBusinessIdentity> {
    await tx.query(`SELECT set_config('search_path',$1,true),set_config('work_mem',$2,true),
      set_config('idle_in_transaction_session_timeout',$3,true),set_config('max_parallel_workers_per_gather','0',true),
      set_config('synchronous_commit','on',true)`, [`pg_catalog,${schema},pg_temp`, `${limits.workMemKb}kB`, String(limits.operationTimeoutMs)]);
    const rows = (await tx.query(`/* migration-runtime-identity */ SELECT current_database() database,current_user username,
      session_user session_username,host(inet_server_addr()) server_address,inet_server_port() server_port,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) system_identifier,
      NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls AS role_safe,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles other WHERE other.oid<>r.oid AND pg_catalog.pg_has_role(r.oid,other.oid,'MEMBER')) AS no_role_memberships,
      n.nspowner=r.oid AS owns_target_schema,
      NOT has_database_privilege(r.oid,current_database(),'CREATE') AS cannot_create_schema,
      NOT has_database_privilege(r.oid,current_database(),'TEMP') AS cannot_create_temp,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace other WHERE other.oid<>n.oid
        AND other.nspname !~'^pg_' AND other.nspname<>'information_schema'
        AND (other.nspowner=r.oid OR has_schema_privilege(r.oid,other.oid,'CREATE'))) AS no_other_schema_authority,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace other ON other.oid=c.relnamespace
        WHERE other.oid<>n.oid AND other.nspname !~'^pg_' AND other.nspname<>'information_schema'
        AND c.relkind IN('r','p','v','m','f') AND (c.relowner=r.oid
          OR has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
          OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) AS no_other_relation_authority,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace other ON other.oid=c.relnamespace
        WHERE other.oid<>n.oid AND other.nspname!~'^pg_' AND other.nspname<>'information_schema' AND c.relkind='S'
          AND (c.relowner=r.oid OR pg_catalog.has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE'))) AS no_other_sequence_authority,
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace other ON other.oid=p.pronamespace
        WHERE other.nspname!~'^pg_' AND other.nspname<>'information_schema' AND p.prosecdef
          AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')) AS no_callable_security_definers
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_namespace n ON n.nspname=$1 WHERE r.rolname=current_user`, [target.schema])).rows;
    const row = rows[0];
    if (rows.length !== 1 || !row || row.database !== target.database || row.username !== target.username
      || row.session_username !== target.username || row.server_address !== target.serverAddress
      || row.server_port !== target.serverPort || row.system_identifier !== target.systemIdentifier
      || ["role_safe", "no_role_memberships", "owns_target_schema", "cannot_create_schema", "cannot_create_temp",
        "no_other_schema_authority", "no_other_relation_authority", "no_other_sequence_authority", "no_callable_security_definers"].some(key => row[key] !== true)) fail("identity_or_authority_mismatch");
    if (capability.purpose === "business_import") {
      const kinds = (await tx.query(`/* migration-runtime-ledger-kind */ SELECT
        EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($1)
          AND c.relkind='r' AND c.relpersistence='p') AS identity_valid,
        EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($2)
          AND c.relkind='r' AND c.relpersistence='p') AS ledger_valid`,
      [`${schema}.business_schema_identity`,`${schema}.business_schema_ledger`])).rows;
      if (kinds.length !== 1 || kinds[0]?.identity_valid !== true || kinds[0]?.ledger_valid !== true) fail("ledger_requires_permanent_tables");
      const ledger = (await tx.query(`/* migration-runtime-ledger */ SELECT i.database_name,i.schema_name,i.generation_id,i.ledger_format,
        l.version,l.fingerprint FROM ${schema}.business_schema_identity i CROSS JOIN ${schema}.business_schema_ledger l
        WHERE i.singleton=true ORDER BY l.version DESC LIMIT 1`)).rows;
      const entry = ledger[0];
      if (ledger.length !== 1 || !entry || entry.database_name !== target.database || entry.schema_name !== target.schema
        || entry.generation_id !== target.generation || entry.ledger_format !== 1 || entry.version !== target.schemaVersion
        || entry.fingerprint !== target.schemaFingerprint) fail("schema_or_generation_mismatch");
    }
    return Object.freeze({ database: target.database, username: target.username, schema: target.schema,
      generation: target.generation, service: target.service, serverAddress: target.serverAddress, serverPort: target.serverPort,
      schemaVersion: target.schemaVersion, schemaFingerprint: target.schemaFingerprint });
  }
  async function run<T>(operation: (transaction: PostgresTransaction) => Promise<T>): Promise<T> {
    if (scope.getStore()) return fail("nested_migration_uow_forbidden");
    if (state !== "ready" || busy || poisoned) return fail("runtime_closed_or_busy");
    const startedAt = now();
    if (startedAt >= capability.expiresAtMs) throw new PostgresMigrationDeadlineError();
    busy = true;
    try {
      return await scope.run({ startedAt, lastObservedAt: startedAt, monotonicDeadline: performance.now() + limits.operationTimeoutMs,
        deadline: startedAt + limits.operationTimeoutMs, statements: 0, identity: null, failure: null }, async () => {
        await bounded(() => authorize(authorizationRequest), limits.operationTimeoutMs);
        remaining();
        return work.run(async tx => {
          scope.getStore()!.identity = await verify(tx);
          const result = await bounded(() => operation(tx), limits.operationTimeoutMs);
          remaining();
          await bounded(() => authorize(authorizationRequest), limits.operationTimeoutMs);
          remaining();
          return result;
        });
      });
    } catch (error) {
      if (error instanceof PostgresMigrationDeadlineError) poisoned = true;
      throw error;
    } finally { busy = false; drained?.(); }
  }
  return Object.freeze({
    run,
    probe: () => run(async () => scope.getStore()!.identity!),
    close(): Promise<void> {
      if (closePromise) return closePromise;
      state = "closing";
      const completion = (busy ? new Promise<void>(resolve => { drained = resolve; }) : Promise.resolve())
        .then(() => endPool()).then(() => { state = "closed"; detachPoolError(); });
      closePromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new PostgresMigrationDeadlineError()), limits.closeTimeoutMs);
        void completion.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      return closePromise;
    },
  });
}
