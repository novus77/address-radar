import { constants } from 'node:fs';
import { open, lstat, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createPostgresServiceFactAdapters } from '../apps/automation/src/postgres-service-fact-adapters.js';
import { createPostgresBusinessRuntime, type PostgresBusinessRuntime } from '../packages/database/src/postgres-business-driver.js';
import type { ServiceEnvironment } from '../packages/database/src/postgres-service-dispatch.js';
import { sealedRelease } from './postgres-address-only-configured-preflight.js';
import { readPrivateAuthorityPin, type PostgresCliExecutionAuthorityConfiguration } from './postgres-service-cli-authority.js';
import { validatePostgresServiceDeployment, type ConfiguredPostgresServiceDeployment } from './postgres-service-entry.js';
import type { FetchLike } from '../packages/collectors/src/types.js';

type Pin = { path: string; sha256: string };
type Chain = 'eth' | 'bsc' | 'base';
type Header = { number: number; hash: string; parentHash: string; timestamp: number };
export interface FloorProvider {
  chain: Chain; providerId: string; endpoint: string; expectedChainId: string; expectedGenesisBlockHash: string;
}
export interface FloorJob {
  protocol: 'address-only-evm-floor-job-v1';
  generationId: string; activatedAt: number; releaseSha256: string;
  deployment: Pin; environment: Pin; credential: Pin; currentJournal: Pin; currentReceipt: Pin;
  receiptPath: string;
}
const hash = (raw: string | Uint8Array) => createHash('sha256').update(raw).digest('hex');
const demand: (value: unknown) => asserts value = value => { if (!value) throw new Error('EVM_FLOOR_REFUSED'); };
const object = (value: unknown): Record<string, any> => {
  demand(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, any>;
};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const blockHash = (value: unknown): value is string => typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value);
const clock = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function pin(value: unknown): Pin {
  const p = object(value);
  demand(Object.keys(p).sort().join(',') === 'path,sha256' && typeof p.path === 'string'
    && isAbsolute(p.path) && resolve(p.path) === p.path && digest(p.sha256)); return p as Pin;
}
export function validateFloorJob(value: unknown): FloorJob {
  const j = object(value);
  demand(Object.keys(j).sort().join(',') === ['protocol','generationId','activatedAt','releaseSha256','deployment',
    'environment','credential','currentJournal','currentReceipt','receiptPath'].sort().join(','));
  demand(j.protocol === 'address-only-evm-floor-job-v1' && typeof j.generationId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(j.generationId) && clock(j.activatedAt) && digest(j.releaseSha256));
  for (const k of ['deployment','environment','credential','currentJournal','currentReceipt']) pin(j[k]);
  demand(typeof j.receiptPath === 'string' && isAbsolute(j.receiptPath) && resolve(j.receiptPath) === j.receiptPath
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.json$/.test(j.receiptPath.slice(dirname(j.receiptPath).length + 1)));
  return j as FloorJob;
}
function quantity(value: unknown): number {
  demand(typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][a-fA-F0-9]*)$/.test(value));
  const n = Number(BigInt(value)); demand(clock(n)); return n;
}
function header(value: unknown): Header {
  const v = object(value); demand(blockHash(v.hash) && blockHash(v.parentHash));
  const timestamp = quantity(v.timestamp); demand(timestamp <= Math.floor(Number.MAX_SAFE_INTEGER / 1000));
  return { number: quantity(v.number), hash: v.hash.toLowerCase(), parentHash: v.parentHash.toLowerCase(), timestamp };
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, any>> {
  demand(response.ok && !response.redirected && response.body);
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted(); const item = await abortable(() => reader.read(),signal); if (item.done) break;
      size += item.value.byteLength; demand(size <= 262144); chunks.push(item.value);
    }
    signal.throwIfAborted(); return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally { await reader.cancel().catch(() => undefined); }
}
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve,reject) => {
    abort = () => reject(new Error('EVM_FLOOR_REFUSED'));
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation(),stopped]); }
  finally { signal.removeEventListener('abort',abort); }
}
/** No raw transport port exists here: the caller supplies the existing durable-budget fetch. */
export async function measureEvmFloors(input: {
  providers: readonly FloorProvider[]; activatedAt: number; fetch: FetchLike; signal: AbortSignal;
  monotonicNow?: () => number;
}) {
  const now = input.monotonicNow ?? (() => performance.now()), started = now();
  demand(clock(input.activatedAt) && input.providers.length > 0 && input.providers.length <= 3);
  const seen = new Set<string>(), origins = new Map<string,string>();
  for (const p of input.providers) {
    const url = new URL(p.endpoint);
    demand(['eth','bsc','base'].includes(p.chain) && !seen.has(p.chain) && p.providerId.length > 0
      && url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && /^(?:[1-9][0-9]*|0x[1-9a-fA-F][a-fA-F0-9]*)$/.test(p.expectedChainId) && blockHash(p.expectedGenesisBlockHash));
    demand(!origins.has(url.origin) || origins.get(url.origin) === p.providerId);
    origins.set(url.origin,p.providerId); seen.add(p.chain);
  }
  const calls = new Map<string,number>(), floors: Partial<Record<Chain,number>> = {}, chains = [];
  const check = () => { input.signal.throwIfAborted(); demand(now() - started < 180000); };
  for (const p of input.providers) {
    const chainStarted = now();
    const rpc = async (method: 'eth_chainId' | 'eth_getBlockByNumber', params: unknown[]) => {
      check(); const count = calls.get(p.providerId) ?? 0; demand(count < 40);
      demand(method === 'eth_chainId' ? params.length === 0
        : params.length === 2 && params[1] === false && (params[0] === 'latest'
          || (typeof params[0] === 'string' && /^0x(?:0|[1-9a-f][a-f0-9]*)$/.test(params[0]))));
      calls.set(p.providerId,count + 1);
      const signal = AbortSignal.any([input.signal,AbortSignal.timeout(Math.max(1,Math.min(10000,180000-(now()-started))))]);
      const id = count + 1;
      const response = await abortable(() => input.fetch(p.endpoint,{method:'POST',redirect:'error',signal,
        headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}),signal);
      const value = await boundedJson(response,signal); check();
      demand(value.jsonrpc === '2.0' && value.id === id && !('error' in value) && 'result' in value);
      return value.result;
    };
    demand(quantity(await rpc('eth_chainId',[])) === Number(BigInt(p.expectedChainId)));
    const cache = new Map<number,Header>();
    const get = async (n: number | 'latest', fresh = false) => {
      if (typeof n === 'number' && !fresh && cache.has(n)) return cache.get(n)!;
      const h = header(await rpc('eth_getBlockByNumber',[n === 'latest' ? n : '0x'+n.toString(16),false]));
      demand(n === 'latest' || h.number === n);
      for (const old of cache.values()) {
        demand(old.number !== h.number || old.hash === h.hash);
        demand(old.number <= h.number ? old.timestamp <= h.timestamp : old.timestamp >= h.timestamp);
      }
      cache.set(h.number,h); return h;
    };
    const genesis = await get(0); demand(genesis.hash === p.expectedGenesisBlockHash.toLowerCase());
    const head = await get('latest'); demand(head.timestamp * 1000 >= input.activatedAt);
    // Reserve final candidate, predecessor and pinned-head checks before starting the search.
    demand((calls.get(p.providerId) ?? 0) + Math.ceil(Math.log2(head.number + 1)) + 3 <= 40);
    let low = 0, high = head.number;
    while (low < high) {
      const mid = low + Math.floor((high-low)/2), h = await get(mid);
      if (h.timestamp * 1000 >= input.activatedAt) high = mid; else low = mid + 1;
    }
    const selected = await get(low,true), before = low === 0 ? null : await get(low-1,true);
    demand(selected.timestamp*1000 >= input.activatedAt && (!before
      || (before.timestamp*1000 < input.activatedAt && selected.parentHash === before.hash)));
    demand((await get(head.number,true)).hash === head.hash); check();
    // The consuming channel requires a positive floor; never publish an unusable zero.
    demand(low > 0);
    floors[p.chain] = low;
    chains.push({chain:p.chain,providerId:p.providerId,chainId:p.expectedChainId,genesisHash:genesis.hash,
      activatedAt:input.activatedAt,fromBlock:low,before,header:selected,searchHead:head,elapsedMs:now()-chainStarted});
  }
  return { floors, chains, providerRequests:Object.fromEntries(calls), elapsedMs:now()-started };
}

// Exact current adapter templates, not a second implementation of budget semantics.
export const EVM_FLOOR_OPERATIONAL_SQL = Object.freeze({
  activation: 'SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1',
  lock: `/* service-provider-budget-lock */ SELECT b.*,
        (SELECT count(*) FROM wallet_service_provider_leases x WHERE x.generation_id=b.generation_id AND x.provider_id=b.provider_id
          AND x.released_at IS NULL AND x.expires_at>$3) active_leases
        FROM wallet_service_provider_budgets b JOIN wallet_service_import_ledger l ON l.generation_id=b.generation_id AND l.import_id=b.import_id
        WHERE b.generation_id=$1 AND b.origin=$2 AND l.proof_scope='provider_contract' AND l.imported_at<=$3
          AND (l.revoked_at IS NULL OR l.revoked_at>$3) FOR UPDATE OF b`,
  debit: `/* service-provider-budget-debit */ UPDATE wallet_service_provider_budgets
        SET window_started_at=$3,requests_used=$4 WHERE generation_id=$1 AND provider_id=$2 RETURNING provider_id`,
  insert: `INSERT INTO wallet_service_provider_leases(lease_id,generation_id,provider_id,owner_id,expires_at)
        VALUES($1,$2,$3,$4,$5)`,
  cooldown: `/* service-provider-cooldown */ UPDATE wallet_service_provider_budgets
            SET cooldown_until=GREATEST(cooldown_until,$3::bigint) WHERE generation_id=$1 AND provider_id=$2 RETURNING cooldown_until`,
  release: `/* service-provider-release */ UPDATE wallet_service_provider_leases SET released_at=$5
        WHERE lease_id=$1 AND generation_id=$2 AND provider_id=$3 AND owner_id=$4 AND released_at IS NULL`,
});
/** Exact text and parameter positions fail closed when the adapter's reviewed SQL changes. */
export function operationalOnlyRuntime(runtime: PostgresBusinessRuntime, generation: string,
  providers: readonly FloorProvider[]): PostgresBusinessRuntime {
  const expected = new Map(providers.map(p=>[new URL(p.endpoint).origin,p.providerId]));
  const providerIds = new Set(providers.map(p=>p.providerId));
  const templates = new Map<string,string>(Object.entries(EVM_FLOOR_OPERATIONAL_SQL).map(([kind,sql])=>[sql,kind]));
  const run: PostgresBusinessRuntime['run'] = operation => runtime.run(tx => operation({ ...tx,
    query: async (sql,values) => {
      const kind = templates.get(sql); demand(kind && values);
      const size = {activation:1,lock:3,debit:4,insert:5,cooldown:3,release:5}[kind as keyof typeof EVM_FLOOR_OPERATIONAL_SQL];
      demand(values.length === size);
      const lease = kind === 'insert' || kind === 'release';
      demand(values[lease ? 1 : 0] === generation);
      if (kind === 'lock') demand(typeof values[1] === 'string' && expected.has(values[1]) && clock(values[2]));
      else if (kind !== 'activation') {
        demand(typeof values[lease ? 2 : 1] === 'string' && providerIds.has(values[lease ? 2 : 1] as string));
        if (lease) demand(typeof values[0] === 'string' && /^[a-f0-9-]{36}$/.test(values[0])
          && typeof values[3] === 'string' && values[3].startsWith('wallet-monitor:') && clock(values[4]));
        else if (kind === 'debit') demand(clock(values[2]) && clock(values[3]) && Number(values[3]) > 0);
        else demand(typeof values[2] === 'string' && /^(0|[1-9][0-9]*)$/.test(values[2])
          && BigInt(values[2]) <= 9223372036854775807n);
      }
      const result = await tx.query(sql,values);
      if (kind === 'lock') {
        for (const row of result.rows) demand(row.provider_id === expected.get(String(values?.[1])));
      }
      return result;
    },
  }));
  return { run, probe:()=>runtime.probe(), statistics:()=>runtime.statistics(), close:()=>runtime.close() };
}
export interface FloorRunnerPorts {
  readPin?: typeof readPrivateAuthorityPin;
  verifyRelease?: typeof sealedRelease;
  createRuntime?: typeof createPostgresBusinessRuntime;
  createFacts?: typeof createPostgresServiceFactAdapters;
  publish?: typeof publishFloorReceipt;
  checkReceiptTarget?: typeof assertReceiptTarget;
}
export async function runFloorJob(jobValue: unknown, ports: FloorRunnerPorts = {}) {
  const job = validateFloorJob(jobValue), read = ports.readPin ?? readPrivateAuthorityPin;
  const started = performance.now(), signal = AbortSignal.timeout(180000);
  const check = () => { signal.throwIfAborted(); demand(performance.now()-started < 180000); };
  const load = async (p: Pin) => { check(); const raw = await read(p); check(); return object(JSON.parse(raw.toString('utf8'))); };
  const environment = await load(job.environment) as ServiceEnvironment;
  const config = validatePostgresServiceDeployment(await load(job.deployment),environment) as ConfiguredPostgresServiceDeployment;
  const manifest = config.cutover?.addressOnly;
  demand(manifest && config.walletExecution?.evm && config.sources.mode === undefined
    && config.generationId === job.generationId && config.activatedAt === job.activatedAt
    && manifest.generationId === job.generationId && manifest.activatedAt === job.activatedAt
    && manifest.releaseSha256 === job.releaseSha256 && environment.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 === job.releaseSha256);
  const authorityPin = pin({path:environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE,
    sha256:environment.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256});
  const authority = await load(authorityPin) as unknown as PostgresCliExecutionAuthorityConfiguration;
  demand(authority.protocol === 'address-only-cli-execution-authority-v1' && authority.operationId === config.operationId
    && authority.generationId === job.generationId && authority.releaseSha256 === job.releaseSha256);
  const state = await load(job.currentJournal), receipt = await load(job.currentReceipt);
  demand(state.phase === 'COMPLETE' && state.pending === null && JSON.stringify(state.receipt) === JSON.stringify(receipt)
    && state.operationId === config.operationId && state.release?.releaseSha256 === job.releaseSha256
    && state.configuredReleaseRoot === config.releaseRoot && receipt.releaseSha256 === job.releaseSha256
    && receipt.protocol === 'address-only-configured-transition-receipt-v1' && receipt.generationId === job.generationId
    && receipt.operationId === config.operationId && receipt.importId === manifest.importId
    && receipt.databaseImported === true && receipt.newImportPerformed === false && receipt.businessReleaseSwitched === true
    && receipt.businessEligibilityGranted === false && receipt.monitoringCompleted === false);
  for (const key of ['gatewayDeliveryEnabled','fomoEnabled','fullHistoricalMiningEnabled']) demand(receipt[key] === false);
  const providers: FloorProvider[] = [];
  for (const [chain,source] of Object.entries(config.walletExecution.evm)) {
    demand(source && ['eth','bsc','base'].includes(chain));
    const bindings = authority.validator.reviewedProviderBindings.filter(b=>b.chain === chain);
    demand(bindings.length === 1); const binding = bindings[0]!;
    demand(binding.chain !== 'solana' && binding.sourceEndpoint === source.endpoint && binding.sourceProviderId === source.providerId
      && binding.expectedChainId === source.expectedChainId && binding.expectedGenesisBlockHash === source.expectedGenesisBlockHash);
    providers.push({chain:chain as Chain,providerId:source.providerId,endpoint:source.endpoint,
      expectedChainId:source.expectedChainId,expectedGenesisBlockHash:source.expectedGenesisBlockHash});
  }
  demand(providers.length > 0);
  const credential = await load(job.credential), username = config.services['wallet-monitor'].username;
  demand(typeof credential.connectionString === 'string' && credential.username === username && credential.gatewayDeliveryEnabled === false);
  const url = new URL(credential.connectionString);
  demand(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port === '5432' && url.pathname === '/'+config.database
    && decodeURIComponent(url.username) === username && url.password && !url.search && !url.hash);
  const verify = ports.verifyRelease ?? sealedRelease;
  demand(await verify(config,check) === job.releaseSha256); check();
  await (ports.checkReceiptTarget ?? assertReceiptTarget)(job.receiptPath); check();
  const native = (ports.createRuntime ?? createPostgresBusinessRuntime)({...config.driver,connectionString:credential.connectionString,
    access:'runtime',maximumConnections:1,target:{database:config.database,schema:config.schema,generation:job.generationId,username,service:'wallet-monitor'},
    connectionTimeoutMs:Math.min(config.driver.connectionTimeoutMs,5000),statementTimeoutMs:Math.min(config.driver.statementTimeoutMs,5000),
    lockTimeoutMs:Math.min(config.driver.lockTimeoutMs,1000),shutdownTimeoutMs:Math.min(config.driver.shutdownTimeoutMs,5000)});
  const runtime = operationalOnlyRuntime(native,job.generationId,providers);
  let measurement: Awaited<ReturnType<typeof measureEvmFloors>>;
  try {
    const identity = await runtime.probe(); check();
    demand(identity.generation === job.generationId && identity.database === config.database && identity.schema === config.schema && identity.username === username);
    const activation = await runtime.run(tx=>tx.query('SELECT activated_at FROM forward_strategy_generations WHERE generation_id=$1',[job.generationId]));
    demand(activation.rows.length === 1 && String(activation.rows[0]!.activated_at) === String(job.activatedAt)); check();
    const facts = await (ports.createFacts ?? createPostgresServiceFactAdapters)({runtime,generationId:job.generationId,
      maximumProfiles:config.wallet.maximumProfiles,now:Date.now,sources:{...config.sources,
        providerTimeoutMs:Math.min(Number(config.sources.providerTimeoutMs),10000),
        maximumResponseBytes:Math.min(Number(config.sources.maximumResponseBytes),262144)}});
    measurement = await measureEvmFloors({providers,activatedAt:job.activatedAt,fetch:facts.fetch,signal}); check();
  } finally { await runtime.close(); }
  demand(await verify(config,check) === job.releaseSha256); check();
  // Detect replacement of any private input during the measurement without printing its contents.
  for (const p of [job.environment,job.deployment,job.currentJournal,job.currentReceipt,job.credential,authorityPin]) { await read(p); check(); }
  const result = {protocol:'address-only-evm-floor-receipt-v1',generationId:job.generationId,activatedAt:job.activatedAt,
    releaseSha256:job.releaseSha256,jobSha256:hash(JSON.stringify(job)),authoritySha256:authorityPin.sha256,
    deploymentSha256:job.deployment.sha256,environmentSha256:job.environment.sha256,
    currentJournalSha256:job.currentJournal.sha256,currentReceiptSha256:job.currentReceipt.sha256,
    measuredAt:Date.now(),maximumRequestsPerProvider:40,maximumRunMs:180000,maximumResponseBytes:262144,
    ...measurement,elapsedMs:performance.now()-started,floorEnvironment:JSON.stringify(measurement.floors),
    businessFactsWritten:false,checkpointWritten:false,activationGranted:false,signalPermissionGranted:false};
  const publication = await (ports.publish ?? publishFloorReceipt)(job.receiptPath,result,check);
  return { ...publication, floors:measurement.floors };
}

export async function assertReceiptTarget(path: string) {
  demand(isAbsolute(path) && resolve(path) === path);
  for (let parent = dirname(path);;) {
    const s = await lstat(parent);
    demand(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && (s.mode & 0o022) === 0);
    if (parent === dirname(path)) demand((s.mode & 0o777) === 0o700);
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  try { await lstat(path); demand(false); } catch (error) { demand((error as NodeJS.ErrnoException).code === 'ENOENT'); }
}
export async function publishFloorReceipt(path: string, value: unknown, check: () => void = () => undefined) {
  check(); await assertReceiptTarget(path); check();
  const parent = await open(dirname(path),constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const s = await parent.stat(); demand(s.uid === 0 && s.isDirectory() && (s.mode & 0o777) === 0o700);
    // Linux descriptor-relative publication prevents a renamed parent from redirecting the output.
    demand(process.platform === 'linux');
    const root = '/proc/self/fd/'+parent.fd, name = path.slice(dirname(path).length+1);
    const temporary = join(root,'.floor-'+randomUUID()+'.pending'), target = join(root,name);
    const bytes = Buffer.from(JSON.stringify(value)+'\n'); demand(bytes.length <= 65536);
    const file = await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    check();
    const live = await lstat(dirname(path)); demand(live.dev === s.dev && live.ino === s.ino);
    await link(temporary,target); await unlink(temporary); await parent.sync(); check();
    return {receiptPath:path,receiptSha256:hash(bytes)};
  } finally { await parent.close(); }
}
async function main() {
  try {
    demand(process.geteuid?.() === 0 && process.argv.length === 6 && process.argv[2] === '--request' && process.argv[4] === '--sha256');
    const raw = await readPrivateAuthorityPin(pin({path:process.argv[3],sha256:process.argv[5]}));
    const result = await runFloorJob(JSON.parse(raw.toString('utf8')));
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch { process.stderr.write('{"error":"EVM_FLOOR_REFUSED"}\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
