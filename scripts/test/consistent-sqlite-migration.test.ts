import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = resolve("scripts/consistent-sqlite-migration.py");
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "radar-consistent-migration-")); roots.push(root);
  const source = join(root, "source.sqlite"); const db = new DatabaseSync(source);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE parents(a TEXT, b TEXT, PRIMARY KEY(a,b));
    CREATE TABLE facts(id INTEGER PRIMARY KEY, a TEXT, b TEXT, value REAL, payload BLOB, note TEXT,
      FOREIGN KEY(a,b) REFERENCES parents(a,b));
    CREATE INDEX facts_partial ON facts(a COLLATE NOCASE DESC,b) WHERE value IS NOT NULL;
    CREATE VIEW fact_view AS SELECT id FROM facts;
    INSERT INTO parents VALUES('a','b');`);
  db.prepare("INSERT INTO facts VALUES(?,?,?,?,?,?)").run(9_007_199_254_740_993n, "a", "b", 0.1,
    Buffer.from([0, 255, 1]), "line\ntext");
  db.exec("CREATE TABLE empty_table(value TEXT); CREATE TABLE invalid_text(value TEXT); INSERT INTO invalid_text VALUES(CAST(x'ff' AS TEXT));");
  return { root, source, db, snapshot: join(root, "snapshot.sqlite"), bundle: join(root, "bundle") };
}
function command(args: string[], success = true) {
  const result = spawnSync("python3", [script, ...args], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  if (success) expect(result.status, result.stderr).toBe(0);
  else expect(result.status, result.stdout).not.toBe(0);
  return result;
}
function snapshot(f: ReturnType<typeof fixture>) {
  return JSON.parse(command(["snapshot", "--source", f.source, "--target", f.snapshot,
    "--operation-id", "fixture", "--deadline-seconds", "10", "--minimum-free-bytes", "0"]).stdout);
}
function exportBundle(f: ReturnType<typeof fixture>, hash: string, extra: string[] = [], success = true) {
  return command(["export", "--source", f.snapshot, "--target", f.bundle, "--operation-id", "fixture",
    "--source-sha256", hash, "--deadline-seconds", "10", "--minimum-free-bytes", "0",
    "--maximum-chunk-bytes", "4096", "--rows-per-chunk", "1", ...extra], success);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("consistent SQLite migration foundation", () => {
  it("backs up committed WAL without changing source files and uses a private exclusive target", () => {
    const f = fixture(); const before = [digest(f.source), digest(f.source + "-wal")];
    try {
      const receipt = snapshot(f);
      expect(receipt.quickCheck).toBe("ok"); expect(receipt.backupSha256).toBe(digest(f.snapshot));
      expect(statSync(f.snapshot).mode & 0o777).toBe(0o600);
      expect([digest(f.source), digest(f.source + "-wal")]).toEqual(before);
      const copy = new DatabaseSync(f.snapshot, { readOnly: true });
      expect(copy.prepare("SELECT count(*) AS n FROM facts").get()?.n).toBe(1); copy.close();
      command(["snapshot", "--source", f.source, "--target", f.snapshot, "--operation-id", "fixture",
        "--deadline-seconds", "10", "--minimum-free-bytes", "0"], false);
      expect(digest(f.snapshot)).toBe(receipt.backupSha256);
    } finally { f.db.close(); }
  });

  it("exports every table, exact compound/index schema, large integers and source storage types", () => {
    const f = fixture();
    try {
      const receipt = snapshot(f); exportBundle(f, receipt.backupSha256);
      const manifest = JSON.parse(readFileSync(join(f.bundle, "manifest.json"), "utf8"));
      expect(manifest.completed).toBe(true); expect(manifest.tables).toHaveLength(4);
      expect(manifest.tables.find((t: {name: string}) => t.name === "empty_table").rowCount).toBe(0);
      const facts = manifest.tables.find((t: {name: string}) => t.name === "facts");
      const chunk = JSON.parse(readFileSync(join(f.bundle, facts.chunks[0].file), "utf8"));
      expect(chunk.rows[0].values[0]).toEqual({ storage: "integer", value: "9007199254740993" });
      expect(chunk.rows[0].values[3]).toEqual({ storage: "real", value: "0x1.999999999999ap-4" });
      expect(chunk.rows[0].values[4]).toEqual({ storage: "blob", value: "AP8B" });
      expect(manifest.catalog.tables.find((t: {name: string}) => t.name === "facts").foreignKeys[0].columns).toHaveLength(2);
      expect(manifest.catalog.objects.some((o: {name: string}) => o.name === "fact_view")).toBe(true);
      const bad = manifest.tables.find((t: {name: string}) => t.name === "invalid_text");
      const raw = JSON.parse(readFileSync(join(f.bundle, bad.chunks[0].file), "utf8"));
      expect(raw.rows[0].values[0]).toEqual({ storage: "text", encoding: "base64", value: "/w==" });
    } finally { f.db.close(); }
  });

  it("restores data and schema into a new isolated file without activating business work", () => {
    const f = fixture(); const target = join(f.root, "restored.sqlite");
    try {
      const receipt = snapshot(f); exportBundle(f, receipt.backupSha256);
      const restored = JSON.parse(command(["restore", "--source", f.bundle, "--target", target,
        "--deadline-seconds", "10", "--minimum-free-bytes", "0"]).stdout);
      expect(restored.preservationVerified).toBe(true); expect(restored.businessActivation).toBe(false);
      expect(restored.gatewayDelivery).toBe(false); expect(restored.tablesVerified).toBe(4);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(target, { readOnly: true });
      const select = copy.prepare("SELECT id,hex(payload) AS payload,hex(CAST(note AS BLOB)) AS note FROM facts");
      select.setReadBigInts(true); expect(select.get()).toMatchObject({ id: 9_007_199_254_740_993n, payload: "00FF01" });
      expect(copy.prepare("SELECT hex(CAST(value AS BLOB)) AS h FROM invalid_text").get()?.h).toBe("FF"); copy.close();
    } finally { f.db.close(); }
  });

  it("resumes an already complete matching export without altering completed chunks", () => {
    const f = fixture();
    try {
      const receipt = snapshot(f); exportBundle(f, receipt.backupSha256);
      const before = digest(join(f.bundle, "manifest.json")); exportBundle(f, receipt.backupSha256, ["--resume"]);
      expect(digest(join(f.bundle, "manifest.json"))).toBe(before);
    } finally { f.db.close(); }
  });

  it("reconciles an interrupted manifest against already durable chunks", () => {
    const f = fixture();
    try {
      const receipt = snapshot(f); exportBundle(f, receipt.backupSha256);
      const path = join(f.bundle, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const table = manifest.tables.find((t: {name: string}) => t.name === "facts");
      const chunkBefore = digest(join(f.bundle, table.chunks[0].file));
      manifest.completed = false; table.completed = false; table.rowCount = 0;
      table.contentSha256 = createHash("sha256").update("").digest("hex");
      writeFileSync(path, JSON.stringify(manifest));
      exportBundle(f, receipt.backupSha256, ["--resume"]);
      expect(JSON.parse(readFileSync(path, "utf8")).completed).toBe(true);
      expect(digest(join(f.bundle, table.chunks[0].file))).toBe(chunkBefore);
    } finally { f.db.close(); }
  });

  it("preserves orphan history without firing triggers or calling it business eligibility", () => {
    const f = fixture();
    try {
      f.db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE insert_audit(id INTEGER); CREATE TRIGGER facts_insert AFTER INSERT ON facts
        BEGIN INSERT INTO insert_audit VALUES(new.id); END;
        UPDATE facts SET a='missing';`);
      const receipt = snapshot(f); exportBundle(f, receipt.backupSha256);
      const target = join(f.root, "orphan-restored.sqlite");
      const restored = JSON.parse(command(["restore", "--source", f.bundle, "--target", target,
        "--deadline-seconds", "10", "--minimum-free-bytes", "0"]).stdout);
      expect(restored.preservationVerified).toBe(true); expect(restored.foreignKeyViolationCountBounded).toBe(1);
      expect(restored.businessActivation).toBe(false);
      const copy = new DatabaseSync(target, { readOnly: true });
      expect(copy.prepare("SELECT count(*) AS n FROM insert_audit").get()?.n).toBe(0); copy.close();
    } finally { f.db.close(); }
  });

  it("refuses changed snapshot identity, tampered chunks, traversal and existing restore destinations", () => {
    const f = fixture();
    try {
      const receipt = snapshot(f); exportBundle(f, receipt.backupSha256);
      exportBundle(f, "0".repeat(64), ["--resume"], false);
      const path = join(f.bundle, "manifest.json"); const manifest = JSON.parse(readFileSync(path, "utf8"));
      const chunk = manifest.tables.find((t: {rowCount: number}) => t.rowCount > 0).chunks[0];
      writeFileSync(join(f.bundle, chunk.file), "{}");
      const target = join(f.root, "refused.sqlite");
      command(["restore", "--source", f.bundle, "--target", target, "--deadline-seconds", "10", "--minimum-free-bytes", "0"], false);
      expect(existsSync(target)).toBe(false);
      chunk.file = "../source.sqlite"; writeFileSync(path, JSON.stringify(manifest));
      command(["restore", "--source", f.bundle, "--target", target, "--deadline-seconds", "10", "--minimum-free-bytes", "0"], false);
      expect(existsSync(target)).toBe(false);
    } finally { f.db.close(); }
  });

  it("refuses exporting a live WAL source or creating a missing source", () => {
    const f = fixture();
    try {
      command(["export", "--source", f.source, "--target", f.bundle, "--operation-id", "fixture",
        "--source-sha256", digest(f.source), "--deadline-seconds", "10", "--minimum-free-bytes", "0",
        "--maximum-chunk-bytes", "4096", "--rows-per-chunk", "1"], false);
      expect(existsSync(f.bundle)).toBe(false);
      const missing = join(f.root, "missing.sqlite");
      command(["snapshot", "--source", missing, "--target", f.snapshot, "--operation-id", "fixture",
        "--deadline-seconds", "10", "--minimum-free-bytes", "0"], false);
      expect(existsSync(missing)).toBe(false); expect(existsSync(f.snapshot)).toBe(false);
    } finally { f.db.close(); }
  });
});
