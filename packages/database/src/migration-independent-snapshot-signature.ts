import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  canonicalFenceClosureEvidence, fenceClosureEvidenceSha256, fenceClosureSigningMessage,
  verifyWriterFenceSnapshotRollbackClosure,
  type FenceClosureAuthorization, type FenceClosureCensus, type FenceClosureRollback,
  type FenceClosureSigned, type FenceClosureSnapshot, type FenceClosureTrust,
} from './migration-writer-fence-closure.js';

export interface IndependentSnapshotMeasurement {
  version: 1;
  kind: 'independent-snapshot-artifact-check';
  source: { path: string; device: string; inode: string };
  tables: FenceClosureSnapshot['tables'];
  tableCensusSha256: string;
  parityReceiptSha256: string;
  restoreReceiptSha256: string;
  currentSourceMeasurementSha256: string;
  currentSourceParityReceiptSha256: string;
  currentSourceRestoreReceiptSha256: string;
  beforeCensusSha256: string;
  afterCensusSha256: string;
  startedAt: string;
  completedAt: string;
  sourceWrites: false;
  signedProofsCreated: false;
  fenceEstablished: false;
}

/** Native transport must hash-pin actual protected checker receipts and key bytes.
 * This API never substitutes measurement flags for signed complete scope census.
 * It returns no envelope unless the unchanged full closure verifier accepts it.
 */
export function signIndependentSnapshotClosure(input: {
  measurement: IndependentSnapshotMeasurement;
  authorization: FenceClosureSigned<FenceClosureAuthorization>;
  census: FenceClosureSigned<FenceClosureCensus>;
  rollback: FenceClosureSigned<FenceClosureRollback>;
  trust: FenceClosureTrust;
  phase: 'before-first-pg-write' | 'after-first-pg-write';
  privateKeyPem: Buffer;
  now: Date;
}): FenceClosureSigned<FenceClosureSnapshot> {
  const fail = (): never => { throw new Error('INDEPENDENT_SNAPSHOT_SIGNATURE_REFUSED'); };
  canonicalFenceClosureEvidence(input.measurement);
  const m = input.measurement, binding = input.trust.expectedBinding;
  if (m.version !== 1 || m.kind !== 'independent-snapshot-artifact-check'
    || m.sourceWrites !== false || m.signedProofsCreated !== false || m.fenceEstablished !== false
    || m.source.path !== binding.sourcePath || m.source.device !== binding.sourceDevice
    || m.source.inode !== binding.sourceInode) fail();
  for (const digest of [m.tableCensusSha256, m.parityReceiptSha256, m.restoreReceiptSha256,
    m.currentSourceMeasurementSha256, m.currentSourceParityReceiptSha256,
    m.currentSourceRestoreReceiptSha256, m.beforeCensusSha256, m.afterCensusSha256]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) fail();
  }
  const key = createPrivateKey(input.privateKeyPem);
  const publicBytes = (pem: string | Buffer) => createPublicKey(pem).export({ type: 'spki', format: 'der' });
  const actual = createPublicKey(key).export({ type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ed25519' || !actual.equals(publicBytes(input.trust.snapshotPublicKeyPem))
    || actual.equals(publicBytes(input.trust.authorizationPublicKeyPem))
    || actual.equals(publicBytes(input.trust.observerPublicKeyPem))
    || actual.equals(publicBytes(input.trust.independentCompatibilityPublicKeyPem))) fail();
  const payload: FenceClosureSnapshot = {
    authorizationSha256: fenceClosureEvidenceSha256(input.authorization.payload),
    censusSha256: fenceClosureEvidenceSha256(input.census.payload),
    binding, kind: 'final-full-fenced', startedAt: m.startedAt, completedAt: m.completedAt,
    tables: m.tables, tableCensusSha256: m.tableCensusSha256,
    parityReceiptSha256: m.currentSourceParityReceiptSha256,
    restoreReceiptSha256: m.currentSourceRestoreReceiptSha256,
  };
  const snapshot = { payload, signatureBase64: sign(null, fenceClosureSigningMessage('snapshot', payload), key).toString('base64') };
  verifyWriterFenceSnapshotRollbackClosure({ authorization: input.authorization, census: input.census,
    rollback: input.rollback, snapshot, phase: input.phase }, input.trust, input.now);
  return snapshot;
}
