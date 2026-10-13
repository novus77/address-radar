import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { composePostgresServicePriceDependencies, createPostgresNativePriceAuthorityDependencies, createPostgresNativeReportedMarketCapAuthorityDependencies, type PostgresNativePriceAuthorityInput } from '../postgres-price-authority.js';
import { createPostgresIndependentPriceValidator, createPostgresReportedMarketCapValidator } from '../../apps/automation/src/postgres-independent-price-validator.js';
import { createPostgresPriceFactPublisher } from '../../apps/automation/src/postgres-price-fact-publisher.js';

vi.mock('../../apps/automation/src/postgres-independent-price-validator.js', () => ({ createPostgresIndependentPriceValidator: vi.fn(), createPostgresReportedMarketCapValidator: vi.fn() }));
vi.mock('../../apps/automation/src/postgres-price-fact-publisher.js', () => ({ createPostgresPriceFactPublisher: vi.fn() }));

// Assembly fixtures only. Mock factory output is not native identity or independent proof evidence.
const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
function fixture(): PostgresNativePriceAuthorityInput {
  const pin = { providerId: 'fixture-source', mapping: { chain: 'solana', tokenAddress: 'fixture-token', poolAddress: 'fixture-pool',
    tokenSide: 'base', network: 'solana', evidenceRef: 'fixture-map', knownAt: 100 },
    mappingApprovalRef: 'fixture-map-approval', sourceApprovalRef: 'fixture-source-approval', sourceProofKind: 'fixture-replay',
    candleMs: 60000, validFrom: 100, validUntil: 100000 };
  // Unused constructor fields are deliberately absent: these tests verify assembly, not the native factories.
  return { deployment: { generationId: 'fixture-generation', activatedAt: 100, priceAcquisition: {
    source: { providerId: pin.providerId, baseUrl: 'https://source.invalid/api/v2', timeframe: 'minute', aggregate: 1 }, mappings: [pin] } },
    validator: { generationId: 'fixture-generation', activatedAt: 100, validatorId: 'fixture-validator', keyId: 'fixture-key',
      actorId: 'fixture-actor', authorizationRef: 'fixture-authorization', publicKey,
      approval: { authorizePriceReplay: vi.fn() }, reviewedBindings: [{
      sourceProviderId: pin.providerId, sourceBaseUrl: 'https://source.invalid/api/v2', replayProviderId: 'fixture-replay',
      replayBaseUrl: 'https://replay.invalid/api/v2', timeframe: 'minute', aggregate: 1, ...pin }] },
    publisher: { target: { generationId: 'fixture-generation' }, mappings: [structuredClone(pin)], validators: [{
      validatorId: 'fixture-validator', keyId: 'fixture-key', actorId: 'fixture-actor', authorizationRef: 'fixture-authorization',
      publicKey, reviewedSourceProviders: ['fixture-replay'] }] },
    signal: new AbortController().signal } as unknown as PostgresNativePriceAuthorityInput;
}
const reader = { validatePrice: vi.fn() };
const writer = { publish: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createPostgresIndependentPriceValidator).mockReturnValue(reader);
  vi.mocked(createPostgresReportedMarketCapValidator).mockReturnValue(reader);
  vi.mocked(createPostgresPriceFactPublisher).mockResolvedValue(writer);
});
describe('native price dependency assembly', () => {
  it('composes native ports for scanner using the actual dependency factory', async () => {
    const input = fixture(), { deployment, signal, ...nativePriceAuthority } = input;
    const result = await composePostgresServicePriceDependencies({ service: 'scanner', deployment, signal, dependencies: { nativePriceAuthority } });
    expect(result.priceAuthority).toEqual({ validator: reader, publisher: writer });
    expect(createPostgresPriceFactPublisher).toHaveBeenCalledOnce();
  });
  it.each(['unconfigured', 'other-service'] as const)('preserves dependencies and performs no native probe: %s', async mode => {
    const input = fixture(), { deployment, signal, ...nativePriceAuthority } = input, dependencies = { nativePriceAuthority };
    expect(await composePostgresServicePriceDependencies({ service: mode === 'other-service' ? 'automation' : 'scanner',
      deployment: mode === 'unconfigured' ? { generationId: deployment.generationId, activatedAt: deployment.activatedAt } : deployment,
      signal, dependencies })).toBe(dependencies);
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it('refuses missing native approval before probing instead of returning partial authority', async () => {
    const input = fixture(), { deployment, signal, ...nativePriceAuthority } = input;
    const { approval: _approval, ...validator } = nativePriceAuthority.validator!;
    await expect(composePostgresServicePriceDependencies({ service: 'scanner', deployment, signal,
      dependencies: { nativePriceAuthority: { ...nativePriceAuthority, validator } } })).rejects.toThrow('INDEPENDENT_PRICE_VALIDATOR_CLI_PORT_REQUIRED');
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it('refuses ambiguous preconstructed and native authority without probing', async () => {
    const input = fixture(), { deployment, signal, ...nativePriceAuthority } = input;
    await expect(composePostgresServicePriceDependencies({ service: 'scanner', deployment, signal,
      dependencies: { nativePriceAuthority, priceAuthority: { validator: reader, publisher: writer } } })).rejects.toThrow('PRICE_AUTHORITY_DEPENDENCY_CONFLICT');
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it.each(['missing', 'duplicate', 'validatorId', 'keyId', 'publicKey', 'malformedKey', 'actorId', 'authorizationRef', 'replay'] as const)
    ('refuses publisher validator pin drift: %s without constructing either factory', async field => {
      const input = fixture(), pin = input.publisher!.validators[0]!;
      const validators = field === 'missing' ? [] : field === 'duplicate' ? [pin, pin]
        : [{ ...pin, ...(field === 'replay' ? { reviewedSourceProviders: [] }
          : field === 'publicKey' ? { publicKey: otherPublicKey }
          : field === 'malformedKey' ? { publicKey: 'SECRET_INVALID_KEY' } : { [field]: 'other' }) }];
      expect(await createPostgresNativePriceAuthorityDependencies({ ...input, publisher: { ...input.publisher!, validators } }))
        .toEqual({ status: 'deferred', reasonCode: 'price_authority_configuration_mismatch' });
      expect(createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
      expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
    });
  it('requires coverage of every replay provider, not just the first binding', async () => {
    const input = fixture(), first = input.validator!.reviewedBindings[0]!;
    const validator = { ...input.validator!, reviewedBindings: [first, { ...first, replayProviderId: 'fixture-second-replay' }] };
    expect(await createPostgresNativePriceAuthorityDependencies({ ...input, validator }))
      .toEqual({ status: 'deferred', reasonCode: 'price_authority_configuration_mismatch' });
    expect(createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it('accepts equivalent PEM encodings of the same SPKI key', async () => {
    const input = fixture(), pin = input.publisher!.validators[0]!;
    const publisher = { ...input.publisher!, validators: [{ ...pin, publicKey: publicKey.replace(/\n/g, '\r\n') }] };
    expect((await createPostgresNativePriceAuthorityDependencies({ ...input, publisher })).status).toBe('available');
  });
  it('keeps absent price configuration disabled without invoking factories', async () => {
    const input = fixture();
    expect(await createPostgresNativePriceAuthorityDependencies({ ...input, deployment: { generationId: 'fixture-generation', activatedAt: 100 } }))
      .toEqual({ status: 'deferred', reasonCode: 'price_acquisition_not_configured' });
    expect(createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it.each(['validator', 'publisher'] as const)('requires explicit %s ports', async key => {
    expect(await createPostgresNativePriceAuthorityDependencies({ ...fixture(), [key]: undefined }))
      .toEqual({ status: 'deferred', reasonCode: 'price_authority_dependencies_unavailable' });
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it('does not treat reviewed bindings as approval', async () => {
    const input = fixture();
    const { approval: _approval, ...validator } = input.validator!;
    expect(await createPostgresNativePriceAuthorityDependencies({ ...input, validator }))
      .toEqual({ status: 'deferred', reasonCode: 'price_independent_approval_unavailable' });
    expect(createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it.each(['generation', 'activation', 'publisherGeneration', 'mapping', 'binding', 'source', 'timeframe'] as const)('refuses drift in %s before native I/O', async field => {
    const input = fixture();
    const altered = field === 'generation' ? { ...input, validator: { ...input.validator!, generationId: 'other' } }
      : field === 'activation' ? { ...input, validator: { ...input.validator!, activatedAt: 101 } }
      : field === 'publisherGeneration' ? { ...input, publisher: { ...input.publisher!, target: { ...input.publisher!.target, generationId: 'other' } } }
      : field === 'mapping' ? { ...input, publisher: { ...input.publisher!, mappings: [] } }
      : field === 'binding' ? { ...input, validator: { ...input.validator!, reviewedBindings: [] } }
      : field === 'source' ? { ...input, deployment: { ...input.deployment, priceAcquisition: { ...input.deployment.priceAcquisition!, source: { ...input.deployment.priceAcquisition!.source, providerId: 'other' } } } }
      : { ...input, validator: { ...input.validator!, reviewedBindings: input.validator!.reviewedBindings.map(binding => ({ ...binding, timeframe: 'hour' as const })) } };
    expect(await createPostgresNativePriceAuthorityDependencies(altered)).toEqual({ status: 'deferred', reasonCode: 'price_authority_configuration_mismatch' });
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it('passes explicit ports unchanged and performs no acquisition or publication', async () => {
    const input = fixture();
    expect(await createPostgresNativePriceAuthorityDependencies(input)).toEqual({ status: 'available', dependencies: { priceAuthority: { validator: reader, publisher: writer } } });
    expect(createPostgresIndependentPriceValidator).toHaveBeenCalledWith(input.validator);
    expect(createPostgresPriceFactPublisher).toHaveBeenCalledWith(input.publisher);
    expect(input.validator!.approval!.authorizePriceReplay).not.toHaveBeenCalled();
    expect(reader.validatePrice).not.toHaveBeenCalled();
    expect(writer.publish).not.toHaveBeenCalled();
  });
  it('redacts native refusal and exposes no dependencies', async () => {
    vi.mocked(createPostgresPriceFactPublisher).mockRejectedValue(new Error('SECRET_CONNECTION_URL'));
    const result = await createPostgresNativePriceAuthorityDependencies(fixture());
    expect(result).toEqual({ status: 'deferred', reasonCode: 'price_native_authority_unavailable' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('does not construct ports after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await createPostgresNativePriceAuthorityDependencies({ ...fixture(), signal: controller.signal }))
      .toEqual({ status: 'deferred', reasonCode: 'price_authority_aborted' });
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
  it('does not expose ports when cancellation occurs during the native probe', async () => {
    const controller = new AbortController();
    vi.mocked(createPostgresPriceFactPublisher).mockImplementation(async () => { controller.abort(); return writer; });
    expect(await createPostgresNativePriceAuthorityDependencies({ ...fixture(), signal: controller.signal }))
      .toEqual({ status: 'deferred', reasonCode: 'price_authority_aborted' });
  });
});

import { reportedMarketApprovalFingerprint, type ReportedMarketApprovalDocument } from '../postgres-reported-market-approval.js';
import { postgresServiceFactFingerprint } from '../../apps/automation/src/postgres-service-fact-adapters.js';
function reportedComposerFixture() {
  const mapping = { chain: 'solana' as const, tokenAddress: '1'.repeat(31)+'2', poolAddress: '1'.repeat(31)+'3', tokenSide: 'base' as const,
    network: 'solana', evidenceRef: 'reviewed-map', knownAt: 100 };
  const target = { database: 'radar_business', schema: 'radar_business', generationId: 'fixture-generation', systemIdentifier: '123',
    serverAddress: '127.0.0.1', serverPort: 5432, schemaVersion: 3, schemaFingerprint: 'a'.repeat(64) };
  const document: ReportedMarketApprovalDocument = { protocol: 'address-only-reported-market-cap-approval-v1', importId: 'reported-review', approvalRef: 'operator-review', authorizationRef: 'fixture-authorization',
    target, validator: { validatorId: 'fixture-validator', keyId: 'fixture-key', actorId: 'fixture-actor', publicKey },
    source: { providerId: 'fixture-source', origin: 'https://prod.ave-api.com', protocol: 'ave_token_market_cap_v1', sourceApprovalRef: 'reported-source-review' },
    mapping, mappingFingerprint: postgresServiceFactFingerprint(mapping), mappingApprovalRef: 'reviewed-map', quoteAddress: '1'.repeat(31)+'4',
    quality: 'reported', sourceProofKind: 'approved_reported_market_cap_v1', reviewer: { actorId: 'reviewer', evidenceSha256: 'b'.repeat(64), reviewedAt: 100, conflictVerdict: 'none_observed' },
    approvedAt: 100, validFrom: 100, validUntil: 100000 };
  const binding = { mapping, providerId: 'fixture-source', quoteAddress: document.quoteAddress, mappingApprovalRef: document.mappingApprovalRef,
    sourceApprovalRef: document.source.sourceApprovalRef, sourceProofKind: document.sourceProofKind, candleMs: 0 as const, validFrom: 100, validUntil: 100000 };
  const base = fixture();
  const input: Parameters<typeof createPostgresNativeReportedMarketCapAuthorityDependencies>[0] = {
    deployment: { generationId: target.generationId, activatedAt: 100 }, sourceOrigin: document.source.origin, signal: new AbortController().signal,
    validator: { ...document.validator, authorizationRef: document.authorizationRef, generationId: target.generationId, activatedAt: 100,
      bindings: [binding] } as unknown as Parameters<typeof createPostgresNativeReportedMarketCapAuthorityDependencies>[0]['validator'],
    publisher: { ...base.publisher!, target: { ...base.publisher!.target, ...target }, mappings: [binding],
      validators: [{ ...base.publisher!.validators[0]!, reviewedSourceProviders: ['fixture-source'] }] },
    approvalReader: { pin: { path: '/root/review.json', sha256: 'e'.repeat(64) }, target, now: () => 1000,
      read: vi.fn(async () => document), run: vi.fn(async () => { throw Error('no actual ledger'); }) } };
  return { input, document };
}
describe('reported native composition never substitutes candle or static approval', () => {
  it('assembles the distinct validator with the actual ledger reader, not the caller approval port', async () => {
    const { input, document } = reportedComposerFixture();
    expect((await createPostgresNativeReportedMarketCapAuthorityDependencies(input)).status).toBe('available');
    expect(createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
    const called = vi.mocked(createPostgresReportedMarketCapValidator).mock.calls[0]![0];
    expect(typeof called.approval?.authorizeReportedMarketCap).toBe('function');
    expect(await called.approval!.authorizeReportedMarketCap({ authorizationRef: document.authorizationRef, generationId: document.target.generationId,
      validatorId: document.validator.validatorId, keyId: document.validator.keyId, actorId: document.validator.actorId, providerId: document.source.providerId,
      sourceApprovalRef: document.source.sourceApprovalRef, mappingApprovalRef: document.mappingApprovalRef, mappingFingerprint: document.mappingFingerprint,
      quoteAddress: document.quoteAddress, candidateFingerprint: 'c'.repeat(64), sampleId: 'sample', executionFingerprint: 'd'.repeat(64), checkedAt: 1000, signal: input.signal })).toMatchObject({ status: 'deferred' });
    expect(reportedMarketApprovalFingerprint(document)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['origin','generation','key','mapping','candle','publisher-key','publisher-actor','publisher-source'])('refuses %s mismatch before publisher construction', async fault => {
    const { input } = reportedComposerFixture();
    const modified = fault === 'origin' ? { ...input, sourceOrigin: 'https://other.invalid' }
      : fault === 'generation' ? { ...input, deployment: { ...input.deployment, generationId: 'other' } }
      : fault === 'key' ? { ...input, validator: { ...input.validator, publicKey: otherPublicKey } }
      : fault === 'mapping' ? { ...input, validator: { ...input.validator, bindings: [] } }
      : fault === 'candle' ? { ...input, publisher: { ...input.publisher, mappings: [{ ...input.publisher.mappings[0]!, sourceProofKind: 'candle', candleMs: 60000 }] } }
      : { ...input, publisher: { ...input.publisher, validators: [{ ...input.publisher.validators[0]!,
        ...(fault === 'publisher-key' ? { publicKey: otherPublicKey } : fault === 'publisher-actor' ? { actorId: 'other' } : { reviewedSourceProviders: ['other'] }) }] } };
    expect((await createPostgresNativeReportedMarketCapAuthorityDependencies(modified)).status).toBe('deferred');
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
});

describe('entry reported authority selection is explicit and fail closed',()=>{
  function selection() {
    const {input,document}=reportedComposerFixture();
    const native={...input,validator:{...input.validator,maximumRunMs:1000,maximumPayloadBytes:64000,maximumWindowMs:120000,maximumMappingAgeMs:200000}};
    const deployment={...input.deployment,database:document.target.database,schema:document.target.schema,
      cutover:{addressOnly:{target:document.target}},priceAcquisition:{protocol:'approved_reported_market_cap_v1',approval:input.approvalReader.pin,
        source:{providerId:document.source.providerId,baseUrl:document.source.origin,sourceApprovalRef:document.source.sourceApprovalRef,
          maximumRunMs:1000,maximumPayloadBytes:64000,maximumWindowMs:120000,maximumMappingAgeMs:200000},
        mappings:input.publisher.mappings,receiver:{maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:64000},
        retry:{maximumSamples:1,maximumRetryEntries:1,maximumMappings:1,maximumPayloadBytes:64000,maximumRunMs:1000,retryDelayMs:1000}}};
    return {native,deployment};
  }
  it('uses the real reported composer, never the candle validator',async()=>{
    const f=selection();
    const result=await composePostgresServicePriceDependencies({service:'scanner',deployment:f.deployment as any,
      dependencies:{nativeReportedMarketCapAuthority:f.native},signal:new AbortController().signal});
    expect(result.priceAuthority).toBeDefined();expect(createPostgresReportedMarketCapValidator).toHaveBeenCalledTimes(1);
    expect(createPostgresIndependentPriceValidator).not.toHaveBeenCalled();
  });
  it.each(['missing','candle-ports','pin','origin','cluster','budget'] )('refuses %s without constructing a publisher',async fault=>{
    const f=selection(),native=f.native;
    if(fault==='pin')f.deployment.priceAcquisition.approval={...native.approvalReader.pin,sha256:'0'.repeat(64)};
    if(fault==='origin')native.sourceOrigin='https://other.invalid';
    if(fault==='cluster')native.approvalReader={...native.approvalReader,target:{...native.approvalReader.target,systemIdentifier:'456'}};
    if(fault==='budget')native.validator.maximumRunMs=1001;
    await expect(composePostgresServicePriceDependencies({service:'scanner',deployment:f.deployment as any,
      dependencies:{...(fault==='missing'?{}:{nativeReportedMarketCapAuthority:native}),...(fault==='candle-ports'?{nativePriceAuthority:{}}:{})},
      signal:new AbortController().signal})).rejects.toThrow();
    expect(createPostgresPriceFactPublisher).not.toHaveBeenCalled();
  });
});
