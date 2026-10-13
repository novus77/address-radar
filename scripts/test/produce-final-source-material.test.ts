import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';
import { createSourceReplacementPlan } from '../prepare-address-only-source-replacement.js';
import { runtimeAuthorityFingerprint } from '../provision-address-only-runtime-authority.js';
import { generateFinalSourceMaterial } from '../produce-final-source-material.js';

const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const pin = (name: string) => ({ path: '/var/lib/address-radar-maintenance-tools/' + name, sha256: sha(name) });
function fixture() {
  const now = Date.now(), generationId = 'production-20261006-v1', operationId = 'fixture-original';
  const review = { version: 1 as const, importId: 'fixture-contract', approvalRef: 'fixture-only-approval',
    generationId, importedAt: now - 1000, contractRef: 'fixture-only-contract', budgets: [{
      providerId: 'solana-publicnode-source', origin: 'https://solana-rpc.publicnode.com',
      windowStartedAt: now - 1000, windowMs: 60000, maximumRequests: 60, requestsUsed: 0,
      maximumConcurrency: 1, cooldownUntil: '0' }] };
  const manifest = { protocol: 'address-only-v1', operationId, generationId, importId: 'fixture-cohort',
    planSha256: sha('original-plan'), gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
    releaseSha256: sha('old-release'), target: {
    database: 'address_radar', schema: 'address_radar_business', systemIdentifier: '7693392208475083526' } };
  const currentManifest = { ...manifest, releaseSha256: sha('configured-current-release') };
  const trustedKey = { validatorId: 'fixture-validator', keyId: 'fixture-key', publicKey: 'fixture-public-key',
    actorId: 'fixture-actor', authorizationRef: 'fixture-validator-approval', reviewedSourceProviders: ['solana-official-replay'] };
  const configuration = { ...trustedKey, kind: 'execution', importId: 'fixture-validator-import',
    evidenceSha256: sha('fixture-evidence'), importedAt: now-1000, validFrom: now-1000, validUntil: now+120000 };
  const runtimeAuthority = { approvalRef: 'existing-validator-import-approval', target: {
    ...manifest.target, generationId }, validators: [configuration] };
  const fingerprint = runtimeAuthorityFingerprint({ approvalRef: runtimeAuthority.approvalRef,
    proofScope: 'validator_authority', configuration });
  const material = { authority: { generationId, releaseSha256: currentManifest.releaseSha256,
    credential: pin('credential'), privateKey: pin('key'), validator: { validatorId: trustedKey.validatorId,
      keyId: trustedKey.keyId, publicKey: trustedKey.publicKey, validationTtlMs: 60000,
      reviewedProviderBindings: [{ chain: 'solana', sourceProviderId: 'solana-helius-source',
        sourceEndpoint: 'https://helius.example/private', replayProviderId: 'solana-official-replay',
        replayEndpoint: 'https://api.mainnet-beta.solana.com' }] },
    publisher: { maximumValidationAgeMs: 60000, validators: [trustedKey] } },
    deployment: { operationId, generationId, releaseRoot: '/opt/address-radar/releases/address-only-origin',
      cutover: { addressOnly: currentManifest }, gatewayDeliveryEnabled: false, fomoEnabled: false,
      fullHistoricalMiningEnabled: false, walletExecution: { solana: { providerId: 'solana-helius-source',
        endpoint: 'https://helius.example/private', maximumRunMs: 5000 }, receiver: { maximumRunMs: 5000 } },
      executionRetry: { maximumCaptures: 1, maximumRunMs: 5000 } },
    settings: { credential: pin('operator'), validators: [{ kind: 'execution', validatorId: trustedKey.validatorId,
      importId: configuration.importId, sourceFingerprint: fingerprint }], providerContracts: [{ providerId: 'solana-helius-source',
      origin: 'https://helius.example', importId: 'old-contract', sourceFingerprint: sha('old-contract'),
      windowMs: 60000, maximumRequests: 60, maximumConcurrency: 1 }] },
    environment: { RADAR_RPC_SOLANA_HTTP_URL: 'https://helius.example/private',
      ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: manifest.releaseSha256,
      ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: sha('old-entry') } };
  const input = { oldProviderId: 'solana-helius-source', oldOrigin: 'https://helius.example',
    oldOperator: 'Helius', newOperator: 'Allnodes/PublicNode', review,
    trustedReviewSha256: sha(migrationCutoverCanonicalJson(review)), material };
  const plan = createSourceReplacementPlan(input);
  const node = pin('node');
  const walletServiceUser = { user: 'fixture_wallet', group: 'fixture_wallet', uid: 1002, gid: 1002 };
  const originPins = { oldState: pin('state'), originalManifest: pin('manifest'), configuredOrigin: {
    journal: pin('configured-state'), receipt: pin('configured-receipt'), releaseRoot: material.deployment.releaseRoot, node } };
  const binding = { target: manifest.target, operationId, generationId, importId: manifest.importId, planSha256: manifest.planSha256 };
  const configuredManifestSha256 = sha(JSON.stringify(currentManifest));
  const receipt = { protocol: 'address-only-configured-transition-receipt-v1', operationId, generationId,
    importId: manifest.importId, transitionId: 'fixture-current', releaseSha256: currentManifest.releaseSha256,
    newManifestSha256: configuredManifestSha256, sourceMonitoring: 'configured_pending_observation',
    databaseImported: true, newImportPerformed: false, businessReleaseSwitched: true, monitoringCompleted: false,
    businessEligibilityGranted: false, gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false };
  return { input, review, runtimeAuthority, currentMaterial: structuredClone(material), originPins, node, walletServiceUser,
    outputDirectory: '/var/lib/address-radar-maintenance-tools/final-source-materials-fixture',
    nowMs: now, manifestSha256: sha(JSON.stringify(manifest)), configuredManifestSha256, transitionId: 'fixture-next',
    origin: { manifest, configuredReceipt: receipt, configuredState: { phase: 'COMPLETE', pending: null, operationId,
      receipt, transitionId: receipt.transitionId, release: { releaseSha256: receipt.releaseSha256 },
      newManifestSha256: configuredManifestSha256, node, walletServiceUser, measurement: { binding } },
      waitingState: { phase: 'COMPLETE', pending: null, operationId, receipt: { sourceMonitoring: 'waiting_configuration' },
        manifestSha256: sha(JSON.stringify(manifest)), measurement: { binding } } },
    evidence: { protocol: 'address-only-final-source-material-approval-v1', purpose: 'source_material_preparation',
      approvalRef: review.approvalRef, generationId, trustedReviewSha256: input.trustedReviewSha256,
      replacementSha256: plan.replacementSha256, validFrom: now - 1000, validUntil: now + 60000, revoked: false },
    stage: { protocol: 'address-only-code-stage-receipt-v1', status: 'CODE_STAGED_ONLY', stageOnly: true,
      authorizationRef: review.approvalRef, transitionId: 'fixture-next',
      release: { root: '/opt/address-radar/releases/address-only-final', releaseSha256: sha('final-release'),
        entryPin: { path: '/opt/address-radar/releases/address-only-final/scripts/postgres-service-entry.mjs', sha256: sha('entry') } },
      nativeNode: { pin: node }, permanentPins: { oldState: originPins.oldState, originalManifest: originPins.originalManifest } } };
}
function mutate(value: unknown, path: string, next: unknown) {
  const keys = path.split('.'); let object = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) object = object[key] as Record<string, unknown>;
  object[keys.at(-1)!] = next;
}

describe('final source material producer', () => {
  it('renders actual bytes, uses their hashes and preserves original authority fields without mutation', () => {
    const value = fixture(), before = structuredClone(value), output = generateFinalSourceMaterial(value);
    expect(value).toEqual(before);
    expect(Object.keys(output.files).sort()).toEqual(['authority.json', 'deployment.json', 'environment.json', 'settings.json']);
    for (const file of Object.values(output.files)) expect(sha(file.raw)).toBe(file.sha256);
    const authority = JSON.parse(output.files['authority.json']!.raw);
    expect(authority.credential).toEqual(value.input.material.authority.credential);
    expect(authority.privateKey).toEqual(value.input.material.authority.privateKey);
    expect(authority.publisher).toEqual(value.input.material.authority.publisher);
    expect(authority.validator.validationTtlMs).toBe(60000);
    const env = JSON.parse(output.files['environment.json']!.raw);
    expect(env.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256).toBe(output.files['authority.json']!.sha256);
    expect(env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256).toBe(output.files['deployment.json']!.sha256);
    expect(env.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256).toBe(output.files['settings.json']!.sha256);
    expect(output.summary.approvalRef).toBe(value.review.approvalRef);
    expect(JSON.stringify(output.summary)).not.toMatch(/privateKey|credential|deadline/);
  });
  it.each([
    ['evidence.revoked', true], ['evidence.validUntil', 0], ['evidence.validFrom', Number.MAX_SAFE_INTEGER],
    ['evidence.approvalRef', 'other'], ['evidence.replacementSha256', sha('other')],
    ['review.approvalRef', 'other'], ['input.review.importedAt', 0],
    ['currentMaterial.authority.privateKey', pin('different')],
    ['runtimeAuthority.validators.0.validUntil', 0], ['runtimeAuthority.validators.0.keyId', 'other'],
    ['runtimeAuthority.target.systemIdentifier', '123'], ['currentMaterial.settings.validators.0.sourceFingerprint', sha('other')],
    ['stage.authorizationRef', 'other'], ['stage.transitionId', 'other'],
    ['stage.nativeNode.pin', pin('other-node')], ['stage.permanentPins.oldState', pin('other-state')],
    ['origin.configuredState.phase', 'BLOCKED'], ['origin.configuredReceipt.releaseSha256', sha('other')],
    ['origin.manifest.target.systemIdentifier', '123'], ['outputDirectory', '/tmp/final-materials'],
  ])('refuses invalid or missing binding at %s', (path, next) => {
    const value = fixture(); mutate(value, path as string, next);
    expect(() => generateFinalSourceMaterial(value)).toThrow('FINAL_SOURCE_MATERIAL_REFUSED');
  });
  it('accepts distinct waiting, configured and staged releases with three distinct stage identifiers', () => {
    const value = fixture();
    expect(new Set([value.origin.manifest.releaseSha256, value.origin.configuredReceipt.releaseSha256,
      value.stage.release.releaseSha256]).size).toBe(3);
    expect(new Set([value.stage.authorizationRef, value.stage.transitionId, value.origin.manifest.operationId]).size).toBe(3);
    expect(value.origin.configuredReceipt.transitionId).not.toBe(value.stage.transitionId);
    const result = generateFinalSourceMaterial(value);
    const deployment = JSON.parse(result.files['deployment.json']!.raw);
    expect(deployment.cutover.addressOnly.operationId).toBe(value.origin.manifest.operationId);
    expect(deployment.cutover.addressOnly.releaseSha256).toBe(value.stage.release.releaseSha256);
    const keys = JSON.parse(result.files['authority.json']!.raw).publisher.validators;
    expect(keys).toEqual(value.input.material.authority.publisher.validators);
    expect(keys[0]).not.toHaveProperty('importedAt');
    expect(keys[0]).not.toHaveProperty('validFrom');
    expect(keys[0]).not.toHaveProperty('validUntil');
  });
  it.each([undefined, 'invalid', 'A'.repeat(64), 'a'.repeat(63)])(
    'refuses invalid independent evidence SHA even with synchronized fingerprints (%s)', evidenceSha256 => {
      const value = fixture();
      const configuration: Record<string, unknown> = value.runtimeAuthority.validators[0]!;
      if (evidenceSha256 === undefined) delete configuration.evidenceSha256;
      else configuration.evidenceSha256 = evidenceSha256;
      value.input.material.settings.validators[0]!.sourceFingerprint = runtimeAuthorityFingerprint({
        approvalRef: value.runtimeAuthority.approvalRef, proofScope: 'validator_authority', configuration });
      value.currentMaterial = structuredClone(value.input.material);
      value.evidence.replacementSha256 = createSourceReplacementPlan(value.input).replacementSha256;
      expect(() => generateFinalSourceMaterial(value)).toThrow('FINAL_SOURCE_MATERIAL_REFUSED');
    });
  it('refuses a changed independent import fingerprint even when current files match the input', () => {
    const value = fixture();
    value.input.material.settings.validators[0]!.sourceFingerprint = sha('wrong-import');
    value.currentMaterial = structuredClone(value.input.material);
    const plan = createSourceReplacementPlan(value.input);
    value.evidence.replacementSha256 = plan.replacementSha256;
    expect(() => generateFinalSourceMaterial(value)).toThrow('FINAL_SOURCE_MATERIAL_REFUSED');
  });
  it('refuses missing preparation approval rather than generating it', () => {
    const value = { ...fixture(), evidence: undefined };
    expect(() => generateFinalSourceMaterial(value)).toThrow('FINAL_SOURCE_MATERIAL_REFUSED');
  });
  it('refuses an otherwise matching but stale source review', () => {
    const value = fixture(); value.nowMs += 86400001;
    value.evidence.validUntil = value.nowMs + 60000;
    value.currentMaterial = structuredClone(value.input.material);
    expect(() => generateFinalSourceMaterial(value)).toThrow('FINAL_SOURCE_MATERIAL_REFUSED');
  });
});
