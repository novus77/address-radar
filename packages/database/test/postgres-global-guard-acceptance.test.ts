import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  GLOBAL_GUARD_LEDGER_TABLES, readOnlyGlobalGuardSnapshot,
  type GuardLedgerPage, type GuardLedgerRow,
} from "../src/global-guard-snapshot-preflight.js";
import { decodeGuardLedgerPage, encodeGuardLedgerPage, verifyGuardLedgerRoundTrip } from "../src/postgres-global-guard-acceptance.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function pageFixture(): GuardLedgerPage {
  const key: GuardLedgerRow["key"] = [{ name: "provider", value: { storage: "text", value: "provider" } }];
  const values: GuardLedgerRow["values"] = [
    ...key,
    { name: "marker", value: { storage: "text", value: "nul\u0000surrogate\ud800" } },
    { name: "big", value: { storage: "integer", value: "9223372036854775807" } },
    { name: "real", value: { storage: "real", value: "5e-324" } },
    { name: "zero", value: { storage: "real", value: "-0" } },
    { name: "blob", value: { storage: "blob", value: "AP8B" } },
    { name: "missing", value: { storage: "null" } },
  ];
  const table = "provider_request_gates";
  const row = { key, values, fingerprint: hash({ table, key, values }) };
  const identity = {
    snapshotId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", sequence: 0,
    table, pageNumber: 0, previousFingerprint: null, rows: [row.fingerprint],
  };
  return { ...identity, rows: [row], fingerprint: hash(identity) };
}

function revisePage(page: GuardLedgerPage, row: GuardLedgerRow): GuardLedgerPage {
  const revised = { ...row, fingerprint: hash({ table: page.table, key: row.key, values: row.values }) };
  return { ...page, rows: [revised], fingerprint: hash({
    snapshotId: page.snapshotId, sequence: page.sequence, table: page.table,
    pageNumber: page.pageNumber, previousFingerprint: page.previousFingerprint, rows: [revised.fingerprint],
  }) };
}

async function sourceFixture(empty = false) {
  const root = mkdtempSync(join(tmpdir(), "radar-guard-roundtrip-"));
  roots.push(root);
  const path = join(root, "source.db");
  const db = new DatabaseSync(path);
  const keys: Record<string, string[]> = {
    broadcast_records: ["broadcast_id"], evidence_consumption: ["event_id"], economic_evidence_consumption: ["dedupe_key"],
    outcome_observations: ["broadcast_id", "horizon"], signal_outbox: ["outbox_id"], signal_outbox_migration_review: ["review_id"],
    provider_budget_usage: ["provider", "usage_window"], provider_request_gates: ["provider"], historical_backfill_credit_usage: ["usage_day"],
  };
  try {
    for (const table of GLOBAL_GUARD_LEDGER_TABLES) {
      db.exec(`CREATE TABLE ${table} (${keys[table]!.map(key => `${key} TEXT`).join(",")}, marker TEXT, PRIMARY KEY (${keys[table]!.join(",")}))`);
    }
    if (!empty) {
      const insert = db.prepare("INSERT INTO provider_budget_usage VALUES(?,?,?)");
      for (let index = 0; index < 3; index++) insert.run("provider", String(index), "original");
      db.exec("INSERT INTO provider_request_gates VALUES('provider','original')");
    }
  } finally { db.close(); }
  const pages: GuardLedgerPage[] = [];
  const source = await readOnlyGlobalGuardSnapshot(path, { pageSize: 2, pageSink: page => { pages.push(page); return page.fingerprint; } });
  return { source, pages };
}

describe("PostgreSQL global guard payload acceptance", () => {
  it("round trips original storage classes without JSONB or numeric coercion", () => {
    const page = pageFixture();
    expect(decodeGuardLedgerPage(encodeGuardLedgerPage(page))).toEqual(page);
  });
  it("rejects changed payload contents", () => {
    const page = pageFixture();
    const payload = Buffer.from(JSON.stringify(page).replace("9223372036854775807", "9223372036854775806"));
    expect(() => decodeGuardLedgerPage(payload)).toThrow("guard_row_fingerprint_mismatch");
  });
  it("rejects a changed page fingerprint", () => {
    expect(() => encodeGuardLedgerPage({ ...pageFixture(), fingerprint: "0".repeat(64) })).toThrow("guard_page_fingerprint_mismatch");
  });
  it("rejects integers outside the original SQLite range", () => {
    const page = pageFixture();
    const row = page.rows[0]!;
    const values = row.values.map(cell => cell.name === "big" ? { ...cell, value: { storage: "integer" as const, value: "9223372036854775808" } } : cell);
    expect(() => encodeGuardLedgerPage(revisePage(page, { ...row, values }))).toThrow("invalid_guard_storage_cell");
  });
  it("rejects noncanonical blobs", () => {
    const page = pageFixture();
    const row = page.rows[0]!;
    const values = row.values.map(cell => cell.name === "blob" ? { ...cell, value: { storage: "blob" as const, value: "invalid base64" } } : cell);
    expect(() => encodeGuardLedgerPage(revisePage(page, { ...row, values }))).toThrow("invalid_guard_storage_cell");
  });
  it("rejects nullable primary keys even when rehashed", () => {
    const page = pageFixture();
    const row = page.rows[0]!;
    const missing = { name: "provider", value: { storage: "null" as const } };
    expect(() => encodeGuardLedgerPage(revisePage(page, { ...row, key: [missing], values: [missing, ...row.values.slice(1)] })))
      .toThrow("invalid_guard_row_key");
  });
  it("rejects invalid stored JSON", () => {
    expect(() => decodeGuardLedgerPage(Buffer.from("not-json"))).toThrow("invalid_guard_page_payload");
  });
  it("checks all table counts and chained pages against the source manifest", async () => {
    const { source, pages } = await sourceFixture();
    const restored = pages.map(page => decodeGuardLedgerPage(encodeGuardLedgerPage(page)));
    const result = verifyGuardLedgerRoundTrip(source, restored);
    expect(result.sourceRows).toBe(4);
    expect(result.sourcePages).toBe(3);
    expect(result.sourceFingerprint).toBe(source.sourceFingerprint);
    expect(result.purchaseDependenciesVerified).toBe(false);
    expect(result.productionMigrationReady).toBe(false);
  });
  it("rejects reordered pages", async () => {
    const { source, pages } = await sourceFixture();
    expect(() => verifyGuardLedgerRoundTrip(source, [...pages].reverse())).toThrow("guard_page_sequence_mismatch");
  });
  it("rejects omitted pages", async () => {
    const { source, pages } = await sourceFixture();
    expect(() => verifyGuardLedgerRoundTrip(source, pages.slice(1))).toThrow("guard_page_count_mismatch");
  });
  it("rejects a modified per-table row count", async () => {
    const { source, pages } = await sourceFixture();
    const ledgers = source.ledgers.map(ledger => ledger.table === "provider_budget_usage" ? { ...ledger, rows: ledger.rows + 1 } : ledger);
    expect(() => verifyGuardLedgerRoundTrip({ ...source, ledgers }, pages)).toThrow("guard_ledger_manifest_mismatch");
  });
  it("rejects pages from a different snapshot", async () => {
    const { source, pages } = await sourceFixture();
    const first = pages[0]!;
    const changed = { ...first, snapshotId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" };
    changed.fingerprint = hash({ snapshotId: changed.snapshotId, sequence: changed.sequence, table: changed.table,
      pageNumber: changed.pageNumber, previousFingerprint: changed.previousFingerprint, rows: changed.rows.map(row => row.fingerprint) });
    expect(() => verifyGuardLedgerRoundTrip(source, [changed, ...pages.slice(1)])).toThrow("guard_snapshot_identity_mismatch");
  });
  it("does not accept inventory-only or incomplete source reports", async () => {
    const { source, pages } = await sourceFixture();
    expect(() => verifyGuardLedgerRoundTrip({ ...source, exportAcknowledged: false }, pages)).toThrow("guard_source_not_fully_exported");
    expect(() => verifyGuardLedgerRoundTrip({ ...source, sourceLedgerCoverageComplete: false }, pages)).toThrow("guard_source_not_fully_exported");
  });
  it("retains explicit coverage of all nine empty tables", async () => {
    const { source, pages } = await sourceFixture(true);
    expect(verifyGuardLedgerRoundTrip(source, pages).sourceRows).toBe(0);
    expect(source.ledgers).toHaveLength(9);
  });
});
