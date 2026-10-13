import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createConfiguredSourceProbeOutputDirectory, runConfiguredSourceProbeCli, parseConfiguredSourceProbeCliArgs } from '../probe-address-only-configured-source-cli.js';
import { runtimeAuthorityFingerprint } from '../provision-address-only-runtime-authority.js';
import { SOLANA_MAINNET_GENESIS } from '../probe-address-only-configured-source.js';
import type { PostgresBusinessRuntime } from '../../packages/database/src/postgres-business-driver.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
describe('exclusive output directory durability before probe IO', () => {
  it.each(['success', 'open failure', 'sync failure'])('orders parent fsync before DB/RPC: %s', async fault => {
    const f = fixture(), events: string[] = [];
    const output = '/var/lib/address-radar-maintenance-tools/probe-exclusive';
    const io = {
      mkdir: vi.fn(async (path: string, options: unknown) => {
        expect(path).toBe(output); expect(options).toEqual({ mode: 0o700 }); events.push('mkdir');
      }),
      open: vi.fn(async (path: string, flags: number) => {
        const { constants } = await import('node:fs');
        expect(path).toBe('/var/lib/address-radar-maintenance-tools');
        expect(flags).toBe(constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        events.push('open-parent');
        if (fault === 'open failure') throw Error('open failed');
        return {
          sync: async () => { events.push('sync-parent'); if (fault === 'sync failure') throw Error('sync failed'); },
          close: async () => { events.push('close-parent'); },
        };
      }),
    } as unknown as Parameters<typeof createConfiguredSourceProbeOutputDirectory>[1];
    const execute = async () => {
      await createConfiguredSourceProbeOutputDirectory(output, io);
      events.push('probe');
      return runConfiguredSourceProbeCli(f.job, new AbortController().signal, f.ports);
    };
    if (fault === 'success') {
      await execute();
      expect(events).toEqual(['mkdir', 'open-parent', 'sync-parent', 'close-parent', 'probe']);
      expect(f.createRuntime).toHaveBeenCalledOnce(); expect(f.network).toHaveBeenCalledOnce();
    } else {
      await expect(execute()).rejects.toThrow();
      expect(events).toEqual(fault === 'open failure' ? ['mkdir', 'open-parent']
        : ['mkdir', 'open-parent', 'sync-parent', 'close-parent']);
      expect(f.ports.readPin).not.toHaveBeenCalled(); expect(f.createRuntime).not.toHaveBeenCalled();
      expect(f.runtime.probe).not.toHaveBeenCalled(); expect(f.queries).toEqual([]);
      expect(f.network).not.toHaveBeenCalled();
    }
  });
});
function fixture() {
  const at = 100_000, keys = generateKeyPairSync('ed25519'), files = new Map<string, Buffer>();
  const put = (name: string, value: unknown) => { const raw = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const path = '/private/' + name; files.set(path, raw); return { path, sha256: hash(raw) }; };
  const source = 'https://solana-rpc.publicnode.com', replay = 'https://api.mainnet-beta.solana.com';
  const validator = { validatorId: 'validator', keyId: 'key', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    reviewedProviderBindings: [{ chain: 'solana', sourceProviderId: 'publicnode-source', sourceEndpoint: source,
      replayProviderId: 'official-replay', replayEndpoint: replay, expectedGenesisHash: SOLANA_MAINNET_GENESIS }],
    maximumProfiles: 10, maximumRpcRequests: 4, maximumLogs: 10, maximumDecimalsReads: 4,
    maximumPayloadBytes: 128_000, maximumRunMs: 5000, validationTtlMs: 60_000, maximumNonces: 10 };
  const configuration = { kind: 'execution', validatorId: 'validator', importId: 'validator-import', evidenceSha256: 'f'.repeat(64),
    importedAt: 1000, validFrom: 1000, validUntil: 500_000, keyId: 'key', publicKey: validator.publicKey,
    actorId: 'independent-operator', authorizationRef: 'execution-approval', reviewedSourceProviders: ['official-replay'] };
  const authority = put('authority', { protocol: 'address-only-cli-execution-authority-v1', operationId: 'operation', generationId: 'generation',
    releaseSha256: 'c'.repeat(64), validator, privateKey: put('key', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    publisher: { validators: [{ ...configuration }] } });
  const contracts = ['publicnode-source', 'official-replay'].map((providerId, i) => ({ providerId,
    origin: i ? replay : source, importId: 'import-' + providerId, sourceFingerprint: 'a'.repeat(64), windowMs: 60_000, maximumRequests: 60, maximumConcurrency: 1 }));
  const services = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console'];
  const manifest = { protocol: 'address-only-v1', operationId: 'operation', importId: 'cohort', generationId: 'generation', activatedAt: 1000,
    planSha256: 'a'.repeat(64), seedSha256: 'b'.repeat(64), cohortSha256: 'd'.repeat(64), walletCount: 1, entityCount: 1,
    releaseSha256: 'c'.repeat(64), backupSha256: 'd'.repeat(64), fenceSha256: 'e'.repeat(64),
    target: { database: 'radar_business', schema: 'radar_generation', schemaFingerprint: 'a'.repeat(64), systemIdentifier: '123', serverAddress: '127.0.0.1', serverPort: 5432 },
    gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false };
  const config = { format: 1, operationId: 'operation', generationId: 'generation', activatedAt: 1000, cohortId: 'cohort',
    database: 'radar_business', schema: 'radar_generation', releaseRoot: '/sealed', cutover: { addressOnly: manifest },
    gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
    lifecycle: { startupMs: 2000, pollMs: 30_000, shutdownMs: 200, killMs: 200 }, execution: { maximumEntries: 5, maximumBytes: 1000 },
    driver: { schemaVersion: 3, schemaFingerprint: 'a'.repeat(64), serviceConnectionBudgets: Object.fromEntries(services.map(s => [s, 1])) },
    services: Object.fromEntries(services.map(s => [s, { username: 'radar_' + s.replaceAll('-', '_'), maximumConnections: 1, intervalMs: 1000 }])),
    sources: { leaseMs: 5000, maximumProfileAgeMs: 60_000, maximumFactAgeMs: 60_000, maximumSafetyAgeMs: 10_000,
      providerTimeoutMs: 1000, maximumResponseBytes: 128_000, maximumFactPayloadBytes: 128_000 },
    wallet: { maximumProfiles: 10, maximumEvents: 10, collectorQuota: 1, leaseMs: 60_000, maximumPayloadBytes: 128_000, maximumRunMs: 24_000 },
    walletExecution: { solana: { providerId: 'publicnode-source', endpoint: source, expectedGenesisHash: SOLANA_MAINNET_GENESIS,
      rateLimitCooldownMs: 1000, maximumProfiles: 10, maximumRunMs: 5000, maximumPayloadBytes: 128_000 },
      receiver: { maximumCandidates: 1, maximumRunMs: 5000, maximumPayloadBytes: 128_000 } },
    composition: { principal: { actorId: 'actor', authorizationEvidenceRef: 'approval', permissions: ['target_registry_write'] },
      quotas: Object.fromEntries(['normalization', 'token', 'purchase', 'fanout', 'opportunity', 'capability', 'signal'].map(s => [s, 1])),
      maximumClaims: 7, maximumRunMs: 500, admissionLimit: 1, leaseMs: 1000, retryDelayMs: 1000,
      maximumPayloadBytes: 128_000, maximumSamples: 1, factLimit: 1, reconcileIntervalMs: 1000 },
    console: { host: '127.0.0.1', port: 3211, maximumTraceRows: 20 } };
  const deployment = put('deployment', config), settings = put('settings', { protocol: 'address-only-configured-preflight-settings-v1', providerContracts: contracts });
  const environment = put('environment', { ADDRESS_RADAR_DATABASE_BACKEND: 'postgresql', ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: 'false',
    ADDRESS_RADAR_FOMO_BROWSER_ENABLED: 'false', ADDRESS_RADAR_FOMO_CAPTURE_ENABLED: 'false', ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED: 'false',
    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE: deployment.path, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: deployment.sha256,
    ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE: authority.path, ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256: authority.sha256,
    ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE: settings.path, ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256: settings.sha256,
    ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: 'c'.repeat(64), ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: 'd'.repeat(64), RADAR_RPC_SOLANA_HTTP_URL: source });
  const wallet = '11111111111111111111111111111111';
  const fact = { entityId: 'entity', channel: 'wallet', subjectId: wallet, walletFamily: 'solana', associationConfidence: 'confirmed', associationSource: 'fixture',
    ownerCount: 1, walletConfidence: 'confirmed', walletSource: 'fixture', identityEvidenceRef: 'identity', ownershipEvidenceRef: 'owner', monitoringEnabled: true, suspended: false };
  const profile = { wallet: { address: wallet, accountId: 'account', entityId: 'entity', lifecycle: 'active' }, fact,
    profileEnabled: true, profileSuspended: false, bindingState: 'owned', versionId: 'version' };
  const payload = put('payload', { schemaVersion: 1, generationId: 'generation', collectorId: 'solana', chainFamily: 'solana', profile,
    event: { eventId: 'event', chain: 'solana', walletAddress: wallet, tokenAddress: 'TokenCase', side: 'buy', occurredAt: 90_000,
      amountUsd: null, priceUsd: null, marketCapUsd: null, sourceReference: 'solana:fixture-signature' }, purchase: null, externalBasis: null, entryPriceBasis: null });
  const runtimeAuthority = put('runtime-authority', { approvalRef: 'ledger-approval', target: { database: config.database, schema: config.schema, generationId: config.generationId, systemIdentifier: '123' }, validators: [configuration] });
  const credential = put('credential', { username: 'radar_wallet_monitor', connectionString: 'postgresql://radar_wallet_monitor:secret@127.0.0.1:5432/radar_business', gatewayDeliveryEnabled: false });
  const job = put('job', { protocol: 'address-only-configured-source-probe-job-v1', deadlineAtMs: 110_000,
    deployment, environment, authority, settings, runtimeAuthority, credential, payload, maximumRunMs: 5000, maximumBodyBytes: 128_000 });
  const network = vi.fn(async () => new Response('private', { status: 403 }));
  const queries: string[] = []; let approved = true;
  const runtime = { probe: vi.fn(async () => ({ database: config.database, schema: config.schema, generation: config.generationId,
    username: 'radar_wallet_monitor', service: 'wallet-monitor', serverAddress: '127.0.0.1', serverPort: 5432, schemaVersion: 3, schemaFingerprint: 'a'.repeat(64) })),
    close: vi.fn(async () => {}), run: async (fn: (tx: unknown) => Promise<unknown>) => fn({ query: async (sql: string) => {
      queries.push(sql); let rows: unknown[] = [];
      if (sql.includes('source-probe-cli-cluster')) rows = [{ system_identifier: '123', username: 'radar_wallet_monitor', session_username: 'radar_wallet_monitor' }];
      if (sql.includes('configured-source-probe-approval')) rows = [{ approved }];
      if (sql.includes('service-fact-profile-cohort')) rows = [{ proof_scope: 'legacy_registry_linkage', import_revoked_at: null, imported_at: 1000,
        observed_at: 90_000, enabled: true, suspended: false, profile_payload: JSON.stringify(profile), channel_payload: JSON.stringify(fact),
        entity_id: 'entity', wallet_family: 'solana', subject_key: JSON.stringify(["wallet", "solana", wallet]), profile_known_at: 1000, channel_known_at: 1000,
        owner_entity_id: 'entity', conflict_at: null, profile_version_id: 'version', channel_version_id: 'version' }];
      if (sql.includes('service-provider-budget-lock')) rows = [{ provider_id: 'publicnode-source', window_started_at: 90_000, window_ms: 60_000,
        maximum_requests: 60, requests_used: 0, maximum_concurrency: 1, active_leases: 0, cooldown_until: 0 }];
      if (sql.includes('service-provider-budget-debit')) rows = [{ provider_id: 'publicnode-source' }];
      if (sql.includes('service-provider-cooldown')) rows = [{ cooldown_until: 160_000 }];
      return { rows, rowCount: rows.length };
    } }) } as unknown as PostgresBusinessRuntime;
  const createRuntime = vi.fn(() => runtime), verifyRelease = vi.fn(async () => ({ root: '/sealed', releaseSha256: 'c'.repeat(64) }));
  const readPin = vi.fn(async (p: { path: string; sha256: string }) => { const raw = files.get(p.path)!; if (!raw || hash(raw) !== p.sha256) throw Error('bad pin'); return raw; });
  return { job, config, deployment, files, put, network, queries, runtime, createRuntime, setApproved: (v: boolean) => { approved = v; },
    ports: { readPin, createRuntime, verifyRelease, now: () => at, transport: network },
    fingerprint: runtimeAuthorityFingerprint({ approvalRef: 'ledger-approval', proofScope: 'validator_authority', configuration }) };
}

describe('native configured source probe CLI composition (isolated ports only)', () => {
  it('requires exact pinned job arguments', () => {
    expect(() => parseConfiguredSourceProbeCliArgs(['--job', '/private/job'])).toThrow();
    expect(() => parseConfiguredSourceProbeCliArgs(['--job', '/private/job', '--job-sha256', 'a'.repeat(64), '--unsafe'])).toThrow();
  });
  it.each([401, 403, 429])('composes real core and guarded adapter, stopping on %s and releasing the lease', async (status) => {
    const f = fixture(); f.network.mockImplementation(async () => new Response('private', { status })); const receipt = await runConfiguredSourceProbeCli(f.job, new AbortController().signal, f.ports);
    expect(receipt).toMatchObject({ status: 'deferred', reasonCode: status === 429 ? 'probe_rate_limited' : 'probe_access_denied', sourceRequests: 1, replayRequests: 0 });
    expect(f.network).toHaveBeenCalledOnce(); expect(f.queries.some(s => s.includes('service-provider-release'))).toBe(true);
    expect(f.queries.some(s => /INSERT INTO wallet_service_fact|UPDATE.*checkpoints/.test(s))).toBe(false);
    expect(f.runtime.close).toHaveBeenCalledOnce(); expect(JSON.stringify(receipt)).not.toMatch(/secret|https:|signature/);
  });
  it('refuses missing ledger approval with zero RPC', async () => {
    const f = fixture(); f.setApproved(false);
    expect(await runConfiguredSourceProbeCli(f.job, new AbortController().signal, f.ports)).toMatchObject({ reasonCode: 'probe_approval_unavailable' });
    expect(f.network).not.toHaveBeenCalled(); expect(f.runtime.close).toHaveBeenCalledOnce();
  });
  it('rejects invalid job pin and aborted invocation without opening a runtime', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(runConfiguredSourceProbeCli(f.job, controller.signal, f.ports)).rejects.toThrow();
    await expect(runConfiguredSourceProbeCli({ ...f.job, sha256: '0'.repeat(64) }, new AbortController().signal, f.ports)).rejects.toThrow();
    expect(f.createRuntime).not.toHaveBeenCalled(); expect(f.network).not.toHaveBeenCalled();
  });
});

it.each(['budget', 'target', 'source', 'price'])('refuses invalid pinned %s material with zero RPC', async fault => {
  const f = fixture();
  const job = JSON.parse(f.files.get(f.job.path)!.toString());
  const env = JSON.parse(f.files.get(job.environment.path)!.toString());
  if (fault === 'budget') {
    const settings = JSON.parse(f.files.get(job.settings.path)!.toString());
    settings.providerContracts[0].maximumRequests = 61;
    job.settings = f.put('settings-invalid', settings);
    env.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE = job.settings.path;
    env.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256 = job.settings.sha256;
  }
  if (fault === 'target') {
    const material = JSON.parse(f.files.get(job.runtimeAuthority.path)!.toString());
    material.target.systemIdentifier = '999'; job.runtimeAuthority = f.put('runtime-invalid', material);
  }
  if (fault === 'source') env.RADAR_RPC_SOLANA_HTTP_URL = 'https://old.example';
  if (fault === 'price') {
    const config = JSON.parse(f.files.get(job.deployment.path)!.toString());
    config.priceAcquisition = {}; job.deployment = f.put('deployment-invalid', config);
    env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE = job.deployment.path;
    env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256 = job.deployment.sha256;
  }
  job.environment = f.put('environment-invalid', env);
  await expect(runConfiguredSourceProbeCli(f.put('job-invalid', job), new AbortController().signal, f.ports)).rejects.toThrow();
  expect(f.network).not.toHaveBeenCalled(); expect(f.createRuntime).not.toHaveBeenCalled();
});

it('refuses actual cluster identity drift without fetching and closes the runtime', async () => {
  const f = fixture(); const original = f.runtime.probe;
  f.runtime.probe = vi.fn(async () => ({ ...await original(), username: 'wrong-role' }));
  await expect(runConfiguredSourceProbeCli(f.job, new AbortController().signal, f.ports)).rejects.toThrow();
  expect(f.network).not.toHaveBeenCalled(); expect(f.runtime.close).toHaveBeenCalledOnce();
});

it('executes the real CLI in a subprocess and refuses missing arguments without IO authority', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../probe-address-only-configured-source-cli.ts', import.meta.url))],
    { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  expect(child.status).toBe(1);
  expect(JSON.parse(child.stdout.trim())).toEqual({ status: 'refused_or_uncertain', retryAuthorized: false, factsPublished: false });
  expect(child.stderr).toBe('');
});

it('projects only public sealed-verifier inputs, never private configuration or environment', async () => {
  const { configuredSourceVerifierSummary } = await import('../probe-address-only-configured-source-cli.js');
  const f = fixture();
  const summary = configuredSourceVerifierSummary(f.config, {
    ADDRESS_RADAR_POSTGRES_ENTRY_SHA256: 'a'.repeat(64), ADDRESS_RADAR_POSTGRES_RELEASE_SHA256: 'b'.repeat(64),
    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: 'c'.repeat(64), ADDRESS_RADAR_POSTGRES_URL: 'postgresql://secret',
    RADAR_RPC_SOLANA_HTTP_URL: 'https://secret-key', PRIVATE_KEY: 'private-key',
  });
  expect(Object.keys(summary.deployment).sort()).toEqual(['cutover', 'execution', 'releaseRoot']);
  expect(summary.env.ADDRESS_RADAR_POSTGRES_URL).toBe('verification-only');
  expect(JSON.stringify(summary)).not.toMatch(/secret|private-key|publicnode|approval|username/);
  expect(summary.env.ADDRESS_RADAR_POSTGRES_POLL_MS).toBe('30000');
  expect(configuredSourceVerifierSummary(f.config, { ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: 'true' }).env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED).toBe('true');
});

it('refuses pre-aborted native verification before any child can start', async () => {
  const { verifyConfiguredSourceRelease } = await import('../probe-address-only-configured-source-cli.js');
  const f = fixture(), controller = new AbortController(), audit = vi.fn(); controller.abort();
  await expect(verifyConfiguredSourceRelease(f.config, {}, controller.signal, audit)).rejects.toThrow();
  expect(audit).not.toHaveBeenCalled();
});

it.skipIf(process.env.ADDRESS_RADAR_PROBE_VERIFIER_NATIVE !== '1')('verifies the formal root-private bundle as actual unprivileged Linux identity', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const output = await mkdtemp(join(tmpdir(), 'probe-verifier-native-'));
  const builderUrl = pathToFileURL(fileURLToPath(new URL('../build-address-only-compiled-release.mjs', import.meta.url))).href;
  const { buildAddressOnlyMaintenanceModule } = await import(builderUrl);
  await buildAddressOnlyMaintenanceModule({ entry: fileURLToPath(new URL('../probe-address-only-configured-source-cli.ts', import.meta.url)),
    output: join(output, 'probe.mjs'), seal: false });
  await writeFile(join(output, 'native.mjs'), `
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import assert from 'node:assert/strict';
import { configuredSourceVerifierSummary, verifyConfiguredSourceRelease } from '/opt/probe/probe.mjs';
const root='/opt/probe-release'; mkdirSync(root+'/scripts',{recursive:true});
const body=Buffer.from('export {};\\n');writeFileSync(root+'/scripts/postgres-service-entry.mjs',body,{mode:0o444});
chmodSync(root+'/scripts',0o555);chmodSync(root,0o555);
const sha=b=>createHash('sha256').update(b).digest('hex');
const entry=sha(body),h=createHash('sha256');
for(const v of [{path:'.',mode:365,kind:'directory'},{path:'scripts',mode:365,kind:'directory'},
 {path:'scripts/postgres-service-entry.mjs',mode:292,kind:'file',size:body.length,sha256:entry}])h.update(JSON.stringify(v)+'\\n');
const env={ADDRESS_RADAR_DATABASE_BACKEND:'postgresql',ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED:'false',
 ADDRESS_RADAR_POSTGRES_ENTRY_SHA256:entry,ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:h.digest('hex'),
 ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256:'c'.repeat(64),ADDRESS_RADAR_POSTGRES_EXECUTION_FORMAT:'compiled-esm',
 ADDRESS_RADAR_POSTGRES_URL:'postgresql://private-secret',RADAR_RPC_SOLANA_HTTP_URL:'https://private-secret'};
const config={releaseRoot:root,execution:{maximumEntries:3,maximumBytes:body.length},executionFormat:'compiled-esm',
 lifecycle:{startupMs:2000,pollMs:30000,shutdownMs:1000,killMs:1000}};
process.argv[1]='/opt/probe/probe.mjs';
const audit=[];assert(!JSON.stringify(configuredSourceVerifierSummary(config,env)).includes('private-secret'));
const sealed=await verifyConfiguredSourceRelease(config,env,new AbortController().signal,a=>audit.push(a));
assert.equal(sealed.releaseSha256,env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256);
assert.equal(audit.at(-1).uid,65534);assert.equal(audit.at(-1).gid,65534);
assert.equal(audit.at(-1).pid,audit.at(-1).pgid);assert(audit.at(-1).groups.every(g=>g===65534));
await assert.rejects(()=>verifyConfiguredSourceRelease(config,{...env,ADDRESS_RADAR_POSTGRES_ENTRY_SHA256:'0'.repeat(64)},new AbortController().signal));
const c=new AbortController();c.abort();await assert.rejects(()=>verifyConfiguredSourceRelease(config,env,c.signal));
const interrupted=new AbortController();
const interruptTimer=setTimeout(()=>interrupted.abort(),5);
await assert.rejects(()=>verifyConfiguredSourceRelease(config,env,interrupted.signal));clearTimeout(interruptTimer);
const timeoutAudit=[];
writeFileSync('/opt/probe/hanging.mjs','setInterval(()=>{},1000);',{mode:0o400});
process.argv[1]='/opt/probe/hanging.mjs';
await assert.rejects(()=>verifyConfiguredSourceRelease(config,env,new AbortController().signal,a=>timeoutAudit.push(a)));
assert.equal(timeoutAudit.at(-1).signal,'SIGKILL');assert(timeoutAudit.at(-1).elapsedMs>=10000);
process.argv[1]='/opt/probe/probe.mjs';
chmodSync(root+'/scripts/postgres-service-entry.mjs',0o644);
await assert.rejects(()=>verifyConfiguredSourceRelease(config,env,new AbortController().signal));
console.log(JSON.stringify({status:'PASS',audit,timeoutAudit}));
`, { mode: 0o600 });
  const child = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', output + ':/input:ro', '--entrypoint', '/bin/bash',
    'address-radar-source-execute-isolated:node24-20261011', '-c',
    'mkdir -m700 /opt/probe; cp /input/probe.mjs /opt/probe/probe.mjs; chmod 400 /opt/probe/probe.mjs; /usr/local/bin/node /input/native.mjs'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_384 });
  expect(child.error).toBeUndefined(); expect(child.stderr).toBe(''); expect(child.status).toBe(0);
  const receipt = JSON.parse(child.stdout.trim()); expect(receipt.status).toBe('PASS');
  expect(receipt.audit.at(-1)).toMatchObject({ status: 'verified', uid: 65534, gid: 65534 });
  await writeFile(join(output, 'receipt.json'), child.stdout, { mode: 0o600 });
  console.info('Native verifier receipt: ' + join(output, 'receipt.json'));
}, 40_000);
