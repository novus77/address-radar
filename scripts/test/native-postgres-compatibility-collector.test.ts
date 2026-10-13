import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateManagedCollectorBinding, validateCollectorAuthorityScopes, validatePrivateFixtureRoleMeasurement, validatePrivateBackendLineage, privateFixtureRoleSql } from '../native-postgres-compatibility-collector.js';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';

function fixture() {
  const nonce = 'a'.repeat(16), request = 'b'.repeat(16), hash = 'c'.repeat(64);
  const control = '/var/lib/address-radar-rehearsal-artifact-control/' + nonce;
  const unit = 'radar-rehearsal-' + nonce + '-verifier-' + request + '.service';
  return {
    job: { fixture: { nonce }, managedRequestNonce: request, expiryRecordSha256: hash,
      managedAdmissionPath: control + '/invocations/' + request + '-verifier.binding.json',
      outputPath: control + '/receipts/' + request + '/proof.json' },
    expiry: { nonce, artifacts: { control: { root: control } } },
    binding: { unit, role: 'verifier', request_nonce: request, record_sha256: hash,
      invocation_id: 'd'.repeat(32), control_group: '/system.slice/' + unit,
      identity: [1, 2], receipt_identity: [1, 3],
      policy: { receipt_directory: control + '/receipts/' + request } },
  };
}
test('compatibility entry uses frozen helper verifier unit and exact receipt path', () => {
  const f = fixture();
  assert.equal(validateManagedCollectorBinding(f.job, f.expiry, f.binding), f.job.outputPath);
});
test('no old namespace, producer, request reuse or unbound output is accepted', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.binding.role = 'producer'; },
    (f: ReturnType<typeof fixture>) => { f.job.outputPath = '/var/lib/address-radar-migration-evidence/proof.json'; },
    (f: ReturnType<typeof fixture>) => { f.binding.record_sha256 = 'e'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.binding.unit = 'arbitrary.service'; },
    (f: ReturnType<typeof fixture>) => { f.binding.control_group = '/system.slice/../escape'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => validateManagedCollectorBinding(f.job, f.expiry, f.binding));
  }
});
test('actual registry scope bytes and full registered coverage are mandatory', () => {
  const scopes = [{ id: 'service-a', kind: 'service', paths: ['/source'], directions: [] }];
  const hash = createHash('sha256').update(migrationCutoverCanonicalJson(scopes)).digest('hex');
  const registry = { scopes, scopesSha256: hash };
  validateCollectorAuthorityScopes(registry, { scopeIds: ['service-a'] }, hash);
  assert.throws(() => validateCollectorAuthorityScopes(registry, { scopeIds: [] }, hash));
  assert.throws(() => validateCollectorAuthorityScopes(registry, { scopeIds: ['unknown'] }, hash));
  assert.throws(() => validateCollectorAuthorityScopes(registry, { scopeIds: ['service-a'] }, '0'.repeat(64)));
});

test('real session authority must be isolated role, DB, endpoint and measured safe privileges', () => {
  const nonce = 'a'.repeat(16);
  const expected = { role: 'radar_rehearsal_' + nonce + '_candidate', database: 'radar_rehearsal_' + nonce };
  const actual = { role: expected.role, session_role: expected.role, database: expected.database,
    host: '127.0.0.1', port: 5434, backend_pid: 123,
    privileges_safe: true, set_role_safe: true, database_scope_safe: true, ddl_safe: true,
    ownership_safe: true, writes_scoped: true, definer_safe: true, extensions_safe: true };
  validatePrivateFixtureRoleMeasurement(actual, expected, nonce);
  for (const [key, value] of Object.entries({ role: 'postgres', session_role: 'postgres', database: 'production',
    host: '127.0.0.1/32', port: 5432, backend_pid: -1, privileges_safe: false,
    set_role_safe: false, database_scope_safe: false, ddl_safe: false, ownership_safe: false,
    writes_scoped: false, definer_safe: false, extensions_safe: false })) {
    assert.throws(() => validatePrivateFixtureRoleMeasurement({ ...actual, [key]: value }, expected, nonce));
  }
  assert.throws(() => validatePrivateFixtureRoleMeasurement({ ...actual, ownership_safe: 'true' }, expected, nonce));
});

test('actual backend must be a live child of the pinned private postmaster', () => {
  const fields = ['S', '900', ...Array(17).fill('0'), '12345'];
  validatePrivateBackendLineage('901 (postgres app) ' + fields.join(' '), 900);
  assert.throws(() => validatePrivateBackendLineage('901 (postgres app) ' + fields.join(' '), 902));
  fields[0] = 'Z';
  assert.throws(() => validatePrivateBackendLineage('901 (postgres app) ' + fields.join(' '), 900));
});

test('cross-schema column-only INSERT UPDATE REFERENCES grants are measured and denied', () => {
  assert.match(privateFixtureRoleSql, /has_any_column_privilege\(r\.oid,c\.oid,'INSERT,UPDATE,REFERENCES'\)/);
  assert.match(privateFixtureRoleSql, /has_table_privilege/);
  for (const grant of ['INSERT', 'UPDATE', 'REFERENCES']) {
    const nonce = 'a'.repeat(16);
    const expected = {role: 'radar_rehearsal_' + nonce, database: 'radar_rehearsal_' + nonce};
    const measured = {role: expected.role, session_role: expected.role, database: expected.database, host: '127.0.0.1', port: 5434, backend_pid: 901, privileges_safe: true, set_role_safe: true, database_scope_safe: true, ddl_safe: true, ownership_safe: true, writes_scoped: false, definer_safe: true, extensions_safe: true};
    assert.throws(() => validatePrivateFixtureRoleMeasurement(measured, expected, nonce), grant + ' column grant must refuse');
  }
});
