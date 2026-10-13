import {it,expect} from 'vitest';
import {installPostgresServiceSchema,createPostgresServiceSchema} from '../../apps/automation/src/postgres-service-schema.js';
import {guardExistingSchemaExecutor} from '../upgrade-production-postgres-service-schema.mjs';
const target={database:'address_radar',schema:'address_radar_business',username:'address_radar_migrator',generation:'production-20261006-v1',service:'migration'};
it('real existing service installer appends normal2/3 in one guarded UOW and never creates or resets namespace',async()=>{
 const plan=createPostgresServiceSchema({protocolVersion:2}).plan;const first=plan.migrations[0]!;
 const history=[{version:1,fingerprint:first.fingerprint,previous_fingerprint:first.previousFingerprint,modules_json:JSON.stringify(first.modules)}];const calls:string[]=[];let transactions=0,guard=false;
 const tx={query:async(sql:string,values:any[]=[])=>{calls.push(sql);
  if(sql.includes('business-schema-installer-identity'))return {rows:[{database:target.database,username:target.username,session_username:target.username,role_safe:true}]};
  if(sql.includes('business-schema-namespace'))return {rows:[{namespace_owner:target.username,namespace_owner_oid:'16384',database_oid:'16391',namespace_oid:'20000'}]};
  if(sql.includes('business-schema-presence'))return {rows:[{identity_exists:true,ledger_exists:true,identity_valid:true,ledger_valid:true}]};
  if(sql.includes('business-schema-header'))return {rows:[{singleton:true,ledger_format:1,database_name:target.database,schema_name:target.schema,generation_id:target.generation}]};
  if(sql.includes('business-schema-history'))return {rows:[...history]};
  if(sql.startsWith('INSERT INTO')&&sql.includes('business_schema_ledger'))history.push({version:values[0],fingerprint:values[1],previous_fingerprint:values[2],modules_json:values[3]});
  return {rows:[]};}};
 const executor=guardExistingSchemaExecutor({run:async(work:any)=>{transactions++;return work(tx);}},async actual=>{expect(actual).toBe(tx);guard=true;});
 const receipt=await installPostgresServiceSchema(executor,{target,approval:'approved-new-business-schema',approvalRef:'explicit-upgrade',protocolVersion:2});
 expect(guard).toBe(true);expect(transactions).toBe(1);expect(receipt.appliedVersions).toEqual([2,3]);expect(history.map(x=>x.version)).toEqual([1,2,3]);expect(calls.some(s=>/CREATE SCHEMA|DROP |TRUNCATE |ALTER ROLE/.test(s))).toBe(false);
});
