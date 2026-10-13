import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPostgresCliReportedPriceAuthority, validateReportedPriceCliMaterial, type ReportedPriceCliMaterial } from '../postgres-reported-price-cli-authority.js';
import { composePostgresServicePriceDependencies } from '../postgres-price-authority.js';
import { attachDedicatedReportedApproval, dedicatedReportedLedgerRow } from '../../apps/automation/test/reported-market-approval-fixture.js';
import type { ConfiguredPostgresServiceDeployment } from '../postgres-service-entry.js';

function fixture() {
  const at=Date.now(),hash='a'.repeat(64),keys=generateKeyPairSync('ed25519');
  const target={database:'radar_business',schema:'radar_business',serverAddress:'127.0.0.1',serverPort:5432,schemaVersion:3,schemaFingerprint:hash};
  const map={chain:'solana' as const,tokenAddress:'1'.repeat(31)+'2',poolAddress:'1'.repeat(31)+'3',tokenSide:'base' as const,
    network:'solana',evidenceRef:'map',knownAt:at-5000};
  const approval=attachDedicatedReportedApproval({approvalRef:'validator-approval',generationId:'generation',validatorId:'price-validator',keyId:'key',actorId:'reviewer',
    providerId:'ave',sourceApprovalRef:'ave-review',mappingApprovalRef:'mapping-review',quoteAddress:'1'.repeat(31)+'4',validFrom:at-2000,validUntil:at+300000},map,target,
    keys.publicKey.export({type:'spki',format:'pem'}).toString());
  const document=approval.approvalDocument,ledger=dedicatedReportedLedgerRow(approval);
  const bytes=new Map<string,Buffer>();
  const put=(path:string,value:unknown)=>{
    const raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));bytes.set(path,raw);
    return {path,sha256:createHash('sha256').update(raw).digest('hex')};
  };
  const approvalPin=put('/root/source-review.json',document);
  const material:ReportedPriceCliMaterial={protocol:'address-only-cli-reported-price-authority-v1',operationId:'operation',generationId:'generation',releaseSha256:hash,
    username:'price_publisher',migrationRole:'migrator',approval:approvalPin,
    credential:put('/root/publisher.json',{connectionString:'postgresql://price_publisher:SECRET_PASSWORD@127.0.0.1:5432/radar_business',username:'price_publisher',service:'price-publisher',gatewayDeliveryEnabled:false}),
    privateKey:put('/root/key.pem',Buffer.from(keys.privateKey.export({type:'pkcs8',format:'pem'}))),
    apiCredential:put('/root/ave.json',{providerId:'ave',origin:'https://prod.ave-api.com',apiKey:'SECRET_AVE_KEY'}),
    providerContract:{providerId:'ave',origin:'https://prod.ave-api.com',importId:'provider-import',sourceFingerprint:'b'.repeat(64),windowMs:60000,maximumRequests:7,maximumConcurrency:1},
    validatorContract:{validatorId:'price-validator',importId:'validator-import',sourceFingerprint:'c'.repeat(64)},
    validator:{maximumRunMs:1000,maximumPayloadBytes:128000,maximumCandidateAgeMs:5000,maximumMappingAgeMs:200000,maximumWindowMs:120000,validationTtlMs:5000},
    publisher:{maximumValidationAgeMs:5000,maximumPayloadBytes:128000,statementTimeoutMs:1000,lockTimeoutMs:500,maximumCandles:1,maximumWindowMs:120000,maximumMappingAgeMs:200000},
    transport:{maximumRequestsPerAcquisition:1,maximumResponseBytes:64000,timeoutMs:500}};
  const env={ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE:'/root/material.json',ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256:'',ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:hash};
  const save=()=>{env.ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256=put('/root/material.json',material).sha256;};save();
  const config={operationId:'operation',generationId:'generation',activatedAt:at-10000,database:target.database,schema:target.schema,
    cutover:{addressOnly:{target:{...target,systemIdentifier:'123'},releaseSha256:hash}},
    driver:{schemaVersion:3,schemaFingerprint:hash,statementTimeoutMs:3000,lockTimeoutMs:1000,shutdownTimeoutMs:1000,
      serverMaximumConnections:16,reservedConnections:3,serviceConnectionBudgets:{scanner:1,automation:1,'wallet-monitor':1,'wallet-analysis':1,'historical-backfill':1,console:1,'execution-publisher':1,'price-publisher':1,operator:1}},
    services:Object.fromEntries(['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'].map(s=>[s,{username:s.replaceAll('-','_'),maximumConnections:1,intervalMs:15000}])),
    sources:{maximumResponseBytes:128000,providerTimeoutMs:1000},
    priceAcquisition:{protocol:'approved_reported_market_cap_v1',approval:approvalPin,
      source:{providerId:'ave',baseUrl:'https://prod.ave-api.com',sourceApprovalRef:'ave-review',maximumRunMs:1000,maximumPayloadBytes:64000,maximumWindowMs:120000,maximumMappingAgeMs:200000},
      receiver:{maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:128000},
      mappings:[{mapping:map,providerId:'ave',mappingApprovalRef:'mapping-review',sourceApprovalRef:'ave-review',sourceProofKind:'approved_reported_market_cap_v1',candleMs:0,
        validFrom:document.validFrom,validUntil:document.validUntil,quoteAddress:document.quoteAddress}],
      retry:{maximumSamples:1,maximumRetryEntries:1,maximumMappings:1,maximumPayloadBytes:128000,maximumRunMs:1000,retryDelayMs:1000}}} as unknown as ConfiguredPostgresServiceDeployment;
  let providerDrift=false,validatorDrift=false;
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes('reported-cli-provider'))return {rows:[{provider_id:'ave',origin:material.providerContract.origin,import_id:'provider-import',window_ms:60000,
      maximum_requests:providerDrift?8:7,maximum_concurrency:1,source_fingerprint:'b'.repeat(64),proof_scope:'provider_contract',revoked_at:null,imported_at:at-1000}],rowCount:1};
    if(sql.includes('reported-cli-validator'))return {rows:[{validator_id:'price-validator',import_id:'validator-import',valid_from:at-2000,valid_until:at+300000,
      revoked_at:validatorDrift?at:null,ledger_revoked_at:null,source_fingerprint:'c'.repeat(64),proof_scope:'validator_authority',imported_at:at-1000}],rowCount:1};
    if(sql.includes('reported-cli-cluster'))return {rows:[{database:target.database,username:'price_publisher',session_username:'price_publisher',address:'127.0.0.1',port:5432,system_identifier:'123'}],rowCount:1};
    if(sql.includes('reported-approval-identity'))return {rows:[{...ledger,generation_id:'generation',fingerprint:hash}],rowCount:1};
    if(sql.includes('reported-approval-reader'))return {rows:[ledger],rowCount:1};
    if(sql.includes('price-publisher-identity'))return {rows:[{database:target.database,username:'price_publisher',session_username:'price_publisher',schema:target.schema,
      serverAddress:'127.0.0.1',serverPort:5432,schema_generation:'generation',schema_version:3,schema_fingerprint:hash,
      role_safe:true,consumer_member:false,objects_safe:true,can_publish:true}],rowCount:1};
    if(sql.includes('set_config'))return {rows:[],rowCount:0};
    throw Error('unexpected SQL');
  });
  const close=vi.fn(async()=>{}),runtime={run:async<T>(op:(tx:any)=>Promise<T>)=>op({query}),close};
  const openRuntime=vi.fn(()=>runtime),readPin=vi.fn(async(pin:{path:string})=>bytes.get(pin.path)!);
  const response=()=>new Response(JSON.stringify({status:1,data:{token:{chain:'solana',token:map.tokenAddress,market_cap:100000,fdv:900000,tvl:10,updated_at:Math.floor(at/1000)},
    pairs:[{chain:'solana',pair:map.poolAddress,token0_address:map.tokenAddress,token1_address:document.quoteAddress,target_token:map.tokenAddress,amm:'test'}]}}));
  const fetch=vi.fn(async(..._args:Parameters<import('../../packages/collectors/src/types.js').FetchLike>)=>response());
  const controller=new AbortController();
  const input={config,env,facts:{fetch},signal:controller.signal};
  const ports={readPin,openRuntime,now:()=>at};
  return {input,ports,material,save,put,bytes,ledger,query,close,fetch,controller,response,identity:{chain:'solana',token:map.tokenAddress,pool:map.poolAddress,quote:document.quoteAddress},
    driftProvider:()=>{providerDrift=true;},driftValidator:()=>{validatorDrift=true;}};
}
describe('reported CLI material loader: isolated doubles, no native/network proof',()=>{
  it('assembles actual reported factories without any provider request at startup',async()=>{
    const f=fixture(),loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    expect(f.fetch).not.toHaveBeenCalled();
    const dependencies=await composePostgresServicePriceDependencies({service:'scanner',deployment:f.input.config,dependencies:{nativeReportedMarketCapAuthority:loaded.native},signal:f.input.signal});
    expect(dependencies.priceAuthority?.validator?.validatePrice).toBeTypeOf('function');
    expect(dependencies.priceAuthority?.publisher?.publish).toBeTypeOf('function');
    expect(f.fetch).not.toHaveBeenCalled();expect(f.query.mock.calls.every(([sql])=>!/(?:^|;)\s*(INSERT|UPDATE|DELETE|GRANT)\b/.test(sql))).toBe(true);
    expect(f.ports.openRuntime).toHaveBeenCalledWith(expect.objectContaining({schema:'radar_business',statementTimeoutMs:1000,lockTimeoutMs:500}));
    await loaded.close();await loaded.close();expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('uses the real AVE parser and only the supplied guarded transport',async()=>{
    const f=fixture(),loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    const result=await loaded.native.validator.client.tokenDetail(f.identity);
    expect(result).toMatchObject({status:'candidate',reportedMarketCap:100000,reportedFdv:900000,circulatingMarketCapVerified:false,independence:'unverified'});
    expect(f.fetch).toHaveBeenCalledTimes(1);expect(f.fetch.mock.calls[0]![0]).toBe(`https://prod.ave-api.com/v2/tokens/${f.identity.token}-solana`);
    expect(new Headers(f.fetch.mock.calls[0]![1]?.headers).get('X-API-KEY')).toBe('SECRET_AVE_KEY');
    expect(JSON.stringify(loaded.native)).not.toMatch(/SECRET_PASSWORD|SECRET_AVE_KEY|PRIVATE KEY/);await loaded.close();
  });
  it.each(['missing-env','missing-allocation','capacity','role','release','source','mapping','credential','api','key','budget','pin'])(
    'refuses %s before opening a publisher connection',async fault=>{
      const f=fixture();
      if(fault==='missing-env')Reflect.deleteProperty(f.input.env,'ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE');
      if(fault==='missing-allocation')Reflect.deleteProperty(f.input.config.driver.serviceConnectionBudgets,'price-publisher');
      if(fault==='capacity')Object.assign(f.input.config.driver,{serverMaximumConnections:3});
      if(fault==='role')Object.assign(f.material,{username:'scanner'});
      if(fault==='release')Object.assign(f.material,{releaseSha256:'0'.repeat(64)});
      if(fault==='source')Object.assign(f.material.providerContract,{providerId:'other'});
      if(fault==='mapping')Object.assign(f.input.config.priceAcquisition!.mappings[0]!,{quoteAddress:'1'.repeat(31)+'5'});
      if(fault==='credential')Object.assign(f.material,{credential:f.put('/root/publisher.json',{connectionString:'postgresql://price_publisher:SECRET_PASSWORD@evil.invalid:5432/radar_business',username:'price_publisher',service:'price-publisher',gatewayDeliveryEnabled:false})});
      if(fault==='api')Object.assign(f.material,{apiCredential:f.put('/root/ave.json',{providerId:'other',origin:'https://prod.ave-api.com',apiKey:'SECRET_AVE_KEY'})});
      if(fault==='key')Object.assign(f.material,{privateKey:f.put('/root/key.pem',Buffer.from(generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'})))});
      if(fault==='budget')Object.assign(f.material.transport,{maximumResponseBytes:64001});
      f.save();if(fault==='pin')f.bytes.set('/root/material.json',Buffer.from('SECRET_BAD_JSON'));
      await expect(createPostgresCliReportedPriceAuthority(f.input,f.ports)).rejects.toThrow('reported_price_cli:material_or_authority_refused');
      expect(f.ports.openRuntime).not.toHaveBeenCalled();expect(f.fetch).not.toHaveBeenCalled();
    });
  it.each(['provider','validator','approval'])( 'requires current actual %s ledger and closes on refusal',async fault=>{
    const f=fixture();if(fault==='provider')f.driftProvider();if(fault==='validator')f.driftValidator();if(fault==='approval')f.ledger.revoked_at=Date.now() as any;
    await expect(createPostgresCliReportedPriceAuthority(f.input,f.ports)).rejects.toThrow('material_or_authority_refused');
    expect(f.fetch).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledTimes(1);
  });
  it.each([401,403,429])('stops on HTTP %s without fallback or secret output',async status=>{
    const f=fixture();f.fetch.mockImplementation(async()=>new Response('PRIVATE_RESPONSE',{status}));
    const loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    const first=await loaded.native.validator.client.tokenDetail(f.identity),second=await loaded.native.validator.client.tokenDetail(f.identity);
    expect(first).toEqual({status:'deferred',reason:status===429?'rate_limited':'unauthorized'});expect(second).toEqual(first);
    expect(f.fetch).toHaveBeenCalledTimes(1);expect(JSON.stringify(first)).not.toMatch(/SECRET|PRIVATE/);await loaded.close();
  });
  it.each(['material','provider','validator','budget'])('defers %s drift before any provider request',async fault=>{
    const f=fixture(),loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    if(fault==='material')f.bytes.set('/root/ave.json',Buffer.from('SECRET_CHANGED'));
    if(fault==='provider')f.driftProvider();if(fault==='validator')f.driftValidator();
    if(fault==='budget')f.fetch.mockImplementation(async()=>{throw Error('SECRET provider budget denied');});
    const result=await loaded.native.validator.client.tokenDetail(f.identity);
    expect(result).toMatchObject({status:'deferred'});expect(f.fetch).toHaveBeenCalledTimes(fault==='budget'?1:0);
    expect(JSON.stringify(result)).not.toContain('SECRET');await loaded.close();
  });
  it('rejects mismatched token transport scope without sending a guarded request',async()=>{
    const f=fixture(),loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    expect(await loaded.native.validator.client.tokenDetail({...f.identity,token:'1'.repeat(31)+'5'})).toMatchObject({status:'deferred'});
    expect(f.fetch).not.toHaveBeenCalled();await loaded.close();
  });
  it('aborts and drains guarded transport before closing the independent pool',async()=>{
    const f=fixture();let finish:()=>void=()=>{};let started:()=>void=()=>{};
    const seen=new Promise<void>(r=>{started=r;});
    f.fetch.mockImplementation(async()=>{started();await new Promise<void>(r=>{finish=r;});return f.response();});
    const loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    const work=loaded.native.validator.client.tokenDetail(f.identity);await seen;const closing=loaded.close();
    await Promise.resolve();expect(f.close).not.toHaveBeenCalled();finish();await closing;await work;
    expect(f.close).toHaveBeenCalledTimes(1);expect(await loaded.native.validator.client.tokenDetail(f.identity)).toMatchObject({status:'deferred'});
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects nonexplicit budgets instead of using AVE defaults',()=>{
    const f=fixture();Reflect.deleteProperty(f.material.transport,'maximumRequestsPerAcquisition');
    expect(()=>validateReportedPriceCliMaterial(f.material)).toThrow();
  });
});

describe('reported guarded client boundary regressions',()=>{
  it('snapshots the guarded fetch port and cannot switch to an unguarded replacement',async()=>{
    const f=fixture(),original=f.fetch,loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports),replacement=vi.fn();
    f.input.facts.fetch=replacement;
    expect(await loaded.native.validator.client.tokenDetail(f.identity)).toMatchObject({status:'candidate'});
    expect(original).toHaveBeenCalledTimes(1);expect(replacement).not.toHaveBeenCalled();await loaded.close();
  });
  it('refuses ambiguous origin contracts instead of charging a different provider',async()=>{
    const f=fixture(),original=f.query.getMockImplementation()!;
    f.query.mockImplementation(async sql=>{const value=await original(sql);
      if(sql.includes('reported-cli-provider'))return {...value,rows:[value.rows[0],{...value.rows[0],provider_id:'another-provider'}]} as any;
      return value;});
    await expect(createPostgresCliReportedPriceAuthority(f.input,f.ports)).rejects.toThrow('material_or_authority_refused');
    expect(f.fetch).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('enforces actual response bytes through the real AVE parser',async()=>{
    const f=fixture();Object.assign(f.material.transport,{maximumResponseBytes:1});f.save();
    const loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
    expect(await loaded.native.validator.client.tokenDetail(f.identity)).toEqual({status:'deferred',reason:'response_too_large'});
    expect(f.fetch).toHaveBeenCalledTimes(1);await loaded.close();
  });
  it('rechecks actual validator authority before loading the signing key',async()=>{
    const f=fixture(),loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);f.driftValidator();
    await expect(loaded.native.validator.signingKey.loadPrivateKey({validatorId:'price-validator',keyId:'key',signal:f.input.signal})).rejects.toThrow('actual_validator_contract');
    expect(f.fetch).not.toHaveBeenCalled();await loaded.close();
  });
  it('does not read materials or allocate a connection after startup cancellation',async()=>{
    const f=fixture();f.controller.abort();
    await expect(createPostgresCliReportedPriceAuthority(f.input,f.ports)).rejects.toThrow('material_or_authority_refused');
    expect(f.ports.readPin).not.toHaveBeenCalled();expect(f.ports.openRuntime).not.toHaveBeenCalled();expect(f.fetch).not.toHaveBeenCalled();
  });
});

it('imports and assembles the actual standalone compiled loader without network or database access',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join,resolve}=await import('node:path'),{pathToFileURL}=await import('node:url');
  const {buildAddressOnlyMaintenanceModule}=await import('../build-address-only-compiled-release.mjs');
  const directory=await mkdtemp(join(tmpdir(),'reported-cli-compiled-'));
  try {
    const output=join(directory,'reported.mjs');
    await buildAddressOnlyMaintenanceModule({entry:resolve('scripts/postgres-reported-price-cli-authority.ts'),output,seal:false});
    const compiled=await import(pathToFileURL(output).href),f=fixture();
    const loaded=await compiled.createPostgresCliReportedPriceAuthority(f.input,f.ports);
    expect(f.fetch).not.toHaveBeenCalled();expect(loaded.native.validator.client.tokenDetail).toBeTypeOf('function');
    await expect(loaded.native.validator.client.tokenDetail(f.identity)).resolves.toMatchObject({status:'candidate',reportedMarketCap:100000});
    expect(f.fetch).toHaveBeenCalledTimes(1);await loaded.close();expect(f.close).toHaveBeenCalledTimes(1);
    // This smoke uses guarded transport and PG doubles; it is not native approval or live AVE proof.
  } finally {await rm(directory,{recursive:true,force:true});}
});
it('does not disclose a signing key for a different validator or key identity',async()=>{
  const f=fixture(),loaded=await createPostgresCliReportedPriceAuthority(f.input,f.ports);
  await expect(loaded.native.validator.signingKey.loadPrivateKey({validatorId:'other',keyId:'key',signal:f.input.signal})).rejects.toThrow('signing_request_binding');
  await loaded.close();expect(f.fetch).not.toHaveBeenCalled();
});
