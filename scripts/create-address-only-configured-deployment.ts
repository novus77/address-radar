import { createAddressOnlyWaitingDeployment, type AddressOnlyWaitingDeploymentInput } from './create-address-only-waiting-deployment.js';
import { validatePostgresServiceDeployment, type ConfiguredPostgresServiceDeployment } from './postgres-service-entry.js';

export type AddressOnlySourceChain = 'solana' | 'eth' | 'bsc' | 'base';
export type AddressOnlyAuthorityKind = 'execution' | 'price' | 'source' | 'risk' | 'independence';
export interface AddressOnlyRpcRegistration {
  readonly chain: AddressOnlySourceChain;
  readonly providerId: string;
  readonly origin: string;
  /** Reference only. The parent supplies secret-bearing URLs through protected environment files. */
  readonly endpointEnvironmentKey: string;
}
export interface AddressOnlyProviderContract {
  readonly providerId: string; readonly origin: string; readonly generationId: string;
  readonly importId: string; readonly proofScope: 'provider_contract';
  readonly evidenceRef: string; readonly evidenceSha256: string;
  readonly importedAt: number; readonly validUntil: number;
  readonly windowMs: number; readonly maximumRequests: number; readonly maximumConcurrency: number;
}
export interface AddressOnlyAuthorityProof {
  readonly kind: AddressOnlyAuthorityKind; readonly generationId: string;
  readonly validatorId: string; readonly publisherRole: string;
  readonly evidenceRef: string; readonly evidenceSha256: string;
  readonly observedAt: number; readonly validUntil: number;
}
export interface AddressOnlyConfiguredDeploymentInput extends Omit<AddressOnlyWaitingDeploymentInput, 'wallet' | 'composition'> {
  readonly principal: ConfiguredPostgresServiceDeployment['composition']['principal'];
  readonly sourceRPCRegistry: readonly AddressOnlyRpcRegistration[];
  readonly budgetContracts: readonly AddressOnlyProviderContract[];
  readonly authorityProofs: readonly AddressOnlyAuthorityProof[];
  readonly walletExecution?: ConfiguredPostgresServiceDeployment['walletExecution'];
  readonly priceAcquisition?: ConfiguredPostgresServiceDeployment['priceAcquisition'];
}
export interface AddressOnlyConfiguredTechnicalBudgets {
  readonly sources: {
    readonly leaseMs: number; readonly maximumProfileAgeMs: number; readonly maximumFactAgeMs: number;
    readonly maximumSafetyAgeMs: number; readonly providerTimeoutMs: number;
    readonly maximumResponseBytes: number; readonly maximumFactPayloadBytes: number;
  };
  readonly wallet: ConfiguredPostgresServiceDeployment['wallet'];
  readonly composition: Omit<ConfiguredPostgresServiceDeployment['composition'], 'principal'>;
}
export interface AddressOnlyConfiguredFactoryOptions {
  readonly now?: () => number;
  readonly technicalBudgets?: AddressOnlyConfiguredTechnicalBudgets;
}
const demand = (condition: unknown, code: string): void => { if (!condition) throw new Error(code); };
const identifier = (value: unknown): void => demand(typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) && !value.includes('://'), 'explicit_metadata_identifier_required');
const integer = (value: unknown, maximum = 2147483647): void => demand(Number.isSafeInteger(value)
  && Number(value) > 0 && Number(value) <= maximum, 'invalid_technical_budget');
function origin(value: string): string {
  const url = new URL(value);
  demand(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && value === url.origin, 'credential_free_canonical_https_origin_required');
  return url.origin;
}
function evidence(value: { evidenceRef: string; evidenceSha256: string; validUntil: number }, at: number): void {
  identifier(value.evidenceRef);
  demand(/^[a-f0-9]{64}$/.test(value.evidenceSha256), 'metadata_evidence_digest_required');
  demand(Number.isSafeInteger(value.validUntil) && value.validUntil > at, 'metadata_evidence_expired');
}
function approvedBudgets(): AddressOnlyConfiguredTechnicalBudgets {
  return {
    sources: { leaseMs: 60000, maximumProfileAgeMs: 2147483647, maximumFactAgeMs: 86400000,
      maximumSafetyAgeMs: 3600000, providerTimeoutMs: 5000, maximumResponseBytes: 2 * 1024**2,
      maximumFactPayloadBytes: 256 * 1024 },
    wallet: { maximumProfiles: 256, maximumEvents: 32, collectorQuota: 3, leaseMs: 60000,
      maximumPayloadBytes: 2 * 1024**2, maximumRunMs: 12000 },
    composition: { quotas: { normalization: 1, token: 1, purchase: 1, fanout: 1, opportunity: 1, capability: 1, signal: 1 },
      maximumClaims: 7, maximumRunMs: 12000, admissionLimit: 32, leaseMs: 60000, retryDelayMs: 60000,
      maximumPayloadBytes: 2 * 1024**2, maximumSamples: 64, factLimit: 32, reconcileIntervalMs: 60000 },
  };
}

/** Metadata preflight only: no network, database, secret loading or authority construction. */
export function createAddressOnlyConfiguredDeploymentFactory(options: AddressOnlyConfiguredFactoryOptions = {}) {
  const budgets = structuredClone(options.technicalBudgets ?? approvedBudgets());
  const now = options.now ?? Date.now;
  return (input: AddressOnlyConfiguredDeploymentInput) => {
    const at = now();
    demand(Number.isSafeInteger(at) && at >= 0, 'invalid_preflight_clock');
    const base = createAddressOnlyWaitingDeployment(input);
    const generation = input.manifest.generationId;
    identifier(input.principal?.actorId); identifier(input.principal?.authorizationEvidenceRef);
    demand(Array.isArray(input.principal?.permissions) && input.principal.permissions.length === 1
      && input.principal.permissions[0] === 'target_registry_write', 'address_only_registry_principal_required');
    const sourceKeys = ['leaseMs', 'maximumProfileAgeMs', 'maximumFactAgeMs', 'maximumSafetyAgeMs',
      'providerTimeoutMs', 'maximumResponseBytes', 'maximumFactPayloadBytes'];
    demand(Object.keys(budgets.sources).sort().join(',') === sourceKeys.sort().join(','), 'exact_seven_source_budgets_required');
    Object.values(budgets.sources).forEach(value => integer(value));
    demand(budgets.wallet.maximumProfiles <= 10000, 'profile_budget_exceeded');
    demand(Array.isArray(input.budgetContracts) && input.budgetContracts.length > 0 && input.budgetContracts.length <= 64,
      'provider_contracts_required');
    const contracts = new Map<string, AddressOnlyProviderContract>(); const origins = new Set<string>();
    for (const contract of input.budgetContracts) {
      identifier(contract.providerId); identifier(contract.importId); evidence(contract, at);
      demand(contract.generationId === generation && contract.proofScope === 'provider_contract'
        && Number.isSafeInteger(contract.importedAt) && contract.importedAt >= 0 && contract.importedAt <= at,
        'provider_contract_binding_required');
      const endpointOrigin = origin(contract.origin);
      demand(!contracts.has(contract.providerId) && !origins.has(endpointOrigin), 'duplicate_provider_contract');
      [contract.windowMs, contract.maximumRequests, contract.maximumConcurrency].forEach(value => integer(value));
      contracts.set(contract.providerId, contract); origins.add(endpointOrigin);
    }
    demand(Array.isArray(input.sourceRPCRegistry) && input.sourceRPCRegistry.length > 0 && input.sourceRPCRegistry.length <= 4,
      'source_rpc_registry_required');
    const chains = new Set<string>();
    for (const rpc of input.sourceRPCRegistry) {
      demand(['solana', 'eth', 'bsc', 'base'].includes(rpc.chain) && !chains.has(rpc.chain), 'distinct_supported_rpc_chains_required');
      chains.add(rpc.chain);
      demand(rpc.endpointEnvironmentKey === `RADAR_RPC_${rpc.chain.toUpperCase()}_HTTP_URL`, 'rpc_environment_binding_required');
      demand(contracts.get(rpc.providerId)?.origin === origin(rpc.origin), 'rpc_provider_contract_required');
    }
    const kinds: readonly AddressOnlyAuthorityKind[] = ['execution', 'price', 'source', 'risk', 'independence'];
    demand(Array.isArray(input.authorityProofs) && input.authorityProofs.length <= kinds.length, 'authority_metadata_array_required');
    const authorities = new Set<string>();
    for (const proof of input.authorityProofs) {
      demand(kinds.includes(proof.kind) && !authorities.has(proof.kind), 'distinct_authority_metadata_required');
      authorities.add(proof.kind); evidence(proof, at); identifier(proof.validatorId); identifier(proof.publisherRole);
      demand(/^[a-z_][a-z0-9_]{0,62}$/.test(proof.publisherRole) && !Object.values(input.roles).includes(proof.publisherRole),
        'independent_publisher_role_required');
      demand(proof.generationId === generation && Number.isSafeInteger(proof.observedAt)
        && proof.observedAt >= 0 && proof.observedAt <= at, 'authority_metadata_binding_required');
    }
    demand(!input.walletExecution || authorities.has('execution'), 'execution_authority_metadata_required');
    demand(!input.priceAcquisition || authorities.has('price'), 'price_authority_metadata_required');
    if (input.walletExecution) {
      for (const chain of ['solana', 'eth', 'bsc', 'base'] as const) {
        const producer = chain === 'solana' ? input.walletExecution.solana : input.walletExecution.evm?.[chain];
        if (!producer) continue;
        const rpc = input.sourceRPCRegistry.find(item => item.chain === chain);
        demand(rpc?.providerId === producer.providerId && new URL(producer.endpoint).origin === rpc.origin,
          'execution_rpc_registry_mismatch');
      }
    }
    if (input.priceAcquisition) {
      demand(contracts.get(input.priceAcquisition.source.providerId)?.origin === new URL(input.priceAcquisition.source.baseUrl).origin,
        'price_provider_contract_required');
    }
    const driver = { ...base.deployment.driver, serviceConnectionBudgets: {
      ...base.deployment.driver.serviceConnectionBudgets, 'execution-publisher': 1,
    } };
    const allocatedConnections = Object.values(driver.serviceConnectionBudgets).reduce((sum, value) => sum + value, 0);
    demand(allocatedConnections + driver.reservedConnections <= driver.serverMaximumConnections, 'publisher_connection_budget_exceeded');
    const deployment = validatePostgresServiceDeployment({ ...base.deployment, driver,
      sources: structuredClone(budgets.sources), wallet: structuredClone(budgets.wallet),
      composition: { ...structuredClone(budgets.composition), principal: structuredClone(input.principal) },
      ...(input.walletExecution ? { walletExecution: structuredClone(input.walletExecution) } : {}),
      ...(input.priceAcquisition ? { priceAcquisition: structuredClone(input.priceAcquisition) } : {}),
    }, base.environment) as ConfiguredPostgresServiceDeployment;
    return { ...base, deployment,
      resources: { ...base.resources, allocatedConnections,
        unallocatedConnections: driver.serverMaximumConnections - driver.reservedConnections - allocatedConnections,
        executionPublisherMaximumConnections: 1 },
      preflight: { scope: 'configuration-metadata-only', measuredAtMs: at, metadataAccepted: true,
        networkVerified: false, databaseContractsVerified: false, authorityPortsVerified: false,
        requiredEnvironmentKeys: input.sourceRPCRegistry.map(rpc => rpc.endpointEnvironmentKey),
        rpcRegistry: structuredClone(input.sourceRPCRegistry), providerContracts: structuredClone(input.budgetContracts),
        authorityProofs: structuredClone(input.authorityProofs),
        gaps: [...kinds.filter(kind => !authorities.has(kind)).map(kind => kind + '_authority_missing'), 'historical_profile_freshness_unverified', 'provider_contracts_require_database_verification',
          'independent_authority_ports_require_runtime_wiring', 'configured_capacity_requires_native_measurement',
          ...(!input.walletExecution ? ['execution_producer_registry_missing'] : []),
          ...(!input.priceAcquisition ? ['price_acquisition_and_mapping_missing'] : [])] },
      acceptance: { migration: 'unchanged_requires_existing_receipt', lifecycle: 'pending_configured_verification',
        sourceMonitoring: 'pending_runtime_wiring_and_native_verification', monitoringCompleted: false,
        businessEligibilityGranted: false, safetyVerified: false },
    } as const;
  };
}
export function createAddressOnlyConfiguredDeployment(input: AddressOnlyConfiguredDeploymentInput,
  options: AddressOnlyConfiguredFactoryOptions = {}) {
  return createAddressOnlyConfiguredDeploymentFactory(options)(input);
}
