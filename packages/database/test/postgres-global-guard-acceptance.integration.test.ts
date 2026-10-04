import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GLOBAL_GUARD_LEDGER_TABLES } from "../src/global-guard-snapshot-preflight.js";
import { createPostgresAcceptanceRuntime } from "../src/postgres-acceptance-driver.js";
import { verifyPostgresGlobalGuardRoundTrip } from "../src/postgres-global-guard-acceptance.js";

const connectionString = process.env.ADDRESS_RADAR_POSTGRES_ACCEPTANCE_TEST_URL;
describe.skipIf(!connectionString)("PostgreSQL guard ledger TEMP acceptance", () => {
  it("restores multi-page SQLite values and rolls back a partial target write", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-guard-pg-integration-"));
    const path = join(root, "source.db");
    const source = new DatabaseSync(path);
    const runtime = createPostgresAcceptanceRuntime({
      connectionString: connectionString!, maximumConnections: 1, connectionTimeoutMs: 3000,
      idleTimeoutMs: 5000, statementTimeoutMs: 2000, lockTimeoutMs: 250,
    });
    try {
      const keys: Record<string, string[]> = {
        broadcast_records: ["broadcast_id"], evidence_consumption: ["event_id"], economic_evidence_consumption: ["dedupe_key"],
        outcome_observations: ["broadcast_id", "horizon"], signal_outbox: ["outbox_id"], signal_outbox_migration_review: ["review_id"],
        provider_budget_usage: ["provider", "usage_window"], provider_request_gates: ["provider"], historical_backfill_credit_usage: ["usage_day"],
      };
      for (const table of GLOBAL_GUARD_LEDGER_TABLES) {
        source.exec(`CREATE TABLE ${table} (${keys[table]!.map(key => `${key} TEXT`).join(",")},
          marker TEXT, payload BLOB, big_value INTEGER, real_value REAL, PRIMARY KEY (${keys[table]!.join(",")}))`);
      }
      const insert = source.prepare("INSERT INTO provider_budget_usage VALUES(?,?,?,?,?,?)");
      source.exec("BEGIN");
      for (let index = 0; index < 1005; index++) {
        insert.run("provider", String(index).padStart(6, "0"), "nul\u0000text", Buffer.from([0, 255]), 9223372036854775807n, 0.125);
      }
      source.exec("COMMIT");
      source.exec("INSERT INTO provider_request_gates(provider,marker) VALUES('provider','original')");
      const report = await verifyPostgresGlobalGuardRoundTrip(runtime, path, { pageSize: 64 });
      expect(report.status).toBe("passed");
      expect(report.sourceRows).toBe(1006);
      expect(report.sourcePages).toBe(17);
      expect(report.partialFailureRollback).toBe(true);
      expect(report.sameSessionCleanupVerified).toBe(true);
      expect(report.targetRoundTripVerified).toBe(true);
      expect(report.purchaseDependenciesVerified).toBe(false);
      expect(report.productionMigrationReady).toBe(false);
    } finally {
      await runtime.close(); source.close(); rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
