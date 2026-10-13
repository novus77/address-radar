import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, pbkdf2Sync, randomBytes, sign } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresClient, type PostgresPool, type PostgresResult } from "../../../packages/database/src/postgres-unit-of-work.js";
import { createPostgresMigrationRuntime } from "../../../packages/database/src/postgres-migration-runtime.js";
import { authenticatePostgresBusinessNamespaceReceipt, postgresBusinessNamespaceReceiptSigningPayload, type PostgresBusinessProvisionedNamespaceReceipt } from "../../../packages/database/src/postgres-business-schema.js";
import { createPostgresServiceSchema, installPostgresServiceSchema } from "../src/postgres-service-schema.js";
import { createPostgresExecutionFactPublisher, executionValidationSigningPayload, type SignedPostgresExecutionValidation } from "../src/postgres-execution-fact-publisher.js";
import { createPostgresPriceFactPublisher, priceCandidateFingerprint, priceValidationSigningPayload, type SignedPostgresPriceValidation } from "../src/postgres-price-fact-publisher.js";
import { postgresServiceFactFingerprint } from "../src/postgres-service-fact-adapters.js";
import { preparePostgresWalletCapture, walletPurchaseBasisFingerprint, type PostgresWalletProfile } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import { deriveExecutionBasis } from "../../wallet-monitor/src/execution-basis.js";
import type { PostgresGeckoTerminalPriceCandidate } from "../src/postgres-controlled-price-producer.js";

const lifecyclePath="/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar_rehearsal_lifecycle-qz6YDc/private-pg16-lifecycle.mjs";
const lifecycleSha="f64463042e64f2d11ccfdd078ca00c47e0610d672b02cd51379d94bc1b7a49bb";
const expectedV2="cecbd7d9218d0a91022c221d1086244fcb5e91cb5de8ac2639e7378c19070ea6";
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
interface PrivateContext { readonly nonce:string;readonly database:string;readonly schema:string;readonly role:string;readonly systemIdentifier:string;readonly connectionPath:string;readonly remoteConnectionPath:string;readonly capacity:string;guard():string; }
interface PrivateConnection {host:string;port:number;database:string;schema:string;username:string;password:string;systemIdentifier:string;nonce:string;}
type NativePool=PostgresPool & {end():Promise<void>;on(event:"error",listener:(error:Error)=>void):unknown};
const {Pool}=createRequire(new URL("../../../packages/database/package.json",import.meta.url))("pg") as {Pool:new(options:Record<string,unknown>)=>NativePool};
const quote=(value:string)=>{assert.match(value,/^radar_rehearsal_[a-f0-9]{16}(?:_[a-z]+)?$/);return `"${value}"`;};
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
function secret(){
 const password=randomBytes(32).toString("hex"),salt=randomBytes(16),salted=pbkdf2Sync(password,salt,4096,32,"sha256");
 const stored=shaBuffer(createHmac("sha256",salted).update("Client Key").digest());
 const server=createHmac("sha256",salted).update("Server Key").digest("base64");
 return{password,verifier:`SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`};
}
const shaBuffer=(value:Buffer)=>createHash("sha256").update(value).digest("base64");
function privateConnection(ctx:PrivateContext):PrivateConnection {
 const stat=lstatSync(ctx.connectionPath);assert(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.uid,process.getuid!());assert.equal(stat.mode&0o777,0o600);assert(stat.size<=8192);
 const connection=JSON.parse(readFileSync(ctx.connectionPath,"utf8")) as PrivateConnection;
 assert.equal(connection.host,"127.0.0.1");assert.equal(connection.port,5434);
 for(const key of ["database","schema","nonce","systemIdentifier"] as const)assert.equal(connection[key],ctx[key]);
 assert.equal(connection.username,ctx.role);assert.match(connection.password,/^[a-f0-9]{64}$/);quote(ctx.database);quote(ctx.schema);quote(ctx.role);
 assert.equal(ctx.database,`radar_rehearsal_${ctx.nonce}`);assert.equal(ctx.schema,`${ctx.database}_schema`);
 assert.equal(ctx.remoteConnectionPath,`/tmp/${ctx.database}/connection.json`);assert.match(ctx.systemIdentifier,/^[0-9]+$/);
 return connection;
}
/** Fixed peer wrapper for this authenticated private cluster only; output never includes credentials. */
function peer(ctx:PrivateContext,sql:string):string {
 ctx.guard();const connectionDigest=sha(readFileSync(ctx.connectionPath));const root=`/tmp/${ctx.database}`;
 const script=`set -eu\numask 077\nroot=${literal(root)}\n`+
  `test ! -L "$root" && test "$(stat -c %u "$root")" = "$(id -u)" && test "$(stat -c %a "$root")" = 700\n`+
  `test ! -L "$root/connection.json" && test "$(stat -c %u "$root/connection.json")" = "$(id -u)" && test "$(stat -c %a "$root/connection.json")" = 600\n`+
  `test "$(sha256sum "$root/connection.json" | cut -d ' ' -f1)" = ${literal(connectionDigest)}\n`+
  `export PGCONNECT_TIMEOUT=2\nexec /usr/lib/postgresql/16/bin/psql -X -qAt -w -h "$root/socket" -p 5434 -d ${quote(ctx.database)} -v ON_ERROR_STOP=1 <<'PRIVATE_SQL'\n`+
  `SET statement_timeout='3s';SET lock_timeout='500ms';SET idle_in_transaction_session_timeout='3s';\n`+
  `SET log_statement='none';SET log_min_error_statement='panic';SET log_parameter_max_length_on_error=0;\n`+
  `DO $private$ BEGIN IF current_setting('port')<>'5434' OR current_setting('data_directory')<>${literal(root+"/data")} OR (SELECT system_identifier::text FROM pg_catalog.pg_control_system())<>${literal(ctx.systemIdentifier)} THEN RAISE EXCEPTION 'Private fixture scope mismatch';END IF;END $private$;\n`+
  sql+"\nPRIVATE_SQL\n";
 const result=spawnSync("ssh",["-o","BatchMode=yes","-o","ConnectTimeout=5","-o","ServerAliveInterval=5","-o","ServerAliveCountMax=1","ubuntu@152.32.185.240","sudo -n -u postgres sh -s"],{input:script,encoding:"utf8",timeout:15000,maxBuffer:64000});
 if(result.error||result.status!==0)throw new Error("private_publication_peer_sql_failed");
 return result.stdout.trim();
}
const sqlState=(error:unknown)=>error&&typeof error==="object"&&"code" in error&&/^[A-Z0-9]{5}$/.test(String(error.code))?String(error.code):"none";
/** Explicit synthetic data, run through the real capture/execution kernel before any fixture writes. */
export function createSyntheticPublicationExecution(generationId:string,knownAt:number,boughtAt:number){
 const token="TokenCase",wallet="11111111111111111111111111111111",usdc="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",entity="synthetic-owner";
 const profile:PostgresWalletProfile={wallet:{address:wallet,accountId:"synthetic-account",entityId:entity,lifecycle:"active"},fact:{entityId:entity,channel:"wallet",subjectId:wallet,walletFamily:"solana",associationConfidence:"confirmed",associationSource:"synthetic-fixture",walletConfidence:"confirmed",walletSource:"synthetic-fixture",ownerCount:1,identityEvidenceRef:"synthetic:identity",ownershipEvidenceRef:"synthetic:owner",monitoringEnabled:true,suspended:false},profileEnabled:true,profileSuspended:false,bindingState:"owned",versionId:"synthetic-profile"};
 const basis=deriveExecutionBasis({successful:true,swapConfirmed:true,tokenDeltas:[{asset:token,quantity:100}],quoteDeltas:[{asset:usdc,symbol:"USDC",quantity:-60,verifiedStablecoin:true}]});
 const sourceReference="solana:synthetic-fixture-signature";
 const payload=preparePostgresWalletCapture({generationId,collectorId:"synthetic-solana",sessionId:"synthetic-session",chainFamily:"solana",receivedAt:knownAt,profile,executionTrust:"rpc_execution",event:{eventId:"synthetic-event",chain:"solana",walletAddress:wallet,tokenAddress:token,side:"buy",occurredAt:boughtAt,amountUsd:60,priceUsd:0.6,marketCapUsd:null,sourceReference,executionBasis:basis}}).payload;
 assert(payload.purchase,"Synthetic source must satisfy actual collector execution-reference contract");
 return{generationId,providerId:"synthetic-rpc",genesisHash:"synthetic-genesis",slot:1,blockHash:"synthetic-block",sourceReference,profile,observedAt:boughtAt,knownAt,contentFingerprint:"b".repeat(64),purchaseCandidate:payload.purchase,evidence:{signatureStatus:{slot:1,confirmationStatus:"finalized",err:null},transaction:{slot:1,synthetic:true},block:{blockhash:"synthetic-block"}}};
}
export async function runPostgresFactPublicationFixture(){
 const moduleStat=lstatSync(lifecyclePath);assert(moduleStat.isFile()&&!moduleStat.isSymbolicLink()&&moduleStat.uid===process.getuid!()&&!(moduleStat.mode&0o022)&&moduleStat.size<64000);
 assert.equal(sha(readFileSync(lifecyclePath)),lifecycleSha);
 const lifecycle=await import(pathToFileURL(lifecyclePath).href) as {withPrivatePreservationFixture<T>(callback:(ctx:PrivateContext)=>Promise<T>):Promise<T>};
 const result=await lifecycle.withPrivatePreservationFixture(async ctx=>{
  const conn=privateConnection(ctx);ctx.guard();const definition=createPostgresServiceSchema();assert.equal(definition.plan.version,2);assert.equal(definition.plan.fingerprint,expectedV2);
  const generation=`synthetic-publication-${ctx.nonce}`,approvalRef=`synthetic-publication/${ctx.nonce}`;
  const publisherRole=`${ctx.database}_publisher`,observerRole=`${ctx.database}_observer`;
  const consumerRoles=["scanner","automation","walletmonitor","walletanalysis","historical","console"].map(suffix=>`${ctx.database}_${suffix}`);
  const forbiddenRoles=[...consumerRoles,ctx.role],publisherSecret=secret(),observerSecret=secret();
  const makePool=(username:string,password:string,searchPath="pg_catalog")=>{
   const pool=new Pool({host:"127.0.0.1",port:5434,database:ctx.database,user:username,password,max:1,connectionTimeoutMillis:2000,idleTimeoutMillis:500,query_timeout:3000,ssl:false,
    options:`-c search_path=${searchPath} -c statement_timeout=3000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=10000 -c work_mem=1MB -c max_parallel_workers_per_gather=0`});pool.on("error",()=>undefined);return pool;
  };
  let migration:ReturnType<typeof createPostgresMigrationRuntime>|undefined,publisherPool:NativePool|undefined,observerPool:NativePool|undefined,stage="namespace",identityDiagnostic="none";
  try{
   const pins=JSON.parse(peer(ctx,`SELECT json_build_object('databaseOid',d.oid::text,'namespaceOid',n.oid::text,'ownerOid',n.nspowner::text) FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=${literal(ctx.database)} AND n.nspname=${literal(ctx.schema)};`)) as {databaseOid:string;namespaceOid:string;ownerOid:string};
   const keys=generateKeyPairSync("ed25519"),issuedAt=Date.now();
   const namespace:PostgresBusinessProvisionedNamespaceReceipt={version:1,purpose:"provisioned-empty-business-namespace",receiptId:`synthetic-namespace/${ctx.nonce}`,signerKeyId:"synthetic-private-fixture-key",approvalRef,database:ctx.database,databaseOid:pins.databaseOid,schema:ctx.schema,namespaceOid:pins.namespaceOid,owner:ctx.role,ownerOid:pins.ownerOid,generation,service:"migration",schemaVersion:2,schemaFingerprint:expectedV2,systemIdentifier:ctx.systemIdentifier,issuedAt,expiresAt:issuedAt+180000};
   const namespaceApproval=authenticatePostgresBusinessNamespaceReceipt({receipt:namespace,signatureBase64:sign(null,Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(namespace)),keys.privateKey).toString("base64")},{signerKeyId:namespace.signerKeyId,publicKeyPem:keys.publicKey.export({type:"spki",format:"pem"}).toString(),maximumReceiptAgeMs:180000,clock:Date.now});
   const migrationTarget={database:ctx.database,username:ctx.role,schema:ctx.schema,generation,service:"migration",serverAddress:"127.0.0.1",serverPort:5434,schemaVersion:2,schemaFingerprint:expectedV2,systemIdentifier:ctx.systemIdentifier};
   migration=createPostgresMigrationRuntime({pool:makePool(ctx.role,conn.password),target:migrationTarget,capability:{mode:"isolated",purpose:"schema_install",approvalRef,planSha256:expectedV2,expiresAtMs:issuedAt+180000},
    limits:{operationTimeoutMs:60000,connectionTimeoutMs:2000,statementTimeoutMs:3000,lockTimeoutMs:500,maximumSqlStatements:1000,workMemKb:1024,closeTimeoutMs:5000},clock:Date.now,
    assertAuthorized:async request=>{assert.equal(request.capability.mode,"isolated");assert.equal(request.capability.purpose,"schema_install");assert.equal(request.capability.approvalRef,approvalRef);assert.equal(request.capability.planSha256,expectedV2);assert.deepEqual(request.target,migrationTarget);}});
   stage="exact-v2-install";
   const installed=await installPostgresServiceSchema(migration,{target:{database:ctx.database,username:ctx.role,schema:ctx.schema,generation,service:"migration"},approval:"approved-provisioned-business-schema",approvalRef,provisionedNamespaceApproval:namespaceApproval});
   assert.deepEqual(installed.appliedVersions,[1,2]);await migration.close();migration=undefined;
   stage="limited-private-roles";
   const tables=["business_schema_identity","business_schema_ledger","wallet_service_import_ledger","wallet_service_fact_validators","wallet_service_fact_inputs","wallet_service_fact_attestations","forward_purchase_samples","forward_trade_revisions","forward_strategy_generations"];
   const relation=(name:string)=>`${quote(ctx.schema)}."${name}"`;
   peer(ctx,consumerRoles.map(role=>`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;`).join("\n")+
    `CREATE ROLE ${quote(publisherRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 1 PASSWORD ${literal(publisherSecret.verifier)};\n`+
    `CREATE ROLE ${quote(observerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 1 PASSWORD ${literal(observerSecret.verifier)};\n`+
    `GRANT CONNECT ON DATABASE ${quote(ctx.database)} TO ${quote(publisherRole)},${quote(observerRole)};GRANT USAGE ON SCHEMA ${quote(ctx.schema)} TO ${quote(publisherRole)},${quote(observerRole)};\n`+
    `GRANT SELECT ON TABLE ${tables.map(relation).join(",")} TO ${quote(publisherRole)};\n`+
    `GRANT INSERT ON TABLE ${["wallet_service_fact_inputs","wallet_service_fact_attestations","wallet_forward_signal_wake_intents"].map(relation).join(",")} TO ${quote(publisherRole)};\n`+
    `GRANT SELECT ON TABLE ${["wallet_service_fact_inputs","wallet_service_fact_attestations","wallet_forward_signal_wake_intents"].map(relation).join(",")} TO ${quote(observerRole)};`);
   const fixtureAt=Date.now(),boughtAt=Math.floor(fixtureAt/60000)*60000-180000,token="TokenCase",entity="synthetic-owner",sample="synthetic-sample",executionFingerprint="a".repeat(64);
   const candidate=createSyntheticPublicationExecution(generation,fixtureAt,boughtAt);
   const mapping={chain:"solana" as const,tokenAddress:token,poolAddress:"SyntheticPool",tokenSide:"base" as const,network:"solana",evidenceRef:"synthetic:map",knownAt:fixtureAt-1000};
   const priceBase:PostgresGeckoTerminalPriceCandidate={generationId:generation,sampleId:sample,executionFingerprint,providerId:"synthetic-price",boughtAt,until:boughtAt+120000,knownAt:fixtureAt,mapping,candles:[{timestamp:boughtAt+60000,open:1,high:3,low:0.5,close:2,volumeUsd:20}],contentFingerprint:"",coverage:"bounded_observations_only"};
   const priceCandidate={...priceBase,contentFingerprint:priceCandidateFingerprint(priceBase)};
   const authorizationUntil=fixtureAt+120000;
   stage="synthetic-authority-and-sample";
   peer(ctx,`SET search_path TO ${quote(ctx.schema)},pg_catalog;INSERT INTO forward_strategy_generations VALUES(${literal(generation)},${boughtAt-60000});\n`+
    `INSERT INTO wallet_service_import_ledger(import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at) VALUES('synthetic-authority',${literal(generation)},${literal(approvalRef)},${literal("c".repeat(64))},'validator_authority',${fixtureAt-1000}),('synthetic-legacy',${literal(generation)},${literal(approvalRef)},${literal("d".repeat(64))},'legacy_registry_linkage',${fixtureAt-1000});\n`+
    `INSERT INTO wallet_service_fact_validators(generation_id,validator_id,kind,import_id,valid_from,valid_until) VALUES(${literal(generation)},'synthetic-validator','execution','synthetic-authority',${fixtureAt-1000},${authorizationUntil}),(${literal(generation)},'synthetic-validator','price','synthetic-authority',${fixtureAt-1000},${authorizationUntil}),(${literal(generation)},'synthetic-wrong-scope','execution','synthetic-legacy',${fixtureAt-1000},${authorizationUntil}),(${literal(generation)},'synthetic-wrong-scope','price','synthetic-legacy',${fixtureAt-1000},${authorizationUntil});\n`+
    `INSERT INTO forward_economic_trades VALUES('synthetic-trade','solana','synthetic-execution',${literal(executionFingerprint)},${literal(entity)},${literal(token)},${boughtAt});\n`+
    `INSERT INTO forward_trade_revisions(trade_id,fingerprint,state,entity_id,token_address,occurred_at,token_quantity,quote_asset,quote_amount,amount_usd,entry_price_usd,amount_basis,amount_estimated,source_representations,execution_evidence_ref,ownership_evidence_ref,recorded_at) VALUES('synthetic-trade',${literal(executionFingerprint)},'original',${literal(entity)},${literal(token)},${boughtAt},100,'USDC',60,60,0.6,'stablecoin_nominal',true,'{}','synthetic:execution','synthetic:owner',${fixtureAt});\n`+
    `INSERT INTO forward_purchase_samples VALUES(${literal(sample)},${literal(generation)},'synthetic-trade',${literal(executionFingerprint)},${literal(entity)},'solana',${literal(token)},${boughtAt},${boughtAt+2592000000},'observing',${fixtureAt});`);
   const publicKey=keys.publicKey.export({type:"spki",format:"pem"}).toString();
   const validators=["synthetic-validator","synthetic-wrong-scope"].map(validatorId=>({validatorId,keyId:"synthetic-key",publicKey,actorId:"synthetic-verified-actor",authorizationRef:approvalRef,reviewedSourceProviders:["synthetic-independent"]}));
   const target={database:ctx.database,schema:ctx.schema,username:publisherRole,serverAddress:"127.0.0.1",serverPort:5434,generationId:generation,schemaVersion:2,schemaFingerprint:expectedV2};
   publisherPool=makePool(publisherRole,publisherSecret.password,`${ctx.schema},pg_catalog`);observerPool=makePool(observerRole,observerSecret.password,`${ctx.schema},pg_catalog`);
   const counts=async()=>{const client=await observerPool!.connect();try{await client.query("BEGIN READ ONLY");const identity=(await client.query("SELECT current_database() database,current_user username,host(inet_server_addr()) address,inet_server_port() port")).rows[0]!;assert.equal(identity.database,ctx.database);assert.equal(identity.username,observerRole);assert.equal(identity.address,"127.0.0.1");assert.equal(Number(identity.port),5434);const row=(await client.query("SELECT (SELECT count(*)::int FROM wallet_service_fact_inputs) facts,(SELECT count(*)::int FROM wallet_service_fact_attestations) attestations,(SELECT count(*)::int FROM wallet_forward_signal_wake_intents) wakes")).rows[0]!;await client.query("COMMIT");return row;}finally{client.release();}};
   const timeout={statementTimeoutMs:3000,lockTimeoutMs:500};
   const uow=createPostgresUnitOfWork(publisherPool,timeout);
   const auditedRun:typeof uow.run=operation=>uow.run(transaction=>operation({async query(sql,values){
    const result=await transaction.query(sql,values);
    if(sql.includes("publisher-identity")){
     const row=result.rows[0];
     const expected={database:target.database,username:publisherRole,session_username:publisherRole,schema:target.schema,
      serverAddress:target.serverAddress,schema_generation:generation,role_safe:true,consumer_member:false,objects_safe:true,can_publish:true};
     const mismatches=Object.entries(expected).filter(([key,value])=>row?.[key]!==value).map(([key])=>key);
     const address=String(row?.serverAddress??"missing");
     identityDiagnostic=mismatches.join(",")+(mismatches.includes("serverAddress")&&/^[0-9a-fA-F:.\/]+$/.test(address)?`:${address}`:"");
    }
    return result;
   }}));
   const options={run:auditedRun,target,forbiddenRoles,validators,maximumValidationAgeMs:120000,maximumPayloadBytes:256000,statementTimeoutMs:3000,lockTimeoutMs:500,now:Date.now};
   const priceOptions={...options,mappings:[{mapping,providerId:"synthetic-price",mappingApprovalRef:"synthetic:map-approval",sourceApprovalRef:"synthetic:source-approval",sourceProofKind:"synthetic-candle-replay",candleMs:60000,validFrom:fixtureAt-1000,validUntil:authorizationUntil}],maximumCandles:3,maximumWindowMs:240000,maximumMappingAgeMs:120000};
   const executionProof=(validatorId="synthetic-validator",owner=entity):SignedPostgresExecutionValidation=>{
    const purchase={...candidate.purchaseCandidate,entityId:owner,executionEvidenceRef:"synthetic:independent-validation"};
    const claims={format:1 as const,generationId:generation,providerId:candidate.providerId,validatorId,keyId:"synthetic-key",candidateFingerprint:candidate.contentFingerprint,sourceReference:candidate.sourceReference,validationRef:"synthetic:independent-validation",checkedAt:fixtureAt,expiresAt:authorizationUntil,sourceBasis:{kind:"independent_rpc_replay" as const,providerId:"synthetic-independent",evidenceRef:"synthetic:raw-replay",contentFingerprint:"e".repeat(64)},purchase,purchaseFingerprint:walletPurchaseBasisFingerprint(purchase)};
    return{claims,signature:sign(null,executionValidationSigningPayload(claims),keys.privateKey).toString("base64")};
   };
   const priceProof=(value=priceCandidate,validatorId="synthetic-validator"):SignedPostgresPriceValidation=>{
    const sourceProof={mapping:value.mapping,candleMs:60000,sourceRevision:value.contentFingerprint,candles:value.candles,rawEvidence:{synthetic:true,provider:"synthetic-independent",observations:value.candles}};
    const claims={format:1 as const,generationId:generation,providerId:value.providerId,validatorId,keyId:"synthetic-key",candidateFingerprint:value.contentFingerprint,candidateKnownAt:value.knownAt,sampleId:sample,executionFingerprint,mappingApprovalRef:"synthetic:map-approval",sourceApprovalRef:"synthetic:source-approval",sourceRevision:value.contentFingerprint,validationRef:"synthetic:candle-validation",checkedAt:fixtureAt,expiresAt:authorizationUntil,sourceBasis:{kind:"synthetic-candle-replay",providerId:"synthetic-independent",evidenceRef:"synthetic:independent-candles",contentFingerprint:postgresServiceFactFingerprint(sourceProof)}};
    return{claims,sourceProof,signature:sign(null,priceValidationSigningPayload(claims),keys.privateKey).toString("base64")};
   };
   const signal=new AbortController().signal;
   stage="actual-publisher-identity";
   const execution=await createPostgresExecutionFactPublisher(options),price=await createPostgresPriceFactPublisher(priceOptions);
   const exInput={candidate,validation:executionProof(),signal},priceInput={candidate:priceCandidate,validation:priceProof(),signal};
   stage="execution-first-publication";assert.equal((await execution.publish(exInput)).status,"published");
   stage="execution-duplicate-publication";assert.equal((await execution.publish(exInput)).status,"duplicate");
   stage="price-first-publication";assert.equal((await price.publish(priceInput)).status,"published");
   stage="price-duplicate-publication";assert.equal((await price.publish(priceInput)).status,"duplicate");
   assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});
   stage="generation-owner-mapping-mismatch";
   await assert.rejects(execution.publish({...exInput,candidate:{...candidate,generationId:"synthetic-wrong-generation"}}));
   await assert.rejects(execution.publish({...exInput,validation:executionProof("synthetic-validator","synthetic-wrong-owner")}));
   const wrongMapping={...priceCandidate,mapping:{...mapping,poolAddress:"UnapprovedPool"}};
   const mismatched={...wrongMapping,contentFingerprint:priceCandidateFingerprint(wrongMapping)};
   assert.equal((await price.publish({candidate:mismatched,validation:priceProof(mismatched),signal})).status,"deferred");
   assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});
   stage="actual-import-authority-scope";
   await assert.rejects(execution.publish({...exInput,validation:executionProof("synthetic-wrong-scope")}));
   assert.equal((await price.publish({...priceInput,validation:priceProof(priceCandidate,"synthetic-wrong-scope")})).status,"deferred");
   assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});
   stage="physical-multi-candle-rollback";
   const multiBase={...priceCandidate,until:boughtAt+180000,candles:[...priceCandidate.candles,{...priceCandidate.candles[0]!,timestamp:boughtAt+120000,high:4}]};
   const multi={...multiBase,contentFingerprint:priceCandidateFingerprint(multiBase)},multiInput={candidate:multi,validation:priceProof(multi),signal};
   let multiFactIds:readonly string[]=[];
   await assert.rejects(uow.run(async()=>{const staged=await price.publish(multiInput);assert(staged.status==="published");multiFactIds=staged.factIds;assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});throw new Error("synthetic_preflight_rollback");}),/synthetic_preflight_rollback/);
   assert.equal(multiFactIds.length,2);assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});
   peer(ctx,`ALTER TABLE ${relation("wallet_forward_signal_wake_intents")} ADD CONSTRAINT synthetic_second_wake_failure CHECK(source_key<>${literal("price:"+multiFactIds[1]!)});`);
   let rollbackState="";try{await price.publish(multiInput);assert.fail("Physical CHECK must reject second wake");}catch(error){rollbackState=sqlState(error);assert.equal(rollbackState,"23514");}
   assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});
   peer(ctx,`ALTER TABLE ${relation("wallet_forward_signal_wake_intents")} DROP CONSTRAINT synthetic_second_wake_failure;`);
   stage="physical-commit-await";
   let commitEntered!:()=>void,commitRelease!:()=>void;
   const entered=new Promise<void>(resolve=>{commitEntered=resolve;}),released=new Promise<void>(resolve=>{commitRelease=resolve;});
   let mode:"hold"|"lost-ack"|"normal"="normal",nativeCommitCalls=0;
   const traced:PostgresPool={async connect():Promise<PostgresClient>{const client=await publisherPool!.connect();return{async query(sql,values):Promise<PostgresResult>{if(sql==="COMMIT"&&mode==="hold"){commitEntered();await released;}const result=await client.query(sql,values);if(sql==="COMMIT"){nativeCommitCalls++;if(mode==="lost-ack"){mode="normal";throw new Error("synthetic_ack_lost_after_real_commit");}}return result;},release:error=>client.release(error)};}};
   const tracedWork=createPostgresUnitOfWork(traced,timeout),tracedPrice=await createPostgresPriceFactPublisher({...priceOptions,run:tracedWork.run});
   mode="hold";let acknowledged=false;const held=tracedPrice.publish(multiInput).then(result=>{acknowledged=true;return result;});
   try{await Promise.race([entered,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error("commit_gate_deadline")),15000);timer.unref();})]);assert.equal(acknowledged,false);assert.deepEqual(await counts(),{facts:2,attestations:2,wakes:1});}finally{commitRelease();}
   assert.equal((await held).status,"published");assert.equal(acknowledged,true);mode="normal";assert.deepEqual(await counts(),{facts:4,attestations:4,wakes:3});
   stage="actual-commit-unknown-reconciliation";
   const changedBase={...priceCandidate,candles:[{...priceCandidate.candles[0]!,high:5}]};
   const changed={...changedBase,contentFingerprint:priceCandidateFingerprint(changedBase)},changedInput={candidate:changed,validation:priceProof(changed),signal};
   mode="lost-ack";await assert.rejects(tracedPrice.publish(changedInput),PostgresCommitUncertainError);
   assert.deepEqual(await counts(),{facts:5,attestations:5,wakes:4});assert.equal((await price.publish(changedInput)).status,"duplicate");
   stage="minimal-actual-acl";
   const acl=JSON.parse(peer(ctx,`SELECT json_build_object('publisherRole',current_user,'consumerAuthorityWrites',EXISTS(SELECT 1 FROM unnest(ARRAY[${consumerRoles.map(literal).join(",")}]) r(role) CROSS JOIN unnest(ARRAY['wallet_service_fact_inputs','wallet_service_fact_attestations','wallet_service_fact_validators']) t(name) WHERE has_table_privilege(r.role,format('%I.%I',${literal(ctx.schema)},t.name),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.role,format('%I.%I',${literal(ctx.schema)},t.name),'INSERT,UPDATE,REFERENCES')),'publisherMutationTables',(SELECT json_agg(c.relname ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(ctx.schema)} AND has_table_privilege(${literal(publisherRole)},c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')));`)) as {consumerAuthorityWrites:boolean;publisherMutationTables:string[]};
   assert.equal(acl.consumerAuthorityWrites,false);assert.deepEqual(acl.publisherMutationTables,["wallet_forward_signal_wake_intents","wallet_service_fact_attestations","wallet_service_fact_inputs"]);
   return{syntheticOnly:true,productionWrites:false,nonce:ctx.nonce,database:ctx.database,schema:ctx.schema,publisherRole,schemaVersion:2,schemaFingerprint:expectedV2,installedVersions:installed.appliedVersions,maximumClients:2,capacity:ctx.capacity,
    executionPublished:true,executionDuplicate:true,pricePublished:true,priceDuplicate:true,mismatchRejections:3,authorityScopeRejections:2,physicalMultiCandleRollback:true,rollbackSqlState:rollbackState,awaitingCommit:true,commitUncertaintyReconciled:true,nativeCommitCalls,consumerAuthorityWrites:false,physicalReceipts:await counts()};
  }catch(error){
   const message=error instanceof Error?error.message:"";
   const predicate=message.match(/Execution fact\/attestation identity collision|Signed execution quantities\/reference mismatch|Current migration-approved validator binding required|Independent source\/candidate\/clock validation required|External validator signature invalid|Independent price candidate\/source\/revision\/clock validation required|Authenticated independent raw candle proof mismatch|External price signature invalid|Immutable price fact\/attestation collision/)?.[0]??"none";
   throw new Error(`Synthetic real publication failed at ${stage}; SQLSTATE=${sqlState(error)}; identity=${identityDiagnostic}; predicate=${predicate}`);
  }
  finally{if(migration)await migration.close();await publisherPool?.end();await observerPool?.end();}
 });
 return{...result,cleaned:true};
}
