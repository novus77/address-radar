import {readFile,lstat} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
const ORIGINAL='2750b013c1aab325717ab934e38c490ec41b625ff3757d0fa9b30e471875ca5b';
const CANDIDATE='7d33863ac425f4531ceb9c036cdadbe3ddf8768570899b6311a42088e5f08278';
const PREFIX='1da609302e537321d2ab5cfdc68372fbe178e44fd1f1b2a57f8536247aae86e9';
const HEAD='b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383';
const demand=(v,c)=>{if(!v)throw Error(c);};
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export function guardExistingSchemaExecutor(executor,verify){return {run:work=>executor.run(async tx=>{await verify(tx);return work(tx);})};}
export function verifyServiceUpgradeLedger(base,plan,approvalRef,ledger,verifyBase){
 demand(ledger&&ledger.owner===base.targetPins.roleOid&&Array.isArray(ledger.history)&&ledger.history.length===3,'upgrade_ledger_incomplete');
 demand(verifyBase(base,{...ledger,history:ledger.history.slice(0,1)})===PREFIX,'v1_prefix_changed');
 for(let i=1;i<3;i++){const r=ledger.history[i],p=plan.migrations[i];demand(r.version===p.version&&r.fingerprint===p.fingerprint&&r.previous_fingerprint===p.previousFingerprint&&r.modules_json===JSON.stringify(p.modules)&&r.installed_by===base.target.username&&r.approval_ref===approvalRef,'append_receipt_changed');}
 return digest(ledger);
}
export async function runServiceSchemaUpgrade(plan,ports,mode){
 demand(['apply','reconcile'].includes(mode),'invalid_upgrade_mode');const boundary=await ports.guard();let j=await ports.load();
 if(!j){demand(mode==='apply','missing_upgrade_intent');j={version:1,operationId:plan.operationId,planSha256:plan.planSha256,boundary,pending:'append-2-3',ledgerSha256:null};await ports.save(j);}
 else {demand(j.version===1&&j.operationId===plan.operationId&&j.planSha256===plan.planSha256&&canonical(j.boundary)===canonical(boundary),'upgrade_intent_changed');demand(j.pending===null||j.pending==='append-2-3','unknown_upgrade_pending');demand(Object.keys(j).sort().join(',')===['version','operationId','planSha256','boundary','pending','ledgerSha256'].sort().join(','),'unknown_upgrade_intent_fields');demand((j.pending==='append-2-3'&&j.ledgerSha256===null)||(j.pending===null&&/^[a-f0-9]{64}$/.test(j.ledgerSha256)),'invalid_upgrade_intent');if(j.pending)demand(mode==='reconcile','explicit_reconcile_required');}
 if(mode==='apply'&&j.pending){demand(canonical(await ports.guard())===canonical(boundary),'preappend_epoch_changed');try{await ports.install();}catch{throw Error('upgrade_pending_preserved');}}
 try{const sha=ports.verify(await ports.readLedger());demand(canonical(await ports.guard())===canonical(boundary),'upgrade_epoch_changed');if(j.ledgerSha256!==null)demand(j.ledgerSha256===sha,'upgrade_receipt_changed');await ports.save({...j,pending:null,ledgerSha256:sha});return {status:mode==='reconcile'?'service_schema_reconciled':'service_schema_upgraded',ledgerSha256:sha,schemaVersion:3,productionMigrationReady:false,otherRolesLogin:false,backendChanged:false,businessActivation:false,dataImported:false};}
 catch{throw Error('upgrade_pending_preserved');}
}

export async function collectProductionRoleAcl(tx,{schema,roles}){
 demand(Array.isArray(roles)&&roles.length===7&&new Set(roles).size===7,'seven_roles_required');
 const result=await tx.query(`SELECT current_setting('transaction_read_only')='on' AS readonly,
 (SELECT count(*)::int FROM pg_roles WHERE rolname=ANY($1::text[])) AS role_count,
 COALESCE((SELECT jsonb_agg(x ORDER BY x.rolname) FROM (
 SELECT r.rolname,r.oid::text AS oid,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,r.rolconnlimit,
 has_database_privilege(r.oid,current_database(),'CONNECT') AS connect,
 has_database_privilege(r.oid,current_database(),'CREATE') AS database_create,
 has_database_privilege(r.oid,current_database(),'TEMP') AS database_temp,
 (SELECT count(*)::int FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'SET')) AS reachable_role_count,
 ARRAY(SELECT other.rolname FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'SET') ORDER BY other.rolname LIMIT 257) AS reachable_roles,
 (SELECT count(*)::int FROM pg_namespace n WHERE n.nspname<>$2 AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND (n.nspowner=r.oid OR has_schema_privilege(r.oid,n.oid,'CREATE'))) AS other_schema_authority,
 (SELECT count(*)::int FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND f.prosecdef AND has_function_privilege(r.oid,f.oid,'EXECUTE')) AS callable_security_definers,
 ARRAY(SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relkind='r' AND has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ORDER BY c.relname LIMIT 257) AS target_table_write_paths,
 (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relkind='r') AS target_table_count,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'privilege',v) ORDER BY c.relname,a.attname,v)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 CROSS JOIN unnest(ARRAY['INSERT','UPDATE','REFERENCES']) v WHERE n.nspname=$2
 AND c.relname=ANY($3::text[]) AND has_column_privilege(r.oid,c.oid,a.attnum,v)),'[]'::jsonb) AS authority_column_write_paths
 FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname LIMIT 8) x),'[]'::jsonb) AS roles`,[roles,schema,['business_schema_identity','business_schema_ledger','migration_cutover_transitions','migration_cutover_transitions_v2','migration_cutover_first_write_markers','wallet_service_import_ledger','wallet_service_profile_cohort','wallet_service_profile_versions','wallet_service_fact_inputs','wallet_service_fact_validators','wallet_service_fact_attestations']]);
 const row=result.rows[0];demand(result.rows.length===1&&row?.readonly===true&&row.role_count===7&&Array.isArray(row.roles)&&row.roles.length===7,'readonly_acl_measurement_incomplete');
 demand(Buffer.byteLength(canonical(row))<=1048576&&row.roles.every(r=>r.reachable_role_count<=256&&r.target_table_count<=256),'acl_measurement_budget');
 return {transactionReadOnly:true,roles:row.roles,receiptSha256:digest(row),observationsAuthenticated:false};
}

export async function loadOriginal(path,maximumMs){
 demand(typeof path==='string'&&resolve(path)===path&&path!=='/','absolute_original_entry_required');
 // Bootstrap only the reviewed original source; all protected artifacts then use its fd-bound reader.
 const {open,constants}=await import('node:fs');
 const fs=await import('node:fs/promises');
 for(let p=dirname(path);;p=dirname(p)){const s=await fs.lstat(p,{bigint:true});demand(s.isDirectory()&&s.uid===0n&&!(s.mode&0o022n),'unsafe_code_ancestor');if(p==='/')break;}
 const h=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let source;try{const s=await h.stat({bigint:true});demand(s.isFile()&&s.uid===0n&&s.gid===0n&&s.nlink===1n&&!(s.mode&0o022n)&&s.size<=1048576n,'unsafe_original_code');const b=Buffer.alloc(Number(s.size)+1);const r=await h.read(b,0,b.length,0);const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');demand(r.bytesRead===Number(s.size)&&stamp(s)===stamp(await h.stat({bigint:true}))&&stamp(s)===stamp(await fs.lstat(path,{bigint:true})),'original_code_changed');source=b.subarray(0,r.bytesRead);demand(createHash('sha256').update(source).digest('hex')===ORIGINAL,'original_code_pin_changed');}finally{await h.close();}
 let text=source.toString('utf8');
 const needle='const install = createSchemaInstaller(uowModule, schemaModule, guardedPool, candidate);';demand(text.split(needle).length===2,'shared_port_contract_changed');
 text=text.replace(needle,'const install = () => globalThis.__radarServiceSchemaAppend(uowModule,guardedPool,candidate);');
 text=text.replace('[candidate.schemaPlan.migrations.length + 1]','[4]');
 text=text.replace('const boundary = client => measureBoundary(candidate, client, rootBoundary);',"const boundary = async client => {const result=await measureBoundary(candidate,client,rootBoundary);if(globalThis.__radarSchemaExpectedBoundary)requireThat(canonical(result)===canonical(globalThis.__radarSchemaExpectedBoundary),'upgrade_epoch_changed');return result;};");
 text=text.replace("if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {",'if (false) {');
 text+='\nexport {nativePorts, boundedFile, storage, protectedAncestors};\n';
 return import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
}
export async function upgradeStorage(path,remaining,mode,shared){
 const fs=await import('node:fs/promises');const {constants}=await import('node:fs');const {basename}=await import('node:path');
 demand(['apply','reconcile'].includes(mode)&&resolve(path)===path,'invalid_storage_scope');
 const parent=dirname(path),bind=await shared.protectedAncestors(parent);const parentFd=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 let directory;
 try{
  await bind();const ps=await parentFd.stat({bigint:true}),pn=await fs.lstat(parent,{bigint:true});demand(ps.dev===pn.dev&&ps.ino===pn.ino,'state_parent_changed');
  const anchored='/proc/self/fd/'+parentFd.fd+'/'+basename(path);
  if(mode==='apply')await fs.mkdir(anchored,{mode:0o700});
  directory=await fs.open(anchored,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const original=await directory.stat({bigint:true});demand(original.isDirectory()&&original.uid===0n&&original.gid===0n&&(original.mode&0o777n)===0o700n,'unsafe_upgrade_state');await bind();
  const current=await fs.lstat(path,{bigint:true});demand(current.dev===original.dev&&current.ino===original.ino,'upgrade_state_changed');
  const fdPath='/proc/self/fd/'+directory.fd;
  const check=async()=>{remaining();await bind();const s=await directory.stat({bigint:true}),n=await fs.lstat(path,{bigint:true});demand(s.dev===original.dev&&s.ino===original.ino&&s.uid===0n&&s.gid===0n&&(s.mode&0o777n)===0o700n&&n.dev===s.dev&&n.ino===s.ino,'upgrade_state_changed');};
  const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
  return {
   load:async()=>{await check();let h;try{h=await fs.open(fdPath+'/journal.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(e.code==='ENOENT'&&mode==='apply')return null;throw e;}
    try{const s=await h.stat({bigint:true});demand(s.isFile()&&s.uid===0n&&s.gid===0n&&(s.mode&0o777n)===0o600n&&s.nlink===1n&&s.size<=65536n,'unsafe_upgrade_journal');const b=Buffer.alloc(Number(s.size)+1);let size=0;while(size<b.length){remaining();const r=await h.read(b,size,b.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}demand(size===Number(s.size)&&stamp(s)===stamp(await h.stat({bigint:true}))&&stamp(s)===stamp(await fs.lstat(fdPath+'/journal.json',{bigint:true})),'upgrade_journal_changed');const text=b.subarray(0,size).toString('utf8'),j=JSON.parse(text);demand(text===canonical(j)+'\n','noncanonical_upgrade_journal');await check();return j;}finally{await h.close();}},
   save:async j=>{await check();const name='.journal-'+randomBytes(16).toString('hex');const h=await fs.open(fdPath+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(canonical(j)+'\n');await h.sync();await check();}finally{await h.close();}await fs.rename(fdPath+'/'+name,fdPath+'/journal.json');await directory.sync();await check();},
   // The original inherited authentication flock excludes competing callers. No durable stale lock is created or removed.
   close:async()=>{try{await directory.close();}finally{await parentFd.close();}}
  };
 }catch(e){try{await directory?.close();}finally{await parentFd.close();}throw e;}
}

export async function main(args=process.argv.slice(2)){
 demand(process.platform==='linux'&&process.getuid?.()===0,'native_root_required');const a={};for(let i=0;i<args.length;i+=2){demand(['--plan','--approved-plan-sha256','--mode','--original-entry'].includes(args[i])&&args[i+1]&&!Object.hasOwn(a,args[i]),'invalid_cli');a[args[i]]=args[i+1];}
 demand(['preflight','roles','apply','reconcile'].includes(a['--mode']),'invalid_mode');const start=performance.now();let budget=180000;const remaining=()=>{const n=Math.floor(budget-(performance.now()-start));demand(n>0,'upgrade_budget_exhausted');return n;};
 const shared=await loadOriginal(a['--original-entry'],budget);const body=(await shared.boundedFile(a['--plan'],1048576,remaining)).bytes;const p=JSON.parse(body);const sha=digest(p);
 demand(a['--approved-plan-sha256']===sha,'explicit_upgrade_plan_approval_required');
 const fields=['version','operationId','approvalRef','schemaCandidate','release','serviceSchemaPlan','privateDirectory','invocationTimeoutMs','serviceRoles'];demand(Object.keys(p).sort().join(',')===fields.sort().join(',')&&p.version===1&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(p.operationId)&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(p.approvalRef)&&Number.isInteger(p.invocationTimeoutMs)&&p.invocationTimeoutMs>10000&&p.invocationTimeoutMs<=180000,'invalid_upgrade_plan');budget=p.invocationTimeoutMs;
 const serviceNames=['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'];demand(p.serviceRoles&&Object.keys(p.serviceRoles).sort().join(',')===serviceNames.sort().join(',')&&new Set(Object.values(p.serviceRoles)).size===6,'six_roles_required');
 const base=shared.validateCandidate(JSON.parse((await shared.boundedFile(p.schemaCandidate.path,1048576,remaining,p.schemaCandidate)).bytes));demand(shared.digest(base)===CANDIDATE,'installed_candidate_changed');
 demand(resolve(p.privateDirectory)===p.privateDirectory&&p.privateDirectory!==base.privateDirectory&&p.privateDirectory!==base.authenticationStateDirectory&&!p.privateDirectory.startsWith(base.authenticationStateDirectory+'/')&&!base.authenticationStateDirectory.startsWith(p.privateDirectory+'/'),'state_collision');
 demand(Object.values(p.serviceRoles).every(n=>typeof n==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(n)&&n!==base.target.username),'role_collision');
 const auth=JSON.parse((await shared.boundedFile(base.authenticationPlan.path,1048576,remaining,base.authenticationPlan)).bytes);demand(shared.digest(auth)===base.authenticationPlanSha256&&canonical(auth.provisioningPlan.serviceRoles)===canonical(p.serviceRoles),'original_roles_changed');
 demand(p.invocationTimeoutMs>=base.statementTimeoutMs&&!p.privateDirectory.startsWith(base.privateDirectory+'/')&&!base.privateDirectory.startsWith(p.privateDirectory+'/'),'state_or_budget_collision');
 const effective=shared.validateCandidate({...base,release:p.release});const inventory=await shared.releaseInventory(p.release,remaining);demand(shared.digest(inventory.entries)===p.release.inventorySha256,'service_release_changed');
 const service=await import(pathToFileURL(join(p.release.root,'apps/automation/src/postgres-service-schema.js')).href);const definition=service.createPostgresServiceSchema({protocolVersion:2});demand(definition.plan.version===3&&definition.plan.fingerprint===HEAD&&canonical(definition.plan)===canonical(p.serviceSchemaPlan),'service_plan_changed');
 const fd=process.env.SCHEMA_AUTH_LOCK_FD;demand(fd&&/^[0-9]+$/.test(fd),'original_lock_required');const fs=await import('node:fs/promises');const lock=await fs.stat('/proc/self/fd/'+fd,{bigint:true});const named=await fs.lstat(join(base.authenticationStateDirectory,'operation.lock'),{bigint:true});demand(named.isFile()&&named.uid===0n&&named.gid===0n&&(named.mode&0o777n)===0o600n&&named.nlink===1n&&named.size===0n&&lock.dev===named.dev&&lock.ino===named.ino,'original_lock_changed');
 globalThis.__radarServiceSchemaAppend=async(uow,pool,target)=>{
   const executor=guardExistingSchemaExecutor(uow.createPostgresUnitOfWork(pool,{statementTimeoutMs:target.statementTimeoutMs,lockTimeoutMs:target.lockTimeoutMs}),async tx=>{
     // Namespace must already exist: the reused installer cannot enter its CREATE SCHEMA path.
     await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`address-radar:business-schema:${base.target.database}:${base.target.schema}`]);
     const q='"'+base.target.schema+'"';const owner=(await tx.query('SELECT nspowner::text AS owner FROM pg_namespace WHERE nspname=$1',[base.target.schema])).rows;
     demand(owner.length===1&&owner[0].owner===base.targetPins.roleOid,'existing_namespace_required');
     const header=(await tx.query(`SELECT singleton,ledger_format,database_name,schema_name,generation_id,installed_by,approval_ref FROM ${q}.business_schema_identity LIMIT 2`)).rows;
     const history=(await tx.query(`SELECT version,fingerprint,previous_fingerprint,modules_json,installed_by,approval_ref FROM ${q}.business_schema_ledger ORDER BY version LIMIT 4`)).rows;
     demand(shared.verifyLedger(base,{owner:owner[0].owner,header,history})===PREFIX,'exact_v1_prefix_required');
   });
   // This legacy enum admits initialized ledger append; the mandatory in-UOW prefix guard forbids namespace creation/adoption.
   return service.installPostgresServiceSchema(executor,{target:base.target,approval:'approved-new-business-schema',approvalRef:p.approvalRef,protocolVersion:2});
 };
 const upgradeInstall=globalThis.__radarServiceSchemaAppend;
 let ports,state;try{
   ports=await shared.nativePorts(effective,remaining);const boundary=await ports.guard();globalThis.__radarSchemaExpectedBoundary=boundary;
   globalThis.__radarServiceSchemaAppend=async(uow,pool,target)=>uow.createPostgresUnitOfWork(pool,{statementTimeoutMs:target.statementTimeoutMs,lockTimeoutMs:target.lockTimeoutMs}).run(async tx=>{await tx.query('SET TRANSACTION READ ONLY');return collectProductionRoleAcl(tx,{schema:base.target.schema,roles:[base.target.username,...Object.values(p.serviceRoles)]});});
   const roleReceipt=await ports.install();
   demand(roleReceipt.transactionReadOnly===true&&roleReceipt.roles.length===7&&roleReceipt.roles.every(r=>r.rolsuper===false&&r.rolcreatedb===false&&r.rolcreaterole===false&&r.rolreplication===false&&r.rolbypassrls===false&&r.rolconnlimit===1&&r.oid===auth.targetPins.roleOids[r.rolname]&&(r.rolname===base.target.username?r.rolcanlogin===true:r.rolcanlogin===false)),'role_activation_boundary_changed');
   if(a['--mode']==='roles')return {status:'production_roles_acl_measured',boundary,...roleReceipt,productionMigrationReady:false,credentialsPrinted:false};
   globalThis.__radarServiceSchemaAppend=upgradeInstall;
   const old=await ports.readLedger();
   const verify=ledger=>verifyServiceUpgradeLedger(base,definition.plan,p.approvalRef,ledger,shared.verifyLedger);
   if(a['--mode']==='preflight'){demand(shared.verifyLedger(base,old)===PREFIX,'exact_v1_prefix_required');return {status:'service_upgrade_preflight_passed',boundary,schemaIntentWritten:false,schemaDdlExecuted:false,productionMigrationReady:false};}
   if(a['--mode']==='apply')demand(shared.verifyLedger(base,old)===PREFIX,'exact_v1_prefix_required');
   state=await upgradeStorage(p.privateDirectory,remaining,a['--mode'],shared);
   return await runServiceSchemaUpgrade({operationId:p.operationId,planSha256:sha},{...ports,...state,verify},a['--mode']);
 }finally{delete globalThis.__radarServiceSchemaAppend;delete globalThis.__radarSchemaExpectedBoundary;try{await state?.close();}finally{await ports?.close();}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(v=>console.log(JSON.stringify(v)),()=>{console.log('{"status":"refused","code":"service_upgrade_failed_preserved","productionMigrationReady":false}');process.exitCode=1;});
