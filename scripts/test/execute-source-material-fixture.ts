/** Disposable fixture materials. No production approvals or successful receipts are created. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createSourceReplacementPlan } from '../prepare-address-only-source-replacement.js';
import { createAddressOnlyConfiguredDeployment } from '../create-address-only-configured-deployment.js';
import { runtimeAuthorityFingerprint } from '../provision-address-only-runtime-authority.js';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';
import { PostgresAuthorityPool } from '../../packages/database/src/postgres-authority-client.js';
const root='/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const load=async (p:string)=>JSON.parse(await readFile(p,'utf8'));
const pin=async (p:string)=>({path:p,sha256:hash(await readFile(p))});
const put=async (name:string,value:unknown)=>{const p=root+'/'+name;await writeFile(p,typeof value==='string'?value:JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});return pin(p);};
let stage='input';
async function main(){
  if(process.geteuid?.()!==0 || process.argv[2]!=='--fixture')throw Error('isolated_material_fixture_only');
  const committed=await load('/tmp/committed.json'),binding=committed.binding;
  if(binding.target.database!=='radar_rehearsal_0123456789abcdef'||binding.target.systemIdentifier==='7693392208475083526')throw Error('isolated_material_target');
  const output=root+'/address-only-run-'+binding.operationId,old=await load(output+'/activation-state.json');
  if(old.phase!=='COMPLETE'||old.receipt.proofScope!=='isolated-activation')throw Error('isolated_material_complete');
  const original=await load(output+'/address-only-manifest.json'),inventory=await load(root+'/new-release-inventory.json');
  const manifest={...original,releaseSha256:inventory.releaseSha256},at=Date.now(),until=at+3_600_000;
  const approval=await put('fixture-authority-approval.json',{protocol:'isolated-fixture-authority-approval-v1',
    productionAuthorized:false,operationId:binding.operationId,generationId:binding.generationId,
    purposes:['execution-validator','provider-contract'],actorId:'isolated-replay-operator',approvedAt:at,expiresAt:until});
  const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString();
  const key=await put('fixture-validator-key.pem',keys.privateKey.export({type:'pkcs8',format:'pem'}).toString());
  const publisherRole='radar_fixture_publisher',operatorRole='radar_fixture_operator',password=randomBytes(32).toString('hex');
  const credential=await put('publisher-credential.json',{service:'execution-publisher',username:publisherRole,gatewayDeliveryEnabled:false,
    connectionString:`postgresql://${publisherRole}:${password}@127.0.0.1:5432/${binding.target.database}`});
  const operator=await put('operator-credential.json',{service:'operator',username:operatorRole,gatewayDeliveryEnabled:false,
    connectionString:`postgresql://${operatorRole}:${password}@127.0.0.1:5432/${binding.target.database}`});
  const configuration={kind:'execution',validatorId:'fixture-validator',importId:'fixture-validator-import',evidenceSha256:approval.sha256,
    importedAt:at,validFrom:at,validUntil:until,keyId:'fixture-key',publicKey,actorId:'isolated-replay-operator',
    authorizationRef:'isolated-execution-approval',reviewedSourceProviders:['fixture-official-replay']};
  const fingerprint=runtimeAuthorityFingerprint({approvalRef:'isolated-ledger-approval',proofScope:'validator_authority',configuration});
  const oldContract={providerId:'fixture-old-source',origin:'https://helius.example',importId:'fixture-old-contract',sourceFingerprint:approval.sha256,windowMs:60000,maximumRequests:60,maximumConcurrency:1};
  const replay={...oldContract,providerId:'fixture-official-replay',origin:'https://api.mainnet-beta.solana.com',importId:'fixture-replay-contract'};
  const pair={chain:'solana',sourceProviderId:oldContract.providerId,sourceEndpoint:oldContract.origin,
    replayProviderId:replay.providerId,replayEndpoint:replay.origin,expectedGenesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'};
  const validator={validatorId:configuration.validatorId,keyId:configuration.keyId,publicKey,reviewedProviderBindings:[pair],
    maximumProfiles:10,maximumRpcRequests:4,maximumLogs:10,maximumDecimalsReads:4,maximumPayloadBytes:128000,
    maximumRunMs:5000,validationTtlMs:60000,maximumNonces:10};
  const authority={protocol:'address-only-cli-execution-authority-v1',operationId:binding.operationId,generationId:binding.generationId,
    releaseSha256:inventory.releaseSha256,username:publisherRole,migrationRole:'radar_migrator_0123456789abcdef',credential,privateKey:key,validator,
    publisher:{validators:[configuration],maximumValidationAgeMs:60000,maximumPayloadBytes:128000,statementTimeoutMs:1000,lockTimeoutMs:1000}};
  const roles={scanner:'radar_0123456789abcdef_scanner',automation:'radar_0123456789abcdef_automation',
    'wallet-monitor':'radar_0123456789abcdef_wallet_monitor','wallet-analysis':'radar_0123456789abcdef_wallet_analysis',
    'historical-backfill':'radar_0123456789abcdef_historical_backfill',console:'radar_0123456789abcdef_console'};
  const walletExecution={solana:{providerId:oldContract.providerId,endpoint:oldContract.origin,expectedGenesisHash:pair.expectedGenesisHash,
    rateLimitCooldownMs:60000,maximumProfiles:10,maximumRunMs:5000,maximumPayloadBytes:128000},receiver:{maximumCandidates:1,maximumRunMs:5000,maximumPayloadBytes:128000}};
  stage='configured_factory';
  const generated=createAddressOnlyConfiguredDeployment({manifest,releaseRoot:root+'/new-release',execution:{maximumEntries:inventory.entries,maximumBytes:inventory.bytes},roles,
    intervalMs:30000,principal:{actorId:'isolated-fixture-operator',authorizationEvidenceRef:'isolated-fixture-only',permissions:['target_registry_write']},
    sourceRPCRegistry:[{chain:'solana',providerId:oldContract.providerId,origin:oldContract.origin,endpointEnvironmentKey:'RADAR_RPC_SOLANA_HTTP_URL'}],
    budgetContracts:[oldContract,replay].map(c=>({...c,generationId:binding.generationId,proofScope:'provider_contract' as const,evidenceRef:'isolated-fixture-only',evidenceSha256:approval.sha256,importedAt:at,validUntil:until})),
    authorityProofs:[{kind:'execution',generationId:binding.generationId,validatorId:configuration.validatorId,publisherRole,evidenceRef:'isolated-fixture-only',evidenceSha256:approval.sha256,observedAt:at,validUntil:until}],walletExecution});
  const settings={protocol:'address-only-configured-preflight-settings-v1',credential:operator,providerContracts:[oldContract,replay],
    validators:[{kind:'execution',validatorId:configuration.validatorId,importId:configuration.importId,sourceFingerprint:fingerprint}]};
  const review={version:1 as const,importId:'fixture-publicnode-contract',contractRef:'isolated-fixture-publicnode-contract',approvalRef:'isolated-source-replacement',generationId:binding.generationId,importedAt:at,
    budgets:[{providerId:'fixture-publicnode-source',origin:'https://solana-rpc.publicnode.com',windowStartedAt:at-120000,windowMs:60000,maximumRequests:60,requestsUsed:0,maximumConcurrency:1,cooldownUntil:'0'}]};
  const input={oldProviderId:oldContract.providerId,oldOrigin:oldContract.origin,oldOperator:'Helius',newOperator:'Allnodes/PublicNode',review,
    trustedReviewSha256:hash(migrationCutoverCanonicalJson(review)),material:{authority,deployment:{...generated.deployment,walletExecution},settings,
      environment:{...generated.environment,RADAR_RPC_SOLANA_HTTP_URL:oldContract.origin}}};
  stage='replacement_plan';
  const plan=createSourceReplacementPlan(input),inputPin=await put('replacement-input.json',input);
  const authorityPin=await put('replacement-authority.json',plan.material.authority),settingsPin=await put('replacement-settings.json',plan.material.settings);
  const deployment=await put('replacement-deployment.json',plan.material.deployment);
  const environment=await put('replacement-environment.json',{...plan.material.environment,ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE:deployment.path,
    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256:deployment.sha256,ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE:authorityPin.path,
    ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256:authorityPin.sha256,ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE:settingsPin.path,
    ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256:settingsPin.sha256,ADDRESS_RADAR_POSTGRES_ENTRY_SHA256:hash(await readFile(root+'/new-release/scripts/postgres-service-entry.mjs')),
    ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:inventory.releaseSha256});
  stage='profile_read';
  const pool=new PostgresAuthorityPool({host:'127.0.0.1',port:5432,database:binding.target.database,user:'radar_migrator_0123456789abcdef',password:'isolated-fixture-password',max:1,statement_timeout:2000,lock_timeout:1000,connectionTimeoutMillis:1000});
  let profile;
  try{const rows=(await pool.query(`SELECT c.profile_payload,v.version_id,h.payload FROM "${binding.target.schema}".wallet_service_profile_cohort c JOIN "${binding.target.schema}".wallet_service_profile_versions v USING(generation_id,subject_key) JOIN "${binding.target.schema}".forward_target_channel_versions h ON h.version_id=v.version_id WHERE c.generation_id=$1 LIMIT 2`,[binding.generationId])).rows;
    if(rows.length!==1)throw Error('isolated_profile_binding');const row=rows[0]!;profile={...JSON.parse(String(row.profile_payload)),fact:JSON.parse(String(row.payload)),versionId:row.version_id};
  }finally{await pool.end();}
  stage='templates';
  const payload=await put('probe-payload.json',{schemaVersion:1,generationId:binding.generationId,collectorId:'solana',chainFamily:'solana',profile,
    event:{eventId:'fixture-event',chain:'solana',walletAddress:'11111111111111111111111111111111',tokenAddress:'TokenCase',side:'buy',occurredAt:Math.floor(at/1000)*1000,amountUsd:null,priceUsd:null,marketCapUsd:null,sourceReference:'solana:fixture-signature'},purchase:null,externalBasis:null,entryPriceBasis:null});
  const runtimeAuthority=await put('runtime-authority.json',{approvalRef:'isolated-ledger-approval',target:{...binding.target,generationId:binding.generationId},validators:[configuration]});
  const importTemplate=await put('import-template.json',{input:inputPin,target:{...binding.target,username:'radar_migrator_0123456789abcdef',generation:binding.generationId,service:'migrator',schemaVersion:3}});
  const probeTemplate=await put('probe-template.json',{protocol:'address-only-configured-source-probe-job-v1',deadlineAtMs:at+60000,deployment,environment,authority:authorityPin,settings:settingsPin,runtimeAuthority,credential:await pin(root+'/auth/wallet-monitor.json'),payload,maximumRunMs:5000,maximumBodyBytes:2097152});
  const q=(v:unknown)=>"'"+String(v).replaceAll("'","''")+"'",schema='"'+binding.target.schema+'"';
  const sql=[`BEGIN; SET LOCAL statement_timeout='2000ms'; SET search_path TO ${schema},pg_catalog;`];
  for(const c of [oldContract,replay]){sql.push(`INSERT INTO wallet_service_import_ledger(import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at) VALUES(${q(c.importId)},${q(binding.generationId)},'isolated-fixture-only',${q(c.sourceFingerprint)},'provider_contract',${at});`);
    sql.push(`INSERT INTO wallet_service_provider_budgets(generation_id,provider_id,origin,import_id,window_started_at,window_ms,maximum_requests,requests_used,maximum_concurrency,cooldown_until) VALUES(${q(binding.generationId)},${q(c.providerId)},${q(c.origin)},${q(c.importId)},${at-120000},60000,60,0,1,0);`);}
  sql.push(`INSERT INTO wallet_service_import_ledger(import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at) VALUES(${q(configuration.importId)},${q(binding.generationId)},'isolated-ledger-approval',${q(fingerprint)},'validator_authority',${at});`);
  sql.push(`INSERT INTO wallet_service_fact_validators(generation_id,validator_id,kind,import_id,valid_from,valid_until) VALUES(${q(binding.generationId)},${q(configuration.validatorId)},'execution',${q(configuration.importId)},${at},${until});`);
  for(const role of [operatorRole,publisherRole])sql.push(`CREATE ROLE ${role} LOGIN NOINHERIT CONNECTION LIMIT 1 PASSWORD ${q(password)}; GRANT CONNECT ON DATABASE ${binding.target.database} TO ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role}; ${role===operatorRole?`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role};`:`GRANT SELECT ON ${['business_schema_identity','business_schema_ledger','wallet_service_import_ledger','wallet_service_fact_validators','wallet_service_provider_budgets','wallet_service_fact_inputs','wallet_service_fact_attestations','forward_purchase_samples','forward_trade_revisions','forward_strategy_generations'].map(name=>schema+'.'+name).join(',')} TO ${role}; GRANT INSERT ON ${['wallet_service_fact_inputs','wallet_service_fact_attestations','wallet_forward_signal_wake_intents'].map(name=>schema+'.'+name).join(',')} TO ${role};`} GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${role};`);
  sql.push(`GRANT UPDATE(window_started_at,requests_used,cooldown_until) ON ${schema}.wallet_service_provider_budgets TO ${roles['wallet-monitor']}; GRANT INSERT,UPDATE ON ${schema}.wallet_service_provider_leases TO ${roles['wallet-monitor']};`);
  sql.push('COMMIT;');await put('fixture-authority-install.sql',sql.join('\n'));
  await put('replacement-material-index.json',{replacementSha256:plan.replacementSha256,importTemplate,probeTemplate,deployment,environment,productionProof:false});
  console.log(JSON.stringify({event:'ISOLATED_REPLACEMENT_MATERIALS_PREPARED',productionProof:false}));
}
void main().catch((error:unknown)=>{
  const properties:PropertyDescriptorMap=error && typeof error==='object'?Object.getOwnPropertyDescriptors(error):{};
  const message=properties.message && 'value' in properties.message?properties.message.value:undefined;
  const code=properties.code && 'value' in properties.code?properties.code.value:undefined;
  const known=['isolated_profile_binding','explicit_metadata_identifier_required','metadata_evidence_expired','SOURCE_REPLACEMENT_OLD_SOURCE_STILL_REFERENCED'];
  console.error(JSON.stringify({event:'ISOLATED_REPLACEMENT_MATERIALS_REFUSED',stage,
    reasonCode:known.includes(message)?message:'unclassified',
    ...(typeof code==='string' && /^[0-9A-Z]{5}$/.test(code)?{sqlState:code}:{}),
    ...(typeof message==='string'?{reasonSha256:hash(message)}:{})}));process.exitCode=1;
});

