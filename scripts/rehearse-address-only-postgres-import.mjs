import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const base='/var/lib/address-radar-maintenance-tools';
const directory=base+'/address-only-import-663b3612f818d519b8e25b52390136285b0e8c462a5d1c6d004f151c9a933bf3';
const release=base+'/schema-v3-7c770833b894072ddca3e7c30bed776da83de36370c39b9c8876644399e88887/release';
const database='radar_rehearsal_663b3612f818d519';
const generation='address-only-rehearsal-20261007';
const demand=(value,reason)=>{if(!value)throw new Error(reason);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function read(path,maximum,pin) {
 for(let p=dirname(path);;p=dirname(p)){const s=await lstat(p);demand(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022),'unsafe_parent');if(p==='/')break;}
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=await fd.stat();demand(before.isFile()&&before.uid===0&&before.nlink===1&&!(before.mode&0o077)&&before.size<=maximum,'unsafe_input');
  const raw=Buffer.alloc(before.size+1);let n=0;while(n<raw.length){const r=await fd.read(raw,n,raw.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}
  const after=await fd.stat(),pathAfter=await lstat(path);demand(n===before.size&&after.ino===before.ino&&after.mtimeMs===before.mtimeMs&&after.ctimeMs===before.ctimeMs&&pathAfter.ino===before.ino,'input_changed');
  const body=raw.subarray(0,n);if(pin)demand(hash(body)===pin,'digest_changed');return body;
 }finally{await fd.close();}
}
async function save(name,value){const f=await open(directory+'/'+name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();}finally{await f.close();}}
async function main(){
 demand(process.platform==='linux'&&process.geteuid?.()===0&&process.argv.length===2,'native_entry_required');
 await read(directory+'/cohort.mjs',1048576,'663b3612f818d519b8e25b52390136285b0e8c462a5d1c6d004f151c9a933bf3');
 const raw=await read('/var/backups/address-radar/address-only-seed-20261007.json',4194304,'ff639371c3417c8431bbc455f7d1393e5a794b1b28119c2a1081b1abc8647817');
 const c=JSON.parse(await read(base+'/address-only-auth-bb6f653ee0b826ed/credential.json',16384));
 demand(c.host==='127.0.0.1'&&c.database==='address_radar'&&c.port===5432&&c.user==='address_radar_migrator'&&c.expiresAtMs>Date.now()+180000,'fresh_credential_required');
 const cohort=await import(pathToFileURL(directory+'/cohort.mjs').href),service=await import(pathToFileURL(release+'/apps/automation/src/postgres-service-schema.js').href);
 const {createPostgresUnitOfWork}=await import(pathToFileURL(release+'/packages/database/src/postgres-unit-of-work.js').href);
 const {default:pg}=await import(pathToFileURL(release+'/node_modules/pg/lib/index.js').href);
 const pool=new pg.Pool({host:c.host,port:c.port,database,user:c.user,password:c.password,max:1,connectionTimeoutMillis:5000,query_timeout:65000,idleTimeoutMillis:1000,application_name:'address-only-isolated-rehearsal'});
 const timer=setTimeout(()=>{for(const client of pool._clients??[])client.connection?.stream?.destroy();},150000);
 const runtime=createPostgresUnitOfWork(pool,{statementTimeoutMs:60000,lockTimeoutMs:3000});
 try{
  const target={database,username:c.user,schema:database,generation,service:'migration'};
  const live=(await pool.query('SELECT current_database() database,current_user username,(pg_control_system()).system_identifier::text system')).rows[0];
  demand(live.database===database&&live.username===c.user&&live.system==='7693392208475083526','isolated_target_mismatch');
  await save('rehearsal-intent.json',{database,schema:database,generation,productionDatabaseTouched:false,startedAt:Date.now()});
  const installed=await service.installPostgresServiceSchema(runtime,{target,approval:'approved-new-business-schema',approvalRef:'user-approved-isolated-address-only-rehearsal-20261007',protocolVersion:2});
  const importedAt=Date.now();
  const review={importId:'isolated-address-only-20261007',approvalRef:'user-approved-isolated-address-only-rehearsal-20261007',actorId:'isolated-migration-operator',
   actorAuthorizationRef:'isolated-rehearsal-only-20261007',generationId:generation,importedAt,seedSha256:hash(raw)};
  const plan=cohort.createReviewedPostgresAddressOnlyImportPlan({rawSeed:raw.toString('utf8'),review,trustedReviewSha256:cohort.postgresCohortImportFingerprint(review)});
  await save('rehearsal-plan.json',plan);
  const identity={...target,serverAddress:'127.0.0.1',serverPort:5432,schemaVersion:3,schemaFingerprint:installed.fingerprint};
  const capability={kind:'isolated',purpose:'cohort_projection',authorizationRef:plan.approvalRef,target:identity,planSha256:plan.planSha256,expiresAtMs:Date.now()+120000};
  const apply=async()=>runtime.run(async transaction=>{
   await transaction.query('SELECT set_config(\'search_path\',$1,true)',['pg_catalog,"'+database+'",pg_temp']);
   await transaction.query('INSERT INTO forward_strategy_generations(generation_id,activated_at) VALUES($1,$2) ON CONFLICT DO NOTHING',[generation,importedAt]);
   return cohort.applyReviewedPostgresCohortImportPlanInTransaction(plan,{transaction,capability,assertAuthorized:async request=>{
    demand(request.capability.kind==='isolated'&&request.capability.target.database===database&&request.capability.target.schema===database&&request.planSha256===plan.planSha256,'isolated_authority_mismatch');
   },budget:{deadlineAtMs:Date.now()+60000,maximumTransactionMs:60000,maximumQueriesPerTransaction:30000,maximumTotalQueries:30000,maximumTransactions:1,recordsPerTransaction:1000,maximumImportLagMs:86400000}});
  });
  const first=await apply(),replay=await apply();
  demand(first.stagedProfiles===216&&replay.stagedProfiles===0&&replay.checkedExistingProfiles===216,'import_or_replay_counts');
  const rows=(await pool.query('SELECT subject_key,profile_payload FROM "'+database+'".wallet_service_profile_cohort ORDER BY subject_key')).rows;
  demand(rows.length===plan.profiles.length&&rows.every((r,i)=>r.subject_key===plan.profiles[i].subjectKey&&r.profile_payload===plan.profiles[i].profilePayload),'destination_body_mismatch');
  const receipt={status:'isolated-native-address-import-passed',database,schema:database,generation,profiles:rows.length,entities:new Set(plan.profiles.map(p=>p.entityId)).size,
   replayVerified:true,bodyParityVerified:true,planSha256:plan.planSha256,productionDatabaseTouched:false,backendChanged:false,gatewayDeliveryEnabled:false};
  await save('rehearsal-receipt.json',receipt);console.log(JSON.stringify(receipt));
 }finally{clearTimeout(timer);await pool.end();}
}
main().catch(()=>{console.log('{"status":"isolated-rehearsal-refused","productionDatabaseTouched":false,"backendChanged":false}');process.exitCode=1;});
