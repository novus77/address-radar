import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const demand=(value,reason)=>{if(!value)throw new Error(reason);};
const digest=value=>createHash('sha256').update(value).digest('hex');
async function protectedRead(path,maximum,expected) {
 demand(resolve(path)===path,'absolute_path_required');
 for(let p=dirname(path);;p=dirname(p)) {
  const s=await lstat(p);demand(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022),'unprotected_parent');
  if(p==='/')break;
 }
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
 try {
  const before=await fd.stat();demand(before.isFile()&&before.uid===0&&before.nlink===1&&!(before.mode&0o077)&&before.size<=maximum,'unprotected_input');
  const bytes=Buffer.alloc(before.size+1);let size=0;
  while(size<bytes.length){const r=await fd.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
  demand(size===before.size&&stamp(before)===stamp(await fd.stat())&&stamp(before)===stamp(await lstat(path)),'input_changed');
  const body=bytes.subarray(0,size);if(expected)demand(digest(body)===expected,'digest_mismatch');return body;
 } finally {await fd.close();}
}
async function writeExclusive(path,value) {
 const fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try {await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}
}
export async function main(args=process.argv.slice(2)) {
 demand(process.platform==='linux'&&process.geteuid?.()===0,'native_root_required');
 demand(args.length===2&&args[0]==='--directory'&&/^\/var\/lib\/address-radar-maintenance-tools\/address-only-import-[0-9a-f]{64}$/.test(args[1]),'invalid_arguments');
 const directory=args[1],pin=directory.slice(directory.lastIndexOf('-')+1);
 demand(await realpath(directory)===directory,'directory_symlink');
 const code=await protectedRead(directory+'/cohort.mjs',1048576,pin);
 const seedPath='/var/backups/address-radar/address-only-seed-20261007.json';
 const raw=await protectedRead(seedPath,4194304,'ff639371c3417c8431bbc455f7d1393e5a794b1b28119c2a1081b1abc8647817');
 const module=await import(pathToFileURL(directory+'/cohort.mjs').href);
 const review={importId:'address-only-20261007',approvalRef:'user-confirmed-address-only-migration-20261007',
  actorId:'production-migration-operator',actorAuthorizationRef:'user-confirmed-address-only-scope-20261007',
  generationId:'production-20261006-v1',importedAt:Date.now(),seedSha256:digest(raw)};
 const plan=module.createReviewedPostgresAddressOnlyImportPlan({rawSeed:raw.toString('utf8'),review,
  trustedReviewSha256:module.postgresCohortImportFingerprint(review)});
 demand(plan.profiles.length===216&&new Set(plan.profiles.map(p=>p.entityId)).size===122,'source_counts_changed');
 const receipt={status:'address-only-plan-prepared-not-imported',codeSha256:digest(code),sourceSha256:digest(raw),planSha256:plan.planSha256,
  wallets:plan.profiles.length,entities:new Set(plan.profiles.map(p=>p.entityId)).size,
  monitoringPolicies:[...new Set(plan.profiles.map(p=>p.profile.monitoringPolicy))],
  databaseConnected:false,productionImportAdmitted:false,backendChanged:false,gatewayDeliveryEnabled:false};
 await writeExclusive(directory+'/review.json',review);
 await writeExclusive(directory+'/prepared-plan.json',plan);
 await writeExclusive(directory+'/preparation-receipt.json',receipt);
 return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 main().then(result=>console.log(JSON.stringify(result)),()=>{console.log('{"status":"refused","databaseConnected":false,"backendChanged":false}');process.exitCode=1;});
}
