import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sqliteAdmissionLease, sqliteWriterLaunchBinding, installSqliteAdmissionGuard, evaluateSqliteAdmission, guardSqliteDatabase, parseSqliteAdmissionPolicy, SqliteAdmissionRejected } from "./sqlite-writer-admission.js";

const sha = "a".repeat(64);
const source = { path: "/var/lib/address-radar/address-radar.db", device: "1", inode: "2", generation: "source-generation-1" };
const writer = { id: "scanner", kind: "services", service: "scanner", sourcePath: source.path, launchSha256: sha, probeLaunchSha256: "b".repeat(64) };
const policy = { version: 1 as const, deploymentId: "deployment-1", challengeId: "challenge-1", notBefore: 1000, notAfter: 10000, sources: [source], writers: [writer], unresolvedScopes: [] };
const state = { version: 1, deploymentId: "deployment-1", policySha256: sha, challengeId: "challenge-1", revision: "1", admission: "open", notBefore: 1000, notAfter: 10000 };
const request = { path: source.path, device: "1", inode: "2", writerId: "scanner", launchSha256: sha, generation: source.generation, probe: false };

test("registered generation is admitted only under open protected state", () => {
  parseSqliteAdmissionPolicy(policy);
  assert.doesNotThrow(() => evaluateSqliteAdmission(policy, state, request, sha, 2000));
});
test("closed generation produces actual typed rejection", () => {
  assert.throws(() => evaluateSqliteAdmission(policy, { ...state, admission: "closed" }, request, sha, 2000),
    (error: unknown) => error instanceof SqliteAdmissionRejected && error.reason === "generation-rejected");
});
test("unknown writer, launch, inode, deadline and scope never become generation proof", () => {
  for (const changed of [{ writerId: "unknown" }, { launchSha256: "c".repeat(64) }, { inode: "3" }]) {
    assert.throws(() => evaluateSqliteAdmission(policy, { ...state, admission: "closed" }, { ...request, ...changed }, sha, 2000),
      (error: unknown) => error instanceof SqliteAdmissionRejected && error.reason !== "generation-rejected");
  }
  assert.throws(() => evaluateSqliteAdmission(policy, state, request, sha, 10000));
  assert.throws(() => parseSqliteAdmissionPolicy({ ...policy, unresolvedScopes: ["deploy"] }));
});
test("probe must use independently registered launch bytes", () => {
  assert.throws(() => evaluateSqliteAdmission(policy, { ...state, admission: "closed" }, { ...request, probe: true }, sha, 2000));
  assert.throws(() => evaluateSqliteAdmission(policy, { ...state, admission: "closed" },
    { ...request, probe: true, launchSha256: writer.probeLaunchSha256 }, sha, 2000),
    (error: unknown) => error instanceof SqliteAdmissionRejected && error.reason === "generation-rejected");
});
test("already prepared statements cannot write after gate closes; rollback remains possible", () => {
  let closed = false;
  const check = () => { if (closed) throw new SqliteAdmissionRejected("generation-rejected"); };
  const database = guardSqliteDatabase(new DatabaseSync(":memory:"), check);
  database.exec("CREATE TABLE sample(value INTEGER)");
  const insert = database.prepare("INSERT INTO sample VALUES (?)");
  database.exec("BEGIN IMMEDIATE");
  insert.run(1);
  closed = true;
  assert.throws(() => insert.run(2), SqliteAdmissionRejected);
  assert.throws(() => database.exec("COMMIT"), SqliteAdmissionRejected);
  database.exec("ROLLBACK");
  closed = false;
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sample").get()!.count, 0);
  database.close();
});
test("attach and replacing authorizer cannot bypass guard", () => {
  const database = guardSqliteDatabase(new DatabaseSync(":memory:"), () => {});
  assert.throws(() => database.exec("ATTACH ':memory:' AS other"));
  assert.throws(() => database.setAuthorizer(null));
  database.close();
});
test("statement iterator checks admission after preparation", () => {
  let closed = false;
  const database = guardSqliteDatabase(new DatabaseSync(":memory:"), () => {
    if (closed) throw new SqliteAdmissionRejected("generation-rejected");
  });
  const iterator = database.prepare("SELECT 1 UNION ALL SELECT 2").iterate();
  assert.equal(iterator.next().done, false);
  closed = true;
  assert.throws(() => iterator.next(), SqliteAdmissionRejected);
  database.close();
});

test("unactivated and unmanaged installations preserve raw database behavior", () => {
  const raw = new DatabaseSync(":memory:");
  const database = installSqliteAdmissionGuard(raw, false, () => { throw new Error("must not run"); });
  assert.equal(database, raw);
  database.exec("ATTACH ':memory:' AS other");
  database.setAuthorizer(null);
  database.close();
});
test("actual executable entry and gate bytes each change launch binding", () => {
  const pins = { "/node": "a".repeat(64), "/entry": "b".repeat(64), "/gate": "c".repeat(64) };
  const measure = (values: Record<string, string>) => sqliteWriterLaunchBinding("/node", "/entry", "/gate",
    ["/node", "/entry"], path => values[path]!);
  const original = measure(pins);
  for (const path of Object.keys(pins)) assert.notEqual(measure({ ...pins, [path]: "d".repeat(64) }), original);
  assert.throws(() => measure({ ...pins, "/gate": "not-a-code-hash" }));
});

test("an installed lease cannot reset its original monotonic deadline", () => {
  let now = 100;
  const check = sqliteAdmissionLease(() => {}, 10, () => now);
  check();
  now = 109;
  check();
  now = 110;
  assert.throws(check, SqliteAdmissionRejected);
});
test("checks which finish after deadline are refused", () => {
  let now = 1;
  const check = sqliteAdmissionLease(() => { now = 20; }, 10, () => now);
  assert.throws(check, SqliteAdmissionRejected);
});

test("INSERT and UPDATE RETURNING prepared before fence cannot execute through get or all", () => {
  let closed = false;
  const db = guardSqliteDatabase(new DatabaseSync(":memory:"), () => {
    if (closed) throw new SqliteAdmissionRejected("generation-rejected");
  });
  db.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO records VALUES(1, 10)");
  const insert = db.prepare("INSERT INTO records VALUES(2, 20) RETURNING id");
  const update = db.prepare("UPDATE records SET value=99 WHERE id=1 RETURNING value");
  assert.equal(insert.columns().length, 1);
  assert.equal(update.columns().length, 1);
  closed = true;
  assert.throws(() => insert.get(), SqliteAdmissionRejected);
  assert.throws(() => update.all(), SqliteAdmissionRejected);
  closed = false;
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records").get()!.count, 1);
  assert.equal(db.prepare("SELECT value FROM records WHERE id=1").get()!.value, 10);
  db.close();
});
test("mutating PRAGMA and direct exec cannot cross a closed boundary", () => {
  let closed = false;
  const db = guardSqliteDatabase(new DatabaseSync(":memory:"), () => {
    if (closed) throw new SqliteAdmissionRejected("generation-rejected");
  });
  db.exec("CREATE TABLE records(value INTEGER)");
  const pragma = db.prepare("PRAGMA user_version = 99");
  closed = true;
  assert.throws(() => pragma.run(), SqliteAdmissionRejected);
  assert.throws(() => db.exec("PRAGMA journal_mode=WAL"), SqliteAdmissionRejected);
  assert.throws(() => db.exec("INSERT INTO records VALUES(1)"), SqliteAdmissionRejected);
  closed = false;
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 0);
  db.close();
});
test("only exact ROLLBACK and close are allowed after fencing", () => {
  let closed = false;
  const db = guardSqliteDatabase(new DatabaseSync(":memory:"), () => {
    if (closed) throw new SqliteAdmissionRejected("generation-rejected");
  });
  db.exec("CREATE TABLE records(value INTEGER); BEGIN IMMEDIATE; INSERT INTO records VALUES(1)");
  closed = true;
  assert.throws(() => db.exec("ROLLBACK; INSERT INTO records VALUES(2)"), SqliteAdmissionRejected);
  db.exec(" ROLLBACK; ");
  db[Symbol.dispose]();
});
