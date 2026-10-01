import { DatabaseSync } from "node:sqlite";
import { afterEach,describe,expect,it } from "vitest";
import { createFactDemandStore,createSourceLedgerStore,migrateAddressRadarDatabase } from "@address-radar/database";
import { reconcileConsumerHistoryRanges } from "../src/consumer-history-ranges.js";

const HOUR=3600000;
const databases: DatabaseSync[]=[];
afterEach(()=>{while(databases.length)databases.pop()!.close();});
function fixture() {
 const database=new DatabaseSync(":memory:"); migrateAddressRadarDatabase(database); databases.push(database);
 const demands=createFactDemandStore(database),ledger=createSourceLedgerStore(database);
 let now=10*HOUR;
 const record=(to=2*HOUR,id="d",tokenId="base:0xabc")=>demands.record({ demandId:id,consumerId:id,purchaseId:id,tokenId,strategyVersion:"trader-ability-v4-opportunity",purpose:"complete_range",requiredFrom:1000,requiredTo:to,evaluatedAt:now,reasonCode:"market_range_missing",proof:null });
 const jobId="recovery:market_history:base:0xabc";
 ledger.enqueueRecoveryJob({jobId,jobType:"market_history",chain:"base",subjectKey:"base:0xabc",priority:25,cursor:"keep",nextAttemptAt:1,createdAt:1});
 ledger.completeRecoveryJob(jobId,2);
 const run=()=>reconcileConsumerHistoryRanges({database,now:()=>now});
 return { database,demands,ledger,record,jobId,run,advance:(ms:number)=>{now+=ms;} };
}

describe("consumer history range rescheduling",()=>{
 it("requeues missing wallet-only ranges once without satisfying the consumer",()=>{
  const f=fixture(); f.record();
  expect(f.run()).toMatchObject({requeued:1,reopened:0});
  expect(f.ledger.recoveryJob(f.jobId)).toMatchObject({status:"pending",cursor:"keep",attemptCount:0});
  expect(f.demands.get("d")).toMatchObject({status:"pending"});
  f.ledger.completeRecoveryJob(f.jobId,3); f.advance(31*60000);
  expect(f.run()).toMatchObject({requeued:0});
  expect(f.database.prepare("SELECT count(*) n FROM consumer_history_recovery_audits").get()).toEqual({n:1});
 });
 it("rechecks an extended interval after cooldown without resetting an active lease",()=>{
  const f=fixture(); f.record(); f.run();
  f.ledger.claimRecoveryJob(10*HOUR,10000);
  f.record(3*HOUR); expect(f.run().requeued).toBe(0);
  expect(f.ledger.recoveryJob(f.jobId)?.status).toBe("running");
  f.ledger.completeRecoveryJob(f.jobId,10*HOUR);
  expect(f.run().requeued).toBe(0);
  f.advance(31*60000); expect(f.run().requeued).toBe(1);
 });
 it("does not reopen a range already covered by actual canonical hourly points",()=>{
  const f=fixture(); f.record();
  for(const at of [1000,HOUR+1000,2*HOUR]) f.database.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES ('base','0xabc',?,1,'test')").run(at);
  expect(f.run().requeued).toBe(0);
  expect(f.demands.get("d")?.status).toBe("pending");
 });
 it("audits exact range-unavailable terminal recovery and preserves original diagnosis",()=>{
  const f=fixture(); f.record(); f.ledger.failRecoveryJob(f.jobId,"historical_market_range_unavailable",3,true,3);
  expect(f.run()).toMatchObject({reopened:1});
  expect(f.database.prepare("SELECT previous_status status,previous_error error,action FROM consumer_history_recovery_audits").get())
   .toEqual({status:"dead_letter",error:"historical_market_range_unavailable",action:"recover_missing_range"});
 });
 it.each(["unsupported_chain","historical_market_pool_unavailable","historical_market_coverage_unavailable"])("preserves unrelated terminal %s",reason=>{
  const f=fixture(); f.record(); f.ledger.failRecoveryJob(f.jobId,reason,3,true,3);
  expect(f.run().reopened).toBe(0);
  expect(f.ledger.recoveryJob(f.jobId)?.lastError).toBe(reason);
 });
 it("preserves failed retry scheduling and does not treat invalid prices as coverage",()=>{
  const f=fixture(); f.record(); f.ledger.failRecoveryJob(f.jobId,"rate_limited",20*HOUR,false,3);
  expect(f.run().requeued).toBe(0);
  expect(f.ledger.recoveryJob(f.jobId)?.nextAttemptAt).toBe(20*HOUR);
  f.ledger.completeRecoveryJob(f.jobId,4);
  f.database.prepare("INSERT INTO market_observations(chain,token_address,observed_at,price_usd,source) VALUES ('base','0xabc',1000,0,'test')").run();
  expect(f.run().requeued).toBe(1);
 });
});
