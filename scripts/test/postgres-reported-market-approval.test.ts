import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresReportedMarketApprovalReader, importReportedMarketApproval, REPORTED_MARKET_APPROVAL_SCOPE,
  reportedMarketApprovalFingerprint, validateReportedMarketApproval, type ReportedMarketApprovalDocument,
  type ReportedApprovalRun } from '../postgres-reported-market-approval.js';
import { postgresServiceFactFingerprint } from '../../apps/automation/src/postgres-service-fact-adapters.js';
import type { PostgresMigrationRuntimeOptions } from '../../packages/database/src/postgres-migration-runtime.js';

export function approvalFixture() {
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const mapping = { chain: 'solana' as const, tokenAddress: '1'.repeat(31)+'2', poolAddress: '1'.repeat(31)+'3',
    tokenSide: 'base' as const, network: 'solana', evidenceRef: 'reviewed-map', knownAt: 1000 };
  const document: ReportedMarketApprovalDocument = {
    protocol: 'address-only-reported-market-cap-approval-v1', importId: 'reported-source-review-1', approvalRef: 'operator-source-review', authorizationRef: 'reported-validator-authorization',
    target: { database: 'radar_test_business', schema: 'radar_test_business', generationId: 'generation', systemIdentifier: '123',
      serverAddress: '127.0.0.1', serverPort: 5432, schemaVersion: 3, schemaFingerprint: 'a'.repeat(64) },
    validator: { validatorId: 'price-validator', keyId: 'key', actorId: 'review-actor', publicKey },
    source: { providerId: 'approved-ave', origin: 'https://prod.ave-api.com', protocol: 'ave_token_market_cap_v1', sourceApprovalRef: 'ave-source-review' },
    mapping, mappingFingerprint: postgresServiceFactFingerprint(mapping), mappingApprovalRef: 'mapping-review', quoteAddress: '1'.repeat(31)+'4',
    quality: 'reported', sourceProofKind: 'approved_reported_market_cap_v1', reviewer: { actorId: 'source-reviewer', evidenceSha256: 'b'.repeat(64), reviewedAt: 2000, conflictVerdict: 'none_observed' },
    approvedAt: 3000, validFrom: 4000, validUntil: 100000 };
  const ledger = { import_id: document.importId, generation_id: 'generation', approval_ref: document.approvalRef,
    source_fingerprint: reportedMarketApprovalFingerprint(document), proof_scope: REPORTED_MARKET_APPROVAL_SCOPE, imported_at: '5000', revoked_at: null };
  const request = { authorizationRef: document.authorizationRef, generationId: 'generation', validatorId: document.validator.validatorId,
    keyId: 'key', actorId: document.validator.actorId, providerId: document.source.providerId, sourceApprovalRef: document.source.sourceApprovalRef,
    mappingApprovalRef: document.mappingApprovalRef, mappingFingerprint: document.mappingFingerprint, quoteAddress: document.quoteAddress,
    candidateFingerprint: 'c'.repeat(64), sampleId: 'sample', executionFingerprint: 'd'.repeat(64), checkedAt: 6000, signal: new AbortController().signal };
  const identity = { database: document.target.database, database_name: document.target.database, schema_name: document.target.schema,
    generation_id: 'generation', ledger_format: 1, server_address: '127.0.0.1', server_port: 5432, system_identifier: '123', version: 3, fingerprint: 'a'.repeat(64) };
  return { document, ledger, request, identity };
}
function readerFixture() {
  const f = approvalFixture(); let rows: Record<string, unknown>[] = [f.ledger], at = 6000;
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('reported-approval-identity') ? [f.identity] : rows, rowCount: 1 }));
  const run: ReportedApprovalRun = fn => fn({ query });
  const read = vi.fn(async () => structuredClone(f.document));
  const reader = createPostgresReportedMarketApprovalReader({ pin: { path: '/root/review.json', sha256: 'e'.repeat(64) },
    target: f.document.target, run, now: () => at, read });
  return { ...f, query, read, reader, setRows: (v: Record<string, unknown>[]) => { rows = v; }, setAt: (v: number) => { at = v; } };
}
describe('strict dedicated reported-source approval document', () => {
  it('binds reviewer evidence and explicit conflict verdict, not generic provider approval', () => {
    const { document } = approvalFixture(); expect(validateReportedMarketApproval(document)).toEqual(document);
    expect(reportedMarketApprovalFingerprint({ ...document, reviewer: { ...document.reviewer, conflictVerdict: 'unknown' } }))
      .not.toBe(reportedMarketApprovalFingerprint(document));
  });
  it.each(['extra','missing-reviewer','wrong-kind','bad-map','same-quote','future-review','bad-origin','bad-key','quality'])('rejects malformed %s', fault => {
    const { document } = approvalFixture(); const d = structuredClone(document) as unknown as Record<string, unknown>;
    if (fault === 'extra') d.businessApproved = true;
    if (fault === 'missing-reviewer') delete d.reviewer;
    if (fault === 'wrong-kind') d.sourceProofKind = 'independent_candle_replay';
    if (fault === 'bad-map') d.mappingFingerprint = '0'.repeat(64);
    if (fault === 'same-quote') d.quoteAddress = document.mapping.tokenAddress;
    if (fault === 'future-review') d.reviewer = { ...document.reviewer, reviewedAt: 100001 };
    if (fault === 'bad-origin') d.source = { ...document.source, origin: 'https://key:secret@prod.ave-api.com' };
    if (fault === 'bad-key') d.validator = { ...document.validator, publicKey: 'secret-invalid' };
    if (fault === 'quality') d.quality = 'independently_verified';
    expect(() => validateReportedMarketApproval(d)).toThrow();
  });
});
describe('actual ledger readonly reported approval reader', () => {
  it('requires actual dedicated ledger and returns audited explicit reviewer verdict', async () => {
    const f = readerFixture(); const r = await f.reader.authorizeReportedMarketCap(f.request);
    expect(r).toMatchObject({ status: 'approved', approval: { conflictState: 'none_observed', quality: 'reported',
      sourceOrigin: f.document.source.origin, reviewer: f.document.reviewer, approvalDocumentFingerprint: f.ledger.source_fingerprint } });
    expect(f.query.mock.calls.every(([sql]) => !/INSERT|UPDATE|DELETE/.test(sql))).toBe(true);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it.each(['missing','duplicate','revoked','provider-scope','candle-scope','fingerprint','generation','approval-ref','future-import'])('defers %s ledger', async fault => {
    const f = readerFixture(); const row: Record<string, unknown> = { ...f.ledger };
    if (fault === 'revoked') row.revoked_at = 5999;
    if (fault === 'provider-scope') row.proof_scope = 'provider_contract';
    if (fault === 'candle-scope') row.proof_scope = 'validator_authority';
    if (fault === 'fingerprint') row.source_fingerprint = '0'.repeat(64);
    if (fault === 'generation') row.generation_id = 'other';
    if (fault === 'approval-ref') row.approval_ref = 'other';
    if (fault === 'future-import') row.imported_at = '7000';
    f.setRows(fault === 'missing' ? [] : fault === 'duplicate' ? [row,row] : [row]);
    expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'deferred' });
  });
  it.each(['unknown','conflict'])('never infers conflict-free from nonrevocation: %s', async verdict => {
    const f = readerFixture(); f.read.mockResolvedValue({ ...f.document, reviewer: { ...f.document.reviewer, conflictVerdict: verdict as 'unknown' | 'conflict' } });
    expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'deferred' }); expect(f.query).not.toHaveBeenCalled();
  });
  it.each(['authorizationRef','providerId','quoteAddress','mappingFingerprint','sampleId','executionFingerprint'])('defers request scope drift %s', async field => {
    const f = readerFixture(); expect(await f.reader.authorizeReportedMarketCap({ ...f.request, [field]: field === 'sampleId' ? '' : 'invalid' })).toMatchObject({ status: 'deferred' });
  });
  it('refuses actual cluster mismatch', async () => {
    const f = readerFixture(); f.identity.system_identifier = '999';
    expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'deferred' });
  });
  it('rechecks expiry after SQL and never leaks underlying failures', async () => {
    const f = readerFixture(); f.read.mockImplementation(async () => { if (f.read.mock.calls.length > 1) f.setAt(100000); return f.document; });
    expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'deferred' });
    f.read.mockRejectedValue(Error('postgresql://secret')); const r = await f.reader.authorizeReportedMarketCap(f.request);
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('refuses approval material drift after SQL', async () => {
    const f = readerFixture(); f.read.mockResolvedValueOnce(f.document).mockResolvedValueOnce({ ...f.document, approvalRef: 'changed' });
    expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'deferred' });
  });
  it('observes revocation on the next call, without cached approval', async () => {
    const f = readerFixture(); expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'approved' });
    f.setRows([{ ...f.ledger, revoked_at: 6000 }]); expect(await f.reader.authorizeReportedMarketCap(f.request)).toMatchObject({ status: 'deferred' });
  });
});
function migrationFixture() {
  const f = approvalFixture(), sql: string[] = []; let existing: Record<string, unknown>[] = [];
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    sql.push(text);
    if (text.includes('migration-runtime-identity')) return { rows: [{ database: f.document.target.database, username: 'migrator', session_username: 'migrator',
      server_address: '127.0.0.1', server_port: 5432, system_identifier: '123', role_safe: true, no_role_memberships: true, owns_target_schema: true,
      cannot_create_schema: true, cannot_create_temp: true, no_other_schema_authority: true, no_other_relation_authority: true, no_other_sequence_authority: true, no_callable_security_definers: true }], rowCount: 1 };
    if (text.includes('migration-runtime-ledger-kind')) return { rows: [{ identity_valid: true, ledger_valid: true }], rowCount: 1 };
    if (text.includes('migration-runtime-ledger */')) return { rows: [{ database_name: f.document.target.database, schema_name: f.document.target.schema,
      generation_id: 'generation', ledger_format: 1, version: 3, fingerprint: 'a'.repeat(64) }], rowCount: 1 };
    if (text.includes('reported-approval-import-existing')) return { rows: existing, rowCount: existing.length };
    if (text.includes('reported-approval-import */')) return { rows: [{ import_id: values![0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn(), end = vi.fn(async () => {}), connect = vi.fn(async () => ({ query, release }));
  const { generationId, ...target } = f.document.target;
  const migration: PostgresMigrationRuntimeOptions = { pool: { connect, end }, target: { ...target, generation: generationId, username: 'migrator', service: 'migrator' },
    capability: { mode: 'isolated', purpose: 'business_import', approvalRef: f.document.approvalRef, planSha256: reportedMarketApprovalFingerprint(f.document), expiresAtMs: 90000 },
    limits: { operationTimeoutMs: 5000, connectionTimeoutMs: 1000, statementTimeoutMs: 1000, lockTimeoutMs: 1000, maximumSqlStatements: 64, workMemKb: 1024, closeTimeoutMs: 1000 },
    clock: () => 6000, assertAuthorized: vi.fn(async () => {}) };
  return { ...f, query, sql, migration, connect, end, setExisting: (rows: Record<string, unknown>[]) => { existing = rows; } };
}
describe('controlled dedicated approval ledger importer over real migration runtime with isolated SQL doubles', () => {
  it('inserts only the dedicated ledger scope and commits after repeated authorization', async () => {
    const f = migrationFixture(); expect(await importReportedMarketApproval(f.document, f.migration)).toMatchObject({ status: 'imported', fingerprint: f.ledger.source_fingerprint });
    expect(f.sql.filter(s => /INSERT INTO/.test(s))).toHaveLength(1); expect(f.sql).toContain('COMMIT'); expect(f.end).toHaveBeenCalledOnce();
    expect(f.migration.assertAuthorized).toHaveBeenCalledTimes(2);
    const insert = f.query.mock.calls.find(([s]) => s.includes('reported-approval-import */'))!;
    expect(insert[1]).toContain(REPORTED_MARKET_APPROVAL_SCOPE);
  });
  it('accepts exact idempotent replay without resetting revocation or importedAt', async () => {
    const f = migrationFixture(); f.setExisting([f.ledger]); expect(await importReportedMarketApproval(f.document, f.migration)).toMatchObject({ status: 'existing' });
    expect(f.sql.some(s => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s))).toBe(false);
  });
  it.each(['revoked','wrong-scope','fingerprint'])('rolls back immutable %s collision', async fault => {
    const f = migrationFixture(); f.setExisting([{ ...f.ledger, ...(fault === 'revoked' ? { revoked_at: 5001 } : fault === 'wrong-scope' ? { proof_scope: 'provider_contract' } : { source_fingerprint: '0'.repeat(64) }) }]);
    await expect(importReportedMarketApproval(f.document, f.migration)).rejects.toThrow(); expect(f.sql).toContain('ROLLBACK'); expect(f.sql).not.toContain('COMMIT');
  });
  it('refuses mismatched capability before connecting', async () => {
    const f = migrationFixture(); await expect(importReportedMarketApproval(f.document, { ...f.migration, capability: { ...f.migration.capability, planSha256: '0'.repeat(64) } })).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('refuses commit when root authority changes at the final authorization', async () => {
    const f = migrationFixture(); vi.mocked(f.migration.assertAuthorized).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('changed-root-review'));
    await expect(importReportedMarketApproval(f.document, f.migration)).rejects.toThrow(); expect(f.sql).toContain('ROLLBACK'); expect(f.sql).not.toContain('COMMIT');
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withReportedMarketApprovalImportAudit } from '../import-postgres-reported-market-approval.js';
describe('reported approval native maintenance audit', () => {
  it('persists exact dedicated pins before work and refuses an existing intent', async () => {
    const dir = await mkdtemp(join(tmpdir(),'reported-approval-audit-'));
    const base = join(dir,'import'), intent = { operationId: 'operation', jobSha256: 'a'.repeat(64), approvalDocumentSha256: 'b'.repeat(64),
      approvalFingerprint: 'c'.repeat(64), credentialSha256: 'd'.repeat(64), mode: 'isolated' };
    try {
      const work = vi.fn(async () => { expect(JSON.parse(await readFile(base+'-intent.json','utf8'))).toMatchObject(intent); return { status: 'imported' }; });
      await withReportedMarketApprovalImportAudit(base,intent,work);
      expect(JSON.parse(await readFile(base+'-receipt.json','utf8'))).toMatchObject({ ...intent, result: { status: 'imported' } });
      await expect(withReportedMarketApprovalImportAudit(base,intent,work)).rejects.toThrow(); expect(work).toHaveBeenCalledOnce();
    } finally { await rm(dir,{ recursive: true }); }
  });
  it('records an uncertain failure without credentials or raw exception', async () => {
    const dir = await mkdtemp(join(tmpdir(),'reported-approval-audit-')), base = join(dir,'import');
    try {
      await expect(withReportedMarketApprovalImportAudit(base,{ operationId: 'operation', jobSha256: 'a'.repeat(64), approvalDocumentSha256: 'b'.repeat(64),
        approvalFingerprint: 'c'.repeat(64), credentialSha256: 'd'.repeat(64), mode: 'isolated' },async () => { throw Error('postgresql://secret'); })).rejects.toThrow('REPORTED_APPROVAL_IMPORT_REFUSED_OR_UNCERTAIN');
      expect(await readFile(base+'-failed.json','utf8')).not.toContain('secret');
    } finally { await rm(dir,{ recursive: true }); }
  });
  it('imports as a library without executing a CLI, and refuses missing CLI arguments', () => {
    const source = new URL('../import-postgres-reported-market-approval.ts',import.meta.url).pathname;
    const imported = spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`await import(${JSON.stringify(source)});console.log('library-only')`],{ encoding: 'utf8',timeout: 10000 });
    expect(imported.status,imported.stderr).toBe(0); expect(imported.stdout).toBe('library-only\n'); expect(imported.stderr).toBe('');
    const cli = spawnSync(process.execPath,['--import','tsx',source],{ encoding: 'utf8',timeout: 10000 });
    expect(cli.status).toBe(1); expect(cli.stderr).toBe('REPORTED_APPROVAL_IMPORT_REFUSED_OR_UNCERTAIN\n'); expect(cli.stdout).toBe('');
  });
});

import { revokeReportedMarketApproval, reportedMarketApprovalRevocationFingerprint } from '../postgres-reported-market-approval.js';
describe('controlled dedicated revocation shares the import/publication lock namespace', () => {
  it('requires separately pinned revocation capability and updates only the dedicated record under exclusive lock', async () => {
    const f = migrationFixture(), revocation = { approvalRef: 'operator-revocation', revokedAt: 6000 };
    const original = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql,values) => sql.includes('reported-approval-revoke-read') ? { rows: [f.ledger], rowCount: 1 }
      : sql.includes('reported-approval-revoke */') ? { rows: [{ import_id: f.document.importId }], rowCount: 1 } : original(sql,values));
    const migration = { ...f.migration, capability: { ...f.migration.capability, approvalRef: revocation.approvalRef,
      planSha256: reportedMarketApprovalRevocationFingerprint(f.document,revocation) } };
    expect(await revokeReportedMarketApproval(f.document,revocation,migration)).toMatchObject({ status: 'revoked' });
    const lock = f.query.mock.calls.find(([sql]) => sql.includes('pg_advisory_xact_lock('))!;
    expect(lock[1]).toEqual([JSON.stringify([REPORTED_MARKET_APPROVAL_SCOPE,f.document.importId])]);
  });
  it('cannot reuse the original import capability to authorize a revocation', async () => {
    const f = migrationFixture(); await expect(revokeReportedMarketApproval(f.document,{ approvalRef: 'revoke',revokedAt: 6000 },f.migration)).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
});
