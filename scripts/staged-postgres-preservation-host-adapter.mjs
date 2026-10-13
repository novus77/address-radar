import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, open, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
// Keep the host policy self-contained: importing the executable supervisor here
// deadlocks its top-level await while it dynamically imports this adapter.
const lifecycleSha256 = "f64463042e64f2d11ccfdd078ca00c47e0610d672b02cd51379d94bc1b7a49bb";
const fixedMaintenance = "/var/lib/address-radar-maintenance-tools/e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d/helper.py";
const fixedPins = Object.freeze({ manifestSha256: "d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c", snapshotSha256: "d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7", catalogFingerprint: "6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5", tables: 141, rows: 6023033, chunks: 1548 });

const sha = value => createHash("sha256").update(value).digest("hex");
const gate = (value, code) => { if (!value) throw new Error("preservation_host_" + code); };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const same = (a, b) => a && b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
export const sshArgs = Object.freeze(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", "ubuntu@152.32.185.240", "sudo -n /usr/bin/nice -n 19 /usr/bin/ionice -c 3 /usr/bin/python3 -"]);
const maintenanceHash = "e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d";

/** Fixed transport. No shell interpolation, stderr exposure, alternate host, or retry. */
export function createFixedTransport(spawnProcess = spawn, { graceMs = 5000 } = {}) {
  return (payload, timeoutMs, { signal: abortSignal } = {}) => new Promise((resolveResult, reject) => {
    gate(count(timeoutMs, 950000) && timeoutMs > 0 && count(graceMs, 5000) && graceMs > 0, "transport_budget");
    gate(!abortSignal?.aborted, "transport_aborted");
    const json=JSON.stringify(payload);gate(Buffer.byteLength(json)<=2*1024*1024,"transport_input_bound");
    const encoded = Buffer.from(json).toString("base64");
    const input = "import base64,io,sys\nsys.stdin=io.StringIO(base64.b64decode('" + encoded + "').decode())\n" + remotePython;
    const child = spawnProcess("ssh", [...sshArgs], { stdio: ["pipe", "pipe", "ignore"], detached: true, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } });
    let bytes = 0, output = [], failure, killTimer, closeTimer;
    const signal = kind => { try { process.kill(-child.pid, kind); } catch { try { child.kill(kind); } catch {} } };
    const abort = reason => {
      if (failure) return; failure = reason; signal("SIGTERM");
      killTimer = setTimeout(() => { signal("SIGKILL"); closeTimer = setTimeout(() => reject(new Error("preservation_host_transport_close_unconfirmed")), graceMs); }, graceMs);
    };
    const timer = setTimeout(() => abort("transport_timeout"), Math.max(0, timeoutMs - 2 * graceMs));
    const abortListener = () => abort("transport_aborted");
    abortSignal?.addEventListener("abort", abortListener, { once: true });
    child.on("error", () => abort("transport_spawn"));
    child.stdin.on("error", () => abort("transport_input"));
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) abort("transport_output_bound"); else output.push(chunk); });
    child.on("close", code => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
      abortSignal?.removeEventListener("abort", abortListener);
      if (failure || code !== 0) { reject(new Error("preservation_host_" + (failure ?? "transport_failed"))); return; }
      let receipt;
      try { receipt = JSON.parse(Buffer.concat(output).toString("utf8")); }
      catch { reject(new Error("preservation_host_invalid_transport_receipt")); return; }
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || typeof receipt.ok !== "boolean") {
        reject(new Error("preservation_host_invalid_transport_receipt")); return;
      }
      if (receipt.ok === false) {
        const safe = ["not_immutable", "source_manifest_pin", "source_operation", "source_manifest_context", "read_kind", "protected_owner"];
        reject(new Error("preservation_host_remote_refused" + (safe.includes(receipt.code) ? "_" + receipt.code : ""))); return;
      }
      if (!Object.hasOwn(receipt,"value")) { reject(new Error("preservation_host_invalid_transport_receipt")); return; }
      resolveResult(receipt.value);
    });
    child.stdin.end(input);
  });
}

// This program executes only when the explicitly invoked adapter dispatches SSH.
// It never reads production credentials or accepts a caller-supplied command.
export const remotePython = String.raw`
import os,sys,json,hashlib,stat,pwd,re,base64,subprocess,time,signal,fcntl,array
p=json.loads(sys.stdin.read(2*1024*1024))
operationDeadlineMono=time.monotonic()+p['operationSeconds']
ROOT_SOURCE='/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle'
MAINT='/var/lib/address-radar-maintenance-tools/e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d/helper.py'
MAINT_HASH='e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d'
PG='/usr/lib/postgresql/16/bin/postgres'
os.umask(0o077)
def need(ok,code):
 if not ok:raise RuntimeError(code)
def digest(x):return hashlib.sha256(x).hexdigest()
def protected(path):
 need(os.path.isabs(path) and os.path.normpath(path)==path,'protected_path')
 current='/'
 for name in path.split('/')[1:]:
  current=os.path.join(current,name);s=os.lstat(current)
  need(not stat.S_ISLNK(s.st_mode) and s.st_uid==0 and not s.st_mode&0o022,'protected_owner')
def read(path,uid,limit=1048576,mode=None):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  a=os.fstat(fd);need(stat.S_ISREG(a.st_mode) and a.st_uid==uid and a.st_nlink==1 and not a.st_mode&0o077 and a.st_size<=limit,'read_kind')
  if mode is not None:need(stat.S_IMODE(a.st_mode)==mode,'read_mode')
  parts=[];total=0
  while True:
   chunk=os.read(fd,min(65536,limit+1-total))
   if not chunk:break
   total+=len(chunk);need(total<=limit,'read_bound');parts.append(chunk)
  b=os.fstat(fd);need((a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)==(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns),'read_race')
  s=os.lstat(path);need((s.st_dev,s.st_ino)==(a.st_dev,a.st_ino),'path_race')
  return b''.join(parts)
 finally:os.close(fd)
def rootdir(path):
 if not os.path.exists(path):os.mkdir(path,0o700)
 protected(path);need(stat.S_ISDIR(os.lstat(path).st_mode),'directory_kind')
def put(path,raw,mode=0o600):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(raw);f.flush()
  os.fsync(fd)
 finally:os.close(fd)
def pinned(path,pin):
 protected(path);need(digest(read(path,0,2*1024*1024))==pin,'helper_pin')
def run(argv,timeout=15):
 need(type(argv) is list and all(type(x) is str and '\x00' not in x for x in argv),'argv')
 r=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=min(timeout,max(.1,operationDeadlineMono-time.monotonic()-10)),env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
 need(r.returncode==0 and len(r.stdout)<=262144,'command_failed');return r.stdout.decode()
def props(unit,keys):
 raw=run(['/usr/bin/systemctl','show',unit,'--no-pager',*[('--property='+k) for k in keys]])
 out={}
 for line in raw.splitlines():
  k,sep,v=line.partition('=');need(sep and k not in out,'property_parse');out[k]=v
 need(set(out)==set(keys),'property_missing');return out
TKEYS=['Id','LoadState','ActiveState','SubState','Transient','AccuracyUSec','TimersCalendar','Triggers','TimersMonotonic','ActiveEnterTimestampMonotonic']
SKEYS=['Id','LoadState','ActiveState','SubState','Transient','Type','User','TimeoutStartUSec','Restart','KillMode','ExecStart']
def native_timespan_usec(value):
 need(isinstance(value,str) and 0<len(value)<=128 and value==value.strip(),'native_timespan')
 if re.fullmatch(r'[0-9]+',value):
  result=int(value);need(result<=9223372036854775807,'native_timespan');return result
 scales={'us':1,'ms':1000,'s':1000000,'min':60000000,'h':3600000000,'d':86400000000,'w':604800000000}
 total=0;position=0;previous=604800000001
 for match in re.finditer(r'([0-9]+)(?:\.([0-9]{1,6}))?(us|ms|min|s|h|d|w)(?: |$)',value):
  need(match.start()==position,'native_timespan');scale=scales[match[3]];need(scale<previous,'native_timespan');previous=scale
  fraction=match[2] or '';numerator=int(match[1])*10**len(fraction)+int(fraction or '0')
  amount,remainder=divmod(numerator*scale,10**len(fraction));need(remainder==0,'native_timespan')
  total+=amount;need(total<=9223372036854775807,'native_timespan');position=match.end()
 need(position==len(value) and position>0,'native_timespan');return total
def timer_verify(name,argv,seconds,timeout):
 t=props(name+'.timer',TKEYS);s=props(name+'.service',SKEYS)
 need(t['Id']==name+'.timer' and t['LoadState']=='loaded' and t['ActiveState']=='active' and t['SubState']=='waiting' and t['Transient']=='yes' and native_timespan_usec(t['AccuracyUSec'])==1000000 and t['TimersCalendar']=='' and t['Triggers']==name+'.service','timer_state')
 interval=re.fullmatch(r'\{ OnActiveUSec=([0-9A-Za-z. ]{1,128}) ; next_elapse=([^;{}\r\n]{1,128})(?: ;)? \}',t['TimersMonotonic'])
 need(interval and interval[2].strip() not in ('[n/a]','n/a','infinity','0'),'timer_interval')
 need(native_timespan_usec(interval[1])==seconds*1000000,'timer_duration')
 need(t['ActiveEnterTimestampMonotonic'].isdigit(),'timer_clock')
 need(s['Id']==name+'.service' and s['LoadState']=='loaded' and s['ActiveState']=='inactive' and s['SubState']=='dead' and s['Transient']=='yes' and s['Type']=='oneshot' and s['User']=='root' and native_timespan_usec(s['TimeoutStartUSec'])==timeout*1000000 and s['Restart']=='no' and s['KillMode']=='control-group','service_state')
 command=re.fullmatch(r'\{ path=/usr/bin/python3 ; argv\[\]=(.*?) ; ignore_errors=no ; [^{}\r\n]{1,2048} \}',s['ExecStart'])
 need(command and command[1]==' '.join(argv),'service_command')
 return int(t['ActiveEnterTimestampMonotonic'])/1000000+seconds
nonce=p['nonce'];need(re.fullmatch(r'[a-f0-9]{16}',nonce),'nonce')
root='/tmp/radar_rehearsal_'+nonce;work='/var/lib/address-radar-rehearsal-artifacts/'+nonce
uid=pwd.getpwnam('postgres').pw_uid
connection=None
def identity():
 global connection
 s=os.lstat(root);need(stat.S_ISDIR(s.st_mode) and s.st_uid==uid and stat.S_IMODE(s.st_mode)==0o700 and os.path.realpath(root)==root,'fixture_root')
 owner=read(root+'/owner',uid,64,0o600).decode();need(re.fullmatch(r'[a-f0-9]{48}',owner),'owner_marker')
 raw=read(root+'/connection.json',uid,16384,0o600);connection=json.loads(raw)
 expected={'host':'127.0.0.1','port':5434,'database':'radar_rehearsal_'+nonce,'schema':'radar_rehearsal_'+nonce+'_schema','username':'radar_rehearsal_'+nonce+'_migrator','systemIdentifier':p['systemIdentifier'],'nonce':nonce}
 need(set(connection)==set(expected)|{'password'} and all(connection[k]==v for k,v in expected.items()) and re.fullmatch(r'[a-f0-9]{64}',connection['password']),'connection_scope')
 data=os.lstat(root+'/data');need(stat.S_ISDIR(data.st_mode) and data.st_uid==uid and stat.S_IMODE(data.st_mode)==0o700 and data.st_dev==s.st_dev,'data_owner')
 pidlines=read(root+'/data/postmaster.pid',uid,65536,0o600).decode().splitlines()
 need(len(pidlines)>=8 and pidlines[0].isdigit() and int(pidlines[0])>1 and pidlines[1]==root+'/data' and pidlines[3]=='5434' and pidlines[4]==root+'/socket' and pidlines[5]=='127.0.0.1' and pidlines[7].strip()=='ready','postmaster_pid')
 pid=int(pidlines[0]);proc='/proc/'+str(pid);need(os.stat(proc).st_uid==uid and os.readlink(proc+'/exe')==PG,'process_owner')
 cmd=open(proc+'/cmdline','rb').read(4096).split(b'\0');need(cmd[0]==PG.encode() and any(cmd[i:i+2]==[b'-D',(root+'/data').encode()] for i in range(1,len(cmd)-1)),'process_command')
 fields=open(proc+'/stat','rb').read(4096).rsplit(b')',1)[1].split();need(fields[0] not in (b'Z',b'X'),'process_dead')
 artifact=os.lstat(work);need(stat.S_ISDIR(artifact.st_mode) and artifact.st_uid==0 and stat.S_IMODE(artifact.st_mode)==0o700,'artifact_root')
 protected(work)
 marker=read(work+'/owner',0,64,0o600).decode();need(re.fullmatch(r'[a-f0-9]{48}',marker),'artifact_marker')
 observed={'artifactRoot':work,'artifactOwner':marker,'artifactDevice':artifact.st_dev,'artifactInode':artifact.st_ino,'owner':owner,'connectionSha256':digest(raw),'directoryDevice':s.st_dev,'directoryInode':s.st_ino,'dataDevice':data.st_dev,'dataInode':data.st_ino,'postmasterPid':pid,'postmasterStart':fields[19].decode(),'postmasterEpoch':int(pidlines[2])}
 if p.get('binding'):need(all(p['binding'][k]==v for k,v in observed.items()),'identity_changed')
 return observed
def immutable(path,set_flag=False):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  flags=array.array('I',[0]);fcntl.ioctl(fd,0x80086601,flags,True)
  if set_flag and not flags[0]&0x10:flags[0]|=0x10;fcntl.ioctl(fd,0x40086602,flags,True);fcntl.ioctl(fd,0x80086601,flags,True)
  need(flags[0]&0x10,'not_immutable')
  return flags[0]
 finally:os.close(fd)
def expiry_paths():
 h=p['expiryHelperSha256'];need(re.fullmatch(r'[a-f0-9]{64}',h),'expiry_hash')
 return '/var/lib/address-radar-preservation-expiry-tools/'+h+'/helper.py','/var/lib/address-radar-preservation-expiry/'+nonce+'/record.json'
def expiry_record(path,pin):
 protected(path);raw=read(path,0,16384,0o600);need(digest(raw)==pin,'expiry_record_pin');immutable(path)
 r=json.loads(raw);b=p['binding']
 need(r['nonce']==nonce and r['root']==root and r['root_identity']==[b['directoryDevice'],b['directoryInode']] and r['data_identity']==[b['dataDevice'],b['dataInode']] and r['owner_pin']['sha256']==digest(b['owner'].encode()) and r['connection_pin']['sha256']==b['connectionSha256'] and r['system_identifier']==p['systemIdentifier'] and r['pid']==b['postmasterPid'] and str(r['process_ticks'])==b['postmasterStart'] and r['postmaster_start']==b['postmasterEpoch'] and 0<r['deadline']-r['created_at']<=10800 and r['deadline']*1000<=p['absoluteDeadlineAtMs'],'expiry_binding')
 if b.get('artifactControlRoot'):
  artifacts=r.get('artifacts');need(type(artifacts) is dict,'expiry_artifacts_missing')
  need(artifacts['root']==work and artifacts['identity']==[b['artifactDevice'],b['artifactInode']] and artifacts['owner_pin']['sha256']==digest(b['artifactOwner'].encode()),'expiry_artifact_identity')
  control=artifacts['control'];need(control['root']==b['artifactControlRoot'] and control['identity']==[b['artifactControlDevice'],b['artifactControlInode']] and control['lock_pin']['identity']==[b['artifactLockDevice'],b['artifactLockInode']],'expiry_control_identity')
  need(set(artifacts['code_pins'])==set(b['registeredCodePins']) and all(artifacts['code_pins'][name]['sha256']==pin for name,pin in b['registeredCodePins'].items()),'expiry_registered_code_pins')
 return r
def pinned_source_operation():
 protected(ROOT_SOURCE);path=ROOT_SOURCE+'/manifest.json';protected(path)
 raw=read(path,0,545010);need(len(raw)==545010 and digest(raw)=='d73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c','source_manifest_pin')
 immutable(path)
 manifest=json.loads(raw);operation=manifest.get('operationId')
 need(type(operation) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',operation),'source_operation')
 need(manifest.get('snapshotSha256')=='d73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7' and manifest.get('catalogFingerprint')=='6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5','source_manifest_context')
 return {'path':path,'manifestSha256':digest(raw),'operationId':operation}
def source_seal_admission():
 rootinfo=os.lstat(ROOT_SOURCE);need(stat.S_ISDIR(rootinfo.st_mode) and rootinfo.st_uid==0 and not rootinfo.st_mode&0o077,'source_root_owner')
 rootflags=immutable(ROOT_SOURCE)
 manifest=json.loads(read(ROOT_SOURCE+'/manifest.json',0,545010));need(len(manifest['tables'])==141,'source_tables')
 seen={'manifest.json'};rows=0
 for table in manifest['tables']:
  table_rows=0
  for chunk in table['chunks']:
   name=chunk['file'];need(type(name) is str and re.fullmatch(r'table-[0-9]{4}-chunk-[0-9]{6}\.json',name) and name not in seen,'source_chunk_name')
   seen.add(name);path=ROOT_SOURCE+'/'+name
   fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
   try:
    before=os.fstat(fd);need(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1 and not before.st_mode&0o077 and 0<before.st_size<=manifest['limits']['maximumChunkBytes'],'source_chunk_kind')
    flags=array.array('I',[0]);fcntl.ioctl(fd,0x80086601,flags,True);need(flags[0]&0x10,'not_immutable')
    current=os.lstat(path);need([current.st_dev,current.st_ino]==[before.st_dev,before.st_ino],'source_chunk_race')
   finally:os.close(fd)
   need(type(chunk['rowCount']) is int and chunk['rowCount']>=0,'source_chunk_rows');table_rows+=chunk['rowCount']
  need(table_rows==table['rowCount'],'source_table_rows');rows+=table_rows
 current=os.lstat(ROOT_SOURCE);need([current.st_dev,current.st_ino]==[rootinfo.st_dev,rootinfo.st_ino],'source_root_race')
 need(len(seen)==1549 and rows==6023033,'source_seal_scope')
 return {'fileCount':len(seen),'rootDevice':rootinfo.st_dev,'rootInode':rootinfo.st_ino,'rootImmutableFlags':rootflags}
child=None
IKEYS=['Id','LoadState','ActiveState','SubState','User','KillMode','ExecStart','ExecMainStartTimestampMonotonic','ControlGroup','Result','InvocationID','Transient']
def invocation_names(invocation):
 need(re.fullmatch(r'[a-f0-9]{32}-[0-9]{6}',invocation),'invocation_name')
 unit='address-radar-preservation-invocation-'+nonce+'-'+invocation+'.service'
 directory='/var/lib/address-radar-rehearsal-artifact-control/'+nonce+'/invocations'
 return unit,directory+'/'+invocation+'.json',directory+'/'+invocation+'-started.json'
def invocation_load(invocation):
 unit,path,started_path=invocation_names(invocation)
 protected(path);raw=read(path,0,65536,0o600);record=json.loads(raw)
 need(record['nonce']==nonce and record['invocationId']==invocation and record['unit']==unit and record['identitySha256']==p['identitySha256'] and record['connectionSha256']==p['binding']['connectionSha256'] and record['owner']==p['binding']['owner'] and record['root']==root,'invocation_binding')
 protected(started_path);started_raw=read(started_path,0,65536,0o600);instance=json.loads(started_raw)
 need(instance['recordSha256']==digest(raw) and instance['startMonotonicUs'].isdigit() and int(instance['startMonotonicUs'])>0,'invocation_instance')
 return record,instance,digest(raw),digest(started_raw)
def invocation_props(record,instance=None):
 s=props(record['unit'],IKEYS)
 need(s['Id']==record['unit'] and s['LoadState']=='loaded' and s['User']=='root' and s['KillMode']=='control-group' and s['Transient']=='yes' and re.fullmatch(r'[a-f0-9]{32}',s['InvocationID']) and s['InvocationID']!='0'*32,'invocation_unit')
 command=re.fullmatch(re.escape('{ path=/usr/bin/ionice ; argv[]=')+'(.*?)'+re.escape(' ; ignore_errors=no ; ')+'[^{}]{1,8192}'+re.escape(' }'),s['ExecStart'])
 need(chr(10) not in s['ExecStart'] and chr(13) not in s['ExecStart'],'invocation_command_line')
 need(command and digest(command[1].encode())==record['commandSha256'],'invocation_command')
 need(s['ExecMainStartTimestampMonotonic'].isdigit() and int(s['ExecMainStartTimestampMonotonic'])>0,'invocation_not_started')
 if instance is not None:need(s['ExecMainStartTimestampMonotonic']==instance['startMonotonicUs'] and s['InvocationID']==instance['nativeInvocationId'],'invocation_reused')
 return s
def cgroup_status(record,instance,s):
 expected='/system.slice/'+record['unit'];cg=s['ControlGroup']
 need(cg in ('',expected),'invocation_cgroup')
 path='/sys/fs/cgroup'+expected
 if not os.path.lexists(path):
  raise RuntimeError('invocation_cgroup_unknown')
 need(cg==expected and os.path.realpath(path)==path,'cgroup_path')
 info=os.lstat(path);need(stat.S_ISDIR(info.st_mode) and info.st_uid==0,'cgroup_owner')
 if instance is not None:need([info.st_dev,info.st_ino]==instance['cgroupIdentity'],'cgroup_reused')
 events=open(path+'/cgroup.events').read(4096);match=re.search(r'^populated ([01])$',events,re.M);need(match,'cgroup_events')
 raw=open(path+'/cgroup.procs').read(65536);need(len(raw)<65536 and all(x.isdigit() for x in raw.split()),'cgroup_procs')
 return int(match[1]),[int(x) for x in raw.split()]
def maintenance_jobs_settled(record):
 if record.get('maintenanceAction') not in ('pause','restore'):return False
 pinned(MAINT,MAINT_HASH)
 import importlib.util
 spec=importlib.util.spec_from_file_location('radar_frozen_maintenance_policy',MAINT)
 policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
 related=set(policy.MAIN+policy.AUX+policy.TIMERS)|{record['unit'],'address-radar-maintenance-'+record['maintenanceNonce']+'.service'}
 for line in run(['/usr/bin/systemctl','list-jobs','--no-legend','--no-pager','--plain'],5).splitlines():
  fields=line.split();need(len(fields)==4 and fields[0].isdigit(),'maintenance_job_format')
  if fields[1] in related:raise RuntimeError('maintenance_jobs_unsettled')
 return True
def invocation_empty(invocation,stop=False):
 record,instance,record_hash,instance_hash=invocation_load(invocation)
 s=invocation_props(record,instance)
 if stop:
  # Stop only the protected exact unit instance; never signal a reaped numeric PGID.
  result=subprocess.run(['/usr/bin/systemctl','stop',record['unit']],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
  need(result.returncode==0,'invocation_stop')
  s=invocation_props(record,instance)
 populated,pids=cgroup_status(record,instance,s)
 maintenance=record.get('maintenanceAction') in ('pause','restore')
 terminal=(s['ActiveState'] in ('inactive','failed') and s['SubState'] in ('dead','failed')) or (maintenance and s['ActiveState']=='active' and s['SubState']=='exited')
 need(populated==0 and not pids and terminal,'producer_not_empty')
 settled=maintenance_jobs_settled(record) if maintenance else False
 again=invocation_props(record,instance);again_populated,again_pids=cgroup_status(record,instance,again)
 need(again_populated==0 and not again_pids and again['ActiveState']==s['ActiveState'] and again['SubState']==s['SubState'],'producer_exit_changed')
 return {'jobsSettled':settled,'invocationId':invocation,'unit':record['unit'],'recordSha256':record_hash,'instanceSha256':instance_hash,'cgroupPopulated':populated,'cgroupProcessCount':len(pids)}
def stop_child():
 global child
 if child is None:return
 invocation_empty(child,True)
 child=None
def interrupted(*_):raise RuntimeError('interrupted')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted);signal.signal(signal.SIGINT,interrupted)
def execute():
 global child
 action=p['action']
 if action=='source-operation-id':return pinned_source_operation()
 if action=='segmented-native-test-admission':
  identity();source=pinned_source_operation();need(source['operationId']==p['operationId'],'native_test_operation')
  source['seal']=source_seal_admission()
  need(open('/proc/1/comm').read(64).strip()=='systemd' and os.path.isfile('/sys/fs/cgroup/cgroup.controllers'),'native_test_systemd')
  controllers=open('/sys/fs/cgroup/cgroup.controllers').read(4096).split();need({'cpu','memory','pids'}.issubset(controllers),'native_test_controllers')
  pinned(MAINT,MAINT_HASH)
  helper,_=expiry_paths();pinned(helper,p['expiryHelperSha256']);immutable(helper)
  database='radar_rehearsal_'+nonce;role=database+'_migrator';schema=database+'_schema'
  query="SELECT json_build_object('database',current_database(),'systemIdentifier',(pg_control_system()).system_identifier::text,'port',current_setting('port')::integer,'role',r.rolname,'superuser',r.rolsuper,'createDatabase',r.rolcreatedb,'createRole',r.rolcreaterole,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=r.oid),'schemaOwner',pg_get_userbyid(n.nspowner)) FROM pg_roles r CROSS JOIN pg_namespace n WHERE r.rolname='"+role+"' AND n.nspname='"+schema+"'"
  argv=['/usr/sbin/runuser','-u','postgres','--','/usr/lib/postgresql/16/bin/psql','-X','-q','-A','-t','--set=ON_ERROR_STOP=1','--host='+root+'/socket','--port=5434','--username=postgres','--dbname='+database,'--command='+query]
  actual=json.loads(run(argv,30));need(actual['database']==database and actual['port']==5434 and actual['systemIdentifier']==p['systemIdentifier'] and actual['role']==role and actual['schemaOwner']==role and actual['connectionLimit']==1 and actual['memberships']==0 and all(actual[k] is False for k in ('superuser','createDatabase','createRole','replication','bypassRls')),'native_test_role_chain')
  identity()
  return {'status':'native-test-admitted','nativeAcceptance':'pending','scope':'fixed-immutable-rehearsal-private-pg16','nonce':nonce,'identitySha256':p['identitySha256'],'source':source,'target':actual}
 if action=='bind':
  rootdir('/var/lib/address-radar-rehearsal-artifacts')
  os.mkdir(work,0o700)
  protected(work);put(work+'/owner',os.urandom(24).hex().encode())
  return identity()
 if action=='managed-independent-empty':
  helper,record=expiry_paths();pinned(helper,p['expiryHelperSha256']);immutable(helper)
  import importlib.util
  specification=importlib.util.spec_from_file_location('radar_independent_expiry',helper)
  module=importlib.util.module_from_spec(specification);specification.loader.exec_module(module)
  actual=module.load_record(record,p['recordSha256'],nonce)
  need(actual['system_identifier']==p['systemIdentifier'] and re.fullmatch(r'[a-f0-9]{32}',p['challenge']),'independent_context')
  need(type(p['invocationIds']) is list and 0<len(p['invocationIds'])<=1000 and len(set(p['invocationIds']))==len(p['invocationIds']),'independent_scope')
  with module.control_scope(nonce,expected=actual['artifacts']['control']) as (fd,_,_):
   proofs=[]
   for invocation in p['invocationIds']:
    need(re.fullmatch(r'[a-f0-9]{32}-[0-9]{6}',invocation),'independent_invocation')
    raw,_=module.read_at(fd,'supervisor-'+invocation+'.json',0,limit=16384);mapping=json.loads(raw)
    need(mapping['nonce']==nonce and mapping['record_sha256']==p['recordSha256'],'independent_mapping')
    managed,_=module.invocation_file(fd,mapping['request_nonce'],mapping['role'],'binding')
    need(managed['record_sha256']==p['recordSha256'] and managed['request_nonce']==mapping['request_nonce'] and managed['role']==mapping['role'],'independent_binding')
    with module.ManagedCgroupProof(managed) as cgroup:need(module.terminal_empty(module.SystemdBackend(actual),actual,managed,cgroup),'independent_exit_unproven')
    proofs.append({'managedProtocol':1,'invocationId':invocation,'requestNonce':mapping['request_nonce'],'role':mapping['role'],
     'unit':managed['unit'],'nativeInvocationId':managed['invocation_id'],'controlGroup':managed['control_group'],'cgroupIdentity':managed['identity'],
     'recordSha256':p['recordSha256'],'instanceSha256':module.digest(module.canonical(managed)),'cgroupPopulated':0,'cgroupProcessCount':0})
  return {'challenge':p['challenge'],'identitySha256':p['identitySha256'],'proofs':proofs}
 if action in ('segmented-bootstrap','segmented-install','segmented-discard','segmented-final'):
  if action!='segmented-final':identity()
  helper,record=expiry_paths()
  if action=='segmented-bootstrap':
   for path in ['/var/lib/address-radar-preservation-expiry-tools',os.path.dirname(helper)]:rootdir(path)
   raw=base64.b64decode(p['expiryCode'],validate=True);need(digest(raw)==p['expiryHelperSha256'],'expiry_install_pin')
   if not os.path.exists(helper):put(helper,raw,0o400)
   pinned(helper,p['expiryHelperSha256']);immutable(helper,True)
  else:pinned(helper,p['expiryHelperSha256']);immutable(helper)
  import importlib.util
  specification=importlib.util.spec_from_file_location('radar_fixed_expiry_install',helper)
  module=importlib.util.module_from_spec(specification);specification.loader.exec_module(module)
  control='/var/lib/address-radar-rehearsal-artifact-control/'+nonce
  if action=='segmented-bootstrap':
   rootdir('/var/lib/address-radar-rehearsal-artifact-control');os.mkdir(control,0o700)
   put(control+'/owner',os.urandom(24).hex().encode());put(control+'/lock',os.urandom(24).hex().encode())
   os.mkdir(control+'/receipts',0o700)
  if action=='segmented-final':
   need(re.fullmatch(r'[a-f0-9]{64}',p['recordSha256']),'final_record_pin')
   result=json.loads(run(['/usr/bin/python3',helper,'cleanup','--nonce',nonce,'--record',record,'--expected-sha256',p['recordSha256'],'--final'],35))
   need(result.get('action')=='cleanup' and result.get('authority')=='final' and result.get('status')=='deleted' and result.get('private_pg',{}).get('status') in ('deleted','already-deleted') and result.get('artifacts',{}).get('status') in ('deleted','already-deleted'),'final_cleanup_status');return result
  with module.artifact_install_lease(nonce,work,control) as lease:
   if p['binding'].get('artifactControlInode') is not None:
    observed=os.lstat(control);lockinfo=os.fstat(lease.lock_fd)
    need([observed.st_dev,observed.st_ino]==[p['binding']['artifactControlDevice'],p['binding']['artifactControlInode']] and [lockinfo.st_dev,lockinfo.st_ino]==[p['binding']['artifactLockDevice'],p['binding']['artifactLockInode']],'install_control_changed')
   if action=='segmented-install':
    need(type(p['files']) is list and 0<len(p['files'])<=32,'install_batch')
    for item in p['files']:
     name=item['name'];need(re.fullmatch(r'(?:segmented-runner\.mjs|segmented-authority\.mjs|source-reader\.py|launch-segmented-postgres-preservation\.py|(?:calibrate|import|verify|finalize)-[a-f0-9]{16}\.json)',name),'install_name')
     raw=base64.b64decode(item['bytesBase64'],validate=True);need(len(raw)<=2097152 and digest(raw)==item['sha256'],'install_bytes_pin')
     fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=lease.root_fd)
     try:
      with os.fdopen(fd,'wb',closefd=False) as stream:stream.write(raw);stream.flush()
      os.fsync(fd)
     finally:os.close(fd)
    os.fsync(lease.root_fd)
   elif action=='segmented-discard':
    # Only this fresh, never-armed namespace's credential configs; retain all nonsecret evidence/code.
    for name in os.listdir(lease.root_fd):
     if re.fullmatch(r'(?:calibrate|import|verify|finalize)-[a-f0-9]{16}\.json',name):
      info=os.stat(name,dir_fd=lease.root_fd,follow_symlinks=False)
      need(stat.S_ISREG(info.st_mode) and info.st_uid==0 and info.st_nlink==1,'discard_kind');os.unlink(name,dir_fd=lease.root_fd)
    os.fsync(lease.root_fd)
   if action=='segmented-install' and p.get('prepared'):
    fd=os.open(control,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
     raw=json.dumps(p['prepared'],separators=(',',':'),sort_keys=True).encode();need(len(raw)<=1048576,'prepared_size')
     descriptor=os.open('prepared-configs.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
     try:
      with os.fdopen(descriptor,'wb',closefd=False) as stream:stream.write(raw);stream.flush()
      os.fsync(descriptor);os.fsync(fd)
     finally:os.close(descriptor)
    finally:os.close(fd)
  with module.control_scope(nonce,path=control) as (fd,lock,pin):
   receipt=os.stat('receipts',dir_fd=fd,follow_symlinks=False)
   return {'artifactControlRoot':control,'artifactControlDevice':pin['identity'][0],'artifactControlInode':pin['identity'][1],
    'artifactLockDevice':pin['lock_pin']['identity'][0],'artifactLockInode':pin['lock_pin']['identity'][1],
    'receiptDirectory':control+'/receipts','receiptDirectoryDevice':receipt.st_dev,'receiptDirectoryInode':receipt.st_ino}
 if action=='identity':return identity()
 if action in ('expiry-arm','expiry-verify','stage'):identity()
 if action=='verify-invocation-empty':
  need(re.fullmatch(r'[a-f0-9]{32}',p['challenge']),'proof_challenge')
  need(type(p['invocationIds']) is list and 0<len(p['invocationIds'])<=1000 and len(set(p['invocationIds']))==len(p['invocationIds']),'proof_ids')
  proofs=[invocation_empty(x) for x in p['invocationIds']]
  return {'challenge':p['challenge'],'identitySha256':p['identitySha256'],'proofs':proofs}
 if action in ('expiry-arm','expiry-verify'):
  helper,record=expiry_paths()
  if action=='expiry-arm':
   for path in ['/var/lib/address-radar-preservation-expiry-tools',os.path.dirname(helper),'/var/lib/address-radar-preservation-expiry',os.path.dirname(record)]:rootdir(path)
   code=base64.b64decode(p['expiryCode'],validate=True);need(digest(code)==p['expiryHelperSha256'],'expiry_code_pin')
   if not os.path.exists(helper):put(helper,code,0o400)
   pinned(helper,p['expiryHelperSha256']);immutable(helper,True)
   ttl=int((p['absoluteDeadlineAtMs']-time.time()*1000)//1000)-30;need(0<ttl<=10800,'expiry_ttl')
   argv=['/usr/bin/python3',helper,'arm','--nonce',nonce,'--record',record,'--ttl-seconds',str(ttl)]
   if p.get('artifactCodePins'):
    need(set(p['artifactCodePins'])=={'segmented-runner.mjs','segmented-authority.mjs','source-reader.py','launch-segmented-postgres-preservation.py'},'expiry_code_catalog')
    argv+=['--artifact-root',work,'--artifact-control','/var/lib/address-radar-rehearsal-artifact-control/'+nonce]
    for name,pin in sorted(p['artifactCodePins'].items()):
     need(re.fullmatch(r'[a-f0-9]{64}',pin),'expiry_artifact_code_hash');argv+=['--artifact-code-pin',name+'='+pin]
   receipt=json.loads(run(argv,30))
   need(receipt['status']=='armed' and re.fullmatch(r'[a-f0-9]{64}',receipt['record_sha256']),'expiry_arm_receipt');immutable(record,True)
   pin=receipt['record_sha256'];r=expiry_record(record,pin)
   delay=max(1,int(r['deadline']-time.time())+2)
   command=['/usr/bin/python3',helper,'cleanup','--nonce',nonce,'--record',record,'--expected-sha256',pin]
   name='address-radar-preservation-expiry-'+nonce
   run(['/usr/bin/systemd-run','--unit='+name,'--on-active='+str(delay)+'s','--timer-property=AccuracySec=1s','--property=Type=oneshot','--property=User=root','--property=TimeoutStartSec=240s','--property=Restart=no','--property=KillMode=control-group',*command])
   return {'recordSha256':pin,'timerSeconds':delay,'deadline':r['deadline']}
  pinned(helper,p['expiryHelperSha256']);immutable(helper)
  r=expiry_record(record,p['recordSha256'])
  command=['/usr/bin/python3',helper,'cleanup','--nonce',nonce,'--record',record,'--expected-sha256',p['recordSha256']]
  fire=timer_verify('address-radar-preservation-expiry-'+nonce,command,p['timerSeconds'],240)
  remaining=fire-time.monotonic();need(0<remaining and time.time()*1000+remaining*1000<=p['absoluteDeadlineAtMs'],'expiry_timer_bound')
  check=json.loads(run(['/usr/bin/python3',helper,'check','--nonce',nonce,'--record',record,'--expected-sha256',p['recordSha256']],30))
  need(check['action']=='check' and check['status']=='retained' and check['postmaster_live'] is True and check['record_sha256']==p['recordSha256'] and check['deadline']==r['deadline'],'expiry_check')
  return {'deadline':r['deadline'],'recordSha256':p['recordSha256']}
 if action in ('capture','maintenance-arm','pause','restore'):
  n=p['maintenanceNonce'];need(re.fullmatch(r'[a-f0-9]{16}',n),'maintenance_nonce');pinned(MAINT,MAINT_HASH)
  directory='/var/lib/address-radar-maintenance/'+n;pin=p.get('baselineSha256')
  if action=='capture':
   receipt=json.loads(run(['/usr/bin/python3',MAINT,'capture','--nonce',n],min(50,p['operationSeconds'])))
   need(receipt['status']=='captured' and receipt['nonce']==n and re.fullmatch(r'[a-f0-9]{64}',receipt['baselineSha256']),'capture_receipt')
   pinned(directory+'/helper.py',MAINT_HASH)
   baseline=read(directory+'/baseline.json',0,131072,0o600);need(digest(baseline)==receipt['baselineSha256'],'baseline_pin')
   return {'baselineSha256':receipt['baselineSha256']}
  if action=='restore' and pin is None:
   if not os.path.lexists(directory):return {'status':'restored'}
   protected(directory)
   # No guessed retry or phase transition after an uncertain capture.
   baseline=read(directory+'/baseline.json',0,131072,0o600);pin=digest(baseline)
  need(re.fullmatch(r'[a-f0-9]{64}',pin or ''),'maintenance_baseline');pinned(directory+'/helper.py',MAINT_HASH)
  raw=read(directory+'/baseline.json',0,131072,0o600);need(digest(raw)==pin,'maintenance_baseline_pin');baseline=json.loads(raw)
  need(baseline['nonce']==n and baseline['helperSha256']==MAINT_HASH,'maintenance_baseline_scope')
  command=['/usr/bin/python3',directory+'/helper.py','restore','--nonce',n,'--baseline-sha256',pin,'--watchdog']
  if action=='maintenance-arm':
   argv=['/usr/bin/systemd-run','--unit=address-radar-maintenance-'+n,'--on-active=55min','--timer-property=AccuracySec=1s','--property=Type=oneshot','--property=User=root','--property=TimeoutStartSec=240s','--property=Restart=no','--property=KillMode=control-group',*command]
   run(argv);fire=timer_verify('address-radar-maintenance-'+n,command,3300,240)
   need(baseline['capturedMonotonicUs']/1000000<=fire-3300<=baseline['capturedMonotonicUs']/1000000+60 and fire+240<=baseline['deadlineMonotonicUs']/1000000,'maintenance_timer_bound')
   return {'baselineSha256':pin}
  argv=['/usr/bin/python3',MAINT,action,'--nonce',n,'--baseline-sha256',pin]
  if action in ('pause','restore'):
   if action=='restore' and p.get('pauseInvocationId'):invocation_empty(p['pauseInvocationId'])
   invocation=p['invocationId'];unit,recordPath,startedPath=invocation_names(invocation)
   control=os.path.dirname(os.path.dirname(recordPath));protected(control)
   info=os.lstat(control);need([info.st_dev,info.st_ino]==[p['binding']['artifactControlDevice'],p['binding']['artifactControlInode']],'pause_control_identity')
   rootdir(os.path.dirname(recordPath))
   output=os.path.dirname(recordPath)+'/'+invocation+'-pause.json';put(output,b'')
   argv=['/usr/bin/ionice','-c','3','/usr/bin/nice','-n','19',*argv]
   record={'version':1,'nonce':nonce,'maintenanceAction':action,'maintenanceNonce':n,'invocationId':invocation,'unit':unit,'identitySha256':p['identitySha256'],'root':root,'owner':p['binding']['owner'],'connectionSha256':p['binding']['connectionSha256'],'commandSha256':digest(' '.join(argv).encode())}
   raw=json.dumps(record,sort_keys=True,separators=(',',':')).encode();put(recordPath,raw)
   need(operationDeadlineMono-time.monotonic()>=(450 if action=='pause' else 20),'maintenance_dispatch_budget')
   runtime=450 if action=='pause' else 270
   need(time.monotonic()+runtime+20+(280 if action=='pause' else 40)<=baseline['capturedMonotonicUs']/1000000+3300,'maintenance_watchdog_budget')
   run(['/usr/bin/systemd-run','--unit='+unit[:-8],'--property=Type=exec','--property=User=root','--property=KillMode=control-group','--property=TimeoutStopSec=5s','--property=RuntimeMaxSec='+str(runtime)+'s','--property=RemainAfterExit=yes','--property=StandardOutput=append:'+output,'--property=StandardError=null',*argv])
   observed=invocation_props(record);cg='/sys/fs/cgroup'+observed['ControlGroup']
   need(observed['ControlGroup']=='/system.slice/'+unit and os.path.realpath(cg)==cg,'pause_cgroup')
   info=os.lstat(cg);need(info.st_uid==0 and stat.S_ISDIR(info.st_mode),'pause_cgroup_owner')
   instance={'recordSha256':digest(raw),'startMonotonicUs':observed['ExecMainStartTimestampMonotonic'],'nativeInvocationId':observed['InvocationID'],'cgroupIdentity':[info.st_dev,info.st_ino]}
   put(startedPath,json.dumps(instance,sort_keys=True,separators=(',',':')).encode())
   # The managed unit outlives controller/SSH failure. RuntimeMaxSec covers native nested restoration.
   # Never stop this unit from controller finally or signal a numeric PID/PGID.
   while True:
    observed=invocation_props(record,instance);populated,pids=cgroup_status(record,instance,observed)
    if observed['SubState'] in ('exited','dead','failed'):
     need(observed['Result']=='success' and populated==0 and not pids,'pause_failed');break
    need(time.monotonic()<operationDeadlineMono-12,'pause_deadline');time.sleep(.2)
   invocation_empty(invocation)
   receipt=json.loads(read(output,0,262144,0o600));need(receipt.get('status')=='restored' if action=='restore' else receipt.get('phase')=='paused','maintenance_receipt')
   return receipt
 need(action=='stage' and p['stage'] in ('calibrate','import','parity'),'action')
 for path in ['/var/lib/address-radar-rehearsal-artifacts',work,work+'/evidence']:rootdir(path)
 for name,key in [('runner.mjs','runner'),('source-reader.py','sourceReader')]:
  raw=base64.b64decode(p[key],validate=True);need(digest(raw)==p[key+'Sha256'],'stage_code_pin');path=work+'/'+name
  if not os.path.exists(path):put(path,raw,0o400)
  pinned(path,p[key+'Sha256'])
 invocation=p['invocationId'];need(re.fullmatch(r'[a-f0-9]{32}-[0-9]{6}',invocation),'invocation')
 stage=p['stage'];config=base64.b64decode(p['config'],validate=True);authority=base64.b64decode(p['authority'],validate=True)
 need(digest(config)==p['configSha256'] and digest(authority)==p['authoritySha256'],'stage_record_pin')
 c=json.loads(config);a=json.loads(authority)
 need(c['bundleDirectory']==ROOT_SOURCE and c['evidenceDirectory']==work+'/evidence' and c['storagePath']==root+'/data' and c['authorityModule']==work+'/runner.mjs' and c['authorityModuleSha256']==p['runnerSha256'] and c['sourceReaderSha256']==p['sourceReaderSha256'] and a['password']==connection['password'] and a['target']==c['target'],'stage_scope')
 configPath=work+'/'+invocation+'-config.json';authPath=work+'/'+invocation+'-authority.json';output=work+'/'+invocation+'-stdout.json'
 put(configPath,config);put(authPath,authority)
 reportPath=work+'/evidence/'+stage+'-'+invocation+'.json';need(not os.path.lexists(reportPath),'evidence_exclusive')
 fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);os.close(fd)
 started=time.monotonic();peak=0;minMem=2**63-1;minDisk=2**63-1;maxPsi=0.;reason=None
 deadline=min(p['deadlineAtMs']/1000,time.time()+(180 if stage=='calibrate' else 900))-12
 need(deadline>time.time() and operationDeadlineMono-time.monotonic()>20,'stage_budget')
 argv=['/usr/bin/ionice','-c','3','/usr/bin/nice','-n','19','/usr/local/bin/node','--max-old-space-size=96','--expose-gc',work+'/runner.mjs',stage,configPath,p['configSha256'],authPath,p['authoritySha256']]
 unit,recordPath,startedPath=invocation_names(invocation)
 protected(os.path.dirname(os.path.dirname(recordPath)));rootdir(os.path.dirname(recordPath))
 record={'version':1,'nonce':nonce,'invocationId':invocation,'unit':unit,'identitySha256':p['identitySha256'],'root':root,'owner':p['binding']['owner'],'connectionSha256':p['binding']['connectionSha256'],'commandSha256':digest(' '.join(argv).encode()),'runnerSha256':p['runnerSha256'],'sourceReaderSha256':p['sourceReaderSha256'],'configSha256':p['configSha256'],'authoritySha256':p['authoritySha256']}
 recordRaw=json.dumps(record,sort_keys=True,separators=(',',':')).encode();put(recordPath,recordRaw)
 runtime=max(1,int(operationDeadlineMono-time.monotonic())-12)
 run(['/usr/bin/systemd-run','--unit='+unit[:-8],'--property=Type=exec','--property=User=root','--property=KillMode=control-group','--property=TimeoutStopSec=5s','--property=RuntimeMaxSec='+str(runtime)+'s','--property=MemoryMax=268435456','--property=TasksMax=16','--property=RemainAfterExit=yes','--property=StandardOutput=append:'+output,'--property=StandardError=null','--setenv=PATH=/usr/bin:/bin','--setenv=LC_ALL=C','--setenv=PRESERVATION_INVOCATION_ID='+invocation,*argv])
 initial=invocation_props(record);cg='/sys/fs/cgroup'+initial['ControlGroup']
 need(initial['ControlGroup']=='/system.slice/'+unit and os.path.realpath(cg)==cg,'initial_cgroup')
 info=os.lstat(cg);need(stat.S_ISDIR(info.st_mode) and info.st_uid==0,'initial_cgroup_owner')
 instance={'recordSha256':digest(recordRaw),'startMonotonicUs':initial['ExecMainStartTimestampMonotonic'],'nativeInvocationId':initial['InvocationID'],'cgroupIdentity':[info.st_dev,info.st_ino]}
 put(startedPath,json.dumps(instance,sort_keys=True,separators=(',',':')).encode());child=invocation
 while True:
  state=invocation_props(record,instance);populated,pids=cgroup_status(record,instance,state)
  if state['SubState'] in ('exited','dead','failed'):
   need(state['Result']=='success' and populated==0,'stage_unit_failed');break
  need(state['ActiveState']=='active' and state['SubState']=='running','stage_unit_state')
  mem=int(next(line for line in open('/proc/meminfo') if line.startswith('MemAvailable:')).split()[1])*1024
  space=os.statvfs(root);disk=space.f_bavail*space.f_frsize
  psi=float(re.search(r'^some avg10=([0-9.]+)',open('/proc/pressure/memory').read(),re.M)[1]);rss=0
  for pid in pids:
   try:
    text=open('/proc/'+str(pid)+'/status').read(65536);match=re.search(r'^VmRSS:[ '+chr(9)+r']+([0-9]+)',text,re.M)
    need(match,'rss_unknown');rss+=int(match[1])*1024
   except FileNotFoundError:pass
  peak=max(peak,rss);minMem=min(minMem,mem);minDisk=min(minDisk,disk);maxPsi=max(maxPsi,psi)
  if mem<1024**3:reason='external_memory_reserve'
  elif disk<5*1024**3:reason='external_disk_reserve'
  elif rss>256*1024**2:reason='external_rss_limit'
  elif psi>1:reason='external_psi_limit'
  elif time.time()>=deadline or time.monotonic()>=operationDeadlineMono-12:reason='external_deadline'
  if reason:break
  time.sleep(.2)
 stop_child();exitCode=-1 if reason else 0
 need(exitCode==0 and reason is None,'stage_failed_reconcile_before_retry')
 raw=read(reportPath,0,262144,0o600);report=json.loads(raw)
 identity();pinned(work+'/runner.mjs',p['runnerSha256']);pinned(work+'/source-reader.py',p['sourceReaderSha256'])
 return {'stage':stage,'invocationId':invocation,'identitySha256':p['identitySha256'],'target':c['target'],'expected':c['expected'],'runnerSha256':p['runnerSha256'],'sourceReaderSha256':p['sourceReaderSha256'],'configSha256':p['configSha256'],'authoritySha256':p['authoritySha256'],'reportSha256':digest(raw),'report':report,'exitCode':exitCode,'reason':reason,'elapsedMs':int((time.monotonic()-started)*1000),'externalPeakRssBytes':peak,'minimumAvailableMemoryBytes':minMem,'minimumFreeBytes':minDisk,'maximumMemoryPsiAvg10':maxPsi}
try:
 value=execute();print(json.dumps({'ok':True,'value':value},separators=(',',':')))
except BaseException as error:
 safe={'not_immutable','source_manifest_pin','source_operation','source_manifest_context','read_kind','protected_owner'}
 code=str(error) if type(error) is RuntimeError and str(error) in safe else 'fixed-operation-refused'
 print(json.dumps({'ok':False,'reason':'fixed-operation-refused','code':code},separators=(',',':')))
finally:
 stop_child()
`;

async function privateFile(path, maximum = 2 * 1024 ** 2) {
  gate(typeof path === "string" && resolve(path) === path, "local_path");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    gate(before.isFile() && before.uid === BigInt(process.getuid()) && (before.mode & 0o077n) === 0n && before.size <= BigInt(maximum) && before.nlink === 1n, "local_file");
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true });
    gate(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && bytes.length <= maximum, "local_file_race");
    return bytes;
  } finally { await handle.close(); }
}

export function authenticateInvocationEmptyProof(proof, request) {
 gate(proof?.challenge === request.challenge && proof.identitySha256 === request.identitySha256 &&
   Array.isArray(proof.proofs) && proof.proofs.length === request.invocationIds.length, "producer_exit_unproven");
 for (let index=0; index<request.invocationIds.length; index++) {
  const id=request.invocationIds[index], item=proof.proofs[index];
  gate(/^[a-f0-9]{32}-[0-9]{6}$/.test(id) && item?.invocationId===id &&
    item.unit==="address-radar-preservation-invocation-"+request.nonce+"-"+id+".service" &&
    hash(item.recordSha256) && hash(item.instanceSha256) && item.cgroupPopulated===0 && item.cgroupProcessCount===0,
    "producer_exit_unproven");
 }
 return proof;
}

export function authenticateStageReceipt(receipt, work, state) {
  const report = receipt?.report;
  gate(receipt?.stage === work.stage && receipt.invocationId === work.invocationId && receipt.identitySha256 === work.identitySha256 && same(receipt.target, state.target) && same(receipt.expected, fixedPins), "stage_lineage");
  for (const key of ["runnerSha256", "sourceReaderSha256", "configSha256", "authoritySha256"]) gate(receipt[key] === state[key], "stage_code_pin");
  gate(hash(receipt.reportSha256) && receipt.exitCode === 0 && !receipt.reason && count(receipt.elapsedMs, work.stage === "calibrate" ? 180000 : 900000), "stage_exit");
  gate(count(receipt.externalPeakRssBytes, 256 * 1024 ** 2) && receipt.minimumAvailableMemoryBytes >= 1024 ** 3 && receipt.minimumFreeBytes >= 5 * 1024 ** 3 && Number.isFinite(receipt.maximumMemoryPsiAvg10) && receipt.maximumMemoryPsiAvg10 >= 0 && receipt.maximumMemoryPsiAvg10 <= 1, "stage_resources");
  const native = report?.nativeMetrics;
  gate(native && [native.physicalSqlStatements, native.commitAttempts, native.acknowledgedCommits, native.acknowledgedRollbacks].every(x => count(x, 1000000)) && native.commitAttempts === native.acknowledgedCommits && !report.failure?.commitUncertaintyObserved && report.productionAuthorized === false && report.sourceReader?.freshHash === true && report.sourceReader.cachedWitnessUsed === false, "native_receipt");
  if (work.stage === "calibrate") {
    gate(report.status === "calibrated" && report.manifestSha256 === fixedPins.manifestSha256 && report.file === "table-0044-chunk-000000.json" && report.bytes === 16775058 && report.rows === 2842 && report.sha256 === "1328e4403d467c4aa7f7ef4cee43a85ea59347263caf0250b4f76be36fb6f8b3" && report.proofSha256 === report.sha256 && report.rollbackObserved === true && native.physicalSqlStatements === 162 && native.acknowledgedRollbacks === 1 && count(report.measuredPeakRssBytes, 256 * 1024 ** 2) && report.measuredPeakRssBytes > 0 && report.maximumRssBytes === 256 * 1024 ** 2, "calibration_receipt");
    return { ...receipt, sourcePins: fixedPins };
  }
  gate(report.stage === work.stage && same(report.expected, fixedPins) && same(report.target, state.target) && report.sourceWrites === false && report.businessActivation === false && report.grantsBusinessEligibility === false, "native_lineage");
  const progress = report.progress;
  gate(progress && [progress.previouslyCommittedChunks, progress.newlyCommittedChunks, progress.resumedChunks, progress.parityChunks].every(x => count(x, fixedPins.chunks)) && count(progress.newlyCommittedRows, fixedPins.rows), "progress_bounds");
  gate(progress.previouslyCommittedChunks === report.previouslyCommittedChunks, "prior_accounting");
  const prior = progress.previouslyCommittedChunks, added = progress.newlyCommittedChunks;
  gate(prior + added <= fixedPins.chunks && progress.resumedChunks <= prior && added <= native.acknowledgedCommits, "durable_accounting");
  const fresh = report.sourceReader.files >= fixedPins.chunks + 1 && (work.stage === "parity" ? report.status === "completed" : count(progress.sourceVerifiedAtMs) && progress.sourceVerifiedAtMs > 0);
  const reconciled = work.stage === "parity" ? report.status === "completed" && progress.parityChunks === fixedPins.chunks : progress.resumedChunks === prior;
  if (work.stage === "import") {
    gate(["yielded_before_transaction", "import_completed_pending_parity"].includes(report.status) && report.parityComplete === false && fresh, "import_receipt");
    if (report.status === "import_completed_pending_parity") gate(prior + added === fixedPins.chunks && reconciled, "import_incomplete");
  } else {
    gate(report.status === "completed" && report.parityComplete === true && fresh && reconciled && progress.parityRows === fixedPins.rows && report.typedBytes?.rows === fixedPins.rows && report.typedBytes.chunks === fixedPins.chunks, "parity_receipt");
  }
  return { ...receipt, sourcePins: fixedPins, durableChunks: prior + added, freshSourceValidationComplete: fresh, durableBodyReconciliationComplete: reconciled,
    ...(work.stage === "parity" ? { parityCounts: { tables: report.expected.tables, rows: report.typedBytes.rows, chunks: report.typedBytes.chunks } } : {}) };
}

/** Dependencies exist for local deterministic tests; production factory pins all artifacts. */
export function buildHostAdapter(files, { transport = createFixedTransport(), readConnection = privateFile, fingerprint = (schema) => spawnSync(process.execPath, ["/private/tmp/radar-preservation-fingerprint.mjs", schema], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }), clock = Date.now, monotonic = () => performance.now(), persist = async () => {} } = {}) {
  let bound, target, connection, expiry;
  const windows = new Map(), invocations = new Set();
  const dispatch = async (ctx, action, request, extra = {}, maximumMs = 45000) => {
    gate(ctx.nonce === bound?.nonce || (action === "identity" || action === "bind"), "context");
    const deadlineAtMs = request.deadlineAtMs ?? clock() + maximumMs;
    const budget = Math.min(maximumMs, deadlineAtMs - clock(), request.timeoutMs ?? Infinity,
      request.monotonicDeadlineAtMs === undefined ? Infinity : request.monotonicDeadlineAtMs - monotonic()); gate(count(Math.floor(budget)) && budget > 1000, "operation_budget");
    return transport({ nonce: ctx.nonce, systemIdentifier: ctx.systemIdentifier, binding: bound, action, deadlineAtMs,
      operationSeconds: Math.max(1, Math.floor((budget - 1000) / 1000)), ...extra }, Math.floor(budget), { signal: request.signal });
  };
  const probeInvocations = async (ctx, request, ids) => {
    try {
      const challenge = request.challenge ?? randomBytes(16).toString("hex");
      const raw = await dispatch(ctx, "verify-invocation-empty", request, { invocationIds: ids, challenge,
        identitySha256: request.identitySha256 }, 30000);
      return authenticateInvocationEmptyProof(raw, { nonce: ctx.nonce, identitySha256: request.identitySha256, invocationIds: ids, challenge });
    } catch { throw new Error("preservation_host_watchdog_handoff_producer_exit_unproven"); }
  };
  const window = request => {
    gate(/^[a-f0-9]{16}$/.test(request.windowNonce), "window_nonce");
    const maintenanceNonce = request.windowNonce;
    let state = windows.get(request.windowNonce);
    if (!state) {
      gate(![...windows.values()].some(x => x.maintenanceNonce === maintenanceNonce), "window_collision");
      state = { maintenanceNonce, captured: false, captureAttempted: false, armAttempted: false, pauseAttempted: false, restored: false }; windows.set(request.windowNonce, state);
    }
    return state;
  };
  return {
    async bind(ctx) {
      gate(!bound && /^[a-f0-9]{16}$/.test(ctx.nonce) && ctx.database === "radar_rehearsal_" + ctx.nonce && ctx.schema === ctx.database + "_schema" && ctx.role === ctx.database + "_migrator" && /^[0-9]{1,20}$/.test(ctx.systemIdentifier), "fixture_context");
      const raw = await readConnection(ctx.connectionPath, 16384); connection = JSON.parse(raw);
      gate(connection.nonce === ctx.nonce && connection.database === ctx.database && connection.schema === ctx.schema && connection.username === ctx.role && connection.systemIdentifier === ctx.systemIdentifier && connection.host === "127.0.0.1" && connection.port === 5434 && /^[a-f0-9]{64}$/.test(connection.password), "connection");
      const native = await dispatch(ctx, "bind", {}, {}, 30000);
      gate(native.connectionSha256 === sha(raw) && /^[a-f0-9]{48}$/.test(native.owner) && [native.directoryDevice, native.directoryInode, native.dataDevice, native.dataInode, native.postmasterPid, native.postmasterEpoch].every(x => count(x)) && native.postmasterPid > 1 && /^[1-9][0-9]*$/.test(native.postmasterStart), "identity_receipt");
      gate(native.artifactRoot === "/var/lib/address-radar-rehearsal-artifacts/" + ctx.nonce && /^[a-f0-9]{48}$/.test(native.artifactOwner) && count(native.artifactDevice) && count(native.artifactInode), "artifact_binding");
      const ddl = await fingerprint(ctx.schema); gate(ddl.status === 0 && hash(ddl.stdout?.trim()), "fingerprint");
      target = Object.freeze({ database: ctx.database, schema: ctx.schema, username: ctx.role, serverAddress: "127.0.0.1", serverPort: 5434, systemIdentifier: ctx.systemIdentifier, schemaVersion: 1, schemaFingerprint: ddl.stdout.trim(), generation: "preservation-" + ctx.nonce, service: "migration-preservation" });
      bound = Object.freeze({ nonce: ctx.nonce, root: "/tmp/" + ctx.database, database: ctx.database, schema: ctx.schema, role: ctx.role, systemIdentifier: ctx.systemIdentifier, ...native,
        connectionSha256: sha(raw), schemaFingerprint: target.schemaFingerprint, runnerSha256: sha(files.runner), sourceReaderSha256: sha(files.sourceReader), expiryHelperSha256: sha(files.expiry), lifecycleSha256, maintenanceHelperPath: fixedMaintenance });
      await persist({ action: "binding", binding: bound, target }); return bound;
    },
    async bindArtifactControl(context, additions) {
      gate(bound && context.nonce === bound.nonce && !bound.artifactControlRoot, "control_binding_state");
      const keys = ["artifactControlRoot", "artifactControlDevice", "artifactControlInode", "artifactLockDevice", "artifactLockInode",
        "receiptDirectory", "receiptDirectoryDevice", "receiptDirectoryInode", "registeredCodePins"];
      gate(keys.every(key => Object.hasOwn(additions, key)) && Object.keys(additions).length === keys.length &&
        additions.artifactControlRoot === "/var/lib/address-radar-rehearsal-artifact-control/" + context.nonce &&
        additions.receiptDirectory === additions.artifactControlRoot + "/receipts" &&
        keys.filter(key => key.endsWith("Device") || key.endsWith("Inode")).every(key => count(additions[key])) &&
        Object.keys(additions.registeredCodePins).sort().join(",") === ["segmented-runner.mjs", "segmented-authority.mjs", "source-reader.py", "launch-segmented-postgres-preservation.py"].sort().join(",") &&
        Object.values(additions.registeredCodePins).every(hash), "control_binding");
      bound = Object.freeze({ ...bound, ...structuredClone(additions) });
    },
    async verifyIdentity(ctx, request) {
      const actual = await dispatch(ctx, "identity", request);
      gate(Object.entries(actual).every(([key, value]) => bound[key] === value), "identity_changed"); return bound;
    },
    async armExpiry(ctx, request) {
      // The current PG-only expiry API cannot safely own credential artifact cleanup.
      // Parent must approve the exact Euclid record/check/cleanup extension first.
      gate(request.artifactCodePins && bound.artifactControlRoot, "expiry_artifact_protocol_pending");
      gate(!expiry, "expiry_rearm");
      const proof = await dispatch(ctx, "expiry-arm", request, { ...request, expiryHelperSha256: bound.expiryHelperSha256, expiryCode: files.expiry.toString("base64") }, 60000);
      gate(hash(proof.recordSha256) && count(proof.timerSeconds, 10800) && proof.timerSeconds > 0 && count(proof.deadline) && proof.deadline * 1000 <= request.absoluteDeadlineAtMs, "expiry_arm");
      expiry = proof; await persist({ action: "expiry", ...proof });
    },
    async verifyExpiry(ctx, request) {
      gate(expiry, "expiry_unarmed");
      const proof = await dispatch(ctx, "expiry-verify", request, { ...request, ...expiry, expiryHelperSha256: bound.expiryHelperSha256 }, 45000);
      gate(proof.recordSha256 === expiry.recordSha256 && proof.deadline === expiry.deadline && proof.deadline * 1000 > clock(), "expiry_receipt");
      return { rootOwned: true, immutable: true, independent: true, armed: true, identitySha256: request.identitySha256, helperSha256: bound.expiryHelperSha256, expiresAtMs: proof.deadline * 1000, recordSha256: proof.recordSha256 };
    },
    async capture(ctx, request) {
      const state = window(request); gate(!state.captureAttempted, "capture_retry_forbidden"); state.captureAttempted = true; state.capturedAtMs = clock(); state.capturedMono = monotonic();
      const proof = await dispatch(ctx, "capture", { ...request, deadlineAtMs: Math.min(request.deadlineAtMs, clock() + 55000) }, state, 55000);
      gate(hash(proof.baselineSha256), "capture_pin"); state.baselineSha256 = proof.baselineSha256; state.captured = true;
      await persist({ action: "window-binding", windowNonce: request.windowNonce, maintenanceNonce: state.maintenanceNonce, baselineSha256: proof.baselineSha256 });
      return { nonce: request.windowNonce, baselineSha256: proof.baselineSha256 };
    },
    async armMaintenance(ctx, request) {
      const state = window(request); gate(state.captured && !state.armAttempted && request.baselineSha256 === state.baselineSha256 && clock() - state.capturedAtMs < 60000 && monotonic() - state.capturedMono < 60000, "maintenance_arm_state"); state.armAttempted = true;
      const proof = await dispatch(ctx, "maintenance-arm", { ...request, deadlineAtMs: state.capturedAtMs + 60000 }, state, 30000);
      gate(proof.baselineSha256 === state.baselineSha256, "maintenance_arm_pin"); state.armed = true;
      return { verified: true, nonce: request.windowNonce, baselineSha256: proof.baselineSha256, watchdogMs: 3300000, restoreTimeoutMs: 240000 };
    },
    async pause(ctx, request) {
      const state = window(request); gate(state.armed && !state.pauseAttempted && !state.restored && clock() - state.capturedAtMs < 60000 && monotonic() - state.capturedMono < 60000, "pause_state");
      const beganAtMs = clock(), beganMono = monotonic();
      const durationMs = Math.floor(Math.min(470000, state.capturedAtMs + 55 * 60000 - beganAtMs - 240000 - 40000,
        state.capturedMono + 55 * 60000 - beganMono - 240000 - 40000, request.deadlineAtMs - beganAtMs,
        request.monotonicDeadlineAtMs - beganMono, request.timeoutMs,
        request.expiresAtMs - beganAtMs - 240000 - 40000));
      gate(durationMs >= 465000, "pause_budget"); state.pauseAttempted = true;
      gate(/^[a-f0-9]{32}$/.test(request.sessionId) && count(request.windowIndex, 99999), "pause_invocation");
      state.pauseInvocationId = request.sessionId + "-" + String(900000 + request.windowIndex).padStart(6, "0");
      const proof = await dispatch(ctx, "pause", { ...request, deadlineAtMs: beganAtMs + durationMs,
        monotonicDeadlineAtMs: beganMono + durationMs, timeoutMs: durationMs }, { ...state, invocationId: state.pauseInvocationId, identitySha256: request.identitySha256 }, 470000);
      gate(clock() <= beganAtMs + durationMs && monotonic() <= beganMono + durationMs, "pause_overrun");
      gate(proof.phase === "paused", "pause_receipt"); state.paused = true; return { phase: "paused" };
    },
    async verifyMaintenanceExit(ctx, request) {
      const state = window(request); gate(state.pauseAttempted && state.pauseInvocationId, "pause_exit_scope");
      const proof = await probeInvocations(ctx, request, [state.pauseInvocationId]);
      gate(proof.proofs.every(item => item.jobsSettled === true), "maintenance_jobs_unsettled"); state.pauseExitVerified = true;
      return { status: "empty", nonce: request.windowNonce, challenge: request.challenge, identitySha256: request.identitySha256 };
    },
    async verifyInvocationEmpty(ctx, request) { return probeInvocations(ctx, request, request.invocationIds); },
    async restore(ctx, request) {
      const state = window(request);
      gate(!state.pauseAttempted || state.pauseExitVerified, "pause_exit_unproven");
      if (state.invocationIds?.length) await probeInvocations(ctx, request, state.invocationIds); gate(!state.restoreAttempted, "restore_retry_forbidden"); state.restoreAttempted = true;
      gate(/^[a-f0-9]{32}$/.test(request.sessionId), "restore_invocation");
      const invocationId = request.sessionId + "-" + String(800000 + request.windowIndex).padStart(6, "0");
      const proof = await dispatch(ctx, "restore", request, { ...state, invocationId, identitySha256: request.identitySha256 }, 240000);
      gate(proof.status === "restored", "restore_receipt"); state.restored = true; state.paused = false;
      await persist({ action: "restored", windowNonce: request.windowNonce }); return { status: "restored", nonce: request.windowNonce };
    },
    async runStage(ctx, work) {
      const state = window(work); gate(state.paused && !state.restored && expiry, "stage_window");
      gate(["calibrate", "import", "parity"].includes(work.stage) && /^[a-f0-9]{32}-[0-9]{6}$/.test(work.invocationId) && !invocations.has(work.invocationId), "stage_invocation"); invocations.add(work.invocationId);
      gate(work.configName === work.invocationId + "-config.json" && work.authorityName === work.invocationId + "-authority.json" && work.outputName === work.invocationId + "-stdout.json" && work.evidenceName === work.stage + "-" + work.invocationId + ".json" && work.environment?.PRESERVATION_INVOCATION_ID === work.invocationId, "stage_names");
      const maximumMs = work.stage === "calibrate" ? 180000 : 900000;
      const deadlineAtMs = Math.min(work.deadlineAtMs, clock() + maximumMs); gate(deadlineAtMs > clock() + 20000, "stage_budget");
      const base = "/var/lib/address-radar-rehearsal-artifacts/" + ctx.nonce;
      const config = { sourceReaderSha256: bound.sourceReaderSha256, version: 1, stage: work.stage === "calibrate" ? "interrupt" : work.stage,
        bundleDirectory: "/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle", evidenceDirectory: base + "/evidence", storagePath: bound.root + "/data", authorityModule: base + "/runner.mjs", authorityModuleSha256: bound.runnerSha256,
        approvalRef: "human-backup-derived-isolated-20261004", deadlineAtMs: deadlineAtMs - 15000, expected: fixedPins, target,
        resources: { reserveBytes: 5 * 1024 ** 3, maximumTargetGrowthBytes: 20 * 1024 ** 3, minimumAvailableMemoryBytes: 1024 ** 3, maximumRssBytes: 256 * 1024 ** 2, maximumMemoryPsiAvg10: 1, maximumResidentChunkBytes: 16775058 },
        maximumTotalQueries: 1000000, maximumTransactionMs: 60000, maximumQueriesPerTransaction: 10000, interruptAfterCommittedChunks: 2 };
      const configBytes = Buffer.from(JSON.stringify(config));
      const authorityBytes = Buffer.from(JSON.stringify({ version: 1, scope: "backup-derived-preservation-rehearsal", target, approvalRef: config.approvalRef, expiresAtMs: config.deadlineAtMs, password: connection.password }));
      const pins = { target, runnerSha256: bound.runnerSha256, sourceReaderSha256: bound.sourceReaderSha256, configSha256: sha(configBytes), authoritySha256: sha(authorityBytes) };
      state.invocationIds ??= []; state.invocationIds.push(work.invocationId);
      const raw = await dispatch(ctx, "stage", { ...work, deadlineAtMs }, { invocationId: work.invocationId, identitySha256: work.identitySha256, stage: work.stage, ...pins,
        runner: files.runner.toString("base64"), sourceReader: files.sourceReader.toString("base64"), config: configBytes.toString("base64"), authority: authorityBytes.toString("base64") }, maximumMs);
      const receipt = authenticateStageReceipt(raw, work, pins);
      await persist({ action: "stage", invocationId: work.invocationId, status: receipt.report.status, reportSha256: receipt.reportSha256, configSha256: pins.configSha256, authoritySha256: pins.authoritySha256, durableChunks: receipt.durableChunks, durableBodyReconciliationComplete: receipt.durableBodyReconciliationComplete, nativeMetrics: receipt.report.nativeMetrics });
      return receipt;
    },
    record: persist,
  };
}

export async function createStagedPreservationPorts({ sourcePins, maintenanceHelperPath }) {
  gate(same(sourcePins, fixedPins) && maintenanceHelperPath === fixedMaintenance, "fixed_scope");
  const pinPath = process.env.PRESERVATION_HOST_CODE_PINS_PATH;
  gate(pinPath, "code_pins_required"); const pins = JSON.parse(await privateFile(pinPath, 16384));
  const paths = { runner: "/private/tmp/radar-private-preservation-runner.mjs", sourceReader: resolve(import.meta.dirname, "preservation-source-reader.py"), fingerprint: "/private/tmp/radar-preservation-fingerprint.mjs", expiry: resolve(import.meta.dirname, "preservation-fixture-expiry.py") };
  const files = {};
  for (const [name, path] of Object.entries(paths)) {
    gate(hash(pins[name + "Sha256"]), "code_pin_required");
    // Checked-in source files may be readable; their externally supplied pin is mandatory.
    const info = await lstat(path); gate(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o022), "code_kind");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { files[name] = await handle.readFile(); } finally { await handle.close(); }
    gate(files[name].length <= 2 * 1024 ** 2 && sha(files[name]) === pins[name + "Sha256"], "code_pin");
  }
  const evidence = process.env.PRESERVATION_HOST_EVIDENCE_DIRECTORY;
  gate(evidence && resolve(evidence) === evidence, "evidence_directory_required");
  await mkdir(evidence, { mode: 0o700 });
  let sequence = 0;
  const persist = receipt => writeFile(join(evidence, String(++sequence).padStart(6, "0") + ".json"), JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  const base=buildHostAdapter(files,{persist});
  if(process.env.PRESERVATION_PROTOCOL_VERSION===undefined)return base;
  gate(process.env.PRESERVATION_PROTOCOL_VERSION==="2","protocol_version");
  const nativeRunnerSha256=pins.segmentedRunnerSha256;
  gate(hash(nativeRunnerSha256) && hash(pins.launcherSha256),"segmented_factory_pins");
  const nativeRunnerPath="/private/tmp/radar-segmented-preservation-runner-"+nativeRunnerSha256+".mjs";
  files.segmentedRunner=await privateFile(nativeRunnerPath,2097152);
  const launcherPath=resolve(import.meta.dirname,"launch-segmented-postgres-preservation.py");
  const launcherStat=await lstat(launcherPath);gate(launcherStat.isFile() && !launcherStat.isSymbolicLink() && launcherStat.nlink===1 && !(launcherStat.mode&0o022),"segmented_launcher_kind");
  const launcherHandle=await open(launcherPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {files.launcher=await launcherHandle.readFile();}finally{await launcherHandle.close();}
  gate(sha(files.segmentedRunner)===nativeRunnerSha256 && sha(files.launcher)===pins.launcherSha256,"segmented_factory_pins");
  files.operationId=pins.operationId;
  return attachSegmentedPreservationPorts(base,{files,nativeRunnerPath,nativeRunnerSha256});
}

/** Owner control is not an artifact producer. It retains the private PG transaction
 * inside the single lifecycle callback, and never creates a target or reconnects.
 */
export const retainedOwnerControlPython = remotePython.split("child=None\n")[0]
  .replace("p=json.loads(sys.stdin.read(2*1024*1024))", "p=json.loads(sys.stdin.readline(262145))") + String.raw`
import select,secrets
identity()
helper,record=expiry_paths()
pinned(helper,p['expiryHelperSha256']);immutable(helper)
expiry=expiry_record(record,p['recordSha256'])
need(expiry['deadline']*1000==p['absoluteDeadlineAtMs'],'owner_expiry_identity')
need(expiry['deadline']>time.time() and 0<p['operationSeconds']<=10800,'owner_expired')
operationDeadlineMono=min(operationDeadlineMono,time.monotonic()+expiry['deadline']-time.time())
owner=subprocess.Popen(['/usr/sbin/runuser','-u','postgres','--','/usr/lib/postgresql/16/bin/psql','-X','-q','-A','-t','--set=ON_ERROR_STOP=1','--host='+root+'/socket','--port=5434','--username=postgres','--dbname=radar_rehearsal_'+nonce],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LC_ALL':'C','PGOPTIONS':'-c statement_timeout=60000 -c lock_timeout=5000 -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0'})
def emit(value):print(json.dumps(value,separators=(',',':')),flush=True)
def literal(value):
 if value is None:return 'NULL'
 if type(value) is bool:return 'TRUE' if value else 'FALSE'
 if type(value) is int:return str(value)
 need(type(value) is str and len(value)<=4096 and '\x00' not in value,'owner_parameter')
 return "E'"+value.replace('\\','\\\\').replace("'","''")+"'"
def response_line(until):
 raw=bytearray()
 while True:
  need(time.time()<expiry['deadline'] and time.monotonic()<until,'owner_query_timeout')
  ready,_,_=select.select([owner.stdout],[],[],min(1,max(.01,until-time.monotonic())))
  if not ready:continue
  chunk=os.read(owner.stdout.fileno(),1)
  need(chunk,'owner_disconnected')
  if chunk==b'\n':return bytes(raw)
  raw.extend(chunk);need(len(raw)<=1048576,'owner_output_bound')
try:
 emit({'ready':True,'nonce':nonce,'recordSha256':p['recordSha256']})
 while True:
  need(time.time()<expiry['deadline'] and time.monotonic()<operationDeadlineMono,'owner_expired')
  ready,_,_=select.select([sys.stdin],[],[],min(1,max(.01,operationDeadlineMono-time.monotonic())))
  if not ready:continue
  raw=sys.stdin.readline(262145)
  if not raw:break
  need(len(raw)<=262144,'owner_input_bound');request=json.loads(raw)
  if request.get('action')=='close':break
  identity()
  need(re.fullmatch(r'[a-f0-9]{16}',request['id']),'owner_request_id')
  action=request.get('action','query')
  if action in ('managed-stage','publish-authority','seal-artifacts','freeze-binding','managed-empty','seal-proof','register-invocation'):
   import importlib.util
   specification=importlib.util.spec_from_file_location('radar_frozen_expiry',helper)
   expiry_module=importlib.util.module_from_spec(specification);specification.loader.exec_module(expiry_module)
   actual_record=expiry_module.load_record(record,p['recordSha256'],nonce)
   launcher_path=work+'/launch-segmented-postgres-preservation.py';protected(launcher_path)
   need(digest(read(launcher_path,0,2097152))==actual_record['artifacts']['code_pins']['launch-segmented-postgres-preservation.py']['sha256'],'managed_launcher_pin')
   specification=importlib.util.spec_from_file_location('radar_registered_launcher',launcher_path)
   launcher=importlib.util.module_from_spec(specification);specification.loader.exec_module(launcher)
   if action=='managed-empty':
    with expiry_module.control_scope(nonce,expected=actual_record['artifacts']['control']) as (control,_,_):
     proofs=[]
     for invocation in request['invocationIds']:
      need(re.fullmatch(r'[a-f0-9]{32}-[0-9]{6}',invocation),'managed_parent_id')
      raw,_=expiry_module.read_at(control,'supervisor-'+invocation+'.json',0,limit=16384);mapping=json.loads(raw)
      need(mapping['record_sha256']==p['recordSha256'] and mapping['nonce']==nonce,'managed_parent_mapping')
      managed,_=expiry_module.invocation_file(control,mapping['request_nonce'],mapping['role'],'binding')
      with expiry_module.ManagedCgroupProof(managed) as cgroup:
       need(expiry_module.terminal_empty(expiry_module.SystemdBackend(actual_record),actual_record,managed,cgroup),'managed_exit_unproven')
      proofs.append({'managedProtocol':1,'invocationId':invocation,'requestNonce':mapping['request_nonce'],'role':mapping['role'],'unit':managed['unit'],
       'nativeInvocationId':managed['invocation_id'],'controlGroup':managed['control_group'],'cgroupIdentity':managed['identity'],
       'recordSha256':p['recordSha256'],'instanceSha256':expiry_module.digest(expiry_module.canonical(managed)), 'cgroupPopulated':0,'cgroupProcessCount':0})
    result={'challenge':request['challenge'],'identitySha256':request['identitySha256'],'proofs':proofs}
   elif action=='register-invocation':
    value=request['value'];need(re.fullmatch(r'[a-f0-9]{32}-[0-9]{6}',value['invocationId']) and value['nonce']==nonce and value['record_sha256']==p['recordSha256'],'managed_parent_binding')
    with expiry_module.control_scope(nonce,expected=actual_record['artifacts']['control']) as (control,_,_):expiry_module.write_control_file(control,'supervisor-'+value['invocationId']+'.json',expiry_module.canonical(value))
    result={'status':'registered'}
   elif action=='seal-proof':
    with expiry_module.control_scope(nonce,expected=actual_record['artifacts']['control']) as (control,_,_):
     state=expiry_module.read_control_state(control,actual_record);need(state['phase']=='sealed','seal_phase')
     with expiry_module.artifact_scope(work,nonce,expected=actual_record['artifacts']) as (artifacts,_):
      need(expiry_module.manifest_digest(expiry_module.tree_manifest(artifacts,0,artifacts=True))==state['snapshot_sha256'],'seal_changed')
     result={'status':'sealed','sealSha256':state['snapshot_sha256']}
   elif action=='managed-stage':
    result=launcher.run_managed_stage(expiry_module,record,p['recordSha256'],nonce,request['configPath'],request['runtimeSeconds'],request.get('authoritySha256'))
   elif action=='publish-authority':
    result=launcher.publish_authority(expiry_module,actual_record,base64.b64decode(request['bytesBase64'],validate=True))
   elif action=='seal-artifacts':result=expiry_module.seal_artifacts(actual_record)
   else:
    value=request['value'];need(value['nonce']==nonce and value['recordSha256']==p['recordSha256'],'freeze_binding_identity')
    with expiry_module.control_scope(nonce,expected=actual_record['artifacts']['control']) as (control,_,_):
     expiry_module.write_control_file(control,'freeze-binding.json',expiry_module.canonical(value))
    result={'status':'published'}
   emit({'id':request['id'],'rows':[result],'rowCount':1});continue
  if action=='artifact-file':
   path=request['path']
   allowed=path in (work+'/segmented-runner.mjs',work+'/launch-segmented-postgres-preservation.py',work+'/segmented-authority.mjs',work+'/source-reader.py') or re.fullmatch(re.escape(work)+r'/[A-Za-z0-9_-]+\.json',path)
   need(allowed,'owner_artifact_scope');protected(path)
   rawfile=read(path,0,2097152);info=os.lstat(path)
   emit({'id':request['id'],'rows':[{'bytesBase64':base64.b64encode(rawfile).decode(),'pin':{'identity':[info.st_dev,info.st_ino],'sha256':digest(rawfile)}}],'rowCount':1})
   continue
  if action=='execution-pin':
   import importlib.util
   specification=importlib.util.spec_from_file_location('radar_frozen_expiry',helper)
   expiry_module=importlib.util.module_from_spec(specification);specification.loader.exec_module(expiry_module)
   emit({'id':request['id'],'rows':[expiry_module.root_path_pin(os.path.realpath('/usr/bin/python3'))],'rowCount':1})
   continue
  need(action in ('query','credential-query'),'owner_action')
  need(re.fullmatch(r'[a-f0-9]{16}',request['id']) and type(request['text']) is str and len(request['text'])<=131072 and '\x00' not in request['text'],'owner_query')
  need(type(request['values']) is list and len(request['values'])<=16,'owner_values')
  values=request['values'];sql=re.sub(r'\$([1-9][0-9]*)',lambda m:literal(values[int(m[1])-1]),request['text']).strip().rstrip(';')
  if action=='credential-query':
   config_path=request['configPath'];need(re.fullmatch(re.escape(work)+r'/[A-Za-z0-9_-]+\.json',config_path),'credential_path');protected(config_path)
   config=json.loads(read(config_path,0,1048576));credential=config['connection']
   need(config['nonce']==nonce and config['stage'] in ('verify','finalize') and credential['host']=='127.0.0.1' and credential['port']==5434 and credential['database']=='radar_rehearsal_'+nonce and credential['systemIdentifier']==p['systemIdentifier'] and credential['username']=='radar_rehearsal_'+nonce+('_verifier' if config['stage']=='verify' else '_finalizer') and re.fullmatch(r'[a-f0-9]{64}',credential['password']),'credential_scope')
   need(re.match(r'^(SELECT|WITH)\b',sql,re.I),'credential_readonly_measurement')
   env={'PATH':'/usr/bin:/bin','LC_ALL':'C','PGPASSWORD':credential['password'],'PGOPTIONS':'-c statement_timeout=60000 -c lock_timeout=5000'+(' -c default_transaction_read_only=on' if config['stage']=='verify' else '')}
   measured=subprocess.run(['/usr/lib/postgresql/16/bin/psql','-X','-q','-A','-t','--set=ON_ERROR_STOP=1','--host=127.0.0.1','--port=5434','--username='+credential['username'],'--dbname=radar_rehearsal_'+nonce],input=('SELECT COALESCE(json_agg(_radar),'+chr(39)+'[]'+chr(39)+'::json) FROM ('+sql+') _radar;').encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=min(65,max(.1,operationDeadlineMono-time.monotonic())),env=env)
   need(measured.returncode==0 and len(measured.stdout)<=1048576,'credential_measurement_failed')
   rows=json.loads(measured.stdout);need(type(rows) is list,'credential_rows')
   emit({'id':request['id'],'rows':rows,'rowCount':len(rows)})
   continue
  # Only the pinned native controller supplies SQL; callers cannot substitute a host/database.
  query='SELECT COALESCE(json_agg(_radar),'+'\x27[]\x27'+'::json) FROM ('+sql+') _radar' if re.match(r'^(SELECT|WITH)\b',sql,re.I) else sql
  marker='radar_owner_'+secrets.token_hex(16)
  owner.stdin.write((query+';\n\\echo '+marker+'\n').encode());owner.stdin.flush()
  until=min(operationDeadlineMono,time.monotonic()+60);lines=[];total=0
  while True:
   line=response_line(until)
   if line.decode()==marker:break
   total+=len(line);need(total<=1048576,'owner_result_bound')
   if line:lines.append(line)
  need(len(lines)<=1,'owner_result_shape')
  rows=json.loads(lines[0]) if lines else [];need(type(rows) is list,'owner_result_rows')
  emit({'id':request['id'],'rows':rows,'rowCount':len(rows)})
except BaseException:
 emit({'failed':True})
 raise
finally:
 try:owner.stdin.close()
 except Exception:pass
 # EOF closes the owner session. Numeric PID/PGID signals are never a retirement proof.
 try:owner.wait(timeout=10)
 except subprocess.TimeoutExpired:raise RuntimeError('owner_exit_unproven')
`;

export async function createFixedRetainedOwnerClient({ ctx, binding, expiry }, {
  spawnProcess = spawn, clock = Date.now, graceMs = 10000,
} = {}) {
  gate(ctx.nonce === binding.nonce && /^[a-f0-9]{16}$/.test(ctx.nonce) && ctx.database === "radar_rehearsal_" + ctx.nonce &&
    ctx.schema === ctx.database + "_schema" && ctx.systemIdentifier === binding.systemIdentifier &&
    hash(binding.expiryHelperSha256) && hash(expiry.recordSha256) && count(expiry.expiresAtMs) &&
    expiry.expiresAtMs > clock() + 280000 && expiry.expiresAtMs <= clock() + 10800000, "owner_scope");
  const code = Buffer.from(retainedOwnerControlPython).toString("base64");
  gate(/^[A-Za-z0-9+/=]+$/.test(code), "owner_program_encoding");
  const argv = [...sshArgs];
  argv[argv.length - 1] = "sudo -n /usr/bin/nice -n 19 /usr/bin/ionice -c 3 /usr/bin/python3 -u -c 'exec(__import__(\"base64\").b64decode(\"" + code + "\"))'";
  const child = spawnProcess("ssh", argv, { stdio: ["pipe", "pipe", "ignore"], detached: false,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } });
  let buffered = "", failed, closed = false, closing = false, waiter, readyResolve, readyReject, closeResolve;
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const finished = new Promise(yes => { closeResolve = yes; });
  const refuse = () => {
    failed ??= new Error("preservation_host_owner_continuity_lost");
    readyReject(failed); if (waiter) { waiter.reject(failed); waiter = undefined; }
  };
  const lifetime = setTimeout(() => { refuse(); child.stdin.end(); }, expiry.expiresAtMs - clock());
  child.once("error", refuse); child.stdin.on("error", refuse);
  child.once("close", code => { closed = true; clearTimeout(lifetime); if (!closing || code !== 0) refuse(); closeResolve(code); });
  child.stdout.on("data", chunk => {
    buffered += chunk.toString("utf8");
    if (Buffer.byteLength(buffered) > 4 * 1048576) { refuse(); child.stdin.end(); return; }
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.ready === true) { gate(value.nonce === ctx.nonce && value.recordSha256 === expiry.recordSha256, "owner_ready_binding"); readyResolve(); }
        else {
          gate(waiter && value.id === waiter.id && Array.isArray(value.rows) && count(value.rowCount) && value.rowCount === value.rows.length, "owner_response");
          waiter.resolve({ rows: value.rows, rowCount: value.rowCount }); waiter = undefined;
        }
      } catch { refuse(); child.stdin.end(); }
    }
  });
  child.stdin.write(JSON.stringify({ nonce: ctx.nonce, systemIdentifier: ctx.systemIdentifier, binding,
    expiryHelperSha256: binding.expiryHelperSha256, recordSha256: expiry.recordSha256,
    absoluteDeadlineAtMs: expiry.expiresAtMs, operationSeconds: Math.floor((expiry.expiresAtMs - clock()) / 1000) }) + "\n");
  const admission = setTimeout(() => { refuse(); child.stdin.end(); }, 15000);
  try { await ready; } finally { clearTimeout(admission); }
  let queue = Promise.resolve(), operationBudget;
  const nativeMetrics={physicalSqlStatements:0,commitAttempts:0,acknowledgedCommits:0,acknowledgedRollbacks:0,uncertainCommit:false};
  const request = (text, values = [], extra = {}) => {
      const operation = queue.then(async () => {
        gate(!failed && !closed && !closing && clock() < expiry.expiresAtMs, "owner_continuity_lost");
        gate(typeof text === "string" && text.length <= 131072 && Array.isArray(values) && values.length <= 16, "owner_query_scope");
        const id = randomBytes(8).toString("hex");
        return await new Promise((yes, no) => {
          const remainingBudget=operationBudget ? Math.min(operationBudget.deadlineAtMs-clock(),operationBudget.monotonicDeadlineAtMs-performance.now()) : Infinity;
          gate(remainingBudget>0 && !operationBudget?.signal?.aborted,"owner_operation_deadline");
          const timer = setTimeout(() => { refuse(); child.stdin.end(); }, Math.min(remainingBudget,
            extra.action === "managed-stage" ? Math.min(950000, (extra.runtimeSeconds + 40) * 1000) : 65000));
          waiter = { id, resolve: result => { clearTimeout(timer); yes(result); }, reject: error => { clearTimeout(timer); no(error); } };
          child.stdin.write(JSON.stringify({ id, text, values, ...extra }) + "\n");
        });
      });
      queue = operation.then(() => {}, () => {});
      return operation;
  };
  return {
    nativeMetrics,
    async query(text,values=[]) {
      nativeMetrics.physicalSqlStatements++;if(text.trim()==="COMMIT")nativeMetrics.commitAttempts++;
      try {const result=await request(text,values);if(text.trim()==="COMMIT")nativeMetrics.acknowledgedCommits++;if(text.trim()==="ROLLBACK")nativeMetrics.acknowledgedRollbacks++;return result;}
      catch(error){if(text.trim()==="COMMIT")nativeMetrics.uncertainCommit=true;throw error;}
    },
    setOperationBudget(work) {
      gate(!operationBudget && count(work.deadlineAtMs) && Number.isFinite(work.monotonicDeadlineAtMs),"owner_operation_scope");
      const abort=()=>{refuse();child.stdin.end();};
      operationBudget=work;work.signal?.addEventListener("abort",abort,{once:true});
      if(work.signal?.aborted)abort();
      return ()=>{work.signal?.removeEventListener("abort",abort);operationBudget=undefined;};
    },
    async managedControl(action, extra = {}) {
      gate(["managed-stage","publish-authority","seal-artifacts","freeze-binding","managed-empty","seal-proof","register-invocation"].includes(action), "managed_control_action");
      const result = await request("", [], { action, ...extra }); gate(result.rows.length === 1, "managed_control_receipt"); return result.rows[0];
    },
    queryCredential(configPath, text, values = []) { return request(text, values, { action: "credential-query", configPath }); },
    async readProtectedArtifact(path) {
      const result = await request("", [], { action: "artifact-file", path });
      gate(result.rows.length === 1 && typeof result.rows[0].bytesBase64 === "string" && hash(result.rows[0].pin?.sha256) &&
        Array.isArray(result.rows[0].pin.identity) && result.rows[0].pin.identity.length === 2 && result.rows[0].pin.identity.every(x => count(x)), "owner_artifact_receipt");
      const bytes = Buffer.from(result.rows[0].bytesBase64, "base64"); gate(bytes.length <= 2097152 && sha(bytes) === result.rows[0].pin.sha256, "owner_artifact_pin");
      return { bytes, pin: result.rows[0].pin };
    },
    async readExecutionPin() {
      const result = await request("", [], { action: "execution-pin" });
      gate(result.rows.length === 1 && /^\/usr\/bin\/python3(?:\.[0-9]+)?$/.test(result.rows[0].path) && hash(result.rows[0].sha256), "owner_execution_pin");
      return result.rows[0];
    },
    release(error) { if (error) refuse(); closing = true; child.stdin.end(JSON.stringify({ action: "close" }) + "\n"); },
    async close() {
      await queue;
      if (!closing) { closing = true; child.stdin.end(JSON.stringify({ action: "close" }) + "\n"); }
      let timer;
      const status = await Promise.race([finished, new Promise((_, no) => { timer = setTimeout(() => no(new Error("preservation_host_owner_exit_unproven")), graceMs); })]).finally(() => clearTimeout(timer));
      gate(closed && status === 0 && !failed, "owner_exit_unproven");
    },
  };
}

/** Keeps the owner barrier under the same retained callback. No default freeze or artifact trust. */
export async function withNativeSegmentedFreeze({ ctx, binding, expiry, config, nativeRunnerPath, nativeRunnerSha256 }, callback, dependencies = {}) {
  gate(hash(nativeRunnerSha256) && nativeRunnerSha256 === binding.segmentedRunnerSha256 &&
    nativeRunnerPath === "/private/tmp/radar-segmented-preservation-runner.mjs", "segmented_native_runner_pin");
  const raw = await privateFile(nativeRunnerPath, 2 * 1024 * 1024);
  gate(sha(raw) === nativeRunnerSha256, "segmented_native_runner_pin");
  const { pathToFileURL } = await import("node:url");
  const native = await import(pathToFileURL(nativeRunnerPath).href);
  gate(typeof native.createCrossWindowFreezeBarrier === "function" && typeof native.generateManagedDatabaseAuthority === "function", "segmented_native_exports");
  const owner = await createFixedRetainedOwnerClient({ ctx, binding, expiry }, dependencies);
  let barrier;
  try {
    barrier = await native.createCrossWindowFreezeBarrier(owner, config, { deadlineAtMs: expiry.expiresAtMs, timeoutMs: 180000 });
    return await callback({ barrier, owner,
      generateAuthority: (configPath, recordSha256, invocation) => native.generateManagedDatabaseAuthority(configPath, "/usr/bin/python3", recordSha256,
        { query: (text, values) => owner.queryCredential(configPath, text, values), release() {} }, barrier,
        { artifact: path => owner.readProtectedArtifact(path), execution: () => owner.readExecutionPin(), ...(invocation ? { invocation } : {}) }),
    });
  } finally {
    try { if (barrier) await barrier.close(); } finally { await owner.close(); }
  }
}

/** Explicit segmented protocol, retained within the original lifecycle callback. Arm remains blocked.
 * Parent maintenance supervisor calls run only inside a paused, independently measured window.
 */
export async function createManagedSegmentedRoute(scope, dependencies = {}) {
  const nativePath = scope.nativeRunnerPath;
  gate((nativePath === "/private/tmp/radar-segmented-preservation-runner.mjs" || nativePath === "/private/tmp/radar-segmented-preservation-runner-"+scope.nativeRunnerSha256+".mjs") && hash(scope.nativeRunnerSha256), "managed_native_bundle");
  const bytes = await privateFile(nativePath,2097152);gate(sha(bytes)===scope.nativeRunnerSha256,"managed_native_bundle");
  const {pathToFileURL}=await import("node:url");const native=await import(pathToFileURL(nativePath).href);
  const owner=await createFixedRetainedOwnerClient(scope,dependencies);
  const seen=new Set();let phase="import",barrier,closed=false;
  const clock=dependencies.clock ?? Date.now,mono=dependencies.monotonic ?? (()=>performance.now());
  const root="/var/lib/address-radar-rehearsal-artifacts/"+scope.ctx.nonce;
  const verifyNative=async(config)=>{
    const before=await barrier.measure();
    config.freezeBarrier={backendPid:before.backendPid,epoch:before.epoch};
    await native.measureSegmentedDatabaseAuthority({query:(text,values)=>owner.queryCredential(config.path,text,values),release(){}},config);
    const after=await barrier.measure();gate(before.identitySha256===after.identitySha256,"managed_freeze_changed");
  };
  return Object.freeze({protocolVersion:2,
    async run({stage,configPath,deadlineAtMs,windowDeadlineAtMs,monotonicDeadlineAtMs,signal}) {
      const clearBudget=owner.setOperationBudget({deadlineAtMs,monotonicDeadlineAtMs,signal});
      try {
      gate(!closed && ["calibrate","import","verify","finalize"].includes(stage) && (["calibrate","import"].includes(stage) ? phase==="import" : phase==="sealed"),"managed_phase");
      gate(new RegExp("^"+root+"/[A-Za-z0-9_-]+\\.json$").test(configPath),"managed_config_path");
      const stored=await owner.readProtectedArtifact(configPath),config=JSON.parse(stored.bytes);config.path=configPath;
      gate(config.stage===stage && config.nonce===scope.ctx.nonce && !seen.has(config.invocation.requestNonce),"managed_request_reuse");
      const remaining=Math.min(deadlineAtMs,windowDeadlineAtMs-280000,scope.expiry.expiresAtMs-280000)-clock();
      let runtimeSeconds=Math.floor(Math.min(stage==="calibrate"?180000:900000,remaining-40000)/1000);gate(runtimeSeconds>70,"managed_work_budget");
      const started=mono();seen.add(config.invocation.requestNonce);let authoritySha256;
      if(["verify","finalize"].includes(stage)) {
        await verifyNative(config);
        const generated=await native.generateManagedDatabaseAuthority(configPath,"/usr/bin/python3",scope.expiry.recordSha256,
          {query:(text,values)=>owner.queryCredential(configPath,text,values),release(){}},barrier,
          {artifact:path=>owner.readProtectedArtifact(path),execution:()=>owner.readExecutionPin(),
           invocation:{requestNonce:config.invocation.requestNonce,timeoutMs:runtimeSeconds*1000,deadlineAtMs:clock()+runtimeSeconds*1000}});
        const published=await owner.managedControl("publish-authority",{bytesBase64:generated.bytes.toString("base64")});
        gate(published.sha256===generated.sha256,"managed_authority_publish");authoritySha256=generated.sha256;
      }
      runtimeSeconds=Math.floor(Math.min(runtimeSeconds*1000, remaining-(mono()-started)-40000,
        Math.min(deadlineAtMs,windowDeadlineAtMs-280000,scope.expiry.expiresAtMs-280000)-clock()-40000)/1000);
      gate(runtimeSeconds>70,"managed_admission_after_measurement");
      const proof=await owner.managedControl("managed-stage",{configPath,runtimeSeconds,authoritySha256});
      gate(mono()-started<remaining && clock()<Math.min(deadlineAtMs,windowDeadlineAtMs-280000,scope.expiry.expiresAtMs-280000) &&
        proof.name===config.invocation.requestNonce+"-"+stage+".proof.json" && hash(proof.sha256),"managed_stage_proof");
      const report=proof.report;
      gate(report?.version===2 && report.stage===stage && report.requestNonce===config.invocation.requestNonce &&
        report.configSha256===stored.pin.sha256 && report.configRelative===configPath.slice(root.length+1) &&
        report.productionAuthorized===false && report.grantsBusinessEligibility===false &&
        report.nativeMetrics?.uncertainCommit===false && report.nativeMetrics.commitAttempts===report.nativeMetrics.acknowledgedCommits &&
        report.target?.database===scope.ctx.database && report.target.schema===scope.ctx.schema && report.target.role===config.connection.username &&
        report.target.systemIdentifier===scope.ctx.systemIdentifier && same(report.expected,fixedPins),"managed_native_receipt");
      if(["verify","finalize"].includes(stage))await verifyNative(config);
      if(stage==="finalize") {
        gate(report.parityComplete===true && report.result?.completed===true &&
          ["acknowledged","reconciled"].includes(report.result.completionOutcome),"managed_native_completion");phase="finalized";
      } else gate(report.parityComplete===false && report.result?.completed!==true,"managed_premature_completion");
      if(stage==="import") {
        gate(["segment_imported","yielded_before_transaction"].includes(report.result.status) &&
          report.result.nextChunkIndex>config.selection.startChunkIndex &&
          report.result.nextChunkIndex<=config.selection.endChunkIndexExclusive &&
          report.result.committedChunks>0 && report.nativeMetrics.acknowledgedCommits>=report.result.committedChunks,
          "managed_zero_progress_or_unacknowledged_import");
      }
      return proof;
      } finally {clearBudget();}
    },
    async freeze(configPath,finalizerConfigPath,work) {
      const beforeMetrics={...owner.nativeMetrics};
      const clearBudget=owner.setOperationBudget(work);
      try {
      gate(typeof configPath === "string" && configPath.startsWith(root+"/") && /^[A-Za-z0-9_-]+\.json$/.test(configPath.slice(root.length+1)),"managed_freeze_config");
      const stored=await owner.readProtectedArtifact(configPath),config=JSON.parse(stored.bytes);
      gate(config.nonce===scope.ctx.nonce && config.stage==="verify","managed_freeze_config");
      gate(!closed && phase==="import" && !barrier,"managed_freeze_phase");
      const finalizerStored=await owner.readProtectedArtifact(finalizerConfigPath);
      await native.prepareSegmentedFreezeRoles(owner,config,JSON.parse(finalizerStored.bytes));
      const counts=await owner.query('SELECT (SELECT count(*)::int FROM "'+scope.ctx.schema+'".full_data_preservation_tables) AS tables, '+
        '(SELECT count(*)::int FROM "'+scope.ctx.schema+'".full_data_preservation_chunks) AS chunks, '+
        '(SELECT count(*)::int FROM "'+scope.ctx.schema+'".full_data_preservation_rows) AS rows');
      gate(counts.rows.length===1 && counts.rows[0].tables===141 && counts.rows[0].chunks===1548 && counts.rows[0].rows===6023033,"managed_import_not_durable");
      barrier=await native.createCrossWindowFreezeBarrier(owner,config,{deadlineAtMs:scope.expiry.expiresAtMs-280000,timeoutMs:180000});
      const measured=await barrier.measure();
      config.binding={...config.binding,freezeEvidenceSha256:measured.identitySha256};
      await owner.managedControl("freeze-binding",{value:{nonce:scope.ctx.nonce,recordSha256:scope.expiry.recordSha256,
        binding:config.binding,backendPid:measured.backendPid,identitySha256:measured.identitySha256}});
      const sealed=await owner.managedControl("seal-artifacts");gate(sealed.status==="sealed","managed_artifact_seal");phase="sealed";
      const sealedProof=await owner.managedControl("seal-proof");
      return {databaseFrozen:true,artifactSealed:true,backendPid:measured.backendPid,identitySha256:measured.identitySha256,
        freezeSha256:sha(JSON.stringify({binding:config.binding,identitySha256:measured.identitySha256})),sealSha256:sealedProof.sealSha256,
        nativeMetrics:{physicalSqlStatements:owner.nativeMetrics.physicalSqlStatements-beforeMetrics.physicalSqlStatements,
          commitAttempts:owner.nativeMetrics.commitAttempts-beforeMetrics.commitAttempts,acknowledgedCommits:owner.nativeMetrics.acknowledgedCommits-beforeMetrics.acknowledgedCommits,
          acknowledgedRollbacks:owner.nativeMetrics.acknowledgedRollbacks-beforeMetrics.acknowledgedRollbacks,uncertainCommit:owner.nativeMetrics.uncertainCommit}};
      } finally {clearBudget();}
    },
    async measureFreeze(challenge,work) { gate(barrier && !closed,"managed_freeze_missing");
      const clearBudget=owner.setOperationBudget(work);try {
        const measured=await barrier.measure();return {...measured,challenge,measurementSha256:sha(JSON.stringify({challenge,...measured})),nativeMeasurementQueries:2,writerSessionCount:0,writeAuthorityCount:0};
      } finally {clearBudget();} },
    async verifySeal(work) {const clearBudget=owner.setOperationBudget(work);try{return await owner.managedControl("seal-proof");}finally{clearBudget();}},
    registerInvocation: value => owner.managedControl("register-invocation",{value}),
    verifyEmpty: request => owner.managedControl("managed-empty",request),
    async close() { if(closed)return;closed=true;try{if(barrier)await barrier.close();}finally{await owner.close();} },
  });
}

/** Local-only bundle preparation. Never starts a fixture, SSH transport or a host command. */
export async function buildSegmentedPreservationBundle() {
  const {createRequire}=await import("node:module");const require=createRequire(import.meta.url);
  const esbuild=createRequire(require.resolve("tsx/package.json"))("esbuild");
  const pg=createRequire(resolve(import.meta.dirname,"../packages/database/package.json"));

  const result=await esbuild.build({entryPoints:[resolve(import.meta.dirname,"run-segmented-postgres-preservation.ts")],
    bundle:true,write:false,platform:"node",format:"esm",target:"node24",alias:{pg:pg.resolve("pg")},external:["pg-native"],
    plugins:[{name:"segmented-library-only",setup(build){build.onLoad({filter:/rehearse-postgres-full-preservation\.ts$/},async args=>({
      contents:(await (await import("node:fs/promises")).readFile(args.path,"utf8")).split("\nif (process.argv[1]")[0],loader:"ts"}));}}],
    banner:{js:"import {createRequire as __radarRequire} from 'node:module';const require=__radarRequire(import.meta.url);"}});
  gate(result.outputFiles?.length===1 && result.outputFiles[0].contents.length<=2097152,"segmented_bundle_size");
  const content=result.outputFiles[0].contents;
  const outfile="/private/tmp/radar-segmented-preservation-runner-"+sha(content)+".mjs";
  try { await writeFile(outfile,content,{flag:"wx",mode:0o600}); }
  catch(error) { if(error.code!=="EEXIST")throw error;
    const existing=await privateFile(outfile,2097152);
    gate(existing.length===content.length && sha(existing)===sha(content),"segmented_existing_bundle_pin");
  }
  return {path:outfile,sha256:sha(content)};
}

export function createSegmentedInstallPlan({ctx,binding,target,sessionId,absoluteDeadlineAtMs,connection,files,segmentChunks=64}) {
  gate(/^[a-f0-9]{32}$/.test(sessionId) && count(absoluteDeadlineAtMs) && ctx.schema===ctx.database+"_schema" &&
    ctx.role===ctx.database+"_migrator" && count(segmentChunks,64) && segmentChunks>0,"install_plan_scope");
  const root="/var/lib/address-radar-rehearsal-artifacts/"+ctx.nonce;
  const request=(stage,index)=>sha(JSON.stringify({nonce:ctx.nonce,sessionId,stage,index})).slice(0,16);
  const verifierPassword=randomBytes(32).toString("hex"),finalizerPassword=randomBytes(32).toString("hex");
  const freezeBinding={sessionId,freezeEpoch:sessionId,operationId:files.operationId,snapshotSha256:fixedPins.snapshotSha256,
    manifestSha256:fixedPins.manifestSha256,target:{database:ctx.database,schema:ctx.schema,endpoint:"127.0.0.1:5434",systemIdentifier:ctx.systemIdentifier},
    freezeEvidenceSha256:sha(JSON.stringify(binding))};
  gate(typeof files.operationId==="string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(files.operationId),"install_operation_pin");
  const configs=[],byStage={calibrate:[],import:[],verify:[],finalize:[]};
  const make=(stage,start,end)=>{
    const requestNonce=request(stage,start),name=stage+"-"+requestNonce+".json";
    const username=ctx.database+(["calibrate","import"].includes(stage)?"_migrator":stage==="verify"?"_verifier":"_finalizer");
    const credential={host:"127.0.0.1",port:5434,database:ctx.database,username,password:stage==="verify"?verifierPassword:stage==="finalize"?finalizerPassword:connection.password,systemIdentifier:ctx.systemIdentifier};
    const config={version:2,nonce:ctx.nonce,stage,sessionId,connection:credential,...(({password,...publicConnection})=>publicConnection)(credential),
      schema:ctx.schema,runnerSha256:sha(files.segmentedRunner),sourceReaderSha256:sha(files.sourceReader),authorityModuleSha256:sha(files.segmentedRunner),
      invocation:{requestNonce,timeoutMs:stage==="calibrate"?180000:900000,deadlineAtMs:absoluteDeadlineAtMs}};
    if(["import","verify"].includes(stage))config.selection={startChunkIndex:start,endChunkIndexExclusive:end};
    if(["verify","finalize"].includes(stage))config.binding=freezeBinding;
    if(stage==="calibrate")config.calibrationTarget=target;
    if(stage==="finalize")config.proofRequests=byStage.verify.map(x=>x.requestNonce);
    const bytes=Buffer.from(JSON.stringify(config)),item={stage,start,end,requestNonce,name,path:root+"/"+name,bytes,sha256:sha(bytes)};
    configs.push(item);byStage[stage].push(item);
  };
  make("calibrate",0,0);
  for(let start=0;start<1548;start++)make("import",start,Math.min(1548,start+segmentChunks));
  for(let start=0;start<1548;start+=segmentChunks)make("verify",start,Math.min(1548,start+segmentChunks));
  make("finalize",0,0);
  gate(new Set(configs.map(c=>c.requestNonce)).size===configs.length,"install_request_collision");
  const code=[{name:"segmented-runner.mjs",bytes:files.segmentedRunner},{name:"segmented-authority.mjs",bytes:files.segmentedRunner},
    {name:"source-reader.py",bytes:files.sourceReader},{name:"launch-segmented-postgres-preservation.py",bytes:files.launcher}];
  return {configs,byStage,code,prepared:{version:1,nonce:ctx.nonce,configs:Object.fromEntries(configs.map(c=>[c.name,c.sha256]))}};
}

/** Concrete outer protocol adapter. Native facts come only from the retained route and fixed transport.
 * Local tests replace the whole transport/route, never inject completion flags into native code.
 */
export function attachSegmentedPreservationPorts(base,{files,nativeRunnerPath,nativeRunnerSha256},dependencies={}) {
  const transport=dependencies.transport ?? createFixedTransport(),routeFactory=dependencies.routeFactory ?? createManagedSegmentedRoute;
  const clock=dependencies.clock ?? Date.now;let ctx,binding,plan,expiry,route,freeze,closed=false;
  const pausedWindows=new Set(), windowInvocations=new Map(), retiredWindows=new Set();
  const mono=dependencies.monotonic ?? (()=>performance.now());
  const dispatch=async(action,extra={},timeout=180000,request={})=>{
    const budget=Math.floor(Math.min(timeout,request.timeoutMs ?? Infinity,
      request.deadlineAtMs===undefined?Infinity:request.deadlineAtMs-clock(),
      request.monotonicDeadlineAtMs===undefined?Infinity:request.monotonicDeadlineAtMs-mono()));
    gate(budget>1000,"segmented_dispatch_budget");
    return transport({nonce:ctx.nonce,systemIdentifier:ctx.systemIdentifier,binding,
      action,expiryHelperSha256:binding.expiryHelperSha256,operationSeconds:Math.floor(budget/1000)-1,deadlineAtMs:clock()+budget,...extra},budget,{signal:request.signal});
  };
  const getRoute=async()=>{
    gate(expiry && !closed,"segmented_unarmed");
    if(!route)route=await routeFactory({ctx,binding,expiry,nativeRunnerPath,nativeRunnerSha256},dependencies);
    return route;
  };
  return {...base,protocolVersion:2,managedRetirementProtocol:1,
    async bind(context,preparation) {
      ctx=context;const initial=await base.bind(ctx);
      const connection=JSON.parse(await (dependencies.readConnection ?? privateFile)(ctx.connectionPath,16384));
      const target={database:ctx.database,schema:ctx.schema,username:ctx.role,serverAddress:"127.0.0.1",serverPort:5434,
        systemIdentifier:ctx.systemIdentifier,schemaVersion:1,schemaFingerprint:initial.schemaFingerprint,generation:"preservation-"+ctx.nonce,service:"migration-preservation"};
      gate(hash(target.schemaFingerprint) && sha(files.segmentedRunner)===nativeRunnerSha256,"segmented_install_native_pin");
      binding={...initial,runnerSha256:nativeRunnerSha256,segmentedRunnerSha256:nativeRunnerSha256};
      plan=createSegmentedInstallPlan({ctx,binding,target,...preparation,connection,files});
      const started=performance.now();const native=await dispatch("segmented-bootstrap",{expiryCode:files.expiry.toString("base64")});
      const additions={...native,registeredCodePins:Object.fromEntries(plan.code.map(c=>[c.name,sha(c.bytes)]))};
      gate(typeof base.bindArtifactControl==="function","segmented_control_binding_port");
      await base.bindArtifactControl(ctx,additions);
      binding=Object.freeze({...binding,...additions});
      const entries=[...plan.code,...plan.configs];
      for(let index=0;index<entries.length;index+=32) {
        gate(performance.now()-started<170000,"segmented_install_deadline");
        const group=entries.slice(index,index+32).map(item=>({name:item.name,bytesBase64:item.bytes.toString("base64"),sha256:sha(item.bytes)}));
        await dispatch("segmented-install",{files:group,...(index+32>=entries.length?{prepared:plan.prepared}:{})},Math.floor(180000-(performance.now()-started)));
      }
      return binding;
    },
    async verifyIdentity(context,request) {await base.verifyIdentity(context,request);return binding;},
    async armExpiry(context,request) {
      gate(binding && context.nonce===ctx.nonce && context.database==="radar_rehearsal_"+ctx.nonce &&
        context.schema===context.database+"_schema" && context.role===context.database+"_migrator" && request.binding &&
        request.binding.nonce===binding.nonce && hash(request.identitySha256),"native_test_scope");
      await base.verifyIdentity(context,request);
      const admission=await dispatch("segmented-native-test-admission",{operationId:files.operationId,identitySha256:request.identitySha256},60000,request);
      authenticateNativeTestAdmission(admission,{ctx,identitySha256:request.identitySha256,operationId:files.operationId});
      await base.record({action:"native-test-admission",status:admission.status,nativeAcceptance:"pending",scope:admission.scope,
        nonce:ctx.nonce,identitySha256:request.identitySha256,operationId:files.operationId,manifestSha256:fixedPins.manifestSha256,productionAuthorized:false});
      return base.armExpiry(context,{...request,artifactCodePins:binding.registeredCodePins});
    },
    async verifyExpiry(context,request) {const proof=await base.verifyExpiry(context,request);expiry=proof;return proof;},
    async pause(context,request) { const value=await base.pause(context,request);
      gate(value.phase==="paused","segmented_pause");pausedWindows.add(request.windowNonce);return value; },
    async restore(context,request) {
      gate(!windowInvocations.get(request.windowNonce)?.length || retiredWindows.has(request.windowNonce),"segmented_restore_exit_unproven");
      const value=await base.restore(context,request);pausedWindows.delete(request.windowNonce);return value;
    },
    async runStage(context,work) {
      gate(pausedWindows.has(work.windowNonce) && !retiredWindows.has(work.windowNonce),"segmented_unpaused_window");
      const active=await getRoute();gate(context.nonce===ctx.nonce,"segmented_context");
      if(work.stage==="freeze") {
        freeze=await active.freeze(plan.byStage.verify[0].path,plan.byStage.finalize[0].path,work);
        const report={protocolVersion:2,stage:"freeze",status:"frozen_pending_verification",sealSha256:freeze.sealSha256,freezeSha256:freeze.freezeSha256,
          nativeMetrics:freeze.nativeMetrics,parityComplete:false,productionAuthorized:false};
        return {protocolVersion:2,invocationId:work.invocationId,identitySha256:work.identitySha256,runnerSha256:nativeRunnerSha256,
          sourcePins:fixedPins,exitCode:0,report,reportSha256:sha(JSON.stringify(report))};
      }
      const chosen=work.stage==="import"?plan.byStage.import.find(c=>c.start===work.importStartChunk):
        work.stage==="verify"?plan.byStage.verify.find(c=>c.start===work.verifyStartChunk):plan.byStage[work.stage]?.[0];
      gate(chosen,"segmented_prepared_config_missing");
      const role=["calibrate","import"].includes(work.stage)?"producer":work.stage==="verify"?"verifier":"finalizer";
      const ids=windowInvocations.get(work.windowNonce) ?? [];ids.push(work.invocationId);windowInvocations.set(work.windowNonce,ids);
      await active.registerInvocation({version:1,nonce:ctx.nonce,record_sha256:expiry.recordSha256,invocationId:work.invocationId,request_nonce:chosen.requestNonce,role});
      const native=await active.run({stage:work.stage,configPath:chosen.path,deadlineAtMs:work.deadlineAtMs,
        windowDeadlineAtMs:work.deadlineAtMs+280000,monotonicDeadlineAtMs:work.monotonicDeadlineAtMs,signal:work.signal});
      const raw=native.report;gate(raw?.version===2 && raw.stage===work.stage && raw.requestNonce===chosen.requestNonce &&
        raw.configSha256===chosen.sha256 && raw.nativeMetrics?.uncertainCommit===false &&
        raw.nativeMetrics.commitAttempts===raw.nativeMetrics.acknowledgedCommits,"segmented_native_unknown_ack");
      const report={protocolVersion:2,stage:work.stage,nativeMetrics:raw.nativeMetrics,parityComplete:raw.parityComplete,productionAuthorized:false,
        ...(freeze?{sealSha256:freeze.sealSha256,freezeSha256:freeze.freezeSha256}:{})};
      if(work.stage==="calibrate") {
        gate(raw.result?.status==="calibrated" && raw.result.rollbackObserved===true && raw.nativeMetrics.acknowledgedRollbacks>=1,"segmented_native_calibration");
        Object.assign(report,{status:"calibrated",rollbackObserved:true});
      } else if(work.stage==="import") {
        gate(raw.result?.committedChunks>0 && raw.result.nextChunkIndex>chosen.start && raw.segment?.endChunk===raw.result.nextChunkIndex &&
          raw.segment.startChunk===chosen.start && raw.result.resumedChunks===0 && raw.result.committedChunks===raw.segment.endChunk-raw.segment.startChunk,
          "segmented_zero_progress_or_unreconciled");
        Object.assign(report,{status:raw.segment.endChunk===1548?"import_segments_exhausted":"import_segment_committed",segment:raw.segment});
      } else if(work.stage==="verify") {
        gate(raw.segment?.startChunk===chosen.start && raw.segment.endChunk===chosen.end && raw.segment.sourceSha256===raw.segment.targetSha256,
          "segmented_native_coverage");Object.assign(report,{status:"segment_verified_pending_finalization",segment:raw.segment});
      } else {
        gate(raw.result?.completed===true && raw.parityComplete===true && raw.result.completionOutcome==="acknowledged" &&
          raw.nativeMetrics.acknowledgedCommits>0,"segmented_native_finalize_ack");
        gate(same(raw.counts,{tables:141,rows:6023033,chunks:1548}) && raw.nativeMetrics.finalizeAttempts===1 && raw.nativeMetrics.acknowledgedFinalizations===1,
          "segmented_native_aggregate_ack");
        Object.assign(report,{status:"finalized",coverageSha256:work.coverageSha256,counts:raw.counts});
      }
      return {protocolVersion:2,invocationId:work.invocationId,identitySha256:work.identitySha256,runnerSha256:nativeRunnerSha256,
        sourcePins:fixedPins,exitCode:0,report,reportSha256:sha(JSON.stringify(report)),durableChunks:raw.segment?.endChunk,
        freshSourceValidationComplete:work.stage!=="calibrate",durableBodyReconciliationComplete:work.stage==="import"};
    },
    async verifyInvocationEmpty(context,request) {
      gate(JSON.stringify(windowInvocations.get(request.windowNonce) ?? [])===JSON.stringify(request.invocationIds),"segmented_retirement_scope");
      const proof=await dispatch("managed-independent-empty",{recordSha256:expiry.recordSha256,invocationIds:request.invocationIds,challenge:request.challenge,identitySha256:request.identitySha256},30000,request);
      gate(proof.challenge===request.challenge && proof.identitySha256===request.identitySha256 && proof.proofs?.length===request.invocationIds.length,"segmented_retirement_response");
      for(let index=0;index<proof.proofs.length;index++) {
        const item=proof.proofs[index];gate(item.managedProtocol===1 && item.invocationId===request.invocationIds[index] &&
          item.recordSha256===expiry.recordSha256 && item.cgroupPopulated===0 && item.cgroupProcessCount===0 &&
          /^[a-f0-9]{16}$/.test(item.requestNonce) && ["producer","verifier","finalizer"].includes(item.role) &&
          item.unit==="radar-rehearsal-"+ctx.nonce+"-"+item.role+"-"+item.requestNonce+".service","segmented_retirement_response");
      }
      retiredWindows.add(request.windowNonce);return proof;
    },
    async measureDatabaseFreeze(context,request) {
      const observed=await (await getRoute()).measureFreeze(request.challenge,request);
      return {...observed,identitySha256:request.identitySha256,freezeSha256:freeze.freezeSha256,mutationEpochSha256:observed.identitySha256,
        measuredAtMs:observed.observedAtMs,systemIdentifier:ctx.systemIdentifier};
    },
    async verifyArtifactSeal(context,request) {
      const proof=await (await getRoute()).verifySeal(request);gate(proof.sealSha256===freeze.sealSha256,"segmented_seal_changed");
      return {...binding,...proof,challenge:request.challenge,identitySha256:request.identitySha256,receiptDirectoryUid:0};
    },
    async closeRetained() {if(closed)return;closed=true;if(route)await route.close();},
    async finalCleanup() {if(!binding)return;
      if(expiry) {
        const receipt=await dispatch("segmented-final",{recordSha256:expiry.recordSha256},40000);
        gate(receipt.action==="cleanup" && receipt.authority==="final" && receipt.status==="deleted" && receipt.deadline*1000===expiry.expiresAtMs &&
          ["deleted","already-deleted"].includes(receipt.private_pg?.status) && ["deleted","already-deleted"].includes(receipt.artifacts?.status),"segmented_final_cleanup_unconfirmed");
      }
      else await dispatch("segmented-discard",{},40000);
    },
  };
}


export function authenticateNativeTestAdmission(proof,{ctx,identitySha256,operationId}) {
  const target=proof?.target;
  gate(proof?.status==="native-test-admitted" && proof.nativeAcceptance==="pending" &&
    proof.scope==="fixed-immutable-rehearsal-private-pg16" && proof.nonce===ctx.nonce && proof.identitySha256===identitySha256 &&
    proof.source?.path==="/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle/manifest.json" &&
    proof.source.manifestSha256===fixedPins.manifestSha256 && proof.source.operationId===operationId &&
    proof.source.seal?.fileCount===1549 && count(proof.source.seal.rootDevice) && count(proof.source.seal.rootInode) &&
    Number.isInteger(proof.source.seal.rootImmutableFlags) && (proof.source.seal.rootImmutableFlags & 0x10)!==0 &&
    target?.database===ctx.database && target.port===5434 && target.systemIdentifier===ctx.systemIdentifier && target.role===ctx.role &&
    target.schemaOwner===ctx.role && target.connectionLimit===1 && target.memberships===0 &&
    ["superuser","createDatabase","createRole","replication","bypassRls"].every(key=>target[key]===false),"native_test_admission_unverified");
  return proof;
}

/** Explicit bounded read-only host query; never creates a fixture or arms anything. */
export async function readPinnedRehearsalOperationId({transport=createFixedTransport()}={}) {
  const source=await transport({action:"source-operation-id",nonce:randomBytes(8).toString("hex"),operationSeconds:20},30000);
  gate(source?.path==="/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle/manifest.json" &&
    source.manifestSha256===fixedPins.manifestSha256 && typeof source.operationId==="string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(source.operationId),"source_operation_receipt");
  return source;
}
