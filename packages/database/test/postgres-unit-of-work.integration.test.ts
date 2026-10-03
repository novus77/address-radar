import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, type PostgresPool, type PostgresResult } from "../src/postgres-unit-of-work.js";

const testUrl = process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
interface TestPool extends PostgresPool {
  query(text: string, values?: unknown[]): Promise<PostgresResult>;
  end(): Promise<void>;
}

function createTestPool(): TestPool {
  const url = new URL(testUrl!);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !database.endsWith("_test")) {
    throw new Error("PostgreSQL integration tests require a local database ending in _test");
  }
  // Opting in requires a separately provisioned test driver and database; never auto-install or migrate.
  const driver = createRequire(import.meta.url)("pg") as {
    Pool: new (config: { connectionString: string; max: number; connectionTimeoutMillis: number }) => TestPool;
  };
  return new driver.Pool({ connectionString: testUrl!, max: 2, connectionTimeoutMillis: 2_000 });
}

describe.skipIf(!testUrl)("PostgreSQL real transaction integration", () => {
  it("rolls back writes on the same client and returns a committed result", async () => {
    const pool = createTestPool();
    const work = createPostgresUnitOfWork(pool, { statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
    try {
      await expect(work.run(async tx => {
        await tx.query("CREATE TEMP TABLE radar_uow_probe (id integer PRIMARY KEY) ON COMMIT DROP");
        await work.run(async nested => { await nested.query("INSERT INTO radar_uow_probe VALUES (1)"); });
        const result = await tx.query("SELECT count(*)::integer AS count FROM radar_uow_probe");
        expect(result.rows[0]?.count).toBe(1);
        throw new Error("rollback probe");
      })).rejects.toThrow("rollback probe");
      await expect(work.run(async tx => {
        const result = await tx.query("SELECT to_regclass('pg_temp.radar_uow_probe') AS relation");
        expect(result.rows[0]?.relation).toBeNull();
        await tx.query("CREATE TEMP TABLE radar_uow_probe (id integer PRIMARY KEY) ON COMMIT DROP");
        await tx.query("INSERT INTO radar_uow_probe VALUES (2)");
        return "committed";
      })).resolves.toBe("committed");
    } finally {
      await pool.end();
    }
  });

  it("rolls back an aborted transaction even when a SQL error was caught", async () => {
    const pool = createTestPool();
    const work = createPostgresUnitOfWork(pool, { statementTimeoutMs: 2_000, lockTimeoutMs: 500 });
    try {
      await expect(work.run(async tx => { await tx.query("SELECT 1 / 0").catch(() => undefined); })).rejects.toBeDefined();
      await expect(work.run(async tx => (await tx.query("SELECT 1 AS value")).rows[0]?.value)).resolves.toBe(1);
    } finally {
      await pool.end();
    }
  });
});
