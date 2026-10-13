#!/usr/bin/env node
/** Protected native transport. No key creation, phase default or activation. */
import * as fs from 'node:fs';
import { createHash, createPublicKey } from 'node:crypto';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HASH = /^[a-f0-9]{64}$/;
const sha = raw => createHash('sha256').update(raw).digest('hex');
const need = (value, reason) => { if (!value) throw new Error(reason); };
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function protectedBytes(path, deadline, maximum = 1048576, privateFile = false) {
  need(path === resolve(path) && performance.now() < deadline, 'protected-path-budget');
  const parents = [];
  for (let p = dirname(path);; p = dirname(p)) {
    const s = fs.lstatSync(p);
    need(s.isDirectory() && s.uid === 0 && !(s.mode & 0o022), 'protected-parent');
    parents.push([p, s.dev, s.ino]);
    if (p === '/') break;
  }
  const before = fs.lstatSync(path);
  need(before.isFile() && before.uid === 0 && before.nlink === 1 && !(before.mode & 0o022)
    && before.size <= maximum, 'protected-file');
  if (privateFile) need((before.mode & 0o777) === 0o600
    && (fs.lstatSync(dirname(path)).mode & 0o777) === 0o700, 'private-file');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const pin = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.uid, s.mode, s.nlink].join(':');
  try {
    need(pin(fs.fstatSync(fd)) === pin(before), 'protected-replaced');
    const buffer = Buffer.alloc(maximum + 1); let amount = 0;
    while (amount < buffer.length) {
      need(performance.now() < deadline, 'original-deadline');
      const read = fs.readSync(fd, buffer, amount, buffer.length - amount, null);
      if (!read) break;
      amount += read;
    }
    need(amount <= maximum && pin(before) === pin(fs.fstatSync(fd))
      && pin(before) === pin(fs.lstatSync(path)), 'protected-mutated');
    for (const [p, dev, ino] of parents) {
      const live = fs.lstatSync(p);
      need(live.isDirectory() && live.uid === 0 && !(live.mode & 0o022)
        && live.dev === dev && live.ino === ino, 'ancestor-replaced');
    }
    return buffer.subarray(0, amount);
  } finally { fs.closeSync(fd); }
}
function record(pin, deadline) {
  need(pin && HASH.test(pin.sha256), 'record-pin');
  const raw = protectedBytes(pin.path, deadline, 1048576, true);
  need(sha(raw) === pin.sha256, 'record-mutated');
  const value = JSON.parse(raw);
  need(canonical(value) === raw.toString(), 'record-canonical');
  return value;
}
export function validateRegistry(registry, trust, entrySha256) {
  need(registry.version === 1 && registry.provenance === 'new-local-operator-bootstrap'
    && HASH.test(registry.profileSha256) && HASH.test(registry.approvedPlanSha256)
    && registry.scopesSha256 === trust.expectedScopesSha256
    && sha(canonical(registry.scopes)) === trust.expectedScopesSha256, 'registry-profile-scopes');
  const map = [
    ['operator-authorization', 'authorizationPublicKeyPem', 'authorization'],
    ['observer-collector', 'observerPublicKeyPem', 'census'],
    ['snapshot-collector', 'snapshotPublicKeyPem', 'snapshot'],
    ['compatibility-verifier', 'independentCompatibilityPublicKeyPem', 'rollback'],
  ];
  need(registry.authorities.length === 4 && new Set(registry.authorities.map(a => a.role)).size === 4, 'registry-roles');
  const ids = registry.scopes.map(s => s.id), keys = [];
  need(ids.length > 0 && new Set(ids).size === ids.length, 'registry-scope-ids');
  let snapshot;
  for (const [role, trustKey, kind] of map) {
    const a = registry.authorities.find(a => a.role === role);
    need(a && a.closureSigningKind === kind && a.privateFile === role + '.private.pem'
      && a.scopeIds.length === ids.length && new Set(a.scopeIds).size === ids.length
      && a.scopeIds.every(id => ids.includes(id)), 'registry-role-scope');
    const key = createPublicKey(trust[trustKey]);
    const der = key.export({type: 'spki', format: 'der'});
    need(key.asymmetricKeyType === 'ed25519' && der.toString('base64') === a.publicKeyBase64
      && sha(der) === a.fingerprintSha256, 'registry-real-key');
    keys.push(der.toString('base64'));
    if (role === 'operator-authorization') need(['prepare','select-postgres','first-postgres-write','rollback','abort'].every(x => a.actions.includes(x)), 'authorization-actions');
    if (role === 'observer-collector') need(['census','fence'].every(x => a.kinds.includes(x)) && HASH.test(a.collectorSha256), 'observer-kinds');
    if (role === 'compatibility-verifier') need(a.kinds.includes('rehearsal') && HASH.test(a.collectorSha256), 'compatibility-kind');
    if (role === 'snapshot-collector') {
      need(a.kinds.length === 1 && a.kinds[0] === 'snapshot' && a.collectorSha256 === entrySha256, 'actual-snapshot-entry');
      snapshot = a;
    }
  }
  need(new Set(keys).size === 4, 'independent-keys');
  return snapshot;
}
export function phaseOfCommitted(capability) {
  need(capability && ['postgres-selected','postgres-written','postgres-rollback-selected'].includes(capability.phase), 'committed-phase-required');
  need((capability.phase === 'postgres-selected') === (capability.firstPostgresWrite === null), 'committed-phase-marker');
  return capability.firstPostgresWrite === null ? 'before-first-pg-write' : 'after-first-pg-write';
}
export async function main(args) {
  const started = performance.now(), deadline = started + 30000;
  need(process.platform === 'linux' && process.geteuid?.() === 0 && args.length === 4
    && args[0] === '--job' && args[2] === '--job-sha256', 'native-root-job');
  const job = record({path: args[1], sha256: args[3]}, deadline);
  need(job.version === 1 && /^[a-f0-9]{16}$/.test(job.nonce) && /^[a-f0-9]{16}$/.test(job.requestNonce), 'job-request');
  const control = '/var/lib/address-radar-rehearsal-artifact-control/' + job.nonce;
  const directory = control + '/receipts/' + job.requestNonce;
  need(job.bindingPath === control + '/invocations/' + job.requestNonce + '-verifier.binding.json'
    && job.outputPath === directory + '/proof.json'
    && /^\/var\/lib\/address-radar-migration-authority\/[a-f0-9]{16}\/registry.json$/.test(job.registry.path), 'namespace');
  const bindingRaw = protectedBytes(job.bindingPath, deadline, 1048576, true);
  const binding = JSON.parse(bindingRaw), bindingSha256 = sha(bindingRaw);
  need(canonical(binding) === bindingRaw.toString(), 'binding-canonical');
  const admitRaw = protectedBytes(job.bindingPath.replace(/binding[.]json$/, 'admit.json'), deadline, 65536, true);
  need(canonical(JSON.parse(admitRaw)) === admitRaw.toString()
    && canonical(JSON.parse(admitRaw)) === canonical({binding_sha256: bindingSha256}), 'admit-chain');
  need(binding.role === 'verifier' && binding.request_nonce === job.requestNonce
    && binding.invocation_id === process.env.INVOCATION_ID
    && /^[a-f0-9]{32}$/.test(binding.invocation_id)
    && binding.unit === 'radar-rehearsal-' + job.nonce + '-verifier-' + job.requestNonce + '.service'
    && binding.policy.receipt_directory === directory, 'managed-binding');
  need(fs.readFileSync('/proc/self/cgroup','utf8').trim() === '0::' + binding.control_group, 'managed-cgroup');
  const cg = fs.lstatSync('/sys/fs/cgroup' + binding.control_group);
  need(cg.isDirectory() && cg.dev === binding.identity[0] && cg.ino === binding.identity[1], 'managed-cgroup-pin');
  const policy = record(job.policy, deadline), registry = record(job.registry, deadline);
  need(policy.version === 2 && policy.closureTrust && registry.profileSha256 === job.approvedProfileSha256, 'approved-trust-profile');
  const entry = fileURLToPath(import.meta.url);
  const authority = validateRegistry(registry, policy.closureTrust, sha(protectedBytes(entry, deadline)));
  // Every actually loaded non-builtin module must have an approved byte pin.
  const pins = new Map();
  need(Array.isArray(job.codePins) && job.codePins.length >= 3 && job.codePins.length <= 512, 'code-closure-bound');
  for (const pin of job.codePins) {
    need(pin.path === resolve(pin.path) && HASH.test(pin.sha256) && !pins.has(pin.path), 'code-closure-pin');
    pins.set(pin.path, pin.sha256);
  }
  const hook = registerHooks({ load(url, context, next) {
    if (url.startsWith('node:')) return next(url, context);
    need(url.startsWith('file:'), 'module-url');
    const path = fileURLToPath(url), pin = pins.get(path);
    need(pin, 'unregistered-module');
    const raw = protectedBytes(path, deadline, 16 * 1024 * 1024);
    need(sha(raw) === pin, 'module-pin');
    const loaded = next(url, context);
    return {...loaded, source: raw};
  }});
  let pool, privateBytes;
  try {
    const engine = await import(pathToFileURL(job.enginePath).href);
    const coordinator = await import(pathToFileURL(job.coordinatorPath).href);
    const pg = await import(pathToFileURL(job.pgModulePath).href);
    need(typeof engine.signIndependentSnapshotClosure === 'function'
      && typeof coordinator.createReadOnlyCutoverStartupStore === 'function'
      && typeof coordinator.createMigrationCutoverCoordinator === 'function', 'actual-native-apis');
    const options = record(job.credentials, deadline), target = policy.binding.target;
    const url = new URL(options.connectionString);
    need(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === '127.0.0.1'
      && Number(url.port) === target.serverPort && target.serverAddress === '127.0.0.1'
      && [5432,5434].includes(target.serverPort) && decodeURIComponent(url.pathname.slice(1)) === target.database
      && !url.search && !url.hash && options.ssl === false, 'phase-endpoint');
    const Pool = pg.Pool ?? pg.default?.Pool;
    pool = new Pool({connectionString: options.connectionString, ssl: false, max: 1,
      connectionTimeoutMillis: 2000, statement_timeout: 2000, lock_timeout: 500});
    const check = () => { need(performance.now() < deadline, 'original-deadline'); return new Date().toISOString(); };
    const runtime = {async run(operation) {
      check(); const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
        const role = (await client.query(`SELECT current_user=session_user AS same_role,
          NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles x WHERE x.oid<>r.oid AND pg_has_role(session_user,x.oid,'SET'))
          AND NOT has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE has_schema_privilege(r.oid,n.oid,'CREATE'))
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
            WHERE p.prosecdef AND n.nspname!~'^pg_' AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid) AS unprivileged,
          NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p','v','m','f')
            AND (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) AS no_table_write,
          NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relkind='S'
            AND has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE')) AS no_sequence_write
          FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows[0];
        need(role && Object.values(role).every(v => v === true), 'phase-role-acl');
        const result = await operation({async query(sql, values = []) {check(); return client.query(sql, [...values]);}});
        check(); await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }};
    const store = coordinator.createReadOnlyCutoverStartupStore({runtime, target, clock: check});
    const phaseReader = coordinator.createMigrationCutoverCoordinator({expected: policy, store, clock: check});
    need(typeof phaseReader.inspectPersistedPhase === 'function', 'native-phase-interface');
    const measure = () => phaseReader.inspectPersistedPhase(
      new Date(Date.now() + Math.min(policy.deadlines.maximumOperationMs, 10000, deadline - performance.now())).toISOString());
    const before = await measure();
    const measurement = record(job.measurement, deadline);
    const inputs = Object.fromEntries(['authorization','census','rollback'].map(k => [k, record(job[k], deadline)]));
    privateBytes = protectedBytes(dirname(job.registry.path) + '/' + authority.privateFile, deadline, 4096, true);
    const signed = engine.signIndependentSnapshotClosure({measurement, ...inputs,
      trust: policy.closureTrust, phase: before.phase, privateKeyPem: privateBytes, now: new Date(check())});
    const after = await measure();
    need(canonical(before) === canonical(after), 'persisted-phase-changed');
    await pool.end(); pool = undefined;
    need(Date.now() < binding.deadline * 1000, 'managed-expired'); check();
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const assertParent = () => {
        const live = fs.lstatSync(directory), held = fs.fstatSync(fd);
        need(live.isDirectory() && live.uid === 0 && (live.mode & 0o777) === 0o700
          && live.dev === binding.receipt_identity[0] && live.ino === binding.receipt_identity[1]
          && held.dev === live.dev && held.ino === live.ino, 'receipt-replaced');
      };
      assertParent();
      const output = fs.openSync('/proc/self/fd/' + fd + '/proof.json', fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {fs.writeFileSync(output, canonical(signed)); fs.fsyncSync(output); assertParent(); fs.fsyncSync(fd);}
      finally {fs.closeSync(output);}
    } finally {fs.closeSync(fd);}
    process.stdout.write('{"status":"snapshot-signed","activationEnabled":false}\n');
  } finally {privateBytes?.fill(0); if (pool) await pool.end(); hook.deregister();}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {process.stdout.write('{"status":"snapshot-signing-refused","activationEnabled":false}\n');process.exitCode=2;});
}
