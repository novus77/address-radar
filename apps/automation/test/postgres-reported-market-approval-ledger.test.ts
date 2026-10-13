import { describe, expect, it, vi } from 'vitest';
import { assertReportedMarketApprovalInTransaction } from '../src/postgres-reported-market-approval-ledger.js';
import { attachDedicatedReportedApproval, dedicatedReportedLedgerRow } from './reported-market-approval-fixture.js';
import { postgresServiceFactFingerprint } from '../src/postgres-service-fact-adapters.js';
function fixture() {
  const mapping = { chain: 'solana' as const, tokenAddress: '1'.repeat(31)+'2', poolAddress: '1'.repeat(31)+'3', tokenSide: 'base' as const,
    network: 'solana', evidenceRef: 'map', knownAt: 100 };
  const approval = attachDedicatedReportedApproval({ approvalRef: 'authorization', actorId: 'validator-actor', generationId: 'generation',
    validatorId: 'validator', keyId: 'key', providerId: 'ave', sourceApprovalRef: 'source-review', mappingApprovalRef: 'map-review',
    mappingFingerprint: postgresServiceFactFingerprint(mapping), quoteAddress: '1'.repeat(31)+'4', sourceProofKind: 'approved_reported_market_cap_v1',
    quality: 'reported', conflictState: 'none_observed', validFrom: 100, validUntil: 10000, revokedAt: null },mapping);
  const row: Record<string,unknown> = dedicatedReportedLedgerRow(approval), now = vi.fn(() => 1000);
  const query = vi.fn(async (sql: string,values?: readonly unknown[]) => ({ rows: sql.includes('reported-approval-transaction') ? [row] : [], rowCount: 1 }));
  const binding = { generationId: approval.generationId, providerId: approval.providerId, validatorId: approval.validatorId, keyId: approval.keyId,
    sourceApprovalRef: approval.sourceApprovalRef, mappingApprovalRef: approval.mappingApprovalRef, mapping, quoteAddress: approval.quoteAddress };
  return { approval,row,now,query,binding,check: () => assertReportedMarketApprovalInTransaction({ query },{ approval,binding,now }) };
}
describe('dedicated reported approval transaction fence', () => {
  it('locks shared before observing the actual ledger and does not require UPDATE or row-lock ACL', async () => {
    const f = fixture(); await f.check();
    expect(f.query.mock.calls[0]![0]).toContain('pg_advisory_xact_lock_shared');
    expect(f.query.mock.calls[1]![0]).toContain('reported-approval-transaction');
    expect(f.query.mock.calls.every(([sql]) => !/FOR SHARE|FOR UPDATE|^UPDATE|^INSERT/.test(sql))).toBe(true);
  });
  it.each(['revoked_at','source_fingerprint','proof_scope','approval_ref','identity_generation','schema_fingerprint','system_identifier','isolation'])('refuses actual %s drift', async key => {
    const f = fixture(); f.row[key] = key === 'revoked_at' ? 500 : 'changed'; await expect(f.check()).rejects.toThrow();
  });
  it.each(['approvalImportId','approvalDocumentFingerprint','sourceOrigin','conflictState','quoteAddress'])('refuses signed %s drift before SQL', async key => {
    const f = fixture(); Object.assign(f.approval,{ [key]: 'changed' }); await expect(f.check()).rejects.toThrow(); expect(f.query).not.toHaveBeenCalled();
  });
  it('rechecks actual time after lock/query wait, not just signature TTL or stale caller asOf', async () => {
    const f = fixture(); f.now.mockReturnValueOnce(1000).mockReturnValueOnce(10000); await expect(f.check()).rejects.toThrow();
  });
  it('fails closed if the approval document is stripped', async () => {
    const f = fixture(); const { approvalDocument: _document,...approval } = f.approval;
    await expect(assertReportedMarketApprovalInTransaction({ query: f.query },{ approval,binding: f.binding,now: f.now })).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
});
