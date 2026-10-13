import { attachDedicatedReportedApproval, dedicatedReportedLedgerRow } from '../../apps/automation/test/reported-market-approval-fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { validateNativeSettings, verifyProvisionedContracts, assertReleaseOnlyTransition,
  assertProducerCoverage, parseRootJson, runConfiguredNativePreflight, verifyReportedPriceConfiguration } from '../postgres-address-only-configured-preflight.js';

import { createHash } from 'node:crypto';
import { createAddressOnlyWaitingDeployment } from '../create-address-only-waiting-deployment.js';
// Stable unit fixture independent of the concurrently developed configured generator.
function createAddressOnlyConfiguredDeployment(input: any) {
  const base=createAddressOnlyWaitingDeployment(input);
  return {...base,deployment:{...base.deployment,sources:{leaseMs:60000,maximumProfileAgeMs:2147483647,maximumFactAgeMs:86400000,maximumSafetyAgeMs:3600000,providerTimeoutMs:5000,maximumResponseBytes:2097152,maximumFactPayloadBytes:262144},
    wallet:{maximumProfiles:256,maximumEvents:32,collectorQuota:3,leaseMs:60000,maximumPayloadBytes:2097152,maximumRunMs:12000},
    composition:{principal:input.principal,quotas:{normalization:1,token:1,purchase:1,fanout:1,opportunity:1,capability:1,signal:1},maximumClaims:7,maximumRunMs:12000,admissionLimit:32,leaseMs:60000,retryDelayMs:60000,maximumPayloadBytes:2097152,maximumSamples:64,factLimit:32,reconcileIntervalMs:60000},walletExecution:input.walletExecution}};
}
const hash = 'a'.repeat(64);
function settings() {
  return { protocol: 'address-only-configured-preflight-settings-v1',
    credential: { path: '/private/operator.json', sha256: hash },
    providerContracts: [{ providerId: 'source', origin: 'https://source.example', importId: 'provider-import',
      sourceFingerprint: hash, windowMs: 60000, maximumRequests: 10, maximumConcurrency: 1 }],
    validators: ['execution'].map(kind => ({ kind, validatorId: kind+'-validator',
      importId: 'validators-import', sourceFingerprint: hash })),
  };
}
function manifest() {
  return { protocol: 'address-only-v1', operationId: 'op', importId: 'cohort', generationId: 'generation', activatedAt: 1,
    planSha256:hash,seedSha256:hash,cohortSha256:hash,walletCount:216,entityCount:122,releaseSha256:hash,
    backupSha256:hash,fenceSha256:hash,target:{database:'address_radar',schema:'address_radar_business',schemaFingerprint:hash,
      systemIdentifier:'123',serverAddress:'127.0.0.1',serverPort:5432},gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false };
}
describe('configured native preflight: mock DB contracts, not native proof', () => {
  it('requires actual execution contracts without fabricated price or safety authorities', () => {
    expect(validateNativeSettings(settings()).validators).toHaveLength(1);
    for (const mutate of [(x:any)=>x.providerContracts=[], (x:any)=>x.validators.pop(),
      (x:any)=>x.validators.push({...x.validators[0]}), (x:any)=>x.providerContracts[0].maximumRequests=0,
      (x:any)=>x.providerContracts[0].origin='https://user:secret@source.example',
      (x:any)=>x.providerContracts[0].sourceFingerprint='invalid']) {
      const value=settings(); mutate(value); expect(()=>validateNativeSettings(value)).toThrow();
    }
  });
  it('refuses unsupported authority metadata in the execution-only deployment', () => {
    const value=settings();value.validators.push({...value.validators[0]!,kind:'price'});
    expect(()=>validateNativeSettings(value)).toThrow();
  });
  it('allows release-only transition and refuses cohort or disabled-flag drift', () => {
    const old=manifest(), next={...old,releaseSha256:'b'.repeat(64)};
    expect(()=>assertReleaseOnlyTransition(old,next)).not.toThrow();
    for(const change of [{importId:'other'},{activatedAt:2},{gatewayDeliveryEnabled:true},{cohortSha256:'c'.repeat(64)}]) {
      expect(()=>assertReleaseOnlyTransition(old,{...next,...change})).toThrow();
    }
  });
  it('queries fixed real tables with bound contracts and rejects negative actual outcomes', async () => {
    const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[{providers_valid:true,validators_valid:true,valid_until:'5000'}],rowCount:1}));
    const runtime={run:async (op:any)=>op({query})};
    await expect(verifyProvisionedContracts(runtime as any,'address_radar_business','generation',validateNativeSettings(settings()),1000)).resolves.toBe(5000);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql,params]=query.mock.calls[0] as unknown as [string,unknown[]];
    expect(sql).toContain('"address_radar_business"."wallet_service_provider_budgets"');
    expect(sql).toContain('"wallet_service_fact_validators"');
    expect(sql).toContain("proof_scope='provider_contract'");
    expect(sql).toContain("proof_scope='validator_authority'");
    expect(sql).toContain('revoked_at IS NULL');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|GRANT)\b/);
    expect(params[0]).toBe('generation'); expect(params[5]).toBe(1);
    expect(sql).not.toContain('count(*)=5');
    for(const failed of [{providers_valid:false,validators_valid:true,valid_until:'5000'},
      {providers_valid:true,validators_valid:false,valid_until:'5000'},
      {providers_valid:true,validators_valid:true,valid_until:'1000'}]) {
      query.mockResolvedValueOnce({rows:[failed],rowCount:1});
      await expect(verifyProvisionedContracts(runtime as any,'address_radar_business','generation',validateNativeSettings(settings()),1000)).rejects.toThrow();
    }
  });
  it('requires configured RPC endpoints, source/replay coverage and real CLI authority', () => {
    const config={walletExecution:{solana:{providerId:'source',endpoint:'https://source.example/rpc'}}};
    const authority={validator:{reviewedProviderBindings:[{chain:'solana',sourceProviderId:'source',sourceEndpoint:'https://source.example/rpc',
      replayProviderId:'replay',replayEndpoint:'https://replay.example/rpc'}]}};
    const contracts=[...settings().providerContracts,{...settings().providerContracts[0]!,providerId:'replay',origin:'https://replay.example'}];
    const env={RADAR_RPC_SOLANA_HTTP_URL:'https://source.example/rpc'};
    expect(()=>assertProducerCoverage(config as any,env,authority as any,contracts)).not.toThrow();
    expect(()=>assertProducerCoverage(config as any,env,authority as any,settings().providerContracts)).toThrow();
    expect(()=>assertProducerCoverage(config as any,{...env,RADAR_RPC_SOLANA_HTTP_URL:'https://other.example'},authority as any,contracts)).toThrow();
    expect(()=>assertProducerCoverage({...config,priceAcquisition:{}} as any,env,authority as any,contracts)).toThrow();
  });
  it('refuses missing root-local authority/config before opening any DB runtime', async () => {
    const createRuntime=vi.fn();
    await expect(runConfiguredNativePreflight(Buffer.from('{}'),{createRuntime} as any)).rejects.toThrow();
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

it('retains actual root-journal nanosecond integers without IEEE-754 loss', () => {
  const row=parseRootJson('{"mtimeNs":1791457120123456789,"ctimeNs":1791457120987654321,"size":5678901234,"activatedAt":1791457120000}') as any;
  expect(row.mtimeNs).toBe('1791457120123456789');
  expect(row.ctimeNs).toBe('1791457120987654321');
  expect(row.size).toBe('5678901234');
  expect(row.activatedAt).toBe(1791457120000);
});

it('runs the real committed-startup verifier and closes the mock native port on refusal', async () => {
  const now=Date.now(), old=manifest(), next={...old,releaseSha256:'b'.repeat(64)};
  const generated=createAddressOnlyConfiguredDeployment({manifest:next as any,
    releaseRoot:'/opt/address-radar/releases/configured-test',execution:{maximumEntries:5,maximumBytes:2000000},intervalMs:15000,
    roles:Object.fromEntries(['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console']
      .map(s=>[s,'address_radar_'+s.replaceAll('-','_')])) as any,
    principal:{actorId:'operator',authorizationEvidenceRef:'approval',permissions:['target_registry_write']},
    sourceRPCRegistry:[{chain:'solana',providerId:'source',origin:'https://source.example',endpointEnvironmentKey:'RADAR_RPC_SOLANA_HTTP_URL'}],
    budgetContracts:[{providerId:'source',origin:'https://source.example',generationId:old.generationId,importId:'provider-import',
      proofScope:'provider_contract',evidenceRef:'contract',evidenceSha256:hash,importedAt:now-1,validUntil:now+60000,
      windowMs:60000,maximumRequests:10,maximumConcurrency:1}],
    authorityProofs:settings().validators.map(v=>({kind:v.kind,validatorId:v.validatorId,publisherRole:v.kind+'_publisher',
      generationId:old.generationId,evidenceRef:'authority',evidenceSha256:hash,observedAt:now-1,validUntil:now+60000})) as any,
    walletExecution:{receiver:{maximumCandidates:1,maximumRunMs:5000,maximumPayloadBytes:100000},
      solana:{providerId:'source',endpoint:'https://source.example/rpc',expectedGenesisHash:'genesis',rateLimitCooldownMs:30000,
        maximumProfiles:256,maximumRunMs:5000,maximumPayloadBytes:100000}},
  });
  Object.assign(generated.deployment.sources, { maximumExecutionFactPayloadBytes: 2097152, maximumFactResultBytes: 2097152 });
  Object.assign(generated.deployment.wallet, { maximumRunMs: 24000 });
  Object.assign(generated.deployment.lifecycle, { pollMs: 30000 });
  Object.assign(generated.deployment.walletExecution.receiver, { maximumPayloadBytes: 2097152 });
  Object.assign(generated.deployment, { executionRetry: { maximumCaptures: 1, maximumPayloadBytes: 2097152, maximumRunMs: 5000 } });

  const mapping=new Map<string,Buffer>();
  const add=(path:string,value:unknown)=>{const raw=Buffer.from(JSON.stringify(value));mapping.set(path,raw);
    return {path,sha256:createHash('sha256').update(raw).digest('hex')};};
  const contractSettings=settings();
  contractSettings.providerContracts.push({...contractSettings.providerContracts[0]!,providerId:'replay',origin:'https://replay.example'});
  const preflightPin=add('/settings',contractSettings);
  const authorityPin=add('/authority',{credential:{path:'/publisher',sha256:hash},privateKey:{path:'/key',sha256:hash},username:'execution_publisher',migrationRole:'migrator',validator:{validatorId:'execution-validator',
    reviewedProviderBindings:[{chain:'solana',sourceProviderId:'source',sourceEndpoint:'https://source.example/rpc',
      replayProviderId:'replay',replayEndpoint:'https://replay.example/rpc'}]}});
  add('/private/operator.json',{connectionString:'postgresql://address_radar_operator:secret@127.0.0.1:5432/address_radar',
    username:'address_radar_operator',gatewayDeliveryEnabled:false});
  // Mock pin reader deliberately bypasses native filesystem trust. Not native proof.
  const stamp={device:'1',inode:'2',size:'3',uid:'0',gid:'0',mode:'256',mtimeNs:'1000',ctimeNs:'1000'};
  const oldState={phase:'COMPLETE',operationId:old.operationId,manifestSha256:createHash('sha256').update(JSON.stringify(old)).digest('hex'),
    receipt:{sourceMonitoring:'waiting_configuration'},measurement:{binding:{operationId:old.operationId,importId:old.importId,
      generationId:old.generationId,planSha256:old.planSha256},backupSha256:old.backupSha256,fenceSha256:old.fenceSha256,
      sources:[{path:'/var/lib/address-radar/address-radar.db',...stamp}],backup:{path:'/backup',sha256:old.backupSha256,stamp}}};
  const env={...generated.environment,RADAR_RPC_SOLANA_HTTP_URL:'https://source.example/rpc',
    ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE:preflightPin.path,ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256:preflightPin.sha256,
    ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE:authorityPin.path,ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256:authorityPin.sha256};
  const request={walletServiceUser:{user:'wallet',group:'wallet',uid:995,gid:995},protocol:'address-only-configured-transition-v1',releaseSha256:next.releaseSha256,deadlineAtMs:now+60000,
    releaseRoot:generated.deployment.releaseRoot,environment:add('/env',env),deployment:add('/deployment',generated.deployment),
    originalManifest:add('/manifest',old),oldState:add('/state',oldState)};
  const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[{snapshot:null}],rowCount:1})),close=vi.fn(async()=>{});
  const runtime={close,probe:vi.fn(async()=>({...next.target,username:'address_radar_operator',schemaVersion:3,
    generation:next.generationId,service:'operator'})),run:async(op:any)=>op({query})};
  const createAuthority=vi.fn(),createFacts=vi.fn();
  const fakeStat={dev:1n,ino:2n,size:3n,uid:0n,gid:0n,mode:256n,nlink:1n,mtimeNs:1000n,ctimeNs:1000n,
    isFile:()=>true,isSymbolicLink:()=>false};
  await expect(runConfiguredNativePreflight(Buffer.from(JSON.stringify(request)),{
    readPin:async p=>mapping.get(p.path)!,createRuntime:()=>runtime as any,createAuthority,createFacts,
    measureRelease:async()=>next.releaseSha256,verifyEpoch:async()=>{},stat:async()=>fakeStat as any,
  })).rejects.toThrow('snapshot_bound');
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0]).toContain('wallet_service_profile_cohort');
  expect(createAuthority).not.toHaveBeenCalled();expect(createFacts).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(1);
  // Exercise the validator embedded in the actual standalone verifier, not just TS imports.
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join,resolve}=await import('node:path');
  const {pathToFileURL}=await import('node:url');
  const {buildAddressOnlyMaintenanceModule}=await import('../build-address-only-compiled-release.mjs');
  const directory=await mkdtemp(join(tmpdir(),'preflight-source-budget-schema-'));
  try {
    const output=join(directory,'preflight.mjs');
    await buildAddressOnlyMaintenanceModule({entry:resolve('scripts/postgres-address-only-configured-preflight.ts'),output,seal:false});
    const compiled=await import(pathToFileURL(output).href);
    const reported=reportedPreflightFixture();
    expect(compiled.validateNativeSettings(reported.input.settings,true).validators).toHaveLength(2);
    await expect(compiled.verifyReportedPriceConfiguration(reported.input)).resolves.toEqual({validUntil:100000,networkVerified:false,monitoringCompleted:false});
    expect(reported.query.mock.calls.every(([sql])=>! /\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
    const createRuntime=vi.fn(()=>runtime);
    await expect(compiled.runConfiguredNativePreflight(Buffer.from(JSON.stringify(request)),{
      readPin:async(p:{path:string})=>mapping.get(p.path)!,createRuntime,createAuthority,createFacts,
      measureRelease:async()=>next.releaseSha256,verifyEpoch:async()=>{},stat:async()=>fakeStat,
    })).rejects.toThrow('snapshot_bound');
    // Dedicated source/validator material is not synthesized by an otherwise valid root config.
    const selected=reported.input.config.priceAcquisition;
    const reportedDeployment={...generated.deployment,priceAcquisition:{...selected,
      source:{...selected.source,maximumRunMs:1000,maximumPayloadBytes:64000,maximumWindowMs:120000,maximumMappingAgeMs:200000},
      receiver:{maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:64000},
      retry:{maximumSamples:1,maximumRetryEntries:1,maximumMappings:1,maximumPayloadBytes:64000,maximumRunMs:1000,retryDelayMs:1000}}};
    mapping.set('/deployment',Buffer.from(JSON.stringify(reportedDeployment)));
    mapping.set('/settings',Buffer.from(JSON.stringify(reported.input.settings)));
    const noRuntime=vi.fn();
    await expect(compiled.runConfiguredNativePreflight(Buffer.from(JSON.stringify(request)),{
      readPin:async(p:{path:string})=>mapping.get(p.path)!,createRuntime:noRuntime,
    })).rejects.toThrow('reported_price_native_material_or_ports_unavailable');
    expect(noRuntime).not.toHaveBeenCalled();
    mapping.set('/deployment',Buffer.from(JSON.stringify(generated.deployment)));
    mapping.set('/settings',Buffer.from(JSON.stringify(contractSettings)));
    // The read-only fake runtime is reached only after the embedded deployment schema accepts both keys.
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(createAuthority).not.toHaveBeenCalled();expect(createFacts).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
    const invalid={...generated.deployment,sources:{...generated.deployment.sources,maximumFactResultBytes:2097153}};
    mapping.set('/deployment',Buffer.from(JSON.stringify(invalid)));
    createRuntime.mockClear();
    await expect(compiled.runConfiguredNativePreflight(Buffer.from(JSON.stringify(request)),{
      readPin:async(p:{path:string})=>mapping.get(p.path)!,createRuntime,
    })).rejects.toThrow();
    expect(createRuntime).not.toHaveBeenCalled();
    for (const executionRetry of [
      { maximumCaptures: 0, maximumPayloadBytes: 2097152, maximumRunMs: 5000 },
      { maximumCaptures: 1, maximumPayloadBytes: 2097153, maximumRunMs: 5000 },
      { maximumCaptures: 1, maximumPayloadBytes: 2097152, maximumRunMs: 5001 },
      { maximumCaptures: 1, maximumPayloadBytes: 2097152, maximumRunMs: 5000, unapproved: true },
    ]) {
      mapping.set('/deployment',Buffer.from(JSON.stringify({...generated.deployment,executionRetry})));
      createRuntime.mockClear();
      await expect(compiled.runConfiguredNativePreflight(Buffer.from(JSON.stringify(request)),{
        readPin:async(p:{path:string})=>mapping.get(p.path)!,createRuntime,
      })).rejects.toThrow();
      expect(createRuntime).not.toHaveBeenCalled();
    }
  } finally {await rm(directory,{recursive:true,force:true});}


});

it('builds a standalone verifier CLI whose refusal emits no success proof (local process, not native DB)', async () => {
  const { mkdtemp, rm }=await import('node:fs/promises');
  const { tmpdir }=await import('node:os');
  const { join, resolve }=await import('node:path');
  const { spawnSync }=await import('node:child_process');
  const { buildAddressOnlyMaintenanceModule }=await import('../build-address-only-compiled-release.mjs');
  const directory=await mkdtemp(join(tmpdir(),'configured-native-preflight-'));
  try {
    const output=join(directory,'preflight.mjs');
    const built=await buildAddressOnlyMaintenanceModule({entry:resolve('scripts/postgres-address-only-configured-preflight.ts'),output,seal:false});
    expect(built.bytes).toBeGreaterThan(0);
    const child=spawnSync(process.execPath,['--no-global-search-paths',output],{encoding:'utf8',timeout:10000,
      env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
    expect(child.status).toBe(1);expect(child.stdout).toBe('');
    expect(child.stderr).toContain('Configured native preflight refused');
  } finally { await rm(directory,{recursive:true,force:true}); }
},15000);

it('uses the real operator allocation in real business runtime options without opening a connection', async () => {
  const { operatorPreflightMaximumConnections }=await import('../postgres-address-only-configured-preflight.js');
  const { createPostgresBusinessRuntime }=await import('../../packages/database/src/postgres-business-driver.js');
  const options={connectionString:'postgresql://address_radar_operator:fixture@127.0.0.1:5432/address_radar',
    target:{database:'address_radar',schema:'radar',username:'address_radar_operator',generation:'generation',service:'operator'},
    access:'read' as const,schemaVersion:3,schemaFingerprint:hash,ssl:false as const,
    serviceConnectionBudgets:{operator:2,scanner:1},serverMaximumConnections:16,reservedConnections:3,
    maximumPendingOperations:0,connectionTimeoutMs:1000,idleTimeoutMs:1000,statementTimeoutMs:1000,
    lockTimeoutMs:500,idleTransactionTimeoutMs:1000,shutdownTimeoutMs:1000,workMemKb:1024};
  expect(()=>createPostgresBusinessRuntime({...options,maximumConnections:1})).toThrow('resource limits');
  const maximumConnections=operatorPreflightMaximumConnections(options);
  expect(maximumConnections).toBe(2);
  const runtime=createPostgresBusinessRuntime({...options,maximumConnections});
  expect(runtime.statistics().totalConnections).toBe(0);
  await runtime.close();
  for(const operator of [undefined,0,3,1.5]) {
    expect(()=>operatorPreflightMaximumConnections({serviceConnectionBudgets:{operator}} as any)).toThrow('operator_allocation');
  }
});

it.each([
  { name: 'paused', cooldown_until: 5000, requests_used: 0, leases: 0 },
  { name: 'MAX paused', cooldown_until: 9223372036854775807n, requests_used: 0, leases: 0 },
  { name: 'exhausted', cooldown_until: 0, requests_used: 10, leases: 0 },
  { name: 'live lease at concurrency limit', cooldown_until: 0, requests_used: 0, leases: 1 },
])('accepts authorized contracts while runtime is $name, without authorizing requests', async state => {
  const query=vi.fn(async(sql:string)=>{
    // Any reintroduction of availability predicates invalidates this contract-only query.
    expect(sql).not.toMatch(/cooldown_until|window_started_at|requests_used|wallet_service_provider_leases/);
    expect(sql).toContain('b.maximum_requests=w."maximumRequests"');
    expect(sql).toContain('b.maximum_concurrency=w."maximumConcurrency"');
    expect(sql).toContain('l.revoked_at IS NULL');
    expect(sql).toContain('v.valid_until>$4');
    expect(state).toBeDefined();
    return {rows:[{providers_valid:true,validators_valid:true,valid_until:'5000'}],rowCount:1};
  });
  await expect(verifyProvisionedContracts({run:async(op:any)=>op({query})} as any,
    'address_radar_business','generation',validateNativeSettings(settings()),1000)).resolves.toBe(5000);
  expect(query).toHaveBeenCalledTimes(1);
});

it('imports compiled contract verification and keeps unavailable provider budgets contract-valid without network',async()=>{
  const {mkdtemp,rm,writeFile}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join,resolve}=await import('node:path');
  const {spawnSync}=await import('node:child_process');
  const {buildAddressOnlyMaintenanceModule}=await import('../build-address-only-compiled-release.mjs');
  const parent=await mkdtemp(join(tmpdir(),'preflight-contract-smoke-'));
  try {
    const output=join(parent,'verifier.mjs'),smoke=join(parent,'smoke.mjs');
    await buildAddressOnlyMaintenanceModule({entry:resolve('scripts/postgres-address-only-configured-preflight.ts'),output,seal:false});
    await writeFile(smoke,`import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);require('node:net').Socket.prototype.connect=()=>{throw Error('NETWORK_FORBIDDEN')};
globalThis.fetch=()=>{throw Error('RPC_FORBIDDEN')};
const {verifyProvisionedContracts,runConfiguredNativePreflight}=await import(${JSON.stringify(output)});
if(typeof runConfiguredNativePreflight!=='function')throw Error('ENTRY_ABI');
const runtime={run:async op=>op({query:async sql=>{
 if(/cooldown_until|requests_used|wallet_service_provider_leases/.test(sql))throw Error('AVAILABILITY_GATE');
 return {rows:[{providers_valid:true,validators_valid:true,valid_until:'5000'}]};}})};
if(await verifyProvisionedContracts(runtime,'radar','generation',${JSON.stringify(settings())},1000)!==5000)throw Error('CONTRACT_REFUSED');
console.log('CONTRACT_ONLY_SMOKE_PASSED');`);
    const child=spawnSync(process.execPath,['--no-global-search-paths',smoke],{env:{},encoding:'utf8',timeout:5000});
    expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
    expect(child.stdout).toBe('CONTRACT_ONLY_SMOKE_PASSED\n');
  } finally {await rm(parent,{recursive:true,force:true});}
},15000);

describe('reported preflight protocol selection',()=>{
  it('requires exactly execution plus price validator contracts only when explicitly selected',()=>{
    const value=settings();value.validators.push({...value.validators[0]!,kind:'price',validatorId:'price-validator'});
    expect(()=>validateNativeSettings(value,true)).not.toThrow();
    expect(()=>validateNativeSettings(value)).toThrow();
    expect(()=>validateNativeSettings(settings(),true)).toThrow();
    value.validators[1]!.kind='safety';expect(()=>validateNativeSettings(value,true)).toThrow();
  });
  it('cannot replace the old price rejection with unbound reported provider coverage',()=>{
    const authority={validator:{reviewedProviderBindings:[{chain:'solana',sourceProviderId:'source',sourceEndpoint:'https://source.example/rpc',
      replayProviderId:'replay',replayEndpoint:'https://replay.example/rpc'}]}};
    const contracts=[...settings().providerContracts,{...settings().providerContracts[0]!,providerId:'replay',origin:'https://replay.example'}];
    const config={walletExecution:{solana:{providerId:'source',endpoint:'https://source.example/rpc'}},priceAcquisition:{protocol:'approved_reported_market_cap_v1',
      source:{providerId:'ave',baseUrl:'https://prod.ave-api.com'}}};
    const env={RADAR_RPC_SOLANA_HTTP_URL:'https://source.example/rpc'};
    expect(()=>assertProducerCoverage(config as any,env,authority as any,contracts)).toThrow('reported_price_provider_contract');
    expect(()=>assertProducerCoverage(config as any,env,authority as any,[...contracts,{...contracts[0]!,providerId:'ave',origin:'https://prod.ave-api.com'}])).not.toThrow();
  });
});

function reportedPreflightFixture() {
  const m=manifest(), map={chain:'solana' as const,tokenAddress:'1'.repeat(31)+'2',poolAddress:'1'.repeat(31)+'3',
    tokenSide:'base' as const,network:'solana',evidenceRef:'mapping',knownAt:1000};
  const raw={approvalRef:'reported-validator',generationId:m.generationId,validatorId:'price-validator',keyId:'key',actorId:'review-actor',
    providerId:'approved-ave',sourceApprovalRef:'approved-source',mappingApprovalRef:'approved-map',quoteAddress:'1'.repeat(31)+'4',
    validFrom:4000,validUntil:100000};
  const approval=attachDedicatedReportedApproval(raw,map,{database:m.target.database,schema:m.target.schema,serverAddress:'127.0.0.1',serverPort:5432,schemaVersion:3,schemaFingerprint:hash});
  const d=approval.approvalDocument,ledger=dedicatedReportedLedgerRow(approval);
  const identity={...ledger,generation_id:m.generationId,fingerprint:hash};
  let rows:Record<string,unknown>[]=[ledger];
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('reported-approval-identity')?[identity]:rows,rowCount:1}));
  const config={database:m.target.database,schema:m.target.schema,generationId:m.generationId,cutover:{addressOnly:m},
    priceAcquisition:{protocol:'approved_reported_market_cap_v1',approval:{path:'/root/reported.json',sha256:hash},
      source:{providerId:raw.providerId,baseUrl:d.source.origin,sourceApprovalRef:raw.sourceApprovalRef},
      mappings:[{mapping:map,providerId:raw.providerId,sourceApprovalRef:raw.sourceApprovalRef,mappingApprovalRef:raw.mappingApprovalRef,
        quoteAddress:raw.quoteAddress,sourceProofKind:d.sourceProofKind,candleMs:0,validFrom:raw.validFrom,validUntil:raw.validUntil}]}};
  const settingsValue=settings();settingsValue.providerContracts.push({...settingsValue.providerContracts[0]!,providerId:raw.providerId,origin:d.source.origin});
  settingsValue.validators.push({...settingsValue.validators[0]!,kind:'price',validatorId:raw.validatorId});
  const read=vi.fn(async()=>structuredClone(d));
  return {input:{config:config as any,settings:validateNativeSettings(settingsValue,true),runtime:{run:async(op:any)=>op({query})},now:()=>6000,read},
    query,read,d,setRows:(r:Record<string,unknown>[])=>{rows=r;},ledger};
}
describe('native reported configuration requires dedicated actual ledger, not candidate fabrication',()=>{
  it('inspects actual identity and ledger without RPC, signature or eligibility',async()=>{
    const f=reportedPreflightFixture();
    await expect(verifyReportedPriceConfiguration(f.input)).resolves.toEqual({validUntil:100000,networkVerified:false,monitoringCompleted:false});
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.every(([sql])=>!/\b(INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
  });
  it.each(['missing','revoked','fingerprint','candle','provider','expired','unknown-review','target','mapping'])(
    'refuses %s and never reports native authority available',async fault=>{
      const f=reportedPreflightFixture(),row={...f.ledger};
      if(fault==='missing')f.setRows([]);
      if(fault==='revoked'){row.revoked_at=5999 as any;f.setRows([row]);}
      if(fault==='fingerprint'){row.source_fingerprint='0'.repeat(64);f.setRows([row]);}
      if(fault==='candle'){row.proof_scope='validator_authority';f.setRows([row]);}
      if(fault==='provider')f.input.settings={...f.input.settings,providerContracts:settings().providerContracts};
      if(fault==='expired')f.input.now=()=>100000;
      if(fault==='unknown-review')f.read.mockImplementation(async()=>({...f.d,reviewer:{...f.d.reviewer,conflictVerdict:'unknown'}}));
      if(fault==='target')f.input.config.database='other';
      if(fault==='mapping')f.input.config.priceAcquisition.mappings[0].quoteAddress='1'.repeat(31)+'5';
      await expect(verifyReportedPriceConfiguration(f.input)).rejects.toThrow();
    });
});
