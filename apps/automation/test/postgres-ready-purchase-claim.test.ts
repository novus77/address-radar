import { describe,expect,it,vi } from "vitest";
import { claimPostgresReadyPurchase, POSTGRES_READY_PURCHASE_CLAIM_SQL } from "../src/postgres-ready-purchase-claim.js";
const input={generationId:"generation",consumerVersion:"forward-purchase-v1:g",owner:"automation",now:1000,leaseMs:60000,
  maximumFacts:32,maximumCaptures:32,maximumPayloadBytes:2097152,preferReady:true};
describe("bounded readiness-aware purchase claim",()=>{
  it("keeps the original lease protocol and treats the row only as a scheduling lease",async()=>{
    const query=vi.fn(async(_sql: string, _values?: unknown[])=>({rows:[{intent_id:"fresh",job_id:"job",semantic_fingerprint:"fingerprint",parser_version:"wallet-chain-v1",
      claim_generation:2,lease_expires_at:61000,requires_review:false}],rowCount:1}));
    const lease=await claimPostgresReadyPurchase({query},input);
    expect(query).toHaveBeenCalledTimes(1);
    expect(lease).toEqual({intentId:"fresh",jobId:"job",consumerName:"forward_purchase_match",consumerVersion:input.consumerVersion,
      owner:"automation",claimGeneration:2,leaseExpiresAt:61000,inputFingerprint:"fingerprint",parserVersion:"wallet-chain-v1",requiresReview:false});
    expect(lease).not.toHaveProperty("purchase");expect(lease).not.toHaveProperty("verified");
  });
  it("bounds fact and capture windows and never casts an unchecked envelope",()=>{
    expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("LIMIT $7");
    expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("LIMIT $8");
    expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("CASE WHEN result_bytes<=$9");
    expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("a.expires_at>$3");
    expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("v.valid_until>$3");
    expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("FOR UPDATE OF w SKIP LOCKED");
  });
  it("passes the explicit FIFO turn without changing the existing allocation",async()=>{
    const query=vi.fn(async(_sql: string, _values?: unknown[])=>({rows:[],rowCount:0}));
    expect(await claimPostgresReadyPurchase({query},{...input,preferReady:false})).toBeNull();
    expect(query.mock.calls[0]?.[1]).toEqual(["forward_purchase_match",input.consumerVersion,1000,"automation",61000,"generation",32,32,2097152,false]);
  });
  it.each([{maximumFacts:0},{maximumCaptures:1001},{maximumPayloadBytes:0},{leaseMs:0},{now:Number.MAX_SAFE_INTEGER}])("rejects invalid bounded inputs %j",async patch=>{
    const query=vi.fn(async(_sql: string, _values?: unknown[])=>({rows:[],rowCount:0}));
    await expect(claimPostgresReadyPurchase({query},{...input,...patch})).rejects.toThrow();expect(query).not.toHaveBeenCalled();
  });
});

it("matches the byte-bounded exact subject before truncating the capture window",()=>{
  const start=POSTGRES_READY_PURCHASE_CLAIM_SQL.indexOf("capture_window AS MATERIALIZED");
  const limit=POSTGRES_READY_PURCHASE_CLAIM_SQL.indexOf("LIMIT $8",start);
  const before=POSTGRES_READY_PURCHASE_CLAIM_SQL.slice(start,limit);
  expect(before).toContain("AND h.subject_key=(SELECT");
  expect(before).toContain("CASE WHEN octet_length(n.normalized_payload)<=$9 THEN n.normalized_payload::jsonb ELSE NULL END p");
});

it("deduplicates qualified subjects before fact LIMIT/bytes and uses semijoins for capture uniqueness",()=>{
 const representatives=POSTGRES_READY_PURCHASE_CLAIM_SQL.indexOf("SELECT DISTINCT ON(f.generation_id,f.kind,f.subject_key)");
 const limit=POSTGRES_READY_PURCHASE_CLAIM_SQL.indexOf("LIMIT $7");
 expect(representatives).toBeGreaterThan(-1);expect(representatives).toBeLessThan(limit);
 expect(POSTGRES_READY_PURCHASE_CLAIM_SQL).toContain("f.subject_key,f.known_at DESC,f.fact_id DESC");
 const captures=POSTGRES_READY_PURCHASE_CLAIM_SQL.slice(POSTGRES_READY_PURCHASE_CLAIM_SQL.indexOf("capture_window AS MATERIALIZED"),POSTGRES_READY_PURCHASE_CLAIM_SQL.indexOf("LIMIT $8"));
 expect(captures).toContain("FROM capture_consumer_jobs w");
 expect(captures).toContain("EXISTS(SELECT 1 FROM live_hints h");
 expect(captures).toContain("EXISTS(SELECT 1 FROM wallet_capture_generation_bindings g");
 expect(captures).not.toContain("JOIN live_hints");expect(captures).not.toContain("JOIN wallet_capture_generation_bindings");
 expect(captures).not.toContain("n.occurred_at::text");expect(captures).toContain("AND n.occurred_at=CASE WHEN");
});
