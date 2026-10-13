import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileScopeProfile, seedScopeInventory} from '../migration-authority-profile-plan.mjs';
import {CONTRACT} from '../migration-authority-bootstrap.mjs';
const hash='a'.repeat(64);
function inventory() {
  const scopes=[...Array.from({length:12},(_,i)=>({id:'service-'+i,kind:'service',paths:['/source'],directions:[]})),...Array.from({length:5},(_,i)=>({id:'timer-'+i,kind:'timer',paths:['/source'],directions:[]})),...['bridge','cron','operator','deploy','external-input'].map(kind=>({id:kind,kind,paths:['/source'],directions:kind==='bridge'?['source-to-input','output-to-source']:[]}))];
  return {version:1,provenance:'new-local-operator-approved-scope-inventory',approvalId:'synthetic-test-approval',hostId:'synthetic-host',bootId:'synthetic-boot',discoverySha256:hash,scopes,unresolvedScopeIds:[],coverage:['units','timers','user-managers','cron-at','operators','deploy','external-input','bridges','fd-mmap'].map(surface=>({surface,evidenceSha256:hash,approved:true}))};
}
const entries=()=>['observer-collector','snapshot-collector','compatibility-verifier'].map(role=>({role,path:'/actual/'+role+'.mjs',sha256:hash}));
test('explicit local bootstrap roles and real-entry pins, never historical trust',()=>{
 const result=compileScopeProfile(inventory(),entries(),'b'.repeat(16),CONTRACT);
 assert.equal(result.profile.provenance,'new-local-operator-bootstrap');
 assert.equal(result.profile.roles.find(r=>r.role==='operator-authorization').actions.length,5);
 assert.equal(result.profile.roles.find(r=>r.role==='compatibility-verifier').kinds[0],'rehearsal');
 assert.equal(result.signedProofsCreated,false); assert.equal(result.nativeScopeClosureProven,false);
});
test('unknown scopes, unreviewed coverage and doc/library replacements refuse',()=>{
 const inv=inventory();inv.unresolvedScopeIds=['unknown'];assert.throws(()=>compileScopeProfile(inv,entries(),'b'.repeat(16),CONTRACT));
 inv.unresolvedScopeIds=[];inv.coverage[0].approved=false;assert.throws(()=>compileScopeProfile(inv,entries(),'b'.repeat(16),CONTRACT));
 inv.coverage[0].approved=true;const e=entries();e[0].path='/fake/README.md';assert.throws(()=>compileScopeProfile(inv,e,'b'.repeat(16),CONTRACT));
});
test('contract drift produces explicit review block, never an old hash alias',()=>{
 const changed={...CONTRACT,coordinatorSha256:'c'.repeat(64)};
 const result=compileScopeProfile(inventory(),entries(),'b'.repeat(16),changed);
 assert.equal(result.bootstrapApplyAllowed,false);assert.deepEqual(result.blockers,['BOOTSTRAP_CONTRACT_PIN_REVIEW_REQUIRED']);
 assert.equal(result.profile.contracts.coordinatorSha256,changed.coordinatorSha256);
});
test('native discovery seed preserves unknowns and protected FOMO, never asserts fence',()=>{
 const result=seedScopeInventory({readOnly:true,kind:'readonly-discovery',observedHost:'host',knownUnits:[{unit:'fomo-radar-collector.service',process:{pid:1}}],listings:{timers:[]},sourceMetadata:[{path:'/source'}],blockers:['OPERATOR_SCOPE_UNKNOWN']},hash);
 assert.equal(result.candidates[0].mustPreserveProcessIdentity,true);
 assert.deepEqual(result.unresolvedDiscoveryBlockers,['OPERATOR_SCOPE_UNKNOWN']);
 assert.equal(result.scopeApproved,false);assert.equal(result.signedProofsCreated,false);
});
