import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDedicatedImportJob, sanitizedImportFailure, diagnosePreparedPlan, diagnosePreparedMigrationPreconnect, diagnosePreparedMigrationReadonly, fenceMeasureFailure, diagnosePreparedMigrationRollback, withDiagnosticStage, DIAGNOSTIC_COHORT_LOCK_SQL, DIAGNOSTIC_STARTUP_SELECT_SHA256} from '../run-dedicated-address-only-import.mjs';
const pin={path:'/var/lib/address-radar-maintenance-tools/test/input.json',sha256:'a'.repeat(64)};
const fixture=()=>({protocol:'address-only-native-job-v1',operationId:'operation-1',action:'prepare',seed:pin,
  runtimeModule:pin,pgModule:pin,credential:pin,sourceFence:pin,outputDirectory:'/var/lib/address-radar-maintenance-tools/output',
  review:{importId:'import-1',approvalRef:'approved',actorId:'operator',actorAuthorizationRef:'user-approved',
    generationId:'new-generation',importedAt:1,seedSha256:pin.sha256},activatedAt:1,releaseSha256:'b'.repeat(64),
  target:{database:'address_radar',username:'address_radar_migrator',schema:'address_radar_business',generation:'new-generation',
    service:'migration',serverAddress:'127.0.0.1',serverPort:5432,schemaVersion:3,
    schemaFingerprint:'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383',systemIdentifier:'7693392208475083526'},
  budget:{deadlineAtMs:100,maximumTransactionMs:100,maximumQueriesPerTransaction:100,maximumTotalQueries:100,
    maximumTransactions:1,recordsPerTransaction:1,maximumImportLagMs:100},
  limits:{operationTimeoutMs:100,connectionTimeoutMs:10,statementTimeoutMs:100,lockTimeoutMs:10,
    maximumSqlStatements:100,workMemKb:1024,closeTimeoutMs:10}});
test('accepts explicit native address-only preparation without connecting',()=>assert.equal(validateDedicatedImportJob(fixture()).action,'prepare'));
for(const key of ['database','username','schema','systemIdentifier','schemaFingerprint','serverPort'])
  test('refuses changed native target '+key,()=>{const job=fixture();job.target[key]='other';assert.throws(()=>validateDedicatedImportJob(job));});
test('refuses external code paths and unpinned inputs',()=>{for(const path of ['/tmp/code.mjs','/var/lib/address-radar-maintenance-tools/../code.mjs']){const job=fixture();job.runtimeModule={...pin,path};assert.throws(()=>validateDedicatedImportJob(job));}});
test('refuses unknown actions and extra fields',()=>{assert.throws(()=>validateDedicatedImportJob({...fixture(),action:'activate'}));assert.throws(()=>validateDedicatedImportJob({...fixture(),delivery:true}));});
test('refuses changed generation and seed review',()=>{const job=fixture();job.review.generationId='old';assert.throws(()=>validateDedicatedImportJob(job));});

test('diagnostics expose only enum codes, never arbitrary errors or SQL',()=>{
  assert.equal(sanitizedImportFailure(new Error('postgresql://role:secret@host'), 'runtime_execute').diagnostic.code,'unknown_failure');
  assert.equal(sanitizedImportFailure(new Error('PostgreSQL migration rejected: invalid_limits'), 'runtime_execute').diagnostic.code,'runtime_invalid_limits');
  try {validateDedicatedImportJob({});} catch(error) {
    assert.deepEqual(sanitizedImportFailure(error).diagnostic,{stage:'job',code:'job_fields'});
  }
});
test('prepared plan diagnosis has no database or publication ports',async()=>{
  const {createHash}=await import('node:crypto');
  const job=fixture(), rawSeed='{}'; job.seed={...pin,sha256:createHash('sha256').update(rawSeed).digest('hex')};
  job.review.seedSha256=job.seed.sha256;
  let calls=0;
  const result=diagnosePreparedPlan({job,rawSeed,runtime:{
    postgresCohortImportFingerprint:()=> 'review',
    createReviewedPostgresAddressOnlyImportPlan:()=>{calls++;return {planSha256:'c'.repeat(64)};}}});
  assert.equal(calls,1);assert.equal(result.databaseImported,false);assert.equal(result.planSha256,'c'.repeat(64));
});

test('synthetic diagnostic exercises genuine migration/runtime and stops at fake connect',async()=>{
  const {createRequire}=await import('node:module');
  const require=createRequire(import.meta.url);
  const {build}=createRequire(require.resolve('tsx/package.json'))('esbuild');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {pathToFileURL}=await import('node:url');
  const {createHash}=await import('node:crypto');
  const result=await build({stdin:{contents:`export {executeDedicatedAddressOnlyMigration} from './apps/automation/src/postgres-address-only-migration.ts';
export {addressOnlyCohortDigest} from './apps/automation/src/postgres-address-only-startup.ts';`,resolveDir:process.cwd()},
    bundle:true,write:false,platform:'node',format:'esm'});
  const directory=await mkdtemp(join(tmpdir(),'address-only-diagnostic-'));
  try {
    const file=join(directory,'runtime.mjs');await writeFile(file,result.outputFiles[0].text);
    const actual=await import(pathToFileURL(file).href);
    const job=fixture(),rawSeed='{}',now=Date.now();
    job.seed={...pin,sha256:createHash('sha256').update(rawSeed).digest('hex')};job.review.seedSha256=job.seed.sha256;
    job.budget.maximumTransactionMs=60000;job.limits.operationTimeoutMs=60000;
    job.budget.maximumTotalQueries=100;job.budget.maximumQueriesPerTransaction=100;
    const profile={subjectKey:'wallet:solana:owner',entityId:'entity/1',observedAt:now,
      profilePayload:'{}',profile:{fact:{walletFamily:'solana'}}};
    const plan={kind:'cohort_projection',importId:job.review.importId,generationId:job.review.generationId,
      approvalRef:job.review.approvalRef,planSha256:'c'.repeat(64),source:{kind:'address_only_registry',seedSha256:job.seed.sha256},
      profiles:[profile],quarantine:[],grantsBusinessEligibility:false};
    const manifest={protocol:'address-only-v1',operationId:job.operationId,importId:plan.importId,generationId:plan.generationId,
      activatedAt:job.activatedAt,planSha256:plan.planSha256,seedSha256:job.seed.sha256,
      cohortSha256:actual.addressOnlyCohortDigest([{subject_key:profile.subjectKey,entity_id:profile.entityId,
        wallet_family:'solana',profile_payload:'{}',import_id:plan.importId,observed_at:now}]),
      walletCount:1,entityCount:1,releaseSha256:job.releaseSha256,backupSha256:'d'.repeat(64),fenceSha256:'e'.repeat(64),
      target:Object.fromEntries(['database','schema','schemaFingerprint','systemIdentifier','serverAddress','serverPort'].map(key=>[key,job.target[key]])),
      gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false};
    const runtime={...actual,postgresCohortImportFingerprint:()=> 'review',createReviewedPostgresAddressOnlyImportPlan:()=>plan};
    const call=overrides=>diagnosePreparedMigrationPreconnect({job,rawSeed,manifest,runtime,...overrides});
    const reached=await call({});
    assert.equal(reached.status,'diagnostic_preconnect_reached');assert.equal(reached.connectAttempts,1);
    assert.equal(reached.authority,false);assert.equal(reached.databaseConnected,false);assert.equal(reached.sqlExecuted,false);
    const wrong=await call({manifest:{...manifest,planSha256:'f'.repeat(64)}});
    assert.equal(wrong.diagnostic.code,'migration_plan_binding');assert.equal(wrong.connectAttempts,0);
    const badBudget=await call({job:{...job,budget:{...job.budget,maximumTotalQueries:4}}});
    assert.equal(badBudget.diagnostic.code,'migration_budget_binding');assert.equal(badBudget.connectAttempts,0);
    const {EventEmitter}=await import('node:events');
    const makePool=(unsafe=false)=>{
      const sent=[];let ends=0;
      const client=Object.assign(new EventEmitter(),{release:()=>{},query:async(sql)=>{
        sent.push(sql);
        if(sql==='SHOW default_transaction_read_only')return {rows:[{default_transaction_read_only:'on'}]};
        if(sql.includes('migration-runtime-identity'))return {rows:[{
          database:job.target.database,username:job.target.username,session_username:job.target.username,
          server_address:job.target.serverAddress,server_port:job.target.serverPort,system_identifier:job.target.systemIdentifier,
          role_safe:true,no_role_memberships:true,owns_target_schema:true,cannot_create_schema:!unsafe,cannot_create_temp:!unsafe,
          no_other_schema_authority:true,no_other_relation_authority:true,no_other_sequence_authority:true,no_callable_security_definers:true}]};
        if(sql.includes('migration-runtime-ledger-kind'))return {rows:[{identity_valid:true,ledger_valid:true}]};
        if(sql.includes('migration-runtime-ledger'))return {rows:[{database_name:job.target.database,schema_name:job.target.schema,
          generation_id:job.target.generation,ledger_format:1,version:3,fingerprint:job.target.schemaFingerprint}]};
        return {rows:[]};
      }});
      const pool=Object.assign(new EventEmitter(),{connect:async()=>client,end:async()=>{ends++;}});
      return {pool,sent,ends:()=>ends};
    };
    for(const unsafe of [false,true]){
      const pg=makePool(unsafe);
      const read=await diagnosePreparedMigrationReadonly({job,rawSeed,manifest,runtime,pool:pg.pool});
      assert.equal(read.status,unsafe?'diagnostic_rejected':'diagnostic_before_first_write');
      if(unsafe)assert.equal(read.diagnostic.code,'runtime_identity_or_authority_mismatch');
      assert.equal(read.authority,false);assert.equal(read.sqlWritesExecuted,false);assert.equal(pg.ends(),1);
      assert.equal(pg.sent[0],'SET default_transaction_read_only=on');
      assert.equal(pg.sent[1],'SHOW default_transaction_read_only');
      assert.ok(!pg.sent.some(sql=>/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)/i.test(sql)));
    }
    const denied=makePool();
    const malicious={...runtime,executeDedicatedAddressOnlyMigration:async input=>{
      const client=await input.migrationRuntime.pool.connect();
      try {await client.query('SELECT dangerous_function()');}finally{client.release();}
    }};
    const refused=await diagnosePreparedMigrationReadonly({job,rawSeed,manifest,runtime:malicious,pool:denied.pool});
    assert.equal(refused.status,'diagnostic_sql_not_allowlisted');
    assert.ok(!denied.sent.includes('SELECT dangerous_function()'));assert.equal(denied.ends(),1);

  } finally {await rm(directory,{recursive:true,force:true});}
});

test('fence child refusal retains only allowlisted native code',()=>{
  for(const code of ['measurement_phase','source_writer_remains','permission_denied','fomo_process_changed']){
    const error=fenceMeasureFailure({stdout:JSON.stringify({status:'address-only-native-refused',diagnostic:{code},password:'secret'})});
    const value=sanitizedImportFailure(error,'fence_measure');
    assert.equal(value.diagnostic.code,'fence_'+code);assert.ok(!JSON.stringify(value).includes('secret'));
  }
  for(const stdout of ['not json secret',JSON.stringify({status:'address-only-native-refused',diagnostic:{code:'private secret'}}),'x'.repeat(65537)])
    assert.equal(sanitizedImportFailure(fenceMeasureFailure({stdout}),'fence_measure').diagnostic.code,'fence_subprocess_failure');
});

test('diagnostic stage restores success context and retains genuine failure stage',async()=>{
  const context={stage:'runtime_execute'};
  await withDiagnosticStage(context,'fence_measure',async()=>{});
  assert.equal(context.stage,'runtime_execute');
  const later=sanitizedImportFailure(new Error('postgres_cohort_import_query_budget_exceeded'),context.stage);
  assert.equal(later.diagnostic.stage,'runtime_execute');
  assert.ok(!JSON.stringify(sanitizedImportFailure(new Error('postgres_cohort_import_private_password'))).includes('private_password'));
  try{await withDiagnosticStage(context,'fence_measure',async()=>{throw new Error('secret');});}
  catch(error){assert.equal(sanitizedImportFailure(error,context.stage).diagnostic.stage,'fence_measure');}
  assert.equal(context.stage,'runtime_execute');
});

test('rollback-only supplied pool never receives COMMIT and confirms real write rollback',async()=>{
  const {EventEmitter}=await import('node:events');const {createHash}=await import('node:crypto');
  const job=fixture(),rawSeed='{}';job.seed={...pin,sha256:createHash('sha256').update(rawSeed).digest('hex')};
  job.review.seedSha256=job.seed.sha256;
  const plan={approvalRef:job.review.approvalRef,planSha256:'c'.repeat(64)};
  const {readFile}=await import('node:fs/promises');
  const startupSource=await readFile(new URL('../../apps/automation/src/postgres-address-only-startup.ts',import.meta.url),'utf8');
  const startupSql=/tx\.query\(`(WITH\n[\s\S]*?)`,\n\s*\[manifest/.exec(startupSource)[1].replaceAll('${schema}','"address_radar_business"');
  assert.equal(createHash('sha256').update(startupSql).digest('hex'),DIAGNOSTIC_STARTUP_SELECT_SHA256);
  // CTE bodies and final statement are SELECT-only; prohibit future mutating source changes.
  const tokens=startupSql.replace(/'(?:''|[^'])*'/g,"''").replace(/"(?:""|[^"])*"/g,'""');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL)\b/i.test(tokens));
  for(const mode of ['commit','early_failure','rollback_failure','escape','wrong_lock','startup_with','unknown_with']){
    const sent=[];let ends=0,releases=0;
    const client=Object.assign(new EventEmitter(),{release:()=>{releases++;},query:async sql=>{
      sent.push(sql);if(sql==='ROLLBACK'&&mode==='rollback_failure')throw new Error('private rollback error');return {rows:[]};}});
    const pool=Object.assign(new EventEmitter(),{connect:async()=>client,end:async()=>{ends++;}});
    const runtime={postgresCohortImportFingerprint:()=> 'review',createReviewedPostgresAddressOnlyImportPlan:()=>plan,
      executeDedicatedAddressOnlyMigration:async input=>{
        const client=await input.migrationRuntime.pool.connect();
        try {
          await client.query('BEGIN');await client.query('INSERT INTO example VALUES($1)',[1]);
          await client.query(mode==='wrong_lock'?DIAGNOSTIC_COHORT_LOCK_SQL.replace('address_radar_business','private_secret'):DIAGNOSTIC_COHORT_LOCK_SQL);
          if(mode==='startup_with')await client.query(startupSql);
          if(mode==='unknown_with')await client.query('WITH x AS (DELETE FROM example RETURNING *) SELECT * FROM x');
          if(mode==='early_failure')throw new Error('address_only_migration:generation_conflict');
          await client.query(mode==='escape'?'END':'COMMIT');
        }finally{client.release();await input.migrationRuntime.pool.end();}
      }};
    const value=await diagnosePreparedMigrationRollback({job,rawSeed,manifest:{},runtime,pool});
    assert.equal(value.commitSent,false);assert.equal(value.authority,false);assert.equal(value.databaseImported,false);
    assert.equal(value.writeStatementsSent,1);assert.equal(ends,1);assert.equal(releases,1);
    assert.ok(!sent.includes('COMMIT'));assert.ok(!sent.includes('END'));assert.ok(sent.includes('ROLLBACK'));
    if(mode==='commit'||mode==='startup_with')assert.equal(value.status,'diagnostic_rollback_confirmed');
    if(mode==='startup_with')assert.ok(sent.includes(startupSql));
    if(mode==='unknown_with'){assert.equal(value.status,'diagnostic_sql_denied');assert.equal(value.deniedSqlFirstKeyword,'WITH');
      assert.ok(!sent.some(sql=>sql.startsWith('WITH x AS')));}
    if(mode==='rollback_failure'){assert.equal(value.status,'diagnostic_rollback_unconfirmed');assert.equal(value.rollbackConfirmed,false);}
    if(mode==='escape'||mode==='wrong_lock'){
      assert.equal(value.status,'diagnostic_sql_denied');
      assert.match(value.deniedSqlSha256,/^[a-f0-9]{64}$/);
      assert.equal(value.deniedSqlFirstKeyword,mode==='escape'?'END':'LOCK');
      assert.equal(value.deniedSqlReason,'unsupported_statement_shape');
      assert.ok(!JSON.stringify(value).includes('private_secret'));
    }
    if(mode==='early_failure'){assert.equal(value.rollbackConfirmed,true);assert.equal(value.diagnostic.reason,'generation_conflict');}
  }
});
