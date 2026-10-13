import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose} from '../diagnose-production-schema-preflight.mjs';
const args=['--preflight','--candidate','/protected/candidate.json','--approved-candidate-sha256','approved'];
function fixture(fail){
  const calls=[];const m={boundedFile:async()=>({bytes:Buffer.from('{}')}),validateCandidate:()=>({invocationTimeoutMs:180000}),digest:()=> 'approved',
    nativePorts:async()=>{calls.push('preflight');if(fail==='initialize')throw Error('SECRET_DO_NOT_PRINT');return {
      guard:async()=>{calls.push('guard');if(fail==='guard')throw Error('live_target_changed');return {systemIdentifier:'7693392208475083526'};},
      close:async()=>calls.push('close'),install:async()=>{throw Error('FORBIDDEN_DDL');},save:async()=>{throw Error('FORBIDDEN_STATE');}};}};
  return {m,calls};
}
test('readonly preflight uses only guarded native connection and closes; never installer or state',async()=>{
  const f=fixture();const out=await diagnose(args,f.m);assert.equal(out.status,'schema_readonly_preflight_passed');
  assert.equal(out.schemaDdlExecuted,false);assert.equal(out.schemaIntentWritten,false);assert.deepEqual(f.calls,['preflight','guard','close']);
});
test('unknown exception text is never emitted',async()=>{
  const f=fixture('initialize');const out=await diagnose(args,f.m);assert.equal(out.code,'unclassified_static_failure');assert.ok(!JSON.stringify(out).includes('SECRET'));
});
test('failed boundary still closes; reports only fixed code',async()=>{
  const f=fixture('guard');const out=await diagnose(args,f.m);assert.equal(out.code,'live_target_changed');assert.deepEqual(f.calls,['preflight','guard','close']);
});
test('explicit preflight flag required before any native action',async()=>{
  const f=fixture();const out=await diagnose(args.slice(1),f.m);assert.equal(out.status,'schema_readonly_preflight_refused');assert.deepEqual(f.calls,[]);
});
