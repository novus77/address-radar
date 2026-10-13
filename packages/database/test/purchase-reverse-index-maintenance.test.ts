import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/apply-reviewed-purchase-reverse-index.py");
const indexName = "idx_canonical_trader_event_observations_observation_id";

function fixture(run: (path: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "radar-index-maintenance-"));
  const path = join(directory, "source.sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE canonical_trader_events(canonical_event_id TEXT PRIMARY KEY);
      CREATE TABLE raw_trader_observations(observation_id TEXT PRIMARY KEY);
      CREATE TABLE canonical_trader_event_observations(
        canonical_event_id TEXT NOT NULL REFERENCES canonical_trader_events(canonical_event_id),
        observation_id TEXT NOT NULL REFERENCES raw_trader_observations(observation_id),
        PRIMARY KEY(canonical_event_id,observation_id));
      INSERT INTO canonical_trader_events VALUES('canonical');
      INSERT INTO raw_trader_observations VALUES('raw');
      INSERT INTO canonical_trader_event_observations VALUES('canonical','raw');
    `);
  } finally { database.close(); }
  try { run(path, directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function python(path: string, body: string, extra: readonly string[] = []): Record<string, unknown> {
  const result = spawnSync("python3", ["-c", `
import importlib.util, sqlite3, sys, json
spec=importlib.util.spec_from_file_location("maintenance",sys.argv[1])
maintenance=importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)
path=sys.argv[2]
${body}
`, script, path, ...extra], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("approved reverse-index maintenance isolation", () => {
  it("creates an independently checked private backup without changing the source", () => fixture((path, directory) => {
    const before = readFileSync(path);
    const backup = join(directory, "backup.sqlite");
    const report = python(path, `
report=maintenance.prepare_backup(path,sys.argv[3])
copy=sqlite3.connect("file:"+sys.argv[3]+"?mode=ro",uri=True)
count=copy.execute("SELECT count(*) FROM canonical_trader_event_observations").fetchone()[0]
copy.close()
print(json.dumps({**report,"copiedRows":count}))`, [backup]);
    expect(report.quickCheck).toBe("ok");
    expect(report.copiedRows).toBe(1);
    expect(report.backupSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
  }));

  it("records ownership before committing a nonunique index without changing link data", () => fixture(path => {
    const report = python(path, `
read=sqlite3.connect("file:"+path+"?mode=ro",uri=True)
expected=maintenance.metadata(read)
read.close()
records=[]
statements=[]
original_connect=maintenance.connect
def observed_connect(*args,**kwargs):
    connection=original_connect(*args,**kwargs)
    connection.set_trace_callback(statements.append)
    return connection
maintenance.connect=observed_connect
result=maintenance.apply_index(path,expected,records.append)
full_scans=[sql for sql in statements if "SELECT canonical_event_id,observation_id" in sql or "SELECT COUNT(*)" in sql.upper()]
print(json.dumps({**result,"auditRecords":len(records),"noFullContentScan":not full_scans}))`);
    expect(report.indexCreated).toBe(true);
    expect(report.linkRows).toBeNull();
    expect(report.linkContentFingerprint).toBeNull();
    expect(report.fullContentFingerprintComputed).toBe(false);
    expect(report.linkContentUnchanged).toBe(true);
    expect(report.rowProtectionMethod).toBe("sqlite_authorizer_and_connection_change_counter");
    expect(report.businessRowChanges).toBe(0);
    expect(report.businessRowMutationAttemptsDenied).toBe(0);
    expect(report.noFullContentScan).toBe(true);
    expect(report.lookupUsesSearch).toBe(true);
    expect(report.auditRecords).toBe(1);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(indexName)?.name).toBe(indexName);
      expect(database.prepare("PRAGMA index_list(canonical_trader_event_observations)").all().find(row => row.name === indexName)?.unique).toBe(0);
    } finally { database.close(); }
  }));

  it("rolls back an already-created index if the precommit ownership journal fails", () => fixture(path => {
    const report = python(path, `
read=sqlite3.connect("file:"+path+"?mode=ro",uri=True)
expected=maintenance.metadata(read)
read.close()
def reject_record(record):
    raise RuntimeError("journal_unavailable")
try:
    maintenance.apply_index(path,expected,reject_record)
    raise AssertionError("expected journal failure")
except RuntimeError as error:
    assert str(error)=="journal_unavailable"
check=sqlite3.connect("file:"+path+"?mode=ro",uri=True)
exists=check.execute("SELECT 1 FROM sqlite_schema WHERE name=?",("${indexName}",)).fetchone()
rows=check.execute("SELECT count(*) FROM canonical_trader_event_observations").fetchone()[0]
check.close()
print(json.dumps({"indexAbsent":exists is None,"linkRows":rows}))`);
    expect(report).toEqual({ indexAbsent: true, linkRows: 1 });
  }));

  it("rejects drift or existing index ownership instead of changing pre-existing objects", () => fixture(path => {
    const report = python(path, `
read=sqlite3.connect(path)
expected=maintenance.metadata(read)
read.execute("CREATE INDEX unreviewed_index ON canonical_trader_event_observations(canonical_event_id)")
read.commit()
read.close()
try:
    maintenance.apply_index(path,expected,lambda record:None)
    raise AssertionError("expected metadata drift")
except RuntimeError as error:
    assert str(error)=="source_metadata_changed"
print(json.dumps({"driftRejected":True}))`);
    expect(report.driftRejected).toBe(true);
  }));

  it("leaves source data and index state unchanged when a writer already holds the lock", () => fixture(path => {
    const report = python(path, `
read=sqlite3.connect(path)
expected=maintenance.metadata(read)
read.close()
writer=sqlite3.connect(path)
writer.execute("BEGIN IMMEDIATE")
try:
    maintenance.apply_index(path,expected,lambda record:None,lock_wait_ms=1)
    raise AssertionError("expected lock contention")
except sqlite3.OperationalError:
    pass
finally:
    writer.rollback()
    writer.close()
check=sqlite3.connect(path)
exists=check.execute("SELECT 1 FROM sqlite_schema WHERE name=?",("${indexName}",)).fetchone()
check.close()
print(json.dumps({"indexAbsent":exists is None}))`);
    expect(report.indexAbsent).toBe(true);
  }));

  it("preserves an existing backup and refuses to start with insufficient disk headroom", () => fixture((path, directory) => {
    const backup = join(directory, "existing.sqlite");
    const report = python(path, `
first=maintenance.prepare_backup(path,sys.argv[3])
try:
    maintenance.prepare_backup(path,sys.argv[3])
    raise AssertionError("expected existing backup refusal")
except FileExistsError:
    pass
try:
    maintenance.prepare_backup(path,sys.argv[4],minimum_free_bytes=2**62)
    raise AssertionError("expected disk refusal")
except RuntimeError as error:
    assert str(error)=="backup_disk_headroom_insufficient"
print(json.dumps({"preserved":True}))`, [backup, join(directory, "refused.sqlite")]);
    expect(report.preserved).toBe(true);
  }));

  it("denies business DML, unrelated schema writes, writable schema, and attached databases", () => fixture(path => {
    const report = python(path, `
guard=getattr(maintenance,"index_write_authorizer",None)
assert callable(guard),"approved_index_authorizer_missing"
connection=sqlite3.connect(path,isolation_level=None)
connection.set_authorizer(guard)
connection.execute(maintenance.CREATE_SQL)
statements=[
    "INSERT OR REPLACE INTO canonical_trader_event_observations VALUES('canonical','raw')",
    "UPDATE canonical_trader_event_observations SET observation_id='changed'",
    "DELETE FROM canonical_trader_event_observations",
    "INSERT INTO raw_trader_observations VALUES('extra')",
    "CREATE INDEX unreviewed_index ON canonical_trader_event_observations(observation_id)",
    "DROP INDEX ${indexName}",
    "DROP TABLE raw_trader_observations",
    "PRAGMA writable_schema=ON",
    "ATTACH DATABASE ':memory:' AS extra"
]
for sql in statements:
    try:
        connection.execute(sql)
        raise AssertionError("unapproved statement succeeded")
    except sqlite3.DatabaseError as error:
        assert str(error)=="not authorized"
        code=getattr(error,"sqlite_errorcode",None)
        assert code is None or code==sqlite3.SQLITE_AUTH
changes=connection.total_changes
connection.close()
connection=sqlite3.connect("file:"+path+"?mode=ro",uri=True)
count=connection.execute("SELECT count(*) FROM canonical_trader_event_observations").fetchone()[0]
connection.close()
print(json.dumps({"deniedStatements":len(statements),"businessRowChanges":changes,"linkRows":count}))`);
    expect(report).toEqual({ deniedStatements: 9, businessRowChanges: 0, linkRows: 1 });
  }));

  it("keeps the DML guard active through precommit audit and rolls back a rejected mutation", () => fixture(path => {
    const report = python(path, `
reader=sqlite3.connect(path)
expected=maintenance.metadata(reader)
reader.close()
writers=[]
original_connect=maintenance.connect
def observed_connect(*args,**kwargs):
    connection=original_connect(*args,**kwargs)
    writers.append(connection)
    return connection
maintenance.connect=observed_connect
def mutate_during_audit(record):
    writers[-1].execute("DELETE FROM canonical_trader_event_observations")
try:
    maintenance.apply_index(path,expected,mutate_during_audit)
    raise AssertionError("expected denied audit mutation")
except sqlite3.DatabaseError as error:
    assert str(error)=="not authorized"
    code=getattr(error,"sqlite_errorcode",None)
    assert code is None or code==sqlite3.SQLITE_AUTH
check=sqlite3.connect(path)
exists=check.execute("SELECT 1 FROM sqlite_schema WHERE name=?",("${indexName}",)).fetchone()
count=check.execute("SELECT count(*) FROM canonical_trader_event_observations").fetchone()[0]
check.close()
print(json.dumps({"indexAbsent":exists is None,"linkRows":count}))`);
    expect(report).toEqual({ indexAbsent: true, linkRows: 1 });
  }));

  it("retains the transaction deadline even when the ownership audit takes too long", () => fixture(path => {
    const report = python(path, `
import time
reader=sqlite3.connect(path)
expected=maintenance.metadata(reader)
reader.close()
def slow_audit(record):
    time.sleep(0.1)
try:
    maintenance.apply_index(path,expected,slow_audit,transaction_seconds=0.05)
    raise AssertionError("expected transaction deadline")
except RuntimeError as error:
    assert str(error)=="index_transaction_deadline_exceeded"
check=sqlite3.connect(path)
exists=check.execute("SELECT 1 FROM sqlite_schema WHERE name=?",("${indexName}",)).fetchone()
check.close()
print(json.dumps({"indexAbsent":exists is None}))`);
    expect(report.indexAbsent).toBe(true);
  }));
});
