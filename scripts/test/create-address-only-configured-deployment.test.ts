import { describe, expect, it } from 'vitest';
import { POSTGRES_BUSINESS_SERVICES } from '../../packages/database/src/postgres-service-dispatch.js';
import { createAddressOnlyConfiguredDeploymentFactory, type AddressOnlyConfiguredDeploymentInput } from '../create-address-only-configured-deployment.js';

const at = 1800000000000;
const generate = createAddressOnlyConfiguredDeploymentFactory({ now: () => at });
function fixture(): AddressOnlyConfiguredDeploymentInput {
  const hash = 'a'.repeat(64), generationId = 'generation-1';
  return {
    manifest: { protocol: 'address-only-v1', operationId: 'operation-1', importId: 'import-1', generationId,
      activatedAt: at - 1000, planSha256: hash, seedSha256: hash, cohortSha256: hash,
      walletCount: 216, entityCount: 122, releaseSha256: hash, backupSha256: hash, fenceSha256: hash,
      target: { database: 'address_radar', schema: 'address_radar_business', schemaFingerprint: hash,
        systemIdentifier: '123456', serverAddress: '127.0.0.1', serverPort: 5432 },
      gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false },
    releaseRoot: '/opt/address-radar/releases/configured-test', execution: { maximumEntries: 5, maximumBytes: 2000000 },
    intervalMs: 15000,
    roles: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(s => [s, 'address_radar_' + s.replaceAll('-', '_')])) as AddressOnlyConfiguredDeploymentInput['roles'],
    principal: { actorId: 'operator', authorizationEvidenceRef: 'operator-approval', permissions: ['target_registry_write'] },
    sourceRPCRegistry: [{ chain: 'solana', providerId: 'rpc-1', origin: 'https://rpc.example', endpointEnvironmentKey: 'RADAR_RPC_SOLANA_HTTP_URL' }],
    budgetContracts: [{ providerId: 'rpc-1', origin: 'https://rpc.example', generationId, importId: 'provider-import-1',
      proofScope: 'provider_contract', evidenceRef: 'approved-provider-contract', evidenceSha256: hash,
      importedAt: at - 1000, validUntil: at + 60000, windowMs: 60000, maximumRequests: 10, maximumConcurrency: 1 }],
    authorityProofs: (['execution', 'price', 'source', 'risk', 'independence'] as const).map(kind => ({ kind, generationId,
      validatorId: kind + '-validator', publisherRole: kind + '_publisher', evidenceRef: kind + '-approval',
      evidenceSha256: hash, observedAt: at - 1000, validUntil: at + 60000 })),
  };
}
describe('configured metadata preflight, not production evidence', () => {
  it('constructs approved budgets while keeping runtime and safety acceptance pending', () => {
    const value = generate(fixture());
    expect(value.deployment.sources).toEqual({ leaseMs: 60000, maximumProfileAgeMs: 2147483647,
      maximumFactAgeMs: 86400000, maximumSafetyAgeMs: 3600000, providerTimeoutMs: 5000,
      maximumResponseBytes: 2097152, maximumFactPayloadBytes: 262144 });
    expect(value.deployment.composition.maximumClaims).toBe(7);
    expect(Object.values(value.deployment.composition.quotas).reduce((a,b) => a+b, 0)).toBe(7);
    expect(value.deployment.wallet).toMatchObject({ maximumProfiles: 256, maximumEvents: 32, collectorQuota: 3 });
    expect(value.deployment.services.console.maximumConnections).toBe(1);
    expect(value.deployment.driver.serviceConnectionBudgets['execution-publisher']).toBe(1);
    expect(Object.values(value.deployment.driver.serviceConnectionBudgets).reduce((a,b) => a+b, 0)).toBe(11);
    expect(value.resources).toMatchObject({ allocatedConnections: 11, reservedConnections: 3,
      unallocatedConnections: 2, executionPublisherMaximumConnections: 1 });
    expect(value.acceptance).toMatchObject({ monitoringCompleted: false, safetyVerified: false, businessEligibilityGranted: false });
    expect(value.preflight.authorityPortsVerified).toBe(false);
    expect(value.preflight.gaps).toContain('historical_profile_freshness_unverified');
    expect(value.environment.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED).toBe('false');
  });
  it.each(['sourceRPCRegistry', 'budgetContracts', 'authorityProofs'] as const)('refuses missing %s', key => {
    const input = fixture(); Object.assign(input, { [key]: key === 'authorityProofs' ? null : [] }); expect(() => generate(input)).toThrow();
  });
  it('refuses expired, cross-generation, duplicated and uncontracted providers', () => {
    for (const change of [{ validUntil: at }, { generationId: 'other' }, { maximumRequests: 0 }, { origin: 'https://other.example' }]) {
      const input = fixture(); Object.assign(input.budgetContracts[0]!, change); expect(() => generate(input)).toThrow();
    }
    const input = fixture(); Object.assign(input, { budgetContracts: [...input.budgetContracts, input.budgetContracts[0]] });
    expect(() => generate(input)).toThrow('duplicate_provider');
  });
  it('refuses missing or borrowed authority, invalid principal and secret-bearing origins', () => {
    const input = fixture(); Object.assign(input.authorityProofs[0]!, { publisherRole: input.roles.scanner });
    expect(() => generate(input)).toThrow('independent_publisher');
    const wrong = fixture(); Object.assign(wrong.principal, { permissions: [] }); expect(() => generate(wrong)).toThrow();
    const secret = fixture(); Object.assign(secret.budgetContracts[0]!, { origin: 'https://user:password@rpc.example' });
    expect(() => generate(secret)).toThrow('credential_free');
  });
  it('does not mutate the approved waiting connection allocation', async () => {
    const { createAddressOnlyWaitingDeployment } = await import('../create-address-only-waiting-deployment.js');
    const input = fixture(); generate(input);
    const waiting = createAddressOnlyWaitingDeployment(input);
    expect(waiting.resources.allocatedConnections).toBe(10);
    expect(waiting.deployment.driver.serviceConnectionBudgets['execution-publisher']).toBeUndefined();
    expect(waiting.deployment.sources).toEqual({ mode: 'waiting_configuration' });
  });
  it('uses independent factory options and rejects incompatible poll allocation', () => {
    const input = fixture(); Object.assign(input, { lifecycle: { startupMs: 60000, pollMs: 10000, shutdownMs: 10000, killMs: 5000 } });
    expect(() => generate(input)).toThrow();
    expect(() => createAddressOnlyConfiguredDeploymentFactory({ now: () => at + 60000 })(fixture())).toThrow('expired');
  });
});

it('accepts execution-only metadata without inventing safety authority', () => {
  const input = fixture(); Object.assign(input, { authorityProofs: input.authorityProofs.filter(p => p.kind === 'execution') });
  const result = generate(input);
  expect(result.acceptance.safetyVerified).toBe(false);
  expect(result.preflight.gaps).toContain('risk_authority_missing');
  expect(result.resources.allocatedConnections).toBe(11);
});
it('requires proof only for enabled execution and price capabilities', () => {
  const input = fixture(); Object.assign(input, { authorityProofs: [], walletExecution: { receiver: {} } });
  expect(() => generate(input)).toThrow('execution_authority_metadata_required');
  Object.assign(input, { walletExecution: undefined, priceAcquisition: {} });
  expect(() => generate(input)).toThrow('price_authority_metadata_required');
});
