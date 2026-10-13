/** Disposable PG fixture only. Uses the real reviewed importer and native commit transport. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPostgresBusinessRuntime } from '../../packages/database/src/postgres-business-driver.js';
import { PostgresAuthorityPool } from '../../packages/database/src/postgres-authority-client.js';
import { createPostgresUnitOfWork } from '../../packages/database/src/postgres-unit-of-work.js';
import { createReviewedPostgresAddressOnlyImportPlan, applyReviewedPostgresCohortImportPlan,
  postgresCohortImportFingerprint } from '../../apps/automation/src/postgres-cohort-import.js';

import { createPostgresServiceSchema, installPostgresServiceSchema, createPostgresServiceSchemaGrantPlan } from '../../apps/automation/src/postgres-service-schema.js';
import { createPostgresBusinessProvisioningPlan, postgresBusinessResourcePolicyFingerprint,
  POSTGRES_BUSINESS_SERVICES, type PostgresBusinessProvisioningResources, type PostgresBusinessService }
  from '../../packages/database/src/postgres-business-provisioning.js';
import { verifyAddressOnlyCommittedStartup, addressOnlyCohortDigest } from '../../apps/automation/src/postgres-address-only-startup.js';

const demand: (value: unknown) => asserts value = (value) => { if (!value) throw Error('isolated_recovery_fixture_refused'); };
let stage = 'input';
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
async function main() {
  demand(process.argv.length === 6 && process.argv[2] === '--job' && process.argv[4] === '--job-sha256');
  const raw = await readFile(process.argv[3]!);
  demand(raw.length <= 65536 && sha(raw) === process.argv[5]);
  const job = JSON.parse(raw.toString());
  demand(job.protocol === 'address-only-isolated-recovery-fixture-v1'
    && /^radar_rehearsal_[a-f0-9]{16}$/.test(job.database) && job.schema === job.database
    && /^radar_migrator_[a-f0-9]{16}$/.test(job.username)
    && /^isolated-recovery-[a-f0-9]{16}$/.test(job.generation)
    && /^[a-f0-9]{64}$/.test(job.schemaFingerprint)
    && job.systemIdentifier !== '7693392208475083526');
  const pool = new PostgresAuthorityPool({ host:'127.0.0.1',port:5432,database:job.database,user:job.username,
    password:job.password,max:1,connectionTimeoutMillis:1000,statement_timeout:3000,lock_timeout:1000,
    application_name:'isolated-recovery-fixture',ssl:false,options:'' });
  const uow = createPostgresUnitOfWork(pool,{statementTimeoutMs:3000,lockTimeoutMs:1000});
  try {
    stage = 'database_identity';
    const identity = await uow.run(async tx => (await tx.query(`SELECT current_database() AS database,
      current_user AS username,session_user AS session_username,host(inet_server_addr()) AS server_address,
      inet_server_port() AS server_port,system_identifier::text FROM pg_catalog.pg_control_system()`)).rows[0]);
    demand(identity !== undefined);
    demand(identity.database === job.database && identity.username === job.username
      && identity.session_username === job.username && identity.server_address === '127.0.0.1'
      && identity.server_port === 5432 && identity.system_identifier === job.systemIdentifier);
    const at = Date.now(), capturedAt = at-1000;
    const seed = JSON.stringify({format:'address-only-seed-v1',capturedAt:new Date(capturedAt).toISOString(),rules:{
      historicalEvidenceImported:false,historicalJobsImported:false,legacyLifecycleIsNotNewCapabilityProof:true,
      gatewayDeliveryEnabled:false,activationAuthorizedByExport:false},tables:{
      fomo_accounts:[{account_id:'fixture-account'}],
      wallet_identities:[{account_id:'fixture-account',chain_family:'solana',address:'11111111111111111111111111111111',confidence:'confirmed',source:'manual'}],
      entity_accounts:[{account_id:'fixture-account',entity_id:'fixture-entity',confidence:'confirmed',source:'manual'}],
      trader_entities:[{entity_id:'fixture-entity',lifecycle:'candidate'}],
      trader_profiles:[{entity_id:'fixture-entity',monitoring_enabled:1,fomo_monitoring_enabled:0,onchain_monitoring_enabled:1}],
      trader_monitoring_policy:[{trader_id:'fixture-entity',policy:'realtime'}]}});
    const review = {importId:'isolated-original-cohort',approvalRef:'isolated-fixture-only',actorId:'isolated-fixture-operator',
      actorAuthorizationRef:'isolated-fixture-registry',generationId:job.generation,importedAt:at,seedSha256:sha(seed)};
    const plan = createReviewedPostgresAddressOnlyImportPlan({rawSeed:seed,review,trustedReviewSha256:postgresCohortImportFingerprint(review)});
    const q = (name: string) => '"'+name+'"';
    stage = 'schema_install';
demand(job.schemaFingerprint === createPostgresServiceSchema({protocolVersion:2}).plan.fingerprint);
await installPostgresServiceSchema(uow, {protocolVersion:2,
  target:{database:job.database,schema:job.schema,username:job.username,generation:job.generation,service:'migration'},
  approval:'approved-isolated-business-schema',approvalRef:'isolated-fixture-only'});
await uow.run(async tx => {
  await tx.query("SELECT set_config('search_path',$1,true)",[q(job.schema)+',pg_catalog,pg_temp']);
  await tx.query('INSERT INTO forward_strategy_generations(generation_id,activated_at) VALUES($1,$2)',[job.generation,at]);
  const suffix=job.database.slice('radar_rehearsal_'.length);
  const readers=['scanner','automation','wallet_monitor','wallet_analysis','historical_backfill','console']
    .map(service=>q('radar_'+suffix+'_'+service)).join(',');
  // Waiting-mode services have no business mutations. Keep these fixture grants read-only.
  await tx.query('REVOKE ALL ON SCHEMA '+q(job.schema)+' FROM PUBLIC');
  await tx.query('GRANT USAGE ON SCHEMA '+q(job.schema)+' TO '+readers);
  await tx.query('GRANT SELECT ON ALL TABLES IN SCHEMA '+q(job.schema)+' TO '+readers);
});
    const target = {database:job.database,schema:job.schema,username:job.username,generation:job.generation,
      service:'migrator',serverAddress:'127.0.0.1',serverPort:5432,schemaVersion:3,schemaFingerprint:job.schemaFingerprint};
    stage = 'cohort_import';
    const result = await applyReviewedPostgresCohortImportPlan(plan,{
      runtime:{run:uow.run,probe:async () => {
        const observed = await uow.run(async tx => (await tx.query('SELECT current_database() AS database,current_user AS username')).rows[0]);
        demand(observed !== undefined);
        demand(observed.database === job.database && observed.username === job.username);
        return target;
      }},capability:{kind:'isolated',purpose:'cohort_projection',authorizationRef:review.approvalRef,
        planSha256:plan.planSha256,expiresAtMs:at+30000,target},
      assertAuthorized:async input => { demand(input.planSha256 === plan.planSha256 && input.approvalRef === review.approvalRef
        && input.generationId === job.generation && input.capability.kind === 'isolated'); },
      budget:{deadlineAtMs:at+30000,maximumTransactionMs:5000,maximumQueriesPerTransaction:128,
        maximumTotalQueries:128,maximumTransactions:1,recordsPerTransaction:1,maximumImportLagMs:30000}});
    stage = 'import_result';
    demand(result.appliedProfiles === 1 && result.grantsBusinessEligibility === false);
    stage = 'committed_read';
    // A separate committed transaction observes the real importer's durable rows.
    await uow.run(async tx => {
      const observed = (await tx.query('SELECT source_fingerprint,proof_scope FROM '+q(job.schema)+'.wallet_service_import_ledger WHERE import_id=$1',[plan.importId])).rows;
      demand(observed.length === 1 && observed[0]?.source_fingerprint === plan.planSha256 && observed[0]?.proof_scope === 'address_only_registry');
    });
    const cohort = await uow.run(async tx => (await tx.query('SELECT subject_key,entity_id,wallet_family,profile_payload,import_id,observed_at FROM '+q(job.schema)+'.wallet_service_profile_cohort WHERE generation_id=$1 ORDER BY subject_key LIMIT 2',[job.generation])).rows);
    const manifestFields = {seedSha256:review.seedSha256,cohortSha256:addressOnlyCohortDigest(cohort),activatedAt:at,walletCount:cohort.length,entityCount:1};
    const binding = {operationId:job.operationId,importId:plan.importId,generationId:job.generation,planSha256:plan.planSha256,
      target:{database:job.database,schema:job.schema,schemaFingerprint:job.schemaFingerprint,systemIdentifier:job.systemIdentifier,
        serverAddress:'127.0.0.1',serverPort:5432}};
    stage = 'write_output';
    await writeFile(job.output,JSON.stringify({protocol:'address-only-isolated-committed-recovery-v1',binding,result,manifestFields}),{mode:0o600,flag:'wx'});
    process.stdout.write(JSON.stringify({status:'ISOLATED_IMPORT_COMMITTED',productionProof:false})+'\n');
  } finally { await pool.end(); }
}
if (process.argv.length === 5 && process.argv[2] === '--runtime-probe') {
  const config=JSON.parse(await readFile(process.argv[3]!, 'utf8'));
  const credential=JSON.parse(await readFile(process.argv[4]!, 'utf8'));
  const service=credential.service;
  const runtime=createPostgresBusinessRuntime({...config.driver, connectionString:credential.connectionString,
    target:{database:config.database,username:credential.username,schema:config.schema,generation:config.generationId,service},
    maximumConnections:1,access:service === 'console' ? 'read' : 'runtime'});
  try {
    const identity=await runtime.probe(); process.stdout.write('ISOLATED_RUNTIME_PROBE_OK\n');
    const evidence=JSON.parse(await readFile(new URL('evidence.json','file://'+process.argv[3]!), 'utf8'));
    await verifyAddressOnlyCommittedStartup({manifest:config.cutover.addressOnly,runtime,identity,
      releaseSha256:evidence.releaseSha256,backupSha256:evidence.backupSha256,fenceSha256:evidence.fenceSha256,
      disabledFlags:evidence,deadline:new Date(Date.now()+3000).toISOString()});
    process.stdout.write('ISOLATED_COMMITTED_STARTUP_OK\n');

  }
  catch(error) {
    const message=error instanceof Error ? Object.getOwnPropertyDescriptor(error,'message')?.value : undefined;
    const reasons=new Map([
      ['PostgreSQL business role failed the least-privilege probe','least_privilege'],
      ['PostgreSQL business schema version, fingerprint or generation mismatch','schema_binding'],
      ['PostgreSQL business connection identity mismatch','connection_identity']]);
    process.stdout.write(JSON.stringify({status:'ISOLATED_RUNTIME_PROBE_REFUSED',messageSha256:typeof message === 'string' ? sha(message) : null,reason:reasons.get(message) ?? (typeof message === 'string' && /^address_only_startup:(?:snapshot_bound|snapshot_shape|cluster_mismatch|generation_mismatch|ledger_mismatch|related_state|cohort_count_or_import|cohort_distinct_counts|cohort_digest)$/.test(message) ? message : 'unclassified')})+'\n');
    process.exitCode=1;
  } finally { await runtime.close(); }
} else if (process.argv.length === 3 && process.argv[2] === '--schema-fingerprint') {
  process.stdout.write(createPostgresServiceSchema({protocolVersion:2}).plan.fingerprint+'\n');
} else if (process.argv.length === 6 && process.argv[2] === '--configured-grants') {
  const database=process.argv[3]!, schema=process.argv[4]!, generation=process.argv[5]!;
  demand(/^radar_rehearsal_[a-f0-9]{16}$/.test(database) && schema===database
    && generation==='isolated-recovery-'+database.slice('radar_rehearsal_'.length));
  const suffix=database.slice('radar_rehearsal_'.length), migratorRole='radar_migrator_'+suffix;
  const serviceRoles=Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>
    [service,'radar_'+suffix+'_'+service.replaceAll('-','_')])) as Record<PostgresBusinessService,string>;
  const resources={pools:Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>[service,{instances:1,maximumConnections:1}])),
    serverMaximumConnections:12,postgresReservedConnections:3,otherHostConnections:0,migrationConnections:1,
    operatorConnections:1,backupConnections:1,maximumPendingOperations:0,connectionTimeoutMs:2000,idleTimeoutMs:500,
    statementTimeoutMs:3000,lockTimeoutMs:500,idleTransactionTimeoutMs:10000,shutdownTimeoutMs:2000,
    workMemKb:1024,maximumMeasurementAgeMs:60000} as PostgresBusinessProvisioningResources;
  const definition=createPostgresServiceSchema({protocolVersion:2}), now=new Date().toISOString();
  // Synthetic offline planning inputs only: this does not attest host capacity or authorize production.
  const plan=createPostgresBusinessProvisioningPlan({database,schema,generation,migratorRole,serviceRoles,resources,now,
    schemaPlan:definition.plan,trustedModules:definition.trustedModules,capacity:{status:'measured',
      hostId:'synthetic-isolated-policy',measurementRef:'fixture-only/not-production-capacity',
      resourcePolicyFingerprint:postgresBusinessResourcePolicyFingerprint(resources),measuredAt:now,
      validUntil:new Date(Date.now()+60000).toISOString(),availableRamBytes:'1073741824',
      measuredPeakRamBytes:'16777216',ramMarginBytes:'16777216',availableDiskBytes:'5368709120',
      measuredPeakDiskBytes:'16777216',measuredPeakWalBytes:'67108864',measuredPeakTempBytes:'16777216',diskMarginBytes:'16777216'}});
  const grants=plan.phases.find(phase=>phase.id==='post-schema-grants');
  demand(grants !== undefined);
  const supplemental=createPostgresServiceSchemaGrantPlan({schema,migratorRole,serviceRoles,protocolVersion:2});
  process.stdout.write([...grants.statements,...supplemental.statements].join('\n')+'\n');
} else void main().catch((error: unknown) => {
  const data: PropertyDescriptorMap = error && typeof error === 'object' ? Object.getOwnPropertyDescriptors(error) : {};
  const message = data.message && 'value' in data.message ? data.message.value : undefined;
  const code = data.code && 'value' in data.code ? data.code.value : undefined;
  const reasons = new Map([
    ['isolated_recovery_fixture_refused', 'assertion_failed'],
    ['postgres_cohort_import_import_clock_or_lag', 'import_clock_or_lag'],
    ['postgres_cohort_import_transaction_deadline', 'transaction_deadline'],
    ['postgres_cohort_import_deadline_exceeded', 'deadline_exceeded'],
    ['postgres_cohort_import_capability_expired', 'capability_expired'],
    ['postgres_cohort_import_query_budget_exceeded', 'query_budget_exceeded'],
    ['timeout exceeded when trying to connect', 'connection_timeout'],
    ['Connection terminated due to connection timeout', 'connection_timeout'],
    ['Connection terminated unexpectedly', 'connection_terminated'],
    ['PostgreSQL operation and rollback failed', 'operation_and_rollback_failed'],
    ['PostgreSQL commit failed; reconcile the durable result before retrying', 'commit_uncertain'],
  ]);
  const reason = typeof message === 'string' ? reasons.get(message) ?? 'unclassified_error' : 'unclassified_error';
  const transportCode = typeof code === 'string' && ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE'].includes(code) ? code : undefined;
  const sqlState = typeof code === 'string' && /^(?:[0-9]{5}|[0-9]{2}[A-Z][0-9A-Z]{2})$/.test(code) ? code : undefined;
  process.stdout.write(JSON.stringify({status:'ISOLATED_FIXTURE_REFUSED',stage,reason,...(transportCode ? {transportCode} : {}),...(sqlState ? {sqlState} : {})})+'\n');
  process.exitCode=1;
});
