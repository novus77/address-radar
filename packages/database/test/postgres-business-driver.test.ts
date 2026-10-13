import { POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES, POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY } from "../src/postgres-business-provisioning.js";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresBusinessRuntime, PostgresBusinessShutdownTimeoutError,
  type PostgresBusinessOptions, type PostgresBusinessRuntime } from "../src/postgres-business-driver.js";
import { PostgresCommitUncertainError } from "../src/postgres-unit-of-work.js";

interface ProtocolGrant {
  readonly role: string;
  readonly kind: "database" | "schema" | "schema-owner" | "table-owner" | "table" | "column" | "sequence" | "function";
  readonly privilege: string;
  readonly schema?: string;
  readonly relation?: string;
  readonly column?: string;
  readonly securityDefiner?: boolean;
}
interface ProtocolCatalog {
  readonly memberships: readonly { readonly member: string; readonly role: string; readonly inherit: boolean; readonly set: boolean }[];
  readonly grants: readonly ProtocolGrant[];
}

const mock = vi.hoisted(() => ({ pools: [] as Array<{
  options: Record<string, unknown>; statements: Array<{ sql: string; values?: unknown[] }>;
  clients: EventEmitter[]; releases: Array<Error | undefined>; connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>;
  listener?: (error: Error) => void;
}>, identity: {} as Record<string, unknown>, privileges: {} as Record<string, unknown>, ledger: {} as Record<string, unknown>,
fail: "", rollbackFail: false, queryEvent: undefined as ((sql: string, client: EventEmitter) => void) | undefined, catalog: undefined as ProtocolCatalog | undefined,
ledgerKinds: { identity: { kind: "r", persistence: "p" }, ledger: { kind: "r", persistence: "p" } } }));
vi.mock("pg", async importOriginal => ({ Client: (await importOriginal<typeof import("pg")>()).Client, Pool: class {
  readonly options: Record<string, unknown>;
  readonly statements: Array<{ sql: string; values?: unknown[] }> = [];
  readonly releases: Array<Error | undefined> = [];
  readonly clients: EventEmitter[] = [];
  totalCount = 0; idleCount = 0; waitingCount = 0;
  listener?: (error: Error) => void;
  readonly end = vi.fn(async () => undefined);
  readonly connect = vi.fn(async () => {
    this.totalCount += 1;
    const client = Object.assign(new EventEmitter(), { query: async (sql: string, values?: unknown[]) => {
      this.statements.push(values ? { sql, values } : { sql });
      if (sql === mock.fail || (sql === "ROLLBACK" && mock.rollbackFail)) throw new Error("injected SQL failure");
      const rows = sql.includes("business-identity") ? [mock.identity]
        : sql.includes("business-ledger-kind") ? [{
          identity_valid: mock.ledgerKinds.identity.kind === "r" && mock.ledgerKinds.identity.persistence === "p",
          ledger_valid: mock.ledgerKinds.ledger.kind === "r" && mock.ledgerKinds.ledger.persistence === "p",
        }]
        : sql.includes("business-privileges") ? [privilegeProtocolResult(sql, values ?? [])]
          : sql.includes("business-ledger-probe") ? [mock.ledger] : [];
      mock.queryEvent?.(sql, client);
      return { rows, rowCount: rows.length };
    }, release: (error?: Error) => { this.releases.push(error); } });
    this.clients.push(client);
    return client;
  });
  constructor(options: Record<string, unknown>) { this.options = options; mock.pools.push(this); }
  on(_event: string, listener: (error: Error) => void) { this.listener = listener; }
} }));

// This catalog/ACL protocol model is deliberately not a PostgreSQL interpreter.
// Concrete grants determine replies, gated by the predicates actually submitted by the driver.
function privilegeProtocolResult(sql: string, values: unknown[]): Record<string, unknown> {
  if (!mock.catalog) return mock.privileges;
  const catalog = mock.catalog;
  const login = String(mock.identity.username);
  const closure = (start: string, mode: "inherit" | "set"): Set<string> => {
    const roles = new Set([start]);
    for (const role of roles) for (const edge of catalog.memberships) {
      if (edge.member === role && edge[mode]) roles.add(edge.role);
    }
    return roles;
  };
  const setRoles = sql.includes("pg_has_role(session_user,r.oid,'SET')") ? closure(login, "set") : new Set([login]);
  const result = { ...mock.privileges };
  const outside = sql.slice(sql.indexOf("AS schema_owner,"), sql.indexOf("AS outside_write,"));
  const unsafe = sql.slice(sql.indexOf("AS outside_write,"), sql.indexOf("AS unsafe_privileges"));
  const table = (section: string) => section.includes("has_table_privilege(a.oid,");
  const columns = (section: string, relation: string, privileges: string) =>
    section.includes(`has_any_column_privilege(a.oid,${relation},'${privileges}')`);
  const authorityTables = sql.includes("c.relname=ANY($5::text[])") ? new Set(values[4] as string[]) : new Set<string>();
  const budgetGuard = sql.includes("c.relname='wallet_service_provider_budgets'")
    && sql.includes("has_column_privilege(a.oid,c.oid,b.attnum,'UPDATE')")
    && sql.includes("NOT (b.attname=ANY($6::text[]))");
  const budgetColumns = new Set(values[5] as string[] | undefined);
  const schema = String(values[0]);
  const read = values[1] === true;
  for (const grant of catalog.grants) {
    const predicate = grant.kind === "column" ? "has_any_column_privilege"
      : grant.kind === "table" ? "has_table_privilege" : grant.kind === "sequence" ? "has_sequence_privilege"
        : grant.kind === "function" ? "has_function_privilege"
          : grant.kind === "database" ? "has_database_privilege" : "has_schema_privilege";
    const owner = grant.kind.endsWith("owner");
    const roles = owner ? (sql.includes("pg_has_role(a.oid,") ? setRoles : new Set([login]))
      : sql.includes(`${predicate}(a.oid,`) ? setRoles : new Set([login]);
    if (grant.role !== "PUBLIC" && ![...roles].some(role => closure(role, "inherit").has(grant.role))) continue;
    if (grant.kind === "database") {
      if (grant.privilege === "CREATE") result.database_create = true;
      if (grant.privilege === "TEMP") result.database_temp = true;
    } else if (grant.kind === "schema" || grant.kind === "schema-owner") {
      if (grant.schema === schema) result[owner ? "schema_owner" : "schema_create"] = true;
      else result.outside_write = true;
    } else if (grant.kind === "function") {
      if (grant.securityDefiner && sql.includes("p.prosecdef") && sql.includes("has_function_privilege(a.oid,p.oid,'EXECUTE')")) {
        result.unsafe_functions = true;
      }
    } else if (grant.schema !== schema) {
      const recognized = owner || (grant.kind === "table" && table(outside))
        || (grant.kind === "column" && columns(outside, "c.oid", "INSERT,UPDATE,REFERENCES"))
        || (grant.kind === "sequence" && outside.includes("has_sequence_privilege(a.oid,c.oid,"));
      if (recognized) result.outside_write = true;
    } else {
      const mutation = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(grant.privilege);
      const authorityWrite = authorityTables.has(grant.relation ?? "") && mutation
        && ((grant.kind === "table" && table(unsafe))
          || (grant.kind === "column" && columns(unsafe, "c.oid", "INSERT,UPDATE,REFERENCES")));
      const budgetWrite = grant.relation === "wallet_service_provider_budgets" && budgetGuard
        && ((grant.kind === "table" && mutation && table(unsafe))
          || (grant.kind === "column" && (["INSERT", "REFERENCES"].includes(grant.privilege)
            || (grant.privilege === "UPDATE" && !budgetColumns.has(grant.column ?? "")))));
      if (authorityWrite || budgetWrite) result.unsafe_privileges = true;
      const protectedParameter = grant.relation === "business_schema_identity" ? "$3"
        : grant.relation === "business_schema_ledger" ? "$4" : undefined;
      if (owner || (grant.kind === "table" && table(unsafe)
        && (protectedParameter || read || ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(grant.privilege)))
        || (grant.kind === "sequence" && unsafe.includes("has_sequence_privilege(a.oid,c.oid,")
          && (read || grant.privilege === "UPDATE"))
        || (grant.kind === "column" && ((protectedParameter
          && columns(unsafe, protectedParameter, "INSERT,UPDATE,REFERENCES"))
          || (grant.privilege === "REFERENCES" && columns(unsafe, "c.oid", "REFERENCES"))
          || (read && unsafe.includes("$2::boolean") && columns(unsafe, "c.oid", "INSERT,UPDATE"))))) {
        result.unsafe_privileges = true;
      }
    }
  }
  return result;
}

const options: PostgresBusinessOptions = {
  connectionString: "postgresql://radar_runtime:sentinel-secret@127.0.0.1:5432/radar_business",
  target: { database: "radar_business", username: "radar_runtime", schema: "business_v1", generation: "generation-1", service: "scanner" },
  access: "runtime", schemaVersion: 1, schemaFingerprint: "a".repeat(64), ssl: false,
  maximumConnections: 3, serviceConnectionBudgets: { scanner: 3, console: 1, monitor: 2, analysis: 2, automation: 2, gateway: 1 },
  serverMaximumConnections: 16, reservedConnections: 5, maximumPendingOperations: 1,
  connectionTimeoutMs: 1_000, idleTimeoutMs: 1_000, statementTimeoutMs: 2_000, lockTimeoutMs: 500,
  idleTransactionTimeoutMs: 3_000, shutdownTimeoutMs: 100, workMemKb: 1_024,
};
const runtimes: PostgresBusinessRuntime[] = [];
const create = (overrides: Partial<PostgresBusinessOptions> = {}) => {
  const runtime = createPostgresBusinessRuntime({ ...options, ...overrides });
  runtimes.push(runtime);
  return runtime;
};
const pool = () => mock.pools.at(-1)!;
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  mock.pools.length = 0; mock.fail = ""; mock.rollbackFail = false; mock.queryEvent = undefined; mock.catalog = undefined;
  mock.ledgerKinds = { identity: { kind: "r", persistence: "p" }, ledger: { kind: "r", persistence: "p" } };
  mock.identity = { database: options.target.database, username: options.target.username, session_username: options.target.username,
    server_address: "127.0.0.1", server_port: 5432,
    application_name: `scanner:${createHash("sha256").update(options.target.generation).digest("hex").slice(0,16)}` };
  mock.privileges = { role_safe: true, database_create: false, database_temp: false, schema_usage: true,
    schema_create: false, schema_owner: false, outside_write: false, unsafe_privileges: false, unsafe_functions: false };
  mock.ledger = { database_name: options.target.database, schema_name: options.target.schema,
    generation_id: options.target.generation, ledger_format: 1, version: 1, fingerprint: options.schemaFingerprint };
});
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); vi.useRealTimers(); });

describe("PostgreSQL business runtime", () => {
  it("constructs a bounded lazy production pool without applying any schema", async () => {
    const runtime = create();
    expect(pool().connect).not.toHaveBeenCalled();
    expect(pool().options).toMatchObject({ max: 3, connectionTimeoutMillis: 1_000, idleTimeoutMillis: 1_000,
      database: "radar_business", user: "radar_runtime", ssl: false });
    expect(pool().options.options).toContain("work_mem=1024kB");
    expect(await runtime.probe()).toMatchObject({ ...options.target, serverPort: 5432, schemaVersion: 1 });
    expect(pool().statements.some(entry => /CREATE|ALTER|DROP|INSERT|UPDATE|DELETE/.test(entry.sql.split("/* business-privileges */")[0]!))).toBe(false);
  });

  it("validates identity and privileges before business work and acknowledges only after commit", async () => {
    const runtime = create();
    await expect(runtime.run(async tx => { await tx.query("BUSINESS WRITE"); return "receipt"; })).resolves.toBe("receipt");
    const statements = pool().statements.map(entry => entry.sql);
    expect(statements.findIndex(sql => sql.includes("business-ledger-probe"))).toBeLessThan(statements.indexOf("BUSINESS WRITE"));
    expect(statements.at(-1)).toBe("COMMIT");
    expect(pool().releases).toEqual([undefined]);
  });

  it("sets a safe transaction-local search path and explicit memory/durability budgets", async () => {
    await create().probe();
    const setting = pool().statements.find(entry => entry.sql.includes("business-session"))!;
    expect(setting.values).toEqual(["pg_catalog,\"business_v1\",pg_temp", mock.identity.application_name, "3000", "1024kB"]);
    expect(setting.sql).toContain("synchronous_commit','on'");
  });

  it("composes nested repository work using the same transaction and admission slot", async () => {
    const runtime = create();
    await runtime.run(async outer => runtime.run(async inner => {
      expect(inner).toBe(outer); expect(runtime.statistics().activeOperations).toBe(1);
      await inner.query("NESTED");
    }));
    expect(pool().connect).toHaveBeenCalledTimes(1);
    expect(pool().statements.filter(entry => entry.sql.includes("business-identity"))).toHaveLength(1);
  });

  it("preserves nested failure poisoning even if the outer callback catches it", async () => {
    const runtime = create();
    await expect(runtime.run(async () => {
      await runtime.run(async () => { throw new Error("nested failure"); }).catch(() => undefined);
    })).rejects.toThrow("nested failure");
    expect(pool().statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it.each(["database", "username", "session_username", "server_port", "server_address", "application_name"])("refuses mismatched %s before invoking the callback", async key => {
    mock.identity[key] = "wrong";
    const operation = vi.fn(async () => undefined);
    await expect(create().run(operation)).rejects.toThrow("identity mismatch");
    expect(operation).not.toHaveBeenCalled();
    expect(pool().statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it.each(["role_safe", "database_create", "database_temp", "schema_usage", "schema_create", "schema_owner", "outside_write", "unsafe_privileges", "unsafe_functions"])("fails closed for unsafe or unknown %s", async key => {
    mock.privileges[key] = undefined;
    const operation = vi.fn(async () => undefined);
    await expect(create().run(operation)).rejects.toThrow("least-privilege");
    expect(operation).not.toHaveBeenCalled();
  });

  it.each(["database_name", "schema_name", "generation_id", "ledger_format", "version", "fingerprint"])("refuses incompatible schema %s without DDL or fallback", async key => {
    mock.ledger[key] = "wrong";
    await expect(create().probe()).rejects.toThrow("schema version, fingerprint or generation mismatch");
    expect(pool().statements.some(entry => entry.sql.startsWith("CREATE "))).toBe(false);
  });

  it("requires the read role's probe and enforces server-side read-only transactions", async () => {
    await create({ access: "read" }).probe();
    const statements = pool().statements.map(entry => entry.sql);
    expect(statements.indexOf("SET TRANSACTION READ ONLY")).toBe(2);
    expect(pool().statements.find(entry => entry.sql.includes("business-privileges"))?.values?.[1]).toBe(true);
  });

  it("does not retry uncertain commits and discards the client", async () => {
    mock.fail = "COMMIT";
    await expect(create().run(async tx => { await tx.query("WRITE"); })).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(pool().connect).toHaveBeenCalledTimes(1);
    expect(pool().releases[0]).toBeInstanceOf(PostgresCommitUncertainError);
  });

  it("preserves rollback failures without returning a healthy client", async () => {
    mock.rollbackFail = true;
    await expect(create().run(async () => { throw new Error("callback failed"); })).rejects.toBeInstanceOf(AggregateError);
    expect(pool().releases[0]).toBeInstanceOf(Error);
  });

  it("bounds admission before pool acquisition", async () => {
    const runtime = create({ maximumConnections: 1, serviceConnectionBudgets: { scanner: 1 }, maximumPendingOperations: 0 });
    const entered = defer(); const finish = defer();
    const first = runtime.run(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    await expect(runtime.probe()).rejects.toThrow("pending operation budget exhausted");
    expect(pool().connect).toHaveBeenCalledTimes(1);
    finish.resolve(); await first;
  });

  it("drains admitted work, allows its nested operations and closes idempotently", async () => {
    const runtime = create(); const entered = defer(); const finish = defer();
    const first = runtime.run(async () => {
      entered.resolve(); await finish.promise;
      await runtime.run(async tx => { await tx.query("FINAL WRITE"); });
    });
    await entered.promise;
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    expect(pool().end).not.toHaveBeenCalled();
    await expect(runtime.probe()).rejects.toThrow("closing or closed");
    finish.resolve(); await first; await closing;
    expect(pool().end).toHaveBeenCalledTimes(1);
    expect(runtime.statistics().state).toBe("closed");
  });

  it("reports shutdown timeout without acknowledging unfinished work and continues draining", async () => {
    vi.useFakeTimers();
    const runtime = create(); const entered = defer(); const finish = defer();
    const first = runtime.run(async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    const closing = runtime.close();
    const assertion = expect(closing).rejects.toBeInstanceOf(PostgresBusinessShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(100); await assertion;
    expect(runtime.statistics().state).toBe("closing");
    expect(pool().end).not.toHaveBeenCalled();
    finish.resolve(); await first; await vi.runAllTimersAsync();
    expect(runtime.statistics().state).toBe("closed");
  });

  it("records idle SQLSTATE without retaining secret-bearing errors", async () => {
    const runtime = create();
    pool().listener!(Object.assign(new Error("sentinel-secret"), { code: "08006" }));
    expect(runtime.statistics()).toMatchObject({ idleErrorCount: 1, lastIdleSqlState: "08006" });
    expect(JSON.stringify(runtime.statistics())).not.toContain("sentinel-secret");
    pool().listener!(Object.assign(new Error("sentinel-secret"), { code: "secret" }));
    expect(runtime.statistics().lastIdleSqlState).toBeNull();
  });

  it.each(["INSERT", "UPDATE", "REFERENCES"])("protocol: rejects cross-schema column-only %s grants", async privilege => {
    mock.catalog = { memberships: [], grants: [{ role: "radar_runtime", kind: "column", schema: "legacy",
      relation: "preserved_rows", column: "payload", privilege }] };
    const callback = vi.fn(async () => undefined);
    await expect(create().run(callback)).rejects.toThrow("least-privilege");
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["business_schema_identity", "business_schema_ledger"])("protocol: protects all columns of %s", async relation => {
    for (const privilege of ["INSERT", "UPDATE", "REFERENCES"]) {
      mock.catalog = { memberships: [], grants: [{ role: "radar_runtime", kind: "column", schema: "business_v1",
        relation, column: relation === "business_schema_identity" ? "generation_id" : "fingerprint", privilege }] };
      await expect(create().probe()).rejects.toThrow("least-privilege");
    }
  });

  it.each(["INSERT", "UPDATE", "REFERENCES"])("protocol: rejects read-role column-only %s grants", async privilege => {
    mock.catalog = { memberships: [], grants: [{ role: "radar_runtime", kind: "column", schema: "business_v1",
      relation: "capture_event_identities", column: "revision_count", privilege }] };
    await expect(create({ access: "read" }).probe()).rejects.toThrow("least-privilege");
  });

  it("protocol: preserves legitimate runtime column INSERT/UPDATE while refusing REFERENCES", async () => {
    mock.catalog = { memberships: [], grants: ["INSERT", "UPDATE"].map(privilege => ({ role: "radar_runtime",
      kind: "column", schema: "business_v1", relation: "capture_event_identities", column: "revision_count", privilege })) };
    await expect(create().probe()).resolves.toMatchObject({ schemaVersion: 1 });
    mock.catalog = { ...mock.catalog, grants: [...mock.catalog.grants, { role: "radar_runtime", kind: "column",
      schema: "business_v1", relation: "capture_event_identities", column: "revision_count", privilege: "REFERENCES" }] };
    await expect(create().probe()).rejects.toThrow("least-privilege");
  });

  it.each([
    { kind: "table", schema: "legacy", relation: "preserved_rows", privilege: "UPDATE" },
    { kind: "column", schema: "legacy", relation: "preserved_rows", column: "payload", privilege: "INSERT" },
    { kind: "column", schema: "business_v1", relation: "business_schema_identity", column: "generation_id", privilege: "UPDATE" },
    { kind: "column", schema: "business_v1", relation: "business_schema_ledger", column: "fingerprint", privilege: "UPDATE" },
    { kind: "database", privilege: "TEMP" }, { kind: "database", privilege: "CREATE" },
    { kind: "schema", schema: "business_v1", privilege: "CREATE" },
    { kind: "schema", schema: "legacy", privilege: "CREATE" },
    { kind: "schema-owner", schema: "business_v1", privilege: "OWNER" },
    { kind: "table-owner", schema: "business_v1", relation: "capture_event_identities", privilege: "OWNER" },
    { kind: "sequence", schema: "legacy", relation: "legacy_seq", privilege: "USAGE" },
    { kind: "sequence", schema: "business_v1", relation: "business_seq", privilege: "UPDATE" },
  ] satisfies Omit<ProtocolGrant, "role">[])("protocol: checks non-inherited SET-role ACL $kind/$privilege/$relation", async grant => {
    // GRANT dormant_writer TO radar_runtime WITH INHERIT FALSE, SET TRUE;
    // dormant_writer has no elevated role flags; only its object/column ACL is unsafe.
    mock.catalog = { memberships: [{ member: "radar_runtime", role: "dormant_writer", inherit: false, set: true }],
      grants: [{ ...grant, role: "dormant_writer" }] };
    const callback = vi.fn(async () => undefined);
    await expect(create().run(callback)).rejects.toThrow("least-privilege");
    expect(callback).not.toHaveBeenCalled();
  });

  it("protocol: checks a SET role's inherited column grants even when the grant role is not SET-accessible", async () => {
    mock.catalog = { memberships: [
      { member: "radar_runtime", role: "dormant_writer", inherit: false, set: true },
      { member: "dormant_writer", role: "ledger_writer", inherit: true, set: false },
    ], grants: [{ role: "ledger_writer", kind: "column", schema: "business_v1",
      relation: "business_schema_ledger", column: "fingerprint", privilege: "UPDATE" }] };
    await expect(create().probe()).rejects.toThrow("least-privilege");
  });

  it("protocol: checks read ACLs through a two-hop SET TRUE chain with INHERIT FALSE", async () => {
    mock.catalog = { memberships: [
      { member: "radar_runtime", role: "bridge", inherit: false, set: true },
      { member: "bridge", role: "column_writer", inherit: false, set: true },
    ], grants: [{ role: "column_writer", kind: "column", schema: "business_v1",
      relation: "capture_event_identities", column: "revision_count", privilege: "UPDATE" }] };
    await expect(create({ access: "read" }).probe()).rejects.toThrow("least-privilege");
  });

  it("protocol: does not treat an inaccessible role's ACL as available", async () => {
    mock.catalog = { memberships: [{ member: "radar_runtime", role: "unreachable", inherit: false, set: false }],
      grants: [{ role: "unreachable", kind: "column", schema: "legacy", relation: "preserved_rows", column: "payload", privilege: "UPDATE" }] };
    await expect(create().probe()).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it.each(["PUBLIC", "radar_runtime", "dormant_writer"])("protocol: refuses SECURITY DEFINER ledger writers executable by %s", async role => {
    // CREATE FUNCTION helpers.rewrite_ledger() ... SECURITY DEFINER;
    // Its body updates business_schema_ledger as the migration owner; EXECUTE alone enables the bypass.
    mock.catalog = { memberships: [{ member: "radar_runtime", role: "dormant_writer", inherit: false, set: true }],
      grants: [{ role, kind: "function", schema: "helpers", relation: "rewrite_ledger", privilege: "EXECUTE", securityDefiner: true }] };
    await expect(create().probe()).rejects.toThrow("least-privilege");
  });

  it("protocol: permits user SECURITY INVOKER routines", async () => {
    mock.catalog = { memberships: [], grants: [{ role: "PUBLIC", kind: "function", schema: "helpers",
      relation: "read_progress", privilege: "EXECUTE", securityDefiner: false }] };
    await expect(create().probe()).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it.each(["identity", "ledger"] as const)("rejects fake %s views before privilege or ledger reads", async name => {
    mock.ledgerKinds[name] = { kind: "v", persistence: "p" };
    await expect(create().probe()).rejects.toThrow("permanent ordinary tables");
    expect(pool().statements.some(entry => entry.sql.includes("business-privileges") || entry.sql.includes("business-ledger-probe"))).toBe(false);
  });

  it("pins pg_catalog in connection startup options before the UOW's first query", () => {
    create(); expect(pool().options.options).toContain("-c search_path=pg_catalog,business_v1,pg_temp");
  });

  it("rejects acceptance/admin targets and SQL identifier injection without creating a pool", () => {
    for (const target of [
      { ...options.target, database: "address_radar_acceptance_test" },
      { ...options.target, username: "address_radar_acceptance" },
      { ...options.target, database: "postgres" }, { ...options.target, username: "postgres" },
      { ...options.target, schema: "public" }, { ...options.target, schema: "pg_catalog" },
      { ...options.target, schema: "business;DROP" }, { ...options.target, generation: "" }, { ...options.target, service: "" },
    ]) expect(() => create({ target })).toThrow("explicit non-acceptance");
    expect(mock.pools).toHaveLength(0);
  });

  it("rejects URL overrides, missing credentials and inconsistent explicit identities without disclosing secrets", () => {
    for (const connectionString of ["sentinel-secret:not-a-url",
      options.connectionString + "?host=remote.invalid", options.connectionString + "#override",
      options.connectionString.replace("radar_business", "another_business"),
      options.connectionString.replace(":5432", ""), options.connectionString.replace("sentinel-secret", "%invalid"),
      options.connectionString.replace(":sentinel-secret", "")]) {
      let error: unknown;
      try { create({ connectionString }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("sentinel-secret");
    }
    expect(mock.pools).toHaveLength(0);
  });

  it("requires verified TLS for remote endpoints", async () => {
    const connectionString = options.connectionString.replace("127.0.0.1", "db.internal");
    expect(() => create({ connectionString })).toThrow("verified TLS");
    const runtime = create({ connectionString, ssl: { ca: "pinned-ca", rejectUnauthorized: true } });
    expect(pool().options.ssl).toEqual({ ca: "pinned-ca", rejectUnauthorized: true });
    await runtime.close();
  });

  it("rejects nonfinite or incoherent resource allocations", () => {
    for (const key of ["maximumConnections", "connectionTimeoutMs", "idleTimeoutMs", "statementTimeoutMs", "lockTimeoutMs",
      "idleTransactionTimeoutMs", "shutdownTimeoutMs", "workMemKb", "reservedConnections", "serverMaximumConnections"] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648]) {
        expect(() => create({ [key]: value })).toThrow("resource limits");
      }
    }
    for (const overrides of [{ serverMaximumConnections: 15 }, { maximumConnections: 2 },
      { serviceConnectionBudgets: {} }, { maximumPendingOperations: -1 }, { workMemKb: 63 },
      { lockTimeoutMs: 2_001 }, { schemaFingerprint: "wrong" }, { schemaVersion: 0 }]) {
      expect(() => create(overrides)).toThrow("resource limits");
    }
    expect(mock.pools).toHaveLength(0);
  });
});


describe("fixed authority ACL boundaries (catalog protocol, not live PostgreSQL)", () => {
  it("submits the reviewed immutable protected set and only three mutable budget columns", async () => {
    await create().probe();
    const query = pool().statements.find(entry => entry.sql.includes("business-privileges"))!;
    expect(query.values?.[4]).toEqual([...new Set([...POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES,
      "migration_cutover_transitions_v2", "migration_cutover_first_write_markers"])]);
    expect(query.values?.[5]).toEqual(["window_started_at", "requests_used", "cooldown_until"]);
    expect(query.values?.[5]).toEqual(POSTGRES_BUSINESS_RUNTIME_COLUMN_POLICY.wallet_service_provider_budgets.update);
    expect(Object.isFrozen(query.values?.[4])).toBe(true);
    expect(Object.isFrozen(query.values?.[5])).toBe(true);
    expect(query.sql).toContain("NOT b.attisdropped");
    expect(query.sql).toContain("b.attnum>0");
  });

  it.each(POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES)("refuses direct and SET-role table/column writes on %s", async relation => {
    for (const role of ["radar_runtime", "authority_writer"]) for (const grant of [
      { kind: "table" as const, privilege: "INSERT" }, { kind: "table" as const, privilege: "UPDATE" },
      { kind: "table" as const, privilege: "DELETE" }, { kind: "column" as const, privilege: "INSERT", column: "generation_id" },
      { kind: "column" as const, privilege: "UPDATE", column: "generation_id" },
      { kind: "column" as const, privilege: "REFERENCES", column: "generation_id" },
    ]) {
      mock.catalog = { memberships: [{ member: "radar_runtime", role: "authority_writer", inherit: false, set: true }],
        grants: [{ ...grant, role, schema: "business_v1", relation }] };
      const operation = vi.fn(async () => undefined);
      await expect(create().run(operation)).rejects.toThrow("least-privilege");
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("checks a SET role's inherited authority and budget ACLs", async () => {
    for (const grant of [
      { relation: "wallet_service_fact_attestations", column: "generation_id", privilege: "UPDATE" },
      { relation: "wallet_service_provider_budgets", column: "maximum_requests", privilege: "UPDATE" },
    ]) {
      mock.catalog = { memberships: [
        { member: "radar_runtime", role: "bridge", inherit: false, set: true },
        { member: "bridge", role: "authority_writer", inherit: true, set: false },
      ], grants: [{ ...grant, role: "authority_writer", kind: "column", schema: "business_v1" }] };
      await expect(create().probe()).rejects.toThrow("least-privilege");
    }
  });

  it.each(["generation_id", "provider_id", "import_id", "origin", "window_ms", "maximum_requests", "maximum_concurrency"])
    ("rejects protected budget UPDATE(%s) through non-inherited SET ROLE", async column => {
      mock.catalog = { memberships: [{ member: "radar_runtime", role: "budget_writer", inherit: false, set: true }],
        grants: [{ role: "budget_writer", kind: "column", schema: "business_v1", relation: "wallet_service_provider_budgets", column, privilege: "UPDATE" }] };
      await expect(create().probe()).rejects.toThrow("least-privilege");
    });

  it.each(["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])("refuses broad budget table %s", async privilege => {
    mock.catalog = { memberships: [], grants: [{ role: "PUBLIC", kind: "table", schema: "business_v1",
      relation: "wallet_service_provider_budgets", privilege }] };
    await expect(create().probe()).rejects.toThrow("least-privilege");
  });

  it.each(["INSERT", "REFERENCES"])("refuses even mutable-column budget %s", async privilege => {
    mock.catalog = { memberships: [], grants: [{ role: "radar_runtime", kind: "column", schema: "business_v1",
      relation: "wallet_service_provider_budgets", column: "cooldown_until", privilege }] };
    await expect(create().probe()).rejects.toThrow("least-privilege");
  });

  it("permits only exact runtime counter/cooldown updates and still rejects them for read access", async () => {
    mock.catalog = { memberships: [{ member: "radar_runtime", role: "counter_writer", inherit: false, set: true }],
      grants: ["window_started_at", "requests_used", "cooldown_until"].map(column => ({ role: "counter_writer",
        kind: "column", schema: "business_v1", relation: "wallet_service_provider_budgets", column, privilege: "UPDATE" })) };
    await expect(create().probe()).resolves.toMatchObject({ schemaVersion: 1 });
    await expect(create({ access: "read" }).probe()).rejects.toThrow("least-privilege");
  });

  it("cannot widen authority permissions with caller-declared configuration", async () => {
    mock.catalog = { memberships: [], grants: [{ role: "radar_runtime", kind: "column", schema: "business_v1",
      relation: "wallet_service_provider_budgets", column: "maximum_requests", privilege: "UPDATE" }] };
    const untrusted = { protectedTables: [], mutableProviderBudgetColumns: ["maximum_requests"] };
    await expect(create({ ...untrusted } as Partial<PostgresBusinessOptions>).probe()).rejects.toThrow("least-privilege");
  });
});

describe("checked-out client error lifecycle (EventEmitter protocol, not live PostgreSQL)", () => {
  const fatal = () => Object.assign(new Error("idle-in-transaction termination"), { code: "25P03" });

  it("handles FATAL while waiting in a callback and does not acknowledge or send COMMIT on the broken connection", async () => {
    const runtime = create(); const error = fatal();
    const result = runtime.run(async () => {
      await Promise.resolve();
      expect(() => pool().clients[0]!.emit("error", error)).not.toThrow();
      return "must-not-acknowledge";
    });
    const caught = await result.catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors[0]).toBeInstanceOf(PostgresCommitUncertainError);
    expect(caught.errors[0].cause).toBe(error);
    expect(caught.errors[1]).toBe(error);
    expect(pool().statements.some(entry => entry.sql === "COMMIT")).toBe(false);
    expect(pool().connect).toHaveBeenCalledTimes(1);
    expect(pool().releases[0]).toBe(error);
    expect(pool().clients[0]!.listenerCount("error")).toBe(0);
    expect(runtime.statistics().activeOperations).toBe(0);
  });

  it("retains the first connection failure even when a callback catches failed SQL and another error event arrives", async () => {
    const first = fatal(); const next = new Error("secondary connection failure");
    const caught = await create().run(async tx => {
      pool().clients[0]!.emit("error", first);
      await expect(tx.query("UNSENT WRITE")).rejects.toBe(first);
      expect(() => pool().clients[0]!.emit("error", next)).not.toThrow();
    }).catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors).toEqual([first, first]);
    expect(pool().statements.some(entry => entry.sql === "UNSENT WRITE" || entry.sql === "COMMIT")).toBe(false);
    expect(pool().releases[0]).toBe(first);
  });

  it("discards a client terminated during BEGIN without opening a transaction or invoking business work", async () => {
    const error = fatal(); const callback = vi.fn(async () => undefined);
    mock.queryEvent = (sql, client) => { if (sql === "BEGIN") client.emit("error", error); };
    await expect(create().run(callback)).rejects.toBe(error);
    expect(callback).not.toHaveBeenCalled(); expect(pool().statements.map(entry => entry.sql)).toEqual(["BEGIN"]);
    expect(pool().releases[0]).toBe(error);
  });

  it("rejects a nominally resolved in-flight SQL response if a connection error was emitted before completion", async () => {
    const error = fatal();
    mock.queryEvent = (sql, client) => { if (sql === "IN-FLIGHT WRITE") client.emit("error", error); };
    const caught = await create().run(async tx => { await tx.query("IN-FLIGHT WRITE"); return "no-receipt"; }).catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors).toEqual([error, error]);
    expect(pool().statements.filter(entry => entry.sql === "IN-FLIGHT WRITE")).toHaveLength(1);
    expect(pool().statements.some(entry => entry.sql === "COMMIT")).toBe(false);
    expect(pool().releases[0]).toBe(error);
  });

  it("preserves commit uncertainty and never replays when FATAL arrives during COMMIT", async () => {
    const error = fatal();
    mock.queryEvent = (sql, client) => { if (sql === "COMMIT") client.emit("error", error); };
    const caught = await create().run(async tx => { await tx.query("WRITE"); }).catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors[0]).toBeInstanceOf(PostgresCommitUncertainError); expect(caught.errors[0].cause).toBe(error);
    expect(caught.errors[1]).toBe(error);
    expect(pool().statements.filter(entry => entry.sql === "COMMIT")).toHaveLength(1);
    expect(pool().statements.filter(entry => entry.sql === "WRITE")).toHaveLength(1);
    expect(pool().connect).toHaveBeenCalledTimes(1); expect(pool().releases[0]).toBe(error);
  });

  it("preserves callback and rollback failures when rollback emits a fatal connection event", async () => {
    const error = fatal(); const original = new Error("original callback failure");
    mock.queryEvent = (sql, client) => { if (sql === "ROLLBACK") client.emit("error", error); };
    const caught = await create().run(async () => { throw original; }).catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors).toEqual([original, error]);
    expect(pool().releases[0]).toBe(error);
    expect(pool().clients[0]!.listenerCount("error")).toBe(0);
  });

  it("removes per-checkout handlers across repeated reuse without treating client failures as idle-pool errors", async () => {
    const runtime = create(); await runtime.probe(); const client = pool().clients[0]!;
    pool().connect.mockResolvedValue(client);
    for (let index = 0; index < 20; index += 1) {
      await runtime.run(async () => { expect(client.listenerCount("error")).toBe(1); });
      expect(client.listenerCount("error")).toBe(0);
    }
    expect(pool().releases).toEqual(Array(21).fill(undefined));
    expect(runtime.statistics()).toMatchObject({ idleErrorCount: 0, lastIdleSqlState: null });
  });
});

describe("protocol V2 immutable authority boundaries (catalog protocol)", () => {
  it.each([
    ["migration_cutover_transitions_v2", "source_key"], ["migration_cutover_transitions_v2", "revision"], ["migration_cutover_transitions_v2", "state"],
    ["migration_cutover_first_write_markers", "source_key"], ["migration_cutover_first_write_markers", "marker_sha256"], ["migration_cutover_first_write_markers", "marker"],
  ])("rejects all consumer direct and SET-role mutations of %s.%s", async (relation, column) => {
    for (const role of ["radar_runtime", "marker_writer"]) for (const privilege of ["INSERT", "UPDATE", "REFERENCES"]) {
      mock.catalog = { memberships: [{ member: "radar_runtime", role: "marker_writer", inherit: false, set: true }],
        grants: [{ role, kind: "column", schema: "business_v1", relation: relation!, column: column!, privilege }] };
      await expect(create().probe()).rejects.toThrow("least-privilege");
    }
  });
});
