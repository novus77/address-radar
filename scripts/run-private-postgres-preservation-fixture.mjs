import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPreservationRunDeadline, preservationStageDeadline } from "./preservation-run-deadline.ts";

const runDeadlineAtMs = readPreservationRunDeadline(process.env.PRESERVATION_RUN_DEADLINE_AT_MS, Date.now());

const helper = "/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar_rehearsal_lifecycle-qz6YDc/private-pg16-lifecycle.mjs";
const helperPin = "f64463042e64f2d11ccfdd078ca00c47e0610d672b02cd51379d94bc1b7a49bb";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const rootSource = "/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle";
const evidence = mkdtempSync(join(tmpdir(),"radar-full-preservation-evidence-"));
const args = ["-o","BatchMode=yes","-o","ConnectTimeout=5","-o","ServerAliveInterval=5","-o","ServerAliveCountMax=1","ubuntu@152.32.185.240"];
if (sha(readFileSync(helper)) !== helperPin) throw new Error("Lifecycle module pin mismatch");
const { withPrivatePreservationFixture } = await import(pathToFileURL(helper).href);
const usePriorCalibration = process.env.PRESERVATION_USE_PRIOR_CALIBRATION === "1";
let priorCalibration;
if (usePriorCalibration) {
  const receipt = JSON.parse(readFileSync("/var/folders/fh/qqfldsc5633ds9h962zq5x2w0000gn/T/radar-full-preservation-evidence-WCoujH/calibrate.json","utf8"));
  if (!Object.entries(pinsForReceipt()).every(([k,v])=>receipt.sourcePins?.[k]===v) || receipt.exitCode!==0 || receipt.target?.systemIdentifier!=="7692712758958352219") throw new Error("Prior calibration provenance mismatch");
  priorCalibration=receipt.reports?.map(x=>x.report).find(x=>x.status==="calibrated"&&x.nativeMetrics?.physicalSqlStatements===162&&x.nativeMetrics?.acknowledgedRollbacks===1&&x.measuredPeakRssBytes===146104320);
  if(!priorCalibration)throw new Error("Prior source calibration missing");
}
function pinsForReceipt(){return {manifestSha256:"d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c",snapshotSha256:"d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7",catalogFingerprint:"6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5",tables:141,rows:6023033,chunks:1548};}
const sourceReader = readFileSync(new URL("./preservation-source-reader.py",import.meta.url));
const runner = readFileSync("/private/tmp/radar-private-preservation-runner.mjs");
const ddlFingerprint = process.env.PRESERVATION_DDL_FINGERPRINT;
// The schema-specific fingerprint is supplied through the compiled read-only helper below,
// not by trusting a production ledger or self-asserting business authority.
const fingerprintScript = process.env.PRESERVATION_FINGERPRINT_HELPER;
if (!fingerprintScript || ddlFingerprint) throw new Error("Explicit isolated fingerprint helper required");
const pins = {manifestSha256:"d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c",snapshotSha256:"d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7",catalogFingerprint:"6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5",tables:141,rows:6023033,chunks:1548};
const remotePython = String.raw`
import os,sys,json,hashlib,stat,pwd,base64,subprocess,time,signal
p=json.loads(sys.stdin.read(2*1024*1024)); root=p['root']
import re
if not re.fullmatch(r'/tmp/radar_rehearsal_[a-f0-9]{16}',root): raise RuntimeError('scope')
uid=pwd.getpwnam('postgres').pw_uid
for path in [root,root+'/connection.json',root+'/owner']:
 s=os.lstat(path)
 if stat.S_ISLNK(s.st_mode) or s.st_uid!=uid or s.st_mode&0o077: raise RuntimeError('fixture_owner')
if os.path.realpath(root)!=root: raise RuntimeError('fixture_path')
with open(root+'/connection.json','rb') as f: c=f.read(16385)
if hashlib.sha256(c).hexdigest()!=p['connectionSha256']: raise RuntimeError('connection_pin')
if not re.fullmatch(r'[a-f0-9]{48}',open(root+'/owner').read()): raise RuntimeError('fixture_marker')
work=root+'/preservation'
if p['stage'] in ('calibrate','install'):
 os.mkdir(work,0o700);os.chown(work,uid,pwd.getpwnam('postgres').pw_gid)
 os.mkdir(work+'/evidence',0o700);os.chown(work+'/evidence',uid,pwd.getpwnam('postgres').pw_gid)
else:
 s=os.lstat(work)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid or s.st_mode&0o077 or os.path.realpath(work)!=work: raise RuntimeError('work_owner')
def put(name,body):
 path=work+'/'+name
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(body)
if p['stage'] in ('calibrate','install'):
 code=base64.b64decode(p['runner'])
 if hashlib.sha256(code).hexdigest()!=p['runnerSha256']: raise RuntimeError('runner_pin')
 put('runner.mjs',code)
 reader=base64.b64decode(p['sourceReader'])
 if hashlib.sha256(reader).hexdigest()!=p['sourceReaderSha256']:raise RuntimeError('source_reader_pin')
 put('source-reader.py',reader)
 if p['stage']=='install':
  proof=base64.b64decode(p['priorCalibration'])
  if hashlib.sha256(proof).hexdigest()!=p['priorCalibrationSha256']:raise RuntimeError('calibration_pin')
  path=work+'/evidence/calibration.json';fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:f.write(proof)
stage=p['stage']
if stage not in ('install','calibrate','interrupt','resume','parity'):raise RuntimeError('stage')
config=base64.b64decode(p['config']);authority=base64.b64decode(p['authority'])
if hashlib.sha256(config).hexdigest()!=p['configSha256'] or hashlib.sha256(authority).hexdigest()!=p['authoritySha256']:raise RuntimeError('record_pin')
put(stage+'-config.json',config);put(stage+'-authority.json',authority)
output=work+'/'+stage+'-stdout.json';fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
started=time.monotonic();started_unix_ms=time.time_ns()//1000000;peak=0;minimum_memory=2**63-1;minimum_disk=2**63-1;reason=None
with os.fdopen(fd,'wb') as f:
 child=subprocess.Popen(['/usr/bin/ionice','-c','3','/usr/bin/nice','-n','19','/usr/local/bin/node','--max-old-space-size=96','--expose-gc',work+'/runner.mjs',stage,work+'/'+stage+'-config.json',p['configSha256'],work+'/'+stage+'-authority.json',p['authoritySha256']],stdout=f,stderr=subprocess.DEVNULL,start_new_session=True)
 while child.poll() is None:
  mem=int(re.search(r'^MemAvailable:\s+(\d+)',open('/proc/meminfo').read(),re.M)[1])*1024
  disk=os.statvfs(root).f_bavail*os.statvfs(root).f_frsize
  try:rss=int(re.search(r'^VmRSS:\s+(\d+)',open('/proc/'+str(child.pid)+'/status').read(),re.M)[1])*1024
  except (OSError,TypeError):rss=0
  peak=max(peak,rss);minimum_memory=min(minimum_memory,mem);minimum_disk=min(minimum_disk,disk)
  if mem<1024**3:reason='external_memory_reserve'
  elif disk<5*1024**3:reason='external_disk_reserve'
  elif rss>256*1024**2:reason='external_rss_limit'
  elif time.monotonic()-started>p['timeoutSeconds']:reason='external_deadline'
  if reason:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
   break
  time.sleep(.2)
ret=child.wait();out=open(output).read(262144)
reports=[]
for name in os.listdir(work+'/evidence'):
 if re.fullmatch(r'[a-z0-9-]+\.json',name):
  path=work+'/evidence/'+name;s=os.lstat(path)
  if stat.S_ISREG(s.st_mode) and s.st_size<=262144:reports.append({'file':name,'report':json.load(open(path))})
print(json.dumps({'stage':stage,'startedAtUnixMs':started_unix_ms,'endedAtUnixMs':time.time_ns()//1000000,'exitCode':ret,'reason':reason,'elapsedSeconds':time.monotonic()-started,'externalPeakRssBytes':peak,'minimumAvailableMemoryBytes':minimum_memory,'minimumFreeBytes':minimum_disk,'stdout':out,'reports':reports},separators=(',',':')))
`;
try {
  await withPrivatePreservationFixture(async ctx => {
    const conn=readFileSync(ctx.connectionPath), connectionSha256=sha(conn), privateConnection=JSON.parse(conn);
    const fingerprint=spawnSync(process.execPath,[fingerprintScript,ctx.schema],{encoding:"utf8",timeout:5000});
    if(fingerprint.status!==0 || !/^[a-f0-9]{64}$/.test(fingerprint.stdout.trim()))throw new Error("Fingerprint helper failed");
    const target={database:ctx.database,schema:ctx.schema,username:ctx.role,serverAddress:"127.0.0.1",serverPort:5434,systemIdentifier:ctx.systemIdentifier,schemaVersion:1,schemaFingerprint:fingerprint.stdout.trim(),generation:"preservation-"+ctx.nonce,service:"migration-preservation"};
    for(const stage of (process.env.PRESERVATION_CALIBRATION_ONLY === "1" ? ["calibrate"] : (usePriorCalibration ? ["install","interrupt","resume","parity"] : ["calibrate","interrupt","resume","parity"]))){
      ctx.guard();
      const stageBudget=preservationStageDeadline(stage,Date.now(),runDeadlineAtMs);
      const deadlineAtMs=stageBudget.deadlineAtMs;
      const config={sourceReaderSha256:sha(sourceReader),version:1,stage:(stage==="calibrate"||stage==="install")?"interrupt":stage,bundleDirectory:rootSource,evidenceDirectory:"/tmp/"+ctx.database+"/preservation/evidence",storagePath:"/tmp/"+ctx.database+"/data",authorityModule:"/tmp/"+ctx.database+"/preservation/runner.mjs",authorityModuleSha256:sha(runner),approvalRef:"human-backup-derived-isolated-20261004",deadlineAtMs,expected:pins,target,
        resources:{reserveBytes:5*1024**3,maximumTargetGrowthBytes:20*1024**3,minimumAvailableMemoryBytes:1024**3,maximumRssBytes:256*1024**2,maximumMemoryPsiAvg10:1,maximumResidentChunkBytes:16775058},maximumTotalQueries:1000000,maximumTransactionMs:60000,maximumQueriesPerTransaction:10000,interruptAfterCommittedChunks:2};
      const configBytes=Buffer.from(JSON.stringify(config)),authorityBytes=Buffer.from(JSON.stringify({version:1,scope:"backup-derived-preservation-rehearsal",target,approvalRef:config.approvalRef,expiresAtMs:deadlineAtMs,password:privateConnection.password}));
      const calibrationBytes=Buffer.from(JSON.stringify(priorCalibration??null));
      const payload={priorCalibration:calibrationBytes.toString("base64"),priorCalibrationSha256:sha(calibrationBytes),sourceReader:sourceReader.toString("base64"),sourceReaderSha256:sha(sourceReader),root:"/tmp/"+ctx.database,stage,connectionSha256,runner:runner.toString("base64"),runnerSha256:sha(runner),config:configBytes.toString("base64"),configSha256:sha(configBytes),authority:authorityBytes.toString("base64"),authoritySha256:sha(authorityBytes),timeoutSeconds:stageBudget.timeoutSeconds};
      // Fixed argv and JSON stdin; the source path is compiled, not interpolated shell input.
      const encoded=Buffer.from(JSON.stringify(payload)).toString("base64");
      const script="import base64,io,sys\nsys.stdin=io.StringIO(base64.b64decode('"+encoded+"').decode())\n"+remotePython;
      const result=spawnSync("ssh",[...args,"sudo -n nice -n 19 ionice -c 3 python3 -"],{input:script,encoding:"utf8",timeout:stageBudget.transportTimeoutMs,maxBuffer:1024*1024});
      if(result.status!==0){writeFileSync(join(evidence,stage+"-transport.json"),JSON.stringify({status:"transport_failed",exitCode:result.status,error:result.error?.code,stage,productionAuthorized:false}),{mode:0o600});throw new Error("Private fixed runner failed; inspect retained transport receipt");}
      const receipt=JSON.parse(result.stdout);writeFileSync(join(evidence,stage+".json"),JSON.stringify({...receipt,target,sourcePins:pins,runDeadlineAtMs})+"\n",{mode:0o600});
      process.stdout.write(JSON.stringify({stage,startedAt:new Date(receipt.startedAtUnixMs).toISOString(),endedAt:new Date(receipt.endedAtUnixMs).toISOString(),exitCode:receipt.exitCode,reason:receipt.reason,elapsedSeconds:receipt.elapsedSeconds,externalPeakRssBytes:receipt.externalPeakRssBytes,minimumAvailableMemoryBytes:receipt.minimumAvailableMemoryBytes,minimumFreeBytes:receipt.minimumFreeBytes})+"\n");
      if(receipt.exitCode!==0 || receipt.reason){process.exitCode=1;break;}
    }
  });
  process.stdout.write(JSON.stringify({evidenceDirectory:evidence,lifecycleCleanupConfirmed:true,productionAuthorized:false})+"\n");
}catch(error){process.stdout.write(JSON.stringify({evidenceDirectory:evidence,lifecycleCleanupConfirmed:false,reason:error.message,productionAuthorized:false})+"\n");process.exitCode=1;}
