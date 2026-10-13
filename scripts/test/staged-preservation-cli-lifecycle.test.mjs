import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const supervisor=fileURLToPath(new URL('../run-staged-postgres-preservation-fixture.mjs',import.meta.url));
const adapter=fileURLToPath(new URL('../staged-postgres-preservation-host-adapter.mjs',import.meta.url));
const pin=createHash('sha256').update(readFileSync(adapter)).digest('hex');
test('direct executable adapter import settles without top-level await cycle or host dispatch',()=>{
 const output='/private/tmp/no-host-cli-'+randomBytes(8).toString('hex')+'.json';
 const env={...process.env,PATH:''};
 delete env.PRESERVATION_HOST_CODE_PINS_PATH;
 delete env.PRESERVATION_HOST_EVIDENCE_DIRECTORY;
 const result=spawnSync(process.execPath,[supervisor,adapter,pin,output],{env,encoding:'utf8',timeout:5000,maxBuffer:16384});
 assert.equal(result.error,undefined);
 assert.equal(result.status,1);
 assert.doesNotMatch(result.stderr,/unsettled top-level await/);
 assert.deepEqual(JSON.parse(result.stdout),{status:'failed',reconciliationRequired:true,parityComplete:false,lifecycleCleanupConfirmed:false,productionAuthorized:false});
 assert.equal(existsSync(output),false);
});
test('fixed policy mismatch rejects locally before transport creation',async()=>{
 const {createStagedPreservationPorts}=await import('../staged-postgres-preservation-host-adapter.mjs');
 await assert.rejects(createStagedPreservationPorts({sourcePins:{},maintenanceHelperPath:'/unapproved'}),/fixed_scope/);
});
