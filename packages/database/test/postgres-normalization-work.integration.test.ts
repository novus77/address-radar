import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createPostgresUnitOfWork, type PostgresPool } from "../src/postgres-unit-of-work.js";
import { createPostgresCaptureRepository, POSTGRES_CAPTURE_INBOX_SCHEMA_SQL } from "../src/postgres-capture-inbox.js";
import { createPostgresNormalizationRepository, POSTGRES_NORMALIZATION_SCHEMA_SQL, type NormalizedCaptureResult } from "../src/postgres-normalization-work.js";

const testUrl=process.env.ADDRESS_RADAR_POSTGRES_TEST_URL;
const capture={sourceNamespace:"fomo-live",sourceEventId:"event-1",collectorId:"server",sessionId:"s1",receivedAt:1_000,
  scrubbedPayload:'{"type":"buy"}',semanticPayload:'{"amount":"50"}'};
const normalized:NormalizedCaptureResult={eventKind:"buy",sourceUserId:"u1",entityId:null,chain:"solana",tokenAddress:"CaseSensitiveMint",
  occurredAt:900,normalizedPayload:'{"amount":"50","entryBasis":"missing"}'};
interface TestPool extends PostgresPool { end():Promise<void> }
async function fixture() {
  const url=new URL(testUrl!);
  if (!["postgres:","postgresql:"].includes(url.protocol)||!["localhost","127.0.0.1","[::1]"].includes(url.hostname)
    ||!decodeURIComponent(url.pathname.slice(1)).endsWith("_test")) throw new Error("Normalization tests require a local _test database");
  const driver=createRequire(import.meta.url)("pg") as {Pool:new(config:{connectionString:string;max:number;connectionTimeoutMillis:number})=>TestPool};
  const pool=new driver.Pool({connectionString:testUrl!,max:1,connectionTimeoutMillis:2_000});
  const work=createPostgresUnitOfWork(pool,{statementTimeoutMs:2_000,lockTimeoutMs:500});
  try { await work.run(async tx=>{await tx.query((POSTGRES_CAPTURE_INBOX_SCHEMA_SQL+POSTGRES_NORMALIZATION_SCHEMA_SQL)
    .replaceAll("CREATE TABLE ","CREATE TEMP TABLE "));}); } catch(error) {await pool.end();throw error;}
  const request=()=>work.run(async tx=>{
    const event=await createPostgresCaptureRepository(tx,{maximumPayloadBytes:65_536}).append(capture);
    return createPostgresNormalizationRepository(tx,65_536).request({sourceNamespace:capture.sourceNamespace,sourceEventId:capture.sourceEventId,
      semanticFingerprint:event.semanticFingerprint,parserVersion:"v1",requestedAt:1_000});
  });
  const claim=(now=1_000)=>work.run(tx=>createPostgresNormalizationRepository(tx,65_536).claim({owner:"worker",now,leaseMs:100}));
  const counts=()=>work.run(async tx=>(await tx.query(`SELECT
    (SELECT count(*)::integer FROM capture_normalized_results) AS results,
    (SELECT count(*)::integer FROM capture_consumer_intents) AS intents`)).rows[0]);
  return {pool,work,request,claim,counts};
}

describe.skipIf(!testUrl)("PostgreSQL normalization work",()=>{
  it("requests parsing atomically with capture and deduplicates that request",async()=>{
    const f=await fixture();try{
      expect(await f.request()).toBe(await f.request());
      const counts=await f.work.run(async tx=>(await tx.query("SELECT count(*)::integer AS count FROM capture_normalization_jobs")).rows[0]);
      expect(counts?.count).toBe(1);
    }finally{await f.pool.end();}
  });
  it("rejects an expired generation even if the same owner reclaims the job",async()=>{
    const f=await fixture();try{
      await f.request();const first=(await f.claim())!;const second=(await f.claim(1_100))!;
      expect(second.claimGeneration).toBe(first.claimGeneration+1);
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(first,normalized,1_101))).toBe(false);
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(second,normalized,1_101))).toBe(true);
      expect(await f.counts()).toEqual({results:1,intents:1});
    }finally{await f.pool.end();}
  });
  it("commits a result and one durable intent but does not claim downstream consumption",async()=>{
    const f=await fixture();try{
      await f.request();const lease=(await f.claim())!;
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(lease,normalized,1_001))).toBe(true);
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(lease,normalized,1_002))).toBe(false);
      const row=await f.work.run(async tx=>(await tx.query("SELECT status FROM capture_consumer_intents")).rows[0]);
      expect(row?.status).toBe("pending");
    }finally{await f.pool.end();}
  });
  it("rolls back result, intent and completion together",async()=>{
    const f=await fixture();try{
      await f.request();const lease=(await f.claim())!;
      await expect(f.work.run(async tx=>{
        await createPostgresNormalizationRepository(tx,65_536).complete(lease,normalized,1_001);
        throw new Error("before commit");
      })).rejects.toThrow("before commit");
      expect(await f.counts()).toEqual({results:0,intents:0});
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(lease,normalized,1_002))).toBe(true);
    }finally{await f.pool.end();}
  });
  it("defers retry without creating a normalized result",async()=>{
    const f=await fixture();try{
      await f.request();const lease=(await f.claim())!;
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).retry(lease,{now:1_001,retryAt:2_000,reason:"missing_schema"}))).toBe(true);
      expect(await f.claim(1_999)).toBeNull();expect(await f.claim(2_000)).not.toBeNull();
      expect(await f.counts()).toEqual({results:0,intents:0});
    }finally{await f.pool.end();}
  });
  it("quarantines an unsupported payload while keeping its capture",async()=>{
    const f=await fixture();try{
      await f.request();const lease=(await f.claim())!;
      expect(await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).quarantine(lease,{now:1_001,reason:"unsupported_shape"}))).toBe(true);
      expect(await f.claim(2_000)).toBeNull();
      const row=await f.work.run(async tx=>(await tx.query("SELECT count(*)::integer AS count FROM capture_raw_payloads")).rows[0]);
      expect(row?.count).toBe(1);
    }finally{await f.pool.end();}
  });
  it("keeps changed business content explicitly awaiting review",async()=>{
    const f=await fixture();try{
      await f.request();const first=(await f.claim())!;
      await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(first,normalized,1_001));
      await f.work.run(async tx=>{
        const revision=await createPostgresCaptureRepository(tx,{maximumPayloadBytes:65_536}).append({...capture,semanticPayload:'{"amount":"80"}'});
        await createPostgresNormalizationRepository(tx,65_536).request({sourceNamespace:capture.sourceNamespace,sourceEventId:capture.sourceEventId,
          semanticFingerprint:revision.semanticFingerprint,parserVersion:"v1",requestedAt:1_002});
      });
      const second=(await f.claim(1_003))!;
      await f.work.run(tx=>createPostgresNormalizationRepository(tx,65_536).complete(second,normalized,1_004));
      const rows=await f.work.run(async tx=>(await tx.query("SELECT requires_review FROM capture_normalized_results ORDER BY committed_at")).rows);
      expect(rows.map(row=>row.requires_review)).toEqual([false,true]);
    }finally{await f.pool.end();}
  });
});
