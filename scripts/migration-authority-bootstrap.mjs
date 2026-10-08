#!/usr/bin/env node
import * as fs from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { dirname, isAbsolute, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export const CONTRACT = Object.freeze({
  coordinatorSha256: '1544baca2bbe6f78a19e62d74d9c28ce3bdbd0bc6795b3276f3765ee2394a07b',
  closureSha256: 'f007a84bd69d0426620387dec0d65b9c252ca6a951ed7581b5aecd3968bbfb2a',
});
const ACTIONS = ['prepare', 'select-postgres', 'first-postgres-write', 'rollback', 'abort'];
const KINDS = ['census', 'fence', 'snapshot', 'parity', 'target', 'guards', 'capacity', 'rehearsal', 'rollback'];
const SCOPE_KINDS = ['service', 'timer', 'bridge', 'cron', 'operator', 'deploy', 'external-input'];
const ROLES = ['operator-authorization', 'observer-collector', 'snapshot-collector', 'compatibility-verifier'];
const OBSERVER_KINDS = KINDS.filter(kind => kind !== 'snapshot');
const CLOSURE_SIGNING_KINDS = Object.freeze({
  'operator-authorization': 'authorization', 'observer-collector': 'census',
  'snapshot-collector': 'snapshot', 'compatibility-verifier': 'rollback',
});
const BASE = '/var/lib/address-radar-migration-authority';
const HASH = /^[a-f0-9]{64}$/;
const MAX = 131072;
const C = fs.constants;
const DIR = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
class Refusal extends Error {}
function need(ok, reason) { if (!ok) throw new Refusal(reason); }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  let nodes = 0;
  function visit(item, depth) {
    need(++nodes <= 20000 && depth <= 16, 'json-bound');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') { need(Number.isSafeInteger(item) && !Object.is(item, -0), 'json-number'); return String(item); }
    if (typeof item === 'string') { need(item.length <= 8192 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item), 'json-string'); return JSON.stringify(item); }
    need(item && typeof item === 'object' && Object.getOwnPropertySymbols(item).length === 0, 'json-object');
    if (Array.isArray(item)) {
      need(Object.getPrototypeOf(item) === Array.prototype, 'json-array');
      return '[' + item.map(child => visit(child, depth + 1)).join(',') + ']';
    }
    need(Object.getPrototypeOf(item) === Object.prototype, 'json-object');
    return '{' + Object.keys(item).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      need(descriptor && Object.hasOwn(descriptor, 'value'), 'json-accessor');
      return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
    }).join(',') + '}';
  }
  const result = visit(value, 0);
  need(Buffer.byteLength(result) <= MAX, 'json-bound');
  return result;
}
function exact(value, keys) {
  need(value && Object.getPrototypeOf(value) === Object.prototype &&
       Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), 'fields');
}
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value);
const path = value => typeof value === 'string' && /^\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(value) &&
  isAbsolute(value) && normalize(value) === value && !value.split('/').some(part => part === '.' || part === '..');
function subset(values, allowed, maximum = 256) {
  need(Array.isArray(values) && values.length <= maximum && new Set(values).size === values.length &&
       values.every(value => allowed.includes(value)), 'enum');
}
export function validateProfile(input) {
  const profile = JSON.parse(canonical(input));
  exact(profile, ['version', 'bootstrapId', 'provenance', 'contracts', 'scopes', 'roles']);
  need(profile.version === 1 && /^[a-f0-9]{16}$/.test(profile.bootstrapId) &&
       profile.provenance === 'new-local-operator-bootstrap', 'bootstrap-identity');
  exact(profile.contracts, ['coordinatorSha256', 'closureSha256']);
  need(canonical(profile.contracts) === canonical(CONTRACT), 'contract-drift');
  need(Array.isArray(profile.scopes) && profile.scopes.length >= 1 && profile.scopes.length <= 256, 'scope-bound');
  const scopeIds = [];
  for (const scope of profile.scopes) {
    exact(scope, ['id', 'kind', 'paths', 'directions']);
    need(token(scope.id) && SCOPE_KINDS.includes(scope.kind), 'scope');
    need(Array.isArray(scope.paths) && scope.paths.length >= 1 && scope.paths.length <= 32 &&
         new Set(scope.paths).size === scope.paths.length && scope.paths.every(path), 'scope-path');
    subset(scope.directions, ['source-to-input', 'output-to-source'], 2);
    need(scope.kind === 'bridge' ? scope.directions.length === 2 : scope.directions.length === 0, 'scope-directions');
    scopeIds.push(scope.id);
  }
  need(new Set(scopeIds).size === scopeIds.length && Array.isArray(profile.roles) && profile.roles.length === 4, 'roles');
  for (const role of profile.roles) {
    exact(role, ['role', 'issuerId', 'keyId', 'actions', 'kinds', 'scopeIds', 'collectorSha256']);
    need(ROLES.includes(role.role) && token(role.issuerId) && token(role.keyId), 'role-identity');
    subset(role.actions, ACTIONS, 5); subset(role.kinds, KINDS, 9); subset(role.scopeIds, scopeIds);
    need(role.scopeIds.length >= 1, 'role-scopes');
    if (role.role === 'operator-authorization') {
      need(role.actions.length === ACTIONS.length && role.kinds.length === 0 &&
           role.collectorSha256 === null, 'authorization-scope');
    } else {
      need(role.actions.length === 0 && HASH.test(role.collectorSha256) && role.kinds.length >= 1, 'collector-scope');
      if (role.role === 'snapshot-collector') need(canonical(role.kinds) === '["snapshot"]', 'snapshot-scope');
      if (role.role === 'compatibility-verifier') need(canonical(role.kinds) === '["rehearsal"]', 'compatibility-scope');
      if (role.role === 'observer-collector') need(role.kinds.includes('census') && role.kinds.includes('fence') &&
           role.kinds.every(kind => OBSERVER_KINDS.includes(kind)), 'observer-scope');
    }
  }
  for (const key of ['role', 'issuerId', 'keyId']) need(new Set(profile.roles.map(role => role[key])).size === 4, 'role-distinctness');
  return profile;
}
export function createPlan(input) {
  const profile = validateProfile(input);
  return { version: 1, provenance: profile.provenance, bootstrapId: profile.bootstrapId,
    root: BASE + '/' + profile.bootstrapId, profileSha256: sha256(canonical(profile)),
    scopesSha256: sha256(canonical(profile.scopes)), contracts: profile.contracts,
    roles: profile.roles, closureSigningKinds: CLOSURE_SIGNING_KINDS, keyAlgorithm: 'Ed25519', directoryMode: '0700', privateMode: '0600',
    publication: 'exclusive-public-registry-last', trustInstalled: false, productionReadiness: false,
    independentNativeEvidenceAcquired: false, signedProofsCreated: false };
}
export function generateAuthorities() {
  return ROLES.map(() => {
    const pair = generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({ type: 'spki', format: 'der' });
    return { publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), fingerprintSha256: sha256(der) };
  });
}
function checkKeys(keys) {
  need(Array.isArray(keys) && keys.length === 4, 'key-count');
  const result = keys.map(key => {
    exact(key, ['publicKeyPem', 'privateKeyPem', 'fingerprintSha256']);
    need(typeof key.publicKeyPem === 'string' && key.publicKeyPem.length <= 512 &&
         typeof key.privateKeyPem === 'string' && key.privateKeyPem.length <= 512, 'key-bound');
    const publicKey = createPublicKey(key.publicKeyPem), privateKey = createPrivateKey(key.privateKeyPem);
    const der = publicKey.export({ type: 'spki', format: 'der' });
    need(publicKey.asymmetricKeyType === 'ed25519' && privateKey.asymmetricKeyType === 'ed25519' &&
         der.equals(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })) &&
         key.fingerprintSha256 === sha256(der), 'key-identity');
    return { publicKeyPem: key.publicKeyPem, publicKeyBase64: der.toString('base64'), fingerprintSha256: sha256(der) };
  });
  need(new Set(result.map(key => key.fingerprintSha256)).size === 4, 'key-distinctness');
  return result;
}
const identity = stat => [stat.dev, stat.ino];
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
export function assertDirectoryStat(stat, exactMode = null) {
  need(stat.isDirectory() && stat.uid === 0 && !(stat.mode & 0o022) &&
       (exactMode === null || (stat.mode & 0o7777) === exactMode), 'directory-permission');
}
export function assertFileStat(stat, root = true) {
  need(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 &&
       (!root || stat.uid === 0), 'file-permission');
}
const alias = fd => '/proc/self/fd/' + fd;
function bounded(until) { need(performance.now() < until, 'operation-bound'); }
function protectedDirectory(absolute) {
  need(path(absolute), 'protected-path');
  let fd = fs.openSync('/', DIR), current = '';
  const pins = [{ path: '/', stat: fs.fstatSync(fd) }];
  try {
    assertDirectoryStat(pins[0].stat);
    for (const name of absolute.split('/').slice(1)) {
      const next = fs.openSync(alias(fd) + '/' + name, DIR);
      fs.closeSync(fd); fd = next; current += '/' + name;
      const stat = fs.fstatSync(fd); assertDirectoryStat(stat);
      need(sameIdentity(stat, fs.lstatSync(current)), 'directory-replaced');
      pins.push({ path: current, stat });
    }
    return { fd, pins };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function checkAncestors(pins) {
  for (const pin of pins) {
    const stat = fs.lstatSync(pin.path); assertDirectoryStat(stat);
    need(sameIdentity(stat, pin.stat), 'ancestor-replaced');
  }
}
function hashProtected(absolute, until) {
  const parent = protectedDirectory(dirname(absolute));
  let fd;
  try {
    checkAncestors(parent.pins);
    fd = fs.openSync(alias(parent.fd) + '/' + basename(absolute), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    need(before.isFile() && before.uid === 0 && before.nlink === 1 && !(before.mode & 0o022) && before.size <= 268435456, 'runtime-file');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (true) { bounded(until); const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break;
      bytes += count; need(bytes <= 268435456, 'runtime-bound'); hash.update(buffer.subarray(0, count)); }
    const after = fs.fstatSync(fd);
    need(sameIdentity(before, after) && before.size === after.size && before.mtimeMs === after.mtimeMs &&
         before.ctimeMs === after.ctimeMs && sameIdentity(before, fs.lstatSync(alias(parent.fd) + '/' + basename(absolute))), 'runtime-replaced');
    checkAncestors(parent.pins);
    return hash.digest('hex');
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(parent.fd); }
}
function checkRuntime(approval, until) {
  need(process.platform === 'linux' && process.geteuid() === 0, 'linux-root-required');
  need(HASH.test(approval.expectedNodeSha256) && HASH.test(approval.expectedBootstrapSha256), 'runtime-pins');
  need(hashProtected(process.execPath, until) === approval.expectedNodeSha256 &&
       hashProtected(fileURLToPath(import.meta.url), until) === approval.expectedBootstrapSha256, 'runtime-pin-mismatch');
}
export class NativeStore {
  constructor(until) { this.until = until; }
  check() {
    bounded(this.until); checkAncestors(this.parent.pins);
    need(sameIdentity(fs.fstatSync(this.fd), fs.lstatSync(this.root)) &&
         sameIdentity(fs.fstatSync(this.fd), this.rootStat), 'namespace-replaced');
    assertDirectoryStat(fs.fstatSync(this.fd), 0o700);
  }
  begin(root) {
    need(path(root) && dirname(root) === BASE && /^[a-f0-9]{16}$/.test(basename(root)), 'namespace');
    this.root = root; this.parent = protectedDirectory(BASE);
    assertDirectoryStat(fs.fstatSync(this.parent.fd), 0o700);
    checkAncestors(this.parent.pins);
    // mkdir is exclusive: incomplete prior bootstraps must be independently audited.
    fs.mkdirSync(alias(this.parent.fd) + '/' + basename(root), { mode: 0o700 });
    this.fd = fs.openSync(alias(this.parent.fd) + '/' + basename(root), DIR);
    this.rootStat = fs.fstatSync(this.fd); this.check(); fs.fsyncSync(this.parent.fd);
  }
  write(name, bytes, mode = 0o600) {
    need(typeof name === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(name) && mode === 0o600 && bytes.length <= MAX, 'write-bound');
    this.check();
    const fd = fs.openSync(alias(this.fd) + '/' + name, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, mode);
    try {
      assertFileStat(fs.fstatSync(fd));
      let offset = 0;
      while (offset < bytes.length) { bounded(this.until); const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); need(count > 0, 'write-progress'); offset += count; }
      fs.fsyncSync(fd); assertFileStat(fs.fstatSync(fd));
      need(sameIdentity(fs.fstatSync(fd), fs.lstatSync(alias(this.fd) + '/' + name)), 'file-replaced');
      this.check();
    } finally { fs.closeSync(fd); }
  }
  publish(bytes) {
    this.write('registry.pending', bytes);
    this.check();
    // link is an atomic no-replace publication. A crash leaving nlink=2 is NOT usable.
    fs.linkSync(alias(this.fd) + '/registry.pending', alias(this.fd) + '/registry.json');
    fs.fsyncSync(this.fd);
    fs.unlinkSync(alias(this.fd) + '/registry.pending');
    fs.fsyncSync(this.fd); this.check();
    assertFileStat(fs.lstatSync(alias(this.fd) + '/registry.json'));
  }
  close() {
    if (this.fd !== undefined) { fs.closeSync(this.fd); this.fd = undefined; }
    if (this.parent) { fs.closeSync(this.parent.fd); this.parent = null; }
  }
}
export function applyBootstrap(input, approval, dependencies = {}) {
  const profile = validateProfile(input), plan = createPlan(profile);
  need(approval.profileSha256 === plan.profileSha256 &&
       approval.approvedPlanSha256 === sha256(canonical(plan)) &&
       approval.approvalKind === 'new-local-operator-bootstrap', 'explicit-profile-plan-approval');
  const until = performance.now() + 30000;
  (dependencies.checkRuntime ?? checkRuntime)(approval, until);
  const store = dependencies.store ?? new NativeStore(until);
  try {
    store.begin(plan.root);
    const keys = (dependencies.generateKeys ?? generateAuthorities)(), publicKeys = checkKeys(keys);
    bounded(until);
    const authorities = profile.roles.map(role => {
      const index = ROLES.indexOf(role.role);
      store.write(role.role + '.private.pem', Buffer.from(keys[index].privateKeyPem), 0o600);
      return { ...role, ...publicKeys[index], closureSigningKind: CLOSURE_SIGNING_KINDS[role.role],
        privateFile: role.role + '.private.pem' };
    });
    const registry = { version: 1, provenance: profile.provenance, bootstrapId: profile.bootstrapId,
      profileSha256: plan.profileSha256, approvedPlanSha256: approval.approvedPlanSha256,
      contracts: profile.contracts, scopes: profile.scopes, scopesSha256: plan.scopesSha256,
      authorities, trustInstalled: false, productionReadiness: false,
      signedProofsCreated: false, independentNativeEvidenceAcquired: false };
    store.publish(Buffer.from(canonical(registry)));
    return { status: 'new-local-operator-bootstrap-created', root: plan.root,
      registrySha256: sha256(canonical(registry)), profileSha256: plan.profileSha256,
      fingerprints: authorities.map(({ role, issuerId, keyId, fingerprintSha256 }) => ({ role, issuerId, keyId, fingerprintSha256 })),
      trustInstalled: false, productionReadiness: false, signedProofsCreated: false };
  } finally { store.close(); }
}
function readProfile(absolute, protect) {
  need(path(absolute), 'profile-path');
  let parent, fd;
  try {
    if (protect) parent = protectedDirectory(dirname(absolute));
    fd = fs.openSync(parent ? alias(parent.fd) + '/' + basename(absolute) : absolute, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    const before = fs.fstatSync(fd); assertFileStat(before, protect); need(before.size <= MAX, 'profile-bound');
    const raw = fs.readFileSync(fd); need(raw.length <= MAX, 'profile-bound');
    const after = fs.fstatSync(fd);
    need(sameIdentity(before, after) && before.size === after.size && before.mtimeMs === after.mtimeMs &&
         before.ctimeMs === after.ctimeMs && sameIdentity(before, fs.lstatSync(absolute)), 'profile-replaced');
    if (parent) checkAncestors(parent.pins);
    const profile = JSON.parse(raw); need(canonical(profile) === raw.toString(), 'canonical-profile-required');
    return profile;
  } finally { if (fd !== undefined) fs.closeSync(fd); if (parent) fs.closeSync(parent.fd); }
}
export function main(argv = process.argv.slice(2)) {
  try {
    const action = argv.shift(); need(['plan', 'apply'].includes(action) && argv.length % 2 === 0 && argv.length <= 14, 'arguments');
    const options = new Map(), allowed = ['--profile', '--profile-sha256', '--approved-plan-sha256', '--approval-kind', '--expected-node-sha256', '--expected-bootstrap-sha256'];
    for (let index = 0; index < argv.length; index += 2) { need(allowed.includes(argv[index]) && !options.has(argv[index]), 'arguments'); options.set(argv[index], argv[index + 1]); }
    need(options.has('--profile') && HASH.test(options.get('--profile-sha256')), 'profile-pin');
    if (action === 'plan') need(options.size === 2, 'plan-arguments');
    else need(options.size === 6, 'apply-arguments');
    const profile = readProfile(options.get('--profile'), action === 'apply');
    need(sha256(canonical(profile)) === options.get('--profile-sha256'), 'profile-pin-mismatch');
    const result = action === 'plan' ? createPlan(profile) : applyBootstrap(profile, {
      profileSha256: options.get('--profile-sha256'), approvedPlanSha256: options.get('--approved-plan-sha256'),
      approvalKind: options.get('--approval-kind'), expectedNodeSha256: options.get('--expected-node-sha256'),
      expectedBootstrapSha256: options.get('--expected-bootstrap-sha256'),
    });
    console.log(canonical(action === 'plan' ? { status: 'offline-plan', plan: result, planSha256: sha256(canonical(result)) } : result));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ status: 'refused', reason: error instanceof Refusal ? error.message : 'bootstrap-failed', productionReadiness: false, trustInstalled: false }));
    return 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
