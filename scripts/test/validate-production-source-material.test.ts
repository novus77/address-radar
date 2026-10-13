import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';
import { createSourceReplacementPlan, type SourceReplacementInput } from '../prepare-address-only-source-replacement.js';
import { main, validateProductionSourceMaterial, type ProductionSourceMaterialValidationInput } from '../validate-production-source-material.js';

const hash = 'a'.repeat(64);
const refusal = 'PRODUCTION_SOURCE_MATERIAL_REFUSED';
function fixture(): ProductionSourceMaterialValidationInput {
  const at = Date.now();
  const review = { version: 1 as const, importId: 'publicnode-contract', approvalRef: 'approved-source-replacement',
    generationId: 'production-20261006-v1', importedAt: at, contractRef: 'publicnode-rpc-terms',
    budgets: [{ providerId: 'solana-publicnode-source', origin: 'https://solana-rpc.publicnode.com',
      windowStartedAt: at, windowMs: 60000, maximumRequests: 60, requestsUsed: 0, maximumConcurrency: 1, cooldownUntil: '0' }] };
  const input: SourceReplacementInput = {
    oldProviderId: 'solana-helius-source', oldOrigin: 'https://helius.example', oldOperator: 'Helius', newOperator: 'Allnodes/PublicNode',
    review, trustedReviewSha256: createHash('sha256').update(migrationCutoverCanonicalJson(review)).digest('hex'),
    material: {
      authority: { generationId: review.generationId, releaseSha256: hash, username: 'publisher',
        credential: { path: '/private/credential', sha256: hash }, privateKey: { path: '/private/key', sha256: hash },
        validator: { validationTtlMs: 60000, reviewedProviderBindings: [{ chain: 'solana',
          sourceProviderId: 'solana-helius-source', sourceEndpoint: 'https://helius.example/private',
          replayProviderId: 'solana-official-replay', replayEndpoint: 'https://api.mainnet-beta.solana.com', expectedGenesisHash: 'mainnet-genesis' }] },
        publisher: { maximumValidationAgeMs: 60000 } },
      deployment: { generationId: review.generationId, releaseRoot: '/opt/address-radar/releases/address-only-origin',
        cutover: { addressOnly: { releaseSha256: hash, generationId: review.generationId, operationId: 'original-operation' } },
        gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
        walletExecution: { solana: { providerId: 'solana-helius-source', endpoint: 'https://helius.example/private', maximumRunMs: 5000 },
          receiver: { maximumRunMs: 5000 } }, executionRetry: { maximumCaptures: 1, maximumRunMs: 5000 } },
      settings: { protocol: 'address-only-configured-preflight-settings-v1', validators: [],
        credential: { path: '/private/operator', sha256: hash }, providerContracts: [{ providerId: 'solana-helius-source',
          origin: 'https://helius.example', importId: 'helius-contract', sourceFingerprint: hash,
          windowMs: 60000, maximumRequests: 60, maximumConcurrency: 1 }] },
      environment: { RADAR_RPC_SOLANA_HTTP_URL: 'https://helius.example/private',
        ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: 'false', ADDRESS_RADAR_FOMO_BROWSER_ENABLED: 'false',
        ADDRESS_RADAR_FOMO_CAPTURE_ENABLED: 'false', ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED: 'false',
        ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: hash, ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: hash,
        ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: hash } },
  };
  const plan = createSourceReplacementPlan(input);
  const releaseRoot = '/opt/address-radar/releases/address-only-20261013-final';
  const releaseSha256 = '83fed25a2cd61f4d950f1b55d755e0990a34e4d8c7200bcc85fbff649803835e';
  const entrySha256 = 'b'.repeat(64);
  const finalPins = { authority: { path: '/var/lib/address-radar-maintenance-tools/final/authority.json', sha256: 'c'.repeat(64) },
    deployment: { path: '/var/lib/address-radar-maintenance-tools/final/deployment.json', sha256: 'd'.repeat(64) },
    settings: { path: '/var/lib/address-radar-maintenance-tools/final/settings.json', sha256: 'e'.repeat(64) } };
  const finalMaterial = structuredClone(plan.material);
  finalMaterial.authority.releaseSha256 = releaseSha256;
  finalMaterial.deployment.releaseRoot = releaseRoot;
  finalMaterial.deployment.cutover = { addressOnly: { releaseSha256, generationId: review.generationId, operationId: 'original-operation' } };
  Object.assign(finalMaterial.environment, { ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: releaseSha256,
    ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: entrySha256,
    ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE: finalPins.authority.path, ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256: finalPins.authority.sha256,
    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE: finalPins.deployment.path, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: finalPins.deployment.sha256,
    ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE: finalPins.settings.path, ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256: finalPins.settings.sha256 });
  return { input, replacementSha256: plan.replacementSha256, approvalRef: review.approvalRef,
    generationId: review.generationId, releaseRoot, releaseSha256, entrySha256, finalMaterial, finalPins };
}
function change(value: unknown, path: string, next: unknown) {
  const keys = path.split('.');
  let target = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys[keys.length - 1]!] = next;
}
async function* bytes(value: unknown) { yield Buffer.from(JSON.stringify(value)); }

describe('trusted production source material validation', () => {
  it('recomputes the source plan and returns only the bound public summary without mutation', () => {
    const value = fixture(), before = structuredClone(value);
    expect(validateProductionSourceMaterial(value)).toEqual({ replacementSha256: createSourceReplacementPlan(value.input).replacementSha256,
      approvalRef: value.approvalRef, generationId: value.generationId, oldProviderId: value.input.oldProviderId,
      oldOrigin: value.input.oldOrigin, newProviderId: 'solana-publicnode-source', newOrigin: 'https://solana-rpc.publicnode.com' });
    expect(value).toEqual(before);
    expect(JSON.stringify(validateProductionSourceMaterial(value))).not.toMatch(/credential|privateKey|releaseRoot|material/);
  });
  it.each(['replacementSha256', 'releaseSha256', 'entrySha256'] as const)('rejects malformed %s', key => {
    const value = { ...fixture(), [key]: 'not-a-hash' };
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it.each(['replacementSha256', 'approvalRef', 'generationId'] as const)('rejects mismatched %s', key => {
    const value = { ...fixture(), [key]: key === 'replacementSha256' ? 'f'.repeat(64) : 'different' };
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it('revalidates the review pin through the real source plan', () => {
    const original = fixture();
    const value = { ...original, input: { ...original.input, trustedReviewSha256: 'f'.repeat(64) } };
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it.each(['authority', 'deployment', 'settings'] as const)('rejects malformed %s pins', key => {
    for (const pin of [{ path: '/private/tmp/../bad', sha256: hash }, { path: 'relative', sha256: hash },
      { path: '/private//bad', sha256: hash }, { path: '/private/bad', sha256: 'bad' },
      { path: '/private/bad', sha256: hash, extra: true }]) {
      const original = fixture();
      const value = { ...original, finalPins: { ...original.finalPins, [key]: pin } };
      expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
    }
  });
  it.each(['authority', 'deployment', 'settings'] as const)('requires actual %s pin equality with final environment', key => {
    const original = fixture();
    const value = { ...original, finalPins: { ...original.finalPins,
      [key]: { ...original.finalPins[key], sha256: 'f'.repeat(64) } } };
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it.each([
    ['authority.releaseSha256', hash], ['deployment.releaseRoot', '/opt/address-radar/releases/other'],
    ['deployment.cutover.addressOnly.releaseSha256', hash], ['deployment.cutover.addressOnly.operationId', 'new-operation'],
    ['deployment.generationId', 'other'], ['authority.generationId', 'other'],
    ['environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256', hash], ['environment.ADDRESS_RADAR_POSTGRES_ENTRY_SHA256', hash],
    ['environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE', '/private/other'],
    ['environment.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE', '/private/other'],
    ['environment.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE', '/private/other'],
    ['environment.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256', hash],
    ['environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256', hash],
    ['environment.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256', hash],
    ['authority.credential', { path: '/private/rebound', sha256: hash }],
    ['authority.privateKey', { path: '/private/rebound', sha256: hash }],
    ['authority.validator.validationTtlMs', 60001], ['authority.publisher.maximumValidationAgeMs', 60001],
    ['authority.validator.reviewedProviderBindings.0.replayProviderId', 'arbitrary'],
    ['authority.validator.reviewedProviderBindings.0.replayEndpoint', 'https://unapproved.example'],
    ['authority.validator.reviewedProviderBindings.0.sourceEndpoint', 'https://unapproved.example'],
    ['deployment.executionRetry.maximumCaptures', 2], ['deployment.walletExecution.receiver.maximumRunMs', 6000],
    ['settings.credential', { path: '/private/rebound', sha256: hash }],
    ['settings.providerContracts.0.maximumRequests', 61], ['settings.providerContracts.0.maximumConcurrency', 2],
    ['settings.providerContracts.0.windowMs', 60001], ['settings.providerContracts.0.sourceFingerprint', hash],
    ['environment.RADAR_RPC_SOLANA_HTTP_URL', 'https://unapproved.example'],
    ['deployment.gatewayDeliveryEnabled', true], ['deployment.fomoEnabled', true], ['deployment.fullHistoricalMiningEnabled', true],
    ['environment.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'true'], ['environment.ADDRESS_RADAR_FOMO_BROWSER_ENABLED', 'true'],
    ['environment.ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'true'], ['environment.ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED', 'true'],
    ['deployment.priceAcquisition', {}], ['settings.extra', true], ['environment.UNAPPROVED', 'value'],
  ] as const)('rejects unapproved final material difference at %s', (path, next) => {
    const value = fixture(); change(value.finalMaterial, path, next);
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it.each(['gatewayDeliveryEnabled', 'fomoEnabled', 'fullHistoricalMiningEnabled'])('retains original source-plan safety check for %s', flag => {
    const value = fixture(); change(value.input.material.deployment, flag, true);
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it('rejects missing or extra final material fields', () => {
    const missing = fixture(); delete missing.finalMaterial.environment.ADDRESS_RADAR_POSTGRES_ENTRY_SHA256;
    expect(() => validateProductionSourceMaterial(missing)).toThrow(refusal);
    const extra = fixture(); Object.assign(extra.finalMaterial, { extra: {} });
    expect(() => validateProductionSourceMaterial(extra)).toThrow(refusal);
  });
  it('rejects malformed envelopes and missing cutover instead of inventing a manifest', () => {
    for (const malformed of [null, [], {}, { ...fixture(), extra: true }]) {
      expect(() => validateProductionSourceMaterial(malformed as ProductionSourceMaterialValidationInput)).toThrow(refusal);
    }
    const original = fixture();
    const deployment = { ...original.input.material.deployment };
    delete deployment.cutover;
    const input = { ...original.input, material: { ...original.input.material, deployment } };
    const value = { ...original, input, replacementSha256: createSourceReplacementPlan(input).replacementSha256 };
    expect(() => validateProductionSourceMaterial(value)).toThrow(refusal);
  });
  it('rejects noncanonical release roots', () => {
    for (const releaseRoot of ['relative', '/opt/releases/../bad', '/opt//bad', '/opt/bad\n']) {
      expect(() => validateProductionSourceMaterial({ ...fixture(), releaseRoot })).toThrow(refusal);
    }
  });
  it('normalizes even private-bearing source-plan failures to a closed error', () => {
    const value = fixture();
    Object.defineProperty(value.input, 'review', { get() { throw Error('private-fixture-value'); } });
    expect(() => validateProductionSourceMaterial(value)).toThrow(new Error(refusal));
  });
});

describe('bounded validation CLI input', () => {
  it('accepts --validate with chunked stdin JSON', async () => {
    const value = fixture(), raw = Buffer.from(JSON.stringify(value));
    async function* input() { yield raw.subarray(0, 17); yield raw.subarray(17); }
    await expect(main(['--validate'], input())).resolves.toEqual(validateProductionSourceMaterial(value));
  });
  it.each([{ args: [] }, { args: ['--execute'] }, { args: ['--validate', 'extra'] }])('rejects arguments $args', async ({ args }) => {
    await expect(main(args, bytes(fixture()))).rejects.toThrow(refusal);
  });
  it('rejects empty, malformed and invalid UTF-8 input with closed errors', async () => {
    for (const raw of [Buffer.alloc(0), Buffer.from('{private-fixture'), Buffer.from([0xff])]) {
      async function* input() { yield raw; }
      await expect(main(['--validate'], input())).rejects.toThrow(new Error(refusal));
    }
  });
  it('accepts exactly 2 MiB and refuses the first byte beyond the bound', async () => {
    const value = fixture(), raw = Buffer.from(JSON.stringify(value)), limit = 2 * 1024 * 1024;
    async function* exact() { yield raw; yield Buffer.alloc(limit - raw.length, 0x20); }
    await expect(main(['--validate'], exact())).resolves.toEqual(validateProductionSourceMaterial(value));
    let resumed = false;
    async function* oversized() { yield Buffer.alloc(limit); yield Buffer.from('x'); resumed = true; throw Error('must-not-resume'); }
    await expect(main(['--validate'], oversized())).rejects.toThrow(refusal);
    expect(resumed).toBe(false);
  });
  it('closes input stream errors without exposing messages', async () => {
    async function* input(): AsyncGenerator<Uint8Array> { throw Error('private-stream-value'); }
    await expect(main(['--validate'], input())).rejects.toThrow(new Error(refusal));
  });
});
