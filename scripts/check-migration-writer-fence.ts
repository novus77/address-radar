import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { CUTOVER_SERVICES, CUTOVER_TIMERS, evaluateMigrationWriterFence, migrationCutoverCanonicalJson, migrationCutoverDigest } from "../packages/database/src/migration-cutover-coordinator.js";

// Saved evidence and explicitly scoped read-only census only. No store, PG, service mutation or authority.
function readJson(path: string): unknown {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor), maximum = 8_388_608;
    if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid artifact");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size <= maximum) {
      const bytes = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (bytes === 0) break;
      size += bytes;
    }
    if (size > maximum) throw new Error("Artifact too large");
    return JSON.parse(buffer.toString("utf8", 0, size));
  } finally { closeSync(descriptor); }
}
const inactive = { readOnly: true, preparationReady: false, writeAuthorized: false, activationEnabled: false };
function savedEvidenceMain(args: string[]): void {
try {
  const allowed = new Set(["--bundle", "--expected-policy", "--expected-policy-sha256"]);
  const values = new Map<string, string>();
  if (args.length !== allowed.size * 2) throw new Error("Invalid arguments");
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1]!;
    if (!allowed.has(flag) || values.has(flag) || !value.trim()) throw new Error("Invalid arguments");
    values.set(flag, value);
  }
  const pinned = values.get("--expected-policy-sha256")!;
  if (!/^[a-f0-9]{64}$/.test(pinned)) throw new Error("Invalid policy pin");
  const policy = readJson(values.get("--expected-policy")!);
  if (migrationCutoverDigest(policy) !== pinned) throw new Error("Policy pin mismatch");
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)
    || (policy as Record<string, unknown>).evidenceMode !== "production-observation") {
    process.stdout.write(JSON.stringify({ ...inactive, error: "FIXTURE_POLICY_NOT_PRODUCTION" }) + "\n");
    process.exitCode = 2;
  } else {
    const result = evaluateMigrationWriterFence(readJson(values.get("--bundle")!), policy, new Date().toISOString());
    process.stdout.write(JSON.stringify({ readOnly: true, ...result }) + "\n");
    process.exitCode = result.preparationReady ? 0 : 1;
  }
} catch {
  process.stdout.write(JSON.stringify({ ...inactive, error: "INVALID_INPUT" }) + "\n");
  process.exitCode = 2;
}

}


export function parseWriterCensusListing(surface: string, text: string): Array<Record<string, string>> {
  return text.split(/\r?\n/).filter(line => line.trim()).map<Record<string,string>>((line): Record<string,string> => {
    const fields = line.trim().split(/\s+/);
    if (surface === "units" && censusUnit.test(fields[0] ?? "")) return { unit: fields[0]!, load: fields[1] ?? "", active: fields[2] ?? "", sub: fields[3] ?? "" };
    if (surface === "unit-files" && censusUnit.test(fields[0] ?? "")) return { unit: fields[0]!, state: fields[1] ?? "", preset: fields[2] ?? "" };
    if (surface === "timers") {
      const index = fields.findIndex(field => field.endsWith(".timer") && censusUnit.test(field));
      if (index >= 0) return { unit: fields[index]!, activates: censusUnit.test(fields[index + 1] ?? "") ? fields[index + 1]! : "", boundary: safeDiagnostic(fields.slice(0, index).join(" ")) };
    }
    if (surface === "sessions" && /^[A-Za-z0-9_-]+$/.test(fields[0] ?? "") && /^\d+$/.test(fields[1] ?? "") && censusName.test(fields[2] ?? "")) {
      return { session: fields[0]!, uid: fields[1]!, owner: fields[2]!, seat: fields[3] ?? "", tty: fields[4] ?? "" };
    }
    return { unparsedSha256: censusHash(line) };
  });
}

export const WRITER_PROCESS_CENSUS_BOUNDS = { maximumProcesses: 128, maximumFdsPerProcess: 256, maximumTotalFds: 4096, maximumCgroups: 64, maximumTasks: 32, maximumElapsedMs: 2000 } as const;
// Exact script bytes are allowlisted by the native executor. No cmdline, environ, data or global /proc walk.
export const WRITER_PROCESS_CENSUS_PYTHON = String.raw`
import os, sys, json, time, stat, errno, re
spec=json.loads(sys.argv[1]); files=spec['files']; roots=spec['roots']; start=time.monotonic()
bounds={'maximumProcesses':128,'maximumFdsPerProcess':256,'maximumTotalFds':4096,'maximumCgroups':64,'maximumTasks':32,'maximumElapsedMs':2000}
errors=[]; truncated=False; processes=[]; totalfds=0; cgcount=0

def error(operation, cause, pid=None):
    status='denied' if cause.errno in (errno.EACCES,errno.EPERM) else 'unavailable' if cause.errno in (errno.ENOENT,errno.ESRCH) else 'unknown'
    errors.append({'operation':operation,'pid':pid,'status':status,'errno':cause.errno})
    return status

def budget():
    global truncated
    if (time.monotonic()-start)*1000 >= bounds['maximumElapsedMs']:
        truncated=True; raise TimeoutError('bounded-reader-deadline')

def entries(path, maximum):
    global truncated
    result=[]
    with os.scandir(path) as iterator:
        for item in iterator:
            budget()
            if len(result)>=maximum: truncated=True; break
            result.append(item.name)
    return result

def read(path, maximum=16384):
    global truncated
    budget()
    with open(path,'r') as stream: result=stream.read(maximum+1)
    if len(result)>maximum: truncated=True; return result[:maximum]
    return result

def source_metadata():
    result=[]
    for path in files:
        try:
            s=os.stat(path)
            result.append({'path':path,'status':'present','device':str(s.st_dev),'inode':str(s.st_ino),'mode':'regular' if stat.S_ISREG(s.st_mode) else 'other','resolvedPath':os.path.realpath(path)})
        except OSError as cause:
            result.append({'path':path,'status':'absent' if cause.errno==errno.ENOENT else 'denied' if cause.errno in (errno.EACCES,errno.EPERM) else 'unknown','errno':cause.errno})
    return result

before=source_metadata(); identities={(x['device'],x['inode']):x['path'] for x in before if x['status']=='present'}
queue=[]; members={}; seen=set()
def enqueue(pid, unit):
    global truncated
    if pid<=0: return
    members.setdefault(pid,set()).add(unit)
    if pid not in seen and pid not in queue:
        if len(seen)+len(queue)>=128: truncated=True
        else: queue.append(pid)
try:
    for root in roots:
        enqueue(root['pid'],root['unit'])
        if root['cgroup']:
            cgroot=os.path.realpath('/sys/fs/cgroup'+root['cgroup'])
            if not cgroot.startswith('/sys/fs/cgroup/'): errors.append({'operation':'cgroup-path','pid':None,'status':'unknown','errno':None}); continue
            cgqueue=[cgroot]
            while cgqueue:
                budget(); cg=cgqueue.pop(0); cgcount+=1
                if cgcount>64: truncated=True; break
                try:
                    for pid in read(cg+'/cgroup.procs').split():
                        if pid.isdigit(): enqueue(int(pid),root['unit'])
                    for name in entries(cg,64):
                        path=cg+'/'+name
                        if not os.path.islink(path) and os.path.isdir(path): cgqueue.append(path)
                except OSError as cause: error('cgroup-read',cause)
    while queue:
        budget(); pid=queue.pop(0); seen.add(pid)
        row={'pid':pid,'ppid':0,'uid':0,'command':'unknown','startTimeTicks':'0','units':sorted(members.get(pid,set())),'status':'unknown','fdsExamined':0,'handles':[]}
        processes.append(row)
        try:
            value=read('/proc/'+str(pid)+'/stat'); end=value.rfind(')'); tail=value[end+2:].split()
            row['ppid']=int(tail[1]); row['startTimeTicks']=tail[19]
            command=value[value.find('(')+1:end]; row['command']=command if re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',command) else 'redacted'
            row['uid']=os.stat('/proc/'+str(pid)).st_uid
            for task in entries('/proc/'+str(pid)+'/task',32):
                if not task.isdigit(): continue
                try:
                    for child in read('/proc/'+str(pid)+'/task/'+task+'/children').split():
                        if child.isdigit():
                            for unit in row['units']: enqueue(int(child),unit)
                except OSError as cause: error('children-read',cause,pid)
            for fd in entries('/proc/'+str(pid)+'/fd',256):
                if not fd.isdigit(): continue
                if totalfds>=4096: truncated=True; break
                totalfds+=1; row['fdsExamined']+=1
                try:
                    path='/proc/'+str(pid)+'/fd/'+fd; target=os.readlink(path); clean=target.removesuffix(' (deleted)'); s=os.stat(path)
                    identity=(str(s.st_dev),str(s.st_ino)); matched=clean if clean in files else identities.get(identity)
                    if matched is None: continue
                    info=dict(line.split(':',1) for line in read('/proc/'+str(pid)+'/fdinfo/'+fd).splitlines() if ':' in line)
                    flags=info.get('flags','').strip()
                    if not re.fullmatch(r'[0-7]{1,16}',flags): errors.append({'operation':'fd-flags','pid':pid,'status':'unknown','errno':None}); continue
                    row['handles'].append({'fd':int(fd),'path':matched,'device':identity[0],'inode':identity[1],'flagsOctal':flags,'matchedBy':'path-and-inode' if clean in files and identities.get(identity)==clean and clean==target else 'alias-or-replaced-inode'})
                except OSError as cause: error('fd-read',cause,pid)
            check=read('/proc/'+str(pid)+'/stat'); tail2=check[check.rfind(')')+2:].split()
            if tail2[19]!=row['startTimeTicks']: errors.append({'operation':'pid-reused','pid':pid,'status':'unknown','errno':None})
            row['status']='unknown' if truncated or any(e['pid']==pid for e in errors) else 'present' if row['handles'] else 'absent'
        except OSError as cause: row['status']=error('process-read',cause,pid)
except TimeoutError:
    truncated=True
    errors.append({'operation':'deadline','pid':None,'status':'unavailable','errno':None})
after=source_metadata()
print(json.dumps({'version':1,'sourceFiles':files,'bounds':bounds,'sourceMetadata':before,'processes':processes,'errors':errors,'truncated':truncated,'sourceChanged':before!=after,'elapsedMs':int((time.monotonic()-start)*1000)}))
`;

export function parseWriterProcessCensus(text: string, sourceFiles: string[]): {
  sourceMetadata: Array<Record<string, unknown>>; processes: Array<Record<string, unknown> & { handles: Array<Record<string, unknown>> }>;
  errors: Array<Record<string, unknown>>; truncated: boolean; sourceChanged: boolean; elapsedMs: number;
} {
  const value = censusKeys(JSON.parse(text), ["version", "sourceFiles", "bounds", "sourceMetadata", "processes", "errors", "truncated", "sourceChanged", "elapsedMs"]);
  if (value.version !== 1 || JSON.stringify(value.sourceFiles) !== JSON.stringify(sourceFiles) || migrationCutoverDigest(value.bounds) !== migrationCutoverDigest(WRITER_PROCESS_CENSUS_BOUNDS)
    || typeof value.truncated !== "boolean" || typeof value.sourceChanged !== "boolean" || !censusInteger(value.elapsedMs, 0, 10000)) throw new Error("Invalid process census envelope");
  const status = (v: unknown) => typeof v === "string" && ["present", "absent", "denied", "unavailable", "unknown"].includes(v);
  const decimal = (v: unknown) => typeof v === "string" && /^\d{1,30}$/.test(v);
  const metadata = censusArray(value.sourceMetadata).map(item => {
    const row = censusObject(item);
    if (!sourceFiles.includes(row.path as string) || !status(row.status)) throw new Error("Invalid source stat");
    if (row.status === "present" && (!decimal(row.device) || !decimal(row.inode) || !["regular", "other"].includes(row.mode as string) || typeof row.resolvedPath !== "string" || !row.resolvedPath.startsWith("/") || /[\x00-\x1f\x7f]/.test(row.resolvedPath))) throw new Error("Invalid source stat");
    if (row.status !== "present" && !censusInteger(row.errno, 1, 4096)) throw new Error("Invalid source errno");
    return row.status === "present" ? {path:row.path,status:row.status,device:row.device,inode:row.inode,mode:row.mode,resolvedPath:row.resolvedPath} : {path:row.path,status:row.status,errno:row.errno};
  });
  if (metadata.length !== 3 || !censusUnique(metadata.map(row => row.path as string))) throw new Error("Incomplete source stat");
  const processes = censusArray(value.processes).map<Record<string,unknown> & { handles:Array<Record<string,unknown> & { access:string;writable:boolean }> }>(item => {
    const row = censusKeys(item, ["pid", "ppid", "uid", "command", "startTimeTicks", "units", "status", "fdsExamined", "handles"]);
    if (!censusInteger(row.pid, 1, 2147483647) || !censusInteger(row.ppid, 0, 2147483647) || !censusInteger(row.uid, 0, 4294967295) || !decimal(row.startTimeTicks)
      || typeof row.command !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(row.command) || !status(row.status) || !censusInteger(row.fdsExamined, 0, 256)
      || censusArray(row.units).some(unit => typeof unit !== "string" || !CUTOVER_SERVICES.some(known => known === unit))) throw new Error("Invalid process metadata");
    const handles = censusArray(row.handles).map<Record<string,unknown> & { access: string; writable: boolean }>(item => {
      const handle = censusKeys(item, ["fd", "path", "device", "inode", "flagsOctal", "matchedBy"]);
      if (!censusInteger(handle.fd, 0, 2147483647) || !sourceFiles.includes(handle.path as string) || !decimal(handle.device) || !decimal(handle.inode)
        || typeof handle.flagsOctal !== "string" || !/^[0-7]{1,16}$/.test(handle.flagsOctal) || !["path-and-inode", "alias-or-replaced-inode"].includes(handle.matchedBy as string)) throw new Error("Invalid FD metadata");
      const access = Number(BigInt("0o" + handle.flagsOctal) & 3n);
      return { ...handle, access: access === 0 ? "read-only" : access === 1 ? "write-only" : access === 2 ? "read-write" : "unknown", writable: access === 1 || access === 2 };
    });
    if (handles.length > row.fdsExamined || !censusUnique(handles.map(h => String(h.fd)))) throw new Error("Invalid handle count");
    return { ...row, handles };
  });
  if (processes.length > 128 || !censusUnique(processes.map(row => String(row.pid))) || processes.reduce((n,row) => n + Number(row.fdsExamined), 0) > 4096) throw new Error("Process bound exceeded");
  const errors = censusArray(value.errors).map(item => {
    const row = censusKeys(item, ["operation", "pid", "status", "errno"]);
    if (typeof row.operation !== "string" || !/^[a-z-]{1,64}$/.test(row.operation) || !status(row.status) || (row.pid !== null && !censusInteger(row.pid, 1, 2147483647))
      || (row.errno !== null && !censusInteger(row.errno, 1, 4096))) throw new Error("Invalid kernel error");
    return row;
  });
  return { sourceMetadata:metadata, processes, errors, truncated:value.truncated, sourceChanged:value.sourceChanged, elapsedMs:value.elapsedMs };
}

export type WriterCensusStatus = "present" | "absent" | "denied" | "unavailable" | "unknown";
export interface WriterCensusPolicy {
  version: 1; host: string;
  sourceFiles: string[];
  users: string[];
  units: Array<{ unit: string; owner: string | null; writerId: string | null }>;
  cronLines: Array<{ owner: string; lineSha256: string; writerId: string }>;
  operatorSessions: Array<{ session: string; owner: string; writerId: string }>;
  processCommands: Array<{ command: string; writerId: string }>;
  inputs: Array<{ id: string; kind: "deploy" | "external"; unit: string | null }>;
  limits: { maximumCommands: number; commandTimeoutMs: number; operationTimeoutMs: number; maximumOutputBytes: number };
}
export interface WriterCensusCommand {
  id: string; executable: "hostname" | "systemctl" | "sudo" | "loginctl" | "lsof";
  args: readonly string[]; timeoutMs: number; maximumOutputBytes: number;
}
export interface WriterCensusCommandResult {
  stdout: string; stderr: string; exitCode: number | null;
  error: "not-found" | "denied" | "timeout" | "output-limit" | "unavailable" | null;
}
export interface WriterCensusObservation {
  id: string; surface: string; owner: string | null; status: WriterCensusStatus; reason: string;
  raw: { stdout: string; stderr: string; stdoutSha256: string; stderrSha256: string; exitCode: number | null; error: WriterCensusCommandResult["error"] };
  metadata?: unknown;
  entries: Array<{ id: string; writerId: string | null; status: WriterCensusStatus; detail: string }>;
}
export interface WriterCensusReport {
  version: 1; readOnly: true; policySha256: string; observedAt: string; completedAt: string;
  coverage: "configured-scopes-only"; censusComplete: boolean; fenceEstablished: false;
  preparationReady: false; writeAuthorized: false; activationEnabled: false;
  commandsExecuted: number; observations: WriterCensusObservation[]; blockers: string[];
}
const censusHash = (text: string) => createHash("sha256").update(text).digest("hex");
const censusName = /^[a-z_][a-z0-9_-]{0,63}$/;
const censusUnit = /^[A-Za-z0-9_@:.\-]{1,200}\.(?:service|timer)$/;
function censusObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid census object");
  return value as Record<string, unknown>;
}
function censusKeys(value: unknown, names: readonly string[]): Record<string, unknown> {
  const result = censusObject(value);
  if (Object.keys(result).length !== names.length || names.some(name => !Object.hasOwn(result, name))) throw new Error("Invalid census fields");
  return result;
}
function censusArray(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Invalid census array"); return value; }
function censusUnique(values: string[]): boolean { return new Set(values).size === values.length; }
function censusInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function validateWriterCensusPolicy(input: unknown): WriterCensusPolicy {
  const normalized = JSON.parse(migrationCutoverCanonicalJson(input)) as unknown;
  const p = censusKeys(normalized, ["version", "host", "sourceFiles", "users", "units", "cronLines", "operatorSessions", "processCommands", "inputs", "limits"]);
  if (p.version !== 1 || typeof p.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(p.host)) throw new Error("Invalid census host");
  const files = censusArray(p.sourceFiles);
  if (files.length !== 3 || files.some(file => typeof file !== "string" || !file.startsWith("/") || posix.normalize(file) !== file || /[\x00-\x1f\x7f]/.test(file))
    || files[1] !== files[0] + "-wal" || files[2] !== files[0] + "-shm") throw new Error("Explicit SQLite file scope required");
  const users = censusArray(p.users);
  if (!users.length || users.length > 8 || users.some(user => typeof user !== "string" || !censusName.test(user)) || !censusUnique(users as string[])
    || !users.includes("address-radar")) throw new Error("Explicit service-user scope required");
  const units = censusArray(p.units).map(unit => censusKeys(unit, ["unit", "owner", "writerId"]));
  if (!units.length || units.length > 256 || !censusUnique(units.map(unit => `${unit.owner ?? "system"}:${unit.unit}`))
    || units.some(unit => typeof unit.unit !== "string" || !censusUnit.test(unit.unit) || (unit.owner !== null && !users.includes(unit.owner))
      || (unit.writerId !== null && (typeof unit.writerId !== "string" || !unit.writerId.length || unit.writerId.length > 256)))
    || [...CUTOVER_SERVICES, ...CUTOVER_TIMERS].some(name => !units.some(unit => unit.owner === null && unit.unit === name && unit.writerId !== null))) throw new Error("Incomplete approved writer unit scope");
  for (const value of censusArray(p.cronLines)) {
    const row = censusKeys(value, ["owner", "lineSha256", "writerId"]);
    if (!users.includes(row.owner) || typeof row.lineSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.lineSha256) || typeof row.writerId !== "string" || !row.writerId) throw new Error("Invalid approved cron scope");
  }
  for (const value of censusArray(p.operatorSessions)) {
    const row = censusKeys(value, ["session", "owner", "writerId"]);
    if (typeof row.session !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.session) || !users.includes(row.owner) || typeof row.writerId !== "string" || !row.writerId) throw new Error("Invalid approved operator scope");
  }
  for (const value of censusArray(p.processCommands)) {
    const row = censusKeys(value, ["command", "writerId"]);
    if (typeof row.command !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(row.command) || typeof row.writerId !== "string" || !row.writerId) throw new Error("Invalid approved process scope");
  }
  const inputs = censusArray(p.inputs).map(value => censusKeys(value, ["id", "kind", "unit"]));
  if (inputs.length > 128 || !censusUnique(inputs.map(row => String(row.id))) || inputs.some(row => typeof row.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(row.id)
    || !["deploy", "external"].includes(row.kind as string) || (row.unit !== null && !units.some(unit => unit.owner === null && unit.unit === row.unit)))
    || !["deploy", "external"].every(kind => inputs.some(row => row.kind === kind))) throw new Error("Explicit deploy and external scopes required");
  const limits = censusKeys(p.limits, ["maximumCommands", "commandTimeoutMs", "operationTimeoutMs", "maximumOutputBytes"]);
  if (!censusInteger(limits.maximumCommands, 1, 64) || !censusInteger(limits.commandTimeoutMs, 1, 3000)
    || !censusInteger(limits.operationTimeoutMs, 1, 30000) || limits.commandTimeoutMs > limits.operationTimeoutMs
    || !censusInteger(limits.maximumOutputBytes, 256, 32768)) throw new Error("Unbounded census limits");
  return p as unknown as WriterCensusPolicy;
}


function validateCensusReadCommand(input: WriterCensusCommand): WriterCensusCommand {
  const checked = censusKeys(JSON.parse(migrationCutoverCanonicalJson(input)), ["id", "executable", "args", "timeoutMs", "maximumOutputBytes"]);
  const args = censusArray(checked.args);
  if (typeof checked.id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(checked.id) || args.some((value,index) => typeof value !== "string" || (/[\x00-\x1f\x7f]/.test(value) && !(checked.executable === "sudo" && index === 3 && value === WRITER_PROCESS_CENSUS_PYTHON)))
    || !censusInteger(checked.timeoutMs, 1, 3000) || !censusInteger(checked.maximumOutputBytes, 256, 32768)) throw new Error("Read-only census command required");
  const same = (expected: string[]) => JSON.stringify(args) === JSON.stringify(expected);
  const systemctl = (values: unknown[]) => [
    ["--all", "--full", "--plain", "--no-legend", "--no-pager", "list-units", "--type=service,timer"],
    ["--full", "--no-legend", "--no-pager", "list-unit-files", "--type=service,timer"],
    ["--all", "--full", "--no-legend", "--no-pager", "list-timers"],
  ].some(expected => JSON.stringify(values) === JSON.stringify(expected));
  let allowed = checked.executable === "hostname" && same([]);
  if (checked.executable === "systemctl") {
    allowed = systemctl(args);
    const prefix=["show","--no-pager","--property=Id","--property=MainPID","--property=ActiveState","--property=SubState","--property=ControlGroup"];
    if (JSON.stringify(args.slice(0,prefix.length)) === JSON.stringify(prefix)) allowed = args.length === prefix.length + CUTOVER_SERVICES.length && CUTOVER_SERVICES.every(unit => args.slice(prefix.length).includes(unit));
  }
  if (checked.executable === "loginctl") allowed = same(["--no-legend", "--no-pager", "list-sessions"]);
  if (checked.executable === "sudo" && args[0] === "-n" && args[1] === "-u" && typeof args[2] === "string" && censusName.test(args[2])) {
    allowed = args[3] === "crontab" && args[4] === "-l" && args.length === 5;
    if (args[3] === "systemctl" && args[4] === "--user") allowed = systemctl(args.slice(5));
  }
  if (checked.executable === "lsof" && args.length === 6 && args[0] === "-nP" && args[1] === "-FpcfaiDn" && args[2] === "--") {
    const path = args[3];
    allowed = typeof path === "string" && path.startsWith("/") && path !== "/" && posix.normalize(path) === path
      && args[4] === path + "-wal" && args[5] === path + "-shm";
  }
  if (checked.executable === "sudo" && args[0] === "-n" && args[1] === "lsof") {
    const tail=args.slice(2), path=tail[3];
    allowed=tail.length===6 && tail[0]==="-nP" && tail[1]==="-FpcfaiDn" && tail[2]==="--" && typeof path==="string" && path.startsWith("/") && path!=="/" && posix.normalize(path)===path && tail[4]===path+"-wal" && tail[5]===path+"-shm";
  }
  if (checked.executable === "sudo" && args.length===5 && args[0]==="-n" && args[1]==="python3" && args[2]==="-c" && args[3]===WRITER_PROCESS_CENSUS_PYTHON) {
    const spec=censusKeys(JSON.parse(args[4] as string),["files","roots"]), files=censusArray(spec.files), roots=censusArray(spec.roots);
    allowed=files.length===3 && typeof files[0]==="string" && files[0].startsWith("/") && files[0]!=="/" && posix.normalize(files[0])===files[0] && !/[\x00-\x1f\x7f]/.test(files[0]) && files[1]===files[0]+"-wal" && files[2]===files[0]+"-shm" && roots.length<=CUTOVER_SERVICES.length;
    for(const entry of roots) {
      const root=censusKeys(entry,["unit","pid","cgroup"]);
      allowed=allowed && typeof root.unit==="string" && CUTOVER_SERVICES.some(known => known === root.unit) && censusInteger(root.pid,0,2147483647) && typeof root.cgroup==="string" && (root.cgroup==="" || (root.cgroup.startsWith("/") && root.cgroup!=="/" && posix.normalize(root.cgroup)===root.cgroup && /^\/[A-Za-z0-9_@:.\/-]+$/.test(root.cgroup)));
    }
  }
  if (!allowed) throw new Error("Read-only census command required");
  return checked as unknown as WriterCensusCommand;
}

/** Bounds only this scanner's read-command child; never signals a production service or unit. */
export async function executeWriterCensusCommand(input: WriterCensusCommand): Promise<WriterCensusCommandResult> {
  const request = validateCensusReadCommand(input);
  return new Promise(resolve => {
    let stdout = "", stderr = "", bytes = 0, error: WriterCensusCommandResult["error"] = null, finished = false;
    const child = spawn(request.executable, [...request.args], { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" } });
    const finish = (exitCode: number | null) => {
      if (finished) return; finished = true; clearTimeout(timer); resolve({ stdout, stderr, exitCode, error });
    };
    const terminateOwnReader = (reason: "timeout" | "output-limit") => {
      error = reason;
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* Only this owned reader can be signaled. */ } }
      finish(null);
    };
    const timer = setTimeout(() => terminateOwnReader("timeout"), request.timeoutMs);
    const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
      if (finished) return;
      const remaining = Math.max(0, request.maximumOutputBytes - bytes), text = chunk.subarray(0, remaining).toString("utf8");
      if (target === "stdout") stdout += text; else stderr += text;
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) terminateOwnReader("output-limit");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout")); child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", cause => { error = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "not-found" : (cause as NodeJS.ErrnoException).code === "EACCES" ? "denied" : "unavailable"; finish(null); });
    child.on("close", finish);
  });
}
function diagnosticStatus(result: WriterCensusCommandResult, cronOwner?: string): WriterCensusStatus {
  if (result.error === "denied" || /permission denied|access denied|not permitted|not allowed|password is required|authentication.*required/i.test(result.stderr)) return "denied";
  if (/^(?:not_available|not available)$/i.test(result.stdout.trim())) return "unavailable";
  if (result.error || result.exitCode === 127 || /not_available|command not found|failed to connect to bus|no such file|not available/i.test(result.stderr)) return "unavailable";
  if (cronOwner && result.exitCode === 1 && result.stdout.trim() === "" && result.stderr.trim() === `no crontab for ${cronOwner}`) return "absent";
  if (result.exitCode !== 0 || result.stderr.trim()) return "unknown";
  return result.stdout.trim() === "" ? "absent" : "present";
}
function safeDiagnostic(text: string): string {
  return text.replace(/\b(?:[a-z][a-z0-9+.-]*):\/\/\S+/gi, "[URL redacted]")
    .replace(/\b(?:password|passwd|token|secret|credential|authorization|api[_-]?key)\s*[:=]\s*\S+/gi, "[credential redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}
function sanitizedCron(text: string): string {
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return "";
    if (line.trimStart().startsWith("#")) return `[comment redacted sha256=${censusHash(line)}]`;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line.trim())) return `[environment redacted sha256=${censusHash(line)}]`;
    const fields = line.trim().split(/\s+/);
    const macros = ["@reboot", "@hourly", "@daily", "@weekly", "@monthly", "@yearly", "@annually", "@midnight"];
    const numeric = fields.length >= 6 && fields.slice(0, 5).every(field => /^[*0-9,/\-]+$/.test(field.replace(/(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)/gi, "1")));
    const schedule = macros.includes(fields[0] ?? "") ? fields[0]! : numeric ? fields.slice(0, 5).join(" ") : "[schedule redacted]";
    return `${schedule} [command redacted sha256=${censusHash(line)}]`;
  }).join("\n");
}

/** Current observations only. No saved output, empty listing or read operation establishes a future fence. */
export async function collectWriterCensus(input: unknown, ports: {
  execute: (command: WriterCensusCommand) => Promise<WriterCensusCommandResult>; clock: () => number;
}): Promise<WriterCensusReport> {
  const policy = validateWriterCensusPolicy(input), start = ports.clock();
  if (!Number.isSafeInteger(start) || start <= 0) throw new Error("Invalid census clock");
  const report: WriterCensusReport = { version: 1, readOnly: true, policySha256: migrationCutoverDigest(policy),
    observedAt: new Date(start).toISOString(), completedAt: new Date(start).toISOString(), coverage: "configured-scopes-only",
    censusComplete: false, fenceEstablished: false, preparationReady: false, writeAuthorized: false, activationEnabled: false,
    commandsExecuted: 0, observations: [], blockers: ["READ_ONLY_CENSUS_NOT_A_FENCE"] };
  const block = (code: string) => { if (!report.blockers.includes(code)) report.blockers.push(code); };
  const processRaw = new Map<string,string>();
  const inspect = async (id: string, surface: string, owner: string | null, executable: WriterCensusCommand["executable"], args: string[]): Promise<WriterCensusObservation> => {
    const current = ports.clock(), remaining = start + policy.limits.operationTimeoutMs - current;
    let result: WriterCensusCommandResult;
    if (!Number.isSafeInteger(current) || current < start || remaining <= 0 || report.commandsExecuted >= policy.limits.maximumCommands) {
      result = { stdout: "", stderr: "", exitCode: null, error: "unavailable" }; block("CENSUS_OPERATION_OR_COMMAND_BUDGET_EXHAUSTED");
    } else {
      report.commandsExecuted++;
      try { result = await ports.execute({ id, executable, args, timeoutMs: Math.min(remaining, policy.limits.commandTimeoutMs), maximumOutputBytes: policy.limits.maximumOutputBytes }); }
      catch { result = { stdout: "", stderr: "", exitCode: null, error: "unavailable" }; }
      if (typeof result.stdout !== "string" || typeof result.stderr !== "string" || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > policy.limits.maximumOutputBytes) {
        result = { stdout: "", stderr: "", exitCode: null, error: "output-limit" };
      }
      if (ports.clock() < current || ports.clock() >= start + policy.limits.operationTimeoutMs) { result.error = "timeout"; block("CENSUS_OPERATION_DEADLINE_EXCEEDED"); }
    }
    if(surface === "processes") processRaw.set(id,result.stdout);
    const emptyHandleMatch = surface === "handles" && result.exitCode === 1 && result.error === null && !result.stdout.trim() && !result.stderr.trim();
    const observation: WriterCensusObservation = { id, surface, owner, status: emptyHandleMatch ? "absent" : diagnosticStatus(result, surface === "cron" ? owner! : undefined), reason: result.error ?? "command-result",
      raw: { stdout: surface === "cron" ? sanitizedCron(result.stdout) : ["units", "unit-files"].includes(surface) ? safeDiagnostic(result.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/).slice(0, surface === "units" ? 4 : 3).join(" ")).join("\n")) : safeDiagnostic(result.stdout),
        stderr: result.stderr ? `[diagnostic redacted sha256=${censusHash(result.stderr)}]` : "",
        stdoutSha256: censusHash(result.stdout), stderrSha256: censusHash(result.stderr), exitCode: result.exitCode, error: result.error }, entries: [] };
    report.observations.push(observation);
    if (["denied", "unavailable", "unknown"].includes(observation.status)) block(`INCOMPLETE:${id}:${observation.status}`);
    // Parsed cron data is never retained in plaintext beyond this command's local processing.
    if (surface === "cron" && observation.status === "present") {
      for (const line of result.stdout.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith("#"))) {
        const approved = policy.cronLines.find(entry => entry.owner === owner && entry.lineSha256 === censusHash(line));
        observation.entries.push({ id: censusHash(line), writerId: approved?.writerId ?? null, status: approved ? "present" : "unknown", detail: "cron-line-sha256" });
        if (!approved) block(`UNKNOWN_CRON_WRITER:${owner}`);
      }
    }
    if (surface === "hostname" && (observation.status !== "present" || result.stdout.trim() !== policy.host)) block("CENSUS_HOST_MISMATCH_OR_NOT_PROVEN");
    return observation;
  };
  const units = (observation: WriterCensusObservation, kind: "live" | "files" | "timers") => {
    if (observation.status !== "present") return;
    for (const line of observation.raw.stdout.split(/\r?\n/).filter(line => line.trim())) {
      const fields = line.trim().split(/\s+/), names = kind === "timers" ? line.match(/[A-Za-z0-9_@:.\-]+\.(?:service|timer)/g) ?? [] : [fields[0]!];
      if (!names.length || names.some(name => !censusUnit.test(name))) { observation.status = "unknown"; block(`UNPARSED_UNIT_CENSUS:${observation.id}`); continue; }
      const scheduled = kind !== "files" || ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(fields[1] ?? "");
      for (const name of names) {
        const approved = policy.units.find(entry => entry.owner === observation.owner && entry.unit === name);
        observation.entries.push({ id: name, writerId: approved?.writerId ?? null, status: approved ? "present" : "unknown", detail: safeDiagnostic(kind === "timers" ? "timer/activates" : fields.slice(1, 4).join(" ")) });
        if (!approved) block(`${scheduled ? "UNKNOWN_UNIT_OR_SCHEDULED_WRITER" : "UNREVIEWED_INACTIVE_UNIT"}:${observation.owner ?? "system"}:${name}`);
      }
    }
  };
  await inspect("host", "hostname", null, "hostname", []);
  const liveArgs = ["--all", "--full", "--plain", "--no-legend", "--no-pager", "list-units", "--type=service,timer"];
  const fileArgs = ["--full", "--no-legend", "--no-pager", "list-unit-files", "--type=service,timer"];
  units(await inspect("system-live", "units", null, "systemctl", liveArgs), "live");
  units(await inspect("system-files", "unit-files", null, "systemctl", fileArgs), "files");
  units(await inspect("system-timers", "timers", null, "systemctl", ["--all", "--full", "--no-legend", "--no-pager", "list-timers"]), "timers");
  for (const user of policy.users) {
    units(await inspect(`user-live:${user}`, "units", user, "sudo", ["-n", "-u", user, "systemctl", "--user", ...liveArgs]), "live");
    units(await inspect(`user-files:${user}`, "unit-files", user, "sudo", ["-n", "-u", user, "systemctl", "--user", ...fileArgs]), "files");
    units(await inspect(`user-timers:${user}`, "timers", user, "sudo", ["-n", "-u", user, "systemctl", "--user", "--all", "--full", "--no-legend", "--no-pager", "list-timers"]), "timers");
    await inspect(`cron:${user}`, "cron", user, "sudo", ["-n", "-u", user, "crontab", "-l"]);
  }
  const sessions = await inspect("operator-sessions", "sessions", null, "loginctl", ["--no-legend", "--no-pager", "list-sessions"]);
  if (sessions.status === "present") for (const line of sessions.raw.stdout.split(/\r?\n/).filter(line => line.trim())) {
    const [session, uid, owner] = line.trim().split(/\s+/);
    const approved = policy.operatorSessions.find(entry => entry.session === session && entry.owner === owner);
    const valid = typeof uid === "string" && /^\d+$/.test(uid) && typeof session === "string" && typeof owner === "string";
    sessions.entries.push({ id: session ?? "unparsed", writerId: valid ? approved?.writerId ?? null : null, status: valid && approved ? "present" : "unknown", detail: valid ? `owner=${owner}` : "unparsed session" });
    if (!valid || !approved) block("UNKNOWN_OPERATOR_SESSION");
  }
  for (const observation of report.observations) if (["units","unit-files","timers","sessions"].includes(observation.surface)) observation.metadata = parseWriterCensusListing(observation.surface, observation.raw.stdout);
  const known = await inspect("known-unit-pids", "unit-status", null, "systemctl", ["show","--no-pager","--property=Id","--property=MainPID","--property=ActiveState","--property=SubState","--property=ControlGroup",...CUTOVER_SERVICES]);
  const roots: Array<{unit:string;pid:number;cgroup:string}> = [];
  const statuses: Array<Record<string,string>> = [];
  for(const chunk of known.raw.stdout.trim().split(/\n\n/)) {
    const fields=Object.fromEntries(chunk.split(/\r?\n/).filter(line=>line.includes("=")).map(line=>[line.slice(0,line.indexOf("=")),line.slice(line.indexOf("=")+1)]));
    if(!CUTOVER_SERVICES.some(known => known === fields.Id) || !/^\d+$/.test(fields.MainPID ?? "") || fields.ControlGroup===undefined || !Number.isSafeInteger(Number(fields.MainPID))) {block("INCOMPLETE_KNOWN_UNIT_PROCESS_SCOPE");continue;}
    roots.push({unit:fields.Id!,pid:Number(fields.MainPID),cgroup:fields.ControlGroup});
    statuses.push({unit:fields.Id!,mainPid:fields.MainPID!,active:fields.ActiveState ?? "unknown",sub:fields.SubState ?? "unknown",cgroup:fields.ControlGroup});
  }
  known.metadata=statuses;
  if(roots.length!==CUTOVER_SERVICES.length)block("INCOMPLETE_KNOWN_UNIT_PROCESS_SCOPE");
  const processObservation = await inspect("process-census", "processes", null, "sudo", ["-n","python3","-c",WRITER_PROCESS_CENSUS_PYTHON,JSON.stringify({files:policy.sourceFiles,roots})]);
  processObservation.raw.stdout="[structured kernel metadata; raw fingerprint retained]";
  if(processObservation.status==="present") {
    try {
      // The execute port returns bounded raw bytes; parsing happens before publication.
      const parsed=parseWriterProcessCensus(processRaw.get("process-census") ?? "",policy.sourceFiles);
      processObservation.metadata=parsed;
      if(parsed.truncated || parsed.sourceChanged || parsed.errors.length || parsed.sourceMetadata.some(row=>row.status!=="present" || row.mode!=="regular")) block("PROCESS_OR_SOURCE_CENSUS_INCOMPLETE");
      for(const row of parsed.processes) {
        const approved=policy.processCommands.find(entry=>entry.command===row.command);
        if(!["present","absent"].includes(String(row.status)))block("INCOMPLETE_PROCESS_FD_SCAN");
        for(const handle of row.handles) {
          processObservation.entries.push({id:row.pid+":"+handle.fd,writerId:approved?.writerId??null,status:approved && handle.matchedBy==="path-and-inode" && handle.access!=="unknown"?"present":"unknown",detail:handle.access+" path="+handle.path+" inode="+handle.inode});
          if(handle.writable){block("OBSERVED_WRITABLE_SOURCE_HANDLE");if(!approved)block("UNKNOWN_WRITABLE_SOURCE_HANDLE");}
          if(handle.matchedBy!=="path-and-inode" || handle.access==="unknown")block("UNKNOWN_OR_UNVERIFIABLE_SOURCE_HANDLE");
        }
      }
    } catch {processObservation.status="unknown";block("UNPARSED_PROCESS_CENSUS");}
  }
  const handles = await inspect("source-handles", "handles", null, "sudo", ["-n","lsof","-nP", "-FpcfaiDn", "--", ...policy.sourceFiles]);
  // lsof's documented empty-match exit is not equivalent to denied or unavailable output.
  if (handles.raw.exitCode === 1 && handles.raw.error === null && !handles.raw.stdout.trim() && !handles.raw.stderr.trim()) handles.status = "absent";
  if (handles.status === "present") {
    let pid = "", command = "", access = "", fd = "";
    for (const line of handles.raw.stdout.split(/\r?\n/).filter(Boolean)) {
      const field = line[0], value = line.slice(1);
      if (field === "p") { pid = value; command = ""; access = ""; fd = ""; }
      if (field === "c") command = value;
      if (field === "f") { fd = value; access = ""; }
      if (field === "a") access = value;
      if (field === "n") {
        const approved = policy.processCommands.find(entry => entry.command === command), writable = access === "w" || access === "u";
        const valid = /^\d+$/.test(pid) && policy.sourceFiles.includes(value) && ["r", "w", "u"].includes(access);
        handles.entries.push({ id: `${pid}:${fd}`, writerId: approved?.writerId ?? null, status: valid && approved ? "present" : "unknown", detail: valid ? `${writable ? "writable" : "read-only"} command=${command} path=${value}` : "unverifiable handle access or file identity" });
        if (!valid || !approved) block(writable ? "UNKNOWN_WRITABLE_SOURCE_HANDLE" : "UNKNOWN_OR_UNVERIFIABLE_SOURCE_HANDLE");
        if (writable) block("OBSERVED_WRITABLE_SOURCE_HANDLE");
      }
    }
    if (!handles.entries.length) block("UNPARSED_SOURCE_HANDLE_CENSUS");
  }
  for (const inputScope of policy.inputs) {
    const found = inputScope.unit === null ? undefined : report.observations.find(observation => observation.id === "system-live")?.entries.find(entry => entry.id === inputScope.unit);
    report.observations.push({ id: `input:${inputScope.id}`, surface: inputScope.kind, owner: null, status: "unknown",
      reason: found ? "unit-observed-admission-and-external-sources-unverified" : "external-enumeration-unavailable",
      raw: { stdout: "", stderr: "", stdoutSha256: censusHash(""), stderrSha256: censusHash(""), exitCode: null, error: null }, entries: [] });
    block(`INCOMPLETE_INPUT_SCOPE:${inputScope.id}`);
  }
  report.observations.push({ id: "system-cron-at", surface: "system-cron-and-at", owner: null, status: "unknown",
    reason: "system-cron-directories-anacron-and-at-not-enumerated",
    raw: { stdout: "", stderr: "", stdoutSha256: censusHash(""), stderrSha256: censusHash(""), exitCode: null, error: null }, entries: [] });
  block("SYSTEM_CRON_AND_AT_SCOPES_UNKNOWN");
  const finished = ports.clock();
  if (!Number.isSafeInteger(finished) || finished < start) block("CENSUS_CLOCK_INVALID");
  else report.completedAt = new Date(finished).toISOString();
  report.censusComplete = report.blockers.length === 1;
  return report;
}
async function censusMain(args: string[]): Promise<void> {
  try {
    if (args.length !== 4 || args[0] !== "--census-scopes" || args[2] !== "--census-scopes-sha256" || !args[1] || !/^[a-f0-9]{64}$/.test(args[3] ?? "")) throw new Error("Invalid census arguments");
    const policy = readJson(args[1]);
    if (migrationCutoverDigest(policy) !== args[3]) throw new Error("Census policy pin mismatch");
    const result = await collectWriterCensus(policy, { execute: executeWriterCensusCommand, clock: Date.now });
    process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.fenceEstablished ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ ...inactive, censusComplete: false, fenceEstablished: false, error: "INVALID_CENSUS_INPUT" }) + "\n"); process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--census") await censusMain(args.slice(1)); else savedEvidenceMain(args);
}
