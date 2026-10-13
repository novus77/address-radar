import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallation, validateCandidate, verifyLedger, protectedPinMaximumBytes, measureBoundary, main, digest,
  guardedNativeQuery, initializeOwnedPool } from '../install-production-postgres-business-schema.mjs';

const hash = 'a'.repeat(64);
const schemaPlan = { version: 1, fingerprint: hash, migrations: [{ version: 1, fingerprint: hash, previousFingerprint: 'b'.repeat(64), modules: ['capture-inbox'] }] };
const pin = path => ({ path, sha256: hash, uid: 0, gid: 0, mode: 0o500, device: '1', inode: '2' });
function candidate() { return { version: 1, operationId: 'schema-operation', approvalRef: 'operator-approved-new-schema',
  authenticationPlanSha256: hash, authenticationPlan: pin('/protected/auth-plan.json'), authenticationScript: pin('/protected/auth.py'),
  authenticationStateDirectory: '/protected/auth-state', python: pin('/usr/bin/python3'), credential: { ...pin('/protected/auth-state/secrets.json'), mode: 0o600 },
  target: { database: 'address_radar', schema: 'radar_business', username: 'radar_migrator', generation: 'production-v1', service: 'migration' },
  targetPins: { systemIdentifier: '7693392208475083526', databaseOid: '16384', roleOid: '16385' },
  schemaPlan, release: { root: '/protected/release', inventorySha256: hash, maximumEntries: 4096, maximumBytes: 134217728 },
  invocationTimeoutMs: 180000, statementTimeoutMs: 60000, lockTimeoutMs: 5000,
  privateDirectory: '/protected/schema-state' }; }
function ledger(c = candidate()) { return { owner: c.targetPins.roleOid, header: [{ singleton: true, ledger_format: 1,
  database_name: c.target.database, schema_name: c.target.schema, generation_id: c.target.generation,
  installed_by: c.target.username, approval_ref: c.approvalRef }], history: schemaPlan.migrations.map(m => ({ version: m.version,
  fingerprint: m.fingerprint, previous_fingerprint: m.previousFingerprint, modules_json: JSON.stringify(m.modules),
  installed_by: c.target.username, approval_ref: c.approvalRef })) }; }
function fixture() { const c = validateCandidate(candidate()); let journal = null, complete = false, installs = 0, guardCalls = 0;
  const boundary = { systemIdentifier: c.targetPins.systemIdentifier, databaseOid: c.targetPins.databaseOid, roleOid: c.targetPins.roleOid, postmasterStart: '2026-10-06T00:00:00.000Z' };
  const ports = { guard: async () => { guardCalls++; return boundary; }, load: async () => journal,
    save: async j => { journal = structuredClone(j); }, namespaceAbsent: async () => !complete,
    install: async () => { installs++; complete = true; return { status: 'installed' }; },
    readLedger: async () => complete ? ledger(c) : null };
  return { c, ports, journal: () => journal, installs: () => installs, guards: () => guardCalls,
    complete: value => { complete = value; } }; }
test('new namespace: durable intent before installer, native ledger ACK, no activation claim', async () => {
  const f = fixture(); f.ports.install = async () => { assert.equal(f.journal().pending, 'schema-install'); f.complete(true); };
  const result = await runInstallation(f.c, f.ports, 'apply');
  assert.equal(result.schemaInstalled, true); assert.equal(result.productionMigrationReady, false);
  assert.equal(result.businessActivation, false); assert.equal(f.journal().pending, null); assert.ok(f.guards() >= 3);
});
test('unknown COMMIT: exact native ledger reconciles without resubmission', async () => {
  const f = fixture(); let calls = 0;
  f.ports.install = async () => { calls++; f.complete(true); throw new Error('native-commit-uncertain'); };
  assert.equal((await runInstallation(f.c, f.ports, 'apply')).status, 'schema_reconciled');
  await runInstallation(f.c, f.ports, 'apply'); assert.equal(calls, 1);
});
test('uncommitted/partial ledger stays pending; explicit reconcile never calls installer', async () => {
  const f = fixture(); let calls = 0; f.ports.install = async () => { calls++; throw new Error('connection-lost'); };
  await assert.rejects(runInstallation(f.c, f.ports, 'apply'), /schema_pending_preserved/);
  await assert.rejects(runInstallation(f.c, f.ports, 'apply'), /explicit_reconcile_required/);
  await assert.rejects(runInstallation(f.c, f.ports, 'reconcile'), /schema_pending_preserved/);
  assert.equal(calls, 1); assert.equal(f.journal().pending, 'schema-install');
  f.complete(true); assert.equal((await runInstallation(f.c, f.ports, 'reconcile')).status, 'schema_reconciled');
});
test('foreign namespace never adopted and no intent written', async () => {
  const f = fixture(); f.complete(true);
  await assert.rejects(runInstallation(f.c, f.ports, 'apply'), /existing_namespace_refused/);
  assert.equal(f.journal(), null); assert.equal(f.installs(), 0);
});
test('resource refusal precedes journal and DDL', async () => {
  const f = fixture(); f.ports.guard = async () => { throw new Error('resource_guard'); };
  await assert.rejects(runInstallation(f.c, f.ports, 'apply'), /resource_guard/);
  assert.equal(f.journal(), null); assert.equal(f.installs(), 0);
});
test('post-boundary epoch change preserves intent and cannot ACK', async () => {
  const f = fixture(); let n = 0, guard = f.ports.guard;
  f.ports.guard = async () => ({ ...await guard(), postmasterStart: ++n > 2 ? 'changed' : '2026-10-06T00:00:00.000Z' });
  await assert.rejects(runInstallation(f.c, f.ports, 'apply'), /schema_pending_preserved/);
  assert.equal(f.journal().pending, 'schema-install');
});
test('ledger rejects extras, wrong module bytes, owner, approval or generation', () => {
  const c = validateCandidate(candidate()); assert.doesNotThrow(() => verifyLedger(c, ledger(c)));
  for (const change of [l => l.history.push(l.history[0]), l => l.history[0].modules_json = '[ ]',
    l => l.owner = '99', l => l.header[0].approval_ref = 'foreign', l => l.header[0].generation_id = 'foreign']) {
    const l = ledger(c); change(l); assert.throws(() => verifyLedger(c, l), /ledger/);
  }
});
test('candidate has explicit bounded deadlines, migration-only identity and no SQL slots', () => {
  for (const change of [c => c.invocationTimeoutMs = 900000, c => c.target.service = 'scanner',
    c => c.sql = 'DROP SCHEMA public', c => c.targetPins.roleOid = '0', c => delete c.approvalRef,
    c => c.statementTimeoutMs = 180001, c => c.credential.mode = 0o644]) {
    const c = candidate(); change(c); assert.throws(() => validateCandidate(c));
  }
});
test('pinned native executable has bounded ELF budget independent of JSON/script budgets', () => {
  assert.equal(protectedPinMaximumBytes('python'), 64 * 1024 * 1024);
  assert.equal(protectedPinMaximumBytes('credential'), 64 * 1024);
  assert.equal(protectedPinMaximumBytes('authenticationPlan'), 1024 * 1024);
  assert.equal(protectedPinMaximumBytes('authenticationScript'), 1024 * 1024);
  assert.throws(() => protectedPinMaximumBytes('arbitrary'), /unknown_pin_slot/);
});
test('native boundary binds root measured system identifier and direct same-epoch TCP session', async () => {
  const c = validateCandidate(candidate()); const root = { ...c.targetPins, postmasterStart: '2026-10-06 00:00:00+00' };
  let rootCalls = 0;
  const client = { query: async text => {
    assert.match(text, /session_user/); return { rows: [{ database: c.target.database, username: c.target.username,
      session_user: c.target.username, database_oid: c.targetPins.databaseOid, role_oid: c.targetPins.roleOid,
      address: '127.0.0.1', port: 5432, postmaster_start: root.postmasterStart }] };
  } };
  assert.deepEqual(await measureBoundary(c, client, async () => { rootCalls++; return root; }), root);
  assert.equal(rootCalls, 2);
  for (const change of [r => r.role_oid = '9', r => r.session_user = 'postgres', r => r.port = 5433,
    r => r.postmaster_start = 'changed', r => r.address = '::1']) {
    const broken = { query: async text => { const output = await client.query(text); change(output.rows[0]); return output; } };
    await assert.rejects(measureBoundary(c, broken, async () => root));
  }
  let calls = 0;
  await assert.rejects(measureBoundary(c, client, async () => ({ ...root, postmasterStart: ++calls === 2 ? 'changed' : root.postmasterStart })), /epoch/);
});
test('actual default CLI plan validates offline without opening credential, PG or protected release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-schema-entry-test-'));
  try {
    const path = join(directory, 'candidate.json'); const c = candidate(); await writeFile(path, JSON.stringify(c));
    assert.deepEqual(await main(['--candidate', path]), {
      status: 'schema_plan_validated_offline', planSha256: digest(c), productionMigrationReady: false, liveTargetChecked: false,
    });
    await assert.rejects(main(['--candidate', path, '--mode', 'unknown']), /invalid_cli_mode/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('aborted transaction receives native ROLLBACK ACK before any boundary SELECT', async () => {
  const calls = []; let aborted = true;
  const client = { query: async text => { calls.push(text); if (text === 'ROLLBACK') { aborted = false; return { command: 'ROLLBACK', rows: [] }; }
    if (aborted) throw new Error('25P02'); return { rows: [] }; } };
  const query = guardedNativeQuery(client, async () => { await client.query('SELECT boundary'); }, () => 1000);
  assert.equal((await query('ROLLBACK')).command, 'ROLLBACK');
  assert.deepEqual(calls, ['ROLLBACK', 'SELECT boundary']);
  assert.deepEqual((await query('SELECT ordinary')).rows, []);
});
test('unknown/failed ROLLBACK cannot be replaced by connection release or a boundary ACK', async () => {
  let measured = false;
  for (const result of [{ command: 'OTHER', rows: [] }, null]) {
    const client = { query: async () => { if (!result) throw new Error('network'); return result; } };
    await assert.rejects(guardedNativeQuery(client, async () => { measured = true; }, () => 1000)('ROLLBACK'));
  }
  assert.equal(measured, false);
});
test('pool allocated before initialization failure is closed internally with registered cleanup', async () => {
  const calls = [];
  await assert.rejects(initializeOwnedPool(() => ({ end: async () => { calls.push('pool.end'); } }), async (_pool, onFailure) => {
    onFailure(() => { calls.push('clear timer'); }); throw new Error('init-failure');
  }), /init-failure/);
  assert.deepEqual(calls, ['clear timer', 'pool.end']);
});
