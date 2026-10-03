import { describe, expect, it } from "vitest";
import * as database from "../src/index.js";
import type { PostgresAcceptanceOptions, PostgresAcceptanceRuntime } from "../src/postgres-acceptance-driver.js";

const options: PostgresAcceptanceOptions = {
  connectionString: "postgresql://radar_test:test-secret@127.0.0.1:5433/radar_test",
  maximumConnections: 2,
  connectionTimeoutMs: 2_000,
  idleTimeoutMs: 5_000,
  statementTimeoutMs: 2_000,
  lockTimeoutMs: 500,
};
const create = (input = options): PostgresAcceptanceRuntime =>
  (database as unknown as { createPostgresAcceptanceRuntime: (value: PostgresAcceptanceOptions) => PostgresAcceptanceRuntime })
    .createPostgresAcceptanceRuntime(input);

describe("PostgreSQL acceptance driver", () => {
  it("exports an explicit acceptance runtime factory", () => {
    expect((database as unknown as Record<string, unknown>).createPostgresAcceptanceRuntime).toBeTypeOf("function");
  });

  it("does not connect on construction and closes idempotently", async () => {
    const runtime = create();
    expect(runtime.statistics()).toEqual({
      totalConnections: 0, idleConnections: 0, waitingConnections: 0,
      idleErrorCount: 0, lastIdleSqlState: null, state: "ready",
    });
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    expect(runtime.statistics().state).toBe("closed");
    await expect(runtime.run(async () => "unused")).rejects.toThrow("closing or closed");
  });

  it("rejects unsafe targets without exposing credentials", () => {
    for (const connectionString of [
      "sentinel-secret:not-a-url",
      "postgresql://radar_test:sentinel-secret@remote.invalid:5433/radar_test",
      "postgresql://radar_test:sentinel-secret@127.0.0.1:5433/business",
      "postgresql://radar_test:sentinel-secret@127.0.0.1:5433/radar_test?host=remote.invalid",
      "postgresql://radar_test:sentinel-secret@127.0.0.1:5433/radar_test#override",
      "postgresql://radar_test:sentinel-secret@127.0.0.1/radar_test",
      "postgresql://radar_test:sentinel-secret@127.0.0.1:0/radar_test",
      "postgresql://radar_test:sentinel-secret@127.0.0.1:65536/radar_test",
      "postgresql://127.0.0.1:5433/radar_test",
      "postgresql://radar_test:sentinel-secret@127.0.0.1:5433/nested%2Fradar_test",
      "postgresql://radar_test:%invalid@127.0.0.1:5433/radar_test",
    ]) {
      expect(() => create({ ...options, connectionString })).toThrow("explicit loopback _test");
      try { create({ ...options, connectionString }); } catch (error) {
        expect(String(error)).not.toContain("sentinel-secret");
        expect(String(error)).not.toContain(connectionString);
      }
    }
  });

  it("accepts valid explicit port boundaries without connecting", async () => {
    for (const port of [1, 65_535]) {
      const runtime = create({ ...options, connectionString: `postgresql://radar_test:test-secret@127.0.0.1:${port}/radar_test` });
      expect(runtime.statistics().totalConnections).toBe(0);
      await runtime.close();
    }
  });

  it("requires finite explicit resource limits", () => {
    for (const key of ["maximumConnections", "connectionTimeoutMs", "idleTimeoutMs", "statementTimeoutMs", "lockTimeoutMs"] as const) {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        expect(() => create({ ...options, [key]: value })).toThrow("resource limits");
      }
    }
    expect(() => create({ ...options, maximumConnections: 3 })).toThrow("resource limits");
    expect(() => create({ ...options, lockTimeoutMs: 2_001 })).toThrow("resource limits");
  });
});
