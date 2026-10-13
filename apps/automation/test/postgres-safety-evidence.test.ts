import { describe, expect, it, vi } from 'vitest';
import { createPostgresSafetyEvidenceValidator, createPostgresSafetyEvidencePublisher, safetyEvidenceFingerprint,
  type PostgresSafetyEvidence } from '../src/postgres-safety-evidence.js';
const at=100000, hash='a'.repeat(64);
function fixture() {
  const target={channel:'wallet',entityId:'entity',walletFamily:'evm',subjectId:'0x'+'1'.repeat(40),
    ownershipEvidenceRef:'owner',associationConfidence:'confirmed',associationSource:'manual',ownerCount:1,
    walletConfidence:'confirmed',walletSource:'manual',identityEvidenceRef:'identity',monitoringEnabled:true,suspended:false} as any;
  const profile={wallet:{address:target.subjectId,entityId:'entity',accountId:'account',chainFamily:'evm'},fact:target,
    profileEnabled:true,profileSuspended:false,bindingState:'owned',versionId:'target-version'} as any;
  const evidence:PostgresSafetyEvidence={protocol:'address-only-safety-evidence-v1',kind:'risk',generationId:'gen',sampleId:'sample',
    executionFingerprint:hash,revision:{state:'original',executionFingerprint:hash},target,targetVersionId:'target-version',
    chain:'bsc',tokenAddress:'0x'+'2'.repeat(40),boughtAt:90000,provenance:{providerId:'provider',sourceRef:'proof:reference',
      contentSha256:hash,observedAt:99000,knownAt:99500},coverage:{status:'complete',scope:'declared-scope',from:80000,until:99000},
    conflict:'none',observations:{evidenceRef:'actual-proof'}};
  const query=vi.fn(async (_sql: string, _values?: readonly unknown[])=>({rows:[{sample_id:'sample',entity_id:'entity',chain:'bsc',token_address:evidence.tokenAddress,occurred_at:'90000',
    execution_fingerprint:hash,original_fingerprint:hash,revision_state:'original',ownership_evidence_ref:'owner'}],rowCount:1}));
  const load=vi.fn(async ()=>({status:'ready' as const,profiles:[profile]}));
  const inspect=vi.fn(async ({fingerprint}:any)=>({status:'verified' as const,evidenceFingerprint:fingerprint,disposition:'unknown' as const}));
  const options={generationId:'gen',maximumPayloadBytes:100000,maximumEvidenceAgeMs:10000,maximumProfiles:10,maximumRunMs:1000,
    reviewedProviderIds:['provider'],now:()=>at,run:async(fn:any)=>fn({query}),profiles:{load},independentlyInspect:inspect};
  return {evidence,profile,query,load,inspect,options};
}
describe('pending-only safety evidence foundation',()=>{
  it('keeps complete exact-bound evidence pending without inventing safe or independence',async()=>{
    const f=fixture(),r=await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal});
    expect(r).toMatchObject({status:'pending',reasonCode:'safety_decision_policy_unconfirmed',bindingVerified:true});
    expect(r).not.toHaveProperty('independenceKey');expect(r).not.toHaveProperty('validation');
    expect(f.query).toHaveBeenCalledTimes(2);expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.flat().join(' ')).not.toMatch(/INSERT|UPDATE|DELETE|FOR UPDATE/);
  });
  it.each(['unknown','partial','conflict','future','stale','revision','provider','target','sample','missing_inspector'])('fails closed for %s',async fault=>{
    const f=fixture();
    if(fault==='unknown'||fault==='partial')Object.assign(f.evidence.coverage,{status:fault});
    if(fault==='conflict')Object.assign(f.evidence,{conflict:'present'});
    if(fault==='future')Object.assign(f.evidence.provenance,{knownAt:at+1});
    if(fault==='stale')Object.assign(f.evidence.provenance,{observedAt:1});
    if(fault==='revision')Object.assign(f.evidence.revision,{executionFingerprint:'b'.repeat(64)});
    if(fault==='provider')Object.assign(f.evidence.provenance,{providerId:'unapproved'});
    if(fault==='target')Object.assign(f.profile,{versionId:'different'});
    if(fault==='sample')f.query.mockResolvedValue({rows:[],rowCount:0});
    if(fault==='missing_inspector')Object.assign(f.options,{independentlyInspect:undefined});
    const r=await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal});
    expect(r.status).toBe('pending');expect(r).not.toHaveProperty('validation');
  });
  it('permits only a fingerprint-bound explicit upstream block, never a safe decision',async()=>{
    const f=fixture();f.inspect.mockResolvedValue({status:'verified',evidenceFingerprint:safetyEvidenceFingerprint(f.evidence),disposition:'blocked',evidenceRef:'independent:block'} as any);
    expect(await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal})).toMatchObject({status:'blocked',publicationAuthorized:false});
    const g=fixture();g.inspect.mockResolvedValue({status:'verified',evidenceFingerprint:safetyEvidenceFingerprint(g.evidence),disposition:'validated'} as any);
    expect((await createPostgresSafetyEvidenceValidator(g.options).validateEvidence({evidence:g.evidence,signal:new AbortController().signal})).status).toBe('pending');
  });
  it('does not equate distinct wallets or an empty relation set with independence',async()=>{
    const f=fixture();Object.assign(f.evidence,{kind:'independence',observations:{relations:[]}});
    const r=await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal});
    expect(r.status).toBe('pending');expect(r).not.toHaveProperty('independenceKey');
  });
  it('rechecks revision and current target after independent inspection',async()=>{
    const f=fixture();f.inspect.mockImplementation(async({fingerprint}:any)=>{Object.assign(f.profile,{versionId:'changed'});return{status:'verified',evidenceFingerprint:fingerprint,disposition:'unknown'};});
    expect(await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal})).toMatchObject({status:'pending',bindingVerified:false});
  });
  it('bounds an ignored read and prevents overlapping checks until it settles',async()=>{
    const f=fixture();let finish!:(v:any)=>void;
    f.load.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));Object.assign(f.options,{maximumRunMs:10});
    const validator=createPostgresSafetyEvidenceValidator(f.options),input={evidence:f.evidence,signal:new AbortController().signal};
    expect((await validator.validateEvidence(input)).status).toBe('pending');
    expect(await validator.validateEvidence(input)).toMatchObject({reasonCode:'safety_verifier_busy'});
    finish({status:'deferred',reasonCode:'missing'});await new Promise(resolve=>setTimeout(resolve,0));
  });
  it('never publishes pending or blocked foundations and never emits private errors',async()=>{
    const f=fixture();f.query.mockRejectedValue(new Error('postgresql://private SQL wallet secret'));
    const r=await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal});
    expect(JSON.stringify(r)).not.toMatch(/private|SQL|wallet secret/);
    const publisher=createPostgresSafetyEvidencePublisher();
    expect(await publisher.publish({assessment:r,signal:new AbortController().signal})).toEqual({status:'deferred',reasonCode:'safety_publication_not_authorized'});
  });
});

it('uses revision columns that exist in the actual purchase schema and binds chain through economic trades', async () => {
  const { POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL } = await import('../../../packages/database/src/postgres-forward-purchases.js');
  const f=fixture();
  await createPostgresSafetyEvidenceValidator(f.options).validateEvidence({evidence:f.evidence,signal:new AbortController().signal});
  const ddl=POSTGRES_FORWARD_PURCHASE_SCHEMA_SQL.split('CREATE TABLE forward_trade_revisions (')[1]!.split(');')[0]!;
  const columns=new Set(ddl.split('\n').flatMap(line=>[...line.matchAll(/(?:^|,)\s*([a-z_]+)\s+(?:text|bigint|numeric|boolean)\b/g)].map(match=>match[1])));
  expect(columns.has('chain')).toBe(false);
  for (const [sql] of f.query.mock.calls) {
    for (const match of sql.matchAll(/\br\.([a-z_]+)\b/g)) expect(columns.has(match[1])).toBe(true);
    expect(sql).not.toMatch(/\br\.chain\b/);
    expect(sql).toContain('t.chain=s.chain');
    expect(sql).toContain('s.generation_id=$1');
    expect(sql).toContain('s.sample_id=$2');
    expect(sql).toContain('s.execution_fingerprint=$3');
    expect(sql).toContain("x.state='pending_review'");
  }
});
