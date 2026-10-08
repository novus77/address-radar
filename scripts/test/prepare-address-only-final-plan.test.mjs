import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateFinalCapture } from '../prepare-address-only-final-plan.mjs';
function fixture() {
  const seed = Buffer.from(JSON.stringify({ capturedAt: '2026-10-08T00:00:00.000Z',
    sourceDatabase: '/var/lib/address-radar/address-radar.db', tables: { wallet_identities: [{}], trader_entities: [{}] } }));
  const hash = createHash('sha256').update(seed).digest('hex');
  const base = '/var/lib/address-radar-maintenance-tools/final/';
  const job = { version: 1, seed: { path: base + 'seed.json', sha256: hash },
    receipt: { path: base + 'seed.json.receipt.json', sha256: 'a'.repeat(64) },
    cohort: { path: base + 'cohort.mjs', sha256: 'b'.repeat(64) }, outputDirectory: base + 'plan',
    review: { importId: 'final-addresses', approvalRef: 'approved', actorId: 'operator', actorAuthorizationRef: 'approved-scope',
      generationId: 'new', importedAt: Date.parse('2026-10-08T00:01:00.000Z'), seedSha256: hash } };
  const receipt = { status: 'fenced-address-only-seed-captured', sourceDatabase: '/var/lib/address-radar/address-radar.db',
    capturedAt: '2026-10-08T00:00:00.000Z', seedSha256: hash, wallets: 1, entities: 1,
    beforeBoundarySha256: 'c'.repeat(64), afterBoundarySha256: 'd'.repeat(64),
    sourceWrites: false, databaseImported: false, activationAuthorized: false, gatewayDeliveryEnabled: false };
  return { job, seed, receipt };
}
test('accepts final capture without hardcoded historical counts or timestamp', () => {
  const { job, seed, receipt } = fixture();
  assert.equal(validateFinalCapture(job, seed, receipt).tables.wallet_identities.length, 1);
});
for (const key of ['sourceWrites', 'databaseImported', 'activationAuthorized', 'gatewayDeliveryEnabled']) {
  test(`refuses ${key}`, () => { const x = fixture(); x.receipt[key] = true;
    assert.throws(() => validateFinalCapture(x.job, x.seed, x.receipt)); });
}
for (const key of ['beforeBoundarySha256', 'afterBoundarySha256', 'seedSha256']) {
  test(`requires ${key}`, () => { const x = fixture(); delete x.receipt[key];
    assert.throws(() => validateFinalCapture(x.job, x.seed, x.receipt)); });
}
test('refuses stale review, modified seed, count mismatch and unprotected path', () => {
  const changes = [x => { x.job.review.importedAt = 0; }, x => { x.seed = Buffer.from('{}'); },
    x => { x.receipt.wallets = 2; }, x => { x.job.seed.path = '/tmp/seed.json'; }];
  for (const change of changes) { const x = fixture(); change(x);
    assert.throws(() => validateFinalCapture(x.job, x.seed, x.receipt)); }
});
test('refuses missing final fence status and mismatched capture clock', () => {
  for (const change of [x => { x.receipt.status = 'rehearsal'; }, x => { x.receipt.capturedAt = '2026-10-07T00:00:00Z'; }]) {
    const x = fixture(); change(x); assert.throws(() => validateFinalCapture(x.job, x.seed, x.receipt));
  }
});
