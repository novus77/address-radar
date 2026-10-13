import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { authenticatePostgresBusinessNamespaceReceipt, postgresBusinessNamespaceReceiptSigningPayload, installPostgresBusinessSchema,
  POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL, POSTGRES_BUSINESS_SCHEMA_PLAN, type PostgresBusinessProvisionedNamespaceReceipt } from "../src/postgres-business-schema.js";
import { describe, expect, it, vi } from "vitest";
import { createPostgresMigrationRuntime, PostgresMigrationDeadlineError,
  type PostgresMigrationRuntimeOptions } from "../src/postgres-migration-runtime.js";
import { PostgresCommitUncertainError } from "../src/postgres-unit-of-work.js";

type MutableFixtureOptions = { -readonly [Key in keyof PostgresMigrationRuntimeOptions]: PostgresMigrationRuntimeOptions[Key] };

function fixture(changes: Partial<PostgresMigrationRuntimeOptions> = {}) {
  const statements: string[] = [], release = vi.fn(), end = vi.fn(async () => {});
  const target = { database: "radar_acceptance_business", username: "radar_migrator", schema: "radar_acceptance_schema",
    service: "migration", generation: "generation-one", serverAddress: "127.0.0.1", serverPort: 5434,
    schemaVersion: 2, schemaFingerprint: "a".repeat(64), systemIdentifier: "123456789" };
  const identity: Record<string, unknown> = { role_safe: true, no_role_memberships: true, owns_target_schema: true,
    cannot_create_schema: true, cannot_create_temp: true, no_other_schema_authority: true, no_other_relation_authority: true,
    no_other_sequence_authority: true, no_callable_security_definers: true };
  const kinds = { identity: { kind: "r", persistence: "p" }, ledger: { kind: "r", persistence: "p" } };
  const grants: Array<{ kind: "sequence" | "function"; schema: string; privilege: "USAGE" | "UPDATE" | "SELECT" | "EXECUTE" | "OWNER";
    securityDefiner?: boolean }> = [];
  let override: ((sql: string, values?: unknown[]) => Promise<unknown>) | undefined;
  const client = new EventEmitter();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    const replacement = override ? await override(sql, values) : undefined;
    // These concrete grants are an ACL/catalog protocol model, not an actual PostgreSQL server.
    const visible = (name: string): boolean => sql.includes("NOT LIKE 'pg_%'") ? !/^pg./.test(name) : !/^pg_/.test(name);
    const rows = Array.isArray(replacement) ? replacement : sql.includes("migration-runtime-identity") ? [{
      database: target.database, username: target.username, session_username: target.username, server_address: target.serverAddress,
      server_port: target.serverPort, system_identifier: target.systemIdentifier, ...identity,
      no_other_sequence_authority: identity.no_other_sequence_authority === true && !grants.some(grant => grant.kind === "sequence"
        && grant.schema !== target.schema && visible(grant.schema) && (grant.privilege === "OWNER"
          ? sql.includes("c.relkind='S'") && sql.includes("c.relowner=r.oid")
          : ["USAGE", "UPDATE"].includes(grant.privilege) && sql.includes("has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE')"))),
      no_callable_security_definers: identity.no_callable_security_definers === true && !grants.some(grant => grant.kind === "function"
        && grant.securityDefiner && visible(grant.schema) && grant.privilege === "EXECUTE"
        && sql.includes("p.prosecdef") && sql.includes("has_function_privilege(r.oid,p.oid,'EXECUTE')")),
    }] : sql.includes("migration-runtime-ledger-kind") ? [{
      identity_valid: kinds.identity.kind === "r" && kinds.identity.persistence === "p",
      ledger_valid: kinds.ledger.kind === "r" && kinds.ledger.persistence === "p",
    }] : sql.includes("migration-runtime-ledger") ? [{ database_name: target.database, schema_name: target.schema,
      generation_id: target.generation, ledger_format: 1, version: target.schemaVersion, fingerprint: target.schemaFingerprint }] : [];
    return { rows, rowCount: rows.length };
  });
  const native = Object.assign(client, { query, release });
  const options: MutableFixtureOptions = { pool: { connect: vi.fn(async () => native), end }, target,
    capability: { mode: "isolated", purpose: "business_import", approvalRef: "approved-fixture", planSha256: "b".repeat(64), expiresAtMs: Date.now() + 60000 },
    limits: { operationTimeoutMs: 1000, connectionTimeoutMs: 100, statementTimeoutMs: 100, lockTimeoutMs: 50,
      maximumSqlStatements: 100, workMemKb: 1024, closeTimeoutMs: 100 }, clock: Date.now, assertAuthorized: vi.fn(async () => {}), ...changes };
  return { options, target, identity, grants, kinds, native, statements, release, end, query,
    override: (fn: (sql: string, values?: unknown[]) => Promise<unknown>) => { override = fn; },
    runtime: () => createPostgresMigrationRuntime(options) };
}
describe("dedicated PostgreSQL migration runtime", () => {
  it("checks authority and commits the projection and first-write marker in one physical transaction", async () => {
    const f = fixture(), runtime = f.runtime();
    await runtime.run(async tx => { await tx.query("INSERT projection"); await tx.query("INSERT first_write_marker"); });
    expect(f.statements.filter(sql => sql === "BEGIN")).toHaveLength(1);
    expect(f.statements.slice(-3)).toEqual(["INSERT projection", "INSERT first_write_marker", "COMMIT"]);
    expect(f.options.assertAuthorized).toHaveBeenCalledTimes(2);
    expect(f.release).toHaveBeenCalledWith(undefined);
    await runtime.close(); expect(f.end).toHaveBeenCalledOnce();
  });
  it("propagates a marker failure and rolls back the complete import", async () => {
    const f = fixture(); f.override(async sql => { if (sql === "INSERT marker") throw new Error("marker rejected"); });
    await expect(f.runtime().run(async tx => { await tx.query("INSERT projection"); await tx.query("INSERT marker"); })).rejects.toThrow("marker rejected");
    expect(f.statements.at(-1)).toBe("ROLLBACK"); expect(f.statements).not.toContain("COMMIT");
  });
  it("rejects nested migration UOWs instead of accidentally acknowledging a joined scope", async () => {
    const f = fixture(), runtime = f.runtime();
    await expect(runtime.run(() => runtime.run(async () => {}))).rejects.toThrow("nested_migration_uow_forbidden");
    expect(f.statements.at(-1)).toBe("ROLLBACK");
  });
  it("denies expired approval before opening a connection", async () => {
    const f = fixture(); const runtime = createPostgresMigrationRuntime({ ...f.options,
      capability: { ...f.options.capability, expiresAtMs: Date.now() - 1 } });
    await expect(runtime.run(async () => {})).rejects.toBeInstanceOf(PostgresMigrationDeadlineError);
    expect(f.options.pool.connect).not.toHaveBeenCalled();
  });
  it("does not treat a configured capability as authorization", async () => {
    const f = fixture({ assertAuthorized: async () => { throw new Error("approval rejected"); } });
    await expect(f.runtime().run(async () => {})).rejects.toThrow("approval rejected");
    expect(f.options.pool.connect).not.toHaveBeenCalled();
  });
  it("checks schema identity before business import and refuses mismatch", async () => {
    const f = fixture(); const runtime = createPostgresMigrationRuntime({ ...f.options,
      target: { ...f.options.target, schemaFingerprint: "c".repeat(64) } });
    await expect(runtime.run(async tx => tx.query("INSERT forbidden"))).rejects.toThrow("schema_or_generation_mismatch");
    expect(f.statements).not.toContain("INSERT forbidden");
  });
  it("requires exact loopback target and isolated names", () => {
    const f = fixture();
    expect(() => createPostgresMigrationRuntime({ ...f.options, target: { ...f.options.target, serverAddress: "10.0.0.1" } })).toThrow("invalid_target");
    expect(() => createPostgresMigrationRuntime({ ...f.options, target: { ...f.options.target, database: "radar_business" } })).toThrow("isolated_target_required");
  });
  it("bounds a hanging callback and discards the connection", async () => {
    const f = fixture(); const runtime = createPostgresMigrationRuntime({ ...f.options,
      limits: { ...f.options.limits, operationTimeoutMs: 30, connectionTimeoutMs: 20, statementTimeoutMs: 20, lockTimeoutMs: 10 } });
    await expect(runtime.run(() => new Promise<never>(() => {}))).rejects.toThrow();
    expect(f.release).toHaveBeenCalledOnce(); expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
  it("reports uncertain COMMIT without acknowledging an imported batch", async () => {
    const f = fixture(); f.override(async sql => { if (sql === "COMMIT") throw new Error("lost commit response"); });
    await expect(f.runtime().run(async tx => tx.query("INSERT projection"))).rejects.toBeInstanceOf(PostgresCommitUncertainError);
    expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(PostgresCommitUncertainError);
  });
  it("bounds SQL statements and rejects further writes", async () => {
    const f = fixture(); const runtime = createPostgresMigrationRuntime({ ...f.options, limits: { ...f.options.limits, maximumSqlStatements: 5 } });
    await expect(runtime.run(async tx => tx.query("INSERT forbidden"))).rejects.toThrow();
    expect(f.statements).not.toContain("INSERT forbidden");
  });
});

describe("migration authority and client lifecycle regression protocols", () => {
  it.each(["database", "username", "session_username", "server_address", "server_port", "system_identifier"])
    ("rejects mismatched actual connection identity %s before invoking import work", async field => {
      const f = fixture(); f.identity[field] = "other_identity"; const callback = vi.fn(async () => {});
      await expect(f.runtime().run(callback)).rejects.toThrow("identity_or_authority_mismatch");
      expect(callback).not.toHaveBeenCalled(); expect(f.statements).not.toContain("COMMIT");
    });

  it.each(["role_safe", "no_role_memberships", "owns_target_schema", "cannot_create_schema", "cannot_create_temp",
    "no_other_schema_authority", "no_other_relation_authority", "no_other_sequence_authority", "no_callable_security_definers"])
    ("fails closed for false or unknown authority evidence %s", async field => {
      for (const value of [false, undefined]) {
        const f = fixture(); f.identity[field] = value; const callback = vi.fn(async () => {});
        await expect(f.runtime().run(callback)).rejects.toThrow("identity_or_authority_mismatch");
        expect(callback).not.toHaveBeenCalled();
      }
    });

  it.each(["USAGE", "UPDATE", "OWNER"] as const)("protocol: refuses outside-schema sequence %s authority", async privilege => {
    for (const schema of ["legacy", "public", "pga_helpers"]) {
      const f = fixture(); f.grants.push({ kind: "sequence", schema, privilege });
      await expect(f.runtime().probe()).rejects.toThrow("identity_or_authority_mismatch");
    }
  });

  it("protocol: permits read-only outside sequences and owned target sequences", async () => {
    const f = fixture(); f.grants.push({ kind: "sequence", schema: "legacy", privilege: "SELECT" },
      { kind: "sequence", schema: f.target.schema, privilege: "OWNER" });
    const runtime = f.runtime(); await expect(runtime.probe()).resolves.toMatchObject({ schemaVersion: 2 }); await runtime.close();
  });

  it.each(["legacy", "public", "pga_helpers", "radar_acceptance_schema"])
    ("protocol: refuses executable user SECURITY DEFINER entrypoints in %s", async schema => {
      const f = fixture(); f.grants.push({ kind: "function", schema, privilege: "EXECUTE", securityDefiner: true });
      await expect(f.runtime().probe()).rejects.toThrow("identity_or_authority_mismatch");
    });

  it("protocol: permits SECURITY INVOKER user functions and catalog built-ins", async () => {
    const f = fixture(); f.grants.push({ kind: "function", schema: "legacy", privilege: "EXECUTE", securityDefiner: false },
      { kind: "function", schema: "pg_catalog", privilege: "EXECUTE", securityDefiner: true });
    const runtime = f.runtime(); await runtime.probe(); await runtime.close();
  });

  it("submits membership and PUBLIC-aware ACL predicates without wildcard pg-prefix blind spots", async () => {
    const f = fixture(), runtime = f.runtime(); await runtime.probe();
    const sql = f.statements.find(statement => statement.includes("migration-runtime-identity"))!;
    expect(sql).toContain("pg_catalog.pg_has_role(r.oid,other.oid,'MEMBER')");
    expect(sql).toContain("has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')");
    expect(sql).toContain("has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE')");
    expect(sql).toContain("has_function_privilege(r.oid,p.oid,'EXECUTE')");
    expect(sql).not.toContain("NOT LIKE 'pg_%'"); await runtime.close();
  });

  it.each(["identity", "ledger"] as const)("rejects counterfeit %s views or nonpermanent tables before reading import ledgers", async name => {
    for (const [kind, persistence] of [["v", "p"], ["m", "p"], ["r", "u"], ["r", "t"]]) {
      const f = fixture(); f.kinds[name] = { kind: kind!, persistence: persistence! };
      await expect(f.runtime().probe()).rejects.toThrow("ledger_requires_permanent_tables");
      expect(f.statements.some(sql => sql.includes("/* migration-runtime-ledger */"))).toBe(false);
    }
  });

  it("schema_install requires the existing owned namespace but never reads or applies a business ledger automatically", async () => {
    const f = fixture(); f.options.capability = { ...f.options.capability, purpose: "schema_install" };
    const runtime = f.runtime(); await runtime.probe();
    expect(f.statements.some(sql => sql.includes("migration-runtime-ledger"))).toBe(false);
    expect(f.statements.some(sql => /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(sql.split("/* migration-runtime-identity */")[0]!))).toBe(false);
    expect(f.options.assertAuthorized).toHaveBeenCalledTimes(2); await runtime.close();
  });

  it("pins catalog search path and only explicit resource limits before BEGIN and the UOW settings", async () => {
    const f = fixture(), runtime = f.runtime(); await runtime.probe();
    expect(f.statements[0]).toContain("/* migration-runtime-bootstrap */");
    expect(f.statements[0]).toContain("pg_catalog.set_config('search_path','pg_catalog',false)");
    expect(f.statements[1]).toBe("BEGIN");
    expect(f.query.mock.calls[0]?.[1]).toEqual(["100", "50", "1000", "1024kB"]);
    await runtime.close();
  });

  it("refuses a second runtime for the same pool object, including after closure", async () => {
    const f = fixture(), runtime = f.runtime();
    expect(() => f.runtime()).toThrow("dedicated_pool_already_owned");
    await runtime.close(); expect(() => f.runtime()).toThrow("dedicated_pool_already_owned");
    expect(f.options.pool.connect).not.toHaveBeenCalled();
  });

  it("snapshots bound pool ports and exact capability pins rather than accepting mutable manifests as external authority", async () => {
    const f = fixture(), runtime = f.runtime();
    f.options.pool.connect = vi.fn(async () => { throw new Error("mutated pool escape"); });
    f.options.pool.end = vi.fn(async () => { throw new Error("mutated close escape"); });
    f.options.capability = { ...f.options.capability, purpose: "schema_install", planSha256: "c".repeat(64) };
    await runtime.probe(); await runtime.close();
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.options.assertAuthorized).toHaveBeenNthCalledWith(1, expect.objectContaining({
      capability: expect.objectContaining({ purpose: "business_import", planSha256: "b".repeat(64) }),
    }));
    expect(f.statements.some(sql => sql.includes("/* migration-runtime-ledger */"))).toBe(true);
  });

  it("rechecks external phase/approval before physical COMMIT and rolls back on revocation", async () => {
    const f = fixture(); let checks = 0;
    f.options.assertAuthorized = vi.fn(async request => {
      expect(Object.isFrozen(request)).toBe(true); expect(Object.isFrozen(request.target)).toBe(true);
      expect(Object.isFrozen(request.capability)).toBe(true);
      if (++checks === 2) throw new Error("approval revoked before commit");
    });
    const runtime = f.runtime();
    await expect(runtime.run(async tx => { await tx.query("INSERT reviewed projection"); })).rejects.toThrow("approval revoked before commit");
    expect(f.statements.at(-1)).toBe("ROLLBACK"); expect(f.statements).not.toContain("COMMIT"); await runtime.close();
  });

  it("discards late acquisitions once and refuses new operations after connection timeout", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let resolve!: (client: typeof f.native) => void;
      f.options.pool.connect = vi.fn(() => new Promise<typeof f.native>(done => { resolve = done; }));
      const runtime = f.runtime(); const first = runtime.probe(); const assertion = expect(first).rejects.toBeInstanceOf(PostgresMigrationDeadlineError);
      await vi.advanceTimersByTimeAsync(100); await assertion;
      await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy");
      expect(f.options.pool.connect).toHaveBeenCalledOnce(); resolve(f.native); await vi.advanceTimersByTimeAsync(0);
      expect(f.release).toHaveBeenCalledOnce(); expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(PostgresMigrationDeadlineError);
      expect(f.statements).toHaveLength(0); expect(f.native.listenerCount("error")).toBe(0); await runtime.close();
    } finally { vi.useRealTimers(); }
  });

  it("does not admit another hanging callback after timeout or allow its late transactional SQL", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let late!: () => Promise<unknown>;
      const runtime = f.runtime(); const first = runtime.run(async tx => {
        await new Promise<void>(done => { late = async () => { done(); return tx.query("LATE WRITE"); }; });
      });
      const assertion = expect(first).rejects.toThrow(); await vi.advanceTimersByTimeAsync(1000); await assertion;
      await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy");
      await expect(late()).rejects.toThrow("transaction scope is closed");
      expect(f.statements).not.toContain("LATE WRITE"); expect(f.release).toHaveBeenCalledOnce();
      expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(PostgresMigrationDeadlineError); await runtime.close();
    } finally { vi.useRealTimers(); }
  });

  it("captures checked-out FATAL events, refuses acknowledgment and removes listeners", async () => {
    const f = fixture(), error = Object.assign(new Error("idle transaction terminated"), { code: "25P03" });
    const runtime = f.runtime(); const result = runtime.run(async () => { expect(() => f.native.emit("error", error)).not.toThrow(); });
    const caught = await result.catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors[0]).toBeInstanceOf(PostgresCommitUncertainError);
    expect(caught.errors[0].cause).toBe(error); expect(f.release).toHaveBeenCalledWith(error);
    expect(f.native.listenerCount("error")).toBe(0); await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy"); await runtime.close();
  });

  it("handles idle pool errors without uncaught events and cleans up only after pool end", async () => {
    const f = fixture(); const events = new EventEmitter();
    f.options.pool = Object.assign(events, f.options.pool); const runtime = f.runtime();
    const error = Object.assign(new Error("idle connection failed"), { code: "08006" });
    expect(() => events.emit("error", error)).not.toThrow(); await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy");
    expect(events.listenerCount("error")).toBe(1); await runtime.close(); expect(events.listenerCount("error")).toBe(0);
  });

  it("preserves physically uncertain COMMIT timeout without replay and still observes a late server completion", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let finish!: () => void; let physicallyCommitted = false;
      f.override(async sql => { if (sql === "COMMIT") await new Promise<void>(done => { finish = () => { physicallyCommitted = true; done(); }; }); });
      const runtime = f.runtime(); const first = runtime.run(async tx => { await tx.query("INSERT first_write_marker"); });
      const assertion = expect(first).rejects.toThrow(); await vi.advanceTimersByTimeAsync(1000); await assertion;
      const caught = await first.catch(value => value);
      expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors[0]).toBeInstanceOf(PostgresCommitUncertainError);
      expect(f.statements.filter(sql => sql === "COMMIT")).toHaveLength(1); expect(physicallyCommitted).toBe(false);
      await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy"); finish(); await vi.advanceTimersByTimeAsync(0);
      expect(physicallyCommitted).toBe(true); expect(f.release).toHaveBeenCalledOnce(); await runtime.close();
    } finally { vi.useRealTimers(); }
  });

  it("bounds close without pretending a hanging pool.end completed", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let ended!: () => void;
      f.options.pool.end = vi.fn(() => new Promise<void>(done => { ended = done; }));
      const runtime = f.runtime(), closing = runtime.close(); const assertion = expect(closing).rejects.toBeInstanceOf(PostgresMigrationDeadlineError);
      await vi.advanceTimersByTimeAsync(100); await assertion;
      expect(runtime.close()).toBe(closing); await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy");
      ended(); await vi.advanceTimersByTimeAsync(0);
    } finally { vi.useRealTimers(); }
  });

  it("composes signed preprovisioned-empty bootstrap with the independently authorized schema_install executor", async () => {
    const f = fixture(); Object.assign(f.target, { database: "radar_rehearsal_0123456789abcdef", schema: "radar_rehearsal_0123456789abcdef_schema",
      schemaVersion: 1, schemaFingerprint: POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint });
    f.options.capability = { ...f.options.capability, purpose: "schema_install" };
    const runtime = f.runtime(); const namespace = { oid: 42, namespace_oid: "42", namespace_owner_oid: "64",
      namespace_owner: f.target.username, database_oid: "32" };
    let initialized = false; const history: Array<Record<string, unknown>> = [];
    f.override(async (sql, values = []) => {
      if (sql.includes("business-schema-installer-identity")) return [{ database: f.target.database, username: f.target.username,
        session_username: f.target.username, role_safe: true }];
      if (sql.includes("business-schema-namespace")) return [namespace];
      if (sql.includes("business-schema-provisioned-cluster")) return [{ system_identifier: f.target.systemIdentifier, database_create: false, database_temp: false }];
      if (sql.includes("business-schema-presence")) return [{ identity_exists: initialized, ledger_exists: initialized,
        identity_valid: initialized, ledger_valid: initialized }];
      if (sql === POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL) initialized = true;
      if (sql.includes("business-schema-header")) return [{ singleton: true, ledger_format: 1, database_name: f.target.database,
        schema_name: f.target.schema, generation_id: f.target.generation }];
      if (sql.includes("business-schema-history")) return history;
      if (sql.startsWith(`INSERT INTO "${f.target.schema}".business_schema_ledger`)) history.push({ version: values[0], fingerprint: values[1],
        previous_fingerprint: values[2], modules_json: values[3] });
      return undefined;
    });
    const at = Date.now(), keys = generateKeyPairSync("ed25519");
    const receipt: PostgresBusinessProvisionedNamespaceReceipt = { version: 1, purpose: "provisioned-empty-business-namespace",
      receiptId: "fixture/namespace-1", signerKeyId: "fixture/external-authority", approvalRef: f.options.capability.approvalRef,
      database: f.target.database, databaseOid: "32", schema: f.target.schema, namespaceOid: "42", owner: f.target.username, ownerOid: "64",
      generation: f.target.generation, service: "migration", schemaVersion: 1, schemaFingerprint: POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint,
      systemIdentifier: f.target.systemIdentifier, issuedAt: at, expiresAt: at + 60000 };
    const approval = authenticatePostgresBusinessNamespaceReceipt({ receipt,
      signatureBase64: sign(null, Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(receipt)), keys.privateKey).toString("base64") },
    { signerKeyId: receipt.signerKeyId, publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), maximumReceiptAgeMs: 60000, clock: Date.now });
    await expect(installPostgresBusinessSchema(runtime, { target: f.target, approvalRef: receipt.approvalRef,
      approval: "approved-provisioned-business-schema", provisionedNamespaceApproval: approval })).resolves.toMatchObject({ status: "installed", namespaceOid: "42" });
    expect(f.statements.some(sql => sql.startsWith("CREATE SCHEMA") || /^GRANT/.test(sql))).toBe(false);
    expect(f.options.assertAuthorized).toHaveBeenCalledTimes(2); expect(f.statements.at(-1)).toBe("COMMIT"); await runtime.close();
  });
});

it("discards a checked-out client with an incomplete event port before issuing any SQL", async () => {
  const f = fixture(); Object.assign(f.native, { removeListener: undefined });
  const runtime = f.runtime(); await expect(runtime.probe()).rejects.toThrow("invalid_error_event_port");
  expect(f.release).toHaveBeenCalledOnce(); expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(f.statements).toHaveLength(0); await runtime.close();
});

it("bounds the entire operation using its explicit limit even when external wall clock is frozen", async () => {
  const f = fixture({ clock: () => 1000 });
  f.options.limits = { ...f.options.limits, operationTimeoutMs: 30, connectionTimeoutMs: 10, statementTimeoutMs: 10, lockTimeoutMs: 5 };
  const runtime = f.runtime();
  await expect(runtime.run(() => new Promise<never>(() => {}))).rejects.toThrow();
  await expect(runtime.probe()).rejects.toThrow("runtime_closed_or_busy");
  expect(f.release).toHaveBeenCalledOnce(); expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(PostgresMigrationDeadlineError);
  await runtime.close();
});

it("rejects an authority clock moving backwards within an operation, not only behind its initial timestamp", async () => {
  const f = fixture(); let at = 1000; f.options.clock = () => at;
  const runtime = f.runtime();
  await expect(runtime.run(async tx => { at = 1200; await tx.query("FIRST WRITE"); at = 1100; await tx.query("UNSENT SECOND WRITE"); })).rejects.toThrow();
  expect(f.statements).not.toContain("UNSENT SECOND WRITE"); expect(f.statements).not.toContain("COMMIT");
  expect(f.release).toHaveBeenCalledOnce(); await runtime.close();
});
