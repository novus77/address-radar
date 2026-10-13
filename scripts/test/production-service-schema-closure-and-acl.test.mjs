import test from 'node:test';import assert from 'node:assert/strict';
import {collectProductionRoleAcl} from '../upgrade-production-postgres-service-schema.mjs';
import {buildUpgradePlan} from '../build-production-service-schema-upgrade-plan.mjs';
import {inspectPublicTrustArtifact} from '../inventory-production-migration-trust.mjs';
test('ACL collector requires measured readonly and seven roles; SQL has no password or mutation',async()=>{let sql;
const roles=Array.from({length:7},(_,i)=>'r'+i);const rows=roles.map(rolname=>({rolname,reachable_role_count:0,target_table_count:1}));
const result=await collectProductionRoleAcl({query:async(text,values)=>{sql=text;assert.deepEqual(values[0],roles);return {rows:[{readonly:true,role_count:7,roles:rows}]};}},{schema:'business',roles});assert.equal(result.transactionReadOnly,true);assert.ok(sql.trim().startsWith('SELECT'));assert.ok(!/rolpassword|pg_authid|ALTER |GRANT /.test(sql));
await assert.rejects(collectProductionRoleAcl({query:async()=>({rows:[{readonly:false,role_count:7,roles:rows}]})},{schema:'business',roles}));});
test('upgrade plan requires real code plan and explicit resource budgets',()=>{
const base={target:{database:'address_radar',schema:'address_radar_business',generation:'production-20261006-v1',username:'address_radar_migrator'}};
const receipt={schemaPlan:{version:3,fingerprint:'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383'},entries:10,bytes:100,inventorySha256:'a'.repeat(64)};
const input={base,basePin:{path:'/protected/base',sha256:'b'.repeat(64),uid:0,gid:0,mode:384,device:'1',inode:'2'},receipt,releaseRoot:'/release',privateDirectory:'/state',operationId:'op',approvalRef:'approval',roles:Object.fromEntries(['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'].map((s,i)=>[s,'service_'+i])),maximumEntries:4096,maximumBytes:134217728,timeoutMs:180000};
assert.equal(buildUpgradePlan(input).serviceSchemaPlan.version,3);assert.throws(()=>buildUpgradePlan({...input,timeoutMs:undefined}));assert.throws(()=>buildUpgradePlan({...input,receipt:{...receipt,schemaPlan:{version:1}}}));});
test('trust inventory never emits private material or treats inventory as approval',()=>{
const privateBody=Buffer.from('-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----');const result=inspectPublicTrustArtifact(privateBody);assert.equal(result.status,'private_material_refused');assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(inspectPublicTrustArtifact(Buffer.from('{}')).trusted,false);assert.throws(()=>inspectPublicTrustArtifact(Buffer.alloc(1048577)));});
