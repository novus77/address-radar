import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthenticationRecovery, probeAuthenticationBoundary, RECOVERY_REVALIDATOR_SHA256,
  RECOVERY_CONSUMER_SHA256, measureBoundary } from '../install-production-postgres-business-schema.mjs';
const pin=(path,sha256,mode=0o500)=>({path,sha256,uid:0,gid:0,mode,device:'64769',inode:'1'});
function recovery(){return {mode:'known-pending-hba',proof:pin('/protected/proof.json','a'.repeat(64),0o600),
  producer:pin('/protected/eac.py','eac155c618a5c7854744917cf2fa1b46949e063cbd842711c28aff4da1fd77ff'),
  revalidator:pin('/protected/revalidator.py',RECOVERY_REVALIDATOR_SHA256),consumer:pin('/protected/consumer.py',RECOVERY_CONSUMER_SHA256),
  pinHelper:pin('/protected/helper.py','f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f')};}
function candidate(){return {authenticationRecovery:recovery(),python:pin('/usr/bin/python3.12','b'.repeat(64)),
  authenticationPlan:pin('/protected/auth-plan.json','c'.repeat(64)),authenticationPlanSha256:'d'.repeat(64),authenticationStateDirectory:'/protected/auth-state',
  targetPins:{systemIdentifier:'7693392208475083526',databaseOid:'16391',roleOid:'16384'},
  target:{database:'address_radar',username:'address_radar_migrator'}};}
function measured(c,full=false){return {status:full?'recovery_current_native_verified':'recovery_root_boundary_verified',
  tcpAuthenticationChecked:full,planSha256:c.authenticationPlanSha256,recoveryRecordFileSha256:c.authenticationRecovery.proof.sha256,
  originalPending:'hba',originalJournalPreserved:true,credentialRenewed:false,historicalHbaAckProved:false,
  independentSoftwareTrustIssued:false,boundary:{...c.targetPins,postmasterStart:'epoch'}};}
test('hard fixed code pins and proof root600 required; unknown mode or arbitrary producer refused',()=>{
  validateAuthenticationRecovery(recovery());
  for(const key of ['producer','consumer','revalidator','pinHelper']){const r=recovery();r[key].sha256='f'.repeat(64);assert.throws(()=>validateAuthenticationRecovery(r));}
  const r=recovery();r.proof.mode=0o644;assert.throws(()=>validateAuthenticationRecovery(r));
});
test('root probe revalidates all five artifacts and calls explicit consumer root mode, not auth ACK conversion',async()=>{
  const c=candidate(),reads=[],calls=[];
  const out=await probeAuthenticationBoundary(c,()=>1000,async(executable,args)=>{calls.push(args);return measured(c);},async(path,max)=>{reads.push([path,max]);});
  assert.equal(reads.length,5);assert.equal(reads[0][1],65536);assert.ok(calls[0].includes('--approved-record-file-sha256'));
  assert.equal(calls[0].at(-1),'root-boundary');assert.deepEqual(out,measured(c).boundary);
});
test('full pre-pool probe requires actual fresh TCP; root-only result cannot masquerade as complete proof',async()=>{
  const c=candidate();await probeAuthenticationBoundary(c,()=>1000,async()=>measured(c,true),async()=>{},'full');
  await assert.rejects(probeAuthenticationBoundary(c,()=>1000,async()=>measured(c),async()=>{},'full'),/recovery_boundary_not_measured/);
});
test('tampered raw hash, target, old ACK or fake independent trust never authorizes boundary',async()=>{
  for(const mutate of [m=>m.recoveryRecordFileSha256='f'.repeat(64),m=>m.boundary.roleOid='1',m=>m.originalPending=null,
    m=>m.credentialRenewed=true,m=>m.historicalHbaAckProved=true,m=>m.independentSoftwareTrustIssued=true]){
    const c=candidate(),m=measured(c);mutate(m);await assert.rejects(probeAuthenticationBoundary(c,()=>1000,async()=>m,async()=>{}));
  }
});
test('existing native migration session supplies TCP identity with host(inet), root probe alone is insufficient',async()=>{
  const c=candidate();let queried=false;
  const client={query:async sql=>{queried=true;assert.ok(sql.includes('host(inet_server_addr()) AS address'));
    return {rows:[{database:'address_radar',username:'address_radar_migrator',session_user:'address_radar_migrator',
      database_oid:'16391',role_oid:'16384',address:'127.0.0.1',port:5432,postmaster_start:'epoch'}]};}};
  await measureBoundary(c,client,async()=>measured(c).boundary);assert.ok(queried);
});
