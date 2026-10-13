import { describe,expect,it } from "vitest";
import { extractSolanaSwapEvidence } from "../src/solana-swap-evidence.js";

const wallet="watched-wallet",program="JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const token=(amount:number)=>({accountIndex:1,mint:"candidate",owner:wallet,uiTokenAmount:{uiAmount:amount}});
const meta={err:null,fee:5,preBalances:[100,1000,0],postBalances:[95,900,0],preTokenBalances:[token(0)],postTokenBalances:[token(10)]};
describe("Solana v0 account resolution",()=>{
  it("resolves raw v0 static then writable then readonly lookup addresses without treating the loaded wallet as fee payer",()=>{
    const evidence=extractSolanaSwapEvidence({version:0,transaction:{message:{accountKeys:["payer"],instructions:[{programIdIndex:2}]}},
      meta:{...meta,loadedAddresses:{writable:[wallet],readonly:[program]}}},wallet);
    expect(evidence.knownSwapProgram).toBe(true);expect(evidence.nativeDelta).toBe(-100/1e9);
    expect(evidence.supportsSwap(evidence.candidateDeltas[0]!)).toBe(true);
  });
  it("uses already expanded jsonParsed v0 keys without requiring loadedAddresses",()=>{
    const evidence=extractSolanaSwapEvidence({version:0,transaction:{message:{accountKeys:[{pubkey:"payer"},{pubkey:wallet},{pubkey:program}],instructions:[{programIdIndex:2}]}},meta},wallet);
    expect(evidence.knownSwapProgram).toBe(true);expect(evidence.nativeDelta).toBe(-100/1e9);
  });
  it("does not append loadedAddresses a second time to parsed keys",()=>{
    const evidence=extractSolanaSwapEvidence({version:0,transaction:{message:{accountKeys:[{pubkey:"payer"},{pubkey:wallet},{pubkey:program}],instructions:[{programIdIndex:4}]}},
      meta:{...meta,loadedAddresses:{writable:[wallet],readonly:[program]}}},wallet);
    expect(evidence.knownSwapProgram).toBe(false);
  });
});

// RPC projection: https://solana.com/upgrades/larger-transaction-sizes
// Protocol widths: https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md
const rpcConfig={computeUnitLimit:30000,heapSize:null,loadedAccountsDataSizeLimit:200000,priorityFee:null};
const v1=()=>({version:1,transaction:{message:{accountKeys:["payer",wallet,program],instructions:[{programIdIndex:2,accounts:[0,1]}],transactionConfig:{...rpcConfig}}},meta:{...meta}});
describe("Solana v1 JSON schema",()=>{
  it("reads the official nullable RPC projection and inline program indices",()=>{
    const evidence=extractSolanaSwapEvidence(v1(),wallet);
    expect(evidence.knownSwapProgram).toBe(true);expect(evidence.nativeDelta).toBe(-100/1e9);
    expect(evidence.supportsSwap(evidence.candidateDeltas[0]!)).toBe(true);
  });
  it("allows all nullable fields without substituting legacy defaults",()=>{
    const tx=v1();Object.assign(tx.transaction.message.transactionConfig,{computeUnitLimit:null,loadedAccountsDataSizeLimit:null});
    expect(()=>extractSolanaSwapEvidence(tx,wallet)).not.toThrow();
  });
  it.each(["missing","null","array","string","negative","fraction","u32overflow","unsafeFee","heap","extra"])("rejects malformed config %s",fault=>{
    const tx=v1(),message=tx.transaction.message as Record<string,unknown>;
    if(fault==="missing")delete message.transactionConfig;
    else if(fault==="null")message.transactionConfig=null;
    else if(fault==="array")message.transactionConfig=[];
    else if(fault==="string")message.transactionConfig={...rpcConfig,computeUnitLimit:"30000"};
    else if(fault==="negative")message.transactionConfig={...rpcConfig,priorityFee:-1};
    else if(fault==="fraction")message.transactionConfig={...rpcConfig,computeUnitLimit:0.5};
    else if(fault==="u32overflow")message.transactionConfig={...rpcConfig,loadedAccountsDataSizeLimit:2**32};
    else if(fault==="unsafeFee")message.transactionConfig={...rpcConfig,priorityFee:Number.MAX_SAFE_INTEGER+1};
    else if(fault==="heap")message.transactionConfig={...rpcConfig,heapSize:32769};
    else message.transactionConfig={...rpcConfig,priorityFeeLamports:5};
    expect(()=>extractSolanaSwapEvidence(tx,wallet)).toThrow();
  });
  it.each(["duplicate","tooMany","lookup","loaded","parsedLookup"])("rejects invalid v1 accounts %s",fault=>{
    const tx=v1(),message=tx.transaction.message as Record<string,unknown>;
    if(fault==="duplicate")message.accountKeys=[wallet,{pubkey:wallet}];
    if(fault==="tooMany")message.accountKeys=Array.from({length:65},(_,i)=>String(i));
    if(fault==="lookup")message.addressTableLookups=[{accountKey:"lookup"}];
    if(fault==="loaded")Object.assign(tx.meta,{loadedAddresses:{writable:[wallet],readonly:[]}});
    if(fault==="parsedLookup")message.accountKeys=[{pubkey:wallet,source:"lookupTable"}];
    expect(()=>extractSolanaSwapEvidence(tx,wallet)).toThrow();
  });
  it.each([2,99,-1])("rejects unknown version %s",version=>expect(()=>extractSolanaSwapEvidence({...v1(),version},wallet)).toThrow());
  it.each(["legacy",0] as const)("does not impose v1 account uniqueness on %s",version=>{
    expect(()=>extractSolanaSwapEvidence({version,transaction:{message:{accountKeys:[wallet,wallet],instructions:[]}},meta},wallet)).not.toThrow();
  });
  it("does not use v1 config or ComputeBudget instructions as actual execution fees",()=>{
    const tx=v1();Object.assign(tx.transaction.message.transactionConfig,{priorityFee:900000,heapSize:65536});
    tx.transaction.message.instructions=[{programIdIndex:2,accounts:[0,1]}];
    Object.assign(tx.transaction.message,{instructions:[{programId:"ComputeBudget111111111111111111111111111111"}]});
    const evidence=extractSolanaSwapEvidence(tx,"payer");
    expect(evidence.nativeDelta).toBe(0);expect(evidence.knownSwapProgram).toBe(false);
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

describe("v1 decoded index bounds",()=>{
  for(const location of indexLocations)it.each(invalidV1Indices)("rejects "+location+" index %j without dropping the instruction",index=>{
    const tx=v1();corruptV1Index(tx,location,index);expect(()=>extractSolanaSwapEvidence(tx,wallet)).toThrow();
  });
  it("accepts boundary indices in outer and inner compiled instructions",()=>{
    const tx=v1();Object.assign(tx.meta,{innerInstructions:[{index:0,instructions:[{programIdIndex:2,accounts:[0,2]}]}]});
    expect(extractSolanaSwapEvidence(tx,wallet).knownSwapProgram).toBe(true);
  });
  it("distinguishes parsed address accounts from compiled numeric indices",()=>{
    const tx=v1();Object.assign(tx.transaction.message,{instructions:[{programId:program,accounts:[wallet],data:""},{programId:program,parsed:{type:"swap",info:{}}}]});
    expect(extractSolanaSwapEvidence(tx,wallet).knownSwapProgram).toBe(true);
  });
  it.each([{programId:program,accounts:[1]},{programId:program,programIdIndex:2,accounts:[]},{programIdIndex:2,accounts:["1"]},{programIdIndex:2}])("rejects mixed or malformed compiled instructions %j",instruction=>{
    const tx=v1();Object.assign(tx.transaction.message,{instructions:[instruction]});expect(()=>extractSolanaSwapEvidence(tx,wallet)).toThrow();
  });
});

// https://solana.com/docs/rpc/json-structures: innerInstructions is array | null.
it("accepts v1 null inner instructions without changing swap evidence",()=>{
  const tx=v1(),expected=extractSolanaSwapEvidence(tx,wallet);
  Object.assign(tx.meta,{innerInstructions:null});
  const actual=extractSolanaSwapEvidence(tx,wallet);
  expect(actual.candidateDeltas).toEqual(expected.candidateDeltas);
  expect(actual.nativeDelta).toBe(expected.nativeDelta);
  expect(actual.knownSwapProgram).toBe(expected.knownSwapProgram);
  expect(actual.supportsSwap(actual.candidateDeltas[0]!)).toBe(true);
});
