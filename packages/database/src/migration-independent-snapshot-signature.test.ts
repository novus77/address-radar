import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { fenceClosureEvidenceSha256, fenceClosureSigningMessage } from './migration-writer-fence-closure.js';
import { signIndependentSnapshotClosure } from './migration-independent-snapshot-signature.js';

function fixture() {
  const keys = Array.from({ length: 4 }, () => generateKeyPairSync('ed25519'));
  const pem = (index: number) => keys[index]!.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const h = 'a'.repeat(64);
  const measurement = { version: 1, kind: 'independent-snapshot-artifact-check',
    source: { path: '/fixture/source.sqlite', device: '1', inode: '2' }, tables: [],
    tableCensusSha256: h, parityReceiptSha256: h, restoreReceiptSha256: h,
    currentSourceMeasurementSha256: h, currentSourceParityReceiptSha256: h,
    currentSourceRestoreReceiptSha256: h, beforeCensusSha256: h, afterCensusSha256: h,
    startedAt: '2026-10-06T00:00:00.000Z', completedAt: '2026-10-06T00:00:01.000Z',
    sourceWrites: false, signedProofsCreated: false, fenceEstablished: false };
  return { measurement, authorization: { payload: {}, signatureBase64: '' },
    census: { payload: {}, signatureBase64: '' }, rollback: { payload: {}, signatureBase64: '' },
    trust: { expectedBinding: { sourcePath: measurement.source.path, sourceDevice: '1', sourceInode: '2' },
      authorizationPublicKeyPem: pem(0), observerPublicKeyPem: pem(1), snapshotPublicKeyPem: pem(2),
      independentCompatibilityPublicKeyPem: pem(3) },
    phase: 'before-first-pg-write', now: new Date('2026-10-06T00:00:02Z'),
    privateKeyPem: Buffer.from(keys[2]!.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()) } as any;
}

test('actual measurement never substitutes for missing signed complete scope census', () => {
  assert.throws(() => signIndependentSnapshotClosure(fixture()));
});
test('unknown source identity cannot produce a snapshot envelope', () => {
  const input = fixture(); input.measurement.source.inode = 'other';
  assert.throws(() => signIndependentSnapshotClosure(input), /SIGNATURE_REFUSED/);
});
test('missing current-source restore evidence cannot produce a snapshot envelope', () => {
  const input = fixture(); delete input.measurement.currentSourceRestoreReceiptSha256;
  assert.throws(() => signIndependentSnapshotClosure(input));
});
test('shared or wrong authority key is refused before signing', () => {
  const input = fixture(); input.trust.observerPublicKeyPem = input.trust.snapshotPublicKeyPem;
  assert.throws(() => signIndependentSnapshotClosure(input), /SIGNATURE_REFUSED/);
  const other = generateKeyPairSync('ed25519');
  input.privateKeyPem = Buffer.from(other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  assert.throws(() => signIndependentSnapshotClosure(input), /SIGNATURE_REFUSED/);
});

test('synthetic complete signed closure returns a real independently verifiable snapshot signature', () => {
  const input = fixture();
  const keys = Array.from({ length: 4 }, () => generateKeyPairSync('ed25519'));
  const pem = (index: number) => keys[index]!.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const h = 'a'.repeat(64);
  const binding = { ...input.trust.expectedBinding, generation: 'g1', watermark: 'w1', cluster: 'cluster1',
    schemaSha256: h, release: 'pg-r1', artifactSha256: h, cohortSha256: h, providerGuardSha256: h, deliveryGuardSha256: h };
  const scopes = [
    ...Array.from({ length: 12 }, (_, index) => ({ id: 'fixture-service-' + index, kind: 'service', paths: [binding.sourcePath], directions: [] })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: 'fixture-timer-' + index, kind: 'timer', paths: [binding.sourcePath], directions: [] })),
    { id: 'fixture-bridge', kind: 'bridge', paths: ['/fixture/input', '/fixture/output'], directions: ['source-to-input', 'output-to-source'] },
    ...['cron', 'operator', 'deploy', 'external-input'].map(kind => ({ id: 'fixture-' + kind, kind, paths: [binding.sourcePath], directions: [] })),
  ];
  const auth = { binding, scopes, windowStart: '2026-10-06T00:00:00.000Z', windowEnd: '2026-10-06T01:00:00.000Z',
    maximumSqlStatements: 1000, maximumTransactionMs: 60000 };
  const census = { authorizationSha256: fenceClosureEvidenceSha256(auth), observedAt: '2026-10-06T00:00:01.500Z',
    fencedAt: '2026-10-06T00:00:00.000Z', scopes: scopes.map(scope => ({ id: scope.id, admission: 'closed',
      controlReceiptSha256: h, closedUntil: auth.windowEnd, processIds: [],
      timer: scope.kind === 'timer' ? 'disabled-no-pending-trigger' : 'not-applicable',
      bridgeDirections: scope.directions, cursorReceiptSha256: scope.kind === 'bridge' ? h : null })),
    processes: [], discoveredScopeIds: scopes.map(scope => scope.id), sourcePath: binding.sourcePath,
    sourceDevice: binding.sourceDevice, sourceInode: binding.sourceInode, generation: binding.generation, watermark: binding.watermark };
  const rollback = { authorizationSha256: fenceClosureEvidenceSha256(auth), binding, route: 'compatible-postgres-release',
    completedAt: '2026-10-06T00:00:01.600Z', parityReceiptSha256: h, rollbackRelease: 'pg-rollback-r1',
    rollbackArtifactSha256: h, compatibilityTestReceiptSha256: h, preservedProviderGuardSha256: h, preservedDeliveryGuardSha256: h };
  const seal = (kind: 'authorization' | 'census' | 'rollback', payload: any, index: number) => ({ payload,
    signatureBase64: sign(null, fenceClosureSigningMessage(kind, payload), keys[index]!.privateKey).toString('base64') });
  input.authorization = seal('authorization', auth, 0);
  input.census = seal('census', census, 1);
  input.rollback = seal('rollback', rollback, 3);
  input.phase = 'after-first-pg-write';
  input.trust = { expectedBinding: binding, authorizationPublicKeyPem: pem(0), observerPublicKeyPem: pem(1),
    snapshotPublicKeyPem: pem(2), independentCompatibilityPublicKeyPem: pem(3),
    expectedScopesSha256: fenceClosureEvidenceSha256(scopes), expectedTableNames: ['records'],
    expectedRollbackRelease: 'pg-rollback-r1', expectedRollbackArtifactSha256: h,
    maximumEvidenceAgeMs: 300000, maximumMaintenanceWindowMs: 3600000 };
  input.privateKeyPem = Buffer.from(keys[2]!.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  input.measurement.tables = [{ name: 'records', rowCount: '216', sha256: h }];
  input.measurement.tableCensusSha256 = fenceClosureEvidenceSha256(input.measurement.tables);
  const envelope = signIndependentSnapshotClosure(input);
  assert.equal(verify(null, fenceClosureSigningMessage('snapshot', envelope.payload), keys[2]!.publicKey,
    Buffer.from(envelope.signatureBase64, 'base64')), true);
  input.census.payload.scopes.find((scope: any) => scope.id === 'fixture-deploy').admission = 'unknown';
  input.census = seal('census', input.census.payload, 1);
  assert.throws(() => signIndependentSnapshotClosure(input));
});
