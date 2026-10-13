import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ownedCommand } from '../install-production-postgres-business-schema.mjs';
function fixture(){
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.exitCode=null;child.signalCode=null;const signals=[];child.kill=signal=>{signals.push(signal);return true;};
  const timers=[];let spawns=0,options;
  const ports={spawn:(exe,args,opts)=>{spawns++;options=opts;return child;},setTimeout:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cleared=true;}};
  return {child,signals,timers,ports,spawns:()=>spawns,options:()=>options};
}
test('expired budget refuses before spawn',async()=>{
  const f=fixture();await assert.rejects(ownedCommand('/pinned/python',[],()=>{throw Error('budget');},f.ports));assert.equal(f.spawns(),0);
});
test('normal exit/close clears timers; a stale timeout never signals reaped child',async()=>{
  const f=fixture(),p=ownedCommand('/pinned/python',[],()=>30000,f.ports);f.child.emit('spawn');f.child.stdout.emit('data',Buffer.from('{"ok":true}'));
  f.child.exitCode=0;f.child.emit('exit',0,null);f.timers[0].fn();f.child.emit('close',0,null);
  assert.deepEqual(await p,{ok:true});assert.deepEqual(f.signals,[]);assert.equal(f.options().detached,false);
});
test('timeout signals owned handle only; failure waits for actual close ACK',async()=>{
  const f=fixture();let settled=false;const p=ownedCommand('/pinned/python',[],()=>30000,f.ports).finally(()=>{settled=true;});
  f.child.emit('spawn');f.timers[0].fn();assert.deepEqual(f.signals,['SIGTERM']);await Promise.resolve();assert.equal(settled,false);
  f.child.signalCode='SIGTERM';f.child.emit('exit',null,'SIGTERM');f.child.emit('close',null,'SIGTERM');await assert.rejects(p,/boundary_probe_failed/);
});
test('spawn error cannot release ownership before close event',async()=>{
  const f=fixture();let settled=false;const p=ownedCommand('/pinned/python',[],()=>30000,f.ports).finally(()=>{settled=true;});
  f.child.emit('error',Error('SECRET'));await Promise.resolve();assert.equal(settled,false);
  f.child.emit('close',-1,null);await assert.rejects(p,/boundary_probe_failed/);assert.deepEqual(f.signals,[]);
});
test('output overflow is rejected and never kills an exited/reaped handle',async()=>{
  const f=fixture(),p=ownedCommand('/pinned/python',[],()=>30000,f.ports);f.child.emit('spawn');f.child.emit('exit',0,null);
  f.child.stderr.emit('data',Buffer.alloc(65537));f.child.emit('close',0,null);await assert.rejects(p,/boundary_probe_failed/);assert.deepEqual(f.signals,[]);
});
test('grace escalation uses only owned live handle and clears on exit',async()=>{
  const f=fixture(),p=ownedCommand('/pinned/python',[],()=>30000,f.ports);f.child.emit('spawn');f.timers[0].fn();f.timers.find(t=>t.ms===8000).fn();
  assert.deepEqual(f.signals,['SIGTERM','SIGKILL']);f.child.emit('exit',null,'SIGKILL');f.timers.find(t=>t.ms===8000).fn();assert.equal(f.signals.length,2);
  f.child.emit('close',null,'SIGKILL');await assert.rejects(p,/boundary_probe_child_closure_unknown/);
});
test('cleanup not acknowledged stays fail closed, never parsed as success',async()=>{
  const f=fixture(),p=ownedCommand('/pinned/python',[],()=>30000,f.ports);f.child.emit('spawn');f.timers[0].fn();f.timers.find(t=>t.ms===8000).fn();f.timers.find(t=>t.ms===10000).fn();
  await assert.rejects(p,/boundary_probe_child_closure_unknown/);
});

test('rollback ACK runs after exhausted operation deadline; failure destroys unknown transaction',async()=>{
  const {guardedNativeQuery}=await import('../install-production-postgres-business-schema.mjs');
  let calls=0,destroyed=false;
  const client={query:async()=>{calls++;return {command:'ROLLBACK'};},connection:{stream:{destroy:()=>{destroyed=true;}}}};
  const query=guardedNativeQuery(client,async()=>{throw Error('expired boundary');},()=>{throw Error('expired');});
  assert.equal((await query('ROLLBACK')).command,'ROLLBACK');assert.equal(calls,1);assert.equal(destroyed,false);
  client.query=async()=>{throw Error('unknown transaction');};await assert.rejects(query('ROLLBACK'));assert.equal(destroyed,true);
});
