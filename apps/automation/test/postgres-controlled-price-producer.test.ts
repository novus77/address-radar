import { describe, expect, it, vi } from "vitest";
import { createPostgresGeckoTerminalPriceProducer, createPostgresReportedMarketCapProducer, normalizeAveReportedMarketCap } from "../src/postgres-controlled-price-producer.js";
const token="TokenCase",pool="PoolCase";
const mapping={chain:"solana" as const,tokenAddress:token,poolAddress:pool,tokenSide:"base" as const,network:"solana",evidenceRef:"reviewed:pool-token-map",knownAt:100000};
function fixture(ohlcv:unknown=[[120,1,3,0.5,2,20]],mappingAddress=token){const fetch=vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).includes("ohlcv")?{data:{attributes:{ohlcv_list:ohlcv}}}:{data:[{id:`solana_${pool}`,attributes:{address:pool,base_token_price_usd:"99",quote_token_price_usd:"1",reserve_in_usd:"100",market_cap_usd:null,fdv_usd:null,pool_created_at:null},relationships:{base_token:{data:{id:`solana_${mappingAddress}`}},quote_token:{data:{id:"solana_USDC"}}}}]}),{status:200,headers:{"content-type":"application/json"}}));
const producer=createPostgresGeckoTerminalPriceProducer({generationId:"generation",activatedAt:1000,providerId:"gecko",fetch,baseUrl:"https://approved.example/api/v2",timeoutMs:1000,minimumRequestIntervalMs:0,rateLimitCooldownMs:1000,maximumRunMs:1000,maximumPayloadBytes:64000,maximumCandles:10,maximumWindowMs:200000,maximumMappingAgeMs:100000,timeframe:"minute",aggregate:1,now:()=>200000});return{producer,fetch};}
const input={generationId:"generation",sampleId:"sample",executionFingerprint:"a".repeat(64),boughtAt:90000,until:180000,mapping,signal:new AbortController().signal};
describe("controlled actual GeckoTerminal price acquisition",()=>{
 it("actually fetches mapped pool and closed post-buy candles, never current-market entry",async()=>{const f=fixture(),result=await f.producer.acquire(input);expect(result.status).toBe("acquired");if(result.status!=="acquired")return;expect(f.fetch).toHaveBeenCalledTimes(2);expect(result.candidate.candles).toEqual([{timestamp:120000,open:1,high:3,low:0.5,close:2,volumeUsd:20}]);expect(result.candidate).not.toHaveProperty("entryPriceUsd");expect(result.candidate).not.toHaveProperty("attestation");expect(result.candidate.mapping.evidenceRef).toBe(mapping.evidenceRef);});
 it("does not treat a pool for another case-sensitive Solana token as coverage",async()=>{const f=fixture(undefined,"tokencase");expect((await f.producer.acquire(input)).status).toBe("deferred");});
 it("excludes a candle containing pre-purchase or incomplete future prices",async()=>{for(const candles of [[[60,1,3,0.5,2,20]],[[180,1,3,0.5,2,20]]]){const f=fixture(candles);expect((await f.producer.acquire(input)).status).toBe("deferred");}});
 it("does not replay stale mapping or old generation histories",async()=>{const f=fixture();expect((await f.producer.acquire({...input,mapping:{...mapping,knownAt:0}})).status).toBe("deferred");expect((await f.producer.acquire({...input,generationId:"old"})).status).toBe("deferred");expect(f.fetch).not.toHaveBeenCalled();});
 it("requires explicit source budgets before factory creates any transport",()=>{const f=fixture();expect(()=>createPostgresGeckoTerminalPriceProducer({generationId:"generation",activatedAt:1000,providerId:"gecko",fetch:f.fetch,baseUrl:"https://approved.example",timeoutMs:1000,minimumRequestIntervalMs:0,rateLimitCooldownMs:1000,maximumRunMs:1000,maximumPayloadBytes:64000,maximumCandles:0,maximumWindowMs:200000,maximumMappingAgeMs:100000,timeframe:"minute",aggregate:1,now:()=>200000})).toThrow();});
 it("preserves the explicit client timeout signal instead of replacing it with the run deadline",async()=>{vi.useFakeTimers();try{const signals:AbortSignal[]=[];const fetch:typeof globalThis.fetch=async(_url,init)=>new Promise((_resolve,reject)=>{const signal=init!.signal!;signals.push(signal);signal.addEventListener("abort",()=>reject(new Error("source timeout")),{once:true});});const producer=createPostgresGeckoTerminalPriceProducer({generationId:"generation",activatedAt:1000,providerId:"gecko",fetch,baseUrl:"https://approved.example",timeoutMs:10,minimumRequestIntervalMs:0,rateLimitCooldownMs:1000,maximumRunMs:1000,maximumPayloadBytes:64000,maximumCandles:10,maximumWindowMs:200000,maximumMappingAgeMs:100000,timeframe:"minute",aggregate:1,now:()=>200000});const result=producer.acquire(input);await vi.advanceTimersByTimeAsync(10);expect((await result).status).toBe("deferred");expect(signals[0]!.aborted).toBe(true);}finally{vi.useRealTimers();}});
});

// Synthetic AVE responses and root-local bindings, never live approval or production facts.
const reportedIdentity = { chain: 'solana', token: '1'.repeat(31) + '2', pool: '1'.repeat(31) + '3', quote: '1'.repeat(31) + '4' };
const reportedMapping = { ...mapping, tokenAddress: reportedIdentity.token, poolAddress: reportedIdentity.pool };
const reportedResponse = () => ({ status: 'candidate' as const, verified: false as const, independence: 'unverified' as const,
  identity: reportedIdentity, reportedMarketCap: 100000, reportedFdv: 900000, reportedTvl: 20, reportedUpdatedAt: 150,
  circulatingMarketCapVerified: false as const, amm: 'synthetic-amm' });
function reportedFixture() {
  const tokenDetail = vi.fn(async () => reportedResponse());
  const options = { generationId: 'generation', activatedAt: 1000, providerId: 'approved-ave', sourceApprovalRef: 'approved:ave-source',
    identity: reportedIdentity, client: { tokenDetail }, maximumRunMs: 1000, maximumPayloadBytes: 64000,
    maximumWindowMs: 200000, maximumMappingAgeMs: 100000, now: () => 200000 };
  return { options, tokenDetail, request: { ...input, mapping: reportedMapping } };
}
describe('reported-cap controlled acquisition', () => {
  it('normalizes source reported cap independently of FDV without supply or independence claims', async () => {
    const f = reportedFixture();
    const result = await createPostgresReportedMarketCapProducer(f.options).acquire(f.request);
    expect(result.status).toBe('acquired');
    if (result.status !== 'acquired') throw new Error('Expected isolated acquisition');
    expect(result.candidate).toMatchObject({ kind: 'reported_market_cap', providerId: 'approved-ave', sourceApprovalRef: 'approved:ave-source',
      report: { marketCapUsd: '100000', fdvUsd: '900000', reportedAt: 150000, quality: 'reported', independence: 'unverified' } });
    expect(result.candidate).not.toHaveProperty('candles');
    expect(result.candidate).not.toHaveProperty('circulatingSupply');
    expect(f.tokenDetail).toHaveBeenCalledOnce();
  });
  it.each(['null-cap', 'future', 'pre-buy', 'wrong-token', 'fdv-only'])('defers %s without fallback', async kind => {
    const f = reportedFixture(), raw = reportedResponse();
    if (kind === 'null-cap' || kind === 'fdv-only') Object.assign(raw, { reportedMarketCap: null });
    if (kind === 'future') raw.reportedUpdatedAt = 201;
    if (kind === 'pre-buy') raw.reportedUpdatedAt = 1;
    if (kind === 'wrong-token') raw.identity = { ...reportedIdentity, token: reportedIdentity.quote };
    f.tokenDetail.mockResolvedValue(raw);
    expect(await createPostgresReportedMarketCapProducer(f.options).acquire(f.request)).toMatchObject({ status: 'deferred' });
  });
  it('normalizer never substitutes FDV or infers supply', () => {
    expect(() => normalizeAveReportedMarketCap({ ...reportedResponse(), reportedMarketCap: null }, reportedIdentity)).toThrow();
  });
  it('snapshots provider, identity, key-free client port and all budgets before await', async () => {
    const f = reportedFixture();
    let deliver!: (raw: ReturnType<typeof reportedResponse>) => void;
    f.tokenDetail.mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
    const producer = createPostgresReportedMarketCapProducer(f.options);
    const pending = producer.acquire(f.request);
    f.options.providerId = 'changed'; f.options.maximumPayloadBytes = 1; f.options.sourceApprovalRef = 'changed';
    deliver(reportedResponse());
    expect(await pending).toMatchObject({ status: 'acquired', candidate: { providerId: 'approved-ave', sourceApprovalRef: 'approved:ave-source' } });
  });
  it('retains busy capacity when the source ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const f = reportedFixture(); f.tokenDetail.mockImplementation(() => new Promise(() => {}));
      const producer = createPostgresReportedMarketCapProducer({ ...f.options, maximumRunMs: 20 });
      const work = producer.acquire(f.request); await vi.advanceTimersByTimeAsync(20);
      expect(await work).toMatchObject({ status: 'deferred' });
      expect(await producer.acquire(f.request)).toMatchObject({ reasonCode: 'reported_market_producer_busy' });
      expect(f.tokenDetail).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
