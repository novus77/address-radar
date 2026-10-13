import { attachDedicatedReportedApproval, dedicatedReportedLedgerRow } from './reported-market-approval-fixture.js';
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { postgresServiceFactFingerprint } from "../src/postgres-service-fact-adapters.js";
import { createPostgresPriceFactPublisher, priceCandidateFingerprint, priceValidationSigningPayload,
  type PostgresPriceValidationClaims, type SignedPostgresPriceValidation } from "../src/postgres-price-fact-publisher.js";
import { createPostgresPriceCandidateReceiver } from "../src/postgres-price-candidate-receiver.js";
import type { PostgresGeckoTerminalPriceCandidate, PostgresPriceCandidate } from "../src/postgres-controlled-price-producer.js";
import { createPostgresGeckoTerminalPriceProducer, createPostgresReportedMarketCapProducer } from "../src/postgres-controlled-price-producer.js";
import { createPostgresIndependentPriceValidator, createPostgresReportedMarketCapValidator } from '../src/postgres-independent-price-validator.js';
import { receivePostgresProductionPriceBatch } from '../src/postgres-production-composition.js';
import { createPostgresForwardOpportunityRepository, type PostgresTransaction } from '@address-radar/database';
import { evaluateForwardOpportunity } from '@address-radar/scoring';
import type { ForwardPeakEvidence } from '@address-radar/domain';
import { composePostgresServicePriceDependencies } from '../../../scripts/postgres-price-authority.js';
import type { PostgresRootPriceConfiguration } from '../../../scripts/postgres-service-entry.js';
const keys=generateKeyPairSync("ed25519");
const mapping={chain:"solana" as const,tokenAddress:"TokenCase",poolAddress:"PoolCase",tokenSide:"base" as const,network:"solana",evidenceRef:"approved:map",knownAt:100000};
const candidate:PostgresGeckoTerminalPriceCandidate={generationId:"generation",sampleId:"sample",executionFingerprint:"a".repeat(64),providerId:"gecko",boughtAt:90000,until:180000,knownAt:200000,mapping,candles:[{timestamp:120000,open:1,high:3,low:0.5,close:2,volumeUsd:20}],contentFingerprint:"",coverage:"bounded_observations_only"};
const rawProof={mapping,candleMs:60000,sourceRevision:"actual:candle-revision",candles:[...candidate.candles],rawEvidence:{provider:"fixture-independent-feed",response:[[120,1,3,0.5,2,20]]}};
function actualCandidate():PostgresGeckoTerminalPriceCandidate{return {...candidate,contentFingerprint:priceCandidateFingerprint(candidate)};}
const target={database:"radar_business",schema:"business_v1",username:"approved_price_publisher",serverAddress:"127.0.0.1",serverPort:5432,generationId:"generation",schemaVersion:2,schemaFingerprint:"b".repeat(64)};
function signed(candidateValue: PostgresPriceCandidate=actualCandidate(),changes:Partial<PostgresPriceValidationClaims>={}):SignedPostgresPriceValidation {
 if(candidateValue.kind==='reported_market_cap')throw new Error('Candle fixture cannot sign reported-market authority');
 const sourceProof={...rawProof,mapping:candidateValue.mapping,candles:candidateValue.candles,sourceRevision:changes.sourceRevision??rawProof.sourceRevision};
 const claims:PostgresPriceValidationClaims={format:1,generationId:"generation",providerId:"gecko",validatorId:"price-validator",keyId:"reviewed-key",candidateFingerprint:candidateValue.contentFingerprint,candidateKnownAt:candidateValue.knownAt,sampleId:"sample",executionFingerprint:candidateValue.executionFingerprint,mappingApprovalRef:"approval:map",sourceApprovalRef:"approval:source",sourceRevision:"actual:candle-revision",validationRef:"proof:price-replay",checkedAt:200000,expiresAt:300000,sourceBasis:{kind:"approved-candle-replay",providerId:"other-feed",evidenceRef:"proof:independent-source",contentFingerprint:postgresServiceFactFingerprint(sourceProof)},...changes};
 return{claims,signature:sign(null,priceValidationSigningPayload(claims),keys.privateKey).toString("base64"),sourceProof};
}
function fixture(){
 const calls:{sql:string;values:readonly unknown[]}[]=[];let inputs:Record<string,unknown>[]=[];let attestations:Record<string,unknown>[]=[];let wakes:string[]=[];let at=200000;
 const query=vi.fn(async(sql:string,values:readonly unknown[]=[])=>{calls.push({sql,values});let rows:Record<string,unknown>[]=[];
  if(sql.includes("price-publisher-identity"))rows=[{...target,session_username:target.username,schema_generation:target.generationId,schema_version:target.schemaVersion,schema_fingerprint:target.schemaFingerprint,role_safe:true,consumer_member:false,objects_safe:true,can_publish:true}];
  else if(sql.includes("price-publisher-validator"))rows=[{valid_from:0,valid_until:300000,revoked_at:null,import_revoked_at:null}];
  else if(sql.includes("price-publisher-sample"))rows=[{generation_id:"generation",execution_fingerprint:candidate.executionFingerprint,chain:"solana",token_address:"TokenCase",occurred_at:90000,expires_at:2592090000,activated_at:1000,revision_state:"original"}];
  else if(sql.includes("price-publisher-existing")){const index=inputs.findIndex(x=>x.fact_id===values[0]);if(index>=0)rows=[{input:inputs[index],attestation:attestations[index]}];}
  else if(sql.includes("INSERT INTO wallet_service_fact_inputs"))inputs.push(JSON.parse(String(values[0])));
  else if(sql.includes("INSERT INTO wallet_service_fact_attestations")){const row=JSON.parse(String(values[0])) as Record<string,unknown>;attestations.push(row);rows=[{fact_id:row.fact_id}];}
  else if(sql.includes("INSERT INTO wallet_forward_signal_wake_intents")){const key=String(values[1]);if(!wakes.includes(key))wakes.push(key);}
  return{rows,rowCount:rows.length};
 });
 const run=async<T>(operation:(tx:{query:typeof query})=>Promise<T>)=>{const oldInputs=structuredClone(inputs),oldAttestations=structuredClone(attestations),oldWakes=[...wakes];try{return await operation({query});}catch(error){inputs=oldInputs;attestations=oldAttestations;wakes=oldWakes;throw error;}};
 const options={run,target,forbiddenRoles:["scanner","automation","wallet-monitor","wallet-analysis","historical-backfill","console","migration"],validators:[{validatorId:"price-validator",keyId:"reviewed-key",publicKey:keys.publicKey.export({type:"spki",format:"pem"}).toString(),actorId:"verified-price-actor",authorizationRef:"approval:validator",reviewedSourceProviders:["other-feed"]}],mappings:[{mapping,providerId:"gecko",mappingApprovalRef:"approval:map",sourceApprovalRef:"approval:source",sourceProofKind:"approved-candle-replay",candleMs:60000,validFrom:100000,validUntil:300000}],maximumValidationAgeMs:100000,maximumMappingAgeMs:100000,maximumPayloadBytes:128000,maximumCandles:3,maximumWindowMs:200000,statementTimeoutMs:2000,lockTimeoutMs:500,now:()=>at};
 return{options,query,calls,getInputs:()=>inputs,getAttestations:()=>attestations,getWakes:()=>wakes,setNow:(value:number)=>{at=value;}};
}
const signal=()=>new AbortController().signal;
it('isolated synthetic single-sample price acquisition, independent validation, publication, consumption and opportunity', async () => {
  // No live source, real approval, PostgreSQL server, business fact or delivery is created by this fixture.
  const f = fixture(), sourceUrl = 'https://source.invalid/api/v2', replayUrl = 'https://replay.invalid/api/v2';
  const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).includes('ohlcv')
    ? { data: { attributes: { ohlcv_list: [[120, 1, 3, 0.5, 2, 20]] } } }
    : { data: [{ id: 'solana_PoolCase', attributes: { address: 'PoolCase', base_token_price_usd: '99', quote_token_price_usd: '1',
      reserve_in_usd: '100', market_cap_usd: null, fdv_usd: null, pool_created_at: null },
      relationships: { base_token: { data: { id: 'solana_TokenCase' } }, quote_token: { data: { id: 'solana_USDC' } } } }] }),
    { headers: { 'content-type': 'application/json' } }));
  const source = { providerId: 'gecko', baseUrl: sourceUrl, timeoutMs: 1000, minimumRequestIntervalMs: 0, rateLimitCooldownMs: 1000,
    maximumRunMs: 1000, maximumPayloadBytes: 128000, maximumCandles: 3, maximumWindowMs: 200000, maximumMappingAgeMs: 100000,
    timeframe: 'minute' as const, aggregate: 1 };
  const pin = { ...f.options.mappings[0]!, sourceProofKind: 'independent_gecko_ohlcv_replay_v1' };
  const priceAcquisition: PostgresRootPriceConfiguration = { source, mappings: [pin],
    receiver: { maximumCandidates: 1, maximumRunMs: 1000, maximumPayloadBytes: 128000 },
    retry: { maximumSamples: 1, maximumRetryEntries: 1, maximumMappings: 1, maximumPayloadBytes: 128000, maximumRunMs: 1000, retryDelayMs: 1000 } };
  const nativePriceAuthority = { publisher: { ...f.options, mappings: [pin] }, validator: {
    ...source, generationId: 'generation', activatedAt: 1000, validatorId: 'price-validator', keyId: 'reviewed-key',
    actorId: 'verified-price-actor', authorizationRef: 'approval:validator', publicKey: f.options.validators[0]!.publicKey,
    signingKey: { loadPrivateKey: () => keys.privateKey }, fetch, now: () => 200000,
    maximumCandidateAgeMs: 10000, maximumResponseBytes: 128000, maximumRequests: 2, maximumOutstandingPorts: 3, validationTtlMs: 30000,
    reviewedBindings: [{ sourceProviderId: 'gecko', replayProviderId: 'other-feed', sourceBaseUrl: sourceUrl, replayBaseUrl: replayUrl,
      ...pin, timeframe: 'minute' as const, aggregate: 1 }],
    approval: { authorizePriceReplay: async () => ({ status: 'approved' as const, approval: {
      approvalRef: 'approval:validator', generationId: 'generation', validatorId: 'price-validator', keyId: 'reviewed-key',
      actorId: 'verified-price-actor', sourceProviderId: 'gecko', replayProviderId: 'other-feed', sourceOperatorId: 'fixture-source-operator',
      replayOperatorId: 'fixture-replay-operator', sourceDataPlatformId: 'fixture-source-platform', replayDataPlatformId: 'fixture-replay-platform',
      mappingApprovalRef: pin.mappingApprovalRef, sourceApprovalRef: pin.sourceApprovalRef, sourceProofKind: pin.sourceProofKind,
      mappingFingerprint: postgresServiceFactFingerprint(mapping), candleMs: 60000, validFrom: 100000, validUntil: 300000, revokedAt: null,
      consistencyPolicy: { policyId: 'fixture-only-exact', kind: 'exact_closed_candles_v1', approvedAt: 100000, validFrom: 100000, validUntil: 300000, revokedAt: null }
    } }) }
  } };
  const composed = await composePostgresServicePriceDependencies({ service: 'scanner', deployment: { generationId: 'generation', activatedAt: 1000, priceAcquisition },
    dependencies: { nativePriceAuthority }, signal: signal() });
  const producer = createPostgresGeckoTerminalPriceProducer({ ...source, generationId: 'generation', activatedAt: 1000, fetch, now: () => 200000 });
  const receiver = createPostgresPriceCandidateReceiver({ ...priceAcquisition.receiver, generationId: 'generation', producer,
    ...composed.priceAuthority, now: () => 200000 });
  const received = await receiver.receive({ requests: [{ ...candidate, mapping }], signal: signal() });
  expect(received.results).toEqual([expect.objectContaining({ status: 'published' })]);
  expect(received.published).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(4);
  const peaks: ForwardPeakEvidence[] = f.getInputs().map(row => JSON.parse(String(row.payload)).peak);
  const stored: string[] = [], fanout: string[] = [];
  const tx: PostgresTransaction = { async query(sql, values = []) {
    if (sql.startsWith('INSERT INTO forward_peak_evidence')) { stored.push(String(values[11])); return { rows: [{ peak_id: values[0] }], rowCount: 1 }; }
    if (sql.startsWith('SELECT known_at FROM forward_peak_evidence')) return { rows: [{ known_at: 200000 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO forward_peak_fanout_jobs')) { fanout.push(String(values[0])); return { rows: [{ peak_id: values[0] }], rowCount: 1 }; }
    if (sql.startsWith('SELECT payload FROM forward_peak_evidence WHERE chain=')) return { rows: stored.map(payload => ({ payload })), rowCount: stored.length };
    throw new Error('Unexpected isolated consumer query');
  } };
  const assertOwned = vi.fn(async () => {}), complete = vi.fn(async () => {});
  expect(await receivePostgresProductionPriceBatch(tx, { generationId: 'generation', asOf: 200000, limit: 1, now: () => 200000,
    batch: { status: 'available', peaks, markets: [], lease: { generationId: 'generation', ownerId: 'fixture-only', claimGeneration: 1,
      leaseExpiresAt: 300000, assertOwned, complete } } })).toEqual({ peaks: 1, markets: 0 });
  expect(assertOwned).toHaveBeenCalledTimes(2); expect(complete).toHaveBeenCalledOnce(); expect(fanout).toHaveLength(1);
  const sample = { sampleId: 'sample', executionFingerprint: candidate.executionFingerprint, entityId: 'fixture-entity', chain: 'solana',
    tokenAddress: 'TokenCase', boughtAt: 90000, amountUsd: '60', amountEstimated: false, entryPriceUsd: '1', entryBasisVerified: true,
    executionEvidenceRef: 'fixture-only-committed-execution' };
  const evaluation = evaluateForwardOpportunity({ sample, peaks: await createPostgresForwardOpportunityRepository(tx).listPeaks(sample, 200000), asOf: 200000 });
  expect(evaluation).toMatchObject({ status: 'hit', tier: 3, sampleId: 'sample', executionFingerprint: candidate.executionFingerprint });
  expect(stored).toHaveLength(1); expect(f.getInputs()[0]!.kind).toBe('price');
  expect(JSON.parse(String(f.getInputs()[0]!.payload))).not.toHaveProperty('entryPriceUsd');
});
describe("dedicated authenticated candle publication",()=>{
 it("factory is read-only and rejects absent authority or source approval",async()=>{const f=fixture();await createPostgresPriceFactPublisher(f.options);expect(f.calls).toHaveLength(2);expect(f.calls.map(x=>x.sql).join("\n")).not.toMatch(/INSERT |UPDATE |CREATE |GRANT /);await expect(createPostgresPriceFactPublisher({...f.options,validators:[]})).rejects.toThrow();await expect(createPostgresPriceFactPublisher({...f.options,mappings:[]})).rejects.toThrow();});
 it("publishes canonical post-buy high with exact revision, raw proof and wake atomically",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);const result=await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()});expect(result.status).toBe("published");expect(f.getInputs()).toHaveLength(1);expect(f.getAttestations()).toHaveLength(1);expect(f.getWakes()).toHaveLength(1);const payload=JSON.parse(String(f.getInputs()[0]!.payload));expect(payload).toMatchObject({type:"peak",sampleId:"sample",executionFingerprint:candidate.executionFingerprint,peak:{kind:"candle",openedAt:120000,closedAt:180000,priceUsd:"3",verification:"validated",knownAt:200000},validation:{sourceProof:rawProof},acquiredEvidence:{candles:candidate.candles}});expect(payload).not.toHaveProperty("entryPriceUsd");expect(f.getInputs()[0]!.source_ref).toBe(payload.peak.evidenceRef);expect(f.calls.findIndex(x=>x.sql.includes("INSERT INTO wallet_service_fact_attestations"))).toBeLessThan(f.calls.findIndex(x=>x.sql.includes("INSERT INTO wallet_forward_signal_wake_intents")));});
 it("deduplicates exact replay without a fresh fact or wake",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options),input={candidate:actualCandidate(),validation:signed(),signal:signal()};await publisher.publish(input);expect((await publisher.publish(input)).status).toBe("duplicate");expect(f.getInputs()).toHaveLength(1);expect(f.getWakes()).toHaveLength(1);});
 it.each(["attestation","wake"])("rolls back all facts when %s fails",async(kind)=>{const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>{if(sql.includes(kind==="wake"?"INSERT INTO wallet_forward_signal_wake_intents":"INSERT INTO wallet_service_fact_attestations"))throw new Error("atomic failure");return original(sql,values);});const publisher=await createPostgresPriceFactPublisher(f.options);await expect(publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()})).rejects.toThrow("atomic failure");expect(f.getInputs()).toHaveLength(0);expect(f.getAttestations()).toHaveLength(0);expect(f.getWakes()).toHaveLength(0);});
 it.each(["consumer_member","role_safe","objects_safe","can_publish"])("rejects unsafe actual role/catalog flag %s",async(flag)=>{const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>{const result=await original(sql,values);if(sql.includes("price-publisher-identity"))return{...result,rows:result.rows.map(x=>({...x,[flag]:flag==="consumer_member"}))};return result;});await expect(createPostgresPriceFactPublisher(f.options)).rejects.toThrow();expect(f.getInputs()).toHaveLength(0);});
 it("rechecks actual identity for every publication and forbids authority/source mutations",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()});expect(f.calls.filter(x=>x.sql.includes("price-publisher-identity"))).toHaveLength(2);const sql=f.calls.map(x=>x.sql).join("\n");expect(sql).toContain("l.imported_at");expect(sql).toContain("validator_authority");expect(sql).toContain("s.execution_fingerprint=$3");expect(sql).toContain("RETURNING fact_id");expect(sql).not.toMatch(/FOR SHARE|FOR UPDATE|CREATE |GRANT |UPDATE wallet_service_fact|INSERT INTO wallet_service_fact_validators/);});
 it.each(["signature","raw","same-provider","wrong-mapping","wrong-source","wrong-revision","future","expired"])("rejects %s proof before writing",async(kind)=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);let validation=signed();if(kind==="signature")validation={...validation,signature:""};if(kind==="raw")validation={...validation,sourceProof:{...rawProof,rawEvidence:{fake:true}}};if(kind==="same-provider")validation=signed(undefined,{sourceBasis:{...validation.claims.sourceBasis,providerId:"gecko"}});if(kind==="wrong-mapping")validation=signed(undefined,{mappingApprovalRef:"other"});if(kind==="wrong-source")validation=signed(undefined,{sourceApprovalRef:"other"});if(kind==="wrong-revision")validation=signed(undefined,{executionFingerprint:"d".repeat(64)});if(kind==="future")validation=signed(undefined,{checkedAt:200001});if(kind==="expired")validation=signed(undefined,{expiresAt:200000});await expect(publisher.publish({candidate:actualCandidate(),validation,signal:signal()})).rejects.toThrow();expect(f.getInputs()).toHaveLength(0);});
 it.each(["pre-buy","open","duplicate","malformed","empty","fingerprint","overflow"])("rejects %s candidate without authority writes",async(kind)=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);let value=actualCandidate();if(kind==="pre-buy")value={...value,candles:[{...value.candles[0]!,timestamp:60000}]};if(kind==="open")value={...value,candles:[{...value.candles[0]!,timestamp:180000}]};if(kind==="duplicate")value={...value,candles:[...value.candles,...value.candles]};if(kind==="malformed")value={...value,candles:[{...value.candles[0]!,high:0.1}]};if(kind==="empty")value={...value,candles:[]};if(kind==="overflow")value={...value,candles:Array.from({length:4},(_,i)=>({...value.candles[0]!,timestamp:120000+i*60000}))};value={...value,contentFingerprint:kind==="fingerprint"?"f".repeat(64):priceCandidateFingerprint(value)};await expect(publisher.publish({candidate:value,validation:signed(value),signal:signal()})).rejects.toThrow();expect(f.getInputs()).toHaveLength(0);});
 it("defers stale or absent durable sample and mapping instead of filling entry",async()=>{for(const absent of [true,false]){const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>sql.includes("price-publisher-sample")?{rows:absent?[]:[{generation_id:"generation",execution_fingerprint:"d".repeat(64)}],rowCount:absent?0:1}:original(sql,values));const publisher=await createPostgresPriceFactPublisher(f.options);expect((await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()})).status).toBe("deferred");expect(f.getInputs()).toHaveLength(0);}const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);f.setNow(300000);expect((await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()})).status).toBe("deferred");});
 it("defers revoked validator and rejects immutable fact collisions",async()=>{const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>sql.includes("price-publisher-validator")?{rows:[{valid_from:0,valid_until:300000,revoked_at:1,import_revoked_at:null}],rowCount:1}:original(sql,values));const publisher=await createPostgresPriceFactPublisher(f.options);expect((await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()})).status).toBe("deferred");const g=fixture(),other=await createPostgresPriceFactPublisher(g.options);const input={candidate:actualCandidate(),validation:signed(),signal:signal()};await other.publish(input);g.getInputs()[0]!.fingerprint="collision";await expect(other.publish(input)).rejects.toThrow("collision");});
 it("produces distinct immutable revisions from newly authenticated source data",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()});const value={...actualCandidate(),candles:[{...candidate.candles[0]!,high:4}]};const updated={...value,contentFingerprint:priceCandidateFingerprint(value)};await publisher.publish({candidate:updated,validation:signed(updated,{sourceRevision:"actual:revision-2"}),signal:signal()});expect(f.getInputs()).toHaveLength(2);expect(f.getWakes()).toHaveLength(2);const peaks=f.getInputs().map(x=>JSON.parse(String(x.payload)).peak);expect(peaks[0].peakId).toBe(peaks[1].peakId);expect(peaks[0].revisionId).not.toBe(peaks[1].revisionId);});
 it("does not mint a new revision from a new validation clock or reference alone",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher({...f.options,maximumMappingAgeMs:200000});await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()});f.setNow(200001);await expect(publisher.publish({candidate:actualCandidate(),validation:signed(undefined,{checkedAt:200001,validationRef:"proof:same-source-new-clock"}),signal:signal()})).rejects.toThrow("collision");expect(f.getInputs()).toHaveLength(1);expect(f.getWakes()).toHaveLength(1);});
 it("rejects authenticated proof whose replayed candles disagree with the candidate",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options),initial=signed();const sourceProof={...initial.sourceProof,candles:[{...candidate.candles[0]!,high:9}]};const claims={...initial.claims,sourceBasis:{...initial.claims.sourceBasis,contentFingerprint:postgresServiceFactFingerprint(sourceProof)}};const validation={claims,sourceProof,signature:sign(null,priceValidationSigningPayload(claims),keys.privateKey).toString("base64")};await expect(publisher.publish({candidate:actualCandidate(),validation,signal:signal()})).rejects.toThrow("raw candle proof mismatch");expect(f.getInputs()).toHaveLength(0);});
 it("defers missing durable sample or validator bounds without coercing unknown to valid",async()=>{for(const [tag,column] of [["price-publisher-sample","expires_at"],["price-publisher-sample","activated_at"],["price-publisher-validator","valid_until"]]){const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>{const result=await original(sql,values);return sql.includes(tag!)?{...result,rows:result.rows.map(row=>({...row,[column!]:undefined}))}:result;});const publisher=await createPostgresPriceFactPublisher(f.options);expect((await publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()})).status).toBe("deferred");expect(f.getInputs()).toHaveLength(0);}});
 it("rolls back an entire multi-candle publication if a later wake fails",async()=>{const f=fixture(),original=f.query.getMockImplementation()!;let wakes=0;f.query.mockImplementation(async(sql,values)=>{if(sql.includes("INSERT INTO wallet_forward_signal_wake_intents")&&++wakes===2)throw new Error("second wake failed");return original(sql,values);});const publisher=await createPostgresPriceFactPublisher({...f.options,maximumMappingAgeMs:200000}),value={...actualCandidate(),until:240000,knownAt:250000,candles:[...candidate.candles,{...candidate.candles[0]!,timestamp:180000}]};const updated={...value,contentFingerprint:priceCandidateFingerprint(value)};f.setNow(250000);await expect(publisher.publish({candidate:updated,validation:signed(updated,{checkedAt:250000}),signal:signal()})).rejects.toThrow("second wake failed");expect(f.getInputs()).toHaveLength(0);expect(f.getAttestations()).toHaveLength(0);expect(f.getWakes()).toHaveLength(0);});
});
describe("bounded price candidate receiver",()=>{
 it("returns deferred without approved mapping before acquisition",async()=>{const acquire=vi.fn();const receiver=createPostgresPriceCandidateReceiver({generationId:"generation",producer:{acquire},maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:128000,now:()=>200000});const result=await receiver.receive({requests:[{generationId:"generation",sampleId:"sample",executionFingerprint:candidate.executionFingerprint,boughtAt:90000,until:180000}],signal:signal()});expect(result.results[0]!.status).toBe("deferred");expect(acquire).not.toHaveBeenCalled();});
 it("acquires a candidate but never self-attests without an external validator",async()=>{const acquire=vi.fn(async()=>({status:"acquired" as const,candidate:actualCandidate()}));const receiver=createPostgresPriceCandidateReceiver({generationId:"generation",producer:{acquire},maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:128000,now:()=>200000});const result=await receiver.receive({requests:[{...candidate,mapping}],signal:signal()});expect(acquire).toHaveBeenCalledOnce();expect(result.published).toBe(0);expect(result.results[0]!.status).toBe("deferred");});
 it("connects real candidate contract, external signature and dedicated transaction",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);const receiver=createPostgresPriceCandidateReceiver({generationId:"generation",producer:{acquire:async()=>({status:"acquired" as const,candidate:actualCandidate()})},validator:{validatePrice:async()=>({status:"verified" as const,validation:signed()})},publisher,maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:128000,now:()=>200000});const result=await receiver.receive({requests:[candidate],signal:signal()});expect(result.published).toBe(1);expect(f.getWakes()).toHaveLength(1);});
 it("rejects batch overflow and bounds an uncooperative acquisition",async()=>{vi.useFakeTimers();try{const acquire=vi.fn(async()=>new Promise<never>(()=>{}));const receiver=createPostgresPriceCandidateReceiver({generationId:"generation",producer:{acquire},maximumCandidates:1,maximumRunMs:10,maximumPayloadBytes:128000,now:()=>200000});await expect(receiver.receive({requests:[candidate,candidate],signal:signal()})).rejects.toThrow();expect(acquire).not.toHaveBeenCalled();const work=receiver.receive({requests:[candidate],signal:signal()});await vi.advanceTimersByTimeAsync(10);expect((await work).results[0]!.status).toBe("deferred");}finally{vi.useRealTimers();}});
 it("runs the actual Gecko SDK transport and kernels through independently signed fixture publication",async()=>{const f=fixture(),publisher=await createPostgresPriceFactPublisher(f.options);const fetch=vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).includes("ohlcv")?{data:{attributes:{ohlcv_list:[[120,1,3,0.5,2,20]]}}}:{data:[{id:"solana_PoolCase",attributes:{address:"PoolCase",base_token_price_usd:"99",quote_token_price_usd:"1",reserve_in_usd:"100",market_cap_usd:null,fdv_usd:null,pool_created_at:null},relationships:{base_token:{data:{id:"solana_TokenCase"}},quote_token:{data:{id:"solana_USDC"}}}}]}),{status:200,headers:{"content-type":"application/json"}}));const producer=createPostgresGeckoTerminalPriceProducer({generationId:"generation",activatedAt:1000,providerId:"gecko",fetch,baseUrl:"https://fixture.example/api/v2",timeoutMs:1000,minimumRequestIntervalMs:0,rateLimitCooldownMs:1000,maximumRunMs:1000,maximumPayloadBytes:128000,maximumCandles:3,maximumWindowMs:200000,maximumMappingAgeMs:100000,timeframe:"minute",aggregate:1,now:()=>200000});const receiver=createPostgresPriceCandidateReceiver({generationId:"generation",producer,validator:{validatePrice:async({candidate:value})=>({status:"verified" as const,validation:signed(value)})},publisher,maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:128000,now:()=>200000});const result=await receiver.receive({requests:[candidate],signal:signal()});expect(result.published).toBe(1);expect(fetch).toHaveBeenCalledTimes(2);expect(JSON.parse(String(f.getInputs()[0]!.payload)).peak.priceUsd).toBe("3");});
});

it("uses the same canonical native host pin as the business and migration runtimes",async()=>{
 const f=fixture();await createPostgresPriceFactPublisher(f.options);
 const sql=f.calls.find(call=>call.sql.includes("price-publisher-identity"))!.sql;
 expect(sql).toContain("host(inet_server_addr())");expect(sql).not.toContain("inet_server_addr()::text");
});

it("requires an actual final authority/sample receipt before publishing facts or wakes",async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,values)=>sql.includes("INSERT INTO wallet_service_fact_attestations")?{rows:[],rowCount:0}:original(sql,values));
 const publisher=await createPostgresPriceFactPublisher(f.options);
 await expect(publisher.publish({candidate:actualCandidate(),validation:signed(),signal:signal()})).rejects.toThrow("Price authority/sample changed before attestation");
 expect(f.getInputs()).toHaveLength(0);expect(f.getWakes()).toHaveLength(0);
 const gate=f.query.mock.calls.find(([sql])=>sql.includes("INSERT INTO wallet_service_fact_attestations"))![0];
 expect(gate).toContain("s.execution_fingerprint=$3");expect(gate).toContain("l.revoked_at IS NULL");expect(gate).toContain("RETURNING fact_id");
 expect(f.query.mock.calls.map(([sql])=>sql).join("\n")).not.toMatch(/FOR SHARE|FOR UPDATE/);
});

// Isolated synthetic end-to-end reported-cap contract; no native PG or actual source approvals.
function reportedMarketFixture() {
  const f = fixture();
  const identity = { chain: 'solana', token: '1'.repeat(31) + '2', pool: '1'.repeat(31) + '3', quote: '1'.repeat(31) + '4' };
  const map = { ...mapping, tokenAddress: identity.token, poolAddress: identity.pool };
  const raw = { status: 'candidate' as const, verified: false as const, independence: 'unverified' as const, identity,
    reportedMarketCap: 100000, reportedFdv: 900000, reportedTvl: 100, reportedUpdatedAt: 150,
    circulatingMarketCapVerified: false as const, amm: 'synthetic-amm' };
  const pin = { mapping: map, providerId: 'approved-ave', mappingApprovalRef: 'approval:ave-map', sourceApprovalRef: 'approval:ave-source',
    sourceProofKind: 'approved_reported_market_cap_v1' as const, quoteAddress: identity.quote, candleMs: 0 as const, validFrom: 100000, validUntil: 300000 };
  const approval = attachDedicatedReportedApproval({ approvalRef: 'approval:validator', generationId: 'generation', validatorId: 'price-validator', keyId: 'reviewed-key',
    actorId: 'verified-price-actor', providerId: pin.providerId, mappingApprovalRef: pin.mappingApprovalRef, sourceApprovalRef: pin.sourceApprovalRef,
    mappingFingerprint: postgresServiceFactFingerprint(map), quoteAddress: identity.quote, sourceProofKind: pin.sourceProofKind,
    quality: 'reported' as const, conflictState: 'none_observed' as const, validFrom: 100000, validUntil: 300000, revokedAt: null }, map, target, f.options.validators[0]!.publicKey);
  const tokenDetail = vi.fn(async () => structuredClone(raw));
  const authorizeReportedMarketCap = vi.fn(async () => ({ status: 'approved' as const, approval: structuredClone(approval) }));
  const loadPrivateKey = vi.fn(async () => keys.privateKey);
  const source = { generationId: 'generation', activatedAt: 1000, providerId: pin.providerId, sourceApprovalRef: pin.sourceApprovalRef,
    identity, client: { tokenDetail }, maximumRunMs: 1000, maximumPayloadBytes: 128000, maximumWindowMs: 200000,
    maximumMappingAgeMs: 100000, now: () => 200000 };
  const producer = createPostgresReportedMarketCapProducer(source);
  const validatorOptions = { generationId: 'generation', activatedAt: 1000, validatorId: 'price-validator', keyId: 'reviewed-key',
    actorId: 'verified-price-actor', authorizationRef: 'approval:validator', publicKey: f.options.validators[0]!.publicKey,
    signingKey: { loadPrivateKey }, approval: { authorizeReportedMarketCap }, client: { tokenDetail }, bindings: [pin],
    now: () => 200000, maximumRunMs: 1000, maximumPayloadBytes: 128000, maximumCandidateAgeMs: 10000,
    maximumMappingAgeMs: 100000, maximumWindowMs: 200000, validationTtlMs: 30000 };
  const original = f.query.getMockImplementation()!;
  f.query.mockImplementation(async (sql, values) => {
    const result = await original(sql, values);
    if (sql.includes('reported-approval-transaction')) return { rows: [dedicatedReportedLedgerRow(approval)], rowCount: 1 };
    return sql.includes('price-publisher-sample') ? { ...result, rows: result.rows.map(row => ({ ...row, token_address: identity.token })) } : result;
  });
  const publisherOptions = { ...f.options, mappings: [pin], validators: f.options.validators.map(v => ({ ...v, reviewedSourceProviders: [pin.providerId] })) };
  return { f, raw, pin, map, source, producer, approval, authorizeReportedMarketCap, tokenDetail, loadPrivateKey, validatorOptions, publisherOptions };
}
async function acquiredReported(f: ReturnType<typeof reportedMarketFixture>) {
  const result = await f.producer.acquire({ ...candidate, mapping: f.map, signal: signal() });
  if (result.status !== 'acquired') throw new Error('Expected isolated reported candidate');
  return result.candidate;
}
describe('approved reported market-cap authority branch', () => {
  it('acquires, validates, publishes and consumes reported 100K without independent supply or candle authority', async () => {
    const f = reportedMarketFixture();
    const value = await acquiredReported(f);
    const validator = createPostgresReportedMarketCapValidator(f.validatorOptions);
    const publisher = await createPostgresPriceFactPublisher(f.publisherOptions);
    const receiver = createPostgresPriceCandidateReceiver({ generationId: 'generation', producer: f.producer, validator, publisher,
      maximumCandidates: 1, maximumRunMs: 1000, maximumPayloadBytes: 128000, now: () => 200000 });
    const received = await receiver.receive({ requests: [{ ...candidate, mapping: f.map }], signal: signal() });
    expect(received.published).toBe(1);
    expect(f.authorizeReportedMarketCap).toHaveBeenCalledTimes(2);
    expect(f.f.getInputs()).toHaveLength(1);
    const payload = JSON.parse(String(f.f.getInputs()[0]!.payload));
    expect(payload).toMatchObject({ type: 'market', market: { marketCapUsd: '100000', fdvUsd: '900000', quality: 'reported',
      independence: 'unverified', verification: 'validated', conflictState: 'none_observed', occurredAt: 150000,
      source: { providerId: 'approved-ave', approvalRef: 'approval:ave-source', reportedAt: 150000 } } });
    expect(payload).not.toHaveProperty('peak');
    expect(payload.market).not.toHaveProperty('circulatingSupply');
    expect(value.contentFingerprint).toBe(priceCandidateFingerprint(value));
    const hits: number[] = [], stored: unknown[] = [];
    const tx: PostgresTransaction = { async query(sql, args = []) {
      if (sql.includes('FROM forward_token_watches')) return { rows: [{ generation_id: 'generation', chain: 'solana', token_address: f.map.tokenAddress,
        first_discovered_at: 90000, capture_until: 700000000, screening_enabled_at: null }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO forward_token_market_inputs')) { stored.push(args); return { rows: [{ fingerprint: args[4] }], rowCount: 1 }; }
      if (sql.startsWith('INSERT INTO forward_token_milestone_hits')) { hits.push(Number(args[3])); return { rows: [{ threshold: args[3] }], rowCount: 1 }; }
      if (sql.startsWith('UPDATE forward_token_watches') || sql.startsWith('INSERT INTO forward_token_watch_intents')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected isolated market storage query');
    } };
    const complete = vi.fn(async () => {});
    expect(await receivePostgresProductionPriceBatch(tx, { generationId: 'generation', asOf: 200000, limit: 1, now: () => 200000,
      batch: { status: 'available', peaks: [], markets: [payload.market], lease: { generationId: 'generation', ownerId: 'fixture-only',
        claimGeneration: 1, leaseExpiresAt: 300000, assertOwned: async () => {}, complete } } })).toEqual({ peaks: 0, markets: 1 });
    expect(hits).toEqual([100000]); expect(stored).toHaveLength(1); expect(complete).toHaveBeenCalledOnce();
  });
  it.each(['absent', 'candle-only', 'revoked', 'conflict', 'unknown-conflict', 'wrong-provider', 'wrong-map', 'wrong-quality', 'wrong-key', 'expired'])('defers %s approval without signing', async kind => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    const options = { ...f.validatorOptions };
    if (kind === 'absent' || kind === 'candle-only') Object.assign(options, { approval: kind === 'absent' ? undefined : { authorizePriceReplay: async () => ({ status: 'approved', approval: f.approval }) } });
    else f.authorizeReportedMarketCap.mockImplementation(async () => ({ status: 'approved', approval: { ...f.approval,
      ...(kind === 'revoked' ? { revokedAt: 199000 } : {}), ...(kind === 'conflict' ? { conflictState: 'conflict' } : {}),
      ...(kind === 'unknown-conflict' ? { conflictState: 'unknown' } : {}), ...(kind === 'wrong-provider' ? { providerId: 'other' } : {}),
      ...(kind === 'wrong-map' ? { mappingFingerprint: 'c'.repeat(64) } : {}), ...(kind === 'wrong-quality' ? { quality: 'independently_verified' } : {}),
      ...(kind === 'wrong-key' ? { keyId: 'wrong' } : {}), ...(kind === 'expired' ? { validUntil: 200000 } : {}) } as unknown as typeof f.approval }));
    expect(await createPostgresReportedMarketCapValidator(options).validatePrice({ candidate: value, signal: signal() })).toMatchObject({ status: 'deferred' });
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });
  it('cannot validate reported cap through the candle validator', async () => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    const fake = { ...value, kind: undefined, coverage: 'bounded_observations_only', candles: [] };
    // A forged candle shape cannot carry the reported source signature or generate market facts.
    expect(priceCandidateFingerprint(fake as unknown as PostgresGeckoTerminalPriceCandidate)).not.toBe(value.contentFingerprint);
  });
  it.each(['cap', 'fdv', 'time', 'token'])('defers source snapshot %s drift instead of signing caller evidence', async kind => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    f.tokenDetail.mockResolvedValue({ ...f.raw, ...(kind === 'cap' ? { reportedMarketCap: 100001 } : {}),
      ...(kind === 'fdv' ? { reportedFdv: 1 } : {}), ...(kind === 'time' ? { reportedUpdatedAt: 151 } : {}),
      ...(kind === 'token' ? { identity: { ...f.raw.identity, token: f.raw.identity.quote } } : {}) });
    expect(await createPostgresReportedMarketCapValidator(f.validatorOptions).validatePrice({ candidate: value, signal: signal() })).toMatchObject({ status: 'deferred' });
    expect(f.loadPrivateKey).not.toHaveBeenCalled();
  });
  it('rechecks source approval after acquisition and key load', async () => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    f.authorizeReportedMarketCap.mockResolvedValueOnce({ status: 'approved', approval: f.approval })
      .mockResolvedValueOnce({ status: 'approved', approval: { ...f.approval, conflictState: 'conflict' } as unknown as typeof f.approval });
    expect(await createPostgresReportedMarketCapValidator(f.validatorOptions).validatePrice({ candidate: value, signal: signal() })).toMatchObject({ status: 'deferred' });
    expect(f.f.getInputs()).toHaveLength(0);
  });
  it('rejects modified reported proof and refuses candle-only publisher pins', async () => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    const verdict = await createPostgresReportedMarketCapValidator(f.validatorOptions).validatePrice({ candidate: value, signal: signal() });
    if (verdict.status !== 'verified') throw new Error('Expected isolated validation');
    const publisher = await createPostgresPriceFactPublisher(f.publisherOptions);
    const tampered = structuredClone(verdict.validation);
    Object.assign(tampered.sourceProof.reportedMarketCap!, { fdvUsd: '100000' });
    await expect(publisher.publish({ candidate: value, validation: tampered, signal: signal() })).rejects.toThrow();
    const candlePublisher = await createPostgresPriceFactPublisher(f.f.options);
    expect(await candlePublisher.publish({ candidate: value, validation: verdict.validation, signal: signal() })).toMatchObject({ status: 'deferred' });
    expect(f.f.getInputs()).toHaveLength(0);
  });
  it('deduplicates the exact signed report and atomically rolls back attestation failure', async () => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    const result = await createPostgresReportedMarketCapValidator(f.validatorOptions).validatePrice({ candidate: value, signal: signal() });
    if (result.status !== 'verified') throw new Error('Expected isolated validation');
    const publisher = await createPostgresPriceFactPublisher(f.publisherOptions);
    const publication = { candidate: value, validation: result.validation, signal: signal() };
    expect(await publisher.publish(publication)).toMatchObject({ status: 'published' });
    expect(await publisher.publish(publication)).toMatchObject({ status: 'duplicate' });
    expect(f.f.getInputs()).toHaveLength(1);
    const other = reportedMarketFixture(), otherValue = await acquiredReported(other);
    const verdict = await createPostgresReportedMarketCapValidator(other.validatorOptions).validatePrice({ candidate: otherValue, signal: signal() });
    if (verdict.status !== 'verified') throw new Error('Expected isolated validation');
    const original = other.f.query.getMockImplementation()!;
    other.f.query.mockImplementation(async (sql, args) => { if (sql.includes('INSERT INTO wallet_service_fact_attestations')) throw new Error('fixture-only-rollback'); return original(sql, args); });
    const writer = await createPostgresPriceFactPublisher(other.publisherOptions);
    await expect(writer.publish({ candidate: otherValue, validation: verdict.validation, signal: signal() })).rejects.toThrow('fixture-only-rollback');
    expect(other.f.getInputs()).toHaveLength(0);
  });
});

describe('reported approval transaction revocation cannot reuse a signed TTL', () => {
  it.each(['missing','revoked','fingerprint','scope','cluster'])('refuses %s approval before any fact write', async fault => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    const verdict = await createPostgresReportedMarketCapValidator(f.validatorOptions).validatePrice({ candidate: value, signal: signal() });
    if (verdict.status !== 'verified') throw Error('Expected synthetic validation');
    const original = f.f.query.getMockImplementation()!;
    f.f.query.mockImplementation(async (sql,args) => {
      if (sql.includes('reported-approval-transaction')) {
        const row = { ...dedicatedReportedLedgerRow(f.approval), ...(fault === 'revoked' ? { revoked_at: 199999 } : {}),
          ...(fault === 'fingerprint' ? { source_fingerprint: '0'.repeat(64) } : {}), ...(fault === 'scope' ? { proof_scope: 'validator_authority' } : {}),
          ...(fault === 'cluster' ? { system_identifier: '999' } : {}) };
        return { rows: fault === 'missing' ? [] : [row], rowCount: 1 };
      }
      return original(sql,args);
    });
    const publisher = await createPostgresPriceFactPublisher(f.publisherOptions);
    await expect(publisher.publish({ candidate: value, validation: verdict.validation, signal: signal() })).rejects.toThrow();
    expect(f.f.getInputs()).toHaveLength(0);
  });
  it('rechecks dedicated approval at the final transaction boundary and rolls back staged facts', async () => {
    const f = reportedMarketFixture(), value = await acquiredReported(f);
    const verdict = await createPostgresReportedMarketCapValidator(f.validatorOptions).validatePrice({ candidate: value, signal: signal() });
    if (verdict.status !== 'verified') throw Error('Expected synthetic validation');
    const original = f.f.query.getMockImplementation()!; let checks = 0;
    f.f.query.mockImplementation(async (sql,args) => {
      if (sql.includes('reported-approval-transaction') && ++checks >= 3) return { rows: [], rowCount: 0 };
      return original(sql,args);
    });
    const publisher = await createPostgresPriceFactPublisher(f.publisherOptions);
    await expect(publisher.publish({ candidate: value, validation: verdict.validation, signal: signal() })).rejects.toThrow();
    expect(checks).toBe(3); expect(f.f.getInputs()).toHaveLength(0);
  });
});
