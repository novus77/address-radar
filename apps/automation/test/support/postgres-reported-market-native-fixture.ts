import assert from 'node:assert/strict';
import { writeFile, chmod, rename, symlink } from 'node:fs/promises';
import { createPostgresCliReportedPriceAuthority, type ReportedPriceCliMaterial } from '../../../../scripts/postgres-reported-price-cli-authority.js';
import { composePostgresServicePriceDependencies } from '../../../../scripts/postgres-price-authority.js';
import type { ConfiguredPostgresServiceDeployment } from '../../../../scripts/postgres-service-entry.js';
import { createPostgresServiceSchema, createPostgresServiceSchemaGrantPlan } from '../../src/postgres-service-schema.js';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { PostgresAuthorityClient as Client, PostgresAuthorityPool as Pool } from '../../../../packages/database/src/postgres-authority-client.js';
import { POSTGRES_BUSINESS_SCHEMA_MODULES, POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL, createPostgresBusinessSchemaPlan } from '../../../../packages/database/src/postgres-business-schema.js';
import { MIGRATION_CUTOVER_TRANSITIONS_DDL } from '../../../../packages/database/src/migration-cutover-coordinator.js';
import { createPostgresBusinessRuntime } from '../../../../packages/database/src/postgres-business-driver.js';
import { createPostgresUnitOfWork, PostgresCommitUncertainError, type PostgresTransaction } from '../../../../packages/database/src/postgres-unit-of-work.js';
import { provisionRuntimeAuthority, runtimeAuthorityFingerprint, type RuntimeAuthorityJob } from '../../../../scripts/provision-address-only-runtime-authority.js';
import { createAveMarketClient } from '../../../../packages/collectors/src/ave-market-client.js';
import { POSTGRES_SERVICE_FACT_SCHEMA_SQL, createPostgresServiceFactAdapters, postgresServiceFactFingerprint } from '../../src/postgres-service-fact-adapters.js';
import { POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL, receivePostgresProductionPriceBatch } from '../../src/postgres-production-composition.js';
import { createPostgresReportedMarketCapProducer } from '../../src/postgres-controlled-price-producer.js';
import { createPostgresReportedMarketCapValidator, type PostgresReportedMarketCapApproval } from '../../src/postgres-independent-price-validator.js';
import { createPostgresPriceFactPublisher, priceValidationSigningPayload } from '../../src/postgres-price-fact-publisher.js';
import { createPostgresReportedMarketApprovalReader, importReportedMarketApproval, revokeReportedMarketApproval,
  reportedMarketApprovalRevocationFingerprint, verifyReportedMarketApprovalConfiguration } from '../../../../scripts/postgres-reported-market-approval.js';
import { REPORTED_MARKET_APPROVAL_SCOPE, reportedMarketApprovalFingerprint,
  type ReportedMarketApprovalDocument } from '../../src/postgres-reported-market-approval-ledger.js';
import type { PostgresMigrationRuntimeOptions } from '../../../../packages/database/src/postgres-migration-runtime.js';

// Synthetic source/approval material is deliberately confined to a newly created Docker cluster.
// No root-native installation/approval receipt or production authority is asserted by this fixture.
const scenarios = new Set(['reported_100k','fdv_only','missing_approval','candle_only_approval','conflicting_approval',
  'revoked_approval','expired_approval','wrong_approval_provider','wrong_approval_mapping','source_snapshot_conflict',
  'pending_revision','wrong_revision','expired_sample','expired_signature','revoked_validator','rollback_attestation',
  'rollback_wake','rollback_consumer','commit_ack_unknown','acl_drift','role_scanner','role_automation','role_wallet_monitor',
  'role_wallet_analysis','role_historical_backfill','role_console','role_migrator',
  'dedicated_revoke_before_publish','dedicated_revoke_before_read','dedicated_revoke_before_ack',
  'dedicated_expired_before_publish','dedicated_expired_before_read','dedicated_expired_before_ack',
  'dedicated_scope_drift','dedicated_fingerprint_drift','dedicated_identity_drift',
  'dedicated_revoke_rollback','dedicated_revoke_commit_unknown','dedicated_revoke_blocks_publish','dedicated_publish_blocks_revoke',
  'dedicated_revoke_blocks_ack','dedicated_ack_blocks_revoke','dedicated_publish_expiry_rollback',
  'dedicated_ack_expiry_rollback','dedicated_overlong_signature_ttl','dedicated_acl','dedicated_pg_control_acl',"loader_100k","loader_revoke_publish","loader_revoke_consume","loader_provider_revoke","loader_validator_revoke","loader_scope","loader_generation","loader_cluster","loader_credential","loader_key","loader_allocation","loader_401","loader_403","loader_429","loader_cancel","loader_budget_window","loader_identity","loader_material_mode","loader_material_symlink","loader_material_drift","loader_provider_scope","loader_validator_scope"]);
let phase = 'input';
function identifier(value: string) { assert.match(value, /^[a-z][a-z0-9_]{0,62}$/); return '"' + value + '"'; }
async function main() {
  assert.equal(process.argv[1], '--isolated-fixture');
  let raw = '';
  for await (const chunk of process.stdin) { raw += String(chunk); assert.ok(Buffer.byteLength(raw) <= 16384); }
  const input = JSON.parse(raw) as { nonce: string; database: string; password: string; scenario: string };
  assert.match(input.nonce, /^[a-f0-9]{16}$/); assert.match(input.password, /^[a-f0-9]{64}$/);
  assert.equal(input.database, 'radar_rehearsal_' + input.nonce); assert.ok(scenarios.has(input.scenario));
  const scenario = input.scenario, tag = createHash('sha256').update(input.nonce + scenario).digest('hex').slice(0,12);
  const schema = input.database + '_' + [...tag].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
  const prefix = 'reported_' + tag + '_';
  const roleNames = ['scanner','automation','wallet_monitor','wallet_analysis','historical_backfill','console','migrator'] as const;
  const roles = Object.fromEntries(roleNames.map(name => [name,prefix + name])) as Record<typeof roleNames[number],string>;
  const publisherRole = prefix + 'publisher', rolePassword = randomBytes(32).toString('hex');
  const generationId = 'production-20261006-v1', nowBase = 1791600000000;
  let clock = nowBase, httpCalls = 0, externalRequests = 0, commitFault = false, rollbackFault = '';
  globalThis.fetch = async () => { externalRequests++; throw new Error('fixture_external_fetch_forbidden'); };
  const now = () => clock;
  const connectionString = (username: string, password = rolePassword) => `postgresql://${username}:${password}@127.0.0.1:5432/${input.database}`;
  const admin = new Client({ connectionString: connectionString('postgres',input.password), query_timeout:3000, connectionTimeoutMillis:2000 });
  const pools: InstanceType<typeof Pool>[] = [];
  let publisherHook: ((sql:string)=>Promise<void>) | undefined;
  let migrationHook: ((sql:string)=>Promise<void>) | undefined;
  let migrationCommitFault = false;
  let runtime: ReturnType<typeof createPostgresBusinessRuntime> | undefined;
  let createdSchema = false;
  const createdRoles: string[] = [];
  await admin.connect();
  try {
    phase = 'cluster_identity';
    const identity = (await admin.query(`SELECT current_database() AS database,current_user AS username,session_user AS session_username,
      system_identifier::text FROM pg_control_system()`)).rows[0];
    assert.equal(identity.database,input.database); assert.equal(identity.username,'postgres'); assert.equal(identity.session_username,'postgres');
    assert.notEqual(identity.system_identifier,'7693392208475083526');
    assert.match(identity.system_identifier,/^[0-9]+$/);
    assert.equal((await admin.query('SHOW fsync')).rows[0].fsync,'on');
    phase = 'fixture_roles';
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(input.database)} FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    for (const name of roleNames) {
      const role = roles[name];
      await admin.query("SELECT set_config('fixture.role', $1, false),set_config('fixture.password',$2,false)",[role,rolePassword]);
      await admin.query(`DO $$ BEGIN EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 1 PASSWORD %L',
        current_setting('fixture.role'),current_setting('fixture.password')); END $$`);
      createdRoles.push(role);
      await admin.query(`GRANT CONNECT ON DATABASE ${identifier(input.database)} TO ${identifier(role)}`);
    }
    await admin.query(`CREATE SCHEMA ${identifier(schema)} AUTHORIZATION ${identifier(roles.migrator)}`); createdSchema = true;
    const extensions = [
      {id:'fixture-service-facts',dependencies:['forward-purchases'],sql:POSTGRES_SERVICE_FACT_SCHEMA_SQL},
      {id:'fixture-production-composition',dependencies:['forward-purchases'],sql:POSTGRES_PRODUCTION_COMPOSITION_SCHEMA_SQL},
      {id:'fixture-cutover',dependencies:[],sql:MIGRATION_CUTOVER_TRANSITIONS_DDL},
    ];
    const loaderSchema = scenario.startsWith('loader_') ? createPostgresServiceSchema({protocolVersion:2}) : undefined;
    const plan = loaderSchema?.plan ?? createPostgresBusinessSchemaPlan([
      {version:1,modules:POSTGRES_BUSINESS_SCHEMA_MODULES.map(module => module.id)},
      {version:2,modules:extensions.map(module => module.id)},
    ],{trustedModules:extensions});
    const migrator = new Client({connectionString:connectionString(roles.migrator),query_timeout:3000,connectionTimeoutMillis:2000});
    await migrator.connect();
    try {
      phase = 'real_schema';
      assert.equal((await migrator.query('SELECT current_user=session_user AS same')).rows[0].same,true);
      await migrator.query(`SET search_path TO ${identifier(schema)},pg_catalog`);
      await migrator.query('BEGIN');
      await migrator.query(POSTGRES_BUSINESS_SCHEMA_LEDGER_SQL);
      for (const module of [...POSTGRES_BUSINESS_SCHEMA_MODULES,...(loaderSchema?.trustedModules ?? extensions)]) await migrator.query(module.sql);
      await migrator.query(`INSERT INTO business_schema_identity(singleton,ledger_format,database_name,schema_name,generation_id,installed_by,approval_ref)
        VALUES(true,1,$1,$2,$3,$4,'fixture-only-schema')`,[input.database,schema,generationId,roles.migrator]);
      for (const migration of plan.migrations) await migrator.query(`INSERT INTO business_schema_ledger(version,fingerprint,previous_fingerprint,modules_json,installed_by,approval_ref)
        VALUES($1,$2,$3,$4,$5,'fixture-only-schema')`,[migration.version,migration.fingerprint,migration.previousFingerprint,JSON.stringify(migration.modules),roles.migrator]);
      await migrator.query('COMMIT');
    } finally { await migrator.end(); }
    await admin.query(`SET search_path TO ${identifier(schema)},pg_catalog`);
    phase = 'seed_original_sample';
    const token = '1'.repeat(31)+'2', poolAddress = '1'.repeat(31)+'3', quote = '1'.repeat(31)+'4';
    const fingerprint = 'a'.repeat(64), boughtAt = nowBase-20000, activatedAt = nowBase-60000;
    await admin.query('INSERT INTO forward_strategy_generations(generation_id,activated_at) VALUES($1,$2)',[generationId,activatedAt]);
    await admin.query(`INSERT INTO wallet_service_import_ledger VALUES('fixture-cohort',$1,'fixture-only-cohort',$2,'legacy_registry_linkage',$3,NULL)`,[generationId,'b'.repeat(64),activatedAt]);
    await admin.query(`INSERT INTO wallet_service_profile_cohort VALUES($1,'fixture-wallet','fixture-entity','solana','{}','fixture-cohort',$2)`,[generationId,activatedAt]);
    const cohort = (await admin.query('SELECT row_to_json(c) AS value FROM wallet_service_profile_cohort c ORDER BY subject_key')).rows.map(row=>row.value);
    await admin.query(`INSERT INTO forward_economic_trades(trade_id,chain,execution_key,original_fingerprint,entity_id,token_address,occurred_at)
      VALUES('fixture-trade','solana','fixture-execution',$1,'fixture-entity',$2,$3)`,[fingerprint,token,boughtAt]);
    await admin.query(`INSERT INTO forward_trade_revisions(trade_id,fingerprint,state,entity_id,token_address,occurred_at,token_quantity,quote_asset,quote_amount,
      amount_usd,entry_price_usd,amount_basis,amount_estimated,source_representations,execution_evidence_ref,ownership_evidence_ref,recorded_at)
      VALUES('fixture-trade',$1,'original','fixture-entity',$2,$3,1,$4,60,60,60,'stablecoin_nominal',false,'[]','fixture-only-execution','fixture-only-ownership',$3)`,[fingerprint,token,boughtAt,quote]);
    await admin.query(`INSERT INTO forward_purchase_samples(sample_id,generation_id,trade_id,execution_fingerprint,entity_id,chain,token_address,occurred_at,expires_at,state,created_at)
      VALUES('fixture-sample',$1,'fixture-trade',$2,'fixture-entity','solana',$3,$4,$5,'observing',$4)`,[generationId,fingerprint,token,boughtAt,nowBase+86400000]);
    await admin.query(`INSERT INTO forward_token_watches(generation_id,chain,token_address,first_discovered_at,capture_until)
      VALUES($1,'solana',$2,$3,$4)`,[generationId,token,boughtAt,nowBase+86400000]);
    await admin.query('INSERT INTO wallet_service_price_leases(generation_id) VALUES($1)',[generationId]);
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({type:'spki',format:'pem'}).toString();
    const job: RuntimeAuthorityJob = {
      version:1,approvalRef:'fixture-only-runtime-authority',approvedAt:nowBase-1000,expiresAt:nowBase+600000,
      target:{database:input.database,schema,adminUsername:'postgres',serverAddress:'127.0.0.1',serverPort:5432,
        systemIdentifier:identity.system_identifier,generationId,schemaVersion:plan.version,schemaFingerprint:plan.fingerprint},
      publisherRole,forbiddenRoles:{scanner:roles.scanner,automation:roles.automation,'wallet-monitor':roles.wallet_monitor,
        'wallet-analysis':roles.wallet_analysis,'historical-backfill':roles.historical_backfill,console:roles.console,migrator:roles.migrator},
      cohort:{importId:'fixture-cohort',wallets:1,entities:1,sha256:runtimeAuthorityFingerprint(cohort)},
      credential:{path:'/var/lib/address-radar-maintenance-tools/fixture/publisher.json',sha256:'b'.repeat(64)},
      adminCredential:{path:'/var/lib/address-radar-maintenance-tools/fixture/admin.json',sha256:'c'.repeat(64)},
      providers:[{providerId:'fixture-ave',origin:'https://prod.ave-api.com',importId:'fixture-provider',evidenceSha256:'d'.repeat(64),
        importedAt:nowBase-500,windowStartedAt:nowBase-500,requestsUsed:0,cooldownUntil:0}],
      validators:[{kind:'price',validatorId:'fixture-validator',importId:'fixture-validator-import',evidenceSha256:'e'.repeat(64),
        importedAt:nowBase-500,validFrom:nowBase-500,validUntil:nowBase+600000,keyId:'fixture-ed25519',publicKey,
        actorId:'fixture-validator-actor',authorizationRef:'fixture-only-reported-approval',reviewedSourceProviders:['fixture-ave']}],
    };
    const credential = {connectionString:connectionString(publisherRole),gatewayDeliveryEnabled:false as const,service:'execution-publisher' as const,username:publisherRole};
    phase = 'provision_preflight';
    const authorityClient={async query(sql:string,values:readonly unknown[]=[]){
      const tag=/^\/\* (provision-[a-z-]+) \*\//.exec(sql)?.[1];
      if(tag)phase=tag;
      const result=await admin.query(sql,[...values]);return{rows:result.rows,rowCount:result.rowCount};
    }};
    const initial = await provisionRuntimeAuthority(job,credential,authorityClient,{now});
    assert.ok(initial);
    assert.equal((await admin.query('SELECT count(*)::integer AS n FROM wallet_service_provider_budgets')).rows[0].n,0);
    phase = 'provision_apply';
    await provisionRuntimeAuthority(job,credential,authorityClient,{apply:true,now}); createdRoles.push(publisherRole);
    await provisionRuntimeAuthority(job,credential,authorityClient,{now});
    assert.deepEqual((await admin.query('SELECT row_to_json(c) AS value FROM wallet_service_profile_cohort c ORDER BY subject_key')).rows.map(row=>row.value),cohort);
    const budget = (await admin.query('SELECT maximum_requests,maximum_concurrency FROM wallet_service_provider_budgets')).rows[0];
    assert.deepEqual(budget,{maximum_requests:60,maximum_concurrency:1});
    phase = 'consumer_acl';
    await admin.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(roles.scanner)};
      GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(schema)} TO ${identifier(roles.scanner)};
      GRANT UPDATE ON wallet_service_price_leases,forward_token_watches,wallet_service_provider_leases TO ${identifier(roles.scanner)};
      GRANT INSERT ON wallet_service_price_consumption,forward_token_market_inputs,forward_token_milestone_hits,forward_token_watch_intents,wallet_service_provider_leases TO ${identifier(roles.scanner)};
      GRANT UPDATE(window_started_at,requests_used,cooldown_until) ON wallet_service_provider_budgets TO ${identifier(roles.scanner)}`);
    const serviceRoles = { scanner:roles.scanner, automation:roles.automation, 'wallet-monitor':roles.wallet_monitor,
      'wallet-analysis':roles.wallet_analysis, 'historical-backfill':roles.historical_backfill, console:roles.console };
    const grants = createPostgresServiceSchemaGrantPlan({schema,migratorRole:roles.migrator,serviceRoles});
    const identityGrants = grants.statements.filter(sql=>sql.startsWith('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()'));
    assert.equal(identityGrants.length,1);
    // Remove the isolated cluster's PUBLIC default so this test proves the explicit service grant.
    await admin.query('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC');
    await admin.query(identityGrants[0]!);
    await admin.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${identifier(roles.migrator)}`);
    const acl = (await admin.query(`SELECT rolname,
      has_table_privilege(rolname,'wallet_service_import_ledger','UPDATE') AS table_update,
      has_any_column_privilege(rolname,'wallet_service_import_ledger','UPDATE') AS column_update
      FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,[[publisherRole,roles.scanner]])).rows;
    assert.equal(acl.length,2);for(const row of acl){assert.equal(row.table_update,false);assert.equal(row.column_update,false);}
    runtime = createPostgresBusinessRuntime({connectionString:connectionString(roles.scanner),target:{database:input.database,username:roles.scanner,
      schema,generation:generationId,service:'scanner'},access:'runtime',schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,
      ssl:false,maximumConnections:1,serviceConnectionBudgets:{scanner:1},serverMaximumConnections:100,reservedConnections:5,
      maximumPendingOperations:4,connectionTimeoutMs:2000,idleTimeoutMs:1000,statementTimeoutMs:3000,lockTimeoutMs:1000,
      idleTransactionTimeoutMs:5000,shutdownTimeoutMs:5000,workMemKb:1024});
    const adapters = await createPostgresServiceFactAdapters({runtime,generationId,maximumProfiles:1,now,sources:{leaseMs:5000,
      maximumProfileAgeMs:120000,maximumFactAgeMs:120000,maximumSafetyAgeMs:120000,providerTimeoutMs:2000,
      maximumResponseBytes:65536,maximumFactPayloadBytes:65536,fetchImpl:async (_url: Parameters<import('../../../../packages/collectors/src/types.js').FetchLike>[0],init: Parameters<import('../../../../packages/collectors/src/types.js').FetchLike>[1]) => {
        httpCalls++;
        if(scenario==='loader_cancel')await new Promise<never>((_,reject)=>{
          const signal=init?.signal;
          if(signal?.aborted)reject(new Error('fixture_cancelled'));
          else signal?.addEventListener('abort',()=>reject(new Error('fixture_cancelled')),{once:true});
        });
        if(['loader_401','loader_403','loader_429'].includes(scenario))return new Response('fixture-private-body',
          {status:Number(scenario.slice(-3)),headers:{'retry-after':'1'}});
        const marketCap = scenario === 'fdv_only' ? null : scenario === 'source_snapshot_conflict' && httpCalls>1 ? '100001' : '100000';
        return new Response(JSON.stringify({status:1,data:{token:{token,chain:'solana',market_cap:marketCap,fdv:'900000',tvl:'100',updated_at:(nowBase-10000)/1000},
          pairs:[{pair:poolAddress,chain:'solana',target_token:token,token0_address:token,token1_address:quote,amm:'fixture-only-amm'}]}}),{headers:{'content-type':'application/json'}});
      }}});
    const client = createAveMarketClient({guardedFetch:adapters.fetch,apiKey:'fixture-only-not-a-real-key',deadlineAtMs:Date.now()+20000,maximumRequests:4,maximumResponseBytes:65536});
    const mapping = {chain:'solana' as const,tokenAddress:token,poolAddress,tokenSide:'base' as const,network:'solana',evidenceRef:'fixture-only-pool-map',knownAt:activatedAt};
    const binding = {mapping,providerId:'fixture-ave',quoteAddress:quote,mappingApprovalRef:'fixture-only-map-approval',sourceApprovalRef:'fixture-only-source-approval',
      sourceProofKind:'approved_reported_market_cap_v1' as const,candleMs:0 as const,validFrom:activatedAt,validUntil:nowBase+600000};
    const shortApproval = scenario.includes('expired_') || scenario.includes('expiry_') || scenario==='dedicated_overlong_signature_ttl';
    const document:ReportedMarketApprovalDocument = {
      protocol:'address-only-reported-market-cap-approval-v1',importId:'fixture-dedicated-reported',approvalRef:'fixture-only-dedicated-review',
      authorizationRef:'fixture-only-reported-approval',target:{database:input.database,schema,generationId,systemIdentifier:identity.system_identifier,
        serverAddress:'127.0.0.1',serverPort:5432,schemaVersion:plan.version,schemaFingerprint:plan.fingerprint},
      validator:{validatorId:'fixture-validator',keyId:'fixture-ed25519',actorId:'fixture-validator-actor',publicKey},
      source:{providerId:binding.providerId,origin:'https://prod.ave-api.com',protocol:'ave_token_market_cap_v1',sourceApprovalRef:binding.sourceApprovalRef},
      mapping,mappingFingerprint:postgresServiceFactFingerprint(mapping),mappingApprovalRef:binding.mappingApprovalRef,quoteAddress:quote,
      quality:'reported',sourceProofKind:binding.sourceProofKind,reviewer:{actorId:'fixture-only-reviewer',evidenceSha256:'c'.repeat(64),
        reviewedAt:activatedAt,conflictVerdict:'none_observed'},approvedAt:activatedAt,validFrom:activatedAt,
      validUntil:shortApproval?nowBase+1000:binding.validUntil,
    };
    const revocation={approvalRef:'fixture-only-revocation',revokedAt:nowBase};
    function migration(revoking:boolean, failAuthorization=false):PostgresMigrationRuntimeOptions{
      const native=new Pool({connectionString:connectionString(roles.migrator),max:1,connectionTimeoutMillis:2000,query_timeout:3000});
      native.on('error',()=>{});
      const {generationId: generation,...target}=document.target;
      const fingerprint=revoking?reportedMarketApprovalRevocationFingerprint(document,revocation):reportedMarketApprovalFingerprint(document);
      let authorizations=0;
      return {pool:{async connect(){const conn=await native.connect();return{
        async query(sql:string,values?:unknown[]){assert.doesNotMatch(sql,/\bSET\s+(LOCAL\s+)?ROLE\b/i);
          const result=await conn.query(sql,values);const last=Array.isArray(result)?result[result.length-1]!:result;
          await migrationHook?.(sql);
          if(sql==='COMMIT'&&migrationCommitFault){migrationCommitFault=false;throw new Error('fixture_only_lost_revoke_ack');}
          return{rows:last.rows,rowCount:last.rowCount};},release(error?:Error){conn.release(error);}};},end:()=>native.end()},
        target:{...target,generation,username:roles.migrator,service:'migrator'},
        capability:{mode:'isolated',purpose:'business_import',approvalRef:revoking?revocation.approvalRef:document.approvalRef,
          planSha256:fingerprint,expiresAtMs:nowBase+600000},clock:now,
        assertAuthorized:async request=>{assert.equal(request.capability.mode,'isolated');assert.equal(request.capability.planSha256,fingerprint);
          assert.equal(request.target.username,roles.migrator);if(failAuthorization&&++authorizations===2)throw new Error('fixture_only_authorization_lost');},
        limits:{operationTimeoutMs:5000,connectionTimeoutMs:1000,statementTimeoutMs:3000,lockTimeoutMs:1000,
          maximumSqlStatements:64,workMemKb:1024,closeTimeoutMs:1000}};
    }
    phase='dedicated_import';
    assert.equal((await importReportedMarketApproval(document,migration(false))).status,'imported');
    assert.equal((await importReportedMarketApproval(document,migration(false))).status,'existing');
    const reader=createPostgresReportedMarketApprovalReader({pin:{path:'/fixture-only/reported-approval.json',sha256:'e'.repeat(64)},
      target:document.target,run:runtime.run,now,read:async()=>structuredClone(document)});
    let approval: PostgresReportedMarketCapApproval = {approvalRef:'fixture-only-reported-approval',generationId,validatorId:'fixture-validator',keyId:'fixture-ed25519',
      actorId:'fixture-validator-actor',providerId:binding.providerId,mappingApprovalRef:binding.mappingApprovalRef,sourceApprovalRef:binding.sourceApprovalRef,
      mappingFingerprint:postgresServiceFactFingerprint(mapping),quoteAddress:quote,sourceProofKind:binding.sourceProofKind,quality:'reported',
      conflictState:'none_observed',validFrom:activatedAt,validUntil:nowBase+600000,revokedAt:null};
    if (scenario==='conflicting_approval') approval={...approval,conflictState:'conflict'};
    // Deliberately malformed authority returned by the test approval reader, not a valid reported approval.
    if (scenario==='candle_only_approval') approval={...approval,
      sourceProofKind:'independent_gecko_ohlcv_replay_v1' as PostgresReportedMarketCapApproval['sourceProofKind']};
    if (scenario==='revoked_approval') approval={...approval,revokedAt:nowBase-1};
    if (scenario==='expired_approval') approval={...approval,validUntil:nowBase};
    if (scenario==='wrong_approval_provider') approval={...approval,providerId:'other-fixture'};
    if (scenario==='wrong_approval_mapping') approval={...approval,mappingFingerprint:'f'.repeat(64)};
    const producer = createPostgresReportedMarketCapProducer({generationId,activatedAt,providerId:binding.providerId,sourceApprovalRef:binding.sourceApprovalRef,
      identity:{chain:'solana',token,pool:poolAddress,quote},client,maximumRunMs:3000,maximumPayloadBytes:65536,maximumWindowMs:120000,maximumMappingAgeMs:120000,now});
    const validator = createPostgresReportedMarketCapValidator({generationId,activatedAt,validatorId:approval.validatorId,keyId:approval.keyId,
      actorId:approval.actorId,authorizationRef:approval.approvalRef,publicKey,signingKey:{loadPrivateKey:()=>keys.privateKey},client,bindings:[binding],now,
      maximumRunMs:3000,maximumPayloadBytes:65536,maximumCandidateAgeMs:120000,maximumMappingAgeMs:120000,maximumWindowMs:120000,validationTtlMs:30000,
      ...(scenario==='missing_approval'?{}:{approval:{authorizeReportedMarketCap:async request=>{
        const result=await reader.authorizeReportedMarketCap(request);
        if(result.status!=='approved')return result;
        // Original negative cases alter the approval reader's result, never the actual SQL response.
        return{status:'approved' as const,approval:{...result.approval,
          ...(scenario==='candle_only_approval'?{sourceProofKind:approval.sourceProofKind}:{}),
          ...(scenario==='conflicting_approval'?{conflictState:approval.conflictState}:{}),
          ...(scenario==='revoked_approval'?{revokedAt:approval.revokedAt}:{}),
          ...(scenario==='expired_approval'?{validUntil:approval.validUntil}:{}),
          ...(scenario==='wrong_approval_provider'?{providerId:approval.providerId}:{}),
          ...(scenario==='wrong_approval_mapping'?{mappingFingerprint:approval.mappingFingerprint}:{})}};
      }}})});
    function unitOfWork(username: string) {
      const pool = new Pool({connectionString:connectionString(username),max:1,connectionTimeoutMillis:2000,idleTimeoutMillis:1000,
        options:`-c search_path=${schema},pg_catalog`,query_timeout:3000});
      pool.on('error',()=>{}); pools.push(pool);
      return createPostgresUnitOfWork({async connect(){const conn=await pool.connect();return{
        async query(sql:string,values?:unknown[]){
          assert.doesNotMatch(sql,/\bSET\s+(LOCAL\s+)?ROLE\b/i);
          if (rollbackFault && sql.includes(rollbackFault)) await conn.query('SELECT 1/0');
          const result=await conn.query(sql,values); const last=Array.isArray(result)?result[result.length-1]!:result;
          if(username===publisherRole)await publisherHook?.(sql);
          if(sql==='COMMIT'&&commitFault){commitFault=false;throw new Error('fixture_only_lost_commit_ack');}
          return{rows:last.rows,rowCount:last.rowCount};
        },release(error?:Error){conn.release(error);}};}},{statementTimeoutMs:3000,lockTimeoutMs:1000});
    }
    const publisherOptions = {run:unitOfWork(publisherRole).run,target:{...job.target,username:publisherRole},forbiddenRoles:Object.values(job.forbiddenRoles),
      validators:[{validatorId:approval.validatorId,keyId:approval.keyId,publicKey,actorId:approval.actorId,authorizationRef:approval.approvalRef,reviewedSourceProviders:['fixture-ave']}],
      mappings:[binding],maximumValidationAgeMs:120000,maximumMappingAgeMs:120000,maximumPayloadBytes:65536,maximumCandles:1,maximumWindowMs:120000,
      statementTimeoutMs:3000,lockTimeoutMs:1000,now};
    const counts = async () => {
      const row=(await admin.query(`SELECT (SELECT count(*)::integer FROM wallet_service_fact_inputs) AS facts,
        (SELECT count(*)::integer FROM wallet_service_fact_attestations) AS attestations,
        (SELECT count(*)::integer FROM wallet_forward_signal_wake_intents) AS wakes,
        (SELECT count(*)::integer FROM forward_token_market_inputs) AS markets,
        (SELECT count(*)::integer FROM forward_token_milestone_hits) AS milestones,
        (SELECT count(*)::integer FROM wallet_service_price_consumption) AS consumed`)).rows[0];
      return row as Record<string,number>;
    };
    const empty={facts:0,attestations:0,wakes:0,markets:0,milestones:0,consumed:0};
    const publishedOnly={...empty,facts:1,attestations:1,wakes:1};
    const consumedAll={facts:1,attestations:1,wakes:1,markets:1,milestones:1,consumed:1};
    const revoke=()=>revokeReportedMarketApproval(document,revocation,migration(true));
    if(scenario.startsWith('loader_')){
      phase='loader_material';
      const put=async(name:string,value:unknown)=>{
        const raw=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
        const path='/authority/'+name;
        await writeFile(path,raw,{mode:0o600,flag:'wx'});
        return {path,sha256:createHash('sha256').update(raw).digest('hex')};
      };
      const providerRow=(await admin.query(`SELECT b.*,l.source_fingerprint FROM wallet_service_provider_budgets b
        JOIN wallet_service_import_ledger l USING(generation_id,import_id)`)).rows[0];
      const validatorRow=(await admin.query(`SELECT v.*,l.source_fingerprint FROM wallet_service_fact_validators v
        JOIN wallet_service_import_ledger l USING(generation_id,import_id)`)).rows[0];
      const approvalPin=await put('approval.json',document),releaseSha='f'.repeat(64);
      const material:ReportedPriceCliMaterial={protocol:'address-only-cli-reported-price-authority-v1',operationId:'fixture-operation',
        generationId,releaseSha256:releaseSha,username:publisherRole,migrationRole:roles.migrator,approval:approvalPin,
        credential:await put('credential.json',{connectionString:connectionString(scenario==='loader_credential'?roles.scanner:publisherRole),
          username:publisherRole,service:'price-publisher',gatewayDeliveryEnabled:false}),
        privateKey:await put('key.pem',Buffer.from((scenario==='loader_key'?generateKeyPairSync('ed25519').privateKey:keys.privateKey).export({type:'pkcs8',format:'pem'}))),
        apiCredential:await put('api.json',{providerId:binding.providerId,origin:document.source.origin,apiKey:'fixture-only-not-a-real-key'}),
        providerContract:{providerId:binding.providerId,origin:document.source.origin,importId:providerRow.import_id,sourceFingerprint:providerRow.source_fingerprint,
          windowMs:Number(providerRow.window_ms),maximumRequests:Number(providerRow.maximum_requests),maximumConcurrency:Number(providerRow.maximum_concurrency)},
        validatorContract:{validatorId:document.validator.validatorId,importId:validatorRow.import_id,sourceFingerprint:validatorRow.source_fingerprint},
        validator:{maximumRunMs:3000,maximumPayloadBytes:65536,maximumCandidateAgeMs:120000,maximumMappingAgeMs:120000,maximumWindowMs:120000,validationTtlMs:30000},
        publisher:{maximumValidationAgeMs:30000,maximumPayloadBytes:65536,statementTimeoutMs:3000,lockTimeoutMs:1000,maximumCandles:1,maximumWindowMs:120000,maximumMappingAgeMs:120000},
        transport:{maximumRequestsPerAcquisition:1,maximumResponseBytes:65536,timeoutMs:2000}};
      const materialPin=await put('material.json',material);
      const config={operationId:'fixture-operation',generationId,activatedAt,database:input.database,schema,
        cutover:{addressOnly:{target:job.target,releaseSha256:releaseSha}},
        driver:{schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,statementTimeoutMs:3000,lockTimeoutMs:1000,shutdownTimeoutMs:3000,
          serverMaximumConnections:100,reservedConnections:5,serviceConnectionBudgets:{...Object.fromEntries(Object.keys(serviceRoles).map(k=>[k,1])),'price-publisher':1}},
        services:Object.fromEntries(Object.entries(serviceRoles).map(([name,username])=>[name,{username,maximumConnections:1,intervalMs:1000}])),
        sources:{maximumResponseBytes:65536,providerTimeoutMs:2000},
        priceAcquisition:{protocol:'approved_reported_market_cap_v1',approval:approvalPin,
          source:{providerId:binding.providerId,baseUrl:document.source.origin,sourceApprovalRef:binding.sourceApprovalRef,
            maximumRunMs:3000,maximumPayloadBytes:65536,maximumWindowMs:120000,maximumMappingAgeMs:120000},
          receiver:{maximumCandidates:1,maximumRunMs:3000,maximumPayloadBytes:65536},mappings:[binding],
          retry:{maximumSamples:1,maximumRetryEntries:1,maximumMappings:1,maximumPayloadBytes:65536,maximumRunMs:3000,retryDelayMs:1000}}} as unknown as ConfiguredPostgresServiceDeployment;
      if(scenario==='loader_generation')Object.assign(config,{generationId:'fixture-wrong-generation'});
      if(scenario==='loader_cluster')Object.assign(config.cutover.addressOnly!.target,{systemIdentifier:'123'});
      if(scenario==='loader_allocation')Reflect.deleteProperty(config.driver.serviceConnectionBudgets,'price-publisher');
      if(scenario==='loader_material_mode')await chmod(material.privateKey.path,0o644);
      if(scenario==='loader_material_symlink'){
        await rename(material.privateKey.path,material.privateKey.path+'.original');
        await symlink(material.privateKey.path+'.original',material.privateKey.path);
      }
      if(scenario==='loader_provider_scope')await admin.query('UPDATE wallet_service_import_ledger SET proof_scope=$1 WHERE import_id=$2',['validator_authority',providerRow.import_id]);
      if(scenario==='loader_validator_scope')await admin.query('UPDATE wallet_service_import_ledger SET proof_scope=$1 WHERE import_id=$2',['provider_contract',validatorRow.import_id]);
      if(scenario==='loader_scope')await admin.query('UPDATE wallet_service_import_ledger SET proof_scope=$1 WHERE import_id=$2',['validator_authority',document.importId]);
      if(scenario==='loader_provider_revoke')await admin.query('UPDATE wallet_service_import_ledger SET revoked_at=$1 WHERE import_id=$2',[clock,providerRow.import_id]);
      if(scenario==='loader_validator_revoke')await admin.query('UPDATE wallet_service_fact_validators SET revoked_at=$1',[clock]);
      if(scenario==='loader_identity')await admin.query('UPDATE business_schema_identity SET generation_id=$1',['fixture-wrong-generation']);
      const controller=new AbortController();
      const load=()=>createPostgresCliReportedPriceAuthority({config,env:{ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_FILE:materialPin.path,
        ADDRESS_RADAR_POSTGRES_REPORTED_PRICE_AUTHORITY_SHA256:materialPin.sha256,ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:releaseSha},facts:adapters,signal:controller.signal},{now});
      const invalid=['loader_scope','loader_generation','loader_cluster','loader_credential','loader_key','loader_allocation','loader_provider_revoke','loader_validator_revoke','loader_identity','loader_material_mode','loader_material_symlink','loader_provider_scope','loader_validator_scope'].includes(scenario);
      if(invalid){
        phase='loader_invalid_material';
        await assert.rejects(load,(error:unknown)=>{
          assert.equal((error as Error).message,'reported_price_cli:material_or_authority_refused');return true;
        });
        assert.equal(httpCalls,0);assert.deepEqual(await counts(),empty);
      }else{
        phase='loader_startup';const loaded=await load();
        try{
          assert.equal(httpCalls,0);
          assert.doesNotMatch(JSON.stringify(loaded.native),/fixture-only-not-a-real-key|PRIVATE KEY/);
          assert.ok(!JSON.stringify(loaded.native).includes(rolePassword));
          phase='loader_compose';
          const composed=await composePostgresServicePriceDependencies({service:'scanner',deployment:config,
            dependencies:{nativeReportedMarketCapAuthority:loaded.native},signal:controller.signal});
          const authority=composed.priceAuthority!;
          assert.ok(authority.validator);assert.ok(authority.publisher);
          const pricePublisher=authority.publisher;
          await loaded.native.publisher.run(async tx=>{
            const row=(await tx.query('SELECT current_user,session_user')).rows[0]!;
            assert.equal(row.current_user,publisherRole);assert.equal(row.session_user,publisherRole);
          });
          await assert.rejects(()=>loaded.native.publisher.run(tx=>tx.query('UPDATE wallet_service_import_ledger SET revoked_at=0 WHERE false')),
            (error:unknown)=>(error as {code?:string}).code==='42501');
          if(scenario==='loader_material_drift')await writeFile(material.apiCredential.path,'fixture-only-changed',{mode:0o600});
          if(['loader_401','loader_403','loader_429','loader_cancel','loader_budget_window','loader_material_drift'].includes(scenario)){
            if(scenario==='loader_budget_window')await admin.query('UPDATE wallet_service_provider_budgets SET requests_used=maximum_requests');
            phase='loader_transport_stop';
            const request=loaded.native.validator.client.tokenDetail({chain:'solana',token,pool:poolAddress,quote},controller.signal);
            if(scenario==='loader_cancel'){
              let started=false;
              for(let i=0;i<80;i++){
                if(Number(httpCalls)===1){started=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
              }assert.equal(started,true);controller.abort();
            }
            const first=await request;assert.equal(first.status,'deferred');
            if(first.status==='deferred')assert.equal(first.reason,scenario==='loader_429'?'rate_limited':
              scenario==='loader_401'||scenario==='loader_403'?'unauthorized':'transport_failure');
            if(scenario!=='loader_cancel'){
              const second=await loaded.native.validator.client.tokenDetail({chain:'solana',token,pool:poolAddress,quote});
              assert.deepEqual(second,first);
            }
            assert.equal(httpCalls,scenario==='loader_budget_window'||scenario==='loader_material_drift'?0:1);
            if(scenario==='loader_429')assert.ok(Number((await admin.query('SELECT cooldown_until FROM wallet_service_provider_budgets')).rows[0].cooldown_until)>clock);
            assert.deepEqual(await counts(),empty);
          }else{
            const realProducer=createPostgresReportedMarketCapProducer({generationId,activatedAt,providerId:binding.providerId,sourceApprovalRef:binding.sourceApprovalRef,
              identity:{chain:'solana',token,pool:poolAddress,quote},client:loaded.native.validator.client,maximumRunMs:3000,maximumPayloadBytes:65536,
              maximumWindowMs:120000,maximumMappingAgeMs:120000,now});
            phase='loader_acquire';const acquired=await realProducer.acquire({generationId,sampleId:'fixture-sample',executionFingerprint:fingerprint,
              boughtAt,until:nowBase,mapping,signal:controller.signal});
            assert.equal(acquired.status,'acquired');if(acquired.status!=='acquired')throw Error('fixture_expected_acquired');
            phase='loader_validate';const checked=await authority.validator.validatePrice({candidate:acquired.candidate,signal:controller.signal});
            assert.equal(checked.status,'verified');if(checked.status!=='verified')throw Error('fixture_expected_verified');
            const publication={candidate:acquired.candidate,validation:checked.validation,signal:controller.signal};
            phase='loader_publish';
            if(scenario==='loader_revoke_publish'){
              await revoke();await assert.rejects(()=>pricePublisher.publish(publication));assert.deepEqual(await counts(),empty);
            }else{
              await pricePublisher.publish(publication);assert.deepEqual(await counts(),publishedOnly);
              if(scenario==='loader_revoke_consume')await revoke();
              phase='loader_consume';const batch=await adapters.facts.prices({generationId,asOf:clock,limit:1,signal:controller.signal});
              if(scenario==='loader_revoke_consume'){
                assert.ok(batch.status==='deferred'||batch.markets.length===0);assert.deepEqual(await counts(),publishedOnly);
              }else{
                assert.equal(batch.status,'available');if(batch.status!=='available')throw Error('fixture_expected_available');
                await runtime!.run(tx=>receivePostgresProductionPriceBatch(tx,{generationId,asOf:clock,limit:1,batch,now}));
                assert.deepEqual(await counts(),consumedAll);
                const stored=JSON.parse((await admin.query('SELECT payload FROM wallet_service_fact_inputs')).rows[0].payload);
                assert.equal(stored.market.quality,'reported');assert.equal(stored.market.marketCapUsd,'100000');
                assert.equal(stored.market.fdvUsd,'900000');assert.equal(stored.market.independence,'unverified');
              }
            }
          }
        }finally{await loaded.close();await loaded.close();}
      }
      phase='loader_cleanup_assert';
      assert.equal(Number((await admin.query('SELECT count(*) AS n FROM wallet_service_provider_leases WHERE released_at IS NULL')).rows[0].n),0);
      assert.equal((await admin.query('SELECT requests_used FROM wallet_service_provider_budgets')).rows[0].requests_used,
        scenario==='loader_budget_window'?60:httpCalls);
      assert.equal(Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2',[input.database,publisherRole])).rows[0].n),0);
      assert.equal(externalRequests,0);assert.ok(httpCalls<=2);
      return {status:'passed',scenario,fixtureOnly:true,productionAuthorityProven:false,externalRequests,setRoleUsed:false};
    }

    function gate(){let open!:()=>void,arrived!:()=>void;const reached=new Promise<void>(resolve=>{arrived=resolve;});
      const released=new Promise<void>(resolve=>{open=resolve;});return{reached,open,async wait(){arrived();let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([released,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture_gate_deadline')),800);})]);}
        finally{clearTimeout(timer);}}};}
    async function blocked(username:string){
      for(let i=0;i<30;i++){
        const row=(await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          WHERE a.datname=$1 AND a.usename=$2 AND l.locktype='advisory' AND NOT l.granted) AS waiting`,[input.database,username])).rows[0];
        if(row.waiting===true)return;await new Promise(resolve=>setTimeout(resolve,5));
      }throw new Error('fixture_expected_advisory_wait');
    }
    phase = 'publisher_identity';
    if(scenario.startsWith('role_')){
      const wrongRole=roles[scenario.slice(5) as keyof typeof roles];assert.ok(wrongRole);
      const wrong=wrongRole===roles.scanner?runtime:unitOfWork(wrongRole);
      await wrong.run(async tx=>{const row=(await tx.query('SELECT current_user AS username,session_user AS session_username')).rows[0]!;
        assert.equal(row.username,wrongRole);assert.equal(row.session_username,wrongRole);});
      await assert.rejects(()=>createPostgresPriceFactPublisher({...publisherOptions,run:wrong.run}));
      assert.deepEqual(await counts(),empty);
    }else if(scenario==='acl_drift'){
      await admin.query(`GRANT UPDATE ON forward_purchase_samples TO ${identifier(publisherRole)}`);
      await assert.rejects(()=>provisionRuntimeAuthority(job,credential,authorityClient,{now}));
      await assert.rejects(()=>createPostgresPriceFactPublisher(publisherOptions));
      assert.deepEqual(await counts(),empty);
    }else{
      const publisher=await createPostgresPriceFactPublisher(publisherOptions);
      phase='acquire';
      const acquired=await producer.acquire({generationId,sampleId:'fixture-sample',executionFingerprint:fingerprint,boughtAt,until:nowBase,mapping,signal:new AbortController().signal});
      if(scenario==='fdv_only'){assert.equal(acquired.status,'deferred');assert.deepEqual(await counts(),empty);}
      else{
        assert.equal(acquired.status,'acquired');if(acquired.status!=='acquired')throw new Error('fixture_acquisition_failed');
        phase='validate';const validated=await validator.validatePrice({candidate:acquired.candidate,signal:new AbortController().signal});
        if(['missing_approval','candle_only_approval','conflicting_approval','revoked_approval','expired_approval','wrong_approval_provider','wrong_approval_mapping','source_snapshot_conflict'].includes(scenario)){
          assert.equal(validated.status,'deferred');assert.deepEqual(await counts(),empty);
        }else{
          assert.equal(validated.status,'verified');if(validated.status!=='verified')throw new Error('fixture_validation_failed');
          if(scenario==='pending_revision')await admin.query("UPDATE forward_trade_revisions SET state='pending_review'");
          if(scenario==='wrong_revision'){
            await admin.query(`INSERT INTO forward_trade_revisions SELECT
              (jsonb_populate_record(NULL::forward_trade_revisions,to_jsonb(r)||jsonb_build_object('fingerprint',$1::text))).*
              FROM forward_trade_revisions r`,['f'.repeat(64)]);
            await admin.query('UPDATE forward_purchase_samples SET execution_fingerprint=$1',['f'.repeat(64)]);
          }
          if(scenario==='expired_sample')await admin.query('UPDATE forward_purchase_samples SET expires_at=$1',[nowBase-1]);
          if(scenario==='expired_signature')clock=nowBase+30001;
          if(scenario==='revoked_validator')await admin.query('UPDATE wallet_service_fact_validators SET revoked_at=$1',[nowBase]);
          if(scenario==='rollback_attestation')rollbackFault='INSERT INTO wallet_service_fact_attestations';
          if(scenario==='rollback_wake')rollbackFault='INSERT INTO wallet_forward_signal_wake_intents';
          if(scenario==='commit_ack_unknown')commitFault=true;
          const publication={candidate:acquired.candidate,validation:validated.validation,signal:new AbortController().signal};
          phase='publish';
          if(scenario.startsWith('dedicated_')){
            phase=scenario;
            const signedExpiry=validated.validation.claims.expiresAt;
            const publish=()=>publisher.publish(publication);
            const batch=()=>adapters.facts.prices({generationId,asOf:clock,limit:1,signal:new AbortController().signal});
            type Batch=Extract<Awaited<ReturnType<typeof batch>>,{status:'available'}>;
            const consume=(value:Batch,hook?:((sql:string)=>Promise<void>))=>runtime!.run(tx=>receivePostgresProductionPriceBatch({
              async query(sql,values){const result=await tx.query(sql,values);await hook?.(sql);return result;}
            },{generationId,asOf:clock,limit:1,batch:value,now}));
            const available=async()=>{const value=await batch();assert.equal(value.status,'available');
              if(value.status!=='available')throw new Error('fixture_expected_available');assert.equal(value.markets.length,1);return value;};
            const rejectedRead=async()=>{const value=await batch();assert.ok(value.status==='deferred'||value.markets.length===0);
              assert.deepEqual(await counts(),publishedOnly);};
            const revoked=async()=>{assert.equal((await revoke()).status,'revoked');assert.ok(clock<signedExpiry);};
            const expiry=()=>{clock=document.validUntil+1;};
            // The current signer clips TTL to approval expiry. This legacy/fault envelope deliberately exceeds it.
            // Only the isolated fixture administrator may seed it to test the consumer's independent defense.
            async function legacyOverlongFact(){
              assert.equal(signedExpiry,document.validUntil);
              const row=(await admin.query('SELECT payload FROM wallet_service_fact_inputs')).rows[0];const payload=JSON.parse(row.payload);
              payload.validation.claims.expiresAt=nowBase+30000;
              payload.validation.signature=sign(null,priceValidationSigningPayload(payload.validation.claims),keys.privateKey).toString('base64');
              const raw=JSON.stringify(payload),hash=postgresServiceFactFingerprint(payload);
              await admin.query('UPDATE wallet_service_fact_inputs SET payload=$1,fingerprint=$2',[raw,hash]);
              await admin.query('UPDATE wallet_service_fact_attestations SET fingerprint=$1,expires_at=$2',[hash,nowBase+30000]);
            }
            if(scenario==='dedicated_pg_control_acl'){
              for(const username of Object.values(serviceRoles)){
                if(username===roles.scanner){
                  await runtime!.run(async tx=>{
                    const row=(await tx.query('SELECT current_user,session_user,system_identifier::text FROM pg_catalog.pg_control_system()')).rows[0]!;
                    assert.equal(row.current_user,username);assert.equal(row.session_user,username);
                    assert.equal(row.system_identifier,document.target.systemIdentifier);
                  });
                  continue;
                }
                const login = new Client({connectionString:connectionString(username),connectionTimeoutMillis:2000,query_timeout:3000});
                try { await login.connect();
                  const row=(await login.query('SELECT current_user,session_user,system_identifier::text FROM pg_catalog.pg_control_system()')).rows[0];
                  assert.equal(row.current_user,username);assert.equal(row.session_user,username);
                  assert.equal(row.system_identifier,document.target.systemIdentifier);
                } finally { await login.end(); }
              }
              phase='control_acl_publish';await publish();
              phase='control_acl_revoke';await admin.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM ${identifier(roles.scanner)}`);
              phase='control_acl_reader_reject';await assert.rejects(()=>verifyReportedMarketApprovalConfiguration({pin:{path:'/fixture/approval.json',sha256:'a'.repeat(64)},
                target:document.target,run:runtime!.run,now,read:async()=>document}));
              phase='control_acl_consumer_reject';await rejectedRead();assert.deepEqual(await counts(),publishedOnly);
              phase='control_acl_restore';await admin.query(identityGrants[0]!);
              await verifyReportedMarketApprovalConfiguration({pin:{path:'/fixture/approval.json',sha256:'a'.repeat(64)},
                target:document.target,run:runtime!.run,now,read:async()=>document});
              phase='control_acl_consumer_restored';await available();assert.deepEqual(await counts(),publishedOnly);
            }else if(scenario==='dedicated_acl'){
              for(const run of [publisherOptions.run,runtime.run])await assert.rejects(()=>run(tx=>tx.query(
                'UPDATE wallet_service_import_ledger SET revoked_at=0 WHERE false')),(error:unknown)=>(error as {code?:string}).code==='42501');
              assert.deepEqual(await counts(),empty);
            }else if(['dedicated_revoke_before_publish','dedicated_scope_drift','dedicated_fingerprint_drift','dedicated_identity_drift','dedicated_revoke_commit_unknown'].includes(scenario)){
              if(scenario==='dedicated_revoke_before_publish')await revoked();
              if(scenario==='dedicated_scope_drift')await admin.query('UPDATE wallet_service_import_ledger SET proof_scope=$1 WHERE import_id=$2',['provider_contract',document.importId]);
              if(scenario==='dedicated_fingerprint_drift')await admin.query('UPDATE wallet_service_import_ledger SET source_fingerprint=$1 WHERE import_id=$2',['f'.repeat(64),document.importId]);
              if(scenario==='dedicated_identity_drift')await admin.query('UPDATE business_schema_identity SET generation_id=$1',['fixture-other-generation']);
              if(scenario==='dedicated_revoke_commit_unknown'){migrationCommitFault=true;await assert.rejects(revoke,PostgresCommitUncertainError);
                assert.equal(Number((await admin.query('SELECT revoked_at FROM wallet_service_import_ledger WHERE import_id=$1',[document.importId])).rows[0].revoked_at),nowBase);}
              await assert.rejects(publish);assert.deepEqual(await counts(),empty);
            }else if(scenario==='dedicated_overlong_signature_ttl'||scenario==='dedicated_expired_before_publish'){
              assert.equal(signedExpiry,document.validUntil);
              const claims={...publication.validation.claims,expiresAt:nowBase+30000};
              const value={...publication,validation:{...publication.validation,claims,
                signature:sign(null,priceValidationSigningPayload(claims),keys.privateKey).toString('base64')}};
              if(scenario==='dedicated_expired_before_publish')expiry();assert.ok(clock<claims.expiresAt);
              await assert.rejects(()=>publisher.publish(value));assert.deepEqual(await counts(),empty);
            }else if(scenario==='dedicated_publish_expiry_rollback'){
              publisherHook=async sql=>{if(sql.includes('INSERT INTO wallet_forward_signal_wake_intents'))expiry();};
              await assert.rejects(publish);assert.deepEqual(await counts(),empty);
            }else if(scenario==='dedicated_revoke_rollback'){
              await assert.rejects(()=>revokeReportedMarketApproval(document,revocation,migration(true,true)));
              assert.equal((await admin.query('SELECT revoked_at FROM wallet_service_import_ledger WHERE import_id=$1',[document.importId])).rows[0].revoked_at,null);
              assert.equal((await publish()).status,'published');await consume(await available());assert.deepEqual(await counts(),consumedAll);
            }else if(scenario==='dedicated_revoke_blocks_publish'||scenario==='dedicated_revoke_blocks_ack'){
              let value:Batch|undefined;
              if(scenario==='dedicated_revoke_blocks_ack'){await publish();value=await available();}
              const held=gate();migrationHook=async sql=>{if(sql.includes('reported-approval-revoke */'))await held.wait();};
              const pendingRevoke=revoke();void pendingRevoke.catch(()=>{});
              try{await held.reached;const action=value?consume(value):publish();void action.catch(()=>{});
                try{await blocked(value?roles.scanner:publisherRole);}finally{held.open();}
                assert.equal((await pendingRevoke).status,'revoked');await assert.rejects(()=>action);
              }finally{held.open();await pendingRevoke.catch(()=>{});migrationHook=undefined;}
              assert.deepEqual(await counts(),value?publishedOnly:empty);
            }else if(scenario==='dedicated_publish_blocks_revoke'||scenario==='dedicated_ack_blocks_revoke'){
              const held=gate();let action:Promise<unknown>;
              if(scenario==='dedicated_publish_blocks_revoke'){
                let first=true;publisherHook=async sql=>{if(first&&sql.includes('reported-approval-transaction')){first=false;await held.wait();}};action=publish();
              }else{await publish();const value=await available();let first=true;
                action=consume(value,async sql=>{if(first&&sql.includes('reported-approval-transaction')){first=false;await held.wait();}});}
              void action.catch(()=>{});
              try{await held.reached;const pendingRevoke=revoke();void pendingRevoke.catch(()=>{});
                try{await blocked(roles.migrator);}finally{held.open();}
                await action;assert.equal((await pendingRevoke).status,'revoked');
              }finally{held.open();await action.catch(()=>{});publisherHook=undefined;}
              assert.deepEqual(await counts(),scenario==='dedicated_ack_blocks_revoke'?consumedAll:publishedOnly);
              if(scenario==='dedicated_publish_blocks_revoke')await rejectedRead();
            }else{
              assert.equal((await publish()).status,'published');
              if(scenario.includes('expired_')||scenario==='dedicated_ack_expiry_rollback')await legacyOverlongFact();
              if(scenario.endsWith('before_read')){
                if(scenario.includes('revoke'))await revoked();else expiry();
                if(scenario.includes('expired'))assert.ok(clock<nowBase+30000);await rejectedRead();
              }else{
                const value=await available();
                if(scenario==='dedicated_revoke_before_ack')await revoked();
                if(scenario==='dedicated_expired_before_ack'){expiry();assert.ok(clock<nowBase+30000);}
                await assert.rejects(()=>consume(value,async sql=>{
                  if(scenario==='dedicated_ack_expiry_rollback'&&sql.includes('INSERT INTO forward_token_milestone_hits'))expiry();
                }));assert.deepEqual(await counts(),publishedOnly);
              }
            }
          }else if(scenario.startsWith('rollback_')&&scenario!=='rollback_consumer'||scenario==='expired_signature'){
            await assert.rejects(()=>publisher.publish(publication));assert.deepEqual(await counts(),empty);
          }else if(scenario==='commit_ack_unknown'){
            await assert.rejects(()=>publisher.publish(publication),PostgresCommitUncertainError);
            assert.deepEqual(await counts(),{...empty,facts:1,attestations:1,wakes:1});
          }else{
            const result=await publisher.publish(publication);
            if(['pending_revision','wrong_revision','expired_sample','revoked_validator'].includes(scenario)){
              assert.equal(result.status,'deferred');assert.deepEqual(await counts(),empty);
            }else{
              assert.equal(result.status,'published');assert.deepEqual(await counts(),{...empty,facts:1,attestations:1,wakes:1});
              const payload=JSON.parse((await admin.query('SELECT payload FROM wallet_service_fact_inputs')).rows[0].payload);
              assert.equal(payload.market.marketCapUsd,'100000');assert.equal(payload.market.fdvUsd,'900000');assert.equal(payload.market.quality,'reported');
              assert.equal(payload.market.independence,'unverified');assert.equal(payload.market.conflictState,'none_observed');
              assert.equal(payload.market.source.providerId,'fixture-ave');assert.equal(payload.market.source.reportedAt,nowBase-10000);
              assert.equal(payload.validation.sourceProof.rawEvidence.approval.approvalRef,approval.approvalRef);
              phase='consume';
              const batch=await adapters.facts.prices({generationId,asOf:clock,limit:1,signal:new AbortController().signal});
              assert.equal(batch.status,'available');if(batch.status!=='available')throw new Error('fixture_consumer_deferred');
              assert.equal(batch.markets.length,1);assert.equal(batch.peaks.length,0);
              if(scenario==='rollback_consumer'){
                await assert.rejects(()=>runtime!.run(tx=>receivePostgresProductionPriceBatch({query:async(sql,values)=>{
                  if(sql.includes('INSERT INTO forward_token_milestone_hits'))await tx.query('SELECT 1/0');
                  return tx.query(sql,values);
                }} as PostgresTransaction,{generationId,asOf:clock,limit:1,batch,now})));
                assert.deepEqual(await counts(),{...empty,facts:1,attestations:1,wakes:1});
              }else{
                assert.deepEqual(await runtime.run(tx=>receivePostgresProductionPriceBatch(tx,{generationId,asOf:clock,limit:1,batch,now})),{peaks:0,markets:1});
                assert.deepEqual(await counts(),{facts:1,attestations:1,wakes:1,markets:1,milestones:1,consumed:1});
                const hits=(await admin.query('SELECT threshold FROM forward_token_milestone_hits')).rows;assert.deepEqual(hits,[{threshold:100000}]);
                assert.equal(Number((await admin.query('SELECT screening_enabled_at FROM forward_token_watches')).rows[0].screening_enabled_at),nowBase-10000);
                assert.equal((await publisher.publish(publication)).status,'duplicate');
                assert.deepEqual(await counts(),{facts:1,attestations:1,wakes:1,markets:1,milestones:1,consumed:1});
              }
            }
          }
        }
      }
    }
    phase='lease_cleanup';
    assert.equal(Number((await admin.query('SELECT count(*) AS n FROM wallet_service_provider_leases WHERE released_at IS NULL')).rows[0].n),0);
    assert.equal((await admin.query('SELECT requests_used FROM wallet_service_provider_budgets')).rows[0].requests_used,httpCalls);
    assert.equal(externalRequests,0);
    assert.ok(httpCalls<=2);
    return{status:'passed',scenario,fixtureOnly:true,productionAuthorityProven:false,externalRequests,setRoleUsed:false};
  }finally{
    await runtime?.close();for(const pool of pools)await pool.end();
    if(createdSchema)await admin.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
    for(const role of createdRoles.reverse())await admin.query(`DROP OWNED BY ${identifier(role)}; DROP ROLE ${identifier(role)}`);
    await admin.end();
  }
}
const timer=setTimeout(()=>{process.stdout.write(JSON.stringify({status:'failed',phase:'deadline'}));process.exit(1);},30000);
void main().then(result=>{clearTimeout(timer);process.stdout.write(JSON.stringify(result));},error=>{
  clearTimeout(timer);const code=(error as {code?:unknown})?.code;
  process.stdout.write(JSON.stringify({status:'failed',phase,...(typeof code==='string'&&/^[0-9A-Z]{5}$/.test(code)?{sqlstate:code}:{}),
    ...(['ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(String(code))?{transport:code}:{})}));process.exitCode=1;
});
