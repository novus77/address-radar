import { describe, expect, it, vi } from "vitest";
import { createPostgresAcceptanceRuntime } from "../src/index.js";
import type { PostgresAcceptanceOptions } from "../src/postgres-acceptance-driver.js";

const testUrl = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const options = (): PostgresAcceptanceOptions => ({ connectionString: testUrl!, maximumConnections: 2,
  connectionTimeoutMs: 2_000, idleTimeoutMs: 5_000, statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe.skipIf(!testUrl)("PostgreSQL acceptance real driver", () => {
  it("verifies the isolated target and preserves exact numeric representations", async () => {
    const runtime = createPostgresAcceptanceRuntime(options());
    try {
      const identity = await runtime.probe();
      expect(identity.database).toBe(decodeURIComponent(new URL(testUrl!).pathname.slice(1)));
      expect(identity.username).toBe(decodeURIComponent(new URL(testUrl!).username));
      expect(["127.0.0.1", "::1"]).toContain(identity.serverAddress);
      expect(identity.serverPort).toBeGreaterThan(0);
      expect(identity.serverPort).toBeLessThanOrEqual(65_535);
      const row = await runtime.run(async tx => (await tx.query("SELECT 9007199254740993::bigint AS large_integer, 0.000000000000000000001::numeric AS exact_decimal")).rows[0]);
      expect(row).toEqual({ large_integer: "9007199254740993", exact_decimal: "0.000000000000000000001" });
    } finally { await runtime.close(); }
  });

  it("adapts batch results and keeps nested transactions on one client", async () => {
    const runtime = createPostgresAcceptanceRuntime(options());
    try {
      await runtime.run(async tx => {
        expect((await tx.query("SELECT 1 AS value; SELECT 2 AS value")).rows[0]?.value).toBe(2);
        const outer = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        await runtime.run(async nested => {
          expect(nested).toBe(tx);
          expect((await nested.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid).toBe(outer);
        });
      });
    } finally { await runtime.close(); }
  });

  it("rolls back failed writes before the connection is reused", async () => {
    const runtime = createPostgresAcceptanceRuntime(options());
    try {
      await expect(runtime.run(async tx => {
        await tx.query("CREATE TEMP TABLE acceptance_driver_rollback(id integer PRIMARY KEY) ON COMMIT DROP");
        await tx.query("INSERT INTO acceptance_driver_rollback VALUES (1)");
        throw new Error("rollback marker");
      })).rejects.toThrow("rollback marker");
      expect(await runtime.run(async tx => (await tx.query("SELECT to_regclass('pg_temp.acceptance_driver_rollback') AS relation")).rows[0]?.relation)).toBeNull();
    } finally { await runtime.close(); }
  });

  it("drains existing work while refusing new transactions during shutdown", async () => {
    const runtime = createPostgresAcceptanceRuntime(options());
    const entered = gate();
    const release = gate();
    const operation = runtime.run(async tx => {
      await tx.query("SELECT 1");
      entered.release();
      await release.promise;
      await tx.query("SELECT 2");
      return "committed";
    });
    void operation.catch(() => entered.release());
    try {
      await entered.promise;
      const closing = runtime.close();
      expect(runtime.close()).toBe(closing);
      expect(runtime.statistics().state).toBe("closing");
      await expect(runtime.run(async () => "unused")).rejects.toThrow("closing or closed");
      release.release();
      await expect(operation).resolves.toBe("committed");
      await closing;
      expect(runtime.statistics().state).toBe("closed");
    } finally { release.release(); await operation.catch(() => undefined); await runtime.close(); }
  });

  it("bounds pool waiting without executing or replaying the queued callback", async () => {
    const runtime = createPostgresAcceptanceRuntime({ ...options(), maximumConnections: 1, connectionTimeoutMs: 100 });
    const entered = gate();
    const release = gate();
    const operation = runtime.run(async tx => { await tx.query("SELECT 1"); entered.release(); await release.promise; });
    void operation.catch(() => entered.release());
    const callback = vi.fn(async () => "should not execute");
    try {
      await entered.promise;
      await expect(runtime.run(callback)).rejects.toThrow(/timeout/i);
      expect(callback).not.toHaveBeenCalled();
      release.release();
      await operation;
      expect(await runtime.run(async tx => (await tx.query("SELECT 3 AS value")).rows[0]?.value)).toBe(3);
    } finally { release.release(); await operation.catch(() => undefined); await runtime.close(); }
  });

  it("observes idle connection failure without leaking raw error messages", async () => {
    const runtime = createPostgresAcceptanceRuntime(options());
    const actor = createPostgresAcceptanceRuntime(options());
    try {
      const pid = await runtime.run(async tx => (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
      await actor.run(async tx => { await tx.query("SELECT pg_terminate_backend($1)", [pid]); });
      await vi.waitFor(() => expect(runtime.statistics().idleErrorCount).toBeGreaterThan(0));
      expect(runtime.statistics().lastIdleSqlState).toMatch(/^[0-9A-Z]{5}$/);
      expect(await runtime.run(async tx => (await tx.query("SELECT 1 AS value")).rows[0]?.value)).toBe(1);
    } finally { await runtime.close(); await actor.close(); }
  });
});
