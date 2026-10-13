import {readFile,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
const base='/var/lib/address-radar-maintenance-tools';
const root=base+'/schema-v3-7c770833b894072ddca3e7c30bed776da83de36370c39b9c8876644399e88887/release';
const original=base+'/schema-closure-2750b013c1aab325717ab934e38c490ec41b625ff3757d0fa9b30e471875ca5b/install-production-postgres-business-schema.mjs';
const demand=(v,c)=>{if(!v)throw Error(c);};
export function verifyLedger(rows,plan){
 demand(rows.length===plan.migrations.length,'incomplete_ledger');
 for(const [i,r] of rows.entries()){
  const e=plan.migrations[i];demand(r.version===e.version&&r.fingerprint===e.fingerprint&&r.previous_fingerprint===e.previousFingerprint&&r.modules_json===JSON.stringify(e.modules),'ledger_mismatch');
 }
}
async function privateRead(path,maximum=1048576){
 for(let p=dirname(path);;p=dirname(p)){const s=await lstat(p);demand(s.isDirectory()&&s.uid===0&&!(s.mode&0o022),'unsafe_ancestor');if(p==='/')break;}
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const a=await h.stat();demand(a.isFile()&&a.uid===0&&a.nlink===1&&!(a.mode&0o022)&&a.size<=maximum,'unsafe_file');const b=await h.readFile();const z=await h.stat();demand(a.ino===z.ino&&a.size===z.size&&a.mtimeMs===z.mtimeMs&&a.ctimeMs===z.ctimeMs,'changed_file');return b;}finally{await h.close();}
}
async function save(path,value){const h=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(JSON.stringify(value));await h.sync();}finally{await h.close();}const d=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{await d.sync();}finally{await d.close();}}
async function main(){
 demand(process.getuid?.()===0&&process.platform==='linux','native_root_required');
 const directory=process.argv[2];demand(new RegExp('^'+base+'/address-only-auth-[a-f0-9]{16}$').test(directory),'invalid_scope');
 const credential=JSON.parse(await privateRead(join(directory,'credential.json')));
 const rotation=JSON.parse(await privateRead(join(directory,'receipt.json')));
 demand(rotation.status==='rotated-authenticated'&&credential.operationId===rotation.operationId&&credential.expiresAtMs===rotation.expiresAtMs&&credential.expiresAtMs>Date.now()+180000,'fresh_rotation_required');
 demand(credential.host==='127.0.0.1'&&credential.port===5432&&credential.database==='address_radar'&&credential.user==='address_radar_migrator','credential_target_changed');
 demand(createHash('sha256').update(await privateRead(original)).digest('hex')==='2750b013c1aab325717ab934e38c490ec41b625ff3757d0fa9b30e471875ca5b','original_code_changed');
 const m=await import(pathToFileURL(original));const started=performance.now();const remaining=()=>{const n=Math.floor(150000-(performance.now()-started));demand(n>0,'deadline');return n;};
 const release={root,inventorySha256:'1173fcffb8d735a9de4917a5d7aa8093e311edd8df21344895c751e0ca07f2d0',maximumEntries:4096,maximumBytes:134217728};
 const inventory=await m.releaseInventory(release,remaining);demand(m.digest(inventory.entries)===release.inventorySha256,'release_changed');
 const service=await import(pathToFileURL(root+'/apps/automation/src/postgres-service-schema.js'));
 const definition=service.createPostgresServiceSchema({protocolVersion:2});demand(definition.plan.fingerprint==='b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383','schema_plan_changed');
 const pg=(await import(pathToFileURL(root+'/node_modules/pg/lib/index.js'))).default;
 const uow=await import(pathToFileURL(root+'/packages/database/src/postgres-unit-of-work.js'));
 const pool=new pg.Pool({host:credential.host,port:5432,database:credential.database,user:credential.user,password:credential.password,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,query_timeout:45000,application_name:'address-only-schema-20261007'});
 const timeout=setTimeout(()=>{for(const c of pool._clients??[])c.connection?.stream?.destroy();},150000);
 try{
  const before=(await pool.query("SELECT current_database() AS database,current_user AS role,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,(pg_control_system()).system_identifier::text AS system,pg_postmaster_start_time()::text AS epoch")).rows[0];
  demand(before.database==='address_radar'&&before.role==='address_radar_migrator'&&before.database_oid==='16391'&&before.role_oid==='16384'&&before.system==='7693392208475083526','live_identity_changed');
  const current=(await pool.query('SELECT version,fingerprint,previous_fingerprint,modules_json FROM address_radar_business.business_schema_ledger ORDER BY version')).rows;
  demand(current.length===1,'unexpected_initial_versions');verifyLedger(current,{migrations:definition.plan.migrations.slice(0,1)});
  const approvalRef='user-confirmed-address-only-schema-20261007';
  await save(join(directory,'schema-intent.json'),{approvalRef,releaseSha256:release.inventorySha256,before,plan:definition.plan,commitState:'not-acknowledged'});
  const result=await service.installPostgresServiceSchema(uow.createPostgresUnitOfWork(pool,{statementTimeoutMs:40000,lockTimeoutMs:3000}),{target:{database:'address_radar',username:'address_radar_migrator',schema:'address_radar_business',generation:'production-20261006-v1',service:'migration'},approval:'approved-new-business-schema',approvalRef,protocolVersion:2});
  const rows=(await pool.query('SELECT version,fingerprint,previous_fingerprint,modules_json FROM address_radar_business.business_schema_ledger ORDER BY version')).rows;verifyLedger(rows,definition.plan);
  demand((await pool.query('SELECT pg_postmaster_start_time()::text AS epoch')).rows[0].epoch===before.epoch,'epoch_changed');
  const receipt={status:'service-schema-upgraded',operationId:credential.operationId,approvalRef,result,ledger:rows,dataImported:false,backendChanged:false,gatewayDeliveryEnabled:false};
  await save(join(directory,'schema-receipt.json'),receipt);console.log(JSON.stringify(receipt));
 }finally{clearTimeout(timeout);await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.log('{"status":"refused-preserved","retryAuthorized":false}');process.exitCode=1;});
