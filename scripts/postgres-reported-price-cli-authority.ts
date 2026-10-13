import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createAveMarketClient } from '../packages/collectors/src/ave-market-client.js';
import { createIndependentPostgresPublisherRuntime } from '../packages/database/src/postgres-independent-publisher-runtime.js';
import { withPostgresDeadline, type ServiceEnvironment } from '../packages/database/src/postgres-service-dispatch.js';
import type { PostgresTransaction } from '../packages/database/src/postgres-unit-of-work.js';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import { validateReportedMarketApproval, verifyReportedMarketApprovalConfiguration, type ReportedApprovalPin } from './postgres-reported-market-approval.js';
import type { PostgresNativeReportedMarketCapAuthorityInput } from './postgres-price-authority.js';
import type { ConfiguredPostgresServiceDeployment, ServiceFactPorts } from './postgres-service-entry.js';

export interface ReportedPriceCliMaterial {
  readonly protocol: 'address-only-cli-reported-price-authority-v1';
  readonly operationId: string; readonly generationId: string; readonly releaseSha256: string;
  readonly username: string; readonly migrationRole: string;
  readonly credential: ReportedApprovalPin; readonly privateKey: ReportedApprovalPin; readonly apiCredential: ReportedApprovalPin;
  readonly approval: ReportedApprovalPin;
  readonly providerContract: { readonly providerId: string; readonly origin: string; readonly importId: string; readonly sourceFingerprint: string;
    readonly windowMs: number; readonly maximumRequests: number; readonly maximumConcurrency: number };
  readonly validatorContract: { readonly validatorId: string; readonly importId: string; readonly sourceFingerprint: string };
  readonly validator: { readonly maximumRunMs: number; readonly maximumPayloadBytes: number; readonly maximumCandidateAgeMs: number;
    readonly maximumMappingAgeMs: number; readonly maximumWindowMs: number; readonly validationTtlMs: number };
  readonly publisher: { readonly maximumValidationAgeMs: number; readonly maximumPayloadBytes: number; readonly statementTimeoutMs: number;
    readonly lockTimeoutMs: number; readonly maximumCandles: number; readonly maximumWindowMs: number; readonly maximumMappingAgeMs: number };
  readonly transport: { readonly maximumRequestsPerAcquisition: number; readonly maximumResponseBytes: number; readonly timeoutMs: number };
}
export interface ReportedPriceCliPorts {
  /** Isolated-test IO seam only; the actual CLI always enforces root-owned pinned files. */
  readonly readPin?: typeof readPrivateAuthorityPin;
  readonly openRuntime?: typeof createIndependentPostgresPublisherRuntime;
  readonly now?: () => number;
}
function demand(value: unknown, reason: string): asserts value { if (!value) throw Error('reported_price_cli:'+reason); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string,unknown> {
  demand(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','),'fields');
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value)>0 && Number(value)<=2147483647;
function pin(value: unknown): asserts value is ReportedApprovalPin {
  exact(value,['path','sha256']); demand(typeof value.path === 'string' && isAbsolute(value.path) && resolve(value.path)===value.path && hash(value.sha256),'pin');
}
export function validateReportedPriceCliMaterial(value: unknown): ReportedPriceCliMaterial {
  exact(value,['protocol','operationId','generationId','releaseSha256','username','migrationRole','credential','privateKey','apiCredential','approval','providerContract','validatorContract','validator','publisher','transport']);
  demand(value.protocol==='address-only-cli-reported-price-authority-v1' && label(value.operationId) && label(value.generationId)
    && hash(value.releaseSha256) && [value.username,value.migrationRole].every(v=>typeof v==='string' && /^[a-z_][a-z0-9_]{0,62}$/.test(v)),'binding');
  [value.credential,value.privateKey,value.apiCredential,value.approval].forEach(pin);
  exact(value.providerContract,['providerId','origin','importId','sourceFingerprint','windowMs','maximumRequests','maximumConcurrency']);
  const p=value.providerContract;
  demand(label(p.providerId) && label(p.importId) && hash(p.sourceFingerprint) && p.origin==='https://prod.ave-api.com'
    && [p.windowMs,p.maximumRequests,p.maximumConcurrency].every(positive),'provider_contract');
  exact(value.validatorContract,['validatorId','importId','sourceFingerprint']);
  demand(label(value.validatorContract.validatorId) && label(value.validatorContract.importId) && hash(value.validatorContract.sourceFingerprint),'validator_contract');
  exact(value.validator,['maximumRunMs','maximumPayloadBytes','maximumCandidateAgeMs','maximumMappingAgeMs','maximumWindowMs','validationTtlMs']);
  exact(value.publisher,['maximumValidationAgeMs','maximumPayloadBytes','statementTimeoutMs','lockTimeoutMs','maximumCandles','maximumWindowMs','maximumMappingAgeMs']);
  exact(value.transport,['maximumRequestsPerAcquisition','maximumResponseBytes','timeoutMs']);
  demand([...Object.values(value.validator),...Object.values(value.publisher),...Object.values(value.transport)].every(positive),'budget');
  return structuredClone(value) as unknown as ReportedPriceCliMaterial;
}
async function readRootPin(p: ReportedApprovalPin): Promise<Buffer> {
  const bytes=await readPrivateAuthorityPin(p),info=await lstat(p.path);
  demand(info.uid===0 && info.isFile() && !info.isSymbolicLink(),'root_material'); return bytes;
}

/** No RPC on assembly. All actual requests use the scanner's existing database-budgeted transport. */
export async function createPostgresCliReportedPriceAuthority(input: {
  config: ConfiguredPostgresServiceDeployment; env: ServiceEnvironment; facts: Pick<ServiceFactPorts,'fetch'>; signal: AbortSignal;
}, ports: ReportedPriceCliPorts = {}): Promise<{
  native: Omit<PostgresNativeReportedMarketCapAuthorityInput,'deployment'|'signal'>; close(): Promise<void>;
}> {
  let runtime: ReturnType<typeof createIndependentPostgresPublisherRuntime> | undefined;
  const lifetime=new AbortController(),abort=()=>lifetime.abort();
  const work=new Set<Promise<unknown>>();
  const now=ports.now??Date.now,read=ports.readPin??readRootPin;
  const approvedFetch=input.facts.fetch.bind(input.facts);
  try {
    input.signal.throwIfAborted();
    const config=structuredClone(input.config),env={...input.env},p=config.priceAcquisition,target=config.cutover.addressOnly?.target;
    demand(p?.protocol==='approved_reported_market_cap_v1' && target,'explicit_protocol');
    const settingsPin={path:env.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE!,sha256:env.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256!};
    pin(settingsPin);
    const readBytes=async(p:ReportedApprovalPin)=>{const bytes=await read(p);demand(bytes.length>0 && bytes.length<=524288 && createHash('sha256').update(bytes).digest('hex')===p.sha256,'material_pin_changed');return bytes;};
    const settings=validateReportedPriceCliMaterial(JSON.parse((await readBytes(settingsPin)).toString('utf8')));
    demand(settings.operationId===config.operationId && settings.generationId===config.generationId
      && settings.releaseSha256===env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256 && settings.releaseSha256===config.cutover.addressOnly!.releaseSha256
      && isDeepStrictEqual(settings.approval,p.approval),'deployment_binding');
    const budgets=config.driver.serviceConnectionBudgets;
    demand(budgets['price-publisher']===1 && Object.values(budgets).every(v=>Number.isSafeInteger(v)&&v>=0)
      && Object.values(budgets).reduce((a,b)=>a+b,0)+config.driver.reservedConnections<=config.driver.serverMaximumConnections,'publisher_allocation');
    const forbiddenRoles=[...Object.values(config.services).map(v=>v.username),settings.migrationRole];
    demand(forbiddenRoles.length===7 && new Set(forbiddenRoles).size===7 && !forbiddenRoles.includes(settings.username),'independent_role');
    const snapshots=new Map<string,Buffer>([[settingsPin.path,await readBytes(settingsPin)]]);
    for(const child of [settings.approval,settings.credential,settings.privateKey,settings.apiCredential]) {
      demand(!snapshots.has(child.path),'distinct_material_paths');snapshots.set(child.path,await readBytes(child));
    }
    const document=validateReportedMarketApproval(JSON.parse(snapshots.get(settings.approval.path)!.toString('utf8'))),d=document;
    demand(isDeepStrictEqual(d.target,{database:config.database,schema:config.schema,generationId:config.generationId,
      systemIdentifier:target.systemIdentifier,serverAddress:target.serverAddress,serverPort:target.serverPort,
      schemaVersion:config.driver.schemaVersion,schemaFingerprint:target.schemaFingerprint})
      && config.driver.schemaFingerprint===target.schemaFingerprint && p.mappings.length===1,'approval_target');
    const binding=p.mappings[0]!;
    demand(isDeepStrictEqual(binding,{mapping:d.mapping,providerId:d.source.providerId,mappingApprovalRef:d.mappingApprovalRef,
      sourceApprovalRef:d.source.sourceApprovalRef,sourceProofKind:d.sourceProofKind,candleMs:0,validFrom:d.validFrom,validUntil:d.validUntil,quoteAddress:d.quoteAddress})
      && p.source.providerId===d.source.providerId && p.source.baseUrl===d.source.origin && p.source.sourceApprovalRef===d.source.sourceApprovalRef
      && settings.providerContract.providerId===d.source.providerId && settings.providerContract.origin===d.source.origin
      && settings.validatorContract.validatorId===d.validator.validatorId,'source_mapping_binding');
    const v=settings.validator,w=settings.publisher,t=settings.transport;
    demand(v.maximumRunMs<=p.receiver.maximumRunMs && v.maximumPayloadBytes<=p.receiver.maximumPayloadBytes
      && v.maximumWindowMs<=p.source.maximumWindowMs && v.maximumMappingAgeMs<=p.source.maximumMappingAgeMs
      && w.maximumPayloadBytes<=p.receiver.maximumPayloadBytes && w.maximumValidationAgeMs<=v.validationTtlMs
      && w.maximumWindowMs<=p.source.maximumWindowMs && w.maximumMappingAgeMs<=p.source.maximumMappingAgeMs
      && w.maximumCandles<=1000 && v.validationTtlMs<=300000 && w.statementTimeoutMs<=config.driver.statementTimeoutMs
      && w.lockTimeoutMs<=Math.min(w.statementTimeoutMs,config.driver.lockTimeoutMs)
      && t.maximumResponseBytes<=Math.min(p.source.maximumPayloadBytes,Number(config.sources.maximumResponseBytes))
      && t.timeoutMs<=Math.min(v.maximumRunMs,p.source.maximumRunMs,Number(config.sources.providerTimeoutMs))
      && t.maximumRequestsPerAcquisition<=settings.providerContract.maximumRequests,'budget_binding');
    const credential=JSON.parse(snapshots.get(settings.credential.path)!.toString('utf8')) as Record<string,unknown>;
    exact(credential,['connectionString','username','service','gatewayDeliveryEnabled']);
    demand(typeof credential.connectionString==='string','credential');const url=new URL(credential.connectionString);
    demand(url.protocol==='postgresql:' && url.hostname===target.serverAddress && url.port===String(target.serverPort)
      && url.pathname==='/'+config.database && decodeURIComponent(url.username)===settings.username && url.password.length>0
      && !url.search && !url.hash && credential.username===settings.username && credential.service==='price-publisher'
      && credential.gatewayDeliveryEnabled===false,'credential_binding');
    const api=JSON.parse(snapshots.get(settings.apiCredential.path)!.toString('utf8')) as Record<string,unknown>;
    exact(api,['providerId','origin','apiKey']);demand(api.providerId===d.source.providerId && api.origin===d.source.origin
      && typeof api.apiKey==='string' && api.apiKey.length>0 && api.apiKey.length<=4096 && !/[\r\n]/.test(api.apiKey),'api_credential');
    const privateKey=createPrivateKey(snapshots.get(settings.privateKey.path)!);
    demand(privateKey.asymmetricKeyType==='ed25519' && createPublicKey(privateKey).export({type:'spki',format:'der'})
      .equals(createPublicKey(d.validator.publicKey).export({type:'spki',format:'der'})),'signing_key_binding');
    const assertMaterials=async()=>{
      demand(!lifetime.signal.aborted,'closed');input.signal.throwIfAborted();
      for(const child of [settingsPin,settings.approval,settings.credential,settings.privateKey,settings.apiCredential])
        demand((await readBytes(child)).equals(snapshots.get(child.path)!),'material_changed');
    };
    const checkContracts=async(tx:PostgresTransaction)=>{
      const at=now();demand(Number.isSafeInteger(at)&&at>=d.validFrom&&at<d.validUntil,'approval_expired');
      const provider=(await tx.query(`/* reported-cli-provider */ SELECT b.provider_id,b.origin,b.import_id,b.window_ms,b.maximum_requests,b.maximum_concurrency,
        l.source_fingerprint,l.proof_scope,l.revoked_at,l.imported_at FROM wallet_service_provider_budgets b
        JOIN wallet_service_import_ledger l USING(generation_id,import_id) WHERE b.generation_id=$1 AND (b.provider_id=$2 OR b.origin=$3)`,[config.generationId,d.source.providerId,d.source.origin])).rows;
      const r=provider[0],pc=settings.providerContract;
      demand(provider.length===1 && r && r.provider_id===pc.providerId && r.origin===pc.origin && r.import_id===pc.importId
        && r.source_fingerprint===pc.sourceFingerprint && r.proof_scope==='provider_contract' && r.revoked_at===null
        && r.imported_at!==null && /^\d+$/.test(String(r.imported_at)) && Number.isSafeInteger(Number(r.imported_at)) && Number(r.imported_at)<=at
        && Number(r.window_ms)===pc.windowMs && Number(r.maximum_requests)===pc.maximumRequests && Number(r.maximum_concurrency)===pc.maximumConcurrency,'actual_provider_contract');
      const validators=(await tx.query(`/* reported-cli-validator */ SELECT v.validator_id,v.import_id,v.valid_from,v.valid_until,v.revoked_at,
        l.source_fingerprint,l.proof_scope,l.revoked_at AS ledger_revoked_at,l.imported_at FROM wallet_service_fact_validators v
        JOIN wallet_service_import_ledger l USING(generation_id,import_id) WHERE v.generation_id=$1 AND v.kind='price' AND v.validator_id=$2`,[config.generationId,d.validator.validatorId])).rows;
      const a=validators[0],vc=settings.validatorContract;
      demand(validators.length===1 && a && a.validator_id===vc.validatorId && a.import_id===vc.importId
        && a.source_fingerprint===vc.sourceFingerprint && a.proof_scope==='validator_authority' && a.revoked_at===null && a.ledger_revoked_at===null
        && a.imported_at!==null && /^\d+$/.test(String(a.imported_at)) && Number.isSafeInteger(Number(a.imported_at)) && Number(a.imported_at)<=at
        && a.valid_from!==null && Number.isSafeInteger(Number(a.valid_from)) && Number(a.valid_from)>=0 && Number(a.valid_from)<=at
        && a.valid_until!==null && Number.isSafeInteger(Number(a.valid_until)) && Number(a.valid_until)>=at+v.validationTtlMs,'actual_validator_contract');
    };
    runtime=(ports.openRuntime??createIndependentPostgresPublisherRuntime)({connectionString:credential.connectionString,schema:config.schema,
      statementTimeoutMs:w.statementTimeoutMs,lockTimeoutMs:w.lockTimeoutMs});
    const owned=runtime;
    const run: typeof owned.run=async operation=>{await assertMaterials();return owned.run(async tx=>{
      await checkContracts(tx);const result=await operation(tx);await assertMaterials();await checkContracts(tx);return result;
    });};
    await run(async tx=>{
      const rows=(await tx.query(`/* reported-cli-cluster */ SELECT current_database() AS database,current_user AS username,
        session_user AS session_username,host(inet_server_addr()) AS address,inet_server_port() AS port,
        system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()`)).rows;
      const r=rows[0];demand(rows.length===1 && r && r.database===target.database && r.username===settings.username && r.session_username===settings.username
        && r.address===target.serverAddress && r.port===target.serverPort && r.system_identifier===target.systemIdentifier,'cluster_identity');
    });
    const readApproval=async(pin:ReportedApprovalPin)=>validateReportedMarketApproval(JSON.parse((await readBytes(pin)).toString('utf8')));
    await verifyReportedMarketApprovalConfiguration({pin:p.approval,target:d.target,run,now,read:readApproval});
    input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();
    let stopped: 'unauthorized'|'rate_limited'|undefined;
    const client: PostgresNativeReportedMarketCapAuthorityInput['validator']['client']={async tokenDetail(identity,signal){
      if(stopped)return {status:'deferred',reason:stopped};
      const execute=async()=>{
        const combined=AbortSignal.any([lifetime.signal,input.signal,...(signal?[signal]:[])]);combined.throwIfAborted();
        await assertMaterials();await run(async()=>{});combined.throwIfAborted();
        const guardedFetch: ServiceFactPorts['fetch']=async(url,init)=>{
          const actual=new URL(url instanceof Request?url.url:String(url));
          demand(actual.origin===d.source.origin && actual.pathname===`/v2/tokens/${d.mapping.tokenAddress}-${d.mapping.chain}`
            && !actual.search && !actual.hash && !actual.username && !actual.password && init?.method==='GET','transport_scope');
          const pending=Promise.resolve().then(()=>approvedFetch(url,init));work.add(pending);
          try{return await pending;}finally{work.delete(pending);}
        };
        const ave=createAveMarketClient({guardedFetch,apiKey:api.apiKey as string,deadlineAtMs:Date.now()+t.timeoutMs,
          maximumRequests:t.maximumRequestsPerAcquisition,maximumResponseBytes:t.maximumResponseBytes});
        const result=await ave.tokenDetail(identity,combined);
        if(result.status==='deferred' && (result.reason==='unauthorized'||result.reason==='rate_limited'))stopped=result.reason;
        await assertMaterials();return result;
      };
      const pending=execute();work.add(pending);
      try{return await pending;}catch{return {status:'deferred',reason:'transport_failure'};}finally{work.delete(pending);}
    }};
    const native: Omit<PostgresNativeReportedMarketCapAuthorityInput,'deployment'|'signal'>={sourceOrigin:d.source.origin,
      approvalReader:{pin:p.approval,target:d.target,run,now,read:readApproval},
      validator:{...d.validator,...v,authorizationRef:d.authorizationRef,generationId:config.generationId,activatedAt:config.activatedAt,
        bindings:[{...binding,sourceProofKind:'approved_reported_market_cap_v1',candleMs:0,quoteAddress:d.quoteAddress}],client,now,
        signingKey:{async loadPrivateKey(request){request.signal.throwIfAborted();
          demand(request.validatorId===d.validator.validatorId && request.keyId===d.validator.keyId,'signing_request_binding');
          await assertMaterials();await run(async()=>{});request.signal.throwIfAborted();return privateKey;}}},
      publisher:{...w,run,now,forbiddenRoles,mappings:p.mappings,target:{database:config.database,schema:config.schema,username:settings.username,
        serverAddress:target.serverAddress,serverPort:target.serverPort,generationId:config.generationId,
        schemaVersion:config.driver.schemaVersion,schemaFingerprint:config.driver.schemaFingerprint},
        validators:[{...d.validator,authorizationRef:d.authorizationRef,reviewedSourceProviders:[d.source.providerId]}]}};
    let closing:Promise<void>|undefined;
    return {native,close(){if(!closing){lifetime.abort();input.signal.removeEventListener('abort',abort);
      closing=(async()=>{try{await withPostgresDeadline(async()=>{await Promise.allSettled([...work]);},
        {maximumMs:config.driver.shutdownTimeoutMs});}finally{await owned.close();}})();}return closing;}};
  } catch {lifetime.abort();input.signal.removeEventListener('abort',abort);if(runtime)await runtime.close().catch(()=>{});
    throw Error('reported_price_cli:material_or_authority_refused');}
}
