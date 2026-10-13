import { createPostgresCliReportedPriceAuthority } from './postgres-reported-price-cli-authority.js';
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresBusinessRuntime, type PostgresBusinessRuntime } from '../packages/database/src/postgres-business-driver.js';
import { createPostgresServiceFactAdapters } from '../apps/automation/src/postgres-service-fact-adapters.js';
import { selectPostgresWalletProfiles } from '../apps/wallet-monitor/src/postgres-wallet-channel.js';
import { loadWalletMonitorConfig } from '../apps/wallet-monitor/src/config.js';
import { validateAddressOnlyStartupManifest, verifyAddressOnlyCommittedStartup, type AddressOnlyStartupManifest } from '../apps/automation/src/postgres-address-only-startup.js';
import { addressOnlySafetyEnvironmentDigest, validateAddressOnlyStartupEvidence, verifyAddressOnlySourceEpoch } from './postgres-address-only-startup-evidence.js';
import { readPrivateAuthorityPin, createPostgresCliExecutionAuthority, type PostgresCliExecutionAuthorityConfiguration } from './postgres-service-cli-authority.js';
import { createPostgresRootWalletExecutionReceiver, validatePostgresServiceDeployment, type ConfiguredPostgresServiceDeployment } from './postgres-service-entry.js';
import { composePostgresServicePriceDependencies, type PostgresNativeReportedMarketCapAuthorityInput } from './postgres-price-authority.js';
import { verifyReportedMarketApprovalConfiguration, readRootReportedMarketApproval, validateReportedMarketApproval } from './postgres-reported-market-approval.js';
import type { ServiceEnvironment } from '../packages/database/src/postgres-service-dispatch.js';

type Pin = { readonly path: string; readonly sha256: string };
type Provider = { readonly providerId: string; readonly origin: string; readonly importId: string; readonly sourceFingerprint: string;
  readonly windowMs: number; readonly maximumRequests: number; readonly maximumConcurrency: number };
type Validator = { readonly kind: string; readonly validatorId: string; readonly importId: string; readonly sourceFingerprint: string };
export interface NativeConfiguredSettings {
  readonly protocol: 'address-only-configured-preflight-settings-v1'; readonly credential: Pin;
  readonly providerContracts: readonly Provider[]; readonly validators: readonly Validator[];
}
const kinds = ['execution'];
const maximumBytes = 524288;
const sha = (raw: Uint8Array | string) => createHash('sha256').update(raw).digest('hex');
function demand(value: unknown, code: string): asserts value { if (!value) throw new Error(`configured_preflight:${code}`); }
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && Buffer.byteLength(value) <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
function object(value: unknown): Record<string, unknown> {
  demand(value && typeof value === 'object' && !Array.isArray(value), 'object'); return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: string[]) {
  demand(Object.keys(value).sort().join(',') === [...names].sort().join(','), 'exact_fields');
}
function pin(value: unknown): Pin {
  const p = object(value); exact(p, ['path','sha256']);
  demand(typeof p.path === 'string' && isAbsolute(p.path) && resolve(p.path) === p.path && hash(p.sha256), 'pin');
  return p as unknown as Pin;
}
/** Node 24 JSON source text preserves Python journal stamps beyond MAX_SAFE_INTEGER. */
export function parseRootJson(raw: string): unknown {
  return JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => {
    if (['device','inode','size','mtimeNs','ctimeNs'].includes(key) && typeof value === 'number') {
      demand(typeof context?.source === 'string' && /^(0|[1-9][0-9]*)$/.test(context.source), 'lossless_root_stamp');
      return context.source;
    }
    return value;
  });
}
function asciiJson(value: unknown): string {
  // Match the root Python journal's compact ensure_ascii=True representation.
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
}
export function validateNativeSettings(value: unknown, reportedPrice = false): NativeConfiguredSettings {
  const v = object(value); exact(v, ['protocol','credential','providerContracts','validators']);
  demand(v.protocol === 'address-only-configured-preflight-settings-v1', 'settings_protocol'); pin(v.credential);
  demand(Array.isArray(v.providerContracts) && v.providerContracts.length > 0 && v.providerContracts.length <= 64, 'providers');
  const ids = new Set(), origins = new Set();
  for (const input of v.providerContracts) {
    const p = object(input); exact(p, ['providerId','origin','importId','sourceFingerprint','windowMs','maximumRequests','maximumConcurrency']);
    demand(id(p.providerId) && id(p.importId) && hash(p.sourceFingerprint) && typeof p.origin === 'string', 'provider_identity');
    const url = new URL(p.origin);
    demand(url.protocol === 'https:' && !url.username && !url.password && url.origin === p.origin
      && !ids.has(p.providerId) && !origins.has(p.origin), 'provider_origin');
    demand([p.windowMs,p.maximumRequests,p.maximumConcurrency].every(positive), 'provider_budget');
    ids.add(p.providerId); origins.add(p.origin);
  }
  const requiredKinds = reportedPrice ? [...kinds,'price'] : kinds;
  demand(Array.isArray(v.validators) && v.validators.length === requiredKinds.length, 'execution_validator_required');
  const seen = new Set();
  for (const input of v.validators) {
    const a = object(input); exact(a, ['kind','validatorId','importId','sourceFingerprint']);
    demand(typeof a.kind === 'string' && requiredKinds.includes(a.kind) && !seen.has(a.kind)
      && id(a.validatorId) && id(a.importId) && hash(a.sourceFingerprint), 'validator_binding'); seen.add(a.kind);
  }
  return structuredClone(v) as unknown as NativeConfiguredSettings;
}
export function assertReleaseOnlyTransition(oldValue: unknown, nextValue: unknown): void {
  const old = validateAddressOnlyStartupManifest(oldValue), next = validateAddressOnlyStartupManifest(nextValue);
  demand(old.releaseSha256 !== next.releaseSha256, 'new_release');
  for (const key of Object.keys(old) as (keyof AddressOnlyStartupManifest)[]) {
    if (key !== 'releaseSha256') demand(asciiJson(old[key]) === asciiJson(next[key]), 'nonrelease_manifest_drift');
  }
}
// Contract authorization is independent of transient runtime budget availability.
// Runtime acquisition still enforces cooldown, window usage and concurrent leases.
export async function verifyProvisionedContracts(runtime: Pick<PostgresBusinessRuntime,'run'>, schema: string, generation: string,
  settings: NativeConfiguredSettings, at: number): Promise<number> {
  demand(/^[a-z_][a-z0-9_]{0,62}$/.test(schema) && !schema.startsWith('pg_') && schema !== 'public', 'schema');
  const s = `"${schema}"`;
  const result = await runtime.run(tx => tx.query(`/* configured-native-contracts: read only */ WITH
    wanted_providers AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
      "providerId" text,origin text,"importId" text,"sourceFingerprint" text,"windowMs" integer,"maximumRequests" integer,"maximumConcurrency" integer)),
    wanted_validators AS MATERIALIZED (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(
      kind text,"validatorId" text,"importId" text,"sourceFingerprint" text)),
    providers AS (SELECT w."providerId", (SELECT count(*)=1 AND coalesce(bool_and(
      b.origin=w.origin AND b.import_id=w."importId" AND l.source_fingerprint=w."sourceFingerprint"
      AND l.proof_scope='provider_contract' AND l.imported_at<=$4 AND l.revoked_at IS NULL
      AND b.window_ms=w."windowMs" AND b.maximum_requests=w."maximumRequests" AND b.maximum_concurrency=w."maximumConcurrency"
),false)
      FROM (SELECT * FROM ${s}."wallet_service_provider_budgets" WHERE generation_id=$1 AND provider_id=w."providerId" LIMIT 2) b
      JOIN ${s}."wallet_service_import_ledger" l ON l.generation_id=b.generation_id AND l.import_id=b.import_id) valid
      FROM wanted_providers w),
    validators AS (SELECT w.kind, (SELECT count(*)=1 AND coalesce(bool_and(
      v.import_id=w."importId" AND l.source_fingerprint=w."sourceFingerprint" AND l.proof_scope='validator_authority'
      AND l.imported_at<=$4 AND l.revoked_at IS NULL AND v.revoked_at IS NULL AND v.valid_from<=$4 AND v.valid_until>$4),false)
      FROM (SELECT * FROM ${s}."wallet_service_fact_validators" WHERE generation_id=$1 AND kind=w.kind AND validator_id=w."validatorId" LIMIT 2) v
      JOIN ${s}."wallet_service_import_ledger" l ON l.generation_id=v.generation_id AND l.import_id=v.import_id) valid,
      (SELECT min(valid_until) FROM ${s}."wallet_service_fact_validators"
        WHERE generation_id=$1 AND kind=w.kind AND validator_id=w."validatorId") valid_until FROM wanted_validators w)
    SELECT (SELECT count(*)=$5 AND coalesce(bool_and(valid),false) FROM providers) providers_valid,
      (SELECT count(*)=$6 AND coalesce(bool_and(valid),false) FROM validators) validators_valid,
      (SELECT min(valid_until)::text FROM validators) valid_until`,
    [generation,JSON.stringify(settings.providerContracts),JSON.stringify(settings.validators),at,settings.providerContracts.length,settings.validators.length]));
  const row = result.rows[0], until = Number(row?.valid_until);
  demand(result.rows.length === 1 && row?.providers_valid === true && row.validators_valid === true
    && Number.isSafeInteger(until) && until > at, 'actual_provisioned_contracts'); return until;
}
export function assertProducerCoverage(config: ConfiguredPostgresServiceDeployment, env: ServiceEnvironment,
  authority: PostgresCliExecutionAuthorityConfiguration, contracts: readonly Provider[]): void {
  demand(config.walletExecution, 'execution_cli_required');
  demand(!config.priceAcquisition || config.priceAcquisition.protocol === 'approved_reported_market_cap_v1', 'price_protocol_not_wired');
  if (config.priceAcquisition) demand(contracts.some(contract => contract.providerId === config.priceAcquisition!.source.providerId
    && contract.origin === config.priceAcquisition!.source.baseUrl), 'reported_price_provider_contract');
  const endpoints = loadWalletMonitorConfig(env).endpoints;
  const pairs = authority.validator?.reviewedProviderBindings;
  demand(Array.isArray(pairs) && pairs.length > 0, 'reviewed_replay_bindings');
  const contract = new Map(contracts.map(c => [c.providerId,c.origin]));
  const chains = ['solana','eth','bsc','base'] as const;
  let enabled = 0;
  for (const chain of chains) {
    const producer = chain === 'solana' ? config.walletExecution.solana : config.walletExecution.evm?.[chain];
    if (!producer) { demand(!endpoints[chain], 'unwired_collector'); continue; }
    enabled++;
    demand(endpoints[chain]?.primary === producer.endpoint && !endpoints[chain]?.fallback, 'collector_producer_endpoint');
    const pair = pairs.find(p => p.chain === chain);
    demand(pair && pair.sourceProviderId === producer.providerId && pair.sourceEndpoint === producer.endpoint
      && pair.replayProviderId !== pair.sourceProviderId && new URL(pair.replayEndpoint).origin !== new URL(pair.sourceEndpoint).origin,
      'independent_replay_coverage');
    for (const [provider,endpoint] of [[pair.sourceProviderId,pair.sourceEndpoint],[pair.replayProviderId,pair.replayEndpoint]]) {
      demand(contract.get(provider!) === new URL(endpoint!).origin, 'provisioned_source_and_replay_contracts');
    }
  }
  demand(enabled > 0 && Object.keys(endpoints).length === enabled, 'exact_collector_coverage');
}
/** Configuration/ledger proof only; never performs provider requests or grants eligibility. */
export async function verifyReportedPriceConfiguration(input: {
  config: ConfiguredPostgresServiceDeployment; settings: NativeConfiguredSettings;
  runtime: Pick<PostgresBusinessRuntime,'run'>; now: () => number;
  read?: typeof readRootReportedMarketApproval;
}) {
  const p = input.config.priceAcquisition;
  demand(p?.protocol === 'approved_reported_market_cap_v1', 'reported_price_protocol');
  const read = input.read ?? readRootReportedMarketApproval;
  const document = validateReportedMarketApproval(await read(p.approval));
  const target = input.config.cutover.addressOnly?.target;
  demand(target && document.target.database === input.config.database && document.target.schema === input.config.schema
    && document.target.generationId === input.config.generationId && document.target.systemIdentifier === target.systemIdentifier
    && document.target.serverAddress === target.serverAddress && document.target.serverPort === target.serverPort
    && document.target.schemaFingerprint === target.schemaFingerprint && document.target.schemaVersion === 3
    && document.source.providerId === p.source.providerId && document.source.origin === p.source.baseUrl
    && document.source.sourceApprovalRef === p.source.sourceApprovalRef && p.mappings.length === 1, 'reported_price_document_binding');
  const binding = p.mappings[0]!;
  demand(JSON.stringify(binding.mapping) === JSON.stringify(document.mapping) && binding.mappingApprovalRef === document.mappingApprovalRef
    && binding.sourceApprovalRef === document.source.sourceApprovalRef && binding.providerId === document.source.providerId
    && binding.sourceProofKind === document.sourceProofKind && binding.candleMs === 0
    && 'quoteAddress' in binding && binding.quoteAddress === document.quoteAddress
    && binding.validFrom === document.validFrom && binding.validUntil === document.validUntil
    && input.settings.validators.some(v => v.kind === 'price' && v.validatorId === document.validator.validatorId)
    && input.settings.providerContracts.some(v => v.providerId === document.source.providerId && v.origin === document.source.origin), 'reported_price_contract_binding');
  await verifyReportedMarketApprovalConfiguration({pin:p.approval,target:document.target,run:input.runtime.run,now:input.now,read});
  return { validUntil: document.validUntil, networkVerified:false, monitoringCompleted:false };
}
async function protectedParents(path: string): Promise<void> {
  demand(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'canonical_protected_path');
  for (let parent = dirname(path);;) {
    const s = await lstat(parent);
    demand(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'protected_parent');
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
}
async function readProbe(path: string): Promise<Buffer> {
  await protectedParents(path);
  const f = await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stamp = (s: import('node:fs').BigIntStats) => [s.dev,s.ino,s.size,s.mode,s.uid,s.gid,s.nlink,s.mtimeNs,s.ctimeNs].join(':');
  try {
    const before = await f.stat({bigint:true});
    demand(before.isFile() && before.uid === 0n && before.nlink === 1n && !(before.mode & 0o077n)
      && before.size > 0n && before.size <= BigInt(maximumBytes), 'probe_file');
    const raw = Buffer.alloc(Number(before.size)+1); let offset=0;
    while(offset<raw.length) { const r=await f.read(raw,offset,raw.length-offset,null); if(!r.bytesRead) break; offset+=r.bytesRead; }
    demand(offset===Number(before.size) && stamp(before)===stamp(await f.stat({bigint:true}))
      && stamp(before)===stamp(await lstat(path,{bigint:true})), 'probe_changed'); return raw.subarray(0,offset);
  } finally { await f.close(); }
}
export async function sealedRelease(config: ConfiguredPostgresServiceDeployment, check:()=>void): Promise<string> {
  const root=config.releaseRoot, limits=config.execution, digest=createHash('sha256'); let entries=0, bytes=0;
  demand(Number.isSafeInteger(limits.maximumEntries) && limits.maximumEntries>0 && limits.maximumEntries<=10000
    && Number.isSafeInteger(limits.maximumBytes) && limits.maximumBytes>0 && limits.maximumBytes<=128*1024**2, 'release_bounds');
  await protectedParents(root); const device=(await lstat(root)).dev;
  async function walk(path:string):Promise<void> {
    check(); const s=await lstat(path,{bigint:true});
    demand(++entries<=limits.maximumEntries && s.uid===0n && !(s.mode&0o222n) && s.dev===BigInt(device)
      && !s.isSymbolicLink() && (s.isDirectory()||s.isFile()), 'release_seal');
    const name=relative(root,path).split('\\').join('/')||'.';
    if(s.isDirectory()) {
      digest.update(JSON.stringify({path:name,mode:Number(s.mode&0o777n),kind:'directory'})+'\n');
      const names:string[]=[]; for await(const child of await opendir(path)) {
        demand(names.length<limits.maximumEntries-entries,'release_entries'); names.push(child.name);
      }
      for(const child of names.sort()) await walk(join(path,child));
    } else {
      demand(s.nlink===1n && s.size<=BigInt(limits.maximumBytes-bytes),'release_bytes'); bytes+=Number(s.size);
      const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const raw=Buffer.alloc(Number(s.size)+1); let offset=0;
        while(offset<raw.length) { check(); const r=await f.read(raw,offset,raw.length-offset,null); if(!r.bytesRead)break; offset+=r.bytesRead; }
        const after=await f.stat({bigint:true}), live=await lstat(path,{bigint:true});
        const stamp=(v:typeof s)=>[v.dev,v.ino,v.size,v.mode,v.uid,v.gid,v.nlink,v.mtimeNs,v.ctimeNs].join(':');
        demand(offset===Number(s.size)&&stamp(s)===stamp(after)&&stamp(s)===stamp(live),'release_changed');
        digest.update(JSON.stringify({path:name,mode:Number(s.mode&0o777n),kind:'file',size:offset,sha256:sha(raw.subarray(0,offset))})+'\n');
      } finally { await f.close(); }
    }
  }
  await walk(root); check(); return digest.digest('hex');
}
export function operatorPreflightMaximumConnections(driver: {
  readonly serviceConnectionBudgets: Readonly<Record<string, number>>;
}): number {
  const allocation = driver.serviceConnectionBudgets.operator;
  if (typeof allocation !== 'number') throw new Error('operator_allocation');
  demand(Number.isSafeInteger(allocation) && allocation >= 1 && allocation <= 2, 'operator_allocation');
  return allocation;
}
export interface NativePreflightPorts {
  readonly readPin?: typeof readPrivateAuthorityPin;
  readonly createRuntime?: typeof createPostgresBusinessRuntime;
  readonly createFacts?: typeof createPostgresServiceFactAdapters;
  readonly createAuthority?: typeof createPostgresCliExecutionAuthority;
  /** Trusted native loader must own credential/key/budget-bound ports and cleanup. No CLI fallback. */
  readonly createReportedPriceAuthority?: (input: { config: ConfiguredPostgresServiceDeployment; runtime: PostgresBusinessRuntime;
    facts: Awaited<ReturnType<typeof createPostgresServiceFactAdapters>>; environment: ServiceEnvironment; signal: AbortSignal }) => Promise<{
      native: Omit<PostgresNativeReportedMarketCapAuthorityInput,'deployment'|'signal'>; close(): Promise<void> }>;

  readonly measureRelease?: typeof sealedRelease;
  readonly verifyEpoch?: typeof verifyAddressOnlySourceEpoch;
  readonly stat?: typeof lstat;
}
/** Test ports are not exposed by the CLI. Production always uses native connections and sealed code. */
export async function runConfiguredNativePreflight(raw:Buffer, ports:NativePreflightPorts={}) {
  demand(raw.length>0 && raw.length<=maximumBytes,'request_bound');
  const request=object(JSON.parse(raw.toString('utf8')));
  demand(request.protocol==='address-only-configured-transition-v1' && hash(request.releaseSha256)
    && Number.isSafeInteger(request.deadlineAtMs) && Number(request.deadlineAtMs)>Date.now(), 'transition');
  const deadline=Math.min(Number(request.deadlineAtMs),Date.now()+55000);
  const signal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
  const check=()=>{signal.throwIfAborted();demand(Date.now()<deadline,'deadline');};
  const read=ports.readPin??readPrivateAuthorityPin;
  const load=async(p:unknown)=>{check();const raw=await read(pin(p));check();return object(parseRootJson(raw.toString('utf8')));};
  const environment=await load(request.environment) as ServiceEnvironment;
  addressOnlySafetyEnvironmentDigest(environment);
  const settingsValue=await load({path:environment.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE,
    sha256:environment.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256});
  demand(environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE && hash(environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256),'execution_authority_pin');
  const authoritySettings=await load({path:environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE,
    sha256:environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256}) as unknown as PostgresCliExecutionAuthorityConfiguration;
  const original=validateAddressOnlyStartupManifest(await load(request.originalManifest));
  const deployment=validatePostgresServiceDeployment(await load(request.deployment),environment);
  demand(deployment.sources.mode===undefined && deployment.wallet && deployment.composition && deployment.cutover.addressOnly,'configured_only');
  const config=deployment as ConfiguredPostgresServiceDeployment, manifest=config.cutover.addressOnly!;
  const reportedPrice = config.priceAcquisition?.protocol === 'approved_reported_market_cap_v1';
  const settings=validateNativeSettings(settingsValue,reportedPrice);
  if (reportedPrice) demand(ports.createReportedPriceAuthority || environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE
    && hash(environment.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256),'reported_price_native_material_or_ports_unavailable');
  assertReleaseOnlyTransition(original,manifest);
  demand(config.releaseRoot===request.releaseRoot && manifest.releaseSha256===request.releaseSha256,'release_binding');
  const old=await load(request.oldState);
  demand(old.phase==='COMPLETE' && old.operationId===manifest.operationId && old.manifestSha256===sha(asciiJson(original))
    && object(old.receipt).sourceMonitoring==='waiting_configuration','completed_waiting_origin');
  const measurement=object(old.measurement), binding=object(measurement.binding);
  demand(['operationId','importId','generationId','planSha256'].every(k=>binding[k]===manifest[k as keyof typeof manifest])
    && measurement.backupSha256===manifest.backupSha256 && measurement.fenceSha256===manifest.fenceSha256,'measured_origin');
  const evidence=validateAddressOnlyStartupEvidence({protocol:'address-only-native-startup-evidence-v1',
    operationId:manifest.operationId,importId:manifest.importId,generationId:manifest.generationId,
    releaseSha256:manifest.releaseSha256,backupSha256:measurement.backupSha256,fenceSha256:measurement.fenceSha256,
    deploymentSha256:sha(asciiJson(config)),safetyEnvironmentSha256:addressOnlySafetyEnvironmentDigest(environment),measuredAt:Date.now(),
    sourceEpoch:(measurement.sources as Record<string,unknown>[]).map(row=>({path:row.path,
      ...Object.fromEntries(['device','inode','size','uid','gid','mode','mtimeNs','ctimeNs'].map(k=>[k,String(row[k])]))})),
    sourceSealed:true,importCommitted:true,gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false},manifest);
  await (ports.verifyEpoch??verifyAddressOnlySourceEpoch)(evidence); check();
  const backup=object(measurement.backup), expected=object(backup.stamp);
  demand(typeof backup.path==='string' && backup.sha256===manifest.backupSha256,'backup_binding');
  const statPort=ports.stat??lstat, backupStat=await statPort(backup.path,{bigint:true});
  const actual={device:backupStat.dev,inode:backupStat.ino,size:backupStat.size,uid:backupStat.uid,gid:backupStat.gid,
    mode:backupStat.mode&0o777n,mtimeNs:backupStat.mtimeNs,ctimeNs:backupStat.ctimeNs};
  demand(backupStat.isFile() && !backupStat.isSymbolicLink() && backupStat.nlink===1n && backupStat.uid===0n
    && backupStat.gid===0n && (backupStat.mode&0o777n)===0o400n
    && Object.entries(actual).every(([k,v])=>String(v)===String(expected[k])),'sealed_backup_epoch');
  const releaseSha=await (ports.measureRelease??sealedRelease)(config,check); check();
  demand(releaseSha===manifest.releaseSha256,'actual_release');
  assertProducerCoverage(config,environment,authoritySettings,settings.providerContracts);
  demand(settings.validators.find(v=>v.kind==='execution')?.validatorId===authoritySettings.validator.validatorId,'execution_validator_binding');
  const credential=await load(settings.credential);
  demand(typeof credential.connectionString==='string' && typeof credential.username==='string' && credential.gatewayDeliveryEnabled===false,'operator_credential');
  const url=new URL(credential.connectionString);
  demand(url.protocol==='postgresql:' && url.hostname==='127.0.0.1' && url.port==='5432' && url.pathname==='/'+config.database
    && decodeURIComponent(url.username)===credential.username && url.password && !url.search && !url.hash
    && !Object.values(config.services).some(s=>s.username===credential.username)
    && credential.username!==authoritySettings.username && credential.username!==authoritySettings.migrationRole,'independent_readonly_operator');
  const milliseconds=Math.max(1,deadline-Date.now());
  const runtime=(ports.createRuntime??createPostgresBusinessRuntime)({...config.driver,connectionString:credential.connectionString,
    maximumConnections:operatorPreflightMaximumConnections(config.driver),access:'read',target:{database:config.database,schema:config.schema,generation:config.generationId,
      username:credential.username,service:'operator'},connectionTimeoutMs:Math.min(config.driver.connectionTimeoutMs,milliseconds),
    statementTimeoutMs:Math.min(config.driver.statementTimeoutMs,5000,milliseconds),
    lockTimeoutMs:Math.min(config.driver.lockTimeoutMs,1000,milliseconds),shutdownTimeoutMs:Math.min(config.driver.shutdownTimeoutMs,milliseconds)});
  let authority:Awaited<ReturnType<typeof createPostgresCliExecutionAuthority>>|undefined;
  let priceAuthority: Awaited<ReturnType<NonNullable<NativePreflightPorts['createReportedPriceAuthority']>>> | undefined;
  let proof:Record<string,unknown>;
  try {
    const identity=await runtime.probe(); check();
    await verifyAddressOnlyCommittedStartup({manifest,runtime,identity,releaseSha256:releaseSha,
      backupSha256:manifest.backupSha256,fenceSha256:manifest.fenceSha256,disabledFlags:evidence,
      deadline:new Date(deadline).toISOString(),signal}); check();
    let validUntil=await verifyProvisionedContracts(runtime,config.schema,config.generationId,settings,Date.now()); check();
    const facts=await (ports.createFacts??createPostgresServiceFactAdapters)({runtime,generationId:config.generationId,
      maximumProfiles:config.wallet.maximumProfiles,now:Date.now,sources:config.sources}); check();
    demand(typeof facts.profiles.load==='function' && typeof facts.fetch==='function'
      && ['purchase','prices','target','safety'].every(k=>typeof facts.facts[k as keyof typeof facts.facts]==='function'),'actual_fact_ports');
    for(const family of ['solana','evm'] as const) {
      if(family==='solana'?!config.walletExecution?.solana:!Object.keys(config.walletExecution?.evm??{}).length)continue;
      const profiles=await facts.profiles.load({generationId:config.generationId,chainFamily:family,asOf:Date.now(),
        limit:config.wallet.maximumProfiles,signal}); check();
      demand(profiles.status==='ready' && selectPostgresWalletProfiles(profiles.profiles,family).length>0,'current_monitorable_profiles');
    }
    if (reportedPrice) {
      const approval = await verifyReportedPriceConfiguration({config,settings,runtime,now:Date.now,
        read:ports.readPin ? async pin=>validateReportedMarketApproval(parseRootJson((await read(pin)).toString('utf8'))) : readRootReportedMarketApproval}); check();
      validUntil=Math.min(validUntil,approval.validUntil);
      priceAuthority=ports.createReportedPriceAuthority
        ? await ports.createReportedPriceAuthority({config,runtime,facts,environment,signal})
        : await createPostgresCliReportedPriceAuthority({config,facts,env:{...environment,ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:releaseSha},signal}); check();
      const composed=await composePostgresServicePriceDependencies({service:'scanner',deployment:config,
        dependencies:{nativeReportedMarketCapAuthority:priceAuthority.native},signal}); check();
      demand(composed.priceAuthority?.validator && composed.priceAuthority.publisher,'reported_price_actual_authority_ports');
    }
    const authorityEnv={...environment,ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:releaseSha};
    authority=await (ports.createAuthority??createPostgresCliExecutionAuthority)({config,env:authorityEnv,facts}); check();
    demand(typeof authority.executionAuthority.validator.validateExecution==='function'
      && typeof authority.executionAuthority.publisher.publish==='function','actual_execution_authority_ports');
    const receiver=createPostgresRootWalletExecutionReceiver({config,ports:facts,authority:authority.executionAuthority,now:Date.now});
    demand(receiver && typeof receiver.receive==='function','actual_producer_receiver');
    await (ports.verifyEpoch??verifyAddressOnlySourceEpoch)(evidence); check();
    demand(await (ports.measureRelease??sealedRelease)(config,check)===releaseSha,'release_changed');
    const measuredAtMs=Date.now();
    proof={protocol:'address-only-configured-native-preflight-v1',inputSha256:sha(raw),measuredAtMs,
      expiresAtMs:Math.min(deadline,validUntil,measuredAtMs+60000),configurationValidated:true,committedStartupVerified:true,
      sourceEpochVerified:true,databaseContractsVerified:true,authorityPortsVerified:true,producerWiringVerified:true,
      authorityScope:reportedPrice?'execution-and-reported-price':'execution-only',configuredCapabilities:reportedPrice?['execution','reported-price']:['execution'],missingCapabilities:reportedPrice?['safety','radar']:['price','safety','radar'],
      deferredCapabilities:{price:reportedPrice?'reported_price_pending_observation':'price_acquisition_not_configured',safety:'independent_safety_authorities_not_wired',radar:'price_and_safety_missing'},
      networkVerified:false,completeRadarLoopVerified:false,providerRequests:0,factsPublished:0,
      monitoringCompleted:false,businessEligibilityGranted:false,gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false};
  } finally {
    try { if(priceAuthority)await priceAuthority.close(); } finally { try { if(authority)await authority.close(); } finally { await runtime.close(); } }
  }
  check(); demand(Number(proof.expiresAtMs)>Date.now(),'proof_expired_during_cleanup'); return proof;
}

if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    demand(process.geteuid?.()===0 && process.platform==='linux' && process.argv.length===3,'native_root_cli');
    demand(!['NODE_OPTIONS','NODE_PATH','NODE_COMPILE_CACHE','NODE_PG_FORCE_NATIVE'].some(k=>process.env[k]!==undefined),'ambient_loader');
    const proof=await runConfiguredNativePreflight(await readProbe(process.argv[2]!));
    process.stdout.write(JSON.stringify(proof)+'\n');
  } catch {
    process.stderr.write('Configured native preflight refused; no deployment authorization issued\n'); process.exitCode=1;
  }
}
