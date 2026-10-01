import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutomationJobStore,createCandidateHistoryStore,createFactDemandStore,createSourceLedgerStore,createTokenFactStore,migrateAddressRadarDatabase } from "@address-radar/database";
import { createRecoveryRuntime } from "../src/recovery-runtime.js";
import { createSourceRecoveryHandlers } from "../src/source-recovery-handlers.js";

const databases: DatabaseSync[]=[];
afterEach(()=>{while(databases.length)databases.pop()!.close();});
function fixture(){
 const database=new DatabaseSync(":memory:");migrateAddressRadarDatabase(database);databases.push(database);
 const ledger=createSourceLedgerStore(database);
 const jobId="recovery:market_history:base:0xabc";
 ledger.enqueueRecoveryJob({jobId,jobType:"market_history",chain:"base",subjectKey:"base:0xabc",priority:25,cursor:null,nextAttemptAt:1,createdAt:1});
 return {database,ledger,jobId};
}

describe("provider budget coordination",()=>{
 it("cannot exceed quota through an interleaving stale budget read",async()=>{
  const f=fixture();
  const read=f.ledger.budgetUsage.bind(f.ledger);
  const ledger={...f.ledger};
  vi.spyOn(ledger,"budgetUsage").mockImplementation((provider,window)=>{
   const observed=read(provider,window);
   f.ledger.addBudgetUsage(provider,window,1,100);
   return observed;
  });
  const runtime=createRecoveryRuntime({ledger,clock:{now:()=>100},handlers:{market_history:context=>{
   context.consumeBudget({provider:"gecko",usageWindow:"0",units:1,limit:1,retryAt:60000});
  }}});
  await runtime.runOnce();
  expect(read("gecko","0")).toBeLessThanOrEqual(1);
 });

 it("charges fallback to the current minute after the primary crosses a window boundary",async()=>{
  const f=fixture();let now=59999;
  createFactDemandStore(f.database).record({demandId:"d",consumerId:"trader",purchaseId:"buy",tokenId:"base:0xabc",strategyVersion:"trader-ability-v4-opportunity",purpose:"complete_range",requiredFrom:1000,requiredTo:50000,evaluatedAt:59000,reasonCode:"market_range_missing",proof:null});
  const handlers=createSourceRecoveryHandlers({database:f.database,ledger:f.ledger,jobs:createAutomationJobStore(f.database),history:createCandidateHistoryStore(f.database),facts:createTokenFactStore(f.database),now:()=>now,
   marketProvider:{} as Parameters<typeof createSourceRecoveryHandlers>[0]["marketProvider"],
   historicalMarketProvider:{topPool:async()=>{now=60001;return null;},ohlcv:async()=>[],trades:async()=>[]},
   historicalPriceFallback:{chart:async()=>({source:"defillama_chart",confidence:1,prices:[{observedAt:1000,priceUsd:1},{observedAt:50000,priceUsd:2}]})},
   fomoProducer:{enqueue:async()=>undefined},
  });
  const charges:Array<{provider:string;usageWindow:string;retryAt:number}>=[];
  await handlers.market_history!({job:f.ledger.recoveryJob(f.jobId)!,checkpoint:()=>undefined,consumeBudget:request=>{charges.push(request);}});
  expect(charges).toHaveLength(2);
  expect(charges[0]?.usageWindow).toBe("0");
  expect(charges[1]?.usageWindow).toBe("1");
  expect(charges[1]!.retryAt).toBeGreaterThan(now);
 });
});
