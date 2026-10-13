import { isDeepStrictEqual } from 'node:util';
import { createPublicKey } from 'node:crypto';
import { createPostgresIndependentPriceValidator, type PostgresIndependentPriceValidatorOptions } from '../apps/automation/src/postgres-independent-price-validator.js';
import { createPostgresPriceFactPublisher, type PostgresPricePublisherOptions } from '../apps/automation/src/postgres-price-fact-publisher.js';
import type { ConfiguredPostgresServiceDeployment, PostgresServiceDependencies } from './postgres-service-entry.js';

export interface PostgresNativePriceAuthorityInput {
  readonly deployment: Pick<ConfiguredPostgresServiceDeployment, 'generationId' | 'activatedAt'> & { readonly priceAcquisition?: import('./postgres-service-entry.js').PostgresRootPriceConfiguration };
  /** Trusted caller supplies independently budgeted transport, approval and server-local key ports. */
  readonly validator?: PostgresIndependentPriceValidatorOptions;
  /** Trusted caller owns the distinct publisher connection and bounded transaction lifecycle. */
  readonly publisher?: PostgresPricePublisherOptions;
  readonly signal: AbortSignal;
}
export type PostgresNativePriceAuthorityResult =
  | { readonly status: 'available'; readonly dependencies: Pick<PostgresServiceDependencies, 'priceAuthority'> }
  | { readonly status: 'deferred'; readonly reasonCode: 'price_acquisition_not_configured' | 'price_authority_dependencies_unavailable'
    | 'price_independent_approval_unavailable' | 'price_authority_configuration_mismatch' | 'price_authority_aborted'
    | 'price_native_authority_unavailable' };

/** Called after the entry's existing startup fence. Only scanner owns price acquisition. */
export async function composePostgresServicePriceDependencies(input: {
  readonly service: string;
  readonly deployment: Pick<ConfiguredPostgresServiceDeployment, 'generationId' | 'activatedAt' | 'priceAcquisition'> & Partial<Pick<ConfiguredPostgresServiceDeployment,'database'|'schema'|'cutover'>>;
  readonly dependencies: PostgresServiceDependencies;
  readonly signal: AbortSignal;
}): Promise<PostgresServiceDependencies> {
  const { dependencies } = input;
  if (input.service !== 'scanner' || !input.deployment.priceAcquisition) return dependencies;
  if (input.deployment.priceAcquisition.protocol === 'approved_reported_market_cap_v1') {
    const native = dependencies.nativeReportedMarketCapAuthority;
    if (!native || dependencies.nativePriceAuthority || dependencies.priceAuthority) throw new Error('REPORTED_PRICE_NATIVE_PORTS_REQUIRED');
    const p = input.deployment.priceAcquisition;
    const target=input.deployment.cutover?.addressOnly?.target, actual=native.approvalReader.target;
    if (!target || actual.database !== input.deployment.database || actual.schema !== input.deployment.schema
      || actual.systemIdentifier !== target.systemIdentifier || actual.serverAddress !== target.serverAddress
      || actual.serverPort !== target.serverPort || actual.schemaFingerprint !== target.schemaFingerprint || actual.schemaVersion !== 3
      || !isDeepStrictEqual(native.approvalReader.pin,p.approval) || native.sourceOrigin !== p.source.baseUrl
      || !isDeepStrictEqual(native.publisher.mappings,p.mappings) || native.validator.bindings.some(binding =>
        binding.providerId !== p.source.providerId || binding.sourceApprovalRef !== p.source.sourceApprovalRef)
      || native.validator.maximumRunMs > p.receiver.maximumRunMs || native.validator.maximumPayloadBytes > p.receiver.maximumPayloadBytes
      || native.validator.maximumWindowMs > p.source.maximumWindowMs || native.validator.maximumMappingAgeMs > p.source.maximumMappingAgeMs) {
      throw new Error('REPORTED_PRICE_NATIVE_BINDING_MISMATCH');
    }
    const result = await createPostgresNativeReportedMarketCapAuthorityDependencies({ ...native, deployment: input.deployment, signal: input.signal });
    if (result.status !== 'available') throw new Error('REPORTED_PRICE_NATIVE_AUTHORITY_UNAVAILABLE');
    return { ...dependencies, ...result.dependencies };
  }
  if (dependencies.nativeReportedMarketCapAuthority) throw new Error('PRICE_PROTOCOL_PORT_CONFLICT');
  if (!dependencies.nativePriceAuthority) return dependencies;
  if (dependencies.priceAuthority) throw new Error('PRICE_AUTHORITY_DEPENDENCY_CONFLICT');
  const result = await createPostgresNativePriceAuthorityDependencies({ ...dependencies.nativePriceAuthority,
    deployment: { ...input.deployment, priceAcquisition: input.deployment.priceAcquisition }, signal: input.signal });
  if (result.status !== 'available') throw new Error('INDEPENDENT_PRICE_VALIDATOR_CLI_PORT_REQUIRED');
  return { ...dependencies, ...result.dependencies };
}

/** Dependency assembly only. Does not approve policy, provision roles, allocate pools or bypass native preflight. */
export async function createPostgresNativePriceAuthorityDependencies(input: PostgresNativePriceAuthorityInput): Promise<PostgresNativePriceAuthorityResult> {
  const defer = (reasonCode: Extract<PostgresNativePriceAuthorityResult, { status: 'deferred' }>['reasonCode']): PostgresNativePriceAuthorityResult => ({ status: 'deferred', reasonCode });
  if (input.signal.aborted) return defer('price_authority_aborted');
  const { deployment, validator, publisher } = input;
  const price = deployment.priceAcquisition;
  if (!price) return defer('price_acquisition_not_configured');
  if ('approval' in price) return defer('price_authority_configuration_mismatch');
  if (!validator || !publisher) return defer('price_authority_dependencies_unavailable');
  if (typeof validator.approval?.authorizePriceReplay !== 'function') return defer('price_independent_approval_unavailable');
  try {
    const pins = publisher.validators.filter(pin => pin.validatorId === validator.validatorId && pin.keyId === validator.keyId);
    const pin = pins[0];
    if (pins.length !== 1 || !pin || ![validator.validatorId, validator.keyId, validator.actorId, validator.authorizationRef]
      .every(value => typeof value === 'string' && value.trim().length > 0)
      || pin.actorId !== validator.actorId || pin.authorizationRef !== validator.authorizationRef
      || !validator.reviewedBindings.every(binding => typeof binding.replayProviderId === 'string'
        && binding.replayProviderId.trim().length > 0 && pin.reviewedSourceProviders.includes(binding.replayProviderId))) {
      return defer('price_authority_configuration_mismatch');
    }
    const validatorKey = createPublicKey(validator.publicKey), publisherKey = createPublicKey(pin.publicKey);
    if (validatorKey.asymmetricKeyType !== 'ed25519' || publisherKey.asymmetricKeyType !== 'ed25519'
      || !validatorKey.export({ type: 'spki', format: 'der' }).equals(publisherKey.export({ type: 'spki', format: 'der' }))) {
      return defer('price_authority_configuration_mismatch');
    }
  } catch {
    return defer('price_authority_configuration_mismatch');
  }
  // Static pins only bind the ports. The validator must still obtain current independent approval per candidate.
  if (validator.generationId !== deployment.generationId || validator.activatedAt !== deployment.activatedAt
    || publisher.target.generationId !== deployment.generationId || !price.mappings.length
    || !isDeepStrictEqual(publisher.mappings, price.mappings)
    || validator.reviewedBindings.length !== price.mappings.length
    || !price.mappings.every(pin => validator.reviewedBindings.some(binding =>
      binding.sourceProviderId === price.source.providerId && binding.sourceProviderId === pin.providerId
      && binding.sourceBaseUrl === price.source.baseUrl && binding.timeframe === price.source.timeframe
      && binding.aggregate === price.source.aggregate && binding.candleMs === pin.candleMs
      && binding.mappingApprovalRef === pin.mappingApprovalRef && binding.sourceApprovalRef === pin.sourceApprovalRef
      && binding.sourceProofKind === pin.sourceProofKind && binding.validFrom === pin.validFrom && binding.validUntil === pin.validUntil
      && isDeepStrictEqual(binding.mapping, pin.mapping)))) return defer('price_authority_configuration_mismatch');
  try {
    const reader = createPostgresIndependentPriceValidator(validator);
    const writer = await createPostgresPriceFactPublisher(publisher);
    if (input.signal.aborted) return defer('price_authority_aborted');
    return { status: 'available', dependencies: { priceAuthority: { validator: reader, publisher: writer } } };
  } catch {
    // Native identity/ACL errors may contain connection metadata; expose only a closed reason.
    return defer('price_native_authority_unavailable');
  }
}

/** Separate reported-source assembly; no candle binding or provider-budget row grants approval. */
export interface PostgresNativeReportedMarketCapAuthorityInput {
  readonly deployment: Pick<ConfiguredPostgresServiceDeployment, 'generationId' | 'activatedAt'>;
  readonly validator: Omit<import('../apps/automation/src/postgres-independent-price-validator.js').PostgresReportedMarketCapValidatorOptions, 'approval'>;
  readonly publisher: PostgresPricePublisherOptions;
  readonly sourceOrigin: string;
  readonly approvalReader: import('./postgres-reported-market-approval.js').ReportedMarketApprovalReaderOptions;
  readonly signal: AbortSignal;
}
export async function createPostgresNativeReportedMarketCapAuthorityDependencies(input: PostgresNativeReportedMarketCapAuthorityInput): Promise<PostgresNativePriceAuthorityResult> {
  const refuse = (): PostgresNativePriceAuthorityResult => ({ status: 'deferred', reasonCode: 'price_native_authority_unavailable' });
  if (input.signal.aborted) return { status: 'deferred', reasonCode: 'price_authority_aborted' };
  try {
    const { createPostgresReportedMarketApprovalReader, readRootReportedMarketApproval, validateReportedMarketApproval } = await import('./postgres-reported-market-approval.js');
    const { createPostgresReportedMarketCapValidator } = await import('../apps/automation/src/postgres-independent-price-validator.js');
    const document = validateReportedMarketApproval(await (input.approvalReader.read ?? readRootReportedMarketApproval)(input.approvalReader.pin));
    const { validator, publisher, deployment } = input;
    const a = document.validator, t = document.target;
    const publicDer = (pem: string) => createPublicKey(pem).export({ type: 'spki', format: 'der' });
    const pins = publisher.validators.filter(pin => pin.validatorId === a.validatorId && pin.keyId === a.keyId);
    const pin = pins[0];
    if (!isDeepStrictEqual(input.approvalReader.target, t) || t.generationId !== deployment.generationId
      || validator.generationId !== deployment.generationId || validator.activatedAt !== deployment.activatedAt
      || publisher.target.generationId !== t.generationId || publisher.target.database !== t.database || publisher.target.schema !== t.schema
      || publisher.target.serverAddress !== t.serverAddress || publisher.target.serverPort !== t.serverPort
      || publisher.target.schemaVersion !== t.schemaVersion || publisher.target.schemaFingerprint !== t.schemaFingerprint
      || input.sourceOrigin !== document.source.origin || validator.validatorId !== a.validatorId || validator.keyId !== a.keyId
      || validator.actorId !== a.actorId || validator.authorizationRef !== document.authorizationRef
      || !publicDer(validator.publicKey).equals(publicDer(a.publicKey)) || pins.length !== 1 || !pin
      || pin.actorId !== a.actorId || pin.authorizationRef !== document.authorizationRef
      || !pin.reviewedSourceProviders.includes(document.source.providerId) || !publicDer(pin.publicKey).equals(publicDer(a.publicKey))
      || validator.bindings.length !== 1 || publisher.mappings.length !== 1
      || !isDeepStrictEqual(validator.bindings, publisher.mappings)) return refuse();
    const binding = validator.bindings[0]!;
    if (binding.providerId !== document.source.providerId || binding.sourceApprovalRef !== document.source.sourceApprovalRef
      || binding.mappingApprovalRef !== document.mappingApprovalRef || binding.quoteAddress !== document.quoteAddress
      || binding.sourceProofKind !== document.sourceProofKind || binding.candleMs !== 0
      || binding.validFrom !== document.validFrom || binding.validUntil !== document.validUntil
      || !isDeepStrictEqual(binding.mapping, document.mapping)) return refuse();
    const approval = createPostgresReportedMarketApprovalReader(input.approvalReader);
    const reader = createPostgresReportedMarketCapValidator({ ...validator, approval });
    const writer = await createPostgresPriceFactPublisher(publisher);
    if (input.signal.aborted) return { status: 'deferred', reasonCode: 'price_authority_aborted' };
    return { status: 'available', dependencies: { priceAuthority: { validator: reader, publisher: writer } } };
  } catch { return refuse(); }
}
