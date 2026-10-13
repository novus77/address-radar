import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importFullDataPreservationBundle, withFullDataPreservationSourceReader } from "../../packages/database/src/postgres-full-data-import.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = String.raw`
import os,sys,json,base64,hashlib
root=sys.argv[1];rows=32
def body(x):return json.dumps(x,sort_keys=True,separators=(',',':')).encode()
def sha(x):return hashlib.sha256(x).hexdigest()
sql='CREATE TABLE payload(id INTEGER PRIMARY KEY, payload BLOB, extra TEXT)'
catalog={'objects':[{'type':'table','name':'payload','tbl_name':'payload','sql':sql}],
 'tables':[{'name':'payload','columns':[[0,'id','INTEGER',0,None,1,0],[1,'payload','BLOB',0,None,0,0],[2,'extra','TEXT',0,None,0,0]],'foreignKeys':[],'indexes':[]}],
 'sequences':[],'pragmas':{'encoding':'UTF-8','user_version':0,'application_id':0}}
snapshot='d'*64;operation='synthetic-memory-test-no-eligibility'
payload=base64.b64encode(bytes(range(256))*256).decode()
plans=[];content=hashlib.sha256();digests={}
for label in ['small','large']:os.mkdir(root+'/'+label,0o700)
for ordinal in range(96):
 values=[{'values':[{'storage':'integer','value':str(ordinal*rows+i)}, {'storage':'blob','value':payload,'encoding':'base64'},{'storage':'null'}]} for i in range(rows)]
 for row in values:content.update(body(row)+b'\n')
 chunk=body({'version':1,'operationId':operation,'snapshotSha256':snapshot,'table':'payload','ordinal':ordinal,'startRow':ordinal*rows,'rows':values})
 name='table-0000-chunk-%06d.json'%ordinal
 fd=os.open(root+'/large/'+name,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(chunk)
 if ordinal<32:os.link(root+'/large/'+name,root+'/small/'+name)
 plans.append({'file':name,'table':'payload','ordinal':ordinal,'startRow':ordinal*rows,'rowCount':rows,'sha256':sha(chunk)})
 if ordinal+1 in (32,96):digests[ordinal+1]=content.hexdigest()
for label,count in [('small',32),('large',96)]:
 manifest={'version':1,'operationId':operation,'snapshotBytes':4096,'snapshotSha256':snapshot,'catalogFingerprint':sha(body(catalog)),
  'completed':True,'businessActivation':False,'catalog':catalog,'limits':{'maximumChunkBytes':16*1024**2,'rowsPerChunk':rows},
  'tables':[{'name':'payload','completed':True,'rowCount':count*rows,'contentSha256':digests[count],'chunks':plans[:count]}]}
 fd=os.open(root+'/'+label+'/manifest.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(body(manifest))
`;
const childSource = String.raw`
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const [root,directory]=process.argv.slice(1);
// Import the real heavy modules, but do not instantiate a pool or run any runtime.
const runtimeUrl=pathToFileURL(join(root,'scripts/rehearse-postgres-full-preservation.ts')).href;
const runtime=await import(runtimeUrl),sameRuntime=runtime===await import(runtimeUrl);
const require=createRequire(join(root,'packages/database/package.json'));
const driver=require('pg'),sameDriver=driver===require('pg');
const importer=await import(pathToFileURL(join(root,'packages/database/src/postgres-full-data-import.ts')).href);
await new Promise(resolve=>setImmediate(resolve));global.gc();
const baseline=process.memoryUsage();
let activeReads=0,maximumActiveReads=0,readBytes=0,maximumChunkBytes=0,readChunks=0;
const refs=[];const peak={rss:baseline.rss,heapUsed:baseline.heapUsed,external:baseline.external,arrayBuffers:baseline.arrayBuffers};
const sample=()=>{const m=process.memoryUsage();for(const key of Object.keys(peak))peak[key]=Math.max(peak[key],m[key]);};
const reader={async read(directory,file,maximum){
 activeReads++;maximumActiveReads=Math.max(maximumActiveReads,activeReads);
 try{
  const bytes=await readFile(join(directory,file));if(bytes.length>maximum)throw new Error('toy_reader_limit');
  readBytes+=bytes.length;
  if(file!=='manifest.json'){readChunks++;maximumChunkBytes=Math.max(maximumChunkBytes,bytes.length);refs.push(new WeakRef(bytes.buffer));}
  sample();return bytes;
 }finally{activeReads--;}
}};
const bundle=await importer.withFullDataPreservationSourceReader(reader,()=>importer.readOpaqueFullDataPreservationBundle(directory,{},sample));
sample();await new Promise(resolve=>setImmediate(resolve));global.gc();
await new Promise(resolve=>setImmediate(resolve));global.gc();
const postGc=process.memoryUsage(),liveChunkBuffers=refs.filter(ref=>ref.deref()!==undefined).length;
process.stdout.write(JSON.stringify({platform:process.platform,node:process.version,sameRuntime,sameDriver,baseline,peak,postGc,liveChunkBuffers,
 maximumActiveReads,readBytes,maximumChunkBytes,readChunks,totalRows:bundle.totalRows,totalChunks:bundle.totalChunks,
 noForcedGcDuringVerification:true,pgConnections:0,realSourceReads:0})+'\n');
`;

interface ChildMemory {
  baseline: NodeJS.MemoryUsage; peak: NodeJS.MemoryUsage; postGc: NodeJS.MemoryUsage;
  platform: string; node: string; sameRuntime: boolean; sameDriver: boolean;
  liveChunkBuffers: number; maximumActiveReads: number; readBytes: number;
  maximumChunkBytes: number; readChunks: number; totalRows: number; totalChunks: number;
  noForcedGcDuringVerification: boolean; pgConnections: number; realSourceReads: number;
}
async function childMemory<T = ChildMemory>(directory: string, source = childSource, timeoutMs = 12000): Promise<T> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=96", "--expose-gc", "--import", "tsx", "--input-type=module", "--eval", source, root, directory], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", stopped: string | undefined;
    child.stdout.on("data", (value: Buffer) => { stdout += value.toString(); if (stdout.length > 16384) { stopped = "local_child_output_limit"; child.kill("SIGTERM"); } });
    child.stderr.on("data", (value: Buffer) => { stderr = (stderr + value.toString()).slice(-8192); });
    const timeout = setTimeout(() => { stopped = "local_child_deadline"; child.kill("SIGTERM"); }, timeoutMs);
    const monitor = setInterval(() => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        const rss = Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8", timeout: 1000 }).trim()) * 1024;
        if (rss > 256 * 1024 ** 2) { stopped = "local_child_rss_limit"; child.kill("SIGTERM"); }
      } catch { /* Exit may race the read-only process probe. */ }
    }, 200);
    child.once("error", error => { clearTimeout(timeout); clearInterval(monitor); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout); clearInterval(monitor);
      if (stopped || code !== 0) reject(new Error(`${stopped ?? "local_child_failed"}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout) as T); } catch (error) { reject(error); } }
    });
  });
}

describe("offline opaque preservation live-buffer bound, synthetic data only", () => {
  it("does not retain total chunk bytes and serializes reads with heavy imports cached", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preservation-memory-fixture-"));
    try {
      execFileSync("python3", ["-c", fixture, directory], { timeout: 8000, maxBuffer: 8192 });
      const small = await childMemory(join(directory, "small"));
      const large = await childMemory(join(directory, "large"));
      for (const [result, chunks] of [[small, 32], [large, 96]] as const) {
        expect(result.totalChunks).toBe(chunks); expect(result.totalRows).toBe(chunks * 32);
        expect(result.readChunks).toBe(chunks); expect(result.maximumActiveReads).toBe(1);
        expect(result.sameRuntime && result.sameDriver).toBe(true);
        expect(result.pgConnections).toBe(0); expect(result.realSourceReads).toBe(0);
        expect(result.noForcedGcDuringVerification).toBe(true);
        expect(result.liveChunkBuffers).toBeLessThanOrEqual(1);
        expect(result.postGc.arrayBuffers - result.baseline.arrayBuffers).toBeLessThan(result.maximumChunkBytes * 2 + 4 * 1024 ** 2);
        expect(result.peak.rss).toBeLessThanOrEqual(256 * 1024 ** 2);
      }
      expect(large.readBytes).toBeGreaterThan(250 * 1024 ** 2);
      expect(large.postGc.arrayBuffers - small.postGc.arrayBuffers).toBeLessThan(large.maximumChunkBytes * 2 + 4 * 1024 ** 2);
      process.stdout.write(JSON.stringify({scope: "offline_synthetic_not_pg_or_linux_capacity_proof", small, large}) + "\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);
});


const repeatedLargeFixture = fixture.replace("rows=32", "rows=4096")
  .replace("bytes(range(256))*256", "bytes(range(256))*11")
  .replace("range(96)", "range(16)").replace("ordinal<32", "ordinal<4")
  .replace("(32,96)", "(4,16)").replace("[('small',32),('large',96)]", "[('small',4),('large',16)]");
const pressureFixture = fixture.replace("rows=32", "rows=1")
  .replace("bytes(range(256))*256", "bytes(range(256))")
  .replace("range(96)", "range(3)").replace("ordinal<32", "ordinal<2")
  .replace("(32,96)", "(2,3)").replace("[('small',32),('large',96)]", "[('small',2),('large',3)]");

// Two fresh validation passes in the same heavyweight process, followed by cancellation and tamper rejection.
// UOW boundaries throw before any SQL; this is not a PostgreSQL or Linux-host capacity proof.
const repeatedChildSource = childSource
  .replace("readBytes+=bytes.length;", "readBytes+=bytes.length;if(file!=='manifest.json'&&phase==='tamper')bytes[bytes.length-2]^=1;")
  .replace("const bundle=await importer.withFullDataPreservationSourceReader(reader,()=>importer.readOpaqueFullDataPreservationBundle(directory,{},sample));", String.raw`
let phase='validation',checkpointCalls=0,gcCalls=0,lastCollectionAt=0,uowBoundaryCalls=0,pressureStart=0;
const boundary=new Error('fixture_uow_boundary'),pressure=new Error('fixture_pressure_error');
const bundle=importer.verifyFullDataPreservationManifest(await readFile(join(directory,'manifest.json')));
const checkpoint=()=>{
 checkpointCalls++;sample();
 if(phase==='pressure'&&readChunks>pressureStart)throw pressure;
 if(Date.now()-lastCollectionAt>=250){global.gc();gcCalls++;lastCollectionAt=Date.now();}sample();
};
const validate=()=>importer.withFullDataPreservationSourceReader(reader,()=>importer.importFullDataPreservationBundle({
 bundleDirectory:directory,target:{schema:'fixture_preservation',database:'fixture_database',role:'fixture_role'},
 executionBudget:{deadlineAtMs:Date.now()+30000,maximumTransactionMs:1000,maximumQueriesPerTransaction:1000,
  maximumTotalQueries:1000,opaqueRowWindows:{maximumRows:64,maximumBytes:512*1024}},checkpoint,
 unitOfWork:{async run(){uowBoundaryCalls++;throw boundary;}}
})).then(()=>null,error=>error);
for(let pass=0;pass<2;pass++){if(await validate()!==boundary)throw new Error('fixture_validation_incomplete');sample();}
if(uowBoundaryCalls!==2||readChunks!==32)throw new Error('fixture_validation_accounting');
phase='pressure';pressureStart=readChunks;const beforePressureUow=uowBoundaryCalls;
const pressurePropagated=await validate()===pressure,pressureReadChunks=readChunks-pressureStart,
 pressureUowCalls=uowBoundaryCalls-beforePressureUow;
if(!pressurePropagated||pressureReadChunks!==1||pressureUowCalls!==0)throw new Error('fixture_checkpoint_not_propagated');
phase='tamper';const beforeTamperReads=readChunks,beforeTamperUow=uowBoundaryCalls;
const tamperError=await validate(),tamperReadChunks=readChunks-beforeTamperReads,tamperUowCalls=uowBoundaryCalls-beforeTamperUow,
 tamperRejected=tamperError?.message==='full_data_preservation_chunk_digest_mismatch';
if(!tamperRejected||tamperReadChunks!==1||tamperUowCalls!==0)throw new Error('fixture_fresh_hash_not_enforced');
`)
  .replace("noForcedGcDuringVerification:true,pgConnections:0", "passes:2,sameProcessRepeatedValidation:true,checkpointCalls,gcCalls,uowBoundaryCalls,pressurePropagated,pressureReadChunks,pressureUowCalls,tamperRejected,tamperReadChunks,tamperUowCalls,noForcedGcDuringVerification:false,pgConnections:0");

interface RepeatedChildMemory extends ChildMemory {
  passes: number; sameProcessRepeatedValidation: boolean; checkpointCalls: number; gcCalls: number; uowBoundaryCalls: number;
  pressurePropagated: boolean; pressureReadChunks: number; pressureUowCalls: number;
  tamperRejected: boolean; tamperReadChunks: number; tamperUowCalls: number;
}

describe("caller checkpoint during complete fresh source validation", () => {
  it("propagates validation pressure after one verified chunk before another read or any UOW", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preservation-pressure-fixture-"));
    try {
      execFileSync("python3", ["-c", pressureFixture, directory], { timeout: 8000, maxBuffer: 8192 });
      const pressure = new Error("fixture_pressure_error");
      let chunkReads = 0, uowCalls = 0, checkpointCalls = 0;
      await expect(withFullDataPreservationSourceReader({ async read(directory, file, maximum) {
        const bytes = await readFile(join(directory, file));
        if (bytes.length > maximum) throw new Error("fixture_reader_limit");
        if (file !== "manifest.json") chunkReads++;
        return bytes;
      } }, () => importFullDataPreservationBundle({
        bundleDirectory: join(directory, "large"), target: { schema: "fixture_preservation", database: "fixture_database", role: "fixture_role" },
        executionBudget: { deadlineAtMs: Date.now() + 10000, maximumTransactionMs: 1000,
          maximumQueriesPerTransaction: 1000, maximumTotalQueries: 1000,
          opaqueRowWindows: { maximumRows: 64, maximumBytes: 512 * 1024 } },
        checkpoint() { checkpointCalls++; if (chunkReads >= 1) throw pressure; },
        unitOfWork: { async run() { uowCalls++; throw new Error("fixture_uow_boundary"); } },
      }))).rejects.toBe(pressure);
      expect(chunkReads).toBe(1); expect(uowCalls).toBe(0); expect(checkpointCalls).toBeGreaterThan(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("continuously verifies large chunks twice in one process below the unchanged RSS bound", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preservation-repeat-memory-fixture-"));
    try {
      execFileSync("python3", ["-c", repeatedLargeFixture, directory], { timeout: 15000, maxBuffer: 8192 });
      const result = await childMemory<RepeatedChildMemory>(join(directory, "large"), repeatedChildSource, 30000);
      expect(result.passes).toBe(2); expect(result.sameProcessRepeatedValidation).toBe(true);
      expect(result.totalChunks).toBe(16); expect(result.totalRows).toBe(16 * 4096);
      expect(result.readChunks).toBe(34); expect(result.maximumChunkBytes).toBeGreaterThan(15 * 1024 ** 2);
      expect(result.readBytes).toBeGreaterThan(500 * 1024 ** 2); expect(result.maximumActiveReads).toBe(1);
      expect(result.sameRuntime && result.sameDriver).toBe(true); expect(result.uowBoundaryCalls).toBe(2);
      expect(result.checkpointCalls).toBeGreaterThanOrEqual(64); expect(result.gcCalls).toBeGreaterThan(0);
      expect(result.pressurePropagated).toBe(true); expect(result.pressureReadChunks).toBe(1); expect(result.pressureUowCalls).toBe(0);
      expect(result.tamperRejected).toBe(true); expect(result.tamperReadChunks).toBe(1); expect(result.tamperUowCalls).toBe(0);
      expect(result.pgConnections).toBe(0); expect(result.realSourceReads).toBe(0);
      expect(result.liveChunkBuffers).toBeLessThanOrEqual(1);
      expect(result.postGc.arrayBuffers - result.baseline.arrayBuffers).toBeLessThan(result.maximumChunkBytes * 2 + 4 * 1024 ** 2);
      expect(result.peak.rss).toBeLessThanOrEqual(256 * 1024 ** 2);
      process.stdout.write(JSON.stringify({ scope: "same_process_offline_synthetic_not_linux_capacity_proof", result }) + "\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 45000);
});

const continuousImportFixture = repeatedLargeFixture.replace("range(16)", "range(8)").replace("(4,16)", "(4,8)")
  .replace("[('small',4),('large',16)]", "[('small',4),('large',8)]");
// Actual driver Bind encoding, modeled SQL results, and synthetic source only. No PostgreSQL is started.
const continuousImportChild = String.raw`
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
const [root,directory]=process.argv.slice(1);
const runtime=await import(pathToFileURL(join(root,'scripts/rehearse-postgres-full-preservation.ts')).href);
const importer=await import(pathToFileURL(join(root,'packages/database/src/postgres-full-data-import.ts')).href);
const require=createRequire(join(root,'packages/database/package.json'));
const driver=require('pg'),prepareValue=require('pg/lib/utils.js').prepareValue;
const protocol=createRequire(require.resolve('pg/lib/utils.js'))('pg-protocol');
const serialize=protocol.serialize;
const manifest=importer.verifyFullDataPreservationManifest(await readFile(join(directory,'manifest.json')));
let reads=0,checkpoints=0,released=0,gcCalls=0,gcMs=0,sampleMs=0,bindMs=0,bindCalls=0,bindBytes=0,maxBindBytes=0,sqlCalls=0,transactions=0;
let lastCollectionAt=0,phase='validation',validationMs=0,importMs=0,passStarted=0;
const refs=[],boundaryLive=[];
global.gc();const baseline=process.memoryUsage();let peakRss=baseline.rss;

const peakMetrics={peakRssBytes:0},realGc=global.gc;
global.gc=()=>{const t=performance.now();realGc();gcMs+=performance.now()-t;gcCalls++;};
const guardedCheckpoint=runtime.createPreservationResourceCheckpoint({
 deadlineAtMs:Date.now()+30000,resources:{maximumRssBytes:256*1024**2}},peakMetrics,()=>undefined);
let largeBindCollections=0,rowBindCollections=0;
const checkpoint=(releasedChunk=false,allocationBytes=0)=>{
 checkpoints++;const t=performance.now();guardedCheckpoint(releasedChunk,allocationBytes);if(allocationBytes>=1024**2)largeBindCollections++;else if(allocationBytes>=256*1024)rowBindCollections++;sampleMs+=performance.now()-t;
 peakRss=peakMetrics.peakRssBytes;
 if(releasedChunk){released++;boundaryLive.push(refs.filter(ref=>ref.deref()!==undefined).length);}
};
const reader={async read(directory,file,maximum){
 const bytes=await readFile(join(directory,file));if(bytes.length>maximum)throw new Error('fixture_read_limit');
 if(file!=='manifest.json'){reads++;refs.push(new WeakRef(bytes.buffer));}
 return bytes;
}};
function fixtureUow(){
 let op,tables=[],receipts=[];const rowBodies=new Map();
 const lineage={operation_id:manifest.value.operationId,snapshot_sha256:manifest.value.snapshotSha256,manifest_sha256:manifest.manifestSha256};
 return {async run(operation){
  transactions++;if(phase==='validation'){validationMs+=performance.now()-passStarted;phase='import';}
  const query=async(sql,v=[])=>{
   sqlCalls++;checkpoint();const t=performance.now();
   const bind=serialize.bind({values:v,valueMapper:prepareValue});
   bindMs+=performance.now()-t;bindCalls++;bindBytes+=bind.length;maxBindBytes=Math.max(maxBindBytes,bind.length);checkpoint();
   const key=/preservation:(\w+)/.exec(sql)?.[1];let rows=[],rowCount=0;
   switch(key){
    case 'targetIdentity':rows=[{database:'fixture_database',role:'fixture_role',schema:'fixture_preservation'}];break;
    case 'insertOperation':op={...lineage,catalog_fingerprint:v[3],manifest_body:v[4],planned_tables:String(v[5]),planned_chunks:String(v[6]),planned_rows:String(v[7]),completed:false};break;
    case 'selectOperation':rows=[op];break;
    case 'insertTable':tables.push({...lineage,table_name:v[1],row_count:String(v[4]),chunk_count:String(v[5]),content_sha256:v[6]});break;
    case 'selectTables':rows=tables;break;
    case 'selectChunk':rows=[];break;
    case 'insertRows':v[4].forEach((ordinal,index)=>rowBodies.set(ordinal,{...lineage,table_name:v[1],row_ordinal:String(ordinal),chunk_ordinal:String(v[6]),row_body:v[5][index]}));break;
    case 'insertChunk':receipts.push({...lineage,table_name:v[1],ordinal:String(v[4]),file:v[5],start_row:String(v[6]),row_count:String(v[7]),sha256:v[8]});break;
    case 'selectRows':rows=[...rowBodies.values()].filter(row=>Number(row.row_ordinal)>=v[2]&&Number(row.row_ordinal)<v[3]).map(row=>({...row,row_body:Buffer.from(row.row_body)}));break;
    case 'verifyChunk':Object.assign(receipts.find(row=>row.ordinal===String(v[5])),{verified_manifest_sha256:v[2],verified_chunk_sha256:v[3],verified_row_count:String(v[4])});rowCount=1;break;
    case 'selectChunks':rows=receipts;break;
    case 'countRows':rows=[{row_count:String(manifest.totalRows)}];break;
    case 'verifyTable':Object.assign(tables[0],{verified_manifest_sha256:v[2],verified_row_count:String(v[3]),verified_chunk_count:String(v[4])});rowCount=1;break;
    case 'countVerifiedChunks':rows=[{chunk_count:String(receipts.length),row_count:String(manifest.totalRows),all_verified:true}];break;
    case 'completeOperation':op.completed=true;rows=[{operation_id:manifest.value.operationId}];rowCount=1;break;
   }
   return {rows,rowCount};
  };
  try{const result=await operation({query});rowBodies.clear();await new Promise(resolve=>setImmediate(resolve));return result;}finally{rowBodies.clear();}
 }};
}
const started=performance.now();
const results=[];
for(let pass=0;pass<2;pass++){
 phase='validation';const passStart=performance.now();passStarted=passStart;
 const result=await importer.withFullDataPreservationSourceReader(reader,()=>importer.importFullDataPreservationBundle({
  bundleDirectory:directory,target:{schema:'fixture_preservation',database:'fixture_database',role:'fixture_role'},
  executionBudget:{deadlineAtMs:Date.now()+30000,maximumTransactionMs:30000,maximumQueriesPerTransaction:1000,maximumTotalQueries:100000,
   opaqueRowWindows:{maximumRows:64,maximumBytes:512*1024}},checkpoint,unitOfWork:fixtureUow()}));
 results.push({completed:result.completed,committedChunks:result.committedChunks,rows:result.totalRows,elapsedMs:performance.now()-passStart});
}
importMs=performance.now()-started-validationMs;
await new Promise(resolve=>setImmediate(resolve));global.gc();await new Promise(resolve=>setImmediate(resolve));global.gc();
const liveChunkBuffers=refs.filter(ref=>ref.deref()!==undefined).length;
process.stdout.write(JSON.stringify({scope:'offline_synthetic_model_sql_actual_pg_bind_no_pg_capacity_claim',platform:process.platform,
 results,reads,checkpoints,released,boundaryLive,liveChunkBuffers,gcCalls,gcMs,sampleMs,bindMs,bindCalls,bindBytes,maxBindBytes,sqlCalls,transactions,
 elapsedMs:performance.now()-started,validationMs,importMs,largeBindCollections,rowBindCollections,baseline,peakRss,postGc:process.memoryUsage(),pgConnections:0,window:{rows:64,bytes:512*1024}})+'\n');
`;
interface ImportSequenceMemory {
  results: { completed: boolean; committedChunks: number; rows: number; elapsedMs: number }[];
  reads: number; checkpoints: number; released: number; boundaryLive: number[]; liveChunkBuffers: number;
  gcCalls: number; gcMs: number; sampleMs: number; bindMs: number; bindCalls: number; bindBytes: number;
  maxBindBytes: number; sqlCalls: number; transactions: number; peakRss: number; pgConnections: number;
  elapsedMs: number; validationMs: number; importMs: number; largeBindCollections: number; rowBindCollections: number; window: { rows: number; bytes: number };
}
describe("complete continuous import with actual PG Bind encoding", () => {
  it("finishes two fresh synthetic imports under the unchanged sticky RSS bound with released-frame checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "preservation-import-memory-fixture-"));
    try {
      execFileSync("python3", ["-c", continuousImportFixture, directory], { timeout: 15000, maxBuffer: 8192 });
      const result = await childMemory<ImportSequenceMemory>(join(directory, "large"), continuousImportChild, 30000);
      expect(result.results).toHaveLength(2);
      for (const pass of result.results) {
        expect(pass.completed).toBe(true); expect(pass.committedChunks).toBe(8); expect(pass.rows).toBe(32768);
      }
      expect(result.reads).toBe(32); expect(result.released).toBe(32);
      expect(result.boundaryLive.every(count => count <= 1)).toBe(true);
      expect(result.liveChunkBuffers).toBe(0); expect(result.gcCalls).toBeGreaterThanOrEqual(32);
      expect(result.largeBindCollections).toBe(16); expect(result.rowBindCollections).toBe(1024);
      expect(result.sqlCalls).toBe(4392); expect(result.bindCalls).toBe(result.sqlCalls);
      expect(result.bindBytes).toBeGreaterThan(700 * 1024 ** 2);
      expect(result.maxBindBytes).toBeGreaterThan(15 * 1024 ** 2);
      expect(result.window).toEqual({ rows: 64, bytes: 512 * 1024 });
      expect(result.pgConnections).toBe(0); expect(result.peakRss).toBeLessThanOrEqual(256 * 1024 ** 2);
      process.stdout.write(JSON.stringify({ scope: "offline_model_sql_actual_pg_bind_not_host_capacity_proof", result }) + "\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 45000);
});
