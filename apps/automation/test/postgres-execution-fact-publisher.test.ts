import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_SERVICE_FACT_SCHEMA_SQL, postgresServiceFactFingerprint } from "../src/postgres-service-fact-adapters.js";
import { preparePostgresWalletCapture, walletPurchaseBasisFingerprint, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { deriveExecutionBasis } from "../../wallet-monitor/src/execution-basis.js";
import { createPostgresExecutionFactPublisher, executionValidationSigningPayload, type SignedPostgresExecutionValidation } from "../src/postgres-execution-fact-publisher.js";
import { createPostgresWalletExecutionReceiver } from "../src/postgres-wallet-execution-receiver.js";
const wallet="11111111111111111111111111111111", mint="TokenCase", usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const profile:PostgresWalletProfile={wallet:{address:wallet,accountId:"account",entityId:"entity",lifecycle:"active"},fact:{entityId:"entity",channel:"wallet",subjectId:wallet,walletFamily:"solana",associationConfidence:"confirmed",associationSource:"fixture",walletConfidence:"confirmed",walletSource:"fixture",ownerCount:1,identityEvidenceRef:"fixture:identity",ownershipEvidenceRef:"fixture:owner",monitoringEnabled:true,suspended:false},profileEnabled:true,profileSuspended:false,bindingState:"owned",versionId:"profile"};
const basis=deriveExecutionBasis({successful:true,swapConfirmed:true,tokenDeltas:[{asset:mint,quantity:100}],quoteDeltas:[{asset:usdc,symbol:"USDC",quantity:-60,verifiedStablecoin:true}]});
const payload=preparePostgresWalletCapture({generationId:"generation",collectorId:"solana",sessionId:"fixture",chainFamily:"solana",receivedAt:100000,profile,executionTrust:"rpc_execution",event:{eventId:"event",chain:"solana",walletAddress:wallet,tokenAddress:mint,side:"buy",occurredAt:90000,amountUsd:60,priceUsd:0.6,marketCapUsd:null,sourceReference:"solana:signature",executionBasis:basis}}).payload;
const candidate={generationId:"generation",providerId:"rpc",genesisHash:"genesis",slot:5,blockHash:"block",sourceReference:"solana:signature",profile,observedAt:90000,knownAt:100000,contentFingerprint:"a".repeat(64),purchaseCandidate:payload.purchase!,evidence:{signatureStatus:{slot:5,confirmationStatus:"finalized",err:null},transaction:{slot:5},block:{blockhash:"block"}}};
const keys=generateKeyPairSync("ed25519");
const publisherTarget={database:"radar_business",schema:"business_v1",username:"radar_execution_publisher",serverAddress:"127.0.0.1",serverPort:5432,generationId:"generation",schemaVersion:2,schemaFingerprint:"b".repeat(64)};
function verdict():SignedPostgresExecutionValidation {
  const claims={format:1 as const,generationId:"generation",providerId:"rpc",validatorId:"validator",keyId:"reviewed-key",candidateFingerprint:candidate.contentFingerprint,sourceReference:candidate.sourceReference,validationRef:"proof:independent-replay",checkedAt:100000,expiresAt:200000,sourceBasis:{kind:"independent_rpc_replay" as const,providerId:"independent-rpc",evidenceRef:"proof:other-rpc",contentFingerprint:"c".repeat(64)},purchase:{...candidate.purchaseCandidate,executionEvidenceRef:"proof:independent-replay"},purchaseFingerprint:""};
  claims.purchaseFingerprint=walletPurchaseBasisFingerprint(claims.purchase);
  return {claims,signature:sign(null,executionValidationSigningPayload(claims),keys.privateKey).toString("base64")};
}
function fixture() {
  const calls:{sql:string;values:readonly unknown[]}[]=[];let inputs:Record<string,unknown>[]=[];let attestations:Record<string,unknown>[]=[];
  const query=vi.fn(async(sql:string,values:readonly unknown[]=[])=>{calls.push({sql,values});let rows:Record<string,unknown>[]=[];
    if(sql.includes("execution-publisher-identity"))rows=[{...publisherTarget,username:publisherTarget.username,session_username:publisherTarget.username,schema_generation:"generation",schema_version:2,schema_fingerprint:publisherTarget.schemaFingerprint,role_safe:true,consumer_member:false,objects_safe:true,can_publish:true}];
    else if(sql.includes("execution-publisher-validator"))rows=[{validator_id:"validator",valid_from:0,valid_until:200000,revoked_at:null,import_revoked_at:null}];
    else if(sql.includes("execution-publisher-existing"))rows=inputs.length?[{input:inputs[0],attestation:attestations[0]}]:[];
    else if(sql.includes("INSERT INTO wallet_service_fact_inputs")){inputs.push(JSON.parse(String(values.at(-1))));}
    else if(sql.includes("INSERT INTO wallet_service_fact_attestations")){const row=JSON.parse(String(values.at(-1))) as Record<string,unknown>;attestations.push(row);rows=[{fact_id:row.fact_id}];}
    return {rows,rowCount:rows.length};
  });
  const run=async<T>(operation:(tx:{query:typeof query})=>Promise<T>)=>{const oldInputs=structuredClone(inputs),oldAttestations=structuredClone(attestations);try{return await operation({query});}catch(error){inputs=oldInputs;attestations=oldAttestations;throw error;}};
  const options={run,target:publisherTarget,forbiddenRoles:["scanner","automation","wallet-monitor","wallet-analysis","historical-backfill","console","migrator"],validators:[{validatorId:"validator",keyId:"reviewed-key",publicKey:keys.publicKey.export({type:"spki",format:"pem"}).toString(),actorId:"verified-actor",authorizationRef:"approval:validator",reviewedSourceProviders:["independent-rpc"]}],maximumValidationAgeMs:100000,maximumPayloadBytes:64000,statementTimeoutMs:2000,lockTimeoutMs:500,now:()=>100000};
  return{options,query,calls,getInputs:()=>inputs,getAttestations:()=>attestations};
}
describe("independently signed dedicated execution publication",()=>{
  it("binds the actual exported schema contract, not an invented publisher table",()=>{
    for(const name of ["wallet_service_fact_inputs","wallet_service_fact_attestations","wallet_service_fact_validators"])expect(POSTGRES_SERVICE_FACT_SCHEMA_SQL).toContain(`CREATE TABLE ${name}`);
    expect(postgresServiceFactFingerprint({a:1})).toMatch(/^[a-f0-9]{64}$/);
  });
  it("factory verifies a dedicated actual identity without writing or minting proof",async()=>{const f=fixture();await createPostgresExecutionFactPublisher(f.options);expect(f.calls).toHaveLength(2);expect(f.calls[1]!.sql).toContain("execution-publisher-identity");});
  it("publishes only a signed candidate-bound execution fact and its attestation in one UOW",async()=>{const f=fixture(),publisher=await createPostgresExecutionFactPublisher(f.options);const result=await publisher.publish({candidate,validation:verdict(),signal:new AbortController().signal});expect(result.status).toBe("published");expect(f.getInputs()).toHaveLength(1);expect(f.getAttestations()).toHaveLength(1);expect(f.calls.map(x=>x.sql).join("\n")).not.toMatch(/CREATE |GRANT |UPDATE .*validators|INSERT INTO .*risk|independence/);});
  it("rejects unsigned/tampered purchase, missing basis, or same-provider validation before writes",async()=>{for(const mutate of [(v:SignedPostgresExecutionValidation)=>({...v,signature:""}),(v:SignedPostgresExecutionValidation)=>({...v,claims:{...v.claims,purchase:{...v.claims.purchase,entryPriceUsd:"999"}}}),(v:SignedPostgresExecutionValidation)=>({...v,claims:{...v.claims,sourceBasis:{...v.claims.sourceBasis,evidenceRef:""}}}),(v:SignedPostgresExecutionValidation)=>({...v,claims:{...v.claims,validatorId:"rpc"}})]){const f=fixture(),publisher=await createPostgresExecutionFactPublisher(f.options);await expect(publisher.publish({candidate,validation:mutate(verdict()),signal:new AbortController().signal})).rejects.toThrow();expect(f.getInputs()).toHaveLength(0);}});
  it("rejects ordinary consumer role membership before SQL publication",async()=>{const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>sql.includes("execution-publisher-identity")?{rows:[{...publisherTarget,session_username:publisherTarget.username,schema_generation:"generation",schema_version:2,schema_fingerprint:publisherTarget.schemaFingerprint,role_safe:true,consumer_member:true,objects_safe:true,can_publish:true}],rowCount:1}:original(sql,values));await expect(createPostgresExecutionFactPublisher(f.options)).rejects.toThrow();});
  it("rolls back a fact if its attestation insert fails",async()=>{const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>{if(sql.includes("INSERT INTO wallet_service_fact_attestations"))throw new Error("attestation failure");return original(sql,values);});const publisher=await createPostgresExecutionFactPublisher(f.options);await expect(publisher.publish({candidate,validation:verdict(),signal:new AbortController().signal})).rejects.toThrow("attestation failure");expect(f.getInputs()).toHaveLength(0);});
  it("deduplicates replay and retains the external signature/source evidence durably",async()=>{const f=fixture(),publisher=await createPostgresExecutionFactPublisher(f.options),validation=verdict(),signal=new AbortController().signal;await publisher.publish({candidate,validation,signal});expect((await publisher.publish({candidate,validation,signal})).status).toBe("duplicate");expect(f.getInputs()).toHaveLength(1);expect(JSON.parse(String(f.getInputs()[0]!.payload))).toMatchObject({validation:{signature:validation.signature},acquiredEvidence:{providerId:"rpc",contentFingerprint:candidate.contentFingerprint}});});
  it("checks migration validator authority scope and rejects revoked or expired approval",async()=>{for(const row of [{valid_from:0,valid_until:200000,revoked_at:99999},{valid_from:100001,valid_until:200000,revoked_at:null},{valid_from:0,valid_until:199999,revoked_at:null}]){const f=fixture(),original=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>sql.includes("execution-publisher-validator")?{rows:[row],rowCount:1}:original(sql,values));const publisher=await createPostgresExecutionFactPublisher(f.options);await expect(publisher.publish({candidate,validation:verdict(),signal:new AbortController().signal})).rejects.toThrow();expect(f.getInputs()).toHaveLength(0);}const f=fixture(),publisher=await createPostgresExecutionFactPublisher(f.options);await publisher.publish({candidate,validation:verdict(),signal:new AbortController().signal});expect(f.calls.find(x=>x.sql.includes("execution-publisher-validator"))!.sql).toContain("l.proof_scope='validator_authority'");});
});
describe("bounded actual candidate receiver",()=>{
  it("still acquires real candidates but defers without an independent validator/publisher",async()=>{const acquire=vi.fn(async()=>({status:"acquired" as const,candidate}));const receiver=createPostgresWalletExecutionReceiver({generationId:"generation",producer:{acquire},maximumCandidates:2,maximumRunMs:1000,maximumPayloadBytes:64000,now:()=>100000});const result=await receiver.receive({payloads:[payload],signal:new AbortController().signal});expect(acquire).toHaveBeenCalledOnce();expect(result.results[0]!.status).toBe("deferred");expect(result.published).toBe(0);});
  it("rejects overflow before any acquisition and never invents safety facts",async()=>{const acquire=vi.fn();const receiver=createPostgresWalletExecutionReceiver({generationId:"generation",producer:{acquire},maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:64000,now:()=>100000});await expect(receiver.receive({payloads:[payload,payload],signal:new AbortController().signal})).rejects.toThrow();expect(acquire).not.toHaveBeenCalled();});
  it("connects acquisition, external validation and dedicated publication to actual external purchase basis",async()=>{const f=fixture(),publisher=await createPostgresExecutionFactPublisher(f.options);const receiver=createPostgresWalletExecutionReceiver({generationId:"generation",producer:{acquire:async()=>({status:"acquired" as const,candidate})},validator:{validateExecution:async()=>({status:"verified" as const,validation:verdict()})},publisher,maximumCandidates:1,maximumRunMs:1000,maximumPayloadBytes:64000,now:()=>100000});const result=await receiver.receive({payloads:[payload],signal:new AbortController().signal});expect(result.published).toBe(1);expect(result.results[0]).toMatchObject({status:"verified",purchase:{entryPriceUsd:"0.6",executionEvidenceRef:"proof:independent-replay"},externalBasis:{verifierId:"validator",generationId:"generation",sourceReference:"solana:signature"}});});
});

it("uses only actual v2 import-ledger DDL columns in publication authority SQL",async()=>{
 const ddl=POSTGRES_SERVICE_FACT_SCHEMA_SQL.match(/CREATE TABLE wallet_service_import_ledger \(([\s\S]*?)\n\);/);
 expect(ddl).not.toBeNull();
 const columns=[...ddl![1]!.matchAll(/(?:^|,)\s*([a-z_]+)\s+(?:text|bigint)\b/g)].map(match=>match[1]);
 expect(columns).toContain("imported_at");expect(columns).not.toContain("import_at");
 const f=fixture(),publisher=await createPostgresExecutionFactPublisher(f.options);
 await publisher.publish({candidate,validation:verdict(),signal:new AbortController().signal});
 const sql=f.calls.find(call=>call.sql.includes("execution-publisher-validator"))!.sql;
 const referenced=[...sql.matchAll(/\bl\.([a-z_]+)\b/g)].map(match=>match[1]);
 expect(referenced).toContain("imported_at");expect(referenced).not.toContain("import_at");
 for(const column of referenced)expect(columns).toContain(column);
});

it("pins canonical native host addresses without accepting CIDR identity drift",async()=>{
 const f=fixture();await createPostgresExecutionFactPublisher(f.options);
 const sql=f.calls.find(call=>call.sql.includes("execution-publisher-identity"))!.sql;
 expect(sql).toContain("host(inet_server_addr())");expect(sql).not.toContain("inet_server_addr()::text");
});

it("rolls back a staged fact when the final SELECT-only authority gate returns no receipt",async()=>{
 const f=fixture(),original=f.query.getMockImplementation()!;
 f.query.mockImplementation(async(sql,values)=>sql.includes("INSERT INTO wallet_service_fact_attestations")?{rows:[],rowCount:0}:original(sql,values));
 const publisher=await createPostgresExecutionFactPublisher(f.options);
 await expect(publisher.publish({candidate,validation:verdict(),signal:new AbortController().signal})).rejects.toThrow("Execution authority changed before attestation");
 expect(f.getInputs()).toHaveLength(0);expect(f.getAttestations()).toHaveLength(0);
 const gate=f.query.mock.calls.find(([sql])=>sql.includes("INSERT INTO wallet_service_fact_attestations"))![0];
 expect(gate).toContain("l.revoked_at IS NULL");expect(gate).toContain("RETURNING fact_id");expect(f.query.mock.calls.map(([sql])=>sql).join("\n")).not.toMatch(/FOR SHARE|FOR UPDATE/);
});

it("persists the complete original immutable candidate and signed validation envelope", async () => {
  const f = fixture(), publisher = await createPostgresExecutionFactPublisher(f.options), validation = verdict();
  const original = structuredClone({ candidate, validation });
  await publisher.publish({ ...original, signal: new AbortController().signal });
  const stored = JSON.parse(String(f.getInputs()[0]!.payload));
  expect(stored.executionEnvelope).toEqual({ format: 1, ...original });
  expect(stored.validation).toEqual(original.validation);
  expect(stored.executionEnvelope.candidate.knownAt).toBe(candidate.knownAt);
  original.candidate = { ...original.candidate, profile: { ...original.candidate.profile, versionId: "mutated-after-publication" } };
  expect(JSON.parse(String(f.getInputs()[0]!.payload)).executionEnvelope.candidate.profile.versionId).toBe("profile");
  expect(String(f.getInputs()[0]!.payload)).not.toMatch(/BEGIN PRIVATE KEY|privateKey|signingKey/);
  expect(f.getInputs()[0]!.fingerprint).toBe(postgresServiceFactFingerprint(stored));
});

it("bounds the entire durable payload including duplicated original envelope before writes", async () => {
  const f = fixture(), validation = verdict();
  const maximumPayloadBytes = Buffer.byteLength(JSON.stringify({ candidate, validation })) + 10;
  const publisher = await createPostgresExecutionFactPublisher({ ...f.options, maximumPayloadBytes });
  await expect(publisher.publish({ candidate, validation, signal: new AbortController().signal })).rejects.toThrow(/payload.*budget/i);
  expect(f.getInputs()).toHaveLength(0); expect(f.getAttestations()).toHaveLength(0);
});
