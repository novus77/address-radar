import { describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createRequire, builtinModules } from "node:module";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPostgresMigrationRuntime } from "../../packages/database/src/postgres-migration-runtime.js";
import { authenticatePostgresBusinessNamespaceReceipt, postgresBusinessNamespaceReceiptSigningPayload, installPostgresBusinessSchema, type PostgresBusinessProvisionedNamespaceReceipt } from "../../packages/database/src/postgres-business-schema.js";
import { createPostgresServiceSchema, createPostgresServiceSchemaGrantPlan } from "../../apps/automation/src/postgres-service-schema.js";
import { createPostgresBusinessProvisioningPlan, postgresBusinessResourcePolicyFingerprint, POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES, type PostgresBusinessProvisioningResources } from "../../packages/database/src/postgres-business-provisioning.js";
import { POSTGRES_BUSINESS_SERVICES, type PostgresBusinessService } from "../../packages/database/src/postgres-service-dispatch.js";
import { createMigrationCutoverCoordinator, createMigrationRuntimeCutoverTransitionStore, evaluateMigrationWriterFence,
  migrationCutoverDigest, migrationCutoverPlanDigest, migrationCutoverObservationPayload, migrationCutoverAuthorizationPayload, migrationCompatiblePostgresRollbackPayload,
  CUTOVER_SERVICES, CUTOVER_TIMERS, WRITER_KINDS, CENSUS_METHODS, PREPARATION_OBSERVATIONS, POSTGRES_COMPATIBILITY_GUARD_CHECKS,
  type CutoverPostgresTarget, type WriterFencePolicy, type WriterFenceBundle, type CutoverObservation, type CutoverCommand, type CutoverAction, type DurableCutoverState, type CompatiblePostgresReleaseProof, type FirstPostgresWriteMarkerV2,
} from "../../packages/database/src/migration-cutover-coordinator.js";
import { verifyWriterFenceSnapshotRollbackClosure, fenceClosureSigningMessage, fenceClosureEvidenceSha256, type FenceClosureSigned, type FenceClosureScope } from "../../packages/database/src/migration-writer-fence-closure.js";
import type { PostgresServiceDeployment } from "../postgres-service-entry.js";

const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const enabled=process.env.ADDRESS_RADAR_RUN_SIX_ROOT_REHEARSAL==="1";
const cliEnabled=process.env.ADDRESS_RADAR_RUN_SIX_DISPATCH_REHEARSAL==="1";
const sha=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
const hash=(value="a")=>value.repeat(64);
const clone=<T>(value:T):T=>structuredClone(value);
const q=(value:string)=>{if(!/^[a-z_][a-z0-9_]{0,62}$/.test(value))throw new Error("Unsafe fixture SQL identifier");return '"'+value+'"';};
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const ssh=["-o","BatchMode=yes","-o","ConnectTimeout=5","-o","ServerAliveInterval=5","-o","ServerAliveCountMax=1","ubuntu@152.32.185.240"];
const remoteNodeSha="7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c";
interface Context {nonce:string;database:string;schema:string;role:string;systemIdentifier:string;connectionPath:string;remoteConnectionPath:string;capacity:string;guard():string}
interface Lifecycle {withPrivatePreservationFixture<T>(operation:(ctx:Context)=>Promise<T>):Promise<T>}
function postgresFixtureFailureDiagnostic(error:unknown):{sqlState:string;detail:string;detailRedacted:boolean;detailBytes:number}|undefined {
  if(error===null||typeof error!=="object"||Array.isArray(error))return undefined;
  const descriptors=Object.getOwnPropertyDescriptors(error);
  const code=descriptors.code&&"value" in descriptors.code?descriptors.code.value:undefined;
  if(typeof code!=="string"||!/^[0-9A-Z]{5}$/.test(code))return undefined;
  const raw=descriptors.detail&&"value" in descriptors.detail?descriptors.detail.value:undefined;
  const detailBytes=typeof raw==="string"?Buffer.byteLength(raw):0;
  let detail="[absent]",detailRedacted=false;
  if(typeof raw==="string"){
    // Only fixed PostgreSQL syntax messages and code-owned protocol field tokens are printable.
    const token=raw.length<=4096?/^Token "([A-Za-z][A-Za-z0-9]{0,63})" is invalid\.$/.exec(raw)?.[1]:undefined;
    const fields=new Set(["version","revision","phase","binding","policySha256","planSha256","activationEnabled","preparation","snapshotTables","firstPostgresWrite","journal","observations","closure","authorization","census","snapshot","rollback","sourceKey","bindingSha256","cohortId","generation","writeId","receiptSha256","providerGuardSha256","deliveryGuardSha256","recordedAt"]);
    if(token&&fields.has(token))detail='Token "'+token+'" is invalid.';
    else if(["The input string ended unexpectedly.","Expected string or \"}\", but found \"{\"."].includes(raw))detail=raw;
    else {detail="[redacted]";detailRedacted=true;}
  }
  return {sqlState:code,detail,detailRedacted,detailBytes};
}

function parseFixtureFailure(output:string):Record<string,unknown>|undefined {
  for(const line of output.slice(-32768).split(/\r?\n/).slice(-16).reverse()) {
    try {
      const value:unknown=JSON.parse(line);
      if(value!==null&&typeof value==="object"&&!Array.isArray(value)&&"status" in value&&value.status==="failed")return value as Record<string,unknown>;
    }catch{/* Transport diagnostics can contain non-JSON lines. */}
  }
  return undefined;
}
function sshRun(command:string,input:string,maximumMs=20000):string {
  const result=spawnSync("ssh",[...ssh,command],{input,encoding:"utf8",timeout:maximumMs,maxBuffer:256*1024});
  if(result.error||result.status!==0) {
    const failure=parseFixtureFailure(result.stdout??"");
    const directory=mkdtempSync(join(tmpdir(),"radar-isolated-ssh-failure-")),path=join(directory,"failure.json");
    // Keep bounded private diagnostics, never argv, stdin, credentials or raw output in the test error.
    writeFileSync(path,JSON.stringify({version:1,status:"failed",exitCode:result.status,signal:result.signal,
      transportError:result.error?.name,failure,stdout:(result.stdout??"").slice(-32768),stderr:(result.stderr??"").slice(-32768),
      productionAuthorized:false})+"\n",{mode:0o600});
    throw new Error("Isolated fixture SSH operation refused (exit "+String(result.status)+"); private diagnostic: "+path);
  }
  return result.stdout.trim();
}
const sourceBundle=String.raw`
export * from "__REPO__/scripts/postgres-service-entry.ts";
export { createPostgresBusinessRuntime } from "__REPO__/packages/database/src/postgres-business-driver.ts";
export { migrationCutoverDigest } from "__REPO__/packages/database/src/migration-cutover-coordinator.ts";
`;
const nativeMarkerVerifierSource=String.raw`
function verifyNativeMarkerRow(row,state,sourceKey) {
  if(state.version!==2||state.phase!=="postgres-written"||!state.firstPostgresWrite)throw new Error("V2 committed first-write state required");
  const write=state.firstPostgresWrite;
  const expected={version:2,sourceKey,policySha256:state.policySha256,planSha256:state.planSha256,bindingSha256:migrationCutoverDigest(state.binding,2),cohortId:state.binding.cohortId,generation:state.binding.generation,writeId:write.writeId,receiptSha256:write.receiptSha256,providerGuardSha256:write.providerGuardSha256,deliveryGuardSha256:write.deliveryGuardSha256,recordedAt:write.recordedAt};
  if(!row||row.marker_sha256!==migrationCutoverDigest(expected,2)||migrationCutoverDigest(row.marker,2)!==row.marker_sha256)throw new Error("Native V2 first-write marker mismatch");
  return row.marker;
}
`;
type FixtureMarkerVerifier=(row:Record<string,unknown>|undefined,state:DurableCutoverState,sourceKey:string)=>FirstPostgresWriteMarkerV2;
const verifyFixtureNativeMarker=new Function("migrationCutoverDigest",nativeMarkerVerifierSource+";return verifyNativeMarkerRow;")(migrationCutoverDigest) as FixtureMarkerVerifier;

const smokeSource=String.raw`
import assert from "node:assert/strict";
import {readFileSync,existsSync,statfsSync} from "node:fs";
import {get,request} from "node:http";
import {runPostgresServiceEntrypoint,createPostgresBusinessRuntime,migrationCutoverDigest} from "./scripts/postgres-service-entry.ts";
${nativeMarkerVerifierSource}
const [file,service]=process.argv.slice(2);
let stage="private-fixture-binding";
const record=JSON.parse(readFileSync(file,"utf8"));
assert.equal(record.scope,"isolated-six-root-factory");
assert.match(record.nonce,/^[a-f0-9]{16}$/);
assert.equal(record.database,"radar_rehearsal_"+record.nonce);
assert.equal(record.schema,record.database+"_schema");
assert.equal(record.env.ADDRESS_RADAR_DATABASE_BACKEND,"postgresql");
assert.equal(record.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED,"false");
const connectionUrl=new URL(record.env.ADDRESS_RADAR_POSTGRES_URL);
assert.equal(connectionUrl.port,"5434");assert.equal(connectionUrl.hostname,"127.0.0.1");assert.equal(connectionUrl.pathname,"/"+record.database);assert.equal(connectionUrl.username,record.username);
const stop=new AbortController(),notices=[],polls=[],identities=[],journals=[];
let runtime,closed=false,inFlight=0,awaitedUows=0,startupBridgeReads=0,startupTopLevelChecks=0,nativeMarkerReads=0,externalFetchCalls=0,consoleRequests=0,pendingConsole;
const originalWrite=process.stdout.write.bind(process.stdout),originalFetch=globalThis.fetch;
const watch=tx=>({query:async(sql,values=[])=>{
  const result=await tx.query(sql,values);
  if(sql.includes("pg_current_xact_id_if_assigned() IS NULL AS no_prior_writes")){assert.equal(result.rows[0].no_prior_writes,true);startupTopLevelChecks++;}
  if(sql.includes("SELECT revision,state")&&result.rows.length===1){
    assert(sql.includes("migration_cutover_transitions_v2"));
    const state=result.rows[0].state;
    const markers=await tx.query("SELECT marker_sha256,marker FROM migration_cutover_first_write_markers WHERE source_key=$1",[record.markerSourceKey]);
    assert.equal(markers.rows.length,1);verifyNativeMarkerRow(markers.rows[0],state,record.markerSourceKey);nativeMarkerReads++;
    startupBridgeReads++;journals.push(structuredClone(state));
  }
  return result;
}});
const boundedRequest=(method,path)=>new Promise((resolve,reject)=>{
  consoleRequests++;
  const url=new URL(path,"http://"+record.console.host+":"+record.console.port);
  const req=request(url,{method,timeout:2000},response=>{
    let body="";response.setEncoding("utf8");
    response.on("data",data=>{body+=data;if(Buffer.byteLength(body)>32768){req.destroy();reject(new Error("Console response budget"));}});
    response.on("end",()=>{try{resolve({status:response.statusCode,body:JSON.parse(body)});}catch(error){reject(error);}});
  });req.on("error",reject);req.on("timeout",()=>req.destroy(new Error("Console deadline")));req.end();
});
let resourceFailure=false,minMemAvailableBytes=null,minDiskAvailableBytes=null;
const resourceGuard=()=>{
  const match=/^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo","utf8"));assert(match);
  const memory=BigInt(match[1])*1024n,fs=statfsSync(record.env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE,{bigint:true}),disk=fs.bsize*fs.bavail;
  minMemAvailableBytes=minMemAvailableBytes===null||memory<minMemAvailableBytes?memory:minMemAvailableBytes;
  minDiskAvailableBytes=minDiskAvailableBytes===null||disk<minDiskAvailableBytes?disk:minDiskAvailableBytes;
  if(memory<1073741824n||disk<5368709120n||process.memoryUsage().rss>268435456){resourceFailure=true;stop.abort();}
};
const resourceTimer=setInterval(()=>{try{resourceGuard();}catch{resourceFailure=true;stop.abort();}},500);
const deadline=setTimeout(()=>stop.abort(),40000);
try {
  resourceGuard();assert.equal(resourceFailure,false);
  globalThis.fetch=async()=>{externalFetchCalls++;throw new Error("External HTTP is forbidden in isolated empty fixture");};
  process.stdout.write=(chunk,...rest)=>{
    const text=String(chunk);
    if(text.startsWith('{"service":')) {
      const body=JSON.parse(text);assert.equal(body.service,service);polls.push(body.result);stop.abort();return true;
    }
    return originalWrite(chunk,...rest);
  };
  stage="real-root-startup-poll-drain";
  await runPostgresServiceEntrypoint(service,record.env,{
    stopSignal:stop.signal,
    createRuntime(options){
      assert.deepEqual(options.target,{database:record.database,username:record.username,schema:record.schema,generation:record.generation,service});
      assert.equal(options.maximumConnections,1);
      assert.equal(options.access,service==="console"?"read":"runtime");
      runtime=createPostgresBusinessRuntime(options);
      const actual=runtime;
      const run=async(operation)=>{
        inFlight++;
        try {const result=await actual.run(async tx=>{
          const native=(await tx.query("SELECT current_database() AS database,current_user AS username,current_setting('server_version_num') AS server_version_num,(SELECT schema_name FROM business_schema_identity WHERE singleton) AS schema")).rows[0];
          assert.equal(native.database,record.database);assert.equal(native.username,record.username);assert.equal(native.schema,record.schema);assert.equal(Math.floor(Number(native.server_version_num)/10000),16);
          return operation(watch(tx));
        });awaitedUows++;return result;}finally{inFlight--;}
      };
      return {...actual,run,
        probe:async()=>{const identity=await actual.probe();identities.push(identity);assert.equal(identity.username,record.username);
          assert.equal(identity.database,record.database);assert.equal(identity.schema,record.schema);assert.equal(identity.generation,record.generation);
          assert.equal(identity.serverPort,5434);assert.equal(identity.service,service);return identity;},
        close:async()=>{assert.equal(inFlight,0);await actual.close();closed=true;},
      };
    },
    async notify(notice) {
      notices.push(notice);
      if(service==="console"&&notice.type==="postgres-service-ready") {
        pendingConsole=new Promise((resolve,reject)=>setTimeout(()=>{
          void(async()=>{
            const health=await boundedRequest("GET","/healthz");
            assert.equal(health.status,200);assert.equal(health.body.backend,"postgresql");assert.equal(health.body.generationId,record.generation);
            const progress=await boundedRequest("GET","/api/v2/operations/closed-loop");
            assert.equal(progress.status,200);assert.equal(progress.body.backend,"postgresql");assert.equal(progress.body.generationId,record.generation);
            assert.equal(progress.body.coverageVerified,false);assert.equal(progress.body.gatewayDeliveryEnabled,false);assert.equal(progress.body.legacyTotalsIncluded,false);
            assert.equal(progress.body.runnableDelta15m,null);assert.equal(progress.body.sampledAt,progress.body.asOf);
            assert(progress.body.stages.length>0);
            for(const row of progress.body.stages){assert.match(row.count,/^(0|[1-9][0-9]*)$/);assert.match(row.newRecords1h,/^(0|[1-9][0-9]*)$/);}
            const denied=await boundedRequest("POST","/api/v2/operations/closed-loop");assert.equal(denied.status,405);
            polls.push(progress.body);stop.abort();resolve();
          })().catch(error=>{stop.abort();reject(error);});
        },20));
        // Root owns its shutdown; attach immediately to avoid an unhandled rejection.
        void pendingConsole.catch(()=>{});
      }
    },
  });
  if(pendingConsole)await pendingConsole;
  stage="receipt-checks";
  resourceGuard();assert.equal(resourceFailure,false);
  assert(closed);assert.equal(inFlight,0);assert.equal(externalFetchCalls,0);assert.equal(polls.length,1);assert.equal(consoleRequests,service==="console"?3:0);
  const failures=value=>{if(value&&typeof value==="object"){for(const [key,child]of Object.entries(value)){if(key==="failed"&&typeof child==="number")assert.equal(child,0);else failures(child);}}};failures(polls[0]);
  assert.equal(notices.filter(x=>x.type==="postgres-service-ready").length,1);
  assert.equal(notices.filter(x=>x.type==="postgres-service-drained").length,1);
  assert(identities.length>0);assert(awaitedUows>0);assert(startupBridgeReads>0);assert(startupTopLevelChecks>0);assert(journals.length>0);assert(nativeMarkerReads>0);
  const state=journals.at(-1);assert.equal(state.version,2);assert.equal(state.revision,3);
  assert.equal(state.policySha256,record.policySha256);assert.equal(state.planSha256,record.planSha256);assert.equal(state.phase,"postgres-written");assert.equal(state.activationEnabled,false);
  assert.equal(state.binding.target.database,record.database);assert.equal(state.binding.target.schema,record.schema);
  assert.equal(state.firstPostgresWrite.writeId,record.markerWriteId);assert.equal(state.firstPostgresWrite.receiptSha256,record.markerReceipt);
  assert.deepEqual(state.journal.map(x=>x.command.action),["prepare","select-postgres","first-postgres-write"]);
  assert.equal(state.journal.at(-1).receipt.revision,3);
  for(const entry of state.journal){assert.equal(entry.command.version,2);assert.equal(entry.requestSha256,migrationCutoverDigest(entry.command,2));}
  assert(!existsSync(record.env.ADDRESS_RADAR_DATABASE_PATH));
  originalWrite(JSON.stringify({status:"passed",service,ready:1,polls:1,drained:1,closed:true,awaitedUows,startupBridgeReads,startupTopLevelChecks,nativeMarkerReads,externalFetchCalls,consoleRequests,protocolVersion:2,
    maxRssBytes:process.resourceUsage().maxRSS*1024,minMemAvailableBytes:String(minMemAvailableBytes),minDiskAvailableBytes:String(minDiskAvailableBytes),
    backend:"postgresql",database:record.database,schema:record.schema,username:record.username,generation:record.generation,
    markerRevision:state.revision,journalEntries:state.journal.length,markerReceipt:state.firstPostgresWrite.receiptSha256,
    coverageVerified:service==="console"?polls[0].coverageVerified:false,legacyTotalsIncluded:false})+"\n");
} catch(error) {
  const message=String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,"[private-url]").slice(0,240);
  originalWrite(JSON.stringify({status:"failed",service,stage,errorName:error.name,message})+"\n");process.exitCode=1;
} finally {clearTimeout(deadline);clearInterval(resourceTimer);process.stdout.write=originalWrite;globalThis.fetch=originalFetch;}
`;
const dispatcherSource=String.raw`
import assert from "node:assert/strict";
import {ChildProcess} from "node:child_process";
import {readFileSync,existsSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {dispatchPostgresBusinessService} from "./dispatch-api.mjs";
const [file,service]=process.argv.slice(2);
const record=JSON.parse(readFileSync(file,"utf8"));
assert.equal(record.scope,"isolated-six-root-dispatcher");
assert.match(record.nonce,/^[a-f0-9]{16}$/);
assert.equal(record.database,"radar_rehearsal_"+record.nonce);
assert.equal(record.schema,record.database+"_schema");
const url=new URL(record.env.ADDRESS_RADAR_POSTGRES_URL);
assert.equal(url.hostname,"127.0.0.1");assert.equal(url.port,"5434");
assert.equal(url.pathname,"/"+record.database);assert.equal(url.username,record.username);
assert.equal(record.env.ADDRESS_RADAR_DATABASE_BACKEND,"postgresql");
assert.equal(record.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED,"false");
const deployment=JSON.parse(readFileSync(record.env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE,"utf8"));
const originalEmit=ChildProcess.prototype.emit,children=[],notices=[];
let observationError,childExit,launchNonce;
ChildProcess.prototype.emit=function(event,...args){
  // Observe and delegate the actual default spawn; do not inject IPC or substitute a child.
  if(event==="spawn"&&this.spawnfile===process.execPath){
    try{
      assert.deepEqual(this.spawnargs,[process.execPath,"--no-global-search-paths",
        "--import",pathToFileURL(deployment.releaseRoot+"/node_modules/tsx/dist/loader.mjs").href,
        deployment.releaseRoot+"/scripts/postgres-service-entry.ts",service]);
      assert.equal(this.connected,true);children.push(this);
      this.on("message",notice=>{
        try{
          assert.equal(Object.keys(notice).length,6);
          assert.equal(notice.service,service);assert.equal(notice.operationId,deployment.operationId);
          assert.equal(notice.generationId,record.generation);assert.equal(notice.releaseSha256,record.env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256);
          assert.match(notice.nonce,/^[a-f0-9]{32}$/);
          if(notice.type==="postgres-service-ready"){assert.equal(launchNonce,undefined);launchNonce=notice.nonce;}
          else {assert.equal(notice.type,"postgres-service-drained");assert.equal(notice.nonce,launchNonce);}
          notices.push(notice);
          process.stdout.write(JSON.stringify({event:"g11-dispatch-ipc",service,type:notice.type})+"\n");
        }catch(error){observationError=error;process.kill(process.pid,"SIGTERM");}
      });
      this.once("exit",(code,signal)=>{childExit={code,signal};});
    }catch(error){observationError=error;process.kill(process.pid,"SIGTERM");}
  }
  return originalEmit.call(this,event,...args);
};
try{
  Object.assign(process.env,record.env);
  assert.equal(await dispatchPostgresBusinessService(service,process.env),true);
  if(observationError)throw observationError;
  assert.equal(children.length,1);assert.deepEqual(childExit,{code:0,signal:null});
  assert.equal(notices.filter(n=>n.type==="postgres-service-ready").length,1);
  assert.equal(notices.filter(n=>n.type==="postgres-service-drained").length,1);
  assert(!existsSync(record.env.ADDRESS_RADAR_DATABASE_PATH));
  process.stdout.write(JSON.stringify({status:"passed",service,dispatcherReturned:true,defaultSpawn:true,
    genuineTsxLoader:true,rootCliMain:true,actualIpc:true,ready:1,drained:1,childExitCode:0,childExitSignal:null,
    namespaceProof:"actual-default-root-startup-driver-and-durable-verifier",database:record.database,
    schema:record.schema,username:record.username,generation:record.generation,backend:"postgresql",markerReceipt:record.markerReceipt,
    startupProofScope:"synthetic-same-nonce-native-coordinator-v2",protocolVersion:2,markerSourceKey:record.markerSourceKey,sqliteFallback:false})+"\n");
}catch(error){
  process.stdout.write(JSON.stringify({status:"failed",service,stage:"actual-dispatcher-cli-ipc",
    errorName:error.name,message:String(error.message).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,"[private-url]").slice(0,240)})+"\n");
  process.exitCode=1;
}finally{ChildProcess.prototype.emit=originalEmit;}
`;
const dispatcherWatchPython=String.raw`
import os,sys,json,re,time,signal,subprocess,selectors,concurrent.futures,urllib.request,stat
file,service=sys.argv[1:];record=json.load(open(file))
nonce=record["nonce"];assert re.fullmatch("[a-f0-9]{16}",nonce)
root="/opt/address-radar-rehearsal/"+nonce
assert file==root+"/private/"+service+".json" and record["scope"]=="isolated-six-root-dispatcher"
assert record["database"]=="radar_rehearsal_"+nonce and record["schema"]==record["database"]+"_schema"
assert os.geteuid()!=0 and record["env"]["ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED"]=="false"
s=os.lstat(file);assert stat.S_ISREG(s.st_mode) and s.st_uid==os.geteuid() and s.st_mode&0o777==0o600
node=root+"/bin/node";runner=root+"/release/dispatch.mjs"
child=None;selector=selectors.DefaultSelector();executor=concurrent.futures.ThreadPoolExecutor(max_workers=1)
future=None;buffers={};captured=0;ready=0;drained=0;polls=[];receipt=None;stopping=False;requests=0
stderr_tail="";last_failure=None
peak=0;minimum_memory=None;minimum_disk=None
def group():
 out=[]
 if child is None:return out
 for name in os.listdir("/proc"):
  if not name.isdigit():continue
  try:
   pid=int(name)
   if os.getpgid(pid)==child.pid:
    assert os.stat("/proc/"+name).st_uid==os.geteuid()
    out.append(pid)
  except ProcessLookupError:pass
 return out
def guard():
 global peak,minimum_memory,minimum_disk
 match=re.search(r"^MemAvailable:\s+(\d+) kB$",open("/proc/meminfo").read(),re.M);assert match
 memory=int(match.group(1))*1024;v=os.statvfs(root);disk=v.f_bavail*v.f_frsize
 total=0
 for pid in group():
  try:
   m=re.search(r"^VmRSS:\s+(\d+) kB$",open("/proc/"+str(pid)+"/status").read(),re.M)
   if m:total+=int(m.group(1))*1024
  except FileNotFoundError:pass
 peak=max(peak,total);minimum_memory=memory if minimum_memory is None else min(minimum_memory,memory)
 minimum_disk=disk if minimum_disk is None else min(minimum_disk,disk)
 assert memory>=1073741824,"G11 available-RAM guard"
 assert disk>=5368709120,"G11 free-disk guard"
 assert total<=268435456,"G11 dispatcher/CLI process-tree RSS guard"
def stop():
 global stopping
 if not stopping:
  stopping=True
  child.send_signal(signal.SIGTERM)
def failed(value):
 if isinstance(value,dict):
  for key,item in value.items():
   assert not(key=="failed" and isinstance(item,(int,float)) and item!=0),"Actual poll reported failure"
   failed(item)
 elif isinstance(value,list):
  for item in value:failed(item)
def console_cycle():
 base="http://127.0.0.1:"+str(record["console"]["port"])
 def fetch(method,path):
  request=urllib.request.Request(base+path,method=method)
  try:
   with urllib.request.urlopen(request,timeout=2) as response:
    body=response.read(32769);assert len(body)<=32768
    return response.status,json.loads(body)
  except urllib.error.HTTPError as error:
   body=error.read(32769);assert len(body)<=32768
   return error.code,json.loads(body)
 code,health=fetch("GET","/healthz");assert code==200 and health["backend"]=="postgresql" and health["generationId"]==record["generation"]
 code,progress=fetch("GET","/api/v2/operations/closed-loop")
 assert code==200 and progress["backend"]=="postgresql" and progress["generationId"]==record["generation"]
 assert progress["coverageVerified"] is False and progress["gatewayDeliveryEnabled"] is False and progress["legacyTotalsIncluded"] is False
 assert progress["runnableDelta15m"] is None and progress["sampledAt"]==progress["asOf"] and progress["stages"]
 for row in progress["stages"]:
  assert re.fullmatch("(0|[1-9][0-9]*)",row["count"]) and re.fullmatch("(0|[1-9][0-9]*)",row["newRecords1h"])
 code,_=fetch("POST","/api/v2/operations/closed-loop");assert code==405
 return progress
try:
 guard()
 child=subprocess.Popen([node,"--max-old-space-size=128","--no-global-search-paths",runner,file,service],
  stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 for stream in (child.stdout,child.stderr):
  os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ);buffers[stream.fileno()]=b""
 deadline=time.monotonic()+55;next_guard=0
 while selector.get_map() or child.poll() is None:
  assert time.monotonic()<deadline,"G11 dispatcher/CLI deadline"
  if time.monotonic()>=next_guard:guard();next_guard=time.monotonic()+.5
  if future is not None and future.done():
   polls.append(future.result());requests=3;future=None;stop()
  for key,_ in selector.select(.1):
   chunk=os.read(key.fd,4096)
   if not chunk:
    assert not buffers[key.fd],"Unterminated fixture output";selector.unregister(key.fileobj);continue
   captured+=len(chunk);assert captured<=131072,"Fixture output budget"
   buffers[key.fd]+=chunk
   assert len(buffers[key.fd])<=32768,"Fixture output line budget"
   while b"\n" in buffers[key.fd]:
    line,buffers[key.fd]=buffers[key.fd].split(b"\n",1)
    if key.fileobj is child.stderr:
     text=re.sub(r"postgres(?:ql)?://[^\s]+","[private-url]",line.decode("utf-8",errors="replace"),flags=re.I)
     stderr_tail=(stderr_tail+text+"\n")[-4096:];continue
    value=json.loads(line)
    if value.get("event")=="g11-dispatch-ipc":
     assert value["service"]==service
     if value["type"]=="postgres-service-ready":
      ready+=1;assert ready==1
      if service=="console":future=executor.submit(console_cycle)
     else:assert value["type"]=="postgres-service-drained";drained+=1
    elif "result" in value:
     assert value["service"]==service and service!="console" and ready==1
     failed(value["result"]);polls.append(value["result"]);assert len(polls)==1;stop()
    elif value.get("status")=="passed":receipt=value
    elif value.get("status")=="failed":
     last_failure={key:value[key] for key in ("status","service","stage","errorName","message") if key in value}
     raise AssertionError("Actual dispatcher/CLI returned a failure receipt")
    else:raise AssertionError("Actual dispatcher/CLI refused or attempted forbidden external HTTP")
 assert child.wait(timeout=2)==0 and receipt is not None and stopping
 assert ready==1 and drained==1 and len(polls)==1 and not group()
 assert receipt["ready"]==1 and receipt["drained"]==1 and receipt["actualIpc"] is True
 guard();receipt.update(polls=1,closed=True,consoleRequests=requests,externalFetchCalls=0,
  maxProcessTreeRssBytes=peak,minMemAvailableBytes=str(minimum_memory),minDiskAvailableBytes=str(minimum_disk),
  coverageVerified=False,legacyTotalsIncluded=False)
 print(json.dumps(receipt))
except Exception as error:
 print(json.dumps({"status":"failed","service":service,"stage":"bounded-default-dispatcher-cli-watch",
  "nonce":nonce,"database":record["database"],"schema":record["schema"],
  "childExitCode":None if child is None else child.poll(),"ready":ready,"drained":drained,"polls":len(polls),
  "maxProcessTreeRssBytes":peak,"minMemAvailableBytes":minimum_memory,"minDiskAvailableBytes":minimum_disk,
  "errorName":type(error).__name__,"message":str(error)[:240],"cliFailure":last_failure,"stderrTail":stderr_tail}));sys.exit(1)
finally:
 if child is not None and group():
  os.killpg(child.pid,signal.SIGTERM);limit=time.monotonic()+5
  while group() and time.monotonic()<limit:time.sleep(.05)
  if group():os.killpg(child.pid,signal.SIGKILL)
  limit=time.monotonic()+2
  while group() and time.monotonic()<limit:time.sleep(.05)
  assert not group(),"Own CLI process-group cleanup not confirmed"
 selector.close();executor.shutdown(wait=True,cancel_futures=True)
`;

function cliBinary(platform:"local"|"linux-x64",overridePath?:string,overrideSha?:string) {
  const request=createRequire(import.meta.resolve("tsx"));
  const packagePath=request.resolve("esbuild/package.json"),metadata=JSON.parse(readFileSync(packagePath,"utf8")) as {version:string;"esbuild.binaryHashes":Record<string,string>};
  const target=platform==="local"?process.platform+"-"+process.arch:"linux-x64";
  const binaryName="@esbuild/"+target+"/bin/esbuild",expected=metadata["esbuild.binaryHashes"][binaryName];
  if(!expected||!/^[a-f0-9]{64}$/.test(expected))throw new Error("Installed esbuild published binary pin required");
  if(overrideSha!==undefined&&overrideSha!==expected)throw new Error("G11 esbuild artifact must match the installed published binary pin");
  let binaryPath=overridePath;
  if(!binaryPath){try{binaryPath=request.resolve(binaryName);}catch{throw new Error("G11 Linux x64 esbuild "+metadata.version+" binary unavailable: supply an existing pinned private artifact before any PG fixture; no download or substitute launcher");}}
  if(resolve(binaryPath)!==binaryPath||lstatSync(binaryPath).isSymbolicLink()||!lstatSync(binaryPath).isFile())throw new Error("Nonregular G11 esbuild artifact refused");
  const body=readFileSync(binaryPath);
  if(body.length>16777216||sha(body)!==expected)throw new Error("G11 esbuild binary identity refused");
  if(target==="linux-x64"&&(body.subarray(0,4).toString("hex")!=="7f454c46"||body[4]!==2||body[5]!==1||body.readUInt16LE(18)!==62))throw new Error("G11 Linux x64 ELF binary required");
  return {binaryPath,binaryName,version:metadata.version,expected,packagePath};
}

interface FileEntry {path:string;body:string;mode:number}
async function packageFixture(options:{dispatcher?:boolean;platform?:"local"|"linux-x64"}={}) {
  // Resolve and pin the platform closure before a cluster or privileged installation can begin.
  const binary=options.dispatcher?cliBinary(options.platform??"local",options.platform==="linux-x64"?process.env.ADDRESS_RADAR_REHEARSAL_ESBUILD_LINUX_FILE:undefined,
    options.platform==="linux-x64"?process.env.ADDRESS_RADAR_REHEARSAL_ESBUILD_LINUX_SHA256:undefined):undefined;
  const maximumClosureBytes=options.dispatcher?33554432:8388608;
  const directory=mkdtempSync(join(realpathSync(tmpdir()),"radar-g11-package-")),marker=randomBytes(16).toString("hex");
  writeFileSync(join(directory,"owner"),marker,{mode:0o600,flag:"wx"});
  const release=join(directory,"release");mkdirSync(join(release,"scripts"),{recursive:true});
  const esbuild=createRequire(import.meta.resolve("tsx"))("esbuild") as {build(options:unknown):Promise<{metafile:{outputs:Record<string,{imports:{path:string}[]}>}}>};
  try {
    const result=await esbuild.build({stdin:{contents:sourceBundle.replaceAll("__REPO__",repo),resolveDir:repo,sourcefile:"isolated-root-exports.ts"},
      outfile:join(release,"scripts/postgres-service-entry.ts"),bundle:true,platform:"node",format:"esm",target:"node24",external:["pg-native"],alias:Object.fromEntries(["database","domain","identity","scoring","collectors","aggregation","signal-engine","observability"].map(name=>["@address-radar/"+name,join(repo,"packages",name,"src/index.ts")])),
      banner:{js:'import { createRequire as __g11CreateRequire } from "node:module"; const require = __g11CreateRequire(import.meta.url);'+(options.dispatcher?'globalThis.fetch=async()=>{process.stdout.write(JSON.stringify({event:"g11-external-fetch-forbidden"})+"\\n");throw new Error("External HTTP forbidden in isolated CLI fixture");};':'')},metafile:true,logLevel:"silent"});
    const allowed=new Set([...builtinModules,...builtinModules.map(value=>"node:"+value),"pg-native"]);
    for(const output of Object.values(result.metafile.outputs))for(const imported of output.imports)if(!allowed.has(imported.path))throw new Error("Unsealed external dependency: "+imported.path);
    // Dispatcher mode seals the genuine launcher, API and exact platform binary; no shim launcher.
    const tsxRoot=resolve(dirname(fileURLToPath(import.meta.resolve("tsx"))),"..");
    mkdirSync(join(release,"node_modules/tsx"),{recursive:true});cpSync(join(tsxRoot,"dist"),join(release,"node_modules/tsx/dist"),{recursive:true});
    cpSync(join(tsxRoot,"package.json"),join(release,"node_modules/tsx/package.json"));
    if(binary){
      const apiRoot=dirname(binary.packagePath),apiTarget=join(release,"node_modules/esbuild");
      mkdirSync(join(apiTarget,"lib"),{recursive:true});cpSync(binary.packagePath,join(apiTarget,"package.json"));
      cpSync(join(apiRoot,"lib/main.js"),join(apiTarget,"lib/main.js"));
      const binaryTarget=join(release,"node_modules",binary.binaryName);mkdirSync(dirname(binaryTarget),{recursive:true});cpSync(binary.binaryPath,binaryTarget);
      // A thin dispatcher-only parent avoids loading a second full service implementation into RAM.
      const dispatcher=await esbuild.build({entryPoints:[join(repo,"packages/database/src/postgres-service-dispatch.ts")],outfile:join(release,"dispatch-api.mjs"),bundle:true,platform:"node",format:"esm",target:"node24",metafile:true,logLevel:"silent"});
      for(const output of Object.values(dispatcher.metafile.outputs))for(const imported of output.imports)if(!allowed.has(imported.path))throw new Error("Unsealed dispatcher dependency: "+imported.path);
      writeFileSync(join(release,"dispatch.mjs"),dispatcherSource);writeFileSync(join(release,"dispatch-watch.py"),dispatcherWatchPython);
    }
    writeFileSync(join(release,"tsconfig.json"),'{"compilerOptions":{"target":"ES2023","module":"NodeNext","moduleResolution":"NodeNext"}}\n');
    writeFileSync(join(release,"package.json"),'{"private":true,"type":"module"}\n');
    writeFileSync(join(release,"smoke.mjs"),smokeSource);
    const files:FileEntry[]=[];
    const walk=(path:string)=>{const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw new Error("Nonregular local closure");
      if(stat.isDirectory()){for(const name of readdirSync(path).sort())walk(join(path,name));}
      else {const name=relative(release,path);files.push({path:name,body:readFileSync(path).toString("base64"),mode:binary&&name==="node_modules/"+binary.binaryName?0o555:0o444});}};
    walk(release);
    files.push({path:"fixture-hash-manifest.json",body:Buffer.from(JSON.stringify({scope:options.dispatcher?"isolated-dispatcher-cli-ipc":"isolated-exported-root-factory",binary:binary?{name:binary.binaryName,version:binary.version,sha256:binary.expected}:null,files:files.map(file=>({path:file.path,sha256:sha(Buffer.from(file.body,"base64"))}))})+"\n").toString("base64"),mode:0o444});
    const directories=new Set(["."]);for(const file of files){let parent=dirname(file.path);while(parent!=="."){directories.add(parent);parent=dirname(parent);}}
    const records=new Map<string,string>();for(const path of directories)records.set(path,JSON.stringify({path,mode:0o555,kind:"directory"})+"\n");
    let bytes=0;for(const file of files){const content=Buffer.from(file.body,"base64");bytes+=content.length;records.set(file.path,JSON.stringify({path:file.path,mode:file.mode,kind:"file",size:content.length,sha256:sha(content)})+"\n");}
    const ordered:string[]=[];const digestWalk=(path:string)=>{ordered.push(records.get(path)!);if(directories.has(path)){
      const prefix=path==="."?"":path+"/";const children=[...records.keys()].filter(key=>key!==path&&key.startsWith(prefix)&&!key.slice(prefix.length).includes("/")).sort();for(const child of children)digestWalk(child);
    }};digestWalk(".");
    const entry=files.find(file=>file.path==="scripts/postgres-service-entry.ts")!;
    if(bytes>=maximumClosureBytes||records.size>=256)throw new Error("Bounded G11 closure inventory exceeded");
    return {files,bytes,entries:records.size,releaseSha:sha(ordered.join("")),entrySha:sha(Buffer.from(entry.body,"base64")),release,maximumClosureBytes,
      cleanup(){if(readFileSync(join(directory,"owner"),"utf8")!==marker||lstatSync(directory).isSymbolicLink())throw new Error("Own local package cleanup refused");rmSync(directory,{recursive:true});}};
  } catch(error){if(readFileSync(join(directory,"owner"),"utf8")===marker)rmSync(directory,{recursive:true});throw error;}
}

function signedFixture(input: {target: CutoverPostgresTarget; tables: string[]; nonce: string; sourcePath: string; capacity: string}) {
  if(input.target.database!=="radar_rehearsal_"+input.nonce||input.target.schema!==input.target.database+"_schema"||input.target.serverPort!==5434)throw new Error("Synthetic authority is restricted to the private same-nonce fixture");
  const anchor=Date.now(), at=(delta=0)=>new Date(anchor+delta).toISOString();
  const keys=generateKeyPairSync("ed25519"), independent=generateKeyPairSync("ed25519");
  const keyBase64=keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const firstWrite={writeId:"synthetic-marker-"+input.nonce};
  const target=input.target;
  const policy: WriterFencePolicy = {
    version: 2, evidenceMode: "production-observation", hostId: "fixture-host", bootId: "fixture-boot", challengeId: "fixture-fence",
    binding: { source: { id: "fixture-source", canonicalPath: input.sourcePath, device: "1", inode: "2", schemaSha256: hash() },
      sourceGeneration: "sqlite-generation-1", generation: target.generation, watermark: "100", cohortId: "fixture-cohort", snapshot: { id: "fixture-snapshot", sha256: hash() },
      target, rollbackTarget: { ...target, releaseSha256: hash("b") } },
    writers: [...CUTOVER_SERVICES.map(id => ({ id, kind: "services" as const, executableSha256: hash() })),
      ...CUTOVER_TIMERS.map(id => ({ id, kind: "timers" as const, executableSha256: hash() })),
      { id: "fixture-operator", kind: "operators", executableSha256: hash() },
      { id: "fixture-deploy", kind: "deploy", executableSha256: hash() },
      { id: "fixture-usercron", kind: "usercron", executableSha256: hash() },
      { id: "fixture-bridge", kind: "externalInputs", executableSha256: hash() },
      { id: "fixture-external-input", kind: "externalInputs", executableSha256: hash() }],
    catalog: ["fixture_trades", "fixture_provider_guards", "fixture_delivery_guards"],
    guards: [{ id: "fixture-provider", kind: "provider", rows: "2", sha256: hash("c") }, { id: "fixture-delivery", kind: "delivery", rows: "3", sha256: hash("d") }],
    collectors: [{ issuerId: "fixture-collector", keyId: "fixture-collector-key", publicKeyBase64: keyBase64, collectorSha256: hash(), kinds: [...PREPARATION_OBSERVATIONS, "rollback"] }],
    reviewers: [{ issuerId: "fixture-reviewer", keyId: "fixture-reviewer-key", publicKeyBase64: keyBase64, actions: ["prepare", "select-postgres", "first-postgres-write", "rollback", "abort"] }],
    deadlines: { windowStart: at(-30_000), windowEnd: at(250_000), maximumEvidenceAgeMs: 300_000, maximumOperationMs: 10_000, maximumLockMs: 1000 },
    budgets: { connections: [], migrationConnections: 1, operatorConnections: 1, backupConnections: 1, reservedConnections: 2, maximumConnections: 32,
      availableRamBytes: String(BigInt(input.capacity.split(":")[0]!)*1024n), peakRamBytes: "16777216", reserveRamBytes: "16777216", availableDiskBytes: String(BigInt(input.capacity.split(":")[1]!)*1024n), peakDiskBytes: "16777216", peakWalBytes: "67108864", peakTempBytes: "0", reserveDiskBytes: "16777216",
      maximumTransitions: 16, maximumSqlStatements: 32 },
  };
  policy.budgets.connections = policy.writers.map(w => ({ writerId: w.id, instances: 1, maximumEach: w.kind === "services" ? 1 : 0 }));
  const signObservation = (observation: CutoverObservation): CutoverObservation => {
    observation.signatureBase64 = sign(null, Buffer.from(migrationCutoverObservationPayload(observation)), keys.privateKey).toString("base64");
    return observation;
  };
  const report = (kind: CutoverObservation["kind"], body: Record<string, unknown>, observedAt = at(-5000)): CutoverObservation => signObservation({
    version: 2, kind, issuerId: "fixture-collector", keyId: "fixture-collector-key", evidenceMode: policy.evidenceMode,
    binding: clone(policy.binding), observedAt, expiresAt: at(240_000),
    provenance: { hostId: policy.hostId, bootId: policy.bootId, collectorSha256: hash(), runId: `fixture-run-${kind}`, sequence: "1", challengeId: policy.challengeId },
    body, signatureBase64: "",
  });
  const sourceTables = policy.catalog.map(table => ({ table, rows: "9007199254740993", sha256: hash() }));
  const parityTables = sourceTables.map(t => ({ table: t.table, sourceRows: t.rows, preservedRows: "9007199254740992", quarantinedRows: "1", sourceSha256: t.sha256, retainedSha256: t.sha256 }));
  const parity = { snapshotSha256: policy.binding.snapshot.sha256, watermark: policy.binding.watermark, tables: parityTables };
  const bundle: WriterFenceBundle = { version: 2, activation: { delivery: false, fomo: false, history: false, ownerMerge: false }, observations: {
    fence: report("fence", { fenceId: policy.challengeId, enforcedAt: at(-20_000), validUntil: at(240_000), deniedGenerations: [policy.binding.sourceGeneration],
      barriers: policy.writers.map(w => ({ writerId: w.id, admission: "denied", input: "blocked", rejection: { attemptId: `fixture-rejection-${w.id}`, generation: policy.binding.sourceGeneration, result: "generation-rejected" } })) }),
    snapshot: report("snapshot", { mode: "full-fenced-snapshot", fenceId: policy.challengeId, snapshotId: policy.binding.snapshot.id, snapshotSha256: policy.binding.snapshot.sha256,
      watermark: policy.binding.watermark, startedAt: at(-17_000), completedAt: at(-15_000), catalogSha256: migrationCutoverDigest(policy.catalog), tables: sourceTables }),
    census: report("census", { fenceId: policy.challengeId, snapshotSha256: policy.binding.snapshot.sha256, startedAt: at(-10_000), completedAt: at(-8000), methods: [...CENSUS_METHODS],
      groups: WRITER_KINDS.map(kind => ({ kind, writerIds: policy.writers.filter(w => w.kind === kind).map(w => w.id) })), writers: clone(policy.writers),
      scannedPaths: [input.sourcePath, input.sourcePath+"-wal", input.sourcePath+"-shm"],
      files: [{ canonicalPath: input.sourcePath, device: "1", inode: "2" }, { canonicalPath: input.sourcePath+"-wal", device: null, inode: null }, { canonicalPath: input.sourcePath+"-shm", device: null, inode: null }], processes: [], fileHolders: [] }),
    parity: report("parity", parity),
    target: report("target", { current: clone(policy.binding.target), compatible: clone(policy.binding.rollbackTarget), probeSha256: hash() }),
    guards: report("guards", { baseline: clone(policy.guards), retained: clone(policy.guards), probeSha256: hash() }),
    capacity: report("capacity", { budgetSha256: migrationCutoverDigest(policy.budgets), measurementId: "fixture-measurement", traceSha256: hash(), startedAt: at(-25_000), completedAt: at(-10_000),
      peakRamBytes: "16777216", peakDiskBytes: "16777216", peakWalBytes: "67108864", peakTempBytes: "0", connectionPeak: 11 }),
    rehearsal: report("rehearsal", { before: { target: "source-only", snapshotSha256: policy.binding.snapshot.sha256, paritySha256: migrationCutoverDigest(parity), guardsSha256: migrationCutoverDigest(policy.guards), receiptSha256: hash(), testedAt: at(-12_000) },
      after: { target: clone(policy.binding.rollbackTarget), writeReceiptSha256: hash(), retainedMutationsSha256: hash(), recoveredMutationsSha256: hash(), guardsSha256: migrationCutoverDigest(policy.guards), receiptSha256: hash(), startedAt: at(-12_000), firstWriteAt: at(-11_000), completedAt: at(-9000) } }),
  } };
  // Synthetic signed authority only: this does not attest production observations or actual compatible-release recovery.
  policy.postgresRollbackCatalog=input.tables.map(table=>({table,operations:POSTGRES_BUSINESS_RUNTIME_PROTECTED_TABLES.includes(table as never)?[]:["insert","update","delete"]}));
  policy.postgresRollbackVerifier={issuerId:"fixture-independent",keyId:"fixture-independent-key"};
  policy.collectors.push({...policy.postgresRollbackVerifier,publicKeyBase64:independent.publicKey.export({type:"spki",format:"der"}).toString("base64"),collectorSha256:hash("9"),kinds:["rehearsal"]});
  const proof:CompatiblePostgresReleaseProof={version:2,binding:clone(policy.binding),strategy:"compatible-postgres-release",recoveryMode:"retain-live-postgres-data",backend:"postgres",
    candidate:clone(target),compatible:clone(policy.binding.rollbackTarget),candidateArtifactSha256:target.releaseSha256,compatibleArtifactSha256:policy.binding.rollbackTarget.releaseSha256,
    catalogSha256:migrationCutoverDigest(policy.postgresRollbackCatalog),schemaProbeSha256:hash(),mutationTraceSha256:hash(),parentTransactionRollbackReceiptSha256:hash(),
    commitUnknownReconciliationReceiptSha256:hash(),providerGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="provider")),deliveryGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="delivery")),
    startedAt:at(-14000),firstWriteAt:at(-13000),completedAt:at(-7000),
    tableChecks:policy.postgresRollbackCatalog.map(entry=>({table:entry.table,retainedRows:"0",recoveredRows:"0",retainedSha256:hash(),recoveredSha256:hash(),
      cases:entry.operations.map(operation=>({operation,committedReceiptSha256:hash(),compatibleReadReceiptSha256:hash(),compatibleWriteReceiptSha256:hash()}))})),
    guardChecks:POSTGRES_COMPATIBILITY_GUARD_CHECKS.map(check=>({check,receiptSha256:hash()})),
    attestation:{...policy.postgresRollbackVerifier,observedAt:at(-6000),expiresAt:at(240000),provenance:{hostId:policy.hostId,bootId:policy.bootId,challengeId:policy.challengeId,collectorSha256:hash("9"),runId:"fixture-independent-run",sequence:"1"},signatureBase64:""}};
  proof.attestation.signatureBase64=sign(null,Buffer.from(migrationCompatiblePostgresRollbackPayload(proof)),independent.privateKey).toString("base64");
  bundle.observations.rehearsal.body.compatibleRelease=proof;signObservation(bundle.observations.rehearsal);
  const fixtureIndependentKeys=independent;
function syntheticSeal<T>(kind:"authorization"|"census"|"snapshot"|"rollback",payload:T):FenceClosureSigned<T>{return{payload,signatureBase64:sign(null,fenceClosureSigningMessage(kind,payload),kind==="rollback"?fixtureIndependentKeys.privateKey:keys.privateKey).toString("base64")};}
function fixtureString(value:unknown):string{if(typeof value!=="string")throw new Error("Synthetic evidence requires a literal string");return value;}
function refreshSyntheticClosure(policy:WriterFencePolicy,bundle:WriterFenceBundle):void {
  const scopes:FenceClosureScope[]=policy.writers.map(w=>({id:w.id,kind:w.kind==="services"?"service":w.kind==="timers"?"timer":w.kind==="operators"?"operator":w.kind==="usercron"?"cron":w.kind==="deploy"?"deploy":w.id==="fixture-bridge"?"bridge":"external-input",paths:w.id==="fixture-bridge"?["/fixture/input","/fixture/output"]:[policy.binding.source.canonicalPath],directions:w.id==="fixture-bridge"?["source-to-input","output-to-source"]:[]}));
  const binding={sourcePath:policy.binding.source.canonicalPath,sourceDevice:policy.binding.source.device,sourceInode:policy.binding.source.inode,generation:policy.binding.generation,watermark:policy.binding.watermark,cluster:policy.binding.target.systemIdentifier,schemaSha256:policy.binding.target.schemaSha256,release:policy.binding.target.releaseSha256,artifactSha256:policy.binding.target.releaseSha256,cohortSha256:migrationCutoverDigest({cohortId:policy.binding.cohortId},2),providerGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="provider")),deliveryGuardSha256:migrationCutoverDigest(policy.guards.filter(g=>g.kind==="delivery"))};
  const pem=keys.publicKey.export({type:"spki",format:"pem"}).toString();
  policy.closureTrust={authorizationPublicKeyPem:pem,observerPublicKeyPem:pem,snapshotPublicKeyPem:pem,independentCompatibilityPublicKeyPem:fixtureIndependentKeys.publicKey.export({type:"spki",format:"pem"}).toString(),expectedBinding:binding,expectedScopesSha256:fenceClosureEvidenceSha256(scopes),expectedTableNames:[...policy.catalog],expectedRollbackRelease:policy.binding.rollbackTarget.releaseSha256,expectedRollbackArtifactSha256:policy.binding.rollbackTarget.releaseSha256,maximumEvidenceAgeMs:policy.deadlines.maximumEvidenceAgeMs,maximumMaintenanceWindowMs:Date.parse(policy.deadlines.windowEnd)-Date.parse(policy.deadlines.windowStart)};
  const authorization={binding,scopes,windowStart:policy.deadlines.windowStart,windowEnd:policy.deadlines.windowEnd,maximumSqlStatements:policy.budgets.maximumSqlStatements,maximumTransactionMs:policy.deadlines.maximumOperationMs};
  const census={authorizationSha256:fenceClosureEvidenceSha256(authorization),observedAt:bundle.observations.census.observedAt,fencedAt:fixtureString(bundle.observations.fence.body.enforcedAt),scopes:scopes.map(s=>({id:s.id,admission:"closed" as const,controlReceiptSha256:hash(),closedUntil:policy.deadlines.windowEnd,processIds:[],timer:s.kind==="timer"?"disabled-no-pending-trigger" as const:"not-applicable" as const,bridgeDirections:[...s.directions],cursorReceiptSha256:s.kind==="bridge"?hash():null})),processes:[],discoveredScopeIds:scopes.map(s=>s.id),sourceDevice:binding.sourceDevice,sourceInode:binding.sourceInode,sourcePath:binding.sourcePath,generation:binding.generation,watermark:binding.watermark};
  const rawTables=bundle.observations.snapshot.body.tables;if(!Array.isArray(rawTables))throw new Error("Synthetic snapshot tables required");
  const tables=rawTables.map((entry:Record<string,unknown>)=>({name:fixtureString(entry.table),rowCount:fixtureString(entry.rows),sha256:fixtureString(entry.sha256)}));
  const parity=migrationCutoverDigest(bundle.observations.parity.body);
  const snapshot={authorizationSha256:fenceClosureEvidenceSha256(authorization),censusSha256:fenceClosureEvidenceSha256(census),binding,kind:"final-full-fenced" as const,startedAt:fixtureString(bundle.observations.snapshot.body.startedAt),completedAt:fixtureString(bundle.observations.snapshot.body.completedAt),tableCensusSha256:fenceClosureEvidenceSha256(tables),tables,parityReceiptSha256:parity,restoreReceiptSha256:hash()};
  const proof=bundle.observations.rehearsal.body.compatibleRelease;
  const completed=proof===undefined?fixtureString((bundle.observations.rehearsal.body.after as Record<string,unknown>).completedAt):fixtureString((proof as Record<string,unknown>).completedAt);
  const rollback={authorizationSha256:fenceClosureEvidenceSha256(authorization),binding,route:proof===undefined?"source-before-first-write" as const:"compatible-postgres-release" as const,completedAt:completed,parityReceiptSha256:parity,rollbackRelease:proof===undefined?null:policy.binding.rollbackTarget.releaseSha256,rollbackArtifactSha256:proof===undefined?null:policy.binding.rollbackTarget.releaseSha256,compatibilityTestReceiptSha256:proof===undefined?null:migrationCutoverDigest(proof,2),preservedProviderGuardSha256:binding.providerGuardSha256,preservedDeliveryGuardSha256:binding.deliveryGuardSha256};
  bundle.closure={authorization:syntheticSeal("authorization",authorization),census:syntheticSeal("census",census),snapshot:syntheticSeal("snapshot",snapshot),rollback:syntheticSeal("rollback",rollback)};
}

  refreshSyntheticClosure(policy,bundle);
  const evaluation = () => evaluateMigrationWriterFence(bundle, policy, at());
  const resignAll = () => {Object.values(bundle.observations).forEach(signObservation);refreshSyntheticClosure(policy,bundle);};
  const authorize = (command: CutoverCommand) => {
    command.authorization.signatureBase64 = sign(null, Buffer.from(migrationCutoverAuthorizationPayload(command)), keys.privateKey).toString("base64");
    return command;
  };
  const command = (action: CutoverAction, revision: number, operationId = `fixture-${action}`): CutoverCommand => {
    const issuedAt=Date.now(),deadline=new Date(issuedAt+10000).toISOString();
    return authorize({
    version:2, operationId, action, expectedRevision: revision, planSha256: migrationCutoverPlanDigest(policy,bundle), deadline,
    writeId: action === "first-postgres-write" ? firstWrite.writeId : null, recovery: null,
    authorization: { issuerId: "fixture-reviewer", keyId: "fixture-reviewer-key", issuedAt: new Date(issuedAt).toISOString(), expiresAt: deadline, signatureBase64: "" },
    });
  };
  const recovery = (c: CutoverCommand, state: DurableCutoverState) => {
    c.recovery = report("rollback", { operationId: c.operationId, stateRevision: state.revision, planSha256: state.planSha256,
      target: state.firstPostgresWrite ? clone(policy.binding.rollbackTarget) : "source-only", snapshotSha256: policy.binding.snapshot.sha256,
      watermark: state.firstPostgresWrite ? "101" : policy.binding.watermark, firstWriteReceiptSha256: state.firstPostgresWrite?.receiptSha256 ?? null,
      tables: clone(parityTables), guards: clone(policy.guards),
      providerGuardSha256: state.firstPostgresWrite?.providerGuardSha256 ?? migrationCutoverDigest(policy.guards.filter(g => g.kind === "provider")),
      deliveryGuardSha256: state.firstPostgresWrite?.deliveryGuardSha256 ?? migrationCutoverDigest(policy.guards.filter(g => g.kind === "delivery")),
      retainedMutationsSha256: state.firstPostgresWrite ? hash() : null, recoveredMutationsSha256: state.firstPostgresWrite ? hash() : null }, at());
    return authorize(c);
  };
  return { policy, bundle, evaluation, resignAll, signObservation, authorize, command, recovery,
    signCompatibility:(value:CompatiblePostgresReleaseProof)=>{value.attestation.signatureBase64=sign(null,Buffer.from(migrationCompatiblePostgresRollbackPayload(value)),independent.privateKey).toString("base64");return value;},
    refreshClosure:()=>refreshSyntheticClosure(policy,bundle) };
}

const installPython=String.raw`
import os,sys,json,stat,hashlib,shutil,pwd,base64
v=json.load(sys.stdin); nonce=v["nonce"]; assert len(nonce)==16 and all(c in "0123456789abcdef" for c in nonce)
base="/opt/address-radar-rehearsal"; root=base+"/"+nonce
for path in ("/","/opt"):
 s=os.lstat(path);assert s.st_uid==0 and not stat.S_ISLNK(s.st_mode) and s.st_mode&0o022==0
if not os.path.exists(base):os.mkdir(base,0o755)
s=os.lstat(base);assert s.st_uid==0 and stat.S_ISDIR(s.st_mode) and s.st_mode&0o022==0
assert not os.path.lexists(root);os.mkdir(root,0o700)
with open(root+"/owner","x") as f:f.write(v["marker"])
os.chmod(root+"/owner",0o444)
def digest(path):
 h=hashlib.sha256()
 with open(path,"rb") as f:
  for block in iter(lambda:f.read(1048576),b""):h.update(block)
 return h.hexdigest()
source="/usr/local/bin/node";s=os.lstat(source);assert stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_size<200000000
assert digest(source)==v["nodeSha"]
os.mkdir(root+"/bin",0o555);shutil.copyfile(source,root+"/bin/node");assert digest(root+"/bin/node")==v["nodeSha"];os.chmod(root+"/bin/node",0o555)
release=root+"/release";os.mkdir(release,0o700)
assert v["maximumClosureBytes"] in (8388608,33554432)
assert len(v["files"])<256 and sum(len(base64.b64decode(f["body"])) for f in v["files"])<v["maximumClosureBytes"]
for file in v["files"]:
 name=file["path"];assert not name.startswith("/") and all(part not in ("",".","..") for part in name.split("/"))
 path=release+"/"+name;os.makedirs(os.path.dirname(path),mode=0o700,exist_ok=True)
 with open(path,"xb") as f:f.write(base64.b64decode(file["body"],validate=True))
 assert file["mode"] in (0o444,0o555)
 if file["mode"]==0o555:assert name.startswith("node_modules/@esbuild/") and name.endswith("/bin/esbuild")
 os.chmod(path,file["mode"])
for path,dirs,files in os.walk(release,topdown=False):os.chmod(path,0o555)
actor=pwd.getpwnam("address-radar");private=root+"/private";os.mkdir(private,0o700);os.chown(private,actor.pw_uid,actor.pw_gid)
os.chmod(root,0o555);print(json.dumps({"installed":True,"nonce":nonce,"nodeSha":digest(root+"/bin/node")}))
`;
const privatePython=String.raw`
import os,sys,json,stat,pwd
v=json.load(sys.stdin);root=v["root"];nonce=v["nonce"]
assert root=="/opt/address-radar-rehearsal/"+nonce and len(nonce)==16 and all(c in "0123456789abcdef" for c in nonce)
s=os.lstat(root);assert s.st_uid==0 and stat.S_ISDIR(s.st_mode)
assert open(root+"/owner").read()==v["marker"]
actor=pwd.getpwnam("address-radar");path=root+"/private";s=os.lstat(path);assert stat.S_ISDIR(s.st_mode) and s.st_uid==actor.pw_uid and s.st_mode&0o777==0o700
fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for file in v["files"]:
  assert file["name"].endswith(".json") and "/" not in file["name"] and ".." not in file["name"]
  f=os.open(file["name"],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
  try:os.fchown(f,actor.pw_uid,actor.pw_gid);os.write(f,file["body"].encode())
  finally:os.close(f)
finally:os.close(fd)
print("private-fixture-files-installed")
`;
const cleanupPython=String.raw`
import os,sys,json,stat,signal,time,shutil,pwd
v=json.load(sys.stdin);root=v["root"];nonce=v["nonce"]
assert root=="/opt/address-radar-rehearsal/"+nonce and len(nonce)==16 and all(c in "0123456789abcdef" for c in nonce)
if not os.path.lexists(root):print("own-sealed-fixture-absent");sys.exit(0)
s=os.lstat(root);assert s.st_uid==0 and stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
marker=root+"/owner";s=os.lstat(marker);assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1
assert open(marker).read()==v["marker"]
actor=pwd.getpwnam("address-radar")
def owned():
 out=[]
 for pid in os.listdir("/proc"):
  if not pid.isdigit():continue
  try:
   if os.readlink("/proc/"+pid+"/exe") in (root+"/bin/node",root+"/release/node_modules/@esbuild/linux-x64/bin/esbuild"):
    assert os.stat("/proc/"+pid).st_uid==actor.pw_uid
    assert (root+"/release/").encode() in open("/proc/"+pid+"/cmdline","rb").read()
    out.append(int(pid))
  except FileNotFoundError:pass
 return out
for pid in owned():os.kill(pid,signal.SIGTERM)
limit=time.monotonic()+2
while owned() and time.monotonic()<limit:time.sleep(.05)
for pid in owned():os.kill(pid,signal.SIGKILL)
limit=time.monotonic()+2
while owned() and time.monotonic()<limit:time.sleep(.05)
assert not owned();shutil.rmtree(root);assert not os.path.lexists(root);print("own-sealed-fixture-cleaned")
`;
function fixtureAdmin(ctx:Context,sql:string):string {
  if(ctx.database!=="radar_rehearsal_"+ctx.nonce||ctx.schema!==ctx.database+"_schema"||ctx.remoteConnectionPath!=="/tmp/"+ctx.database+"/connection.json")throw new Error("Private bootstrap binding refused");
  ctx.guard();
  const root="/tmp/"+ctx.database,connectionSha=sha(readFileSync(ctx.connectionPath));
  return sshRun("sudo -n -u postgres sh -s",`set -eu
root=${literal(root)}
test ! -L "$root" && test "$(stat -c %u "$root")" = "$(id -u)"
test ! -L "$root/connection.json" && test "$(stat -c %a "$root/connection.json")" = 600
test "$(sha256sum "$root/connection.json" | cut -d ' ' -f1)" = ${literal(connectionSha)}
/usr/lib/postgresql/16/bin/psql -X -qAt -h "$root/socket" -p5434 -d ${ctx.database} -v ON_ERROR_STOP=1 <<'SQL'
SET statement_timeout='3s'; SET lock_timeout='500ms';
DO $guard$ BEGIN IF current_setting('port')<>'5434' OR current_setting('data_directory')<>${literal(root+"/data")}
 OR (SELECT system_identifier::text FROM pg_catalog.pg_control_system())<>${literal(ctx.systemIdentifier)}
 THEN RAISE EXCEPTION 'Isolated cluster identity mismatch'; END IF; END $guard$;
${sql}
SQL
`,30000);
}
function requireG11V2Schema(definition:ReturnType<typeof createPostgresServiceSchema>) {
  if(definition.plan.version!==3||definition.supportTables.length!==19)throw new Error("G11 V2 requires reviewed physical schema3 with 19 support tables; no V1 or temporary-DDL fallback");
  return definition;
}
async function runActualRehearsal(pkg:Awaited<ReturnType<typeof packageFixture>>,dispatcher=false) {
  const definition=requireG11V2Schema(createPostgresServiceSchema({protocolVersion:2}));
  if(dispatcher&&process.env.ADDRESS_RADAR_REHEARSAL_MENDEL_SLOT_RELEASED!=="1")throw new Error("Explicit Mendel lifecycle cleanup and slot release required before native CLI rehearsal");
  const lifecyclePath=process.env.ADDRESS_RADAR_PRIVATE_PG16_LIFECYCLE_FILE,lifecycleSha=process.env.ADDRESS_RADAR_PRIVATE_PG16_LIFECYCLE_SHA256;
  if(!lifecyclePath||!lifecycleSha||sha(readFileSync(lifecyclePath))!==lifecycleSha||lstatSync(lifecyclePath).isSymbolicLink())throw new Error("Pinned reviewed private lifecycle is mandatory");
  const lifecycle=await import(pathToFileURL(lifecyclePath).href) as Lifecycle;
  const evidence={services:[] as Record<string,unknown>[],sealed:false,schemaSupportTables:0,markerPhysicalCommitted:false,protocolVersion:2,nativeMarkerSourceKey:"",sealedCleanup:false,clusterCleanup:false,syntheticAuthority:true,dispatcherCliVerified:false};
  await lifecycle.withPrivatePreservationFixture(async ctx=>{
    ctx.guard();process.stdout.write("G11 guarded private PG16 started (same-nonce, port5434)\n");
    const root="/opt/address-radar-rehearsal/"+ctx.nonce,marker=randomBytes(24).toString("hex");
    let native:ReturnType<typeof createPostgresMigrationRuntime>|undefined;
    try {
      const installed=JSON.parse(sshRun("sudo -n python3 -c "+literal(installPython),JSON.stringify({nonce:ctx.nonce,marker,nodeSha:remoteNodeSha,files:pkg.files,maximumClosureBytes:pkg.maximumClosureBytes}),45000));
      expect(installed.installed).toBe(true);expect(installed.nodeSha).toBe(remoteNodeSha);evidence.sealed=true;process.stdout.write("G11 root-owned nonce closure installed\n");
      const privateConnection=JSON.parse(readFileSync(ctx.connectionPath,"utf8")) as {password:string};
      const Pool=createRequire(join(repo,"packages/database/package.json"))("pg").Pool;
      const plan=definition.plan,generation="synthetic-root-"+ctx.nonce,activatedAt=Date.now();
      const roles=Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>[service,ctx.database+"_"+service.replaceAll("-","")])) as Record<PostgresBusinessService,string>;
      const passwords=Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>[service,randomBytes(32).toString("hex")])) as Record<PostgresBusinessService,string>;
      fixtureAdmin(ctx,POSTGRES_BUSINESS_SERVICES.map(service=>`CREATE ROLE ${q(roles[service])} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 PASSWORD ${literal(passwords[service])};`).join("\n")+
        `\nREVOKE ALL ON SCHEMA public FROM PUBLIC;ALTER DEFAULT PRIVILEGES FOR ROLE ${q(ctx.role)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
      const pins=JSON.parse(fixtureAdmin(ctx,`SELECT json_build_object('databaseOid',d.oid::text,'namespaceOid',n.oid::text,'ownerOid',n.nspowner::text)
        FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=current_database() AND n.nspname=${literal(ctx.schema)};`).split("\n").at(-1)!);
      const approvalRef="synthetic-root-only/"+ctx.nonce,authority=generateKeyPairSync("ed25519"),issuedAt=Date.now();
      const receipt:PostgresBusinessProvisionedNamespaceReceipt={version:1,purpose:"provisioned-empty-business-namespace",receiptId:approvalRef,signerKeyId:"synthetic-root-namespace",
        approvalRef,database:ctx.database,databaseOid:pins.databaseOid,schema:ctx.schema,namespaceOid:pins.namespaceOid,owner:ctx.role,ownerOid:pins.ownerOid,generation,service:"migration",
        schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,systemIdentifier:ctx.systemIdentifier,issuedAt,expiresAt:issuedAt+900000};
      const approval=authenticatePostgresBusinessNamespaceReceipt({receipt,signatureBase64:sign(null,Buffer.from(postgresBusinessNamespaceReceiptSigningPayload(receipt)),authority.privateKey).toString("base64")},
        {signerKeyId:receipt.signerKeyId,publicKeyPem:authority.publicKey.export({type:"spki",format:"pem"}).toString(),maximumReceiptAgeMs:900000,clock:Date.now});
      const pool=()=>new Pool({host:"127.0.0.1",port:5434,database:ctx.database,user:ctx.role,password:privateConnection.password,max:1,connectionTimeoutMillis:2000,idleTimeoutMillis:500,query_timeout:3000});
      const migrationTarget={database:ctx.database,username:ctx.role,schema:ctx.schema,generation,service:"migration",serverAddress:"127.0.0.1",serverPort:5434,
        schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,systemIdentifier:ctx.systemIdentifier};
      const makeNative=(purpose:"schema_install"|"business_import")=>createPostgresMigrationRuntime({pool:pool(),target:migrationTarget,
        capability:{mode:"isolated",purpose,approvalRef,planSha256:plan.fingerprint,expiresAtMs:Date.now()+300000},
        limits:{operationTimeoutMs:60000,connectionTimeoutMs:2000,statementTimeoutMs:3000,lockTimeoutMs:500,maximumSqlStatements:2000,workMemKb:1024,closeTimeoutMs:2000},clock:Date.now,
        assertAuthorized:async({target,capability})=>{if(target.database!==ctx.database||target.schema!==ctx.schema||target.systemIdentifier!==ctx.systemIdentifier
          ||capability.mode!=="isolated"||capability.purpose!==purpose||capability.approvalRef!==approvalRef||capability.planSha256!==plan.fingerprint)throw new Error("Synthetic same-nonce authority refused");}});
      native=makeNative("schema_install");
      expect((await installPostgresBusinessSchema(native,{plan,trustedModules:definition.trustedModules,target:{database:ctx.database,username:ctx.role,schema:ctx.schema,generation,service:"migration"},
        approval:"approved-provisioned-business-schema",approvalRef,provisionedNamespaceApproval:approval})).appliedVersions).toEqual([1,2,3]);
      evidence.schemaSupportTables=definition.supportTables.length;expect(plan.version).toBe(3);expect(evidence.schemaSupportTables).toBe(19);process.stdout.write("G11 schema3 with physical V2 ledger/marker installed\n");
      const tables=(await native.run(tx=>tx.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname",[ctx.schema]))).rows.map(row=>String(row.relname));
      expect(tables).toContain("migration_cutover_transitions_v2");expect(tables).toContain("migration_cutover_first_write_markers");
      await native.close();native=undefined;
      // Logical GRANT fixture, not six simultaneous workers or measured production capacity.
      const resources={pools:Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>[service,{instances:1,maximumConnections:1}])),
        serverMaximumConnections:12,postgresReservedConnections:3,otherHostConnections:0,migrationConnections:1,operatorConnections:1,backupConnections:1,
        maximumPendingOperations:0,connectionTimeoutMs:2000,idleTimeoutMs:500,statementTimeoutMs:3000,lockTimeoutMs:500,idleTransactionTimeoutMs:10000,
        shutdownTimeoutMs:2000,workMemKb:1024,maximumMeasurementAgeMs:60000} as PostgresBusinessProvisioningResources;
      const now=new Date().toISOString();
      const grants=createPostgresBusinessProvisioningPlan({database:ctx.database,schema:ctx.schema,generation,migratorRole:ctx.role,serviceRoles:roles,
        resources,schemaPlan:plan,trustedModules:definition.trustedModules,now,capacity:{status:"measured",hostId:"synthetic-grant-policy",measurementRef:"synthetic-only/not-production-capacity",
          resourcePolicyFingerprint:postgresBusinessResourcePolicyFingerprint(resources),measuredAt:now,validUntil:new Date(Date.now()+60000).toISOString(),
          availableRamBytes:"1073741824",measuredPeakRamBytes:"16777216",ramMarginBytes:"16777216",availableDiskBytes:"5368709120",measuredPeakDiskBytes:"16777216",
          measuredPeakWalBytes:"67108864",measuredPeakTempBytes:"16777216",diskMarginBytes:"16777216"}});
      fixtureAdmin(ctx,grants.phases.find(phase=>phase.id==="post-schema-grants")!.statements.join("\n")+"\n"+
        createPostgresServiceSchemaGrantPlan({protocolVersion:2,schema:ctx.schema,migratorRole:ctx.role,serviceRoles:roles}).statements.join("\n")+
        `\nREVOKE CREATE,TEMPORARY ON DATABASE ${q(ctx.database)} FROM ${q(ctx.role)};GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${q(ctx.role)};`);
      const target:CutoverPostgresTarget={database:ctx.database,schema:ctx.schema,schemaSha256:plan.fingerprint,releaseSha256:pkg.releaseSha,generation,serverAddress:"127.0.0.1",serverPort:5434,systemIdentifier:ctx.systemIdentifier};
      const signed=signedFixture({target,tables,nonce:ctx.nonce,sourcePath:root+"/absent-source.sqlite",capacity:ctx.guard()});
      expect(signed.evaluation()).toMatchObject({preparationReady:true,writeAuthorized:false,activationEnabled:false});
      const closureTrust=signed.policy.closureTrust;
      if(signed.policy.version!==2||!closureTrust)throw new Error("G11 root startup requires explicit complete V2 policy trust");
      native=makeNative("business_import");
      const store=createMigrationRuntimeCutoverTransitionStore({runtime:native,target,statementTimeoutMs:3000,lockTimeoutMs:500,clock:()=>new Date().toISOString()});
      const coordinator=createMigrationCutoverCoordinator({expected:signed.policy,store,clock:()=>new Date().toISOString()});
      expect((await coordinator.execute(signed.command("prepare",0),signed.bundle)).revision).toBe(1);
      expect((await coordinator.execute(signed.command("select-postgres",1),signed.bundle)).revision).toBe(2);
      let markerReceipt="";
      const first=await coordinator.execute(signed.command("first-postgres-write",2),signed.bundle,{write:async(tx,writeId)=>{
        const inserted=await tx.query(`INSERT INTO ${q(ctx.schema)}.forward_strategy_generations(generation_id,activated_at) VALUES($1,$2) RETURNING generation_id,activated_at::text`,[generation,activatedAt]);
        await tx.query(`INSERT INTO ${q(ctx.schema)}.wallet_service_price_leases(generation_id) VALUES($1)`,[generation]);
        markerReceipt=migrationCutoverDigest({writeId,rows:inserted.rows});
        return {writeId,receiptSha256:markerReceipt,providerGuardSha256:migrationCutoverDigest(signed.policy.guards.filter(g=>g.kind==="provider")),
          deliveryGuardSha256:migrationCutoverDigest(signed.policy.guards.filter(g=>g.kind==="delivery"))};
      }});
      expect(first.revision).toBe(3);expect(first.phase).toBe("postgres-written");
      const markerSourceKey=migrationCutoverDigest({hostId:signed.policy.hostId,canonicalPath:signed.policy.binding.source.canonicalPath});
      const durable=await native.run(async tx=>{
        const ledger=await tx.query(`SELECT revision::text,state FROM ${q(ctx.schema)}.migration_cutover_transitions_v2 WHERE source_key=$1`,[markerSourceKey]);
        const markers=await tx.query(`SELECT marker_sha256,marker FROM ${q(ctx.schema)}.migration_cutover_first_write_markers WHERE source_key=$1`,[markerSourceKey]);
        expect(ledger.rows).toHaveLength(1);expect(markers.rows).toHaveLength(1);
        const state=ledger.rows[0]!.state as DurableCutoverState;
        expect(state.version).toBe(2);expect(state.policySha256).toBe(migrationCutoverDigest(signed.policy,2));expect(state.planSha256).toBe(migrationCutoverPlanDigest(signed.policy,signed.bundle));
        const marker=verifyFixtureNativeMarker(markers.rows[0],state,markerSourceKey);
        expect(marker.generation).toBe(generation);expect(marker.cohortId).toBe(signed.policy.binding.cohortId);expect(marker.receiptSha256).toBe(markerReceipt);
        const business=await tx.query(`SELECT generation_id FROM ${q(ctx.schema)}.forward_strategy_generations WHERE generation_id=$1`,[generation]);
        const lease=await tx.query(`SELECT generation_id FROM ${q(ctx.schema)}.wallet_service_price_leases WHERE generation_id=$1`,[generation]);
        expect(business.rows).toHaveLength(1);expect(lease.rows).toHaveLength(1);
        for(const entry of state.journal){expect(entry.command.version).toBe(2);expect(entry.requestSha256).toBe(migrationCutoverDigest(entry.command,2));}
        evidence.nativeMarkerSourceKey=markerSourceKey;return ledger;
      });
      expect(durable.rows[0]!.revision).toBe("3");expect((durable.rows[0]!.state as DurableCutoverState).journal).toHaveLength(3);evidence.markerPhysicalCommitted=true;process.stdout.write("G11 V2 native ledger/marker/business heads physically reconciled after coordinator commit\n");
      await native.close();native=undefined;
      const consolePort=18000+Number.parseInt(ctx.nonce.slice(0,4),16)%10000;
      const services=Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>[service,{username:roles[service],maximumConnections:1,intervalMs:60000}])) as PostgresServiceDeployment["services"];
      const config:PostgresServiceDeployment={format:1,operationId:"synthetic-root-"+ctx.nonce,generationId:generation,activatedAt,database:ctx.database,schema:ctx.schema,
        releaseRoot:root+"/release",cohortId:signed.policy.binding.cohortId,cutover:{expected:{...signed.policy,version:2,closureTrust}},lifecycle:{startupMs:30000,pollMs:15000,shutdownMs:5000,killMs:5000},
        execution:{maximumEntries:pkg.entries+32,maximumBytes:pkg.bytes+16384},gatewayDeliveryEnabled:false,fomoEnabled:false,fullHistoricalMiningEnabled:false,
        driver:{schemaVersion:plan.version,schemaFingerprint:plan.fingerprint,ssl:false,serviceConnectionBudgets:Object.fromEntries(POSTGRES_BUSINESS_SERVICES.map(service=>[service,1])),
          serverMaximumConnections:8,reservedConnections:2,maximumPendingOperations:0,connectionTimeoutMs:2000,idleTimeoutMs:500,statementTimeoutMs:3000,lockTimeoutMs:500,
          idleTransactionTimeoutMs:10000,shutdownTimeoutMs:2000,workMemKb:1024},services,
        composition:{principal:{actorId:"synthetic-root-observer",authorizationEvidenceRef:"synthetic-only/"+ctx.nonce,permissions:["target_registry_write","radar_authorization_write"]},quotas:{normalization:1,token:1,purchase:1,fanout:1,opportunity:1,capability:1,signal:1},
          maximumClaims:7,maximumRunMs:10000,admissionLimit:1,leaseMs:10000,retryDelayMs:1000,maximumPayloadBytes:16384,maximumSamples:1,factLimit:1,reconcileIntervalMs:60000},
        wallet:{maximumProfiles:1,maximumEvents:1,collectorQuota:1,leaseMs:10000,maximumPayloadBytes:16384,maximumRunMs:10000},
        sources:{leaseMs:10000,maximumProfileAgeMs:60000,maximumFactAgeMs:60000,maximumSafetyAgeMs:60000,providerTimeoutMs:2000,maximumResponseBytes:1024,maximumFactPayloadBytes:1024},
        console:{host:"127.0.0.1",port:consolePort,maximumTraceRows:1}};
      const configBody=JSON.stringify(config),deploymentPath=root+"/private/deployment.json";
      const privateFiles=[{name:"deployment.json",body:configBody}];
      for(const service of POSTGRES_BUSINESS_SERVICES) {
        const url=new URL("postgresql://127.0.0.1:5434/"+ctx.database);url.username=roles[service];url.password=passwords[service];
        const env={ADDRESS_RADAR_DATABASE_BACKEND:"postgresql",ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED:"false",ADDRESS_RADAR_FOMO_BROWSER_ENABLED:"false",
          ADDRESS_RADAR_FOMO_CAPTURE_ENABLED:"false",ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED:"false",ADDRESS_RADAR_POSTGRES_URL:url.toString(),
          ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE:deploymentPath,ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256:sha(configBody),ADDRESS_RADAR_POSTGRES_ENTRY_SHA256:pkg.entrySha,
          ADDRESS_RADAR_POSTGRES_RELEASE_SHA256:pkg.releaseSha,ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE:randomBytes(16).toString("hex"),
          ADDRESS_RADAR_POSTGRES_STARTUP_MS:"30000",ADDRESS_RADAR_POSTGRES_POLL_MS:"15000",ADDRESS_RADAR_POSTGRES_SHUTDOWN_MS:"5000",ADDRESS_RADAR_POSTGRES_KILL_MS:"5000",
          ADDRESS_RADAR_DATABASE_PATH:root+"/private/forbidden-sqlite.sqlite",RADAR_RPC_SOLANA_HTTP_URL:"http://127.0.0.1:9/absent-provider",TSX_DISABLE_CACHE:"1",NODE_DISABLE_COMPILE_CACHE:"1"};
        privateFiles.push({name:service+".json",body:JSON.stringify({scope:dispatcher?"isolated-six-root-dispatcher":"isolated-six-root-factory",nonce:ctx.nonce,database:ctx.database,schema:ctx.schema,
          username:roles[service],generation,env,console:config.console,markerWriteId:"synthetic-marker-"+ctx.nonce,markerReceipt,markerSourceKey,policySha256:migrationCutoverDigest(signed.policy,2),planSha256:migrationCutoverPlanDigest(signed.policy,signed.bundle),protocolVersion:2})});
      }
      sshRun("sudo -n python3 -c "+literal(privatePython),JSON.stringify({root,nonce:ctx.nonce,marker,files:privateFiles}));
      for(const service of POSTGRES_BUSINESS_SERVICES) {
        ctx.guard();
        const prefix="sudo -n -u address-radar env -i HOME="+literal(root+"/private")+" PATH="+literal(root+"/bin")+" /usr/bin/nice -n 19 ";
        const command=dispatcher?prefix+"/usr/bin/timeout 65s /usr/bin/python3 "+literal(root+"/release/dispatch-watch.py")+" "+literal(root+"/private/"+service+".json")+" "+literal(service)
          :prefix+"/usr/bin/timeout 45s "+literal(root+"/bin/node")+" --max-old-space-size=128 --no-global-search-paths "+literal(root+"/release/smoke.mjs")+" "+literal(root+"/private/"+service+".json")+" "+literal(service);
        const output=sshRun(command,"",dispatcher?70000:50000),receipt=JSON.parse(output) as Record<string,unknown>;
        expect(receipt.status).toBe("passed");expect(receipt.service).toBe(service);expect(receipt.polls).toBe(1);expect(receipt.markerReceipt).toBe(markerReceipt);expect(receipt.protocolVersion).toBe(2);
        if(!dispatcher)expect(Number(receipt.nativeMarkerReads)).toBeGreaterThan(0);
        expect(receipt.backend).toBe("postgresql");expect(receipt.externalFetchCalls).toBe(0);expect(receipt.closed).toBe(true);evidence.services.push(receipt);process.stdout.write("G11 service drained "+service+"; polls=1; externalFetch=0\n");
      }
    } catch(error) {
      const failure=postgresFixtureFailureDiagnostic(error);
      if(failure)process.stderr.write("G11 PostgreSQL fixture failure "+JSON.stringify(failure)+"\n");
      throw error;
    } finally {
      try {if(native)await native.close();}
      finally {expect(sshRun("sudo -n python3 -c "+literal(cleanupPython),JSON.stringify({root,nonce:ctx.nonce,marker}))).toMatch(/own-sealed-fixture-(cleaned|absent)/);evidence.sealedCleanup=true;process.stdout.write("G11 own sealed fixture cleanup confirmed\n");}
    }
  });
  evidence.clusterCleanup=true;evidence.dispatcherCliVerified=dispatcher;return evidence;
}
describe("isolated sealed six-root exported-factory rehearsal",()=>{
  it("reports only bounded SQLSTATE and approved static PostgreSQL details, never failed row contents",()=>{
    expect(postgresFixtureFailureDiagnostic({code:"22P02",detail:'Token "preparation" is invalid.'})).toEqual({sqlState:"22P02",detail:'Token "preparation" is invalid.',detailRedacted:false,detailBytes:31});
    for(const detail of ['Failing row contains (private-state, private-key).','Token "privateCredential" is invalid.',"x".repeat(8192)]){
      const result=postgresFixtureFailureDiagnostic({code:"23514",detail});
      expect(result).toEqual({sqlState:"23514",detail:"[redacted]",detailRedacted:true,detailBytes:Buffer.byteLength(detail)});
      expect(JSON.stringify(result)).not.toContain("private");
    }
    expect(postgresFixtureFailureDiagnostic({code:"22P02"})).toEqual({sqlState:"22P02",detail:"[absent]",detailRedacted:false,detailBytes:0});
  });
  it("does not invoke error accessors or interpret non-SQLSTATE transport errors as PostgreSQL diagnostics",()=>{
    const accessor=vi.fn(()=>{throw new Error("Private getter must not be called");});
    const error=Object.defineProperties({}, {code:{value:"22P02",enumerable:true},detail:{get:accessor,enumerable:true}});
    expect(postgresFixtureFailureDiagnostic(error)?.detail).toBe("[absent]");expect(accessor).not.toHaveBeenCalled();
    for(const input of [null,[],"22P02",{code:"ETIMEDOUT"},{code:"22p02"},{code:22002}])expect(postgresFixtureFailureDiagnostic(input)).toBeUndefined();
  });

  it("retains spaced Python failure JSON independently of transport line formatting",()=>{
    const receipt={status:"failed",nonce:"0123456789abcdef",stage:"bounded-default-dispatcher-cli-watch",childExitCode:1};
    expect(parseFixtureFailure("fixture progress\n"+JSON.stringify(receipt,null,0).replaceAll(":",": ").replaceAll(",",", ")+"\r\n")).toEqual(receipt);
    expect(parseFixtureFailure(JSON.stringify({status:"passed"})+"\n"+JSON.stringify(receipt))).toEqual(receipt);
  });
  it("does not interpret malformed, oversized, primitive or successful diagnostics as a failure receipt",()=>{
    for(const output of ["{bad json}","null","[]","true",'{"status":"passed"}',JSON.stringify({status:"failed",message:"x".repeat(40000)})])
      expect(parseFixtureFailure(output)).toBeUndefined();
  });
  it("validates nonce-bound synthetic signatures without granting production authority",()=>{
    const nonce="0123456789abcdef",database="radar_rehearsal_"+nonce;
    const input={nonce,capacity:"1371264:29785416",sourcePath:"/opt/address-radar-rehearsal/"+nonce+"/absent-source.sqlite",
      tables:["business_schema_identity","business_schema_ledger","migration_cutover_transitions","migration_cutover_transitions_v2","migration_cutover_first_write_markers","forward_strategy_generations"],
      target:{database,schema:database+"_schema",schemaSha256:hash("e"),releaseSha256:hash("f"),generation:"synthetic-root-"+nonce,serverAddress:"127.0.0.1",serverPort:5434,systemIdentifier:"7333333333333333333"}};
    const initial=signedFixture(input);expect(initial.policy.version).toBe(2);expect(initial.bundle.version).toBe(2);
    expect(initial.bundle.closure).toBeDefined();expect(initial.evaluation()).toMatchObject({preparationReady:true,writeAuthorized:false,activationEnabled:false});
    expect(initial.policy.writers.filter(writer=>writer.kind==="services")).toHaveLength(12);expect(initial.policy.writers.filter(writer=>writer.kind==="timers")).toHaveLength(5);
    expect(initial.bundle.closure!.authorization.payload.scopes.map(scope=>scope.kind)).toContain("bridge");
    expect(initial.bundle.closure!.authorization.payload.scopes.map(scope=>scope.kind)).toContain("external-input");
    expect(initial.bundle.closure!.snapshot.payload.tables[0]!.rowCount).toBe("9007199254740993");
    expect(()=>signedFixture({...input,target:{...input.target,database:"business"}})).toThrow("private same-nonce");
    const fixture=signedFixture(input),anchor=Date.now();let ticks=0;
    const clock=vi.spyOn(Date,"now").mockImplementation(()=>anchor+ticks++);
    try {
      const command=fixture.command("prepare",0);
      expect(command.version).toBe(2);expect(command.planSha256).toBe(migrationCutoverPlanDigest(fixture.policy,fixture.bundle));
      expect(command.authorization.expiresAt).toBe(command.deadline);
      expect(Date.parse(command.deadline)-Date.parse(command.authorization.issuedAt)).toBe(10000);
      expect(clock).toHaveBeenCalledTimes(1);
    }finally{clock.mockRestore();}
  });
  const offlineFixture=()=>{const nonce="0123456789abcdef",database="radar_rehearsal_"+nonce;
    return signedFixture({nonce,capacity:"1371264:29785416",sourcePath:"/opt/address-radar-rehearsal/"+nonce+"/absent-source.sqlite",
      tables:["business_schema_identity","business_schema_ledger","migration_cutover_transitions","migration_cutover_transitions_v2","migration_cutover_first_write_markers","forward_strategy_generations"],
      target:{database,schema:database+"_schema",schemaSha256:hash("e"),releaseSha256:hash("f"),generation:"synthetic-root-"+nonce,serverAddress:"127.0.0.1",serverPort:5434,systemIdentifier:"7333333333333333333"}});};
  it("binds complete V2 synthetic closure and rejects absent, substituted or unsigned evidence offline",()=>{
    for(const mutate of [
      (f:ReturnType<typeof offlineFixture>)=>{delete f.bundle.closure;},
      (f:ReturnType<typeof offlineFixture>)=>{f.bundle.closure!.authorization.signatureBase64="";},
      (f:ReturnType<typeof offlineFixture>)=>{f.bundle.closure!.snapshot.payload.binding.cluster="7333333333333333334";},
      (f:ReturnType<typeof offlineFixture>)=>{f.bundle.closure!.snapshot.payload.tables[0]!.rowCount="9007199254740992";},
      (f:ReturnType<typeof offlineFixture>)=>{f.bundle.closure!.census.payload.scopes.pop();},
    ]){const fixture=offlineFixture();mutate(fixture);expect(fixture.evaluation().preparationReady).toBe(false);}
  });
  it("does not grant new V1 selection authority or call a first-write callback offline",async()=>{
    const fixture=offlineFixture();fixture.policy.version=1;fixture.bundle.version=1;
    for(const observation of Object.values(fixture.bundle.observations))observation.version=1;
    const proof=fixture.bundle.observations.rehearsal.body.compatibleRelease as CompatiblePostgresReleaseProof;
    proof.version=1;fixture.signCompatibility(proof);fixture.resignAll();delete fixture.policy.closureTrust;delete fixture.bundle.closure;
    expect(fixture.evaluation().preparationReady).toBe(false);
    const command=fixture.command("select-postgres",1);delete command.version;fixture.authorize(command);
    const run=vi.fn(async()=>{throw new Error("Offline native transaction is forbidden");}),write=vi.fn();
    const coordinator=createMigrationCutoverCoordinator({expected:fixture.policy,store:{run},clock:()=>new Date().toISOString()});
    await expect(coordinator.execute(command,fixture.bundle,{write})).rejects.toThrow("V1_AUDIT_ONLY_NO_CUTOVER_ADVANCE");
    expect(run).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
  });
  it("rejects source-only closure at the post-write proof boundary using the actual verifier offline",()=>{
    const fixture=offlineFixture();delete fixture.bundle.observations.rehearsal.body.compatibleRelease;fixture.resignAll();
    const closure=fixture.bundle.closure,trust=fixture.policy.closureTrust;
    if(!closure||!trust)throw new Error("Explicit synthetic closure trust required");
    expect(closure.rollback.payload.route).toBe("source-before-first-write");
    expect(()=>verifyWriterFenceSnapshotRollbackClosure({...closure,phase:"before-first-pg-write"},trust,new Date())).not.toThrow();
    expect(()=>verifyWriterFenceSnapshotRollbackClosure({...closure,phase:"after-first-pg-write"},trust,new Date())).toThrow();
  });
  it("verifies V2 native marker bytes and every state/source/cohort/plan binding without a PG connection",()=>{
    const fixture=offlineFixture(),recordedAt=new Date().toISOString();
    const sourceKey=migrationCutoverDigest({hostId:fixture.policy.hostId,canonicalPath:fixture.policy.binding.source.canonicalPath});
    const state:DurableCutoverState={version:2,revision:3,phase:"postgres-written",binding:clone(fixture.policy.binding),policySha256:migrationCutoverDigest(fixture.policy,2),planSha256:migrationCutoverPlanDigest(fixture.policy,fixture.bundle),activationEnabled:false,preparation:clone(fixture.bundle),snapshotTables:[],journal:[],
      firstPostgresWrite:{writeId:"synthetic-marker-0123456789abcdef",receiptSha256:hash("7"),providerGuardSha256:migrationCutoverDigest(fixture.policy.guards.filter(g=>g.kind==="provider")),deliveryGuardSha256:migrationCutoverDigest(fixture.policy.guards.filter(g=>g.kind==="delivery")),recordedAt}};
    const marker:FirstPostgresWriteMarkerV2={version:2,sourceKey,policySha256:state.policySha256,planSha256:state.planSha256,bindingSha256:migrationCutoverDigest(state.binding,2),cohortId:state.binding.cohortId,generation:state.binding.generation,...state.firstPostgresWrite!};
    const row={marker_sha256:migrationCutoverDigest(marker,2),marker};expect(verifyFixtureNativeMarker(row,state,sourceKey)).toEqual(marker);
    expect(()=>verifyFixtureNativeMarker(undefined,state,sourceKey)).toThrow("marker mismatch");
    expect(()=>verifyFixtureNativeMarker({...row,marker_sha256:hash("0")},state,sourceKey)).toThrow("marker mismatch");
    for(const field of ["sourceKey","policySha256","planSha256","bindingSha256","cohortId","generation","writeId","receiptSha256","providerGuardSha256","deliveryGuardSha256","recordedAt"] as const){
      const changed={...marker,[field]:"substituted"};
      expect(()=>verifyFixtureNativeMarker({marker_sha256:migrationCutoverDigest(changed,2),marker:changed},state,sourceKey)).toThrow("marker mismatch");
    }
    expect(()=>verifyFixtureNativeMarker(row,{...state,version:1},sourceKey)).toThrow("V2 committed");
    expect(()=>verifyFixtureNativeMarker(row,{...state,firstPostgresWrite:null},sourceKey)).toThrow("V2 committed");
    const extra={...marker,unreviewed:true};expect(()=>verifyFixtureNativeMarker({marker_sha256:migrationCutoverDigest(extra,2),marker:extra},state,sourceKey)).toThrow("marker mismatch");
    expect(sourceKey).not.toBe(migrationCutoverDigest({hostId:fixture.policy.hostId,canonicalPath:fixture.policy.binding.source.canonicalPath},2));
  });
  it("refuses physical schema2 before fixture creation rather than falling back to V1 or temporary DDL",()=>{
    const schema=createPostgresServiceSchema({protocolVersion:2});expect(createPostgresServiceSchema().plan.version).toBe(2);
    expect(()=>requireG11V2Schema({...schema,plan:{...schema.plan,version:2}})).toThrow("reviewed physical schema3");
    expect(()=>requireG11V2Schema({...schema,supportTables:[]})).toThrow("reviewed physical schema3");
  });
  it("checks reviewed schema3 factory readiness offline, not a real PG receipt",()=>{
    expect(requireG11V2Schema(createPostgresServiceSchema({protocolVersion:2})).supportTables).toHaveLength(19);
  });

  it("parses the sealed runner and guarded installation/cleanup programs offline",()=>{
    for(const source of [smokeSource,dispatcherSource]){const js=spawnSync(process.execPath,["--check","--input-type=module"],{input:source,encoding:"utf8",timeout:2000});expect(js.status).toBe(0);}
    const resourceExpression=smokeSource.split("const match=")[1]!.split(".exec(")[0]!;
    expect((Function("return "+resourceExpression)() as RegExp).exec("MemAvailable:    1287788 kB")?.[1]).toBe("1287788");
    for(const script of [installPython,privatePython,cleanupPython,dispatcherWatchPython]) {
      const python=spawnSync("python3",["-c","import ast,sys; ast.parse(sys.stdin.read())"],{input:script,encoding:"utf8",timeout:2000});
      expect(python.status).toBe(0);
    }
  });
  it("builds a bounded self-contained root export closure using installed tools only",async()=>{
    const pkg=await packageFixture();
    try {expect(pkg.files.some(file=>file.path==="scripts/postgres-service-entry.ts")).toBe(true);
      expect(pkg.files.some(file=>file.path==="node_modules/tsx/dist/cli.mjs")).toBe(true);expect(pkg.bytes).toBeLessThan(8388608);expect(pkg.releaseSha).toMatch(/^[a-f0-9]{64}$/);
    } finally {pkg.cleanup();}
  },30000);

  it("executes the genuine local tsx CLI root main and refuses missing startup authority offline",async()=>{
    const pkg=await packageFixture({dispatcher:true,platform:"local"});
    try{
      const environment={PATH:process.env.PATH??"",HOME:dirname(pkg.release),TSX_DISABLE_CACHE:"1",NODE_DISABLE_COMPILE_CACHE:"1"};
      const args=["--no-global-search-paths",join(pkg.release,"node_modules/tsx/dist/cli.mjs"),"--tsconfig",join(pkg.release,"tsconfig.json"),join(pkg.release,"scripts/postgres-service-entry.ts")];
      const invalid=spawnSync(process.execPath,[...args,"__invalid_fixture_service__"],{env:environment,encoding:"utf8",timeout:15000,maxBuffer:65536});
      expect(invalid.error).toBeUndefined();expect(invalid.status).toBe(1);expect(invalid.stderr).toContain("Explicit PostgreSQL business service required");
      const privateUrl="postgresql://scanner:REHEARSAL_PRIVATE_PASSWORD@127.0.0.1:5432/private_rehearsal";
      const unapproved=spawnSync(process.execPath,[...args,"scanner"],{env:{...environment,ADDRESS_RADAR_POSTGRES_URL:privateUrl},encoding:"utf8",timeout:15000,maxBuffer:65536});
      expect(unapproved.error).toBeUndefined();expect(unapproved.status).toBe(1);
      const failures=unapproved.stderr.split(/\r?\n/).filter(line=>line.startsWith("{")).map(line=>JSON.parse(line));
      expect(failures).toEqual([{event:"postgres_service_failure",service:"scanner",phase:"cli-exit",reasonCode:"unclassified_failure"}]);
      expect(unapproved.stderr).not.toContain(privateUrl);
      expect(unapproved.stderr).not.toContain("REHEARSAL_PRIVATE_PASSWORD");
      expect(unapproved.stderr).not.toContain("private_rehearsal");
      expect(unapproved.stderr).not.toContain("PostgreSQL startup refused");
    }finally{pkg.cleanup();}
  },45000);
  it("rejects a substituted platform binary pin before creating any PG fixture",()=>{
    expect(()=>cliBinary("linux-x64","/private/tmp/not-an-approved-esbuild",hash("0"))).toThrow("installed published binary pin");
  });
  it.skipIf(!process.env.ADDRESS_RADAR_REHEARSAL_ESBUILD_LINUX_FILE)("builds the pinned Linux dispatcher closure without executing the target binary or opening PG",async()=>{
    const pkg=await packageFixture({dispatcher:true,platform:"linux-x64"});
    try{
      const binary=pkg.files.find(file=>file.path==="node_modules/@esbuild/linux-x64/bin/esbuild");
      expect(binary?.mode).toBe(0o555);
      expect(sha(Buffer.from(binary!.body,"base64"))).toBe("e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100");
      for(const path of ["dispatch-api.mjs","dispatch.mjs","dispatch-watch.py","node_modules/tsx/package.json","node_modules/esbuild/lib/main.js"])
        expect(pkg.files.some(file=>file.path===path)).toBe(true);
      expect(pkg.bytes).toBeLessThan(33554432);expect(pkg.entries).toBeLessThan(256);
      process.stdout.write("G11 offline Linux closure "+JSON.stringify({bytes:pkg.bytes,entries:pkg.entries,binarySha256:sha(Buffer.from(binary!.body,"base64")),releaseSha256:pkg.releaseSha,noPg:true})+"\n");
    }finally{pkg.cleanup();}
  },30000);

  it.skipIf(!enabled&&!cliEnabled)("runs six real restricted root services against only a guarded same-nonce PG16 cluster",async()=>{
    if(cliEnabled&&process.env.ADDRESS_RADAR_REHEARSAL_MENDEL_SLOT_RELEASED!=="1")throw new Error("Explicit Mendel lifecycle cleanup and slot release required before native CLI rehearsal");
    const pkg=await packageFixture(cliEnabled?{dispatcher:true,platform:"linux-x64"}:{});
    try {const receipt=await runActualRehearsal(pkg,cliEnabled);expect(receipt.services).toHaveLength(6);
      expect(receipt.clusterCleanup).toBe(true);expect(receipt.sealedCleanup).toBe(true);
      process.stdout.write((cliEnabled?"G11 isolated dispatcher-CLI-IPC receipt ":"G11 isolated exported-root-factory receipt ")+JSON.stringify(receipt)+"\n");
    } finally {pkg.cleanup();}
  },600000);
});
