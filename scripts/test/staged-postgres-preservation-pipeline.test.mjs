import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {attachSegmentedPreservationPorts,remotePython,retainedOwnerControlPython,authenticateNativeTestAdmission,readPinnedRehearsalOperationId} from '../staged-postgres-preservation-host-adapter.mjs';
import {superviseSegmentedPreservation,sourcePins,lifecycleSha256,maintenanceHelperPath} from '../run-staged-postgres-preservation-fixture.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),h='a'.repeat(64),nonce='b'.repeat(16),database='radar_rehearsal_'+nonce;
function fixture(failure) {
 let now=1000000,mono=1000000,cleanup=0,ownerClosed=0;const installed=new Map(),events=[],mappings=new Map();
 const ctx={nonce,database,schema:database+'_schema',role:database+'_migrator',systemIdentifier:'123',connectionPath:'/local/connection.json'};
 const files={runner:Buffer.from('old'),segmentedRunner:Buffer.from('native bundle'),sourceReader:Buffer.from('reader'),launcher:Buffer.from('launcher'),expiry:Buffer.from('frozen helper'),operationId:'operation'};
 const runner=sha(files.segmentedRunner);
 const binding={...ctx,root:'/tmp/'+database,owner:'c'.repeat(48),directoryDevice:1,directoryInode:2,postmasterPid:9,postmasterStart:'123',
 connectionSha256:h,runnerSha256:sha(files.runner),sourceReaderSha256:sha(files.sourceReader),expiryHelperSha256:sha(files.expiry),lifecycleSha256,maintenanceHelperPath,
 artifactRoot:'/var/lib/address-radar-rehearsal-artifacts/'+nonce,artifactOwner:'d'.repeat(48),artifactDevice:1,artifactInode:3,schemaFingerprint:h};
 let bound,expiry,independentProof;
 const base={withFixture:async fn=>{try{await fn(ctx);}finally{cleanup++;events.push('lifecycle-cleanup');}},bind:async()=>binding,verifyIdentity:async()=>binding,
 bindArtifactControl:async(_ctx,additions)=>{assert.equal(additions.artifactControlRoot,"/var/lib/address-radar-rehearsal-artifact-control/"+nonce);events.push("control-bound");},
 armExpiry:async()=>{events.push('arm');if(failure==='arm-blocked')throw Error('expiry_artifact_protocol_pending');},verifyExpiry:async(_ctx,request)=>(expiry={rootOwned:true,immutable:true,independent:true,armed:true,identitySha256:request.identitySha256,helperSha256:binding.expiryHelperSha256,expiresAtMs:request.absoluteDeadlineAtMs,recordSha256:h}),
 capture:async(_ctx,request)=>{events.push('capture');return {nonce:request.windowNonce,baselineSha256:h};},armMaintenance:async(_ctx,request)=>({...request,nonce:request.windowNonce,verified:true}),pause:async()=>({phase:'paused'}),
 verifyMaintenanceExit:async(_ctx,r)=>{events.push('pause-retire');if(failure==='pause-unresolved')throw Error('pause-unresolved');return {status:'empty',nonce:r.windowNonce,challenge:r.challenge,identitySha256:r.identitySha256};},
 restore:async(_ctx,request)=>{events.push('restore');return {nonce:request.windowNonce,status:'restored'};},record:async()=>{},
 runStage:async()=>{throw Error('old-stage-must-not-run');},verifyInvocationEmpty:async()=>{throw Error('old-proof-must-not-run');}};
 const dependencies={clock:()=>now,monotonic:()=>mono,readConnection:async()=>Buffer.from(JSON.stringify({password:'e'.repeat(64)})),
 transport:async payload=>{
  if(payload.action==='segmented-bootstrap')return {artifactControlRoot:'/var/lib/address-radar-rehearsal-artifact-control/'+nonce,artifactControlDevice:1,artifactControlInode:4,artifactLockDevice:1,artifactLockInode:5,receiptDirectory:'/var/lib/address-radar-rehearsal-artifact-control/'+nonce+'/receipts',receiptDirectoryDevice:1,receiptDirectoryInode:6};
  if(payload.action==='managed-independent-empty')return independentProof(payload);
  if(payload.action==='segmented-install') {events.push('install');if(failure==='install-interruption')throw Error('install-lost');for(const item of payload.files){assert.equal(sha(Buffer.from(item.bytesBase64,'base64')),item.sha256);assert.ok(!installed.has(item.name));installed.set(item.name,Buffer.from(item.bytesBase64,'base64'));}if(payload.prepared)events.push('prepared');return {};}
  if(payload.action==='segmented-final'||payload.action==='segmented-discard'){events.push('final-cleanup');if(failure==='partial-cleanup')return {status:'partial'};return {action:'cleanup',authority:'final',status:'deleted',deadline:expiry?.expiresAtMs/1000,private_pg:{status:'deleted'},artifacts:{status:'deleted'}};}
  throw Error('unexpected-transport');},
 routeFactory:async scope=>{bound=scope.binding;return {
 registerInvocation:async mapping=>{assert.ok(!mappings.has(mapping.invocationId));mappings.set(mapping.invocationId,mapping);},
 run:async work=>{
  const name=work.configPath.split('/').at(-1),raw=installed.get(name);assert.ok(raw);const config=JSON.parse(raw);
  events.push('stage:'+work.stage);const elapsed=Math.min(90000,work.deadlineAtMs-now-1);assert.ok(elapsed>0);now+=elapsed;mono+=elapsed;
  if(failure==='transport'&&work.stage==='import')throw Error('transport-lost');
  const metrics={physicalSqlStatements:10,commitAttempts:1,acknowledgedCommits:1,acknowledgedRollbacks:1,uncertainCommit:false,finalizeAttempts:work.stage==='finalize'?1:0,acknowledgedFinalizations:work.stage==='finalize'?1:0};
  let result,segment;
  if(work.stage==='calibrate')result={status:'calibrated',rollbackObserved:true};
  if(work.stage==='import'||work.stage==='verify') {
   const s=config.selection;segment={startChunk:s.startChunkIndex,endChunk:s.endChunkIndexExclusive,rows:s.endChunkIndexExclusive-s.startChunkIndex+(s.endChunkIndexExclusive===1548?6023033-1548:0),sourceSha256:h,targetSha256:h};
   result=work.stage==='import'?{status:'segment_imported',committedChunks:segment.endChunk-segment.startChunk,resumedChunks:0,nextChunkIndex:segment.endChunk,completed:false}:{artifactSha256:h};
  }
  if(work.stage==='finalize')result={completed:true,completionOutcome:'acknowledged'};
  if(failure==='unknown-ack'&&work.stage==='import'){metrics.acknowledgedCommits=0;metrics.uncertainCommit=true;}
  if(failure==='zero-progress'&&work.stage==='import')result.committedChunks=0;
  if(failure==='false-final'&&work.stage==='finalize')result.completionOutcome='reconciled';
  return {name:config.invocation.requestNonce+'-'+work.stage+'.proof.json',sha256:h,report:{version:2,stage:work.stage,requestNonce:config.invocation.requestNonce,configSha256:sha(raw),nativeMetrics:metrics,result,segment,parityComplete:work.stage==='finalize',counts:{tables:141,rows:6023033,chunks:1548}}};
 },
 freeze:async path=>{events.push('freeze');assert.ok(installed.has(path.split('/').at(-1)));return {sealSha256:'1'.repeat(64),freezeSha256:'2'.repeat(64),nativeMetrics:{physicalSqlStatements:40,commitAttempts:2,acknowledgedCommits:2,acknowledgedRollbacks:0,uncertainCommit:false}};},
 verifySeal:async()=>({status:'sealed',sealSha256:'1'.repeat(64)}),
 measureFreeze:async challenge=>({challenge,identitySha256:'3'.repeat(64),observedAtMs:now,measurementSha256:sha(challenge),nativeMeasurementQueries:2,writerSessionCount:0,writeAuthorityCount:0}),
 verifyEmpty:independentProof=async request=>{
  events.push('retire');if(failure==='unresolved')throw Error('managed-cgroup-unresolved');
  return {challenge:request.challenge,identitySha256:request.identitySha256,proofs:request.invocationIds.map(id=>{
   const mapping=mappings.get(id);assert.ok(mapping);const proof={managedProtocol:1,invocationId:id,requestNonce:mapping.request_nonce,role:mapping.role,unit:'radar-rehearsal-'+nonce+'-'+mapping.role+'-'+mapping.request_nonce+'.service',nativeInvocationId:'4'.repeat(32),controlGroup:'/system.slice/pinned.service',cgroupIdentity:[1,9],recordSha256:h,instanceSha256:h,cgroupPopulated:0,cgroupProcessCount:0};
   if(failure==='wrong-unit')proof.unit='wrong.service';return proof;
  })};
 },close:async()=>{ownerClosed++;events.push('owner-close');}};}};
 const ports=attachSegmentedPreservationPorts(base,{files,nativeRunnerPath:'/private/tmp/pinned.mjs',nativeRunnerSha256:runner},dependencies);
 const actualArm=ports.armExpiry;ports.armExpiry=base.armExpiry;
 return {actualArm,ports,options:{clock:()=>now,monotonic:()=>mono},events,installed,cleanup:()=>cleanup,ownerClosed:()=>ownerClosed};
}
test('concrete outer route installs all configs before arm and completes across windows with measured retirement',async()=>{
 const f=fixture();const result=await superviseSegmentedPreservation(f.ports,f.options);
 assert.equal(result.parityComplete,true);assert.ok(result.windowIndex>1);assert.equal(result.durableChunks,1548);assert.equal(result.verifiedSegments,25);
 assert.equal(f.cleanup(),1);assert.equal(f.ownerClosed(),1);assert.ok(f.events.indexOf('prepared')<f.events.indexOf('arm'));
 assert.ok(f.events.lastIndexOf('restore')<f.events.indexOf('owner-close'));assert.ok(f.events.indexOf('owner-close')<f.events.indexOf('final-cleanup'));
 assert.equal(f.events.at(-1),'lifecycle-cleanup');assert.ok(f.installed.size>1548);
});
for(const failure of ['unknown-ack','zero-progress','false-final'])test('pipeline fails clean and retires before restore: '+failure,async()=>{
 const f=fixture(failure);await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/segmented_/);
 assert.equal(f.cleanup(),1);assert.equal(f.ownerClosed(),1);assert.ok(f.events.indexOf('retire')<f.events.indexOf('restore'));assert.equal(f.events.at(-1),'lifecycle-cleanup');
});
for(const failure of ['unresolved','wrong-unit'])test('unproven managed retirement hands off watchdog without active restore: '+failure,async()=>{
 const f=fixture(failure);await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/watchdog_handoff/);
 assert.ok(!f.events.includes('restore'));assert.equal(f.cleanup(),1);assert.equal(f.ownerClosed(),1);
});
test('local transport loss is not remote child retirement',async()=>{
 const f=fixture('transport');const retire=f.ports.verifyInvocationEmpty;f.ports.verifyInvocationEmpty=async()=>{throw Error('unresolved-after-close');};
 await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/watchdog_handoff/);assert.ok(!f.events.includes('restore'));assert.equal(f.cleanup(),1);
});
test('embedded install and managed controller programs compile locally',()=>{
 for(const input of [remotePython,retainedOwnerControlPython]){const result=spawnSync('python3',['-c',"import sys;compile(sys.stdin.read(),'<fixed-controller>','exec')"],{input,encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
});

test('interrupted preseal installation invokes unarmed credential cleanup and lifecycle finally',async()=>{
 const f=fixture('install-interruption');await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/install-lost/);
 assert.ok(!f.events.includes('arm'));assert.ok(f.events.includes('final-cleanup'));assert.equal(f.cleanup(),1);
});
test('blocked arm never opens a retained route or captures maintenance',async()=>{
 const f=fixture('arm-blocked');await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/expiry_artifact_protocol_pending/);
 assert.ok(!f.events.includes('capture'));assert.equal(f.ownerClosed(),0);assert.ok(f.events.includes('final-cleanup'));assert.equal(f.cleanup(),1);
});
test('partial independent cleanup is not reported as lifecycle-confirmed completion',async()=>{
 const f=fixture('partial-cleanup');await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/final_cleanup_unconfirmed/);
 assert.equal(f.cleanup(),1);assert.equal(f.ownerClosed(),1);
});

test('native-test arm rejects unbound scope without environment bypass',async()=>{
 const f=fixture();await assert.rejects(f.actualArm({},{}),/native_test_scope/);
 assert.ok(!f.events.includes('arm'));assert.equal(f.cleanup(),0);
});


test('unresolved remote maintenance pause cannot overlap active restoration',async()=>{
 const f=fixture('pause-unresolved');await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/watchdog_handoff_maintenance_exit_unproven/);
 assert.ok(!f.events.includes('restore'));assert.equal(f.cleanup(),1);
});
test('every maintenance pause retires independently before active restoration',async()=>{
 const f=fixture();await superviseSegmentedPreservation(f.ports,f.options);
 let retired=false;for(const event of f.events){if(event==='pause-retire')retired=true;if(event==='restore'){assert.equal(retired,true);retired=false;}}
});


test('segmented retirement cannot fall back to legacy unit receipts',async()=>{
 const f=fixture();const original=f.ports.verifyInvocationEmpty;
 f.ports.verifyInvocationEmpty=async(...args)=>{const proof=await original(...args);for(const item of proof.proofs){delete item.managedProtocol;item.unit='address-radar-preservation-invocation-'+nonce+'-'+item.invocationId+'.service';}return proof;};
 await assert.rejects(superviseSegmentedPreservation(f.ports,f.options),/watchdog_handoff_producer_exit_unproven/);
 assert.ok(!f.events.includes('restore'));
});
test('preseal native control identity is bound before installing immutable configs',async()=>{
 const f=fixture();await superviseSegmentedPreservation(f.ports,f.options);
 assert.ok(f.events.indexOf('control-bound')<f.events.indexOf('install'));
});

test('native maintenance retirement rejects unsettled jobs and changing cgroup observations',()=>{
 const input=JSON.stringify(remotePython);
 const program=`import ast,json,sys
source=json.loads(sys.stdin.read());tree=ast.parse(source)
selected=ast.Module(body=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='invocation_empty'],type_ignores=[])
def need(ok,reason):
 if not ok:raise RuntimeError(reason)
record={'unit':'exact.service','maintenanceAction':'pause'}
instance={}
def invocation_load(_):return record,instance,'a'*64,'b'*64
def invocation_props(*_):return {'ActiveState':'active','SubState':'exited'}
observations=[(0,[]),(0,[])]
def cgroup_status(*_):return observations.pop(0)
def maintenance_jobs_settled(_):return True
namespace=globals();exec(compile(selected,'<native-retirement>','exec'),namespace)
proof=invocation_empty('invocation');assert proof['jobsSettled'] and proof['cgroupPopulated']==0
observations=[(0,[])]
def maintenance_jobs_settled(_):raise RuntimeError('maintenance_jobs_unsettled')
try:invocation_empty('invocation');raise AssertionError('unsettled jobs accepted')
except RuntimeError as error:assert str(error)=='maintenance_jobs_unsettled'
def maintenance_jobs_settled(_):return True
observations=[(0,[]),(1,[99])]
try:invocation_empty('invocation');raise AssertionError('changed cgroup accepted')
except RuntimeError as error:assert str(error)=='producer_exit_changed'
`;
 const result=spawnSync('python3',['-c',program],{input,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});


test('native-test admission is not full acceptance and binds fixed source and private role',()=>{
 const ctx={nonce,database,schema:database+'_schema',role:database+'_migrator',systemIdentifier:'123'};
 const proof={status:'native-test-admitted',nativeAcceptance:'pending',scope:'fixed-immutable-rehearsal-private-pg16',nonce,identitySha256:h,
 source:{path:'/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle/manifest.json',manifestSha256:sourcePins.manifestSha256,operationId:'operation',seal:{fileCount:1549,rootDevice:1,rootInode:2,rootImmutableFlags:16}},
 target:{database,port:5434,systemIdentifier:'123',role:ctx.role,schemaOwner:ctx.role,connectionLimit:1,memberships:0,superuser:false,createDatabase:false,createRole:false,replication:false,bypassRls:false}};
 assert.equal(authenticateNativeTestAdmission(proof,{ctx,identitySha256:h,operationId:'operation'}),proof);
 for(const mutate of [p=>p.target.port=5432,p=>p.target.superuser=true,p=>p.target.memberships=1,p=>p.nativeAcceptance='accepted',p=>p.source.operationId='other',p=>p.source.manifestSha256='0'.repeat(64),p=>p.target.schemaOwner='postgres',p=>p.source.seal.fileCount=1,p=>p.source.seal.rootImmutableFlags=0]){
  const changed=structuredClone(proof);mutate(changed);assert.throws(()=>authenticateNativeTestAdmission(changed,{ctx,identitySha256:h,operationId:'operation'}),/admission_unverified/);
 }
});
test('operationId lookup is bounded fixed-source transport with no fixture or arm',async()=>{
 let payload;const value={path:'/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle/manifest.json',manifestSha256:sourcePins.manifestSha256,operationId:'actual-source-operation'};
 const result=await readPinnedRehearsalOperationId({transport:async(p,timeout)=>{payload=p;assert.equal(timeout,30000);return value;}});
 assert.equal(result.operationId,value.operationId);assert.equal(payload.action,'source-operation-id');assert.equal(payload.operationSeconds,20);
 await assert.rejects(readPinnedRehearsalOperationId({transport:async()=>({...value,manifestSha256:h})}),/source_operation_receipt/);
});
