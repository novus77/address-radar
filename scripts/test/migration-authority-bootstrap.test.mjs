import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { validateProfile, createPlan, generateAuthorities, applyBootstrap, canonical, sha256, CONTRACT, assertDirectoryStat, assertFileStat, main } from '../migration-authority-bootstrap.mjs';

const hash = 'a'.repeat(64);
function profile() {
  return {
    version: 1, bootstrapId: '0123456789abcdef', provenance: 'new-local-operator-bootstrap',
    contracts: { coordinatorSha256: CONTRACT.coordinatorSha256, closureSha256: CONTRACT.closureSha256 },
    scopes: [{ id: 'approved-service', kind: 'service', paths: ['/approved/source'], directions: [] }],
    roles: [
      { role: 'operator-authorization', issuerId: 'new-local-operator', keyId: 'authorization-key', actions: ['prepare', 'select-postgres', 'first-postgres-write', 'rollback', 'abort'], kinds: [], scopeIds: ['approved-service'], collectorSha256: null },
      { role: 'observer-collector', issuerId: 'new-local-observer', keyId: 'observer-key', actions: [], kinds: ['census', 'fence'], scopeIds: ['approved-service'], collectorSha256: hash },
      { role: 'snapshot-collector', issuerId: 'new-local-snapshot', keyId: 'snapshot-key', actions: [], kinds: ['snapshot'], scopeIds: ['approved-service'], collectorSha256: hash },
      { role: 'compatibility-verifier', issuerId: 'new-local-compatibility', keyId: 'compatibility-key', actions: [], kinds: ['rehearsal'], scopeIds: ['approved-service'], collectorSha256: hash },
    ],
  };
}
function authoritySet() { return generateAuthorities(); }
function memoryStore({ failure = null, exists = false } = {}) {
  const files = new Map(), events = [];
  return { files, events,
    begin(root) { if (exists) throw new Error('exclusive'); events.push(['begin', root]); },
    write(name, bytes, mode) { assert.equal(mode, 0o600); if (files.has(name) || failure === name) throw new Error('exclusive'); files.set(name, Buffer.from(bytes)); events.push(['write', name]); },
    publish(bytes) { if (failure === 'publish') throw new Error('publication'); files.set('registry.json', bytes); events.push(['publish']); },
    close() { events.push(['close']); },
  };
}
function approved(p = profile()) {
  const plan = createPlan(p);
  return { profileSha256: sha256(canonical(p)), approvedPlanSha256: sha256(canonical(plan)),
           approvalKind: 'new-local-operator-bootstrap', expectedNodeSha256: hash, expectedBootstrapSha256: hash };
}

test('offline plan is deterministic, bounded and explicitly not readiness', () => {
  const p = profile(), plan = createPlan(p);
  assert.deepEqual(plan, createPlan(p));
  assert.equal(plan.productionReadiness, false);
  assert.equal(plan.trustInstalled, false);
  assert.equal(plan.provenance, 'new-local-operator-bootstrap');
  assert.equal(plan.root, '/var/lib/address-radar-migration-authority/0123456789abcdef');
  assert.ok(!canonical(plan).includes('PRIVATE KEY'));
});
test('profile rejects unapproved enums, scopes, duplicate identities and unknown fields', () => {
  for (const mutate of [
    p => p.roles[0].actions.push('activate'), p => p.roles[1].kinds.push('success'),
    p => p.scopes[0].kind = 'opaque', p => p.scopes[0].paths = ['/approved/../source'],
    p => p.roles[0].scopeIds = ['unknown'], p => p.roles[3].keyId = p.roles[0].keyId,
    p => p.roles[3].issuerId = p.roles[1].issuerId, p => p.roles[0].privateKey = 'bad',
    p => p.provenance = 'pre-existing-external-reviewer', p => p.contracts.closureSha256 = hash,
  ]) { const p = profile(); mutate(p); assert.throws(() => validateProfile(p)); }
});
test('real Ed25519 authorities have four distinct public keys', () => {
  const keys = authoritySet();
  assert.equal(new Set(keys.map(k => k.fingerprintSha256)).size, 4);
  for (const key of keys) {
    assert.equal(createPublicKey(key.publicKeyPem).asymmetricKeyType, 'ed25519');
    assert.equal(createPublicKey(key.privateKeyPem).export({ type: 'spki', format: 'pem' }).toString(), key.publicKeyPem);
  }
});
test('approval pins are required before storage or key creation', () => {
  for (const field of ['profileSha256', 'approvedPlanSha256', 'approvalKind']) {
    const p = profile(), approval = approved(p), store = memoryStore(); approval[field] = 'bad';
    assert.throws(() => applyBootstrap(p, approval, { store, checkRuntime() {}, generateKeys() { throw new Error('must not generate'); } }));
    assert.deepEqual(store.events, []);
  }
});
test('apply writes private600 and only then publishes the public registry', () => {
  const p = profile(), store = memoryStore();
  const result = applyBootstrap(p, approved(p), { store, checkRuntime() {}, generateKeys: authoritySet });
  assert.equal(result.productionReadiness, false);
  assert.equal(result.trustInstalled, false);
  assert.ok(!canonical(result).includes('PRIVATE KEY'));
  const registry = JSON.parse(store.files.get('registry.json'));
  assert.equal(registry.authorities.length, 4);
  assert.ok(!canonical(registry).includes('PRIVATE KEY'));
  assert.equal(new Set(registry.authorities.map(k => k.fingerprintSha256)).size, 4);
  assert.deepEqual(store.events.slice(-2), [['publish'], ['close']]);
  for (const role of p.roles) assert.ok(store.files.get(role.role + '.private.pem').toString().startsWith('-----BEGIN PRIVATE KEY-----'));
});
test('existing namespaces and failed writes never publish or silently retry', () => {
  for (const opts of [{ exists: true }, { failure: 'snapshot-collector.private.pem' }, { failure: 'publish' }]) {
    const p = profile(), store = memoryStore(opts);
    assert.throws(() => applyBootstrap(p, approved(p), { store, checkRuntime() {}, generateKeys: authoritySet }));
    assert.ok(!store.files.has('registry.json'));
  }
});
test('duplicate real keys fail before private writes', () => {
  const p = profile(), store = memoryStore(), keys = authoritySet(); keys[3] = keys[0];
  assert.throws(() => applyBootstrap(p, approved(p), { store, checkRuntime() {}, generateKeys: () => keys }));
  assert.ok(!store.events.some(e => e[0] === 'write' || e[0] === 'publish'));
});
test('key type and private/public mismatches are refused', () => {
  const p = profile();
  for (const mutation of ['wrong-type', 'mismatch']) {
    const keys = authoritySet(), store = memoryStore();
    if (mutation === 'mismatch') keys[0].privateKeyPem = keys[1].privateKeyPem;
    else keys[0].publicKeyPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.throws(() => applyBootstrap(p, approved(p), { store, checkRuntime() {}, generateKeys: () => keys }));
    assert.ok(!store.files.has('registry.json'));
  }
});

test('canonical public PEM roundtrip and nonplain/accessor rejection', () => {
  const pem = authoritySet()[0].publicKeyPem;
  assert.equal(JSON.parse(canonical({ pem })).pem, pem);
  assert.throws(() => canonical({ get secret() { throw new Error('not evaluated'); } }));
  assert.throws(() => canonical({ toJSON() { return 'coerced'; } }));
  assert.throws(() => canonical({ bad: '\ud800' }));
});
test('native metadata guards reject symlinks, ownership, modes and hardlinks', () => {
  const directory = { isDirectory: () => true, uid: 0, mode: 0o40700 };
  assertDirectoryStat(directory, 0o700);
  for (const mutation of [{ uid: 1 }, { mode: 0o40777 }, { isDirectory: () => false }, { mode: 0o40755 }]) {
    assert.throws(() => assertDirectoryStat({ ...directory, ...mutation }, 0o700));
  }
  const file = { isFile: () => true, uid: 0, mode: 0o100600, nlink: 1 };
  assertFileStat(file);
  for (const mutation of [{ uid: 1 }, { mode: 0o100644 }, { isFile: () => false }, { nlink: 2 }]) {
    assert.throws(() => assertFileStat({ ...file, ...mutation }));
  }
});
test('CLI refuses unknown key arguments without echoing their contents', () => {
  let output = '';
  const original = console.log;
  console.log = value => { output += value; };
  try { assert.equal(main(['apply', '--private-key', 'SECRET-PRIVATE-KEY']), 1); }
  finally { console.log = original; }
  assert.ok(!output.includes('SECRET-PRIVATE-KEY'));
  assert.equal(JSON.parse(output).reason, 'arguments');
});

test('full-cutover authorization requires all five existing actions', () => {
  for (const action of profile().roles[0].actions) {
    const p = profile(); p.roles[0].actions = p.roles[0].actions.filter(value => value !== action);
    assert.throws(() => validateProfile(p));
  }
  const p = profile(); p.roles[0].actions.reverse();
  assert.equal(validateProfile(p).roles[0].actions.length, 5);
});
test('compatibility collector requires coordinator rehearsal, not closure rollback kind', () => {
  for (const kinds of [['rollback'], [], ['rehearsal', 'rollback']]) {
    const p = profile(); p.roles[3].kinds = kinds;
    assert.throws(() => validateProfile(p));
  }
  assert.deepEqual(validateProfile(profile()).roles[3].kinds, ['rehearsal']);
});
test('observer minimally requires census and fence without implicit rollback authority', () => {
  const kinds = profile().roles[1].kinds;
  for (const kind of kinds) {
    const p = profile(); p.roles[1].kinds = kinds.filter(value => value !== kind);
    assert.throws(() => validateProfile(p));
  }
  const p = profile(); p.roles[1].kinds.reverse();
  assert.equal(validateProfile(p).roles[1].kinds.length, 2);
});
test('registry separates closure signing domains from coordinator kinds and keys', () => {
  const p = profile(), store = memoryStore();
  p.roles[1].kinds.push('rollback');
  applyBootstrap(p, approved(p), { store, checkRuntime() {}, generateKeys: authoritySet });
  const registry = JSON.parse(store.files.get('registry.json'));
  const byRole = Object.fromEntries(registry.authorities.map(authority => [authority.role, authority]));
  assert.equal(byRole['operator-authorization'].closureSigningKind, 'authorization');
  assert.equal(byRole['observer-collector'].closureSigningKind, 'census');
  assert.ok(byRole['observer-collector'].kinds.includes('rollback'));
  assert.equal(byRole['snapshot-collector'].closureSigningKind, 'snapshot');
  assert.equal(byRole['compatibility-verifier'].closureSigningKind, 'rollback');
  assert.deepEqual(byRole['compatibility-verifier'].kinds, ['rehearsal']);
  assert.notEqual(byRole['compatibility-verifier'].publicKeyBase64, byRole['observer-collector'].publicKeyBase64);
  assert.notEqual(byRole['compatibility-verifier'].publicKeyBase64, byRole['operator-authorization'].publicKeyBase64);
  assert.equal(registry.productionReadiness, false);
  assert.equal(registry.trustInstalled, false);
});

test('minimal registry never adds coordinator rollback or observer extras', () => {
  const p = profile(), store = memoryStore();
  applyBootstrap(p, approved(p), { store, checkRuntime() {}, generateKeys: authoritySet });
  const registry = JSON.parse(store.files.get('registry.json'));
  const observer = registry.authorities.find(authority => authority.role === 'observer-collector');
  const compatibility = registry.authorities.find(authority => authority.role === 'compatibility-verifier');
  assert.deepEqual(observer.kinds, ['census', 'fence']);
  assert.deepEqual(compatibility.kinds, ['rehearsal']);
  assert.equal(compatibility.closureSigningKind, 'rollback');
});
test('full coordinator observation coverage is explicit profile approval, not bootstrap defaults', () => {
  const p = profile();
  p.roles[1].kinds = ['census', 'fence', 'parity', 'target', 'guards', 'capacity', 'rehearsal', 'rollback'];
  const minimalHash = createPlan(profile()).profileSha256;
  assert.notEqual(createPlan(p).profileSha256, minimalHash);
  assert.equal(validateProfile(p).roles[1].kinds.length, 8);
  assert.deepEqual(p.roles[3].kinds, ['rehearsal']);
});
