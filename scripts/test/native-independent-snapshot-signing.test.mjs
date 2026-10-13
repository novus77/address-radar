import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createHash} from 'node:crypto';
import {canonical, validateRegistry, phaseOfCommitted} from '../native-independent-snapshot-signing.mjs';
const sha = raw => createHash('sha256').update(raw).digest('hex');
function fixture() {
  const scopes = [{id:'scope',kind:'operator',paths:['/source'],directions:[]}];
  const names = ['authorizationPublicKeyPem','observerPublicKeyPem','snapshotPublicKeyPem','independentCompatibilityPublicKeyPem'];
  const roles = ['operator-authorization','observer-collector','snapshot-collector','compatibility-verifier'];
  const kinds = ['authorization','census','snapshot','rollback'];
  const trust = {expectedScopesSha256:sha(canonical(scopes))};
  const authorities = roles.map((role,i) => {
    const {publicKey} = generateKeyPairSync('ed25519');
    trust[names[i]] = publicKey.export({type:'spki',format:'pem'}).toString();
    const der = publicKey.export({type:'spki',format:'der'});
    return {role,closureSigningKind:kinds[i],privateFile:role+'.private.pem',scopeIds:['scope'],
      publicKeyBase64:der.toString('base64'),fingerprintSha256:sha(der),collectorSha256:'a'.repeat(64),
      actions:i===0?['prepare','select-postgres','first-postgres-write','rollback','abort']:[],
      kinds:i===1?['census','fence']:i===2?['snapshot']:i===3?['rehearsal']:[]};
  });
  return {registry:{version:1,provenance:'new-local-operator-bootstrap',profileSha256:'b'.repeat(64),approvedPlanSha256:'c'.repeat(64),scopes,scopesSha256:trust.expectedScopesSha256,authorities},trust};
}
test('real independent keys, actual collector and exact scope pins required',()=>{
  const {registry,trust}=fixture(); validateRegistry(registry,trust,'a'.repeat(64));
  assert.throws(()=>validateRegistry(registry,trust,'d'.repeat(64)));
  registry.authorities[2].scopeIds=['unknown']; assert.throws(()=>validateRegistry(registry,trust,'a'.repeat(64)));
});
test('new local operator bootstrap is explicit, never invented external trust',()=>{
  const {registry,trust}=fixture();registry.provenance='external-reviewer';assert.throws(()=>validateRegistry(registry,trust,'a'.repeat(64)));
});
test('missing or inconsistent persisted selection never defaults before write',()=>{
  for(const value of [null,{phase:'prepared',firstPostgresWrite:null},{phase:'postgres-written',firstPostgresWrite:null}]) assert.throws(()=>phaseOfCommitted(value));
  assert.equal(phaseOfCommitted({phase:'postgres-selected',firstPostgresWrite:null}),'before-first-pg-write');
  assert.equal(phaseOfCommitted({phase:'postgres-written',firstPostgresWrite:{writeId:'measured'}}),'after-first-pg-write');
});
