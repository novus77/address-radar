import { createHash, generateKeyPairSync } from "node:crypto";
import { runtimeAuthorityFingerprint, type RuntimeAuthorityJob } from "../provision-address-only-runtime-authority.js";
import type { ReviewedPostgresExecutionProviderBinding } from "../../apps/automation/src/postgres-independent-execution-validator.js";
import { describe,expect,it,vi } from "vitest";
import { createConfiguredSourceProbe, SOLANA_MAINNET_GENESIS } from "../probe-address-only-configured-source.js";
import { preparePostgresWalletCapture, type PostgresWalletProfile } from "../../apps/wallet-monitor/src/postgres-wallet-channel.js";

function fixture(multiChain=false) {
  const keys=generateKeyPairSync("ed25519"),now=100_000,source="https://solana-rpc.publicnode.com",replay="https://api.mainnet-beta.solana.com";
  const wallet="11111111111111111111111111111111",mint="TokenCase",usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const profile:PostgresWalletProfile={wallet:{address:wallet,accountId:"account",entityId:"entity",lifecycle:"active"},
    fact:{entityId:"entity",channel:"wallet",subjectId:wallet,walletFamily:"solana",associationConfidence:"confirmed",associationSource:"fixture",
      ownerCount:1,walletConfidence:"confirmed",walletSource:"fixture",identityEvidenceRef:"identity",ownershipEvidenceRef:"owner",monitoringEnabled:true,suspended:false},
    profileEnabled:true,profileSuspended:false,bindingState:"owned",versionId:"version"};
  const balance=(accountIndex:number,token:string,amount:number)=>({accountIndex,mint:token,owner:wallet,uiTokenAmount:{uiAmount:amount}});
  const replies:Record<string,unknown>={getGenesisHash:SOLANA_MAINNET_GENESIS,getSignatureStatuses:{value:[{slot:5,err:null,confirmationStatus:"finalized"}]},
    getTransaction:{version:1,slot:5,blockTime:90,transaction:{signatures:["fixture-signature"],message:{accountKeys:[wallet,"token-account","usdc-account"],instructions:[],
      transactionConfig:{computeUnitLimit:null,heapSize:null,loadedAccountsDataSizeLimit:null,priorityFee:null}}},
      meta:{err:null,fee:5000,preBalances:[1_000_000_000,0,0],postBalances:[999_995_000,0,0],innerInstructions:null,
        preTokenBalances:[balance(1,mint,0),balance(2,usdc,100)],postTokenBalances:[balance(1,mint,100),balance(2,usdc,40)]}},
    getBlock:{blockhash:"block",blockTime:90,signatures:["fixture-signature"]}};
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{const r=JSON.parse(String(init?.body));return new Response(JSON.stringify({jsonrpc:"2.0",id:r.id,result:replies[r.method]}));});
  const query=vi.fn(async(_sql:string,params?:readonly unknown[])=>({rows:[{approved:params?.[6]===ledgerFingerprint && params?.[8]==="runtime-ledger-approval"}],rowCount:1}));
  const payload=preparePostgresWalletCapture({generationId:"generation",collectorId:"solana",sessionId:"fixture",chainFamily:"solana",receivedAt:now,
    profile,executionTrust:"unverified",event:{eventId:"event",chain:"solana",walletAddress:wallet,tokenAddress:mint,side:"buy",occurredAt:90_000,
      amountUsd:null,priceUsd:null,marketCapUsd:null,sourceReference:"solana:fixture-signature"}}).payload;
  const contract=(providerId:string,endpoint:string)=>({providerId,endpoint,importId:`import-${providerId}`,sourceFingerprint:"a".repeat(64),windowMs:60_000,maximumRequests:60,maximumConcurrency:1});
  const options={schema:"radar_business",generationId:"generation",activatedAt:1000,source:contract("publicnode-source",source),replay:contract("official-replay",replay),
    validatorImport:{importId:"validator-import",sourceFingerprint:"b".repeat(64)},maximumRunMs:5000,maximumRequests:8,maximumBodyBytes:128_000,
    ports:{fetch,profiles:{load:vi.fn(async()=>({status:"ready" as const,profiles:[profile]}))},run:async<T>(fn:(tx:{query:typeof query})=>Promise<T>)=>fn({query})},
    validator:{generationId:"generation",activatedAt:1000,validatorId:"validator",keyId:"key",publicKey:keys.publicKey.export({type:"spki",format:"pem"}).toString(),
      signingKey:{loadPrivateKey:()=>keys.privateKey},reviewedProviderBindings:[{chain:"solana" as const,sourceProviderId:"publicnode-source",sourceEndpoint:source,
        replayProviderId:"official-replay",replayEndpoint:replay,expectedGenesisHash:SOLANA_MAINNET_GENESIS},...(multiChain?[{chain:"eth" as const,sourceProviderId:"eth-source",sourceEndpoint:"https://eth-source.example",
        replayProviderId:"eth-replay",replayEndpoint:"https://eth-replay.example",expectedChainId:"0x1",expectedGenesisBlockHash:"0x"+"a".repeat(64),stableQuoteTokens:[{address:"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",symbol:"USDC" as const}]}]:[])] as ReviewedPostgresExecutionProviderBinding[],maximumProfiles:10,maximumRpcRequests:4,maximumLogs:10,
      maximumDecimalsReads:4,maximumPayloadBytes:128_000,maximumRunMs:5000,validationTtlMs:60_000,maximumNonces:10,nonce:()=>"fixture_nonce_0123456789"},now:()=>now};
  const authority = {protocol:"address-only-cli-execution-authority-v1",operationId:"operation",generationId:"generation",releaseSha256:"c".repeat(64),
    username:"execution_publisher",migrationRole:"address_radar_migrator",credential:{path:"/private/credential.json",sha256:"d".repeat(64)},privateKey:{path:"/private/key.pem",sha256:"e".repeat(64)},
    validator:{...options.validator,signingKey:undefined,nonce:undefined,generationId:undefined,activatedAt:undefined},
    publisher:{maximumValidationAgeMs:60_000,maximumPayloadBytes:128_000,statementTimeoutMs:1000,lockTimeoutMs:1000,validators:[{validatorId:"validator",keyId:"key",publicKey:options.validator.publicKey,actorId:"independent-operator",authorizationRef:"execution-approval",reviewedSourceProviders:["official-replay"]}]}};
  const raw=Buffer.from(JSON.stringify(authority)),sha256=createHash("sha256").update(raw).digest("hex");
  const configuration:RuntimeAuthorityJob["validators"][number]={kind:"execution",validatorId:"validator",importId:"validator-import",evidenceSha256:"f".repeat(64),
    importedAt:1000,validFrom:1000,validUntil:500_000,keyId:"key",publicKey:options.validator.publicKey,actorId:"independent-operator",
    authorizationRef:"execution-approval",reviewedSourceProviders:["official-replay"]};
  const ledgerFingerprint=runtimeAuthorityFingerprint({approvalRef:"runtime-ledger-approval",proofScope:"validator_authority",configuration});
  options.validatorImport.sourceFingerprint=ledgerFingerprint;
  const boundOptions={...options,validatorImport:{...options.validatorImport,approvalRef:"runtime-ledger-approval",configuration},authority:{pin:{path:"/private/authority.json",sha256},operationId:"operation",releaseSha256:"c".repeat(64),actorId:"independent-operator",authorizationRef:"execution-approval"},
    ports:{...options.ports,readPin:vi.fn(async()=>raw)}};
  return {options:boundOptions,payload,replies,fetch,query,ledgerFingerprint};
}

describe("controlled configured PublicNode source probe",()=>{
  it("requires actual contracts before 4 source and 4 independent replay calls and verifies a real signature",async()=>{
    const f=fixture(),result=await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal});
    expect(result).toMatchObject({status:"verified",sourceRequests:4,replayRequests:4,mainnetGenesisVerified:true,sourceVersion1Verified:true,replayVersion1Verified:true,independentSignatureVerified:true});
    expect(f.query).toHaveBeenCalledOnce();expect(f.query.mock.calls[0]?.[0]).not.toMatch(/INSERT|UPDATE|DELETE|GRANT|CREATE/);
    expect(f.fetch).toHaveBeenCalledTimes(8);expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[0]!);
    const calls=f.fetch.mock.calls.map(([url,init])=>({url,body:JSON.parse(String(init?.body))}));
    expect(calls.map(c=>c.url)).toEqual([...Array(4).fill(f.options.source.endpoint),...Array(4).fill(f.options.replay.endpoint)]);
    for(const call of calls.filter(c=>c.body.method==="getTransaction"))expect(call.body.params[1].maxSupportedTransactionVersion).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/https:|fixture-signature|TokenCase|BEGIN|private/);
  });
  it("refuses missing authority/contract before network",async()=>{
    const f=fixture();f.query.mockResolvedValue({rows:[{approved:false}],rowCount:1});
    expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({status:"deferred",reasonCode:"probe_approval_unavailable"});
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([403,429])("stops after HTTP %s without fallback or replay",async status=>{
    const f=fixture();f.fetch.mockResolvedValueOnce(new Response("secret provider text",{status}));
    const result=await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal});
    expect(result).toMatchObject({status:"deferred",reasonCode:status===403?"probe_access_denied":"probe_rate_limited"});expect(f.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("stops on HTTP200 RPC rate-limit without retry",async()=>{
    const f=fixture();f.fetch.mockImplementationOnce(async(_url,init)=>new Response(JSON.stringify({jsonrpc:"2.0",id:JSON.parse(String(init?.body)).id,error:{code:-32005,message:"too many requests secret"}})));
    expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({reasonCode:"probe_rate_limited"});expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each(["genesis","version","bytes","requests"])("fails closed for %s",async fault=>{
    const f=fixture();if(fault==="genesis")f.replies.getGenesisHash="wrong";
    if(fault==="version")(f.replies.getTransaction as {version:number}).version=0;
    if(fault==="bytes")f.options.maximumBodyBytes=10;
    if(fault==="requests")f.options.maximumRequests=1;
    expect((await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).status).toBe("deferred");
    expect(f.fetch.mock.calls.every(([url])=>url===f.options.source.endpoint)).toBe(true);
  });
  it("rejects Helius or an unbound source at construction",()=>{
    const f=fixture();expect(()=>createConfiguredSourceProbe({...f.options,source:{...f.options.source,endpoint:"https://mainnet.helius-rpc.com"}})).toThrow("probe_configuration_invalid");expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not bypass budget rejection or expose its error",async()=>{
    const f=fixture();f.fetch.mockRejectedValueOnce(Object.assign(new Error("secret URL"),{name:"PostgresProviderBudgetError"}));
    const result=await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal});
    expect(result).toMatchObject({status:"deferred",reasonCode:"probe_provider_budget_unavailable"});expect(f.fetch).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain("secret");
  });
});

it("enforces streamed response bytes rather than trusting Content-Length",async()=>{
  const f=fixture();f.fetch.mockResolvedValueOnce(new Response("x".repeat(129_000),{headers:{"Content-Length":"1"}}));
  const result=await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal});
  expect(result).toMatchObject({status:"deferred",reasonCode:"probe_response_budget_exceeded"});expect(f.fetch).toHaveBeenCalledOnce();
});

it("stops at replay 403 without any subsequent requests",async()=>{
  const f=fixture(),base=f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async(url,init)=>url===f.options.replay.endpoint?new Response("private",{status:403}):base(url,init));
  expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({reasonCode:"probe_access_denied",sourceRequests:4,replayRequests:1});
  expect(f.fetch).toHaveBeenCalledTimes(5);
});

it("returns on deadline but fences reentry until the original native approval read drains",async()=>{
  vi.useFakeTimers();
  try{
    const f=fixture();f.options.maximumRunMs=20;
    let settle!:(value:{rows:{approved:boolean}[];rowCount:number})=>void;
    f.query.mockImplementationOnce(()=>new Promise(resolve=>{settle=resolve;}));
    const probe=createConfiguredSourceProbe(f.options),input={payload:f.payload,signal:new AbortController().signal};
    const pending=probe.probe(input);await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({reasonCode:"probe_aborted_or_timed_out"});
    expect(await probe.probe(input)).toMatchObject({reasonCode:"probe_busy"});expect(f.fetch).not.toHaveBeenCalled();
    settle({rows:[{approved:true}],rowCount:1});await vi.advanceTimersByTimeAsync(0);
    const controller=new AbortController();controller.abort();
    expect(await probe.probe({payload:f.payload,signal:controller.signal})).toMatchObject({reasonCode:"probe_aborted_or_timed_out"});
    expect(f.fetch).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
});


it.each(["key","publicKey","privateKey","actor","scope"])("rejects mismatched authority %s before RPC",async fault=>{
  const f=fixture();
  if(fault==="key")f.options.validator.keyId="other";
  if(fault==="publicKey")f.options.validator.publicKey=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString();
  if(fault==="privateKey")f.options.validator.signingKey.loadPrivateKey=()=>generateKeyPairSync("ed25519").privateKey;
  if(fault==="actor")f.options.authority.actorId="other";
  if(fault==="scope")f.options.authority.authorizationRef="other";
  expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({status:"deferred",reasonCode:"probe_authority_unavailable"});
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(["windowMs","maximumRequests","maximumConcurrency"] as const)("rejects expanded %s even with matching approved DB",field=>{
  const f=fixture();f.options.source[field]*=2;f.options.replay[field]*=2;
  expect(()=>createConfiguredSourceProbe(f.options)).toThrow("probe_configuration_invalid");expect(f.fetch).not.toHaveBeenCalled();
});
it("binds actual runtime ledger fingerprint separately from validator authorization reference",async()=>{
  const f=fixture();await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal});
  expect(f.query.mock.calls[0]?.[0]).toContain("l.approval_ref=$9");
  expect(f.query.mock.calls[0]?.[1]?.[6]).toBe(f.ledgerFingerprint);
  expect(f.ledgerFingerprint).not.toBe(f.options.authority.pin.sha256);
  expect(f.query.mock.calls[0]?.[1]?.[8]).toBe("runtime-ledger-approval");
  expect(f.options.authority.authorizationRef).toBe("execution-approval");
  expect(f.query.mock.calls[0]?.[0]).toContain("v.valid_from=$10 AND v.valid_until=$11");
  expect(f.query.mock.calls[0]?.[0]).toContain("l.imported_at=$12");
  expect(f.query.mock.calls[0]?.[1]?.slice(9)).toEqual([1000,500_000,1000]);
});

it.each([false,true])("real guarded fetch fences until lease-release ACK; ignored abort=%s",async ignoredAbort=>{
  const {createPostgresServiceFactAdapters}=await import("../../apps/automation/src/postgres-service-fact-adapters.js");
  const f=fixture(),controller=new AbortController();
  let markStarted!:()=>void,markRelease!:()=>void,releaseAck!:()=>void,finishNetwork!:(response:Response)=>void;
  const started=new Promise<void>(resolve=>{markStarted=resolve;}),releaseStarted=new Promise<void>(resolve=>{markRelease=resolve;});
  const releasePending=new Promise<void>(resolve=>{releaseAck=resolve;});
  let abortObserved=false,networkSettled=false;
  const network=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((resolve,reject)=>{
    finishNetwork=response=>{networkSettled=true;resolve(response);};
    init?.signal?.addEventListener("abort",()=>{
      abortObserved=true;
      if(!ignoredAbort){networkSettled=true;reject(new Error("cancelled"));}
    },{once:true});
    markStarted();
  }));
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes("service-provider-budget-lock"))return {rows:[{provider_id:"publicnode-source",window_started_at:90_000,
      window_ms:60_000,maximum_requests:60,requests_used:0,maximum_concurrency:1,active_leases:0,cooldown_until:0}],rowCount:1};
    if(sql.includes("service-provider-budget-debit"))return {rows:[{provider_id:"publicnode-source"}],rowCount:1};
    if(sql.includes("service-provider-release")){markRelease();await releasePending;}
    return {rows:[],rowCount:1};
  });
  const runtime={probe:async()=>({generation:"generation",service:"wallet-monitor"}),
    run:async<T>(fn:(tx:{query:typeof query})=>Promise<T>)=>fn({query})} as unknown as import("../../packages/database/src/postgres-business-driver.js").PostgresBusinessRuntime;
  const guarded=await createPostgresServiceFactAdapters({runtime,generationId:"generation",maximumProfiles:10,now:f.options.now,
    sources:{leaseMs:5000,maximumProfileAgeMs:60_000,maximumFactAgeMs:60_000,maximumSafetyAgeMs:10_000,
      providerTimeoutMs:1000,maximumResponseBytes:128_000,maximumFactPayloadBytes:128_000,fetchImpl:network}});
  const probe=createConfiguredSourceProbe({...f.options,ports:{...f.options.ports,fetch:guarded.fetch}});
  const input={payload:f.payload,signal:controller.signal},pending=probe.probe(input);
  await started;controller.abort();
  expect(await pending).toMatchObject({status:"deferred",reasonCode:"probe_aborted_or_timed_out"});
  await releaseStarted;
  expect(abortObserved).toBe(true);
  expect(await probe.probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({reasonCode:"probe_busy"});
  expect(query.mock.calls.filter(([sql])=>sql.startsWith("INSERT INTO wallet_service_provider_leases"))).toHaveLength(1);
  expect(query.mock.calls.filter(([sql])=>sql.includes("service-provider-release"))).toHaveLength(1);
  releaseAck();
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(await probe.probe(input)).toMatchObject({reasonCode:"probe_aborted_or_timed_out"});
  expect(network).toHaveBeenCalledOnce();
  // The guarded port drains its lease, not an arbitrary fetch implementation that ignores AbortSignal.
  // Such implementations are not safe production transports; this test does not certify network drain.
  expect(networkSettled).toBe(!ignoredAbort);
  if(ignoredAbort)finishNetwork(new Response(null,{status:204}));
});


it("accepts the existing multi-chain authority shape and selects the exact Solana binding",async()=>{
  const f=fixture(true);
  expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({status:"verified",sourceRequests:4,replayRequests:4});
  expect(f.fetch.mock.calls.every(([url])=>url===f.options.source.endpoint || url===f.options.replay.endpoint)).toBe(true);
});
it.each(["fingerprint","ledger-ref","validator-ref","import","kind","actor","key","public-key","replay"])("rejects wrong approved configuration %s before RPC",async fault=>{
  const f=fixture();
  if(fault==="fingerprint")f.options.validatorImport.sourceFingerprint="0".repeat(64);
  if(fault==="ledger-ref")f.options.validatorImport.approvalRef="execution-approval";
  const v=f.options.validatorImport.configuration;
  if(fault==="validator-ref")v.authorizationRef="runtime-ledger-approval";
  if(fault==="import")v.importId="other-import";
  if(fault==="kind")v.kind="price";
  if(fault==="actor")v.actorId="other-actor";
  if(fault==="key")v.keyId="other-key";
  if(fault==="public-key")v.publicKey=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString();
  if(fault==="replay")v.reviewedSourceProviders=["other-replay"];
  if(!["fingerprint","ledger-ref"].includes(fault))f.options.validatorImport.sourceFingerprint=runtimeAuthorityFingerprint({approvalRef:f.options.validatorImport.approvalRef,proofScope:"validator_authority",configuration:v});
  expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({status:"deferred",reasonCode:"probe_authority_unavailable"});
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(["fingerprint","approval-ref"])("rejects mismatched actual ledger %s with zero RPC",async fault=>{
  const f=fixture();
  f.query.mockImplementation(async(_sql,params)=>({rows:[{approved:params?.[fault==="fingerprint"?6:8]===(fault==="fingerprint"?"0".repeat(64):"other-ledger-approval")}],rowCount:1}));
  expect(await createConfiguredSourceProbe(f.options).probe({payload:f.payload,signal:new AbortController().signal})).toMatchObject({reasonCode:"probe_approval_unavailable"});
  expect(f.query).toHaveBeenCalledOnce();expect(f.fetch).not.toHaveBeenCalled();
});
it("rejects duplicate Solana bindings even inside a multi-chain authority",()=>{
  const f=fixture(true);f.options.validator.reviewedProviderBindings.push({...f.options.validator.reviewedProviderBindings[0]!});
  expect(()=>createConfiguredSourceProbe(f.options)).toThrow("probe_configuration_invalid");expect(f.fetch).not.toHaveBeenCalled();
});
