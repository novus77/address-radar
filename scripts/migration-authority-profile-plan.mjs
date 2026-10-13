#!/usr/bin/env node
/** Offline/native-readonly profile planner. Never creates keys or closes scopes. */
import * as fs from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {canonical, sha256, CONTRACT, createPlan} from './migration-authority-bootstrap.mjs';
const HASH=/^[a-f0-9]{64}$/;
const need=(v,r)=>{if(!v)throw Error(r);};
const SURFACES=['units','timers','user-managers','cron-at','operators','deploy','external-input','bridges','fd-mmap'];
const KINDS=['service','timer','bridge','cron','operator','deploy','external-input'];
const FOMO=new Set(['fomo-radar-collector.service','fomo-radar-login.service','fomo-radar-novnc.service']);
export function seedScopeInventory(report, discoverySha256) {
 need(HASH.test(discoverySha256)&&report.readOnly===true&&report.kind==='readonly-discovery','actual-discovery-input');
 need(Array.isArray(report.knownUnits)&&report.knownUnits.length<=512&&Array.isArray(report.blockers),'discovery-bound');
 const paths=report.sourceMetadata.map(s=>s.path), candidates=new Map();
 for(const unit of report.knownUnits) candidates.set(unit.unit,{id:unit.unit,kind:'service',paths,
   directions:[],observedProcess:unit.process??null,mustPreserveProcessIdentity:FOMO.has(unit.unit),reviewed:false});
 for(const timer of report.listings?.timers??[]) for(const unit of timer.units) {
   need(candidates.size<512,'candidate-bound');
   if(!candidates.has(unit)) candidates.set(unit,{id:unit,kind:unit.endsWith('.timer')?'timer':'service',paths,directions:[],reviewed:false});
 }
 return {version:1,kind:'operator-review-inventory-seed',provenance:'actual-readonly-discovery-derived',
   hostId:report.observedHost,discoverySha256,candidates:[...candidates.values()],
   requiredCoverage:SURFACES,unresolvedDiscoveryBlockers:[...report.blockers],
   scopeApproved:false,signedProofsCreated:false,fenceEstablished:false,nativeScopeClosureProven:false};
}
export function compileScopeProfile(inventory, entries, bootstrapId, contracts) {
 need(inventory.version===1&&inventory.provenance==='new-local-operator-approved-scope-inventory'
   &&typeof inventory.approvalId==='string'&&inventory.approvalId.length>0
   &&typeof inventory.hostId==='string'&&typeof inventory.bootId==='string'
   &&HASH.test(inventory.discoverySha256)&&/^[a-f0-9]{16}$/.test(bootstrapId),'explicit-inventory-approval');
 need(Array.isArray(inventory.unresolvedScopeIds)&&inventory.unresolvedScopeIds.length===0,'unresolved-scopes');
 need(Array.isArray(inventory.coverage)&&inventory.coverage.length===SURFACES.length
   &&new Set(inventory.coverage.map(c=>c.surface)).size===SURFACES.length
   &&SURFACES.every(s=>inventory.coverage.some(c=>c.surface===s&&c.approved===true&&HASH.test(c.evidenceSha256))),'reviewed-surface-coverage');
 const scopes=inventory.scopes;
 need(Array.isArray(scopes)&&scopes.length>=1&&scopes.length<=256,'scope-bound');
 for(const scope of scopes) {
   need(typeof scope.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(scope.id)
     &&KINDS.includes(scope.kind)&&Array.isArray(scope.paths)&&scope.paths.length>=1&&scope.paths.length<=32
     &&new Set(scope.paths).size===scope.paths.length
     &&scope.paths.every(p=>typeof p==='string'&&p===resolve(p)&&/^\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(p)),'scope-shape');
   need(Array.isArray(scope.directions)&&new Set(scope.directions).size===scope.directions.length
     &&(scope.kind==='bridge'?canonical([...scope.directions].sort())===canonical(['output-to-source','source-to-input']):scope.directions.length===0),'scope-directions');
 }
 need(new Set(scopes.map(s=>s.id)).size===scopes.length&&KINDS.every(k=>scopes.some(s=>s.kind===k))
   &&scopes.filter(s=>s.kind==='service').length>=12&&scopes.filter(s=>s.kind==='timer').length>=5,'full-contract-scope-inventory');
 const roles=['operator-authorization','observer-collector','snapshot-collector','compatibility-verifier'];
 need(Array.isArray(entries)&&entries.length===3&&new Set(entries.map(e=>e.role)).size===3,'entry-roles');
 for(const role of roles.slice(1)) {
   const entry=entries.find(e=>e.role===role);
   need(entry&&HASH.test(entry.sha256)&&typeof entry.path==='string'&&entry.path===resolve(entry.path)
     &&/\.(?:mjs|js|py)$/.test(entry.path),'native-entry-pin');
 }
 need(HASH.test(contracts.coordinatorSha256)&&HASH.test(contracts.closureSha256),'contract-pins');
 const profile={version:1,bootstrapId,provenance:'new-local-operator-bootstrap',contracts,
   scopes:scopes.map(s=>({id:s.id,kind:s.kind,paths:s.paths,directions:s.directions})),
   roles:roles.map((role,i)=>({role,issuerId:'new-local-operator:'+bootstrapId+':'+role,
     keyId:'local-'+bootstrapId+'-'+role,scopeIds:scopes.map(s=>s.id),
     actions:i===0?['prepare','select-postgres','first-postgres-write','rollback','abort']:[],
     kinds:i===1?['census','fence']:i===2?['snapshot']:i===3?['rehearsal']:[],
     collectorSha256:i===0?null:entries.find(e=>e.role===role).sha256}))};
 const drift=canonical(contracts)!==canonical(CONTRACT);
 const plan=drift?null:createPlan(profile);
 return {version:1,status:'unsigned-operator-bootstrap-plan',profile,profileSha256:sha256(canonical(profile)),
   scopesSha256:sha256(canonical(profile.scopes)),inventoryApprovalSha256:sha256(canonical(inventory)),
   actualCollectorEntries:entries,plan,planSha256:plan?sha256(canonical(plan)):null,
   bootstrapApplyAllowed:false,blockers:drift?['BOOTSTRAP_CONTRACT_PIN_REVIEW_REQUIRED']:[],
   operatorReviewRequired:true,nativeScopeClosureProven:false,signedProofsCreated:false,keysCreated:false};
}
function readPinned(path,pin,until,native=false,maximum=1048576) {
 need(path===resolve(path)&&HASH.test(pin),'input-pin');
 const parents=[];
 if(native) for(let p=dirname(path);;p=dirname(p)) {
   const s=fs.lstatSync(p);need(s.isDirectory()&&s.uid===0&&!(s.mode&0o022),'protected-parent');parents.push([p,s.dev,s.ino]);if(p==='/')break;
 }
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 const metadata=s=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
 try {
   const before=fs.fstatSync(fd);need(before.isFile()&&before.nlink===1&&before.size<=maximum,'input-file');
   if(native)need(before.uid===0&&!(before.mode&0o022),'protected-input');
   const buffer=Buffer.alloc(maximum+1);let amount=0;
   while(amount<buffer.length) {need(performance.now()<until,'original-deadline');const n=fs.readSync(fd,buffer,amount,buffer.length-amount,null);if(!n)break;amount+=n;}
   need(amount<=maximum&&metadata(before)===metadata(fs.fstatSync(fd))&&metadata(before)===metadata(fs.lstatSync(path)),'input-mutated');
   for(const [p,dev,ino] of parents){const s=fs.lstatSync(p);need(s.isDirectory()&&s.uid===0&&!(s.mode&0o022)&&s.dev===dev&&s.ino===ino,'parent-mutated');}
   const raw=buffer.subarray(0,amount);need(sha256(raw)===pin,'input-digest');return raw;
 }finally{fs.closeSync(fd);}
}
export function main(args=process.argv.slice(2)) {
 try {
   const until=performance.now()+30000,mode=args.shift(),options=new Map();
   need(['seed','plan'].includes(mode)&&args.length%2===0&&args.length<=30,'arguments');
   const allowed=['--discovery','--discovery-sha256','--inventory','--inventory-sha256','--entries','--entries-sha256','--bootstrap-id','--coordinator','--coordinator-sha256','--closure','--closure-sha256','--native-readonly'];
   for(let i=0;i<args.length;i+=2){need(allowed.includes(args[i])&&!options.has(args[i]),'arguments');options.set(args[i],args[i+1]);}
   const native=options.get('--native-readonly')==='true';
   if(options.has('--native-readonly'))need(native&&process.platform==='linux'&&process.geteuid?.()===0,'native-readonly-runtime');
   const json=name=>{const raw=readPinned(options.get('--'+name),options.get('--'+name+'-sha256'),until,native);const value=JSON.parse(raw);need(canonical(value)===raw.toString()||(mode==='seed'&&canonical(value)+'\n'===raw.toString()),'canonical-input');return value;};
   let result;
   if(mode==='seed')result=seedScopeInventory(json('discovery'),options.get('--discovery-sha256'));
   else {
     const inventory=json('inventory'),entries=json('entries');
     // Native mode verifies the actual approved evidence files, not bare hash assertions.
     for(const coverage of inventory.coverage) {
       need(typeof coverage.evidencePath==='string','coverage-file-required');
       readPinned(coverage.evidencePath,coverage.evidenceSha256,until,native);
     }
     readPinned(options.get('--coordinator'),options.get('--coordinator-sha256'),until,native);
     readPinned(options.get('--closure'),options.get('--closure-sha256'),until,native);
     for(const entry of entries)readPinned(entry.path,entry.sha256,until,native,16*1024*1024);
     result=compileScopeProfile(inventory,entries,options.get('--bootstrap-id'),
       {coordinatorSha256:options.get('--coordinator-sha256'),closureSha256:options.get('--closure-sha256')});
   }
   process.stdout.write(canonical({...result,entryBytesMeasured:mode==='plan',nativeProtectedReads:native})+'\n');return 0;
 }catch{process.stdout.write('{"status":"profile-plan-refused","keysCreated":false,"signedProofsCreated":false}\n');return 2;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
