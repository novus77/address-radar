import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
const execute = promisify(execFile);
const diagnosticErrors = new WeakMap();
const diagnosticStages = new WeakMap();
const demand = (value, code) => {
  if (!value) { const error = new Error(code); diagnosticErrors.set(error, code); throw error; }
};
export const FENCE_DIAGNOSTIC_CODES = Object.freeze(["active", "ascii", "assert_alive_and_locked", "automation", "backup", "backup_changed_during_digest", "backup_directory", "backup_integrity_failed", "binding", "console", "controller_lock_not_held", "controller_lock_not_owned", "controller_lock_replaced", "database", "device", "disabled", "enabled", "failed", "flags", "fomo_process_changed", "fragment", "gid", "guard", "guard_anchor", "guard_directory", "guards", "identity", "import_outcome_not_confirmed_absent", "import_outcome_not_confirmed_committed", "import_outcome_not_reconciled_under_exclusion", "import_plan_already_bound", "import_plan_not_bound", "inactive", "indirect", "information_schema", "inode", "insufficient_backup_space", "invalid_deadline_budget", "invalid_fence_phase", "invalid_import_binding", "invalid_import_plan_hash", "invalid_import_target", "invalid_journal", "invalid_operation_id", "invalid_plan_binding_phase", "invalid_restore_phase", "invalid_source_metadata", "invalid_source_sizes", "inventory_changed", "isolation", "journal_budget", "journal_unit_inventory_changed", "kind", "linux", "loaded", "mapped", "maps_budget", "mask", "masked", "masks", "measurement", "measurement_backup_changed", "measurement_backup_path", "measurement_binding", "measurement_journal_changed", "measurement_operation_mismatch", "measurement_phase", "measurement_restart_exclusion_changed", "measurement_source_changed", "measurement_source_directory_changed", "measurement_unsafe_directory", "measurement_unsafe_file", "migrate", "mode", "native_root_required", "no_unresolved_journal", "operation_id_required", "operation_id_reused", "original_operation_deadline", "parent_replaced", "path", "pending", "permission_target_replaced", "pg_", "phase", "pid", "prepared", "process_budget", "process_fd_budget", "protected_writer_overlap", "protocol", "public", "recovery_guard_already_active", "recovery_live_lock_connection_changed", "recovery_live_lock_guard_required", "recovery_live_lock_proof_required", "reload", "restart_guard_anchor_replaced", "restart_guard_directory_replaced", "restart_guard_missing", "restart_guard_not_effective", "restart_guard_replaced", "restart_mask_anchor_replaced", "restart_mask_replaced", "restart_original_changed", "restart_sentinel_changed", "restore_", "restore_directory", "restore_file", "scanner", "schema", "seal_", "seal_directory", "seal_file", "sealed_source_changed", "sentinel", "sha256", "show", "size", "source_changed_during_copy", "source_replaced", "source_short_read", "source_writer_remains", "sources", "staging_checkpoint_failed", "stamp", "start", "static", "status", "stop", "store_true", "subject", "systemctl", "systemd", "target", "total_fd_budget", "uid", "unexpected_operation_id", "unexpected_source_inventory", "unguard", "unguard_directory", "unit_configuration_changed", "unit_dropin_budget", "unmask", "unprotected_ancestor", "unresolved_journal", "unsafe_private_directory", "unsafe_private_file", "unsafe_source_directory", "unsafe_source_file", "unsafe_unit_configuration", "unsupported_restart_guard_order", "unsupported_restart_guard_path", "unsupported_restart_mask", "unsupported_restart_mask_filesystem", "unsupported_stop_propagation", "writable", "writer_mask_missing", "writer_reactivated", "writers_not_stopped", "unknown_failure", "permission_denied", "file_not_found", "os_error", "subprocess_timeout", "subprocess_failed", "invalid_json"]);
export function fenceMeasureFailure(error) {
  let code='fence_subprocess_failure';
  try {
    const raw=error?.stdout;
    if(typeof raw==='string'&&Buffer.byteLength(raw)<=65536) {
      const value=JSON.parse(raw);
      if(value?.status==='address-only-native-refused'&&FENCE_DIAGNOSTIC_CODES.includes(value.diagnostic?.code))
        code='fence_'+value.diagnostic.code;
    }
  } catch {}
  const failure=new Error('native_fence_measure_failed');
  diagnosticErrors.set(failure,code);return failure;
}

const STATIC_REASON_NAMESPACES = Object.freeze({"postgres_cohort_import_":["active","address_only_registry","applied","approved_cutover","base64","bigint","boolean","candidate","capability_binding","capability_expired","capability_kind","channel","cohort_projection","columns","confirmed","conflict_at","conflict_by_version","created_by_version","cutover_requires_parent_transaction","deadline_exceeded","definition","degraded","duplicate_allowlist_subject","duplicate_provider_seed","duplicate_source_row","elite","entity_accounts","entity_id","entity_wallet_identities","evm","execution_budget","fomo_monitoring_enabled","foreign_columns","foreign_schema","foreign_table","forward_strategy_generations","forward_target_channel_heads","forward_target_channel_versions","forward_target_control_locks","forward_target_identity_bindings","fresh_chain_facts","function","generation_id","generation_not_registered","hex","high","historical","historical_coherent","identity_review","import_clock_or_lag","import_id","information_schema","integer","intent_key","invalid_array","invalid_json_value","isolated","isolated_target_required","kind","ledger_collision","legacy_confidence_not_owner_authority","legacy_registry_linkage","lock_timeout","lossy_number","low","medium","missing_reviewed_registry_reference","monitoring_enabled","multiple_owner","name","native_transaction_record_budget","no_applicable_cohort","no_applicable_provider_seed","not_imported","not_null","number","object","onchain_monitoring_enabled","origin","owned","pending_parent_commit","pg_","pg_catalog","plan_budget","plan_budget_or_crosswalk_shape","postgres_cohort_import_","probation","profile_or_owner_collision","profile_receipt_collision","provider_budget_seed","provider_contract","provider_explicit_budget","provider_id","provider_origin","provider_origin_collision","provider_review_pin","provider_review_shape","provider_seed_collision","provider_seed_shape","provider_unknown_cooldown","public","quarantine","quarantined_or_multiple_owner","query_budget_exceeded","review_allowlist_shape","review_clock","review_pin_mismatch","review_shape","revoked_at","rows","runtime","schema_check","schema_column","schema_foreign_key","schema_migration_role_privileges","schema_primary_key","schema_relation_kind","schema_table_accounting","schema_unique_key","search_path","serialization_budget","sha256","solana","source_pin_mismatch","source_pin_shape","source_profile_boolean_mismatch","stable_qualification","statement_timeout","string","subject_key","suspended","target_connection_mismatch","target_probe_mismatch","target_registry_write","target_repository_collision","target_shape","text","token_projection","trader_profiles","transaction","transaction_budget","transaction_deadline","type","unknown_lifecycle","unknown_profile_flags","unknown_profile_or_account","unknown_source_confidence","unproven_account_linkage","unproven_source_profile","unproven_wallet_cohort","unproven_wallet_linkage","unsupported","untrusted_plan_object","validated","value","version_id","wallet","wallet_identities","wallet_service_import_ledger","wallet_service_profile_cohort","wallet_service_provider_budgets"],"address_only_startup:":["abort","aborted","activated_at","actual_disabled_flags_required","address_only_registry","bigint","cluster","cluster_mismatch","cohort","cohort_byte_limit","cohort_count_or_import","cohort_digest","cohort_distinct_counts","cohort_label","cohort_row_limit","database","deadline_iso","disabled_flags_required","endpoint","entity_count","entity_id","evm","exact_fields_required","expired","fact","forward_strategy_generations","forward_target_channel_heads","forward_target_channel_versions","forward_target_identity_bindings","generation_mismatch","generations","hash","hex","import_id","information_schema","invalid_epoch","label","ledger","ledger_mismatch","number","object","object_required","owned","pg_","probed_identity_mismatch","profile_payload_limit","protocol","public","related_state","related_valid","run","schema","schema_fingerprint","sha256","snapshot_bound","snapshot_shape","solana","string","subject_key","system_identifier","target","value","wallet","wallet_count","wallet_family","wallet_service_import_ledger","wallet_service_profile_cohort","wallet_service_profile_versions"],"address_only_migration:":["address_only_registry","approved_cutover","budget","budget_binding","business_import","capability","capability_binding","clock","cohort_projection","committed","deadline","forward_strategy_generations","generation_conflict","incomplete_import","kind","pending_parent_commit","plan_binding","projected_digest","source_fence_drift","target","target_binding","unknown"],"PostgreSQL migration rejected: ":["approved_cutover","business_import","cannot_create_schema","cannot_create_temp","clock_moved_backwards","closed","closing","connection_already_released","dedicated_pool_already_owned","error","function","identity_or_authority_mismatch","idle_in_transaction_session_timeout","information_schema","invalid_capability","invalid_clock","invalid_error_event_port","invalid_limits","invalid_target","isolated","isolated_target_required","ledger_requires_permanent_tables","lock_timeout","max_parallel_workers_per_gather","missing_operation_scope","missing_verified_ports","nested_migration_uow_forbidden","no_callable_security_definers","no_other_relation_authority","no_other_schema_authority","no_other_sequence_authority","no_role_memberships","owns_target_schema","pg_","pg_catalog","postgres","public","query","radar_rehearsal_","ready","role_safe","runtime_closed_or_busy","schema_install","schema_or_generation_mismatch","search_path","sql_statement_budget","statement_timeout","string","synchronous_commit","template0","template1","work_mem"]});
export async function withDiagnosticStage(context, stage, operation) {
  const previous=context.stage;context.stage=stage;
  try {return await operation();}
  catch(error){if(error&&typeof error==='object'&&!diagnosticStages.has(error))diagnosticStages.set(error,stage);throw error;}
  finally{context.stage=previous;}
}
function knownReason(error, depth=0) {
  if(depth>3 || !error || typeof error!=='object')return undefined;
  for(const [prefix,reasons] of Object.entries(STATIC_REASON_NAMESPACES)) {
    if(typeof error.message==='string' && error.message.startsWith(prefix)) {
      const reason=error.message.slice(prefix.length);
      if(reasons.includes(reason))return {namespace:prefix==='postgres_cohort_import_'?'cohort':
        prefix==='address_only_startup:'?'startup':prefix==='address_only_migration:'?'migration':'runtime',reason};
    }
  }
  return knownReason(error.operationError,depth+1)??knownReason(error.cause,depth+1);
}

// Reviewed SELECT-only MVCC CTE from postgres-address-only-startup.ts; raw bytes are pinned.
export const DIAGNOSTIC_STARTUP_SELECT_SHA256 = 'a1cdfc48361c76c7c0a0d46e6bf792c8c8ab9db832cc0620780e24eb3a1160a4';

export const DIAGNOSTIC_COHORT_LOCK_SQL = "LOCK TABLE \"address_radar_business\".\"wallet_service_import_ledger\",\"address_radar_business\".\"wallet_service_profile_cohort\",\"address_radar_business\".\"wallet_service_profile_versions\",\"address_radar_business\".\"forward_target_control_locks\",\"address_radar_business\".\"forward_target_channel_versions\",\"address_radar_business\".\"forward_target_channel_heads\",\"address_radar_business\".\"forward_target_identity_bindings\",\"address_radar_business\".\"forward_target_authorization_intents\" IN SHARE ROW EXCLUSIVE MODE";

export async function diagnosePreparedMigrationRollback({job,rawSeed,manifest,runtime,pool}) {
  let retired=false,ended=false,commitBlocked=false,rollbackConfirmed=false,rollbackFailed=false;
  let connected=false,writeStatementsSent=0,sqlDenied=false,deniedSql;
  const deny=(sql,reason)=>{
    sqlDenied=true;
    const text=typeof sql==='string'?sql:'';
    const stripped=text.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ').trim();
    const keyword=/^[A-Za-z]+/.exec(stripped)?.[0].toUpperCase();
    const allowed=['SELECT','INSERT','UPDATE','DELETE','LOCK','WITH','SAVEPOINT','RELEASE','BEGIN','COMMIT','ROLLBACK','END','SET','CREATE','ALTER','DROP','TRUNCATE'];
    deniedSql??={deniedSqlSha256:hash(text),deniedSqlFirstKeyword:allowed.includes(keyword)?keyword:'UNKNOWN',deniedSqlReason:reason};
  };
  const clients=[];
  const stop=new Error('diagnostic_commit_blocked');
  const wrapped={on:pool.on.bind(pool),removeListener:pool.removeListener.bind(pool),end:async()=>{},
    async connect(){
      const native=await pool.connect();
      if(retired){native.release(stop);throw stop;}
      connected=true;
      const state={native,active:false,released:false,error:undefined};clients.push(state);
      return {on:native.on.bind(native),removeListener:native.removeListener.bind(native),
        release:error=>{state.released=true;state.error=error;},
        query:async(sql,values)=>{
          if(retired||typeof sql!=='string')throw stop;
          const normalized=sql.trim().replace(/\s+/g,' ');
          if(normalized==='COMMIT'){
            commitBlocked=true;
            if(!state.active){deny(sql,'commit_without_transaction');throw stop;}
            try{await native.query('ROLLBACK');state.active=false;rollbackConfirmed=true;}
            catch{rollbackFailed=true;}
            throw stop;
          }
          if(normalized==='ROLLBACK'){
            try{const result=await native.query('ROLLBACK');state.active=false;rollbackConfirmed=true;return result;}
            catch(error){rollbackFailed=true;throw error;}
          }
          if(normalized==='BEGIN'){
            if(state.active){deny(sql,'nested_begin');throw stop;}
            // Mark intent first: an uncertain BEGIN still needs rollback/discard.
            state.active=true;return native.query(sql,values);
          }
          if(!state.active){
            if(!READONLY_PROBE_SQL_HASHES.has(hash(normalized))||!normalized.startsWith('/* migration-runtime-bootstrap */')){
              deny(sql,'outside_transaction');throw stop;
            }
          } else {
            // Genuine trusted runtime supplies SQL; deny transaction escape and multi-command text.
            const tokens=sql.replace(/'(?:''|[^'])*'/g,"''").replace(/"(?:""|[^"])*"/g,'""')
              .replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ').trim();
if(tokens.includes(';')||/\$[A-Za-z_0-9]*\$/.test(tokens)) {
              deny(sql,'multi_statement_or_dollar_quote');throw stop;
            }
            if(!/^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(tokens) && normalized!==DIAGNOSTIC_COHORT_LOCK_SQL
               && hash(sql)!==DIAGNOSTIC_STARTUP_SELECT_SHA256) {
              deny(sql,'unsupported_statement_shape');throw stop;
            }
            if(/^(INSERT|UPDATE|DELETE)\b/i.test(tokens))writeStatementsSent++;
          }
          return native.query(sql,values);
        }};
    }};
  let result;
  try {
    result=await diagnosePreparedMigrationPreconnect({job,rawSeed,manifest,runtime:{...runtime,
      executeDedicatedAddressOnlyMigration:input=>runtime.executeDedicatedAddressOnlyMigration({...input,
        migrationRuntime:{...input.migrationRuntime,pool:wrapped}})}});
  } finally {
    retired=true;
    for(const state of clients){
      if(state.active){
        try{await state.native.query('ROLLBACK');state.active=false;rollbackConfirmed=true;}
        catch{rollbackFailed=true;}
      }
      state.native.release(rollbackFailed?stop:state.error);
    }
    try{await pool.end();ended=true;}catch{}
  }
  return {...result,protocol:'address-only-synthetic-rollback-diagnostic-v1',databaseConnected:connected,
    sqlExecuted:connected,realTransactionalWrites:true,writeStatementsSent,commitSent:false,
    rollbackConfirmed:rollbackConfirmed&&!rollbackFailed,poolClosed:ended,...deniedSql,
    status:rollbackFailed?'diagnostic_rollback_unconfirmed':!ended?'diagnostic_pool_close_failed':
      sqlDenied?'diagnostic_sql_denied':commitBlocked&&rollbackConfirmed?'diagnostic_rollback_confirmed':result.status};
}

export const DIAGNOSTIC_STAGES = Object.freeze(['job', 'seed', 'runtime_load', 'plan', 'publication',
  'fence_measure', 'credential', 'pg_load', 'runtime_execute', 'runtime_authority', 'import_authority', 'receipt']);
export const DIAGNOSTIC_CODES = Object.freeze(['unknown_failure', 'job_fields', 'job_protocol', 'job_pin',
  'job_output', 'activation_clock', 'job_target', 'job_review', 'job_budgets', 'job_numeric_budgets',
  'job_budget_order', 'native_root_required', 'arguments', 'native_deadline', 'protected_pin',
  'protected_parent', 'protected_file', 'protected_file_changed', 'protected_parent_changed', 'protected_digest',
  'output_path', 'output_parent', 'private_output', 'output_budget', 'publication_already_exists',
  'native_fence_measurement', 'fresh_credential_required', 'native_runtime_authority', 'native_import_authority',
  'runtime_invalid_limits', 'runtime_invalid_target', 'runtime_invalid_capability', 'runtime_missing_verified_ports',
  'migration_plan_binding', 'migration_target_binding', 'migration_capability_binding', 'migration_budget_binding',
  'migration_deadline', 'migration_projected_digest', 'migration_source_fence_drift',
  'runtime_identity_or_authority_mismatch','runtime_schema_or_generation_mismatch']);
export function sanitizedImportFailure(error, stage = 'job') {
  stage=diagnosticStages.get(error)??stage;
  const runtimeCodes = new Map([['PostgreSQL migration rejected: invalid_limits','runtime_invalid_limits'],
    ['PostgreSQL migration rejected: invalid_target','runtime_invalid_target'],
    ['PostgreSQL migration rejected: invalid_capability','runtime_invalid_capability'],
    ['PostgreSQL migration rejected: missing_verified_ports','runtime_missing_verified_ports'],
    ['PostgreSQL migration rejected: identity_or_authority_mismatch','runtime_identity_or_authority_mismatch'],
    ['PostgreSQL migration rejected: schema_or_generation_mismatch','runtime_schema_or_generation_mismatch']]);
for(const reason of ['plan_binding','target_binding','capability_binding','budget_binding','deadline','projected_digest','source_fence_drift'])
    runtimeCodes.set('address_only_migration:'+reason,'migration_'+reason);
  const classified=knownReason(error);
  const code = diagnosticErrors.get(error) ?? runtimeCodes.get(error?.message);
  return {status:'address-only-native-refused-or-uncertain', outcomeKnown:false,
    businessReleaseSwitched:false, gatewayDeliveryEnabled:false,
    diagnostic:{...(classified?{namespace:classified.namespace,reason:classified.reason}:{}),
      stage:DIAGNOSTIC_STAGES.includes(stage)?stage:'job',
      code:(DIAGNOSTIC_CODES.includes(code)||code==='fence_subprocess_failure'||FENCE_DIAGNOSTIC_CODES.some(value=>code==='fence_'+value))?code:'unknown_failure'}};
}
const READONLY_PROBE_SQL_HASHES = new Set(["04b703098215b225bd1e9a79101d55c1eee71f735d82259bdcc4ad6df1985cf3", "1502705a052c867d5ef4b7ca305429cf075207a450be9e00f3142b18c66fceac", "77c8896a076e62e8c5a40f6b70667dc860b07b2e3d9eab491b22524dfdc7436b", "e98f5f4e0f7e865e1030268398791d03491e04f521e411ccb6b202a820d2e763", "37bd61d271202076a723d984d4c236e002ea8ee44944b115eaecf45a93a0e0fe", "a8402858d4f1e1d27afee976520485ebb4b96a5387355b823f0d0b8079729032", "79663c1d3b43ceaf9ee728e501c64b57ae2e4d6cb36ff5c65eddcda1de27342f", "587fa628a9fe4642ac0e22825a97e81d388af674f7251a9fb699f96901dcb710", "cfc8f85932a8453c4e8b1782bec76b9d6249617c974e6852448b2255d0982977", "1a6751ba70ff65d15e989d0a11b3d8d51cabe9cfb325027136238a3b25d84f8e"]);
export async function diagnosePreparedMigrationReadonly({job, rawSeed, manifest, runtime, pool}) {
  let ended=false, blocked=false, denied=false, readonlyFailed=false, connected=false;
  const end=async()=>{if(!ended){ended=true;await pool.end();}};
  const stop=new Error('diagnostic_before_first_write');
  const wrapped={end,async connect(){
    const client=await pool.connect();connected=true;
    try {
      await client.query('SET default_transaction_read_only=on');
      const result=await client.query('SHOW default_transaction_read_only');
      if(result.rows?.length!==1 || result.rows[0].default_transaction_read_only!=='on') {
        readonlyFailed=true;throw stop;
      }
    } catch(error) {client.release(error);throw error;}
    return {query:async(sql,values)=>{
      if(typeof sql!=='string'){denied=true;throw stop;}
      const normalized=sql.trim().replace(/\s+/g,' ');
      if(normalized.startsWith('INSERT INTO "address_radar_business"."forward_strategy_generations"(')) {
        blocked=true;throw stop;
      }
      if(!READONLY_PROBE_SQL_HASHES.has(hash(normalized))){denied=true;throw stop;}
      return client.query(sql,values);
    },release:error=>client.release(error),on:client.on.bind(client),removeListener:client.removeListener.bind(client)};
  },on:pool.on.bind(pool),removeListener:pool.removeListener.bind(pool)};
  let result;
  try {
    result=await diagnosePreparedMigrationPreconnect({job,rawSeed,manifest,runtime:{...runtime,
      executeDedicatedAddressOnlyMigration:input=>runtime.executeDedicatedAddressOnlyMigration({...input,
        migrationRuntime:{...input.migrationRuntime,pool:wrapped}})}});
  } finally {await end();}
  return {...result,protocol:'address-only-synthetic-readonly-diagnostic-v1',databaseConnected:connected,
    sqlExecuted:connected,sqlWritesExecuted:false,
    status:readonlyFailed?'diagnostic_readonly_not_confirmed':denied?'diagnostic_sql_not_allowlisted':
      blocked?'diagnostic_before_first_write':result.status};
}

export async function diagnosePreparedMigrationPreconnect({job, rawSeed, manifest, runtime}) {
  const base={protocol:'address-only-synthetic-preconnect-diagnostic-v1', synthetic:true,
    authority:false, databaseImported:false, databaseConnected:false, sqlExecuted:false,
    businessReleaseSwitched:false, gatewayDeliveryEnabled:false};
  const sentinel=new Error('diagnostic_preconnect_reached');
  let connectAttempts=0, stage='job';
  try {
    validateDedicatedImportJob(job);
    stage='seed'; demand(hash(Buffer.from(rawSeed))===job.seed.sha256,'protected_digest');
    stage='plan';
    const plan=runtime.createReviewedPostgresAddressOnlyImportPlan({rawSeed:Buffer.from(rawSeed).toString('utf8'),
      review:job.review,trustedReviewSha256:runtime.postgresCohortImportFingerprint(job.review)});
    // Only expiry is refreshed. All captured bindings, numeric limits and transaction budgets remain intact.
    const expiresAtMs=Date.now()+Math.min(60000,job.budget.maximumTransactionMs);
    const pool={connect:async()=>{connectAttempts++;throw sentinel;},end:async()=>{}};
    const measureSourceFence=async()=>({backupSha256:manifest.backupSha256,fenceSha256:manifest.fenceSha256,
      gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false});
    stage='runtime_execute';
    await runtime.executeDedicatedAddressOnlyMigration({target:job.target,plan,manifest,
      migrationRuntime:{pool,limits:{...job.limits},assertAuthorized:async()=>{}},
      capability:{kind:'approved_cutover',purpose:'cohort_projection',authorizationRef:plan.approvalRef,
        target:Object.fromEntries(Object.entries(job.target).filter(([key])=>key!=='systemIdentifier')),
        planSha256:plan.planSha256,expiresAtMs},
      budget:{...job.budget,deadlineAtMs:expiresAtMs},assertAuthorized:async()=>{},
      measureSourceFence,releaseSha256:job.releaseSha256});
    return {...base,status:'diagnostic_unexpected_return',connectAttempts};
  } catch(error) {
    if(error===sentinel) return {...base,status:'diagnostic_preconnect_reached',connectAttempts};
    return {...base,status:'diagnostic_rejected',connectAttempts,
      diagnostic:sanitizedImportFailure(error,stage).diagnostic};
  }
}

export function diagnosePreparedPlan({job, rawSeed, runtime}) {
  validateDedicatedImportJob(job);
  demand(hash(Buffer.from(rawSeed)) === job.seed.sha256, 'protected_digest');
  const plan = runtime.createReviewedPostgresAddressOnlyImportPlan({rawSeed:Buffer.from(rawSeed).toString('utf8'),
    review:job.review, trustedReviewSha256:runtime.postgresCohortImportFingerprint(job.review)});
  return {status:'address-only-plan-hashed-not-imported', operationId:job.operationId,
    planSha256:plan.planSha256, databaseImported:false, businessReleaseSwitched:false, gatewayDeliveryEnabled:false};
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const root = '/var/lib/address-radar-maintenance-tools/';
const nativePath = value => typeof value === 'string' && resolve(value) === value && value.startsWith(root);
export function validateDedicatedImportJob(job) {
  demand(exact(job, ['protocol','operationId','action','seed','review','activatedAt','target','releaseSha256',
    'runtimeModule','pgModule','credential','sourceFence','budget','limits','outputDirectory']), 'job_fields');
  demand(job.protocol === 'address-only-native-job-v1' && ['plan','prepare','import'].includes(job.action)
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(job.operationId), 'job_protocol');
  for (const pin of [job.seed,job.runtimeModule,job.pgModule,job.credential,job.sourceFence]) {
    demand(exact(pin,['path','sha256']) && nativePath(pin.path) && sha(pin.sha256),'job_pin');
  }
  demand(nativePath(job.outputDirectory) && !job.outputDirectory.endsWith('/') && sha(job.releaseSha256),'job_output');
  demand(Number.isSafeInteger(job.activatedAt) && job.activatedAt >= 0,'activation_clock');
  demand(exact(job.target,['database','username','schema','generation','service','serverAddress','serverPort','schemaVersion','schemaFingerprint','systemIdentifier'])
    && job.target.database === 'address_radar' && job.target.schema === 'address_radar_business'
    && job.target.username === 'address_radar_migrator' && job.target.service === 'migration'
    && job.target.serverAddress === '127.0.0.1' && job.target.serverPort === 5432 && job.target.schemaVersion === 3
    && job.target.schemaFingerprint === 'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383'
    && job.target.systemIdentifier === '7693392208475083526','job_target');
  demand(exact(job.review,['importId','approvalRef','actorId','actorAuthorizationRef','generationId','importedAt','seedSha256'])
    && job.review.generationId === job.target.generation && job.review.seedSha256 === job.seed.sha256,'job_review');
  demand(exact(job.budget,['deadlineAtMs','maximumTransactionMs','maximumQueriesPerTransaction','maximumTotalQueries',
    'maximumTransactions','recordsPerTransaction','maximumImportLagMs'])
    && exact(job.limits,['operationTimeoutMs','connectionTimeoutMs','statementTimeoutMs','lockTimeoutMs',
      'maximumSqlStatements','workMemKb','closeTimeoutMs']), 'job_budgets');
  const ceilings = {deadlineAtMs:Number.MAX_SAFE_INTEGER,maximumTransactionMs:60000,
    maximumQueriesPerTransaction:100000,maximumTotalQueries:100000,maximumTransactions:1,
    recordsPerTransaction:1000,maximumImportLagMs:86400000};
  const runtimeCeilings = {operationTimeoutMs:60000,connectionTimeoutMs:10000,statementTimeoutMs:30000,
    lockTimeoutMs:5000,maximumSqlStatements:100000,workMemKb:4096,closeTimeoutMs:10000};
  for(const [values,limits] of [[job.budget,ceilings],[job.limits,runtimeCeilings]])
    demand(Object.entries(limits).every(([k,max])=>Number.isSafeInteger(values[k])&&values[k]>0&&values[k]<=max),'job_numeric_budgets');
  demand(job.limits.lockTimeoutMs<=job.limits.statementTimeoutMs
    &&job.limits.statementTimeoutMs<=job.limits.operationTimeoutMs
    &&job.limits.connectionTimeoutMs<=job.limits.operationTimeoutMs,'job_budget_order');
  return job;

}
function deadline(milliseconds=60000) {
  const end = performance.now()+milliseconds;
  return () => { const remaining = Math.floor(end-performance.now()); demand(remaining>0,'native_deadline'); return remaining; };
}
async function protectedRead(pin, maximum, remaining) {
  demand(nativePath(pin.path) && sha(pin.sha256),'protected_pin');
  const parents=[];
  for(let p=dirname(pin.path);;p=dirname(p)) {
    remaining();const info=await lstat(p,{bigint:true});
    demand(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===0n&&!(info.mode&0o022n),'protected_parent');
    parents.push([p,info.dev,info.ino]);if(p==='/')break;
  }
  const fd=await open(pin.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stamp=s=>[s.dev,s.ino,s.size,s.uid,s.mode,s.nlink,s.ctimeNs,s.mtimeNs].join(':');
  try {
    const before=await fd.stat({bigint:true});
    demand(before.isFile()&&before.uid===0n&&before.nlink===1n&&!(before.mode&0o022n)
      &&before.size>0n&&before.size<=BigInt(maximum),'protected_file');
    const bytes=Buffer.alloc(Number(before.size)+1);let n=0;
    while(n<bytes.length){remaining();const r=await fd.read(bytes,n,Math.min(65536,bytes.length-n),null);if(!r.bytesRead)break;n+=r.bytesRead;}
    demand(n===Number(before.size)&&stamp(before)===stamp(await fd.stat({bigint:true}))
      &&stamp(before)===stamp(await lstat(pin.path,{bigint:true})),'protected_file_changed');
    for(const [p,dev,ino] of parents){remaining();const s=await lstat(p,{bigint:true});demand(s.isDirectory()&&!s.isSymbolicLink()
      &&s.uid===0n&&!(s.mode&0o022n)&&s.dev===dev&&s.ino===ino,'protected_parent_changed');}
    const raw=bytes.subarray(0,n);demand(hash(raw)===pin.sha256,'protected_digest');return raw;
  }finally{await fd.close();}
}
async function save(directory,name,value,remaining) {
  demand(nativePath(directory)&&/^[a-z-]+\.json$/.test(name),'output_path');
  for(let p=directory;;p=dirname(p)){remaining();const s=await lstat(p);demand(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022),'output_parent');if(p==='/')break;}
  demand(((await lstat(directory)).mode&0o777)===0o700,'private_output');
  const parent=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const fd=await open('/proc/self/fd/'+parent.fd+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{const raw=Buffer.from(JSON.stringify(value)+'\n');demand(raw.length<=4194304,'output_budget');remaining();await fd.writeFile(raw);await fd.sync();}
    finally{await fd.close();}
    await parent.sync();remaining();
  }finally{await parent.close();}
}
export async function runDedicatedImport(args=process.argv.slice(2), diagnosticContext={stage:'job'}) {
  demand(process.platform==='linux'&&process.geteuid?.()===0,'native_root_required');
  demand(args.length===4&&args[0]==='--job'&&args[2]==='--job-sha256','arguments');
  const remaining=deadline();
  const job=validateDedicatedImportJob(JSON.parse(await protectedRead({path:args[1],sha256:args[3]},65536,remaining)));
  diagnosticContext.stage='seed';
  const rawSeed=await protectedRead(job.seed,4194304,remaining);
  await protectedRead(job.runtimeModule,4194304,remaining);await protectedRead(job.sourceFence,1048576,remaining);
  diagnosticContext.stage='runtime_load';
  const module=await import(pathToFileURL(job.runtimeModule.path).href);remaining();
  diagnosticContext.stage='plan';
  const plan=module.createReviewedPostgresAddressOnlyImportPlan({rawSeed:rawSeed.toString('utf8'),review:job.review,
    trustedReviewSha256:module.postgresCohortImportFingerprint(job.review)});
  if(job.action==='plan') return {status:'address-only-plan-hashed-not-imported',operationId:job.operationId,
    importId:plan.importId,generationId:plan.generationId,planSha256:plan.planSha256,
    walletCount:plan.profiles.length,entityCount:new Set(plan.profiles.map(p=>p.entityId)).size,
    databaseImported:false,businessReleaseSwitched:false,gatewayDeliveryEnabled:false};
  diagnosticContext.stage='publication';
  const publicationNames=job.action==='prepare' ? ['prepared-address-only-manifest.json','preparation-receipt.json']
    : ['address-only-manifest.json','import-receipt.json'];
  for(const name of publicationNames) {
    try { await lstat(job.outputDirectory+'/'+name); demand(false,'publication_already_exists'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  const measureSourceFence=async()=>withDiagnosticStage(diagnosticContext,'fence_measure',async()=>{
    await protectedRead(job.sourceFence,1048576,remaining);
    let stdout;
    try {
      ({stdout}=await execute('/usr/bin/python3',['-I','-B',job.sourceFence.path,'--measure','--operation-id',job.operationId],
        {timeout:Math.min(10000,remaining()),maxBuffer:65536,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}));
    } catch(error) {throw fenceMeasureFailure(error);}
    remaining();const observed=JSON.parse(stdout);
    demand(observed.operationId===job.operationId&&observed.sourceSealed===true
      &&observed.binding?.importId===plan.importId&&observed.binding?.generationId===plan.generationId
      &&observed.binding?.planSha256===plan.planSha256&&sha(observed.backupSha256)&&sha(observed.fenceSha256),'native_fence_measurement');
    return {backupSha256:observed.backupSha256,fenceSha256:observed.fenceSha256,
      gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false};
  });
  const measured=await measureSourceFence();
  const cohortSha256=module.addressOnlyCohortDigest(plan.profiles.map(p=>({subject_key:p.subjectKey,entity_id:p.entityId,
    wallet_family:p.profile.fact.walletFamily,profile_payload:p.profilePayload,import_id:plan.importId,observed_at:p.observedAt})));
  const manifest={protocol:'address-only-v1',operationId:job.operationId,importId:plan.importId,generationId:plan.generationId,
    activatedAt:job.activatedAt,planSha256:plan.planSha256,seedSha256:job.seed.sha256,cohortSha256,
    walletCount:plan.profiles.length,entityCount:new Set(plan.profiles.map(p=>p.entityId)).size,
    releaseSha256:job.releaseSha256,backupSha256:measured.backupSha256,fenceSha256:measured.fenceSha256,
    target:{database:job.target.database,schema:job.target.schema,schemaFingerprint:job.target.schemaFingerprint,
      systemIdentifier:job.target.systemIdentifier,serverAddress:job.target.serverAddress,serverPort:job.target.serverPort},
    gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false};
  if(job.action==='prepare') {
    await save(job.outputDirectory,'prepared-address-only-manifest.json',manifest,remaining);
    const receipt={status:'address-only-native-prepared-not-imported',operationId:job.operationId,
      planSha256:plan.planSha256,walletCount:manifest.walletCount,entityCount:manifest.entityCount,
      generationId:plan.generationId,databaseImported:false,businessReleaseSwitched:false,gatewayDeliveryEnabled:false};
    await save(job.outputDirectory,'preparation-receipt.json',receipt,remaining);return receipt;
  }
  diagnosticContext.stage='credential';
  const credential=JSON.parse(await protectedRead(job.credential,16384,remaining));
  demand(credential.host==='127.0.0.1'&&credential.port===5432&&credential.database===job.target.database
    &&credential.user===job.target.username&&typeof credential.password==='string'&&credential.password.length>=32
    &&credential.expiresAtMs>Date.now()+Math.min(job.budget.maximumTransactionMs,remaining()),'fresh_credential_required');
  diagnosticContext.stage='pg_load';
  await protectedRead(job.pgModule,1048576,remaining);
  const {default:pg}=await import(pathToFileURL(job.pgModule.path).href);remaining();
  const pool=new pg.Pool({host:credential.host,port:credential.port,database:credential.database,user:credential.user,
    password:credential.password,max:1,connectionTimeoutMillis:job.limits.connectionTimeoutMs,
    query_timeout:Math.min(job.limits.operationTimeoutMs,remaining()),idleTimeoutMillis:1000,
    application_name:'address-only-v1:'+job.operationId});
  const expiresAtMs=Math.min(job.budget.deadlineAtMs,credential.expiresAtMs,Date.now()+remaining());
  let receipt, runtimeOwnsPool=false;
  try {
    diagnosticContext.stage='runtime_execute';
    receipt=await module.executeDedicatedAddressOnlyMigration({target:job.target,plan,manifest,
      onRuntimeClaimed:()=>{runtimeOwnsPool=true;},
      migrationRuntime:{pool,limits:job.limits,assertAuthorized:async request=>withDiagnosticStage(diagnosticContext,'runtime_authority',async()=>{
        remaining();demand(request.capability.mode==='approved_cutover'&&request.capability.purpose==='business_import'
          &&request.capability.planSha256===plan.planSha256&&request.capability.approvalRef===plan.approvalRef
          &&request.target.systemIdentifier===job.target.systemIdentifier,'native_runtime_authority');
        await measureSourceFence();
      })},
      capability:{kind:'approved_cutover',purpose:'cohort_projection',authorizationRef:plan.approvalRef,
        target:Object.fromEntries(Object.entries(job.target).filter(([k])=>k!=='systemIdentifier')),planSha256:plan.planSha256,expiresAtMs},
      budget:{...job.budget,deadlineAtMs:expiresAtMs},assertAuthorized:async request=>withDiagnosticStage(diagnosticContext,'import_authority',async()=>{
        remaining();demand(request.planSha256===plan.planSha256&&request.generationId===plan.generationId
          &&request.approvalRef===plan.approvalRef,'native_import_authority');
      }),measureSourceFence,releaseSha256:job.releaseSha256});
  }finally{if(!runtimeOwnsPool)await pool.end();}
  // A publication failure after acknowledged COMMIT must be reconciled, never treated as an absent import.
  diagnosticContext.stage='receipt';
  await save(job.outputDirectory,'address-only-manifest.json',manifest,remaining);
  await save(job.outputDirectory,'import-receipt.json',receipt,remaining);
  return {status:'address-only-native-import-committed',operationId:job.operationId,
    walletCount:manifest.walletCount,entityCount:manifest.entityCount,generationId:plan.generationId,
    planSha256:plan.planSha256,cohortSha256,databaseImported:true,businessReleaseSwitched:false,gatewayDeliveryEnabled:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const context={stage:'job'};
  runDedicatedImport(process.argv.slice(2),context).then(value=>console.log(JSON.stringify(value)),error=>{
    console.log(JSON.stringify(sanitizedImportFailure(error,context.stage)));process.exitCode=1;
  });
}
