import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresCliExecutionAuthority, type PostgresCliExecutionAuthorityConfiguration, type PostgresCliAuthorityPorts } from '../postgres-service-cli-authority.js';
import type { ConfiguredPostgresServiceDeployment, ServiceFactPorts } from '../postgres-service-entry.js';

function fixture(fault?: 'provider' | 'validator' | 'cluster') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const source = { providerId: 'source', endpoint: 'https://source.example/rpc', expectedGenesisHash: 'genesis',
    maximumProfiles: 256, maximumRunMs: 5000, maximumPayloadBytes: 2097152, rateLimitCooldownMs: 30000 };
  const roles = ['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'];
  const config = { operationId: 'op', generationId: 'generation', activatedAt: 100,
    database: 'address_radar', schema: 'address_radar_business',
    services: Object.fromEntries(roles.map(role => [role, { username: role.replaceAll('-', '_') }])),
    driver: { schemaVersion: 3, schemaFingerprint: 'a'.repeat(64) },
    cutover: { addressOnly: { target: { database: 'address_radar', serverAddress: '127.0.0.1', serverPort: 5432, systemIdentifier: '123' } } },
    walletExecution: { solana: source },
  } as unknown as ConfiguredPostgresServiceDeployment;
  const settings: PostgresCliExecutionAuthorityConfiguration = {
    protocol: 'address-only-cli-execution-authority-v1', operationId: 'op', generationId: 'generation', releaseSha256: 'b'.repeat(64),
    username: 'execution_publisher', migrationRole: 'migrator', credential: { path: '/credential', sha256: 'c'.repeat(64) },
    privateKey: { path: '/key', sha256: 'd'.repeat(64) },
    validator: { validatorId: 'validator', keyId: 'key1', publicKey: pub,
      reviewedProviderBindings: [{ chain: 'solana', sourceProviderId: 'source', sourceEndpoint: source.endpoint,
        replayProviderId: 'replay', replayEndpoint: 'https://replay.example/rpc', expectedGenesisHash: 'genesis' }],
      maximumProfiles: 256, maximumRpcRequests: 32, maximumLogs: 32, maximumDecimalsReads: 8,
      maximumPayloadBytes: 2097152, maximumRunMs: 5000, validationTtlMs: 60000, maximumNonces: 64 },
    publisher: { validators: [{ validatorId: 'validator', keyId: 'key1', publicKey: pub, actorId: 'operator',
      authorizationRef: 'approval', reviewedSourceProviders: ['replay'] }], maximumValidationAgeMs: 60000,
      maximumPayloadBytes: 2097152, statementTimeoutMs: 5000, lockTimeoutMs: 1000 },
  };
  const close = vi.fn(async () => {}), queries: string[] = [];
  const runtime = { close, async run<T>(operation: (tx: { query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>): Promise<T> {
    return operation({ async query(sql) {
      queries.push(sql);
      const rows = sql.includes('cli-authority-cluster') ? [{ database: 'address_radar', username: 'execution_publisher',
        session_username: 'execution_publisher', address: '127.0.0.1', port: 5432, system_identifier: fault === 'cluster' ? 'wrong' : '123' }]
        : sql.includes('cli-authority-validator') ? (fault === 'validator' ? [] : [{ validator_id: 'validator' }])
        : fault === 'provider' ? [] : [{ provider_id: 'source', origin: 'https://source.example' }, { provider_id: 'replay', origin: 'https://replay.example' }];
      return { rows, rowCount: rows.length };
    } });
  } };
  const openRuntime = vi.fn(() => runtime) as unknown as NonNullable<PostgresCliAuthorityPorts['openRuntime']>;
  const createPublisher = vi.fn(async () => ({ publish: vi.fn() })) as unknown as NonNullable<PostgresCliAuthorityPorts['createPublisher']>;
  const fetch = vi.fn(async () => { throw new Error('No provider requests during wiring'); });
  const input = { config, env: { ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE: '/authority', ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256: 'e'.repeat(64),
    ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: 'b'.repeat(64) }, facts: { fetch, profiles: { load: vi.fn(async () => []) } } as unknown as Pick<ServiceFactPorts, 'fetch' | 'profiles'> };
  const readPin: NonNullable<PostgresCliAuthorityPorts['readPin']> = async pin => Buffer.from(pin.path === '/authority' ? JSON.stringify(settings)
    : pin.path === '/key' ? privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    : JSON.stringify({ connectionString: 'postgresql://execution_publisher:serverlocal@127.0.0.1:5432/address_radar', username: 'execution_publisher', gatewayDeliveryEnabled: false }));
  return { input, settings, ports: { readPin, openRuntime, createPublisher, now: () => 1000 }, close, queries, fetch, openRuntime, createPublisher };
}
describe('execution CLI authority wiring (mock DB, real validator construction)', () => {
  it('uses a separate publisher runtime and real Ed25519 replay validator without constructing facts', async () => {
    const f = fixture(); const authority = await createPostgresCliExecutionAuthority(f.input, f.ports);
    expect(typeof authority.executionAuthority.validator.validateExecution).toBe('function');
    expect(f.openRuntime).toHaveBeenCalledTimes(1); expect(f.createPublisher).toHaveBeenCalledTimes(1);
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.queries).toHaveLength(3);
    await authority.close(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each(['provider','validator','cluster'] as const)('rejects actual missing/mismatched %s evidence before publisher creation', async fault => {
    const f = fixture(fault); await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow();
    expect(f.createPublisher).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses missing CLI pins, release substitution and borrowing a consumer role', async () => {
    for (const kind of ['missing','release','role']) {
      const f = fixture();
      if (kind === 'missing') f.input.env.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE = '';
      if (kind === 'release') Object.assign(f.settings, { releaseSha256: 'f'.repeat(64) });
      if (kind === 'role') Object.assign(f.settings, { username: 'scanner' });
      await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow();
      expect(f.openRuntime).not.toHaveBeenCalled();
    }
  });
  it('refuses a same-host replay, closing the independent pool', async () => {
    const f = fixture(); Object.assign(f.settings.validator.reviewedProviderBindings[0]!, { replayEndpoint: 'https://source.example/other' });
    await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses a private key that does not match the approved Ed25519 public key', async () => {
    const f = fixture(), original = f.ports.readPin;
    const wrongKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    f.ports.readPin = async pin => pin.path === '/key' ? Buffer.from(wrongKey) : original(pin);
    await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow('ed25519');
    expect(f.createPublisher).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('refuses a producer endpoint substitution before opening a publisher connection', async () => {
    const f = fixture(); Object.assign(f.settings.validator.reviewedProviderBindings[0]!, { sourceEndpoint: 'https://other.example/rpc' });
    await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow('REPLAY_SOURCE');
    expect(f.openRuntime).not.toHaveBeenCalled();
  });
});

it('binds Solana genesis before opening runtime', async () => {
  const f = fixture(); Object.assign(f.settings.validator.reviewedProviderBindings[0]!, { expectedGenesisHash: 'other' });
  await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow('REPLAY_SOURCE');
  expect(f.openRuntime).not.toHaveBeenCalled();
});
it.each(['expectedChainId','expectedGenesisBlockHash','stableQuoteTokens'])('binds EVM %s before opening runtime', async field => {
  const f = fixture();
  const producer = { providerId: 'source', endpoint: 'https://source.example/rpc', expectedChainId: '0x1',
    expectedGenesisBlockHash: '0x' + 'a'.repeat(64), stableQuoteTokens: [{ address: '0x' + '1'.repeat(40), symbol: 'USDC', decimals: 6 }] };
  Object.assign(f.input.config, { walletExecution: { evm: { eth: producer } } });
  const binding = { chain: 'eth', sourceProviderId: 'source', sourceEndpoint: producer.endpoint,
    replayProviderId: 'replay', replayEndpoint: 'https://replay.example/rpc', expectedChainId: producer.expectedChainId,
    expectedGenesisBlockHash: producer.expectedGenesisBlockHash, stableQuoteTokens: producer.stableQuoteTokens };
  Object.assign(binding, { [field]: field === 'stableQuoteTokens' ? [] : 'different' });
  Object.assign(f.settings.validator, { reviewedProviderBindings: [binding] });
  await expect(createPostgresCliExecutionAuthority(f.input, f.ports)).rejects.toThrow('REPLAY_SOURCE');
  expect(f.openRuntime).not.toHaveBeenCalled();
});

it('forwards the trusted replay observer to the validator without loading it from authority JSON',async()=>{
  const f=fixture(),onRpcDiagnostic=vi.fn(),createValidator=vi.fn(()=>({validateExecution:vi.fn()}));
  await createPostgresCliExecutionAuthority({...f.input,onRpcDiagnostic},{...f.ports,createValidator});
  expect(createValidator).toHaveBeenCalledWith(expect.objectContaining({onRpcDiagnostic}));
  expect(f.fetch).not.toHaveBeenCalled();
});
