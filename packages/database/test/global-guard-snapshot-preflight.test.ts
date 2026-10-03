import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  GLOBAL_GUARD_LEDGER_TABLES, readOnlyGlobalGuardSnapshot,
  type GuardLedgerPage,
} from "../src/global-guard-snapshot-preflight.js";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "radar-guard-snapshot-"));
  roots.push(root);
  const path = join(root, "source.db");
  const database = new DatabaseSync(path);
  databases.push(database);
  database.exec("PRAGMA journal_mode=WAL");
  const keys: Record<string, string[]> = {
    broadcast_records: ["broadcast_id"], evidence_consumption: ["event_id"],
    economic_evidence_consumption: ["dedupe_key"], outcome_observations: ["broadcast_id", "horizon"],
    signal_outbox: ["outbox_id"], signal_outbox_migration_review: ["review_id"],
    provider_budget_usage: ["provider", "usage_window"], provider_request_gates: ["provider"],
    historical_backfill_credit_usage: ["usage_day"],
  };
  for (const table of GLOBAL_GUARD_LEDGER_TABLES) {
    database.exec(`CREATE TABLE ${table} (${keys[table]!.map(key => `${key} TEXT`).join(",")},
      marker TEXT, payload BLOB, big_value INTEGER, real_value REAL,
      PRIMARY KEY (${keys[table]!.join(",")}))`);
  }
  return { database, path };
}

function budgets(database: DatabaseSync, count: number) {
  const insert = database.prepare("INSERT INTO provider_budget_usage(provider,usage_window,marker) VALUES(?,?,?)");
  database.exec("BEGIN");
  for (let index = 0; index < count; index++) insert.run("provider", String(index).padStart(6, "0"), "original");
  database.exec("COMMIT");
}

describe("global guard snapshot preflight", () => {
  it("explicitly covers all nine empty ledgers without claiming a target export", async () => {
    const { path } = fixture();
    const result = await readOnlyGlobalGuardSnapshot(path);
    expect(result.status).toBe("complete");
    expect(result.ledgers.map(ledger => ledger.table)).toEqual([...GLOBAL_GUARD_LEDGER_TABLES]);
    expect(result.ledgers.every(ledger => ledger.complete && ledger.rows === 0)).toBe(true);
    expect(result.sourceLedgerCoverageComplete).toBe(true);
    expect(result.exportAcknowledged).toBe(false);
    expect(result.targetRoundTripVerified).toBe(false);
    expect(result.purchaseDependenciesVerified).toBe(false);
    expect(result.productionMigrationReady).toBe(false);
  });

  it("reads more than the old slice limit in bounded, chained pages", async () => {
    const { database, path } = fixture();
    budgets(database, 1005);
    const pages: GuardLedgerPage[] = [];
    const result = await readOnlyGlobalGuardSnapshot(path, {
      pageSize: 128, pageSink: page => { pages.push(page); return page.fingerprint; },
    });
    expect(result.status).toBe("complete");
    expect(result.rowCount).toBe(1005);
    expect(result.pageCount).toBe(8);
    expect(result.exportAcknowledged).toBe(true);
    expect(pages.every(page => page.rows.length <= 128 && page.snapshotId === result.snapshotId)).toBe(true);
    expect(pages.map(page => page.previousFingerprint)).toEqual([null, ...pages.slice(0, -1).map(page => page.fingerprint)]);
    const keys = pages.flatMap(page => page.rows.map(row => JSON.stringify(row.key)));
    expect(new Set(keys).size).toBe(1005);
  });

  it("retains observed storage classes and all source digits", async () => {
    const { database, path } = fixture();
    database.prepare("INSERT INTO provider_request_gates VALUES(?,?,?,?,?)")
      .run("provider", "nul\u0000text\u{1f4be}", Buffer.from([0, 255, 1]), 9223372036854775807n, 0.125);
    const pages: GuardLedgerPage[] = [];
    await readOnlyGlobalGuardSnapshot(path, { pageSink: page => { pages.push(page); return page.fingerprint; } });
    const values = Object.fromEntries(pages[0]!.rows[0]!.values.map(cell => [cell.name, cell.value]));
    expect(values.marker).toEqual({ storage: "text", value: "nul\u0000text\u{1f4be}" });
    expect(values.payload).toEqual({ storage: "blob", value: "AP8B" });
    expect(values.big_value).toEqual({ storage: "integer", value: "9223372036854775807" });
    expect(values.real_value).toEqual({ storage: "real", value: "0.125" });
  });

  it("keeps later ledger reads on the original WAL snapshot", async () => {
    const { database, path } = fixture();
    budgets(database, 3);
    database.prepare("INSERT INTO provider_request_gates(provider,marker) VALUES(?,?)").run("provider", "before");
    const pages: GuardLedgerPage[] = [];
    let changed = false;
    const result = await readOnlyGlobalGuardSnapshot(path, {
      pageSize: 2,
      pageSink: page => {
        pages.push(page);
        if (!changed && page.table === "provider_budget_usage") {
          changed = true;
          database.exec("UPDATE provider_request_gates SET marker='after'; INSERT INTO provider_budget_usage(provider,usage_window) VALUES('provider','999999')");
        }
        return page.fingerprint;
      },
    });
    expect(result.status).toBe("complete");
    expect(result.rowCount).toBe(4);
    const gate = pages.find(page => page.table === "provider_request_gates")!;
    expect(gate.rows[0]!.values.find(cell => cell.name === "marker")!.value).toEqual({ storage: "text", value: "before" });
    expect(database.prepare("SELECT marker FROM provider_request_gates").get()!.marker).toBe("after");
  });

  it("preflights missing tables before acknowledging any pages", async () => {
    const { database, path } = fixture();
    budgets(database, 2);
    database.exec("DROP TABLE historical_backfill_credit_usage");
    let called = false;
    const result = await readOnlyGlobalGuardSnapshot(path, { pageSink: page => { called = true; return page.fingerprint; } });
    expect(result.status).toBe("blocked");
    expect(result.issues).toContainEqual({ code: "missing_guard_ledger", table: "historical_backfill_credit_usage" });
    expect(called).toBe(false);
    expect(result.sourceLedgerCoverageComplete).toBe(false);
  });

  it("does not invent a cursor for nullable legacy primary keys", async () => {
    const { database, path } = fixture();
    database.exec("INSERT INTO provider_request_gates(provider) VALUES(NULL)");
    const result = await readOnlyGlobalGuardSnapshot(path);
    expect(result.status).toBe("blocked");
    expect(result.issues).toContainEqual({ code: "invalid_guard_primary_key", table: "provider_request_gates" });
  });

  it("stops at the explicit row budget without reporting complete coverage", async () => {
    const { database, path } = fixture();
    budgets(database, 10);
    const result = await readOnlyGlobalGuardSnapshot(path, { pageSize: 2, maximumRows: 5 });
    expect(result.status).toBe("blocked");
    expect(result.rowCount).toBeLessThanOrEqual(5);
    expect(result.issues).toContainEqual({ code: "guard_row_budget_exhausted", table: "provider_budget_usage" });
    expect(result.sourceLedgerCoverageComplete).toBe(false);
    expect(result.exportAcknowledged).toBe(false);
  });

  it("does not deliver an oversized page to the sink", async () => {
    const { database, path } = fixture();
    database.prepare("INSERT INTO provider_request_gates(provider,marker) VALUES(?,?)").run("provider", "x".repeat(2000));
    let called = false;
    const result = await readOnlyGlobalGuardSnapshot(path, {
      maximumBytes: 512, pageSink: page => { called = true; return page.fingerprint; },
    });
    expect(result.status).toBe("blocked");
    expect(result.issues).toContainEqual({ code: "guard_byte_budget_exhausted", table: "provider_request_gates" });
    expect(called).toBe(false);
  });

  it("requires an acknowledgement of the exact page fingerprint", async () => {
    const { database, path } = fixture();
    budgets(database, 1);
    const result = await readOnlyGlobalGuardSnapshot(path, { pageSink: () => "wrong_page" });
    expect(result.status).toBe("blocked");
    expect(result.issues).toContainEqual({ code: "guard_page_acknowledgement_mismatch", table: "provider_budget_usage" });
    expect(result.exportAcknowledged).toBe(false);
  });

  it("redacts sink failures rather than leaking ledger contents", async () => {
    const { database, path } = fixture();
    budgets(database, 1);
    const result = await readOnlyGlobalGuardSnapshot(path, { pageSink: () => { throw new Error("private-payload-secret"); } });
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("private-payload-secret");
    expect(result.issues).toContainEqual({ code: "guard_page_sink_failed", table: "provider_budget_usage" });
  });

  it("bounds asynchronous sinks and aborts their signal", async () => {
    const { database, path } = fixture();
    budgets(database, 1);
    let signal: AbortSignal | undefined;
    const result = await readOnlyGlobalGuardSnapshot(path, {
      maximumDurationMs: 100,
      pageSink: async (page, currentSignal) => {
        signal = currentSignal;
        await new Promise(resolve => setTimeout(resolve, 200));
        return page.fingerprint;
      },
    });
    expect(result.status).toBe("blocked");
    expect(result.issues).toContainEqual({ code: "guard_time_budget_exhausted", table: "provider_budget_usage" });
    expect(signal!.aborted).toBe(true);
  });

  it("rejects unsafe limits without opening a writable database", async () => {
    const { path } = fixture();
    await expect(readOnlyGlobalGuardSnapshot(path, { pageSize: 0 })).rejects.toThrow("invalid_guard_snapshot_limits");
    await expect(readOnlyGlobalGuardSnapshot(path, { maximumRows: Number.MAX_SAFE_INTEGER })).rejects.toThrow("invalid_guard_snapshot_limits");
  });
});
