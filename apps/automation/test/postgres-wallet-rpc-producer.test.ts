import { describe,expect,it,vi } from "vitest";
import type { PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { preparePostgresWalletCapture } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { deriveExecutionBasis } from "../../wallet-monitor/src/execution-basis.js";
import { createPostgresSolanaExecutionProducer } from "../src/postgres-wallet-rpc-producer.js";

const mint="TokenCase",usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",signature="signature",now=100_000;
const profile:PostgresWalletProfile={wallet:{address:"11111111111111111111111111111111",accountId:"account",entityId:"entity",lifecycle:"active"},
  fact:{entityId:"entity",channel:"wallet",subjectId:"11111111111111111111111111111111",walletFamily:"solana",associationConfidence:"confirmed",
    associationSource:"fixture",ownerCount:1,walletConfidence:"confirmed",walletSource:"fixture",
    identityEvidenceRef:"fixture:identity",ownershipEvidenceRef:"fixture:owner",monitoringEnabled:true,suspended:false},
  profileEnabled:true,profileSuspended:false,bindingState:"owned",versionId:"fixture:version"};
const basis=deriveExecutionBasis({successful:true,swapConfirmed:true,tokenDeltas:[{asset:mint,quantity:100}],
  quoteDeltas:[{asset:usdc,symbol:"USDC",quantity:-60,verifiedStablecoin:true}]});
function capture(){return preparePostgresWalletCapture({generationId:"generation",collectorId:"solana",sessionId:"fixture",
  chainFamily:"solana",receivedAt:now,profile,executionTrust:"rpc_execution",event:{eventId:`solana:${signature}:${mint}:buy`,
    chain:"solana",walletAddress:"11111111111111111111111111111111",tokenAddress:mint,side:"buy",occurredAt:90_000,amountUsd:60,priceUsd:0.6,
    marketCapUsd:null,sourceReference:`solana:${signature}`,executionBasis:basis}}).payload;}
function setup(overrides:Record<string,unknown>={},current=profile,onRpcDiagnostic?: (diagnostic: unknown) => void){
  const balance=(accountIndex:number,mint:string,amount:number)=>({accountIndex,mint,owner:"11111111111111111111111111111111",uiTokenAmount:{uiAmount:amount}});
  const responses:Record<string,unknown>={getGenesisHash:"reviewed-genesis",
    getSignatureStatuses:{value:[{slot:5,err:null,confirmationStatus:"finalized"}]},
    getTransaction:{slot:5,blockTime:90,transaction:{signatures:[signature],message:{accountKeys:["11111111111111111111111111111111","candidate-token-account","quote-token-account"],instructions:[]}},
      meta:{err:null,fee:5000,preBalances:[1_000_000_000,0,0],postBalances:[999_995_000,0,0],
        preTokenBalances:[balance(1,mint,0),balance(2,usdc,100)],postTokenBalances:[balance(1,mint,100),balance(2,usdc,40)]}},
    getBlock:{blockhash:"canonical-block",blockTime:90,signatures:[signature]},...overrides};
  const request=vi.fn(async (_chain:string,method:string)=>responses[method]);
  const load=vi.fn(async()=>({status:"ready" as const,profiles:[current]}));
  const producer=createPostgresSolanaExecutionProducer({generationId:"generation",activatedAt:1000,providerId:"approved-rpc",
    expectedGenesisHash:"reviewed-genesis",rpc:{request},profiles:{load},maximumProfiles:10,maximumPayloadBytes:64_000,
    maximumRunMs:1000,now:()=>now,...(onRpcDiagnostic ? { onRpcDiagnostic } : {})});
  return {producer,request,load,responses};
}

describe("real targeted wallet RPC acquisition",()=>{
  it("actually queries finalized RPC and recomputes execution, without a trusted-attestation/eligibility shortcut",async()=>{
    const {producer,request}=setup(),result=await producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(result.status).toBe("acquired");if(result.status!=="acquired")throw new Error("Expected actual evidence candidate");
    expect(request.mock.calls.map(call=>call[1])).toEqual(["getGenesisHash","getSignatureStatuses","getTransaction","getBlock"]);
    expect(result.candidate.purchaseCandidate).toMatchObject({amountUsd:"60",entryPriceUsd:"0.6",tokenQuantity:"100",amountEstimated:true,
      amountBasis:"stablecoin_nominal",entityId:"entity",sourceUserId:"account"});
    expect(result.candidate).toMatchObject({providerId:"approved-rpc",genesisHash:"reviewed-genesis",slot:5,blockHash:"canonical-block",
      sourceReference:`solana:${signature}`,observedAt:90_000,knownAt:now});
    expect(result.candidate).not.toHaveProperty("attestation");expect(result.candidate).not.toHaveProperty("independenceKey");
    expect(result.candidate).not.toHaveProperty("liveSourceVerified");
  });
  it("keeps replay semantic IDs stable without inventing fresh historical events",async()=>{
    const {producer}=setup(),input={payload:capture(),signal:new AbortController().signal};
    const first=await producer.acquire(input),second=await producer.acquire(input);
    expect(first.status).toBe("acquired");expect(second.status).toBe("acquired");
    if(first.status!=="acquired"||second.status!=="acquired")throw new Error("Expected real acquisition");
    expect(first.candidate.contentFingerprint).toBe(second.candidate.contentFingerprint);
  });
  it.each([
    {getGenesisHash:"other-network"},
    {getSignatureStatuses:{value:[{slot:5,err:null,confirmationStatus:"confirmed"}]}},
    {getBlock:{blockhash:"canonical-block",blockTime:90,signatures:["other-signature"]}},
    {getBlock:{blockhash:"canonical-block",blockTime:91,signatures:[signature]}},
    {getTransaction:null},
  ])("defers missing/noncanonical execution %j",async overrides=>{
    const {producer}=setup(overrides);expect(await producer.acquire({payload:capture(),signal:new AbortController().signal})).toMatchObject({status:"deferred"});
  });
  it("never acquires RPC for a suspended owner or an old/wrong generation",async()=>{
    const suspended=setup({}, {...profile,profileSuspended:true});
    expect(await suspended.producer.acquire({payload:capture(),signal:new AbortController().signal})).toMatchObject({status:"deferred"});
    expect(suspended.request).not.toHaveBeenCalled();
    let state=setup(),old=capture();old = { ...old, generationId: "other" };
    expect(await state.producer.acquire({payload:old,signal:new AbortController().signal})).toMatchObject({status:"deferred"});expect(state.request).not.toHaveBeenCalled();
  });
  it("rejects a captured quantity/price mismatch rather than copying the injected price",async()=>{
    let state=setup(),payload=capture();payload = { ...payload, event: {...payload.event,priceUsd:999} };
    expect(await state.producer.acquire({payload,signal:new AbortController().signal})).toMatchObject({status:"deferred"});
  });
  it("retains below-50 factual execution without adding a producer dust gate",async()=>{
    let state=setup(),payload=capture(),tx=state.responses.getTransaction as {meta:{postTokenBalances:Array<{uiTokenAmount:{uiAmount:number}}>}};
    tx.meta.postTokenBalances[1]!.uiTokenAmount.uiAmount=90;
    payload = { ...payload, event: {...payload.event,amountUsd:10,priceUsd:0.1,executionBasis:deriveExecutionBasis({successful:true,swapConfirmed:true,
      tokenDeltas:[{asset:mint,quantity:100}],quoteDeltas:[{asset:usdc,symbol:"USDC",quantity:-10,verifiedStablecoin:true}]})} };
    payload = { ...payload, purchase: null };
    const result=await state.producer.acquire({payload,signal:new AbortController().signal});
    expect(result.status).toBe("acquired");if(result.status!=="acquired")throw new Error("Expected real low-amount execution");
    expect(result.candidate.purchaseCandidate.amountUsd).toBe("10");
  });
  it("bounds a provider that ignores cancellation",async()=>{
    const state=setup();const producer=createPostgresSolanaExecutionProducer({generationId:"generation",activatedAt:1000,
      providerId:"approved-rpc",expectedGenesisHash:"reviewed-genesis",rpc:{request:()=>new Promise(()=>undefined)},profiles:{load:state.load},
      maximumProfiles:10,maximumPayloadBytes:64_000,maximumRunMs:10,now:()=>now});
    expect(await producer.acquire({payload:capture(),signal:new AbortController().signal})).toMatchObject({status:"deferred"});
  });
});

describe("closed execution acquisition transport diagnostics",()=>{
  it.each([
    ["PostgresProviderBudgetError","execution_rpc_provider_budget_unavailable"],
    ["WalletRpcRateLimitError","execution_rpc_rate_limited"],
    ["JsonRpcRateLimitError","execution_rpc_rate_limited"],
    ["JsonRpcTimeoutError","execution_rpc_timed_out"],
    ["JsonRpcResponseError","execution_rpc_response_error"],
    ["JsonRpcAbortError","execution_rpc_aborted"],
    ["TypeError","execution_rpc_transport_unavailable"],
  ])("retains %s as a safe reason without raw exception text",async(name,reasonCode)=>{
    const state=setup();
    state.request.mockRejectedValueOnce(Object.assign(new Error("https://private.example/token?secret=private"),{name}));
    const result=await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(result).toEqual({status:"deferred",reasonCode});
    expect(JSON.stringify(result)).not.toContain("private");expect(state.request).toHaveBeenCalledTimes(1);
  });
});

describe("safe RPC method/code/subcategory diagnostics",()=>{
  it.each([
    [-32602,"Invalid params: private payload","invalid_params"],
    [-32601,"Method not found: https://private.example","method_not_found"],
    [-32015,"Transaction version not supported private","unsupported_transaction_version"],
    [-32000,"Transaction version (1) is not supported by the requesting client","unsupported_transaction_version"],
    [-32000,"Invalid API key: private","authentication_required"],
    [-32000,"Access denied: private","permission_denied"],
    [-32000,"Transaction history is not available from this node","resource_unavailable"],
    [-32603,"private internal failure","rpc_internal_error"],
    [undefined,"Malformed JSON-RPC response","malformed_response"],
    [undefined,"JSON-RPC HTTP 401: https://private.example","authentication_required"],
    [undefined,"JSON-RPC HTTP 403: https://private.example","permission_denied"],
    [-32099,"private opaque failure","other_rpc_error"],
  ])("retains only closed diagnostic metadata for code %s",async(code,message,subcategory)=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);
    state.request.mockImplementation(async(_chain,method)=>{
      if(method==="getTransaction")throw Object.assign(new Error(message),{name:"JsonRpcResponseError",code});
      return state.responses[method];
    });
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal}))
      .toEqual({status:"deferred",reasonCode:"execution_rpc_response_error"});
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({method:"getTransaction",code:code??null,subcategory,reasonCode:"execution_rpc_response_error"});
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|https:|payload|API key/);
    expect(state.request.mock.calls.map(call=>call[1])).toEqual(["getGenesisHash","getSignatureStatuses","getTransaction"]);
  });
  it.each([NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,"-32602"])("does not expose unsafe numeric code %s",async code=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);
    state.request.mockRejectedValueOnce(Object.assign(new Error("opaque"),{name:"JsonRpcResponseError",code}));
    await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({method:"getGenesisHash",code:null,subcategory:"other_rpc_error",reasonCode:"execution_rpc_response_error"});
  });
  it("cannot turn a diagnostic sink failure into a successful acquisition or a new RPC call",async()=>{
    const state=setup({},profile,()=>{throw new Error("private sink failure");});
    state.request.mockRejectedValueOnce(Object.assign(new Error("Invalid params private"),{name:"JsonRpcResponseError",code:-32602}));
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal}))
      .toEqual({status:"deferred",reasonCode:"execution_rpc_response_error"});
    expect(state.request).toHaveBeenCalledTimes(1);
  });
});

describe("RPC diagnostic own-data snapshots",()=>{
  it.each(["name","code","message","reasonCode"])("never invokes a changing %s accessor",async field=>{
    const toJSON=vi.fn(()=>"secret"),getter=vi.fn().mockReturnValueOnce(field==="name"?"JsonRpcResponseError":field==="code"?-32602:"rpc_json_limit_ambiguous").mockReturnValue({toJSON});
    const error=Object.assign(new Error("opaque"),{name:"JsonRpcResponseError",code:-32602});
    Object.defineProperty(error,field,{get:getter,configurable:true});
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);state.request.mockRejectedValueOnce(error);
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal})).toMatchObject({status:"deferred"});
    expect(getter).not.toHaveBeenCalled();expect(toJSON).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret");
  });
  it("ignores inherited code/message/limit classification without calling hooks",async()=>{
    const getter=vi.fn(()=>"secret");
    const error=Object.assign(new Error(),{name:"JsonRpcResponseError"});
    const prototype=Object.create(Error.prototype);
    for(const field of ["code","message","reasonCode"])Object.defineProperty(prototype,field,{get:getter});
    Object.setPrototypeOf(error,prototype);
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);state.request.mockRejectedValueOnce(error);
    await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(getter).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({method:"getGenesisHash",code:null,subcategory:"other_rpc_error",reasonCode:"execution_rpc_response_error"});
  });
  it("never serializes an unknown Error subclass or object-valued properties",async()=>{
    const toJSON=vi.fn(()=>"secret"),toString=vi.fn(()=>"secret");
    class UnknownFailure extends Error { toJSON=toJSON; }
    const error=new UnknownFailure("opaque");
    Object.assign(error,{name:{toJSON,toString},code:{toJSON,toString},reasonCode:{toJSON,toString},message:{toJSON,toString}});
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);state.request.mockRejectedValueOnce(error);
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal}))
      .toEqual({status:"deferred",reasonCode:"execution_rpc_transport_unavailable"});
    expect(toJSON).not.toHaveBeenCalled();expect(toString).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret");
  });
});

describe("explicit supported Solana transaction versions",()=>{
  it.each([2,-1,"0",null,true,{}])("refuses unknown response version %j before requesting its block",async version=>{
    const state=setup();state.responses.getTransaction={...state.responses.getTransaction as object,version};
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal}))
      .toEqual({status:"deferred",reasonCode:"execution_transaction_mismatch"});
    expect(state.request.mock.calls.map(call=>call[1])).toEqual(["getGenesisHash","getSignatureStatuses","getTransaction"]);
  });
  it.each(["legacy",0,1])("sends explicit maximum version one over actual JSON-RPC and decodes %s",async version=>{
    const state=setup();state.responses.getTransaction={...state.responses.getTransaction as object,version};
    if(version===1){const tx=state.responses.getTransaction as {transaction:{message:Record<string,unknown>}};
      tx.transaction.message.transactionConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};}
    const {createConfiguredWalletRpcClient}=await import("../../wallet-monitor/src/rpc.js");
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const request=JSON.parse(String(init?.body));
      if(request.method==="getTransaction")expect(request.params).toEqual([signature,{commitment:"finalized",encoding:"jsonParsed",maxSupportedTransactionVersion:1}]);
      if(request.method==="getBlock")expect(request.params[1].maxSupportedTransactionVersion).toBe(1);
      return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,result:state.responses[request.method]}));
    });
    const producer=createPostgresSolanaExecutionProducer({generationId:"generation",activatedAt:1000,providerId:"approved-rpc",expectedGenesisHash:"reviewed-genesis",
      profiles:{load:state.load},maximumProfiles:10,maximumPayloadBytes:64000,maximumRunMs:1000,now:()=>now,
      rpc:createConfiguredWalletRpcClient({endpoints:{solana:{primary:"https://fixture.example/rpc"}},fetch})});
    expect((await producer.acquire({payload:capture(),signal:new AbortController().signal})).status).toBe("acquired");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

const invalidV1Indices=[-1,0.5,3,Number.MAX_SAFE_INTEGER+1,"1",null,undefined];
const indexLocations=["preToken","postToken","outerProgram","outerAccount","innerProgram","innerAccount"] as const;
function corruptV1Index(tx: {transaction:{message:Record<string,unknown>};meta:Record<string,unknown>},location:string,index:unknown){
  if(location==="preToken"||location==="postToken"){
    const key=location==="preToken"?"preTokenBalances":"postTokenBalances";
    const balances=structuredClone(tx.meta[key]) as Array<Record<string,unknown>>;balances[0]!.accountIndex=index;tx.meta[key]=balances;return;
  }
  const instruction=location.endsWith("Program")?{programIdIndex:index,accounts:[0,1,2]}:{programIdIndex:0,accounts:[index]};
  if(location.startsWith("outer"))tx.transaction.message.instructions=[instruction];
  else tx.meta.innerInstructions=[{index:0,instructions:[instruction]}];
}

describe("v1 producer index bounds",()=>{
  for(const location of indexLocations)it.each(invalidV1Indices)("rejects "+location+" index %j before block RPC",async index=>{
    const state=setup(),tx=state.responses.getTransaction as {transaction:{message:Record<string,unknown>};meta:Record<string,unknown>};
    Object.assign(tx,{version:1});tx.transaction.message.transactionConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};
    corruptV1Index(tx,location,index);
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal})).toEqual({status:"deferred",reasonCode:"execution_transaction_mismatch"});
    expect(state.request.mock.calls.map(call=>call[1])).toEqual(["getGenesisHash","getSignatureStatuses","getTransaction"]);
  });
});

it("acquires v1 with legally null inner instructions",async()=>{
  const state=setup(),tx=state.responses.getTransaction as {transaction:{message:Record<string,unknown>};meta:Record<string,unknown>};
  Object.assign(tx,{version:1});Object.assign(tx.meta,{innerInstructions:null});
  tx.transaction.message.transactionConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};
  expect((await state.producer.acquire({payload:capture(),signal:new AbortController().signal})).status).toBe("acquired");
  expect(state.request).toHaveBeenCalledTimes(4);
});

describe("optional safe budget and transport details",()=>{
  it.each([
    ["PostgresProviderBudgetError",{budgetReason:"cooldown"},{budgetReason:"cooldown"}],
    ["JsonRpcRateLimitError",{reasonCode:"rpc_http_rate_limited"},{transport:"http"}],
    ["WalletRpcRateLimitError",{reasonCode:"rpc_json_rate_limited"},{transport:"rpc"}],
  ])("snapshots optional details for %s",async(name,fields,expected)=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);
    state.request.mockRejectedValueOnce(Object.assign(new Error("secret https://private"),{name,...fields}));
    await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject(expected);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret");
  });
  it("never invokes an optional budget getter",async()=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic),getter=vi.fn(()=>"secret");
    const error=Object.assign(new Error("private"),{name:"PostgresProviderBudgetError"});
    Object.defineProperty(error,"budgetReason",{get:getter});state.request.mockRejectedValueOnce(error);
    await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(getter).not.toHaveBeenCalled();expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("secret");
  });
});


describe("safe optional RPC status and retry snapshots",()=>{
  it.each([429,401,403,200])("keeps HTTP %s separate from JSON-RPC code",async httpStatus=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);
    state.request.mockRejectedValueOnce(Object.assign(new Error("private"),{name:"JsonRpcResponseError",code:-32602,httpStatus,retryAt:160000}));
    expect(await state.producer.acquire({payload:capture(),signal:new AbortController().signal})).toMatchObject({status:"deferred",reasonCode:"execution_rpc_response_error"});
    expect(diagnostic.mock.calls[0]?.[0]).toMatchObject({code:-32602,httpStatus,retryAt:160000});
    expect(state.request).toHaveBeenCalledTimes(1);
  });
  it.each(["httpStatus","retryAt"])("never executes a %s accessor",async field=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic),getter=vi.fn(()=>429);
    const error=Object.assign(new Error("private"),{name:"JsonRpcResponseError"});
    Object.defineProperty(error,field,{get:getter});state.request.mockRejectedValueOnce(error);
    await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(getter).not.toHaveBeenCalled();expect(diagnostic.mock.calls[0]?.[0]).not.toHaveProperty(field);
  });
  it.each([NaN,Infinity,-1,Number.MAX_SAFE_INTEGER+1])("omits unsafe retry timing %s",async retryAt=>{
    const diagnostic=vi.fn(),state=setup({},profile,diagnostic);
    state.request.mockRejectedValueOnce(Object.assign(new Error("private"),{name:"PostgresProviderBudgetError",budgetReason:"cooldown",retryAt}));
    await state.producer.acquire({payload:capture(),signal:new AbortController().signal});
    expect(diagnostic.mock.calls[0]?.[0]).not.toHaveProperty("retryAt");
  });
});
