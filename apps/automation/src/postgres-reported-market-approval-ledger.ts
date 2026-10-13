import { createHash, createPublicKey } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PostgresTransaction } from '../../../packages/database/src/postgres-unit-of-work.js';
import type { PostgresPricePoolMapping } from './postgres-controlled-price-producer.js';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const REPORTED_MARKET_APPROVAL_SCOPE = 'reported_market_cap_source_approval_v1';
export interface ReportedApprovalPin { readonly path: string; readonly sha256: string }
export interface ReportedApprovalTarget {
  readonly database: string; readonly schema: string; readonly generationId: string;
  readonly systemIdentifier: string; readonly serverAddress: string; readonly serverPort: number;
  readonly schemaVersion: number; readonly schemaFingerprint: string;
}
export interface ReportedMarketApprovalDocument {
  readonly protocol: 'address-only-reported-market-cap-approval-v1';
  readonly importId: string; readonly approvalRef: string; readonly authorizationRef: string;
  readonly target: ReportedApprovalTarget;
  readonly validator: { readonly validatorId: string; readonly keyId: string; readonly actorId: string; readonly publicKey: string };
  readonly source: { readonly providerId: string; readonly origin: string; readonly protocol: 'ave_token_market_cap_v1'; readonly sourceApprovalRef: string };
  readonly mapping: PostgresPricePoolMapping; readonly mappingFingerprint: string; readonly mappingApprovalRef: string;
  readonly quoteAddress: string; readonly quality: 'reported'; readonly sourceProofKind: 'approved_reported_market_cap_v1';
  readonly reviewer: { readonly actorId: string; readonly evidenceSha256: string; readonly reviewedAt: number;
    readonly conflictVerdict: 'none_observed' | 'conflict' | 'unknown' };
  readonly approvedAt: number; readonly validFrom: number; readonly validUntil: number;
}
function demand(value: unknown, reason: string): asserts value { if (!value) throw Error('REPORTED_APPROVAL_' + reason); }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function object(value: unknown): Record<string, unknown> { demand(value && typeof value === 'object' && !Array.isArray(value), 'OBJECT'); return value as Record<string, unknown>; }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const result = object(value); demand(Object.keys(result).sort().join(',') === keys.sort().join(','), 'FIELDS'); return result;
}
function address(value: unknown, chain: string): boolean {
  if (typeof value !== 'string') return false;
  if (chain !== 'solana') return /^0x[0-9a-f]{40}$/.test(value);
  if (value.length < 32 || value.length > 44) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n;
  for (const c of value) { const i = alphabet.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let bytes = 0, zeroes = 0; while (n > 0n) { n >>= 8n; bytes++; } while (value[zeroes] === '1') zeroes++;
  return bytes + zeroes === 32;
}
export function validateReportedMarketApproval(value: unknown): ReportedMarketApprovalDocument {
  const v = exact(value, ['protocol','importId','approvalRef','authorizationRef','target','validator','source','mapping','mappingFingerprint',
    'mappingApprovalRef','quoteAddress','quality','sourceProofKind','reviewer','approvedAt','validFrom','validUntil']);
  const t = exact(v.target, ['database','schema','generationId','systemIdentifier','serverAddress','serverPort','schemaVersion','schemaFingerprint']);
  const a = exact(v.validator, ['validatorId','keyId','actorId','publicKey']);
  const s = exact(v.source, ['providerId','origin','protocol','sourceApprovalRef']);
  const m = exact(v.mapping, ['chain','tokenAddress','poolAddress','tokenSide','network','evidenceRef','knownAt']);
  const r = exact(v.reviewer, ['actorId','evidenceSha256','reviewedAt','conflictVerdict']);
  demand(v.protocol === 'address-only-reported-market-cap-approval-v1' && v.quality === 'reported'
    && v.sourceProofKind === 'approved_reported_market_cap_v1' && s.protocol === 'ave_token_market_cap_v1', 'PROTOCOL');
  demand([v.importId,v.approvalRef,v.authorizationRef,v.mappingApprovalRef,t.generationId,a.validatorId,a.keyId,a.actorId,
    s.providerId,s.sourceApprovalRef,m.network,m.evidenceRef,r.actorId].every(label), 'IDENTITY');
  demand([t.database,t.schema].every(x => typeof x === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(x)
    && !x.startsWith('pg_') && !['postgres','template0','template1','public','information_schema'].includes(x)), 'TARGET');
  demand(typeof t.systemIdentifier === 'string' && /^[1-9][0-9]{0,19}$/.test(t.systemIdentifier)
    && BigInt(t.systemIdentifier) <= 18446744073709551615n && ['127.0.0.1','::1'].includes(String(t.serverAddress))
    && Number.isSafeInteger(t.serverPort) && Number(t.serverPort) > 0 && Number(t.serverPort) <= 65535
    && Number.isSafeInteger(t.schemaVersion) && Number(t.schemaVersion) > 0 && hash(t.schemaFingerprint), 'TARGET');
  demand(typeof s.origin === 'string', 'ORIGIN'); const url = new URL(s.origin);
  demand(url.protocol === 'https:' && url.origin === s.origin && !url.username && !url.password, 'ORIGIN');
  demand(['eth','bsc','base','solana'].includes(String(m.chain)) && ['base','quote'].includes(String(m.tokenSide))
    && [m.tokenAddress,m.poolAddress,v.quoteAddress].every(x => address(x, String(m.chain)))
    && m.tokenAddress !== v.quoteAddress && time(m.knownAt) && hash(v.mappingFingerprint)
    && v.mappingFingerprint === fingerprint(m), 'MAPPING');
  demand(typeof a.publicKey === 'string' && a.publicKey.length <= 4096 && createPublicKey(a.publicKey).asymmetricKeyType === 'ed25519'
    && a.actorId !== s.providerId && a.validatorId !== s.providerId && r.actorId !== s.providerId, 'VALIDATOR');
  demand(hash(r.evidenceSha256) && ['none_observed','conflict','unknown'].includes(String(r.conflictVerdict))
    && [r.reviewedAt,v.approvedAt,v.validFrom,v.validUntil].every(time)
    && Number(m.knownAt) <= Number(r.reviewedAt) && Number(r.reviewedAt) <= Number(v.approvedAt)
    && Number(v.approvedAt) <= Number(v.validFrom) && Number(v.validUntil) > Number(v.validFrom), 'REVIEW');
  return structuredClone(v) as unknown as ReportedMarketApprovalDocument;
}
export function reportedMarketApprovalFingerprint(document: ReportedMarketApprovalDocument): string {
  return fingerprint({ proofScope: REPORTED_MARKET_APPROVAL_SCOPE, document: validateReportedMarketApproval(document) });
}

export interface ReportedApprovalTransactionBinding {
  readonly generationId: string; readonly providerId: string; readonly validatorId: string; readonly keyId: string;
  readonly sourceApprovalRef: string; readonly mappingApprovalRef: string; readonly mapping: PostgresPricePoolMapping;
  readonly quoteAddress: string;
}
/** Shared transaction lock is paired with the controlled import/revoke exclusive lock.
 * No ledger UPDATE privilege is granted to publishers or consumers for row locks.
 * Administrative raw SQL is outside this protocol and must never be used to revoke approvals.
 */
export async function assertReportedMarketApprovalInTransaction(tx: PostgresTransaction, input: {
  readonly approval: unknown; readonly binding: ReportedApprovalTransactionBinding; readonly now: () => number;
}): Promise<void> {
  const approval = object(input.approval), b = input.binding;
  const d = validateReportedMarketApproval(approval.approvalDocument), t = d.target;
  const documentFingerprint = reportedMarketApprovalFingerprint(d), at = input.now();
  demand(time(at) && at >= d.validFrom && at < d.validUntil && approval.approvalDocumentFingerprint === documentFingerprint
    && approval.approvalImportId === d.importId && approval.approvalRef === d.authorizationRef
    && approval.generationId === t.generationId && approval.validatorId === d.validator.validatorId
    && approval.keyId === d.validator.keyId && approval.actorId === d.validator.actorId
    && approval.providerId === d.source.providerId && approval.sourceApprovalRef === d.source.sourceApprovalRef
    && approval.mappingApprovalRef === d.mappingApprovalRef && approval.mappingFingerprint === d.mappingFingerprint
    && approval.quoteAddress === d.quoteAddress && approval.sourceOrigin === d.source.origin
    && approval.sourceProofKind === d.sourceProofKind && approval.quality === d.quality
    && approval.validFrom === d.validFrom && approval.validUntil === d.validUntil && approval.revokedAt === null
    && approval.conflictState === 'none_observed' && d.reviewer.conflictVerdict === 'none_observed'
    && isDeepStrictEqual(approval.reviewer,d.reviewer)
    && b.generationId === t.generationId && b.providerId === d.source.providerId && b.validatorId === d.validator.validatorId
    && b.keyId === d.validator.keyId && b.sourceApprovalRef === d.source.sourceApprovalRef
    && b.mappingApprovalRef === d.mappingApprovalRef && b.quoteAddress === d.quoteAddress && isDeepStrictEqual(b.mapping,d.mapping), 'SIGNED_DOCUMENT_BINDING');
  await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [JSON.stringify([REPORTED_MARKET_APPROVAL_SCOPE,d.importId])]);
  const s = '"' + t.schema + '"';
  const rows = (await tx.query(`/* reported-approval-transaction: read only */ SELECT l.*,
    current_setting('transaction_isolation') isolation,current_database() database,
    host(inet_server_addr()) server_address,inet_server_port() server_port,
    (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) system_identifier,
    i.database_name,i.schema_name,i.generation_id identity_generation,i.ledger_format,
    v.version,v.fingerprint schema_fingerprint
    FROM ${s}.wallet_service_import_ledger l CROSS JOIN ${s}.business_schema_identity i
    CROSS JOIN LATERAL (SELECT version,fingerprint FROM ${s}.business_schema_ledger ORDER BY version DESC LIMIT 1) v
    WHERE l.import_id=$1 AND l.generation_id=$2 AND i.singleton=true`,[d.importId,t.generationId])).rows;
  const r = rows[0], ended = input.now();
  demand(rows.length === 1 && r && time(ended) && ended >= at && ended < d.validUntil && r.isolation === 'read committed'
    && r.import_id === d.importId && r.generation_id === t.generationId && r.approval_ref === d.approvalRef
    && r.source_fingerprint === documentFingerprint && r.proof_scope === REPORTED_MARKET_APPROVAL_SCOPE && r.revoked_at === null
    && r.imported_at !== null && /^\d+$/.test(String(r.imported_at)) && time(Number(r.imported_at))
    && Number(r.imported_at) >= d.approvedAt && Number(r.imported_at) <= at
    && r.database === t.database && r.database_name === t.database && r.schema_name === t.schema
    && r.identity_generation === t.generationId && r.ledger_format === 1 && r.server_address === t.serverAddress
    && r.server_port === t.serverPort && r.system_identifier === t.systemIdentifier
    && r.version === t.schemaVersion && r.schema_fingerprint === t.schemaFingerprint, 'ACTUAL_TRANSACTION_LEDGER');
}
