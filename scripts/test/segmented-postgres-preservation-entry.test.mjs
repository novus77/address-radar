import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSegmentedEntry, executeSegmentedEntry, segmentedSourcePins } from '../run-segmented-postgres-preservation.ts';
const nonce='a'.repeat(16), database='radar_rehearsal_'+nonce, h='b'.repeat(64);
function config(stage='import') {
 const c={version:2,nonce,stage,sessionId:'s',connection:{host:'127.0.0.1',port:5434,database,username:database+(stage==='import'?'_migrator':stage==='verify'?'_verifier':'_finalizer'),password:h,systemIdentifier:'123'},schema:database+'_schema',runnerSha256:h,sourceReaderSha256:h,authorityModuleSha256:h};
 Object.assign(c,{host:c.connection.host,port:c.connection.port,database:c.connection.database,username:c.connection.username,systemIdentifier:c.connection.systemIdentifier,invocation});
 if(stage!=='finalize')c.selection={startChunkIndex:0,endChunkIndexExclusive:1};
 if(stage!=='import')c.binding={sessionId:'s',freezeEpoch:'f',operationId:'o',snapshotSha256:segmentedSourcePins.snapshotSha256,manifestSha256:segmentedSourcePins.manifestSha256,target:{database,schema:c.schema,endpoint:'127.0.0.1:5434',systemIdentifier:'123'},freezeEvidenceSha256:h};
 if(stage==='finalize')c.proofFiles=[{name:'c'.repeat(16)+'-verify.proof.json',artifactSha256:h}];
 return c;
}
const invocation={requestNonce:'d'.repeat(16),deadlineAtMs:901000,timeoutMs:900000};
for(const stage of ['import','verify','finalize'])test('dedicated nonowner role admitted for '+stage,()=>assert.equal(validateSegmentedEntry(config(stage),invocation,1000).stage,stage));
for(const change of [c=>{c.connection.username='postgres';},c=>{c.connection.port=5432;},c=>{c.connection.host='remote';},c=>{c.nonce='a'.repeat(32);},c=>{c.runnerSha256='invalid';},c=>{c.selection.endChunkIndexExclusive=1549;}])test('invalid target/pin/selection rejected '+String(change),()=>{const c=config();change(c);assert.throws(()=>validateSegmentedEntry(c,invocation,1000),/segmented_entry_/);});
test('stage budget is at most fifteen minutes and clipped wall deadline',()=>{
 for(const i of [{...invocation,timeoutMs:900001},{...invocation,deadlineAtMs:901001},{...invocation,deadlineAtMs:11000}])assert.throws(()=>validateSegmentedEntry(config(),i,1000),/budget/);
});
test('readonly verifier credentials cannot authorize finalization',()=>{const c=config('finalize');c.connection.username=database+'_verifier';assert.throws(()=>validateSegmentedEntry(c,invocation,1000),/target/);});
test('freeze evidence and protected proof references have no permissive defaults',()=>{
 const c=config('verify');delete c.binding;assert.throws(()=>validateSegmentedEntry(c,invocation,1000),/freeze_binding/);
 const f=config('finalize');f.proofFiles[0].name='../artifact.json';assert.throws(()=>validateSegmentedEntry(f,invocation,1000),/proof_files/);
});
test('bad config closes source process and pool without connecting',async()=>{
 const events=[];const c=config();c.connection.port=5432;
 await assert.rejects(executeSegmentedEntry(c,invocation,{clock:()=>1000,monotonic:()=>0,
 pool:{connect:async()=>{events.push('connect');throw Error('unexpected');},end:async()=>{events.push('pool-close');}},
 reader:{read:async()=>{events.push('read');throw Error('unexpected');},close:async()=>{events.push('reader-close');},metrics:{}}}),/target/);
 assert.deepEqual(events,['reader-close','pool-close']);
});
test('unverified source fails before native UOW and still closes both resources',async()=>{
 const events=[];await assert.rejects(executeSegmentedEntry(config(),invocation,{clock:()=>1000,monotonic:()=>0,
 pool:{connect:async()=>{events.push('connect');throw Error('unexpected');},end:async()=>{events.push('pool-close');}},
 reader:{read:async()=>Buffer.from('{}'),close:async()=>{events.push('reader-close');},metrics:{}}}),/source_manifest/);
 assert.deepEqual(events,['reader-close','pool-close']);
});
test('pool cleanup still runs if reader close fails',async()=>{
 const events=[];const c=config();c.connection.port=5432;
 await assert.rejects(executeSegmentedEntry(c,invocation,{clock:()=>1000,monotonic:()=>0,
 pool:{connect:async()=>{throw Error('unexpected');},end:async()=>{events.push('pool-close');}},
 reader:{read:async()=>{throw Error('unexpected');},close:async()=>{throw Error('reader-close');},metrics:{}}}),/reader-close/);
 assert.deepEqual(events,['pool-close']);
});

const {measureSegmentedDatabaseAuthority,finalizerLedgerPolicy}=await import('../run-segmented-postgres-preservation.ts');
function measured(stage='verify'){
 const c=config(stage);c.freezeBarrier={backendPid:99,epoch:'f'};
 const names=['full_data_preservation_chunks','full_data_preservation_operations','full_data_preservation_rows','full_data_preservation_staged_completions','full_data_preservation_tables'];
 const row={database,username:c.connection.username,role:c.connection.username,backend_pid:7,address:'127.0.0.1',port:5434,readonly:stage==='verify'?'on':'off',unsafe_attributes:false,memberships:0,owned_objects:0,create_paths:false,callable_user_functions:0,writable_sequences:0,barrier_session:true,barrier_relations:5,other_sessions:0,
 relations:names.map(relation=>({schema:c.schema,relation,select:true,table_writes:[],column_writes:stage==='finalize'&&finalizerLedgerPolicy[relation]?finalizerLedgerPolicy[relation].columns.map(column=>({operation:finalizerLedgerPolicy[relation].operation,column})):[]}))};
 return {c,row};
}
test('native measurement executes one bound catalogue query, not receipt booleans',async()=>{
 const {c,row}=measured();let query;const result=await measureSegmentedDatabaseAuthority({query:async(text,values)=>{query={text,values};return {rows:[row],rowCount:1};}},c);
 assert.ok(query.text.includes('pg_auth_members'));assert.ok(query.text.includes('pg_shdepend'));assert.ok(query.text.includes('has_column_privilege'));assert.ok(query.text.includes('pg_locks'));
 assert.deepEqual(query.values.slice(0,2),[c.schema,99]);assert.match(result.catalogueSha256,/^[a-f0-9]{64}$/);
});
test('finalizer ledger policy accepts only actual exact fixed column grants',async()=>{
 const {c,row}=measured('finalize');await measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c);
 row.relations.find(r=>r.relation==='full_data_preservation_operations').column_writes.push({operation:'UPDATE',column:'manifest_body'});
 await assert.rejects(measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c),/native_column_write_acl/);
});
for(const field of ['memberships','owned_objects','callable_user_functions','writable_sequences','other_sessions','barrier_relations','port'])test('native authority refuses changed '+field,async()=>{
 const {c,row}=measured();row[field]=field==='barrier_relations'?4:field==='port'?5432:1;
 await assert.rejects(measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c),/segmented_entry_native_/);
});
test('missing owner barrier never defaults to a freeze claim',async()=>{
 const {c,row}=measured();row.barrier_session=false;await assert.rejects(measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c),/native_barrier_missing/);
});
test('table-wide UPDATE cannot replace narrow column grants',async()=>{
 const {c,row}=measured('finalize');row.relations[1].table_writes=['UPDATE'];await assert.rejects(measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c),/native_table_write_acl/);
});

test('real jsonb key order does not change narrow ACL acceptance',async()=>{
 const {c,row}=measured('finalize');for(const r of row.relations)r.column_writes=r.column_writes.map(g=>({column:g.column,operation:g.operation}));
 await measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c);
});
test('duplicate column grant is rejected after structural normalization',async()=>{
 const {c,row}=measured('finalize');const r=row.relations.find(r=>r.relation==='full_data_preservation_operations');r.column_writes.push({...r.column_writes[0]});
 await assert.rejects(measureSegmentedDatabaseAuthority({query:async()=>({rows:[row],rowCount:1})},c),/native_column_write_acl/);
});
const {createCrossWindowFreezeBarrier}=await import('../run-segmented-postgres-preservation.ts');
function controlFixture(){
 const c=config('verify'), queries=[],released=[];let transaction='2026-10-06 00:00:00+00',locks=5;
 const client={release:error=>released.push(error),query:async(text,values)=>{
  queries.push({text,values});
  if(text.includes('AS superuser'))return {rows:[{database,role:'postgres',username:'postgres',pid:99,port:5434,system_identifier:'123',superuser:true}],rowCount:1};
  if(text.includes('transaction_start'))return {rows:[{pid:99,database,role:'postgres',system_identifier:'123',transaction_start:transaction,application:'radar-preservation-freeze-'+nonce+'-f',importer_login:0,unapproved_login_roles:0,other_sessions:0,locks}],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 return {c,client,queries,released,replaceTransaction:()=>{transaction='changed';},loseLocks:()=>{locks=4;}};
}
test('cross-window barrier keeps one actual transaction until explicit cleanup',async()=>{
 const f=controlFixture();const barrier=await createCrossWindowFreezeBarrier(f.client,f.c,{deadlineAtMs:Date.now()+10800000});
 const before=await barrier.measure(),after=await barrier.measure();assert.equal(before.identitySha256,after.identitySha256);assert.equal(f.released.length,0);
 assert.ok(f.queries.some(q=>q.text.includes('NOLOGIN')));assert.ok(f.queries.some(q=>q.text.includes('SHARE ROW EXCLUSIVE')));
 await barrier.close();assert.equal(f.released.length,1);assert.equal(f.queries.at(-1).text,'ROLLBACK');await barrier.close();assert.equal(f.released.length,1);
});
for(const failure of ['replaceTransaction','loseLocks'])test('lost native freeze continuity fails without reconnect '+failure,async()=>{
 const f=controlFixture();const barrier=await createCrossWindowFreezeBarrier(f.client,f.c,{deadlineAtMs:Date.now()+10800000});f[failure]();
 await assert.rejects(barrier.measure(),/freeze_(epoch_changed|native_continuity)/);await assert.rejects(barrier.measure(),/continuity_lost/);
 await barrier.close();assert.ok(f.released[0] instanceof Error);
});

const {createFixedRetainedOwnerClient,retainedOwnerControlPython,sshArgs}=await import('../staged-postgres-preservation-host-adapter.mjs');
const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');const {spawnSync}=await import('node:child_process');
function ownerChild(){const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();return child;}
function ownerScope(){return {ctx:{nonce,database,schema:database+'_schema',systemIdentifier:'123'},binding:{nonce,systemIdentifier:'123',expiryHelperSha256:h},expiry:{recordSha256:h,expiresAtMs:1000+10800000}};}
test('retained owner Python compiles locally and contains no numeric retirement fallback',()=>{
 const result=spawnSync('python3',['-c',"import sys;compile(sys.stdin.read(),'<retained-owner>','exec')"],{input:retainedOwnerControlPython,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.ok(!retainedOwnerControlPython.includes('killpg('));assert.ok(retainedOwnerControlPython.includes('expiry_record(record'));
});
test('fixed retained owner transport keeps one process and does not reconnect',async()=>{
 const child=ownerChild();let launches=0,argv,requests=[];
 child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const q=JSON.parse(line);requests.push(q);
  if(q.nonce)queueMicrotask(()=>child.stdout.write(JSON.stringify({ready:true,nonce,recordSha256:h})+'\n'));
  else if(q.action==='close')queueMicrotask(()=>child.emit('close',0));
  else queueMicrotask(()=>child.stdout.write(JSON.stringify({id:q.id,rows:[{count:1}],rowCount:1})+'\n'));
 }});
 const client=await createFixedRetainedOwnerClient(ownerScope(),{clock:()=>1000,spawnProcess:(command,args)=>{launches++;assert.equal(command,'ssh');argv=args;return child;}});
 assert.deepEqual(argv.slice(0,-1),sshArgs.slice(0,-1));await client.query('SELECT 1');await client.query('SELECT 2');assert.equal(launches,1);
 client.release();await client.close();assert.equal(requests.filter(q=>q.id).length,2);
});
test('owner channel loss refuses future work without retry',async()=>{
 const child=ownerChild();let launches=0;
 child.stdin.on('data',chunk=>{const q=JSON.parse(chunk.toString().trim());if(q.nonce)queueMicrotask(()=>child.stdout.write(JSON.stringify({ready:true,nonce,recordSha256:h})+'\n'));else if(q.id)queueMicrotask(()=>child.emit('close',1));});
 const client=await createFixedRetainedOwnerClient(ownerScope(),{clock:()=>1000,spawnProcess:()=>{launches++;return child;}});
 await assert.rejects(client.query('SELECT 1'),/continuity_lost/);await assert.rejects(client.query('SELECT 1'),/continuity_lost/);assert.equal(launches,1);
 await assert.rejects(client.close(),/owner_exit_unproven/);
});

test('retained channel binds remote filesystem pins and credential query config',async()=>{
 const child=ownerChild(),data=Buffer.from('protected remote code'),calls=[];
 child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const q=JSON.parse(line);calls.push(q);
  if(q.nonce)queueMicrotask(()=>child.stdout.write(JSON.stringify({ready:true,nonce,recordSha256:h})+'\n'));
  else if(q.action==='close')queueMicrotask(()=>child.emit('close',0));
  else {const rows=q.action==='artifact-file'?[{bytesBase64:data.toString('base64'),pin:{identity:[1,2],sha256:(createHashLocal(data))}}]:q.action==='execution-pin'?[{path:'/usr/bin/python3.12',identity:[1,3],sha256:h}]:[{backend_pid:7}];
   queueMicrotask(()=>child.stdout.write(JSON.stringify({id:q.id,rows,rowCount:rows.length})+'\n'));}
 }});
 const client=await createFixedRetainedOwnerClient(ownerScope(),{clock:()=>1000,spawnProcess:()=>child});
 const root='/var/lib/address-radar-rehearsal-artifacts/'+nonce;
 const artifact=await client.readProtectedArtifact(root+'/segmented-runner.mjs');assert.deepEqual(artifact.bytes,data);
 assert.equal((await client.readExecutionPin()).path,'/usr/bin/python3.12');
 await client.queryCredential(root+'/verify.json','SELECT pg_backend_pid()');assert.equal(calls.at(-1).action,'credential-query');assert.equal(calls.at(-1).configPath,root+'/verify.json');
 client.release();await client.close();
});
const {createHash:createHashNode}=await import('node:crypto');
function createHashLocal(bytes){return createHashNode('sha256').update(bytes).digest('hex');}
const {generateManagedDatabaseAuthority}=await import('../run-segmented-postgres-preservation.ts');
for(const stage of ['verify','finalize'])test('AuthorityV2 is generated from measured session and protected pins '+stage,async()=>{
 const f=controlFixture();const barrier=await createCrossWindowFreezeBarrier(f.client,f.c,{deadlineAtMs:Date.now()+10800000});
 const {c,row}=measured(stage);c.connection.password='e'.repeat(64);c.invocation={requestNonce:'d'.repeat(16),deadlineAtMs:Date.now()+890000,timeoutMs:900000};
 const code=Buffer.from('registered reviewed native runner');c.runnerSha256=createHashLocal(code);
 const raw=Buffer.from(JSON.stringify(c)),root='/var/lib/address-radar-rehearsal-artifacts/'+nonce,path=root+'/prepared.json';
 const nativeFiles={artifact:async name=>{const bytes=name===path?raw:name.endsWith('segmented-runner.mjs')?code:Buffer.from('registered launcher');return {bytes,pin:{identity:[1,2],sha256:createHashLocal(bytes)}};},
 execution:async()=>({path:'/usr/bin/python3.12',identity:[1,3],sha256:h})};
 let actualQueries=0;const output=await generateManagedDatabaseAuthority(path,'/usr/bin/python3',h,{query:async()=>{actualQueries++;return {rows:[row],rowCount:1};}},barrier,nativeFiles);
 const proof=JSON.parse(output.bytes);assert.equal(actualQueries,1);assert.equal(proof.version,2);assert.equal(proof.measurement.session.backend_pid,7);assert.equal(proof.credential_ref,createHashLocal(raw));
 assert.equal(proof.config_pin.sha256,createHashLocal(raw));assert.equal(proof.measurement.adapter_pin.sha256,createHashLocal(code));assert.equal(proof.role,stage==='verify'?'verifier':'finalizer');
 assert.equal(proof.entry.argv_sha256,createHashLocal(JSON.stringify(['/usr/bin/python3.12',root+'/launch-segmented-postgres-preservation.py',path])));
 assert.ok(!output.bytes.toString().includes(c.connection.password));assert.equal(output.sha256,createHashLocal(output.bytes));
 if(stage==='finalize'){assert.equal(proof.measurement.select_grants.length,5);assert.deepEqual(proof.ledger_targets.operations.columns,['completed']);assert.equal(proof.ledger_targets.completion.columns.length,7);}
 else assert.equal(proof.ledger_targets,null);
 await barrier.close();
});

const {deriveManagedInvocation}=await import('../run-segmented-postgres-preservation.ts');
test('sealed config stale deadline is replaced only by a pinned managed header budget',()=>{
 const c=config('verify');c.invocation={...invocation,deadlineAtMs:1};
 const header={version:1,role:'verifier',request_nonce:invocation.requestNonce,record_sha256:h,
 unit:'radar-rehearsal-'+nonce+'-verifier-'+invocation.requestNonce+'.service',deadline:200,policy:{runtime_seconds:90}};
 const actual=deriveManagedInvocation(c,header,100000);assert.equal(actual.deadlineAtMs,175000);assert.equal(actual.timeoutMs,75000);
 assert.equal(c.invocation.deadlineAtMs,1);assert.throws(()=>deriveManagedInvocation(c,{...header,role:'producer'},100000),/managed_budget_binding/);
 assert.throws(()=>deriveManagedInvocation(c,header,170000),/managed_clipped_budget/);
});

const {createNativeSegmentedTrust}=await import('../run-segmented-postgres-preservation.ts');
test('worker live freeze authenticates only its own fresh native observation and consumes it once',async()=>{
 const {c,row}=measured();let reads=0,releases=0;
 const pool={connect:async()=>({query:async()=>{reads++;return {rows:[row],rowCount:1};},release:()=>{releases++;}})};
 const trust=await createNativeSegmentedTrust(c,invocation,pool,'/unused',h);
 const bytes=await trust.freeze.readLiveMeasurement(c.binding);
 assert.equal(reads,1);assert.equal(releases,1);
 assert.equal(await trust.freeze.verifyMeasurement(Buffer.from('{}'),c.binding),null);
 assert.ok(await trust.freeze.verifyMeasurement(bytes,c.binding));
 assert.equal(await trust.freeze.verifyMeasurement(bytes,c.binding),null);
 row.barrier_session=false;await assert.rejects(trust.freeze.readLiveMeasurement(c.binding),/native_barrier_missing/);
 assert.equal(releases,2);
});

test('retained owner stage AbortSignal refuses channel work without inventing remote retirement',async()=>{
 const child=ownerChild();child.stdin.on('data',chunk=>{const q=JSON.parse(chunk.toString().trim());if(q.nonce)queueMicrotask(()=>child.stdout.write(JSON.stringify({ready:true,nonce,recordSha256:h})+'\n'));});
 const client=await createFixedRetainedOwnerClient(ownerScope(),{clock:()=>1000,spawnProcess:()=>child});
 const controller=new AbortController();const clear=client.setOperationBudget({deadlineAtMs:61000,monotonicDeadlineAtMs:performance.now()+60000,signal:controller.signal});
 const work=client.query('SELECT 1');await new Promise(resolve=>setImmediate(resolve));controller.abort();
 await assert.rejects(work,/owner_continuity_lost/);clear();child.emit('close',1);await assert.rejects(client.close(),/owner_exit_unproven/);
});
test('owner query admission clips against monotonic deadline despite wall rollback',async()=>{
 const child=ownerChild();let queries=0;
 child.stdin.on('data',chunk=>{const q=JSON.parse(chunk.toString().trim());if(q.nonce)queueMicrotask(()=>child.stdout.write(JSON.stringify({ready:true,nonce,recordSha256:h})+'\n'));else if(q.id)queries++;else if(q.action==='close')queueMicrotask(()=>child.emit('close',0));});
 const client=await createFixedRetainedOwnerClient(ownerScope(),{clock:()=>1000,spawnProcess:()=>child});
 const clear=client.setOperationBudget({deadlineAtMs:9999999,monotonicDeadlineAtMs:performance.now()-1});
 await assert.rejects(client.query('SELECT 1'),/owner_operation_deadline/);assert.equal(queries,0);clear();client.release();await client.close();
});
