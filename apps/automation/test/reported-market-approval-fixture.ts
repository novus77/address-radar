/** Synthetic document/ledger pair only. Never production approval evidence. */
import { generateKeyPairSync } from 'node:crypto';
import { reportedMarketApprovalFingerprint, REPORTED_MARKET_APPROVAL_SCOPE,
  type ReportedMarketApprovalDocument } from '../src/postgres-reported-market-approval-ledger.js';
import { postgresServiceFactFingerprint } from '../src/postgres-service-fact-adapters.js';
import type { PostgresPricePoolMapping } from '../src/postgres-controlled-price-producer.js';
const fixtureKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
export function attachDedicatedReportedApproval<T extends Record<string, unknown>>(approval: T, mapping: PostgresPricePoolMapping,
  target = { database: 'radar_live', schema: 'radar_live', serverAddress: '127.0.0.1', serverPort: 5432, schemaVersion: 3, schemaFingerprint: 'a'.repeat(64) },
  publicKey = fixtureKey) {
  const document: ReportedMarketApprovalDocument = { protocol: 'address-only-reported-market-cap-approval-v1',
    importId: 'synthetic-reported-review', approvalRef: 'synthetic-operator-review', authorizationRef: String(approval.approvalRef),
    target: { database: target.database, schema: target.schema, serverAddress: target.serverAddress, serverPort: target.serverPort, schemaVersion: target.schemaVersion, schemaFingerprint: target.schemaFingerprint, systemIdentifier: '123', generationId: String(approval.generationId) },
    validator: { validatorId: String(approval.validatorId), keyId: String(approval.keyId), actorId: String(approval.actorId), publicKey },
    source: { providerId: String(approval.providerId), origin: 'https://prod.ave-api.com', protocol: 'ave_token_market_cap_v1', sourceApprovalRef: String(approval.sourceApprovalRef) },
    mapping, mappingFingerprint: postgresServiceFactFingerprint(mapping), mappingApprovalRef: String(approval.mappingApprovalRef), quoteAddress: String(approval.quoteAddress),
    quality: 'reported', sourceProofKind: 'approved_reported_market_cap_v1', reviewer: { actorId: 'synthetic-reviewer', evidenceSha256: 'e'.repeat(64),
      reviewedAt: mapping.knownAt, conflictVerdict: 'none_observed' }, approvedAt: mapping.knownAt, validFrom: Number(approval.validFrom), validUntil: Number(approval.validUntil) };
  return { ...approval, approvalImportId: document.importId, approvalDocument: document,
    approvalDocumentFingerprint: reportedMarketApprovalFingerprint(document), sourceOrigin: document.source.origin, reviewer: document.reviewer };
}
export function dedicatedReportedLedgerRow(approval: ReturnType<typeof attachDedicatedReportedApproval>) {
  const d = approval.approvalDocument, t = d.target;
  return { import_id: d.importId, generation_id: t.generationId, approval_ref: d.approvalRef,
    source_fingerprint: approval.approvalDocumentFingerprint, proof_scope: REPORTED_MARKET_APPROVAL_SCOPE, revoked_at: null,
    imported_at: String(d.approvedAt), isolation: 'read committed', database: t.database, database_name: t.database,
    schema_name: t.schema, identity_generation: t.generationId, ledger_format: 1, server_address: t.serverAddress,
    server_port: t.serverPort, system_identifier: t.systemIdentifier, version: t.schemaVersion, schema_fingerprint: t.schemaFingerprint };
}
