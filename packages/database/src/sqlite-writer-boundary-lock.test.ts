import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { assertSourcePinIdentity, assertProductionSourceInPolicy, serializeSqliteBoundary } from './sqlite-writer-boundary-lock.js';

test('fixed production source cannot be omitted by policy', () => {
  const source = { path: '/production/source.sqlite', device: '1', inode: '2' };
  assert.throws(() => assertProductionSourceInPolicy(source, { sources: [] }));
  assert.throws(() => assertProductionSourceInPolicy(source, { sources: [{ ...source, inode: '3' }] }));
  assertProductionSourceInPolicy(source, { sources: [source] });
});

test('execution and commit remain inside the shared lease', () => {
  let held = false;
  const events: string[] = [];
  const database = { exec(sql: string) { assert.equal(held, true); events.push(sql); } };
  const guarded = serializeSqliteBoundary(database, () => {
    assert.equal(held, false); held = true; events.push('lock');
    return { active: true, release() { held = false; events.push('unlock'); } };
  });
  guarded.exec('COMMIT');
  assert.deepEqual(events, ['lock', 'COMMIT', 'unlock']);
});

test('statement get and all finalize RETURNING inside the lease', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t(value INTEGER)');
  let held = false;
  const guarded = serializeSqliteBoundary(database, () => {
    held = true; return { active: true, release() { held = false; } };
  });
  assert.equal(guarded.prepare('INSERT INTO t VALUES (1) RETURNING value').get()!.value, 1);
  assert.equal(held, false);
  assert.equal(guarded.prepare('UPDATE t SET value=2 RETURNING value').all().length, 1);
  database.exec('BEGIN IMMEDIATE; ROLLBACK');
  guarded.close();
});

test('activated streaming cursor refuses before executing RETURNING', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t(value INTEGER)');
  const guarded = serializeSqliteBoundary(database, () => ({ active: true, release() {} }));
  assert.throws(() => guarded.prepare('INSERT INTO t VALUES (1) RETURNING value').iterate());
  assert.equal(database.prepare('SELECT count(*) AS n FROM t').get()!.n, 0);
  guarded.close();
});

test('unactivated fixture preserves iterator behavior', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t(value INTEGER)');
  const guarded = serializeSqliteBoundary(database, () => ({ active: false, release() {} }));
  assert.equal([...guarded.prepare('INSERT INTO t VALUES (1) RETURNING value').iterate()].length, 1);
  guarded.close();
});

test('lease closes on execution failure and close remains callable', () => {
  let held = false;
  const database = new DatabaseSync(':memory:');
  const guarded = serializeSqliteBoundary(database, () => {
    held = true; return { active: true, release() { held = false; } };
  });
  assert.throws(() => guarded.exec('bad SQL'));
  assert.equal(held, false);
  guarded.close();
});

test('production source symlink or canonical alias is never admitted', () => {
  const pin = { path: '/production/source.sqlite', device: '1', inode: '2' };
  const value = { isFile: () => true, nlink: 1n, dev: 1n, ino: 2n } as any;
  assertSourcePinIdentity(pin, value, pin.path);
  assert.throws(() => assertSourcePinIdentity(pin, value, '/other/source.sqlite'));
  assert.throws(() => assertSourcePinIdentity(pin, { ...value, isFile: () => false }, pin.path));
  assert.throws(() => assertSourcePinIdentity(pin, { ...value, nlink: 2n }, pin.path));
});


test('cleanup bypasses failed lease without admitting arbitrary SQL', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t(value INTEGER); BEGIN; INSERT INTO t VALUES (1)');
  let attempts = 0;
  const guarded = serializeSqliteBoundary(database, () => {
    attempts++; throw new Error('lock unavailable');
  });
  for (const sql of ['ROLLBACK; INSERT INTO t VALUES (2)', 'ROLLBACK TO savepoint',
    'ROLLBACK; -- comment', 'COMMIT', 'SELECT 1']) {
    assert.throws(() => guarded.exec(sql), /lock unavailable/);
    assert.throws(() => guarded.prepare(sql), /lock unavailable/);
  }
  assert.equal(attempts, 10);
  guarded.exec(' \tROLLBACK;\n');
  assert.equal(database.prepare('SELECT count(*) AS n FROM t').get()!.n, 0);
  database.exec('BEGIN');
  assert.throws(() => guarded.prepare('ROLLBACK'), /lock unavailable/);
  guarded.exec('ROLLBACK');
  assert.equal(attempts, 11);
  guarded.close();
  assert.equal(attempts, 11);
});

test('dispose bypasses failed lease', () => {
  let disposed = false;
  const guarded = serializeSqliteBoundary({ [Symbol.dispose]() { disposed = true; } },
    () => { throw new Error('lock unavailable'); });
  guarded[Symbol.dispose]();
  assert.equal(disposed, true);
});

test('closed admission does not claim a drained transaction', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t(value INTEGER)');
  let closed = false;
  const guarded = serializeSqliteBoundary(database, () => {
    if (closed) throw new Error('admission closed');
    return { active: true, release() {} };
  });
  guarded.exec('BEGIN');
  guarded.exec('INSERT INTO t VALUES (1)');
  closed = true;
  assert.throws(() => guarded.exec('COMMIT'), /admission closed/);
  assert.equal(database.isTransaction, true);
  guarded.exec('ROLLBACK');
  assert.equal(database.isTransaction, false);
  assert.equal(database.prepare('SELECT count(*) AS n FROM t').get()!.n, 0);
  guarded.close();
});
