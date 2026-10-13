import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { POSTGRES_BUSINESS_SERVICES } from '../../packages/database/src/postgres-service-dispatch.js';
import { createAddressOnlyServerMaterials, parseServerRpcEnvironment, type AddressOnlyServerMaterialInput, type AddressOnlyServerMaterialPorts } from '../create-address-only-server-material.js';
const at = 1800000000000, hash = 'a'.repeat(64);
function fixture() {
  const input: AddressOnlyServerMaterialInput = {
    protocol: 'address-only-server-material-input-v1', outputDirectory: '/etc/address-radar/material-test', walletMonitorUser: 'wallet_private',
    environmentFiles: [{ path: '/etc/address-radar/existing.env', sha256: hash }], publisherUsername: 'execution_publisher', migrationRole: 'migrator',
    validatorId: 'validator', keyId: 'key1', actorId: 'operator', authorizationRef: 'approval',
    rpc: [{ chain: 'solana', sourceProviderId: 'source', replayProviderId: 'replay', sourceEnvironmentKey: 'RADAR_RPC_SOLANA_HTTP_URL',
      replayEnvironmentKey: 'RADAR_RPC_SOLANA_FALLBACK_HTTP_URL', expectedGenesisHash: 'genesis' }],
    configured: {
      manifest: { protocol: 'address-only-v1', operationId: 'op', importId: 'import', generationId: 'gen', activatedAt: at - 1000,
        planSha256: hash, seedSha256: hash, cohortSha256: hash, walletCount: 216, entityCount: 122, releaseSha256: hash,
        backupSha256: hash, fenceSha256: hash, gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
        target: { database: 'address_radar', schema: 'address_radar_business', schemaFingerprint: hash, systemIdentifier: '123', serverAddress: '127.0.0.1', serverPort: 5432 } },
      releaseRoot: '/opt/address-radar/releases/test', execution: { maximumEntries: 5, maximumBytes: 2000000 }, intervalMs: 15000,
      roles: Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(s => [s, 'address_radar_' + s.replaceAll('-', '_')])) as AddressOnlyServerMaterialInput['configured']['roles'],
      principal: { actorId: 'operator', authorizationEvidenceRef: 'approval', permissions: ['target_registry_write'] },
      budgetContracts: ['source','replay'].map(id => ({ providerId: id, origin: `https://${id}.example`, generationId: 'gen', importId: id,
        proofScope: 'provider_contract', evidenceRef: 'approval', evidenceSha256: hash, importedAt: at - 1000, validUntil: at + 60000,
        windowMs: 60000, maximumRequests: 60, maximumConcurrency: 1 })),
      authorityProofs: [{ kind: 'execution', generationId: 'gen', validatorId: 'validator', publisherRole: 'execution_publisher',
        evidenceRef: 'approval', evidenceSha256: hash, observedAt: at - 1000, validUntil: at + 60000 }],
    },
  };
  const files = new Map<string, { raw: Buffer; uid: number | undefined }>();
  const ports: { -readonly [K in keyof AddressOnlyServerMaterialPorts]: AddressOnlyServerMaterialPorts[K] } = {
    requireRoot() {}, now: () => at, consumerUser: async () => 'consumer',
    resolveUser: async username => ({ username, uid: username === 'wallet_private' ? 1001 : 1002, gid: 100 }),
    readPin: async () => Buffer.from('RADAR_RPC_SOLANA_HTTP_URL=https://source.example/?key=private-source\nRADAR_RPC_SOLANA_FALLBACK_HTTP_URL=https://replay.example/?key=private-replay\n'),
    createDirectory: async () => {}, finishDirectory: async () => {}, verifyAccess: async () => {},
    publishFile: async (path, raw, owner) => { files.set(path, { raw, uid: owner?.uid }); return { path, sha256: createHash('sha256').update(raw).digest('hex') }; },
  };
  return { input, ports, files };
}
describe('server-local private material generation', () => {
  it('generates matching private key and pinned authority for wallet UID only, returning no secrets', async () => {
    const f = fixture(), receipt = await createAddressOnlyServerMaterials(f.input, f.ports);
    for (const name of ['publisher.json','validator.pem','execution-authority.json','wallet-monitor-rpc.env']) {
      expect(f.files.get(f.input.outputDirectory + '/' + name)?.uid).toBe(1001);
    }
    const privateKey = createPrivateKey(f.files.get(receipt.privateKey.path)!.raw);
    expect(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()).toBe(receipt.publicKey);
    const authority = JSON.parse(f.files.get(receipt.authority.path)!.raw.toString());
    expect(authority.credential).toEqual(receipt.credential);
    expect(receipt.resources.allocatedConnections).toBe(11);
    expect(receipt.rpcEnvironmentUsage).toEqual({ purpose: 'audit-material-only', serviceEnvironmentFileAllowed: false,
      controllerEnvironmentPolicy: 'source-primary-only', sourcePrimaryEnvironmentKeys: ['RADAR_RPC_SOLANA_HTTP_URL'],
      replayConfigurationLocation: 'execution-authority.json', configuredChains: ['solana'], unconfiguredChains: ['eth','bsc','base'] });
    expect(receipt.productionConfigured).toBe(false); expect(receipt.monitoringCompleted).toBe(false);
    expect(JSON.stringify(receipt)).not.toMatch(/private-source|private-replay|postgresql:|PRIVATE KEY/);
    expect(f.files.get(receipt.configuredDeployment.path)!.uid).toBeUndefined();
  });
  it('refuses a shared consumer UID before any publication', async () => {
    const f = fixture(); f.ports.resolveUser = async username => ({ username, uid: 1001, gid: 100 });
    await expect(createAddressOnlyServerMaterials(f.input, f.ports)).rejects.toThrow('UID_SHARED'); expect(f.files.size).toBe(0);
  });
  it.each(['missing_rpc','missing_proof','wrong_policy'])('fails closed for %s before publication', async fault => {
    const f = fixture();
    if (fault === 'missing_rpc') f.ports.readPin = async () => Buffer.from('OTHER=value');
    if (fault === 'missing_proof') Object.assign(f.input.configured, { authorityProofs: [] });
    if (fault === 'wrong_policy') Object.assign(f.input.configured.budgetContracts[0]!, { maximumRequests: 61 });
    await expect(createAddressOnlyServerMaterials(f.input, f.ports)).rejects.toThrow(); expect(f.files.size).toBe(0);
  });
  it('does not reuse a directory or publish a completion receipt after access failure', async () => {
    const f = fixture(); f.ports.createDirectory = async () => { throw new Error('EEXIST'); };
    await expect(createAddressOnlyServerMaterials(f.input, f.ports)).rejects.toThrow('EEXIST'); expect(f.files.size).toBe(0);
    const g = fixture(); g.ports.verifyAccess = async () => { throw new Error('ACCESS_DENIED'); };
    await expect(createAddressOnlyServerMaterials(g.input, g.ports)).rejects.toThrow('ACCESS_DENIED');
    expect(g.files.has(g.input.outputDirectory + '/material-receipt.json')).toBe(false);
  });
  it('parses literal values without shell expansion and refuses conflicting duplicates', () => {
    expect(parseServerRpcEnvironment(Buffer.from('RADAR_RPC_SOLANA_HTTP_URL="https://rpc.example/$KEY"')).RADAR_RPC_SOLANA_HTTP_URL).toContain('$KEY');
    expect(() => parseServerRpcEnvironment(Buffer.from('RADAR_RPC_SOLANA_HTTP_URL=a\nRADAR_RPC_SOLANA_HTTP_URL=b'))).toThrow('DUPLICATE');
    expect(() => parseServerRpcEnvironment(Buffer.from('RADAR_RPC_SOLANA_HTTP_URL=`command`'))).toThrow();
  });
});

it('feeds byte-identical runtime/maintenance credentials into the real provisioner contract', async () => {
  const { mkdtemp, writeFile, copyFile, chmod, readFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { validateRuntimeAuthorityInput, createScramVerifier, passwordMatchesVerifier } = await import('../provision-address-only-runtime-authority.js');
  const f = fixture(), generationId = 'production-20261006-v1';
  Object.assign(f.input.configured.manifest, { generationId });
  for (const p of [...f.input.configured.budgetContracts, ...f.input.configured.authorityProofs]) Object.assign(p, { generationId });
  const receipt = await createAddressOnlyServerMaterials(f.input, f.ports);
  const dir = await mkdtemp(join(tmpdir(), 'material-provision-contract-'));
  try {
    const runtime = join(dir, 'runtime.json'), maintenance = join(dir, 'maintenance.json');
    await writeFile(runtime, f.files.get(receipt.credential.path)!.raw, { mode: 0o400 });
    await copyFile(runtime, maintenance); await chmod(maintenance, 0o600);
    const raw = await readFile(maintenance), credential = JSON.parse(raw.toString());
    expect(raw.equals(await readFile(runtime))).toBe(true);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(receipt.credential.sha256);
    expect((await stat(runtime)).mode & 0o777).toBe(0o400);
    expect((await stat(maintenance)).mode & 0o777).toBe(0o600);
    const authority = JSON.parse(f.files.get(receipt.authority.path)!.raw.toString());
    const job = {
      version: 1 as const, approvalRef: 'approval', approvedAt: at - 1000, expiresAt: at + 30000,
      target: { ...f.input.configured.manifest.target, generationId, adminUsername: 'postgres', schemaVersion: 3 },
      publisherRole: f.input.publisherUsername, forbiddenRoles: { ...f.input.configured.roles, migrator: f.input.migrationRole },
      cohort: { importId: 'cohort-import', wallets: 216, entities: 122, sha256: hash },
      credential: { path: '/var/lib/address-radar-maintenance-tools/authority/publisher.json', sha256: receipt.credential.sha256 },
      adminCredential: { mode: 'peer' as const, socketDirectory: '/var/run/postgresql' },
      providers: f.input.configured.budgetContracts.map(p => ({ providerId: p.providerId, origin: p.origin, importId: 'import-' + p.providerId,
        evidenceSha256: p.evidenceSha256, importedAt: at - 1000, windowStartedAt: at - 1000, requestsUsed: 0, cooldownUntil: 0 })),
      validators: [{ kind: 'execution' as const, validatorId: f.input.validatorId, importId: 'validator-import', evidenceSha256: hash,
        importedAt: at - 1000, validFrom: at - 1000, validUntil: at + 60000, ...authority.publisher.validators[0] }],
    };
    // Cross-module validation uses the actual generated bytes, not a separately mocked credential.
    expect(() => validateRuntimeAuthorityInput(job, credential, at)).not.toThrow();
    expect(credential.service).toBe('execution-publisher');
    const password = decodeURIComponent(new URL(credential.connectionString).password);
    expect(password).toMatch(/^[a-f0-9]{64}$/);
    expect(passwordMatchesVerifier(password, createScramVerifier(password))).toBe(true);
    expect(() => validateRuntimeAuthorityInput({ ...job, credential: receipt.credential }, credential, at)).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
