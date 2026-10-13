import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, rename, unlink, opendir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const hashPattern = /^[a-f0-9]{64}$/;
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const reference = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const decimal = /^[1-9][0-9]*$/;
export function protectedPinMaximumBytes(slot) {
  requireThat(['python', 'authenticationPlan', 'authenticationScript', 'credential'].includes(slot), 'unknown_pin_slot');
  return slot === 'python' ? 64 * 1024 * 1024 : slot === 'credential' ? 64 * 1024 : 1024 * 1024;
}
const requireThat = (value, code) => { if (!value) throw new Error(code); };
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  requireThat(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'invalid_canonical_value');
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function fields(value, names) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...names].sort()), 'unknown_or_missing_field');
}
function absolute(path) { requireThat(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== '/', 'invalid_protected_path'); }
function pin(value, secret = false) {
  fields(value, ['path', 'sha256', 'uid', 'gid', 'mode', 'device', 'inode']); absolute(value.path);
  requireThat(hashPattern.test(value.sha256) && value.uid === 0 && value.gid === 0
    && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777
    && !(value.mode & 0o022) && (!secret || value.mode === 0o600)
    && decimal.test(value.device) && decimal.test(value.inode), 'invalid_protected_pin');
}
export function validateCandidate(value) {
  fields(value, ['version', 'operationId', 'approvalRef', 'authenticationPlanSha256', 'authenticationPlan',
    'authenticationScript', 'authenticationStateDirectory', 'python', 'credential', 'target', 'targetPins',
    'schemaPlan', 'release', 'invocationTimeoutMs', 'statementTimeoutMs', 'lockTimeoutMs', 'privateDirectory',
    ...(Object.hasOwn(value, 'authenticationRecovery') ? ['authenticationRecovery'] : [])]);
  if (Object.hasOwn(value, 'authenticationRecovery')) validateAuthenticationRecovery(value.authenticationRecovery);
  requireThat(value.version === 1 && reference.test(value.operationId) && reference.test(value.approvalRef)
    && hashPattern.test(value.authenticationPlanSha256), 'invalid_candidate_identity');
  for (const key of ['authenticationPlan', 'authenticationScript', 'python']) pin(value[key]);
  pin(value.credential, true); absolute(value.authenticationStateDirectory); absolute(value.privateDirectory);
  requireThat(value.credential.path === join(value.authenticationStateDirectory, 'secrets.json')
    && value.privateDirectory !== value.authenticationStateDirectory, 'private_state_collision');
  fields(value.target, ['database', 'schema', 'username', 'generation', 'service']);
  requireThat(['database', 'schema', 'username'].every(key => identifier.test(value.target[key]))
    && !['public', 'information_schema'].includes(value.target.schema) && !value.target.schema.startsWith('pg_')
    && reference.test(value.target.generation) && value.target.service === 'migration', 'migration_target_required');
  fields(value.targetPins, ['systemIdentifier', 'databaseOid', 'roleOid']);
  requireThat(Object.values(value.targetPins).every(v => typeof v === 'string' && decimal.test(v)), 'invalid_target_pins');
  fields(value.schemaPlan, ['version', 'fingerprint', 'migrations']);
  requireThat(Number.isSafeInteger(value.schemaPlan.version) && value.schemaPlan.version >= 1
    && value.schemaPlan.version <= 80 && hashPattern.test(value.schemaPlan.fingerprint)
    && Array.isArray(value.schemaPlan.migrations) && value.schemaPlan.migrations.length === value.schemaPlan.version, 'invalid_schema_plan');
  value.schemaPlan.migrations.forEach((m, index) => {
    fields(m, ['version', 'fingerprint', 'previousFingerprint', 'modules']);
    requireThat(m.version === index + 1 && hashPattern.test(m.fingerprint) && hashPattern.test(m.previousFingerprint)
      && Array.isArray(m.modules) && m.modules.length > 0 && m.modules.length <= 80
      && m.modules.every(v => typeof v === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(v))
      && new Set(m.modules).size === m.modules.length
      && (index === 0 || m.previousFingerprint === value.schemaPlan.migrations[index - 1].fingerprint), 'invalid_schema_chain');
  });
  requireThat(value.schemaPlan.fingerprint === value.schemaPlan.migrations.at(-1).fingerprint, 'invalid_schema_head');
  fields(value.release, ['root', 'inventorySha256', 'maximumEntries', 'maximumBytes']); absolute(value.release.root);
  requireThat(hashPattern.test(value.release.inventorySha256) && Number.isInteger(value.release.maximumEntries)
    && value.release.maximumEntries >= 1 && value.release.maximumEntries <= 4096
    && Number.isSafeInteger(value.release.maximumBytes) && value.release.maximumBytes >= 1
    && value.release.maximumBytes <= 134217728, 'invalid_release_budget');
  requireThat(Number.isInteger(value.invocationTimeoutMs) && value.invocationTimeoutMs > 0 && value.invocationTimeoutMs <= 180000
    && Number.isInteger(value.statementTimeoutMs) && value.statementTimeoutMs > 0 && value.statementTimeoutMs <= value.invocationTimeoutMs
    && Number.isInteger(value.lockTimeoutMs) && value.lockTimeoutMs > 0 && value.lockTimeoutMs <= value.statementTimeoutMs, 'invalid_invocation_budget');
  return structuredClone(value);
}
export const RECOVERY_REVALIDATOR_SHA256 = '11fa16d2aa49da8cf55cb8c791421b24745f6cbebd8db18224cc7eca5b849e51';
export const RECOVERY_CONSUMER_SHA256 = '0b8edb0c600920cd7ec42c1b42d95ae979c429a6fbdd43281708034f82a588f7';
export function validateAuthenticationRecovery(value) {
  fields(value, ['mode', 'proof', 'producer', 'revalidator', 'consumer', 'pinHelper']);
  requireThat(value.mode === 'known-pending-hba', 'invalid_recovery_mode');
  for (const key of ['proof', 'producer', 'revalidator', 'consumer', 'pinHelper']) pin(value[key], key === 'proof');
  requireThat(['eac155c618a5c7854744917cf2fa1b46949e063cbd842711c28aff4da1fd77ff', RECOVERY_REVALIDATOR_SHA256].includes(value.producer.sha256)
    && value.revalidator.sha256 === RECOVERY_REVALIDATOR_SHA256 && value.consumer.sha256 === RECOVERY_CONSUMER_SHA256
    && value.pinHelper.sha256 === 'f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f', 'unreviewed_recovery_code');
}
export async function probeAuthenticationBoundary(candidate, remaining, runner = command, read = boundedFile, mode = 'root-boundary') {
  if (!candidate.authenticationRecovery) {
    const measured = await runner(candidate.python.path, ['-I', candidate.authenticationScript.path, '--plan', candidate.authenticationPlan.path,
      '--mode', 'measure-root', '--private-directory', candidate.authenticationStateDirectory], remaining);
    requireThat(measured.status === 'measured_root_migrator_boundary' && measured.tcpAuthenticationChecked === false
      && measured.planSha256 === candidate.authenticationPlanSha256, 'root_boundary_not_measured');
    return expectedBoundary(candidate, measured);
  }
  const r = candidate.authenticationRecovery; validateAuthenticationRecovery(r);
  requireThat(['full', 'root-boundary'].includes(mode), 'invalid_recovery_probe_mode');
  for (const key of ['proof', 'producer', 'revalidator', 'consumer', 'pinHelper'])
    await read(r[key].path, key === 'proof' ? 65536 : 1048576, remaining, r[key]);
  const measured = await runner(candidate.python.path, ['-I', r.consumer.path, '--pin-helper', r.pinHelper.path,
    '--producer', r.producer.path, '--revalidator', r.revalidator.path, '--recovery-proof', r.proof.path,
    '--approved-record-file-sha256', r.proof.sha256, '--plan', candidate.authenticationPlan.path,
    '--state-directory', candidate.authenticationStateDirectory, '--mode', mode], remaining);
  requireThat(measured.status === (mode === 'full' ? 'recovery_current_native_verified' : 'recovery_root_boundary_verified')
    && measured.tcpAuthenticationChecked === (mode === 'full') && measured.planSha256 === candidate.authenticationPlanSha256
    && measured.recoveryRecordFileSha256 === r.proof.sha256 && measured.originalPending === 'hba'
    && measured.originalJournalPreserved === true && measured.credentialRenewed === false
    && measured.historicalHbaAckProved === false && measured.independentSoftwareTrustIssued === false,
    'recovery_boundary_not_measured');
  return expectedBoundary(candidate, measured.boundary);
}

export function verifyLedger(candidate, ledger) {
  const t = candidate.target;
  requireThat(ledger && ledger.owner === candidate.targetPins.roleOid && Array.isArray(ledger.header)
    && ledger.header.length === 1 && Array.isArray(ledger.history)
    && ledger.history.length === candidate.schemaPlan.migrations.length, 'ledger_incomplete_or_foreign');
  const h = ledger.header[0];
  requireThat(h.singleton === true && h.ledger_format === 1 && h.database_name === t.database
    && h.schema_name === t.schema && h.generation_id === t.generation && h.installed_by === t.username
    && h.approval_ref === candidate.approvalRef, 'ledger_identity_changed');
  ledger.history.forEach((row, index) => {
    const m = candidate.schemaPlan.migrations[index];
    requireThat(row.version === m.version && row.fingerprint === m.fingerprint
      && row.previous_fingerprint === m.previousFingerprint && row.modules_json === JSON.stringify(m.modules)
      && row.installed_by === t.username && row.approval_ref === candidate.approvalRef, 'ledger_history_changed');
  });
  return digest(ledger);
}
const result = status => ({ status, schemaInstalled: true, productionMigrationReady: false,
  fullCapacityProved: false, backendChanged: false, businessActivation: false, dataImported: false,
  deliveryEnabled: false, otherRolesLogin: false, trustEstablished: false });
function expectedBoundary(candidate, boundary) {
  requireThat(boundary && Object.entries(candidate.targetPins).every(([k, v]) => boundary[k] === v)
    && typeof boundary.postmasterStart === 'string' && boundary.postmasterStart.length > 0, 'live_target_changed');
  return { ...candidate.targetPins, postmasterStart: boundary.postmasterStart };
}
export async function measureBoundary(candidate, client, rootBoundary) {
  const before = expectedBoundary(candidate, await rootBoundary());
  const rows = (await client.query(`SELECT current_database() AS database, current_user AS username, session_user AS session_user,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
    host(inet_server_addr()) AS address, inet_server_port() AS port,
    pg_postmaster_start_time()::text AS postmaster_start`)).rows;
  requireThat(rows.length === 1 && rows[0].database === candidate.target.database && rows[0].username === candidate.target.username
    && rows[0].session_user === candidate.target.username && rows[0].database_oid === candidate.targetPins.databaseOid
    && rows[0].role_oid === candidate.targetPins.roleOid && rows[0].address === '127.0.0.1' && rows[0].port === 5432, 'native_connection_identity_changed');
  const after = expectedBoundary(candidate, await rootBoundary());
  requireThat(rows[0].postmaster_start === before.postmasterStart && canonical(before) === canonical(after), 'native_connection_epoch_changed');
  return before;
}
export function createSchemaInstaller(uowModule, schemaModule, guardedPool, candidate) {
  requireThat(canonical(schemaModule.POSTGRES_BUSINESS_SCHEMA_PLAN) === canonical(candidate.schemaPlan), 'compiled_schema_plan_changed');
  const executor = uowModule.createPostgresUnitOfWork(guardedPool, {
    statementTimeoutMs: candidate.statementTimeoutMs, lockTimeoutMs: candidate.lockTimeoutMs,
  });
  return () => schemaModule.installPostgresBusinessSchema(executor, {
    target: candidate.target, approval: 'approved-new-business-schema', approvalRef: candidate.approvalRef,
    plan: schemaModule.POSTGRES_BUSINESS_SCHEMA_PLAN,
  });
}
export function guardedNativeQuery(client, boundary, remaining) {
  return async (text, values) => {
    if (text === 'ROLLBACK') {
      // Cleanup is independent of the exhausted operation budget, and never authorizes further work.
      let timer;
      try {
        const receipt = await Promise.race([client.query(text, values), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('native_rollback_cleanup_timeout')), 5000);
        })]);
        requireThat(receipt?.command === 'ROLLBACK', 'native_rollback_unacknowledged');
        let canContinue = false;
        try { canContinue = remaining() > 0; } catch {}
        if (canContinue) await boundary(client);
        return receipt;
      } catch (error) { client.connection?.stream?.destroy(); throw error; }
      finally { clearTimeout(timer); }
    }
    await boundary(client); remaining(); return client.query(text, values);
  };
}
export async function initializeOwnedPool(factory, initialize) {
  const pool = factory(), cleanup = [];
  try { return await initialize(pool, action => cleanup.push(action)); }
  catch (error) {
    try { for (const action of cleanup.reverse()) await action(); }
    finally { await pool.end(); }
    throw error;
  }
}
export async function runInstallation(candidate, ports, mode) {
  requireThat(['apply', 'reconcile'].includes(mode), 'invalid_mutating_mode');
  const planSha256 = digest(candidate), before = expectedBoundary(candidate, await ports.guard());
  let journal = await ports.load();
  if (!journal) {
    requireThat(mode === 'apply', 'missing_schema_intent');
    requireThat(await ports.namespaceAbsent(), 'existing_namespace_refused');
    journal = { version: 1, planSha256, operationId: candidate.operationId, boundary: before,
      pending: 'schema-install', ledgerSha256: null };
    await ports.save(journal);
  } else {
    fields(journal, ['version', 'planSha256', 'operationId', 'boundary', 'pending', 'ledgerSha256']);
    requireThat(journal.version === 1 && journal.planSha256 === planSha256 && journal.operationId === candidate.operationId
      && canonical(journal.boundary) === canonical(before)
      && (journal.pending === 'schema-install' && journal.ledgerSha256 === null
        || journal.pending === null && hashPattern.test(journal.ledgerSha256)), 'schema_journal_changed');
    if (journal.pending) requireThat(mode === 'reconcile', 'explicit_reconcile_required');
    return finish(journal.pending ? 'schema_reconciled' : 'schema_already_installed');
  }
  requireThat(canonical(expectedBoundary(candidate, await ports.guard())) === canonical(before), 'preinstall_boundary_changed');
  let uncertain = false;
  try { await ports.install(); } catch { uncertain = true; }
  return finish(uncertain ? 'schema_reconciled' : 'schema_installed');
  async function finish(status) {
    try {
      const ledgerSha256 = verifyLedger(candidate, await ports.readLedger());
      requireThat(canonical(expectedBoundary(candidate, await ports.guard())) === canonical(before), 'postinstall_boundary_changed');
      if (journal.ledgerSha256 !== null) requireThat(journal.ledgerSha256 === ledgerSha256, 'schema_receipt_changed');
      await ports.save({ ...journal, pending: null, ledgerSha256 });
      return { ...result(status), planSha256, ledgerSha256 };
    } catch { throw new Error('schema_pending_preserved'); }
  }
}

function stamp(s) { return [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].map(String).join(':'); }
async function protectedAncestors(path) {
  const identities = [];
  for (let current = path; ; current = dirname(current)) {
    const s = await lstat(current, { bigint: true });
    requireThat(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0n && !(s.mode & 0o022n), 'unsafe_protected_ancestor');
    identities.push([current, `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.gid}`]);
    if (current === '/') break;
  }
  return async () => {
    for (const [path_, identity] of identities) {
      const s = await lstat(path_, { bigint: true });
      requireThat(s.isDirectory() && `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.gid}` === identity, 'protected_ancestor_changed');
    }
  };
}
async function boundedFile(path, maximum, remaining, expected) {
  absolute(path); remaining(); const bind = await protectedAncestors(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await handle.stat({ bigint: true });
    requireThat(s.isFile() && s.uid === 0n && s.nlink === 1n && !(s.mode & 0o022n)
      && s.size <= BigInt(maximum), 'unsafe_or_oversize_file');
    if (expected) requireThat(String(s.dev) === expected.device && String(s.ino) === expected.inode
      && Number(s.mode & 0o777n) === expected.mode && Number(s.uid) === expected.uid && Number(s.gid) === expected.gid, 'protected_file_pin_changed');
    const chunks = []; let size = 0;
    while (true) {
      remaining(); const buffer = Buffer.alloc(Math.min(65536, maximum - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead; requireThat(size <= maximum, 'file_grew_past_budget'); chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    requireThat(stamp(s) === stamp(await handle.stat({ bigint: true }))
      && stamp(s) === stamp(await lstat(path, { bigint: true })) && bytes.length === Number(s.size), 'protected_file_changed');
    await bind();
    if (expected) requireThat(createHash('sha256').update(bytes).digest('hex') === expected.sha256, 'protected_file_hash_changed');
    return { bytes, stat: s };
  } finally { await handle.close(); }
}
export async function releaseInventory(spec, remaining) {
  const bind = await protectedAncestors(spec.root); const entries = []; let count = 0, total = 0;
  async function scan(directory, relative, depth) {
    requireThat(depth <= 32, 'release_depth_exceeded'); remaining();
    const handle = await opendir(directory); const names = [];
    try { for await (const item of handle) { remaining(); requireThat(++count <= spec.maximumEntries, 'release_entries_exceeded'); names.push(item.name); } }
    catch (e) { try { await handle.close(); } catch {} throw e; }
    for (const name of names.sort()) {
      remaining(); const path = join(directory, name), suffix = relative ? `${relative}/${name}` : name;
      const s = await lstat(path, { bigint: true });
      requireThat(!s.isSymbolicLink() && s.uid === 0n && !(s.mode & 0o022n), 'unsafe_release_entry');
      if (s.isDirectory()) { entries.push({ path: suffix, kind: 'directory', mode: Number(s.mode & 0o777n) }); await scan(path, suffix, depth + 1); }
      else {
        requireThat(s.isFile() && s.size <= BigInt(spec.maximumBytes - total), 'release_bytes_exceeded');
        const { bytes } = await boundedFile(path, spec.maximumBytes - total, remaining); total += bytes.length;
        entries.push({ path: suffix, kind: 'file', mode: Number(s.mode & 0o777n), size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
    const after = await opendir(directory); const again = [];
    for await (const item of after) { remaining(); requireThat(again.length < spec.maximumEntries, 'release_rescan_exceeded'); again.push(item.name); }
    requireThat(canonical(names.sort()) === canonical(again.sort()), 'release_inventory_changed');
  }
  await scan(spec.root, '', 0); await bind();
  return { entries: entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), bytes: total };
}
async function storage(path, remaining) {
  const parentBind = await protectedAncestors(dirname(path));
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  await parentBind(); const s = await lstat(path, { bigint: true });
  requireThat(s.isDirectory() && s.uid === 0n && s.gid === 0n && (s.mode & 0o777n) === 0o700n, 'unsafe_schema_state');
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const fdPath = `/proc/self/fd/${directory.fd}`;
  const bind = async () => {
    remaining(); await parentBind(); const current = await lstat(path, { bigint: true });
    requireThat(current.dev === s.dev && current.ino === s.ino && current.mode === s.mode && current.uid === s.uid && current.gid === s.gid, 'schema_state_changed');
  };
  let lock;
  try { lock = await open(join(fdPath, 'operation.lock'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await lock.sync(); await directory.sync(); }
  catch { await directory.close(); throw new Error('schema_state_locked'); }
  const lockIdentity = await lock.stat({ bigint: true });
  return {
    load: async () => {
      await bind(); let handle;
      try { handle = await open(join(fdPath, 'journal.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      try {
        const before = await handle.stat({ bigint: true });
        requireThat(before.isFile() && before.nlink === 1n && before.uid === 0n && before.gid === 0n
          && (before.mode & 0o777n) === 0o600n && before.size <= 65536n, 'unsafe_schema_journal');
        const bytes = Buffer.alloc(Number(before.size) + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
        requireThat(read.bytesRead === Number(before.size) && stamp(before) === stamp(await handle.stat({ bigint: true })), 'schema_journal_changed');
        const text = bytes.subarray(0, read.bytesRead).toString('utf8'), parsed = JSON.parse(text);
        requireThat(text === canonical(parsed) + '\n', 'noncanonical_schema_journal'); await bind(); return parsed;
      } finally { await handle.close(); }
    },
    save: async value => {
      await bind(); const name = `.journal-${randomBytes(16).toString('hex')}`;
      const handle = await open(join(fdPath, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(canonical(value) + '\n'); await handle.sync(); await bind(); }
      finally { await handle.close(); }
      await rename(join(fdPath, name), join(fdPath, 'journal.json')); await directory.sync(); await bind();
    },
    close: async () => {
      try { await bind(); const current = await lstat(join(fdPath, 'operation.lock'), { bigint: true });
        requireThat(current.dev === lockIdentity.dev && current.ino === lockIdentity.ino, 'schema_lock_changed');
        await unlink(join(fdPath, 'operation.lock')); await directory.sync();
      } finally { await lock.close(); await directory.close(); }
    },
  };
}
export async function ownedCommand(executable, args, remaining, ports = { spawn, setTimeout, clearTimeout }) {
  // Reserve a bounded cleanup window before allocating any child.
  const maximumMs = remaining();
  requireThat(Number.isFinite(maximumMs) && maximumMs > 10000, 'boundary_probe_budget_insufficient');
  return new Promise((resolve_, reject) => {
    let child, deadline, grace, closure, spawned = false, exited = false, closed = false, settled = false;
    let failed = false, closureUnknown = false, stopping = false, size = 0;
    const chunks = [];
    const clear = timer => { if (timer) ports.clearTimeout(timer); };
    const finish = error => {
      if (settled) return; settled = true; clear(deadline); clear(grace); clear(closure);
      if (error) reject(new Error(error)); else {
        try { resolve_(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('invalid_boundary_probe')); }
      }
    };
    const live = () => spawned && !exited && !closed && !settled && child.exitCode === null && child.signalCode === null;
    const signalOwned = signal => {
      if (!live()) return;
      // ChildProcess.kill uses the owned libuv process handle, never an external numeric PID/PGID.
      try { if (!child.kill(signal)) closureUnknown = true; } catch { closureUnknown = true; }
    };
    const requireClose = milliseconds => {
      if (closure || closed || settled) return;
      closure = ports.setTimeout(() => { if (!closed) finish('boundary_probe_child_closure_unknown'); }, milliseconds);
    };
    const stop = () => {
      failed = true; clear(deadline);
      if (stopping || closed || settled) return; stopping = true;
      signalOwned('SIGTERM'); requireClose(10000);
      if (!exited) grace = ports.setTimeout(() => {
        if (!live()) return;
        // Escalation cannot certify descendants closed: always fail closed.
        closureUnknown = true; signalOwned('SIGKILL');
      }, 8000);
    };
    try {
      child = ports.spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe', ...(process.env.SCHEMA_AUTH_LOCK_FD ? [Number(process.env.SCHEMA_AUTH_LOCK_FD)] : [])],
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', ...(process.env.SCHEMA_AUTH_LOCK_FD ? { SCHEMA_AUTH_LOCK_FD: '3' } : {}) }, detached: false });
      child.on('spawn', () => { spawned = true; if (stopping) signalOwned('SIGTERM'); });
      child.on('exit', () => { exited = true; clear(deadline); clear(grace); requireClose(5000); });
      child.on('error', () => { failed = true; clear(deadline); requireClose(5000); });
      child.on('close', code => {
        closed = true;
        if (closureUnknown) finish('boundary_probe_child_closure_unknown');
        else if (failed || code !== 0) finish('boundary_probe_failed');
        else finish();
      });
      deadline = ports.setTimeout(() => { if (!exited && !closed && !settled) stop(); }, maximumMs - 10000);
      child.stdout.on('data', bytes => { size += bytes.length; if (size > 65536) stop(); else if (!failed) chunks.push(Buffer.from(bytes)); });
      child.stderr.on('data', bytes => { size += bytes.length; if (size > 65536) stop(); });
    } catch {
      if (!child) finish('boundary_probe_failed');
      else stop(); // Initialization failure still owns the child until close ACK.
    }
  });
}
const command = ownedCommand;
async function nativePorts(candidate, remaining) {
  for (const key of ['authenticationPlan', 'authenticationScript', 'python', 'credential']) await boundedFile(candidate[key].path, protectedPinMaximumBytes(key), remaining, candidate[key]);
  const auth = JSON.parse((await boundedFile(candidate.authenticationPlan.path, 1048576, remaining, candidate.authenticationPlan)).bytes);
  requireThat(digest(auth) === candidate.authenticationPlanSha256, 'authentication_plan_changed');
  const credential = JSON.parse((await boundedFile(candidate.credential.path, 65536, remaining, candidate.credential)).bytes);
  requireThat(credential.version === 1 && credential.purpose === 'production-migrator-private-connection'
    && credential.planSha256 === candidate.authenticationPlanSha256 && credential.host === '127.0.0.1' && credential.port === 5432
    && credential.database === candidate.target.database && credential.user === candidate.target.username
    && credential.schema === candidate.target.schema && credential.generation === candidate.target.generation
    && typeof credential.password === 'string' && /^[A-Za-z0-9_-]{43}$/.test(credential.password)
    && Number.isSafeInteger(credential.expiresAtMs) && credential.expiresAtMs > Date.now() + remaining()
    && credential.targetPins?.systemIdentifier === candidate.targetPins.systemIdentifier
    && credential.targetPins?.databaseOid === candidate.targetPins.databaseOid
    && credential.targetPins?.roleOids?.[candidate.target.username] === candidate.targetPins.roleOid, 'private_credential_binding_changed');
  const inventory = await releaseInventory(candidate.release, remaining);
  requireThat(digest(inventory.entries) === candidate.release.inventorySha256, 'release_inventory_hash_changed');
  const modulePath = relative => pathToFileURL(join(candidate.release.root, relative)).href;
  const schemaModule = await import(modulePath('packages/database/src/postgres-business-schema.js'));
  const uowModule = await import(modulePath('packages/database/src/postgres-unit-of-work.js'));
  const pg = (await import(modulePath('node_modules/pg/lib/index.js'))).default;
  requireThat(canonical(schemaModule.POSTGRES_BUSINESS_SCHEMA_PLAN) === canonical(candidate.schemaPlan), 'compiled_schema_plan_changed');
  if (candidate.authenticationRecovery) await probeAuthenticationBoundary(candidate, remaining, command, boundedFile, 'full');
  return initializeOwnedPool(() => new pg.Pool({ host: '127.0.0.1', port: 5432, database: credential.database, user: credential.user,
    password: credential.password, max: 1, connectionTimeoutMillis: Math.min(remaining(), candidate.statementTimeoutMs),
    query_timeout: candidate.statementTimeoutMs, idleTimeoutMillis: 1000, application_name: 'address-radar-private-schema-installer' }), async (pool, onFailure) => {
  const clients = new Set();
  const timer = setTimeout(() => { for (const client of clients) client.connection?.stream?.destroy(); }, remaining() + 5000);
  onFailure(() => { clearTimeout(timer); for (const client of clients) client.connection?.stream?.destroy(); });
  async function acquire() { remaining(); const client = await pool.connect(); clients.add(client); return client; }
  function release(client, error) { clients.delete(client); client.release(error); }
  async function rootBoundary() {
    remaining(); requireThat(Date.now() < credential.expiresAtMs, 'private_credential_expired');
    for (const key of ['python', 'authenticationScript', 'authenticationPlan', 'credential']) await boundedFile(candidate[key].path, protectedPinMaximumBytes(key), remaining, candidate[key]);
    return probeAuthenticationBoundary(candidate, remaining);
  }
  const boundary = client => measureBoundary(candidate, client, rootBoundary);
  const guardedPool = { connect: async () => {
    const client = await acquire();
    return { query: guardedNativeQuery(client, boundary, remaining),
      release: error => release(client, error) };
  } };
  const install = createSchemaInstaller(uowModule, schemaModule, guardedPool, candidate);
  async function readOnly(work) {
    const client = await acquire(); let broken = true;
    try {
      const before = await boundary(client); await client.query('BEGIN READ ONLY');
      const value = await work(async (text, values) => { await boundary(client); remaining(); return (await client.query(text, values)).rows; });
      await client.query('COMMIT'); requireThat(canonical(before) === canonical(await boundary(client)), 'readonly_boundary_changed'); broken = false; return value;
    } finally { release(client, broken ? new Error('discard_readonly_connection') : undefined); }
  }
  return {
    guard: async () => { const client = await acquire(); try { return await boundary(client); } finally { release(client); } },
    namespaceAbsent: () => readOnly(async query => (await query('SELECT oid FROM pg_namespace WHERE nspname=$1', [candidate.target.schema])).length === 0),
    install,
    readLedger: () => readOnly(async query => {
      const namespace = await query('SELECT nspowner::text AS owner FROM pg_namespace WHERE nspname=$1', [candidate.target.schema]);
      if (namespace.length !== 1) return null;
      const relations = await query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname IN ('business_schema_identity','business_schema_ledger')
        AND c.relkind='r' AND c.relpersistence='p' AND c.relowner::text=$2 ORDER BY c.relname`, [candidate.target.schema, candidate.targetPins.roleOid]);
      if (relations.length !== 2) return null;
      const schema = `"${candidate.target.schema}"`;
      return { owner: namespace[0].owner,
        header: await query(`SELECT singleton,ledger_format,database_name,schema_name,generation_id,installed_by,approval_ref FROM ${schema}.business_schema_identity LIMIT 2`),
        history: await query(`SELECT version,fingerprint,previous_fingerprint,modules_json,installed_by,approval_ref FROM ${schema}.business_schema_ledger ORDER BY version LIMIT $1`, [candidate.schemaPlan.migrations.length + 1]) };
    }),
    close: async () => { clearTimeout(timer); for (const client of clients) client.connection?.stream?.destroy(); await pool.end(); },
  };
  });
}
export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    requireThat(['--candidate', '--mode', '--approved-candidate-sha256'].includes(argv[i]) && argv[i + 1] && !Object.hasOwn(args, argv[i]), 'invalid_cli'); args[argv[i]] = argv[i + 1];
  }
  const mode = args['--mode'] ?? 'plan'; requireThat(['plan', 'apply', 'reconcile'].includes(mode), 'invalid_cli_mode');
  const started = performance.now(); let budget = 180000;
  const remaining = () => { const left = Math.floor(budget - (performance.now() - started)); requireThat(left > 0, 'invocation_budget_exhausted'); return left; };
  requireThat(args['--candidate'], 'candidate_required');
  // Offline planning is non-authoritative and deliberately has no credential, root or live probes.
  let bytes;
  if (mode === 'plan') {
    const handle = await open(args['--candidate'], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const before = await handle.stat({ bigint: true }); requireThat(before.isFile() && before.size <= 1048576n, 'candidate_too_large');
      bytes = Buffer.alloc(Number(before.size) + 1); const r = await handle.read(bytes, 0, bytes.length, 0);
      requireThat(r.bytesRead === Number(before.size) && stamp(before) === stamp(await handle.stat({ bigint: true })), 'candidate_changed'); bytes = bytes.subarray(0, r.bytesRead);
    } finally { await handle.close(); }
  } else {
    requireThat(process.platform === 'linux' && process.getuid?.() === 0, 'native_root_required');
    const own = await realpath(fileURLToPath(import.meta.url)); await boundedFile(own, 1048576, remaining);
    bytes = (await boundedFile(args['--candidate'], 1048576, remaining)).bytes;
  }
  const candidate = validateCandidate(JSON.parse(bytes.toString('utf8'))); budget = candidate.invocationTimeoutMs;
  const planSha256 = digest(candidate);
  if (mode === 'plan') return { status: 'schema_plan_validated_offline', planSha256, productionMigrationReady: false, liveTargetChecked: false };
  requireThat(args['--approved-candidate-sha256'] === planSha256, 'explicit_candidate_approval_required');
  const inherited = process.env.SCHEMA_AUTH_LOCK_FD;
  requireThat(inherited && /^[0-9]+$/.test(inherited), 'original_auth_lock_supervisor_required');
  const inheritedLock = await open(`/proc/self/fd/${inherited}`, constants.O_RDONLY);
  const lock = await inheritedLock.stat({ bigint: true });
  await inheritedLock.close();
  const originalLock = await lstat(join(candidate.authenticationStateDirectory, 'operation.lock'), { bigint: true });
  requireThat(originalLock.isFile() && originalLock.uid === 0n && originalLock.gid === 0n
    && (originalLock.mode & 0o777n) === 0o600n && originalLock.nlink === 1n && originalLock.size === 0n
    && lock.dev === originalLock.dev && lock.ino === originalLock.ino, 'original_auth_lock_changed');
  const ports = await nativePorts(candidate, remaining); let state;
  try {
    await ports.guard(); state = await storage(candidate.privateDirectory, remaining);
    return await runInstallation(candidate, { ...ports, load: state.load, save: state.save }, mode);
  } finally { try { await state?.close(); } finally { await ports.close(); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(value => process.stdout.write(JSON.stringify(value) + '\n'), () => {
    process.stdout.write(JSON.stringify({ status: 'refused', code: 'schema_operation_failed_preserved', productionMigrationReady: false }) + '\n'); process.exitCode = 1;
  });
}
