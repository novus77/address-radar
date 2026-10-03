import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe,expect,it } from "vitest";
import { createPostgresUnitOfWork,type PostgresPool,type PostgresResult } from "../src/postgres-unit-of-work.js";
import { createPostgresCaptureRepository,POSTGRES_CAPTURE_INBOX_SCHEMA_SQL } from "../src/postgres-capture-inbox.js";
import { createPostgresNormalizationRepository,POSTGRES_NORMALIZATION_SCHEMA_SQL } from "../src/postgres-normalization-work.js";
import { createPostgresConsumerWorkRepository,POSTGRES_CONSUMER_WORK_SCHEMA_SQL } from "../src/postgres-consumer-work.js";

const testUrl=process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const policy={consumerName:"canonical-source",consumerVersion:"v1"};
interface TestPool extends PostgresPool {query(text:string,values?:unknown[]):Promise<PostgresResult>;end():Promise<void>}
async function fixture() {
  const url=new URL(testUrl!);
  if(!["postgres:","postgresql:"].includes(url.protocol)||!["localhost","127.0.0.1","[::1]"].includes(url.hostname)
    ||!decodeURIComponent(url.pathname.slice(1)).endsWith("_test"))throw new Error("Consumer tests require a local _test database");
  const schema=`radar_consumer_test_${randomUUID().replaceAll("-","")}`;
  const driver=createRequire(import.meta.url)("pg") as {Pool:new(config:{connectionString:string;max:number;connectionTimeoutMillis:number;options:string})=>TestPool};
  const pool=new driver.Pool({connectionString:testUrl!,max:2,connectionTimeoutMillis:2_000,
    options:`-c search_path=${schema} -c statement_timeout=2000 -c lock_timeout=500`});
  const work=createPostgresUnitOfWork(pool,{statementTimeoutMs:2_000,lockTimeoutMs:500});
  try {await pool.query(`CREATE SCHEMA ${schema}`);
    await work.run(async tx=>{await tx.query(POSTGRES_CAPTURE_INBOX_SCHEMA_SQL+POSTGRES_NORMALIZATION_SCHEMA_SQL+POSTGRES_CONSUMER_WORK_SCHEMA_SQL);
      await tx.query("CREATE TABLE test_consumer_results(result_key text PRIMARY KEY)");});
  }catch(error){try{await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);}finally{await pool.end();}throw error;}
  const seed=async(eventId="event-1",amount="50")=>{
    const job=await work.run(async tx=>{
      const capture=await createPostgresCaptureRepository(tx,{maximumPayloadBytes:65_536}).append({sourceNamespace:"fomo-live",
        sourceEventId:eventId,collectorId:"server",sessionId:"s1",receivedAt:1_000,scrubbedPayload:"{}",semanticPayload:JSON.stringify({amount})});
      return createPostgresNormalizationRepository(tx,65_536).request({sourceNamespace:"fomo-live",sourceEventId:eventId,
        semanticFingerprint:capture.semanticFingerprint,parserVersion:"v1",requestedAt:1_000});
    });
    await work.run(async tx=>{
      const repo=createPostgresNormalizationRepository(tx,65_536);
      const lease=await repo.claim({owner:"parser",now:1_000,leaseMs:100});
      if(!lease||lease.jobId!==job)throw new Error("Normalization fixture claim mismatch");
      await repo.complete(lease,{eventKind:"buy",sourceUserId:"u1",entityId:null,chain:"solana",tokenAddress:"Mint",
        occurredAt:900,normalizedPayload:JSON.stringify({amount})},1_001);
    });
  };
  const schedule=()=>work.run(tx=>createPostgresConsumerWorkRepository(tx,policy).schedulePending(1_002,100));
  const claim=(owner="consumer",now=1_002)=>work.run(tx=>createPostgresConsumerWorkRepository(tx,policy).claim({owner,now,leaseMs:100}));
  const counts=()=>work.run(async tx=>(await tx.query(`SELECT
    (SELECT count(*)::integer FROM capture_consumer_receipts) AS receipts,
    (SELECT count(*)::integer FROM test_consumer_results) AS results,
    (SELECT count(*)::integer FROM capture_consumer_intents WHERE status='dispatched') AS dispatched`)).rows[0]);
  const close=async()=>{try{await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}};
  return {work,seed,schedule,claim,counts,close};
}

describe.skipIf(!testUrl)("PostgreSQL fenced consumer work",()=>{
  it("deduplicates scheduling and records a result with its receipt atomically",async()=>{
    const f=await fixture();try{
      await f.seed();expect(await f.schedule()).toBe(1);expect(await f.schedule()).toBe(0);
      const lease=(await f.claim())!;
      await f.work.run(async tx=>{
        await tx.query("INSERT INTO test_consumer_results VALUES('result-1')");
        expect(await createPostgresConsumerWorkRepository(tx,policy).complete(lease,{outcome:"produced",resultKey:"result-1"},1_003)).toBe(true);
      });
      expect(await f.counts()).toEqual({receipts:1,results:1,dispatched:1});
      expect(await f.claim()).toBeNull();
    }finally{await f.close();}
  });
  it("lets two actual connections claim different intents without duplication",async()=>{
    const f=await fixture();try{
      await f.seed("event-1");await f.seed("event-2");await f.schedule();
      const [first,second]=await Promise.all([f.claim("a"),f.claim("b")]);
      expect(first).not.toBeNull();expect(second).not.toBeNull();expect(first!.intentId).not.toBe(second!.intentId);
      expect(await f.claim("c")).toBeNull();
    }finally{await f.close();}
  });
  it("rejects stale completion after a lease is reclaimed",async()=>{
    const f=await fixture();try{
      await f.seed();await f.schedule();const first=(await f.claim())!;const second=(await f.claim("consumer",1_102))!;
      expect(second.claimGeneration).toBe(first.claimGeneration+1);
      expect(await f.work.run(tx=>createPostgresConsumerWorkRepository(tx,policy).complete(first,{outcome:"no_output",reasonCode:"excluded_by_policy"},1_103))).toBe(false);
      expect(await f.counts()).toEqual({receipts:0,results:0,dispatched:0});
    }finally{await f.close();}
  });
  it("does not create a success receipt or dispatch marker while awaiting data",async()=>{
    const f=await fixture();try{
      await f.seed();await f.schedule();const lease=(await f.claim())!;
      expect(await f.work.run(tx=>createPostgresConsumerWorkRepository(tx,policy).defer(lease,{now:1_003,retryAt:2_000,reasonCode:"missing_execution"}))).toBe(true);
      expect(await f.claim("consumer",1_999)).toBeNull();expect(await f.claim("consumer",2_000)).not.toBeNull();
      expect(await f.counts()).toEqual({receipts:0,results:0,dispatched:0});
    }finally{await f.close();}
  });
  it("rolls back the actual result and receipt after a failed transaction",async()=>{
    const f=await fixture();try{
      await f.seed();await f.schedule();const lease=(await f.claim())!;
      await expect(f.work.run(async tx=>{
        await tx.query("INSERT INTO test_consumer_results VALUES('result-1')");
        await createPostgresConsumerWorkRepository(tx,policy).complete(lease,{outcome:"produced",resultKey:"result-1"},1_003);
        throw new Error("before commit");
      })).rejects.toThrow("before commit");
      expect(await f.counts()).toEqual({receipts:0,results:0,dispatched:0});
    }finally{await f.close();}
  });
  it("records explicit no-output separately from production",async()=>{
    const f=await fixture();try{
      await f.seed();await f.schedule();const lease=(await f.claim())!;
      await f.work.run(tx=>createPostgresConsumerWorkRepository(tx,policy).complete(lease,{outcome:"no_output",reasonCode:"excluded_by_policy"},1_003));
      expect(await f.counts()).toEqual({receipts:1,results:0,dispatched:1});
      const row=await f.work.run(async tx=>(await tx.query("SELECT outcome,reason_code FROM capture_consumer_receipts")).rows[0]);
      expect(row).toEqual({outcome:"no_output",reason_code:"excluded_by_policy"});
    }finally{await f.close();}
  });
  it("prevents unreviewed source revisions from gaining a consumption receipt",async()=>{
    const f=await fixture();try{
      await f.seed();await f.seed("event-1","80");await f.schedule();
      const first=(await f.claim())!;const second=(await f.claim("second"))!;
      const revised=first.requiresReview?first:second;
      expect(revised.requiresReview).toBe(true);
      await expect(f.work.run(tx=>createPostgresConsumerWorkRepository(tx,policy).complete(revised,{outcome:"produced",resultKey:"unapproved"},1_003))).rejects.toThrow("requires review");
      expect(await f.counts()).toEqual({receipts:0,results:0,dispatched:0});
    }finally{await f.close();}
  });
});
