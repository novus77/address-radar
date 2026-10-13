#!/usr/bin/env python3
"""Validate and prepare one production job. Never activate services or renew authority."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/var/lib/address-radar-maintenance-tools')
PIN_FIELDS = {'fenceRequest', 'adapter', 'sequence', 'controllerConfig', 'transition', 'importTemplate', 'probeTemplate', 'selfPin'}
CONTROLLERS = {'activation', 'configured', 'controller', 'fence', 'pgFence'}
TOOLS = {'python', 'node', 'rotation', 'rotationSupport', 'import', 'probe'}
DIGEST = re.compile('[a-f0-9]{64}')
JSON_LIMIT = 524288
CODE_LIMIT = 4194304
BINARY_LIMIT = 256 * 1024**2
CONFIGURED_POLICY = {'mode': 'configured', 'minimumDiskBytes': 3 * 1024**3,
    'minimumTotalRamBytes': 5 * 1024**3 // 2, 'minimumPrestartAvailableRamBytes': 2 * 1024**3,
    'serviceMemoryMaxBytes': 256 * 1024**2, 'serviceTasksMax': 64}


def bounded_process(argv, raw, seconds, check):
    """Bound both pipe directions and retain ownership of the entire child group."""
    end = time.monotonic() + seconds
    child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    output, offset, succeeded = bytearray(), 0, False
    try:
        with selectors.DefaultSelector() as selector:
            for stream in (child.stdin, child.stdout):
                os.set_blocking(stream.fileno(), False)
            selector.register(child.stdout, selectors.EVENT_READ)
            if raw:
                selector.register(child.stdin, selectors.EVENT_WRITE)
            else:
                child.stdin.close()
            while selector.get_map() or child.poll() is None:
                check()
                require(time.monotonic() < end, 'validator_timeout')
                for key, _ in selector.select(min(.05, max(0, end-time.monotonic()))):
                    if key.fileobj is child.stdin:
                        count = os.write(child.stdin.fileno(), raw[offset:offset+65536])
                        offset += count
                        if offset == len(raw):
                            selector.unregister(child.stdin); child.stdin.close()
                    else:
                        chunk = os.read(child.stdout.fileno(), 8193-len(output))
                        if not chunk:
                            selector.unregister(child.stdout)
                        else:
                            output.extend(chunk)
                            require(len(output) <= 8192, 'validator_output_budget')
            require(child.returncode == 0, 'material_validation')
            # A leader's exit is not proof that its descendants exited.
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise ValueError('validator_group_residual')
            succeeded = True
            return bytes(output)
    finally:
        # Cleanup has its own short budget even when preparation has expired.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        cleanup_end = time.monotonic()+1
        try:
            child.wait(timeout=1)
            while True:
                try:
                    os.killpg(child.pid, 0)
                except ProcessLookupError:
                    break
                require(time.monotonic() < cleanup_end, 'validator_cleanup_uncertain')
                time.sleep(.01)
        except BaseException:
            if succeeded:
                raise
        finally:
            if not child.stdin.closed: child.stdin.close()
            child.stdout.close()


def require(value, code):
    if not value:
        raise ValueError(code)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def validate_pin(value):
    require(type(value) is dict and set(value) == {'path', 'sha256'}, 'pin_shape')
    path = value['path']
    require(type(path) is str and path.startswith('/') and os.path.normpath(path) == path
            and '//' not in path and type(value['sha256']) is str and DIGEST.fullmatch(value['sha256']), 'pin_binding')
    return value


def assemble(materials, reader, now_ms):
    fields = {'protocol', 'operationId', 'approvalRef', 'replacementSha256', 'rotationNonce',
              'controllerPins', 'tools', 'stageReceipt', 'materialValidator'} | PIN_FIELDS
    require(type(materials) is dict and set(materials) == fields
            and materials['protocol'] == 'address-only-production-execution-materials-v1', 'materials_shape')
    operation = materials['operationId']
    require(type(operation) is str and re.fullmatch('[A-Za-z0-9_-]{1,64}', operation), 'operation')
    require(type(materials['approvalRef']) is str and 0 < len(materials['approvalRef']) <= 512, 'approval')
    require(type(materials['replacementSha256']) is str and DIGEST.fullmatch(materials['replacementSha256']), 'replacement')
    require(type(materials['rotationNonce']) is str and re.fullmatch('[a-f0-9]{16}', materials['rotationNonce']), 'rotation')
    require(type(materials['controllerPins']) is dict and set(materials['controllerPins']) == CONTROLLERS
            and type(materials['tools']) is dict and set(materials['tools']) == TOOLS, 'tool_shape')
    read = lambda pin: reader(validate_pin(pin), maximum=JSON_LIMIT)
    document = lambda pin: json.loads(read(pin))
    for key in ('adapter', 'sequence', 'selfPin'):
        reader(validate_pin(materials[key]), maximum=CODE_LIMIT, collect=False)
    for pin in materials['controllerPins'].values():
        reader(validate_pin(pin), maximum=CODE_LIMIT, collect=False)
    for key, pin in materials['tools'].items():
        reader(validate_pin(pin), maximum=BINARY_LIMIT if key in ('python', 'node') else 128*1024**2, collect=False)
    reader(validate_pin(materials['materialValidator']), maximum=128*1024**2, collect=False)
    request, transition, config, template, probe, stage = [document(materials[key]) for key in
        ('fenceRequest', 'transition', 'controllerConfig', 'importTemplate', 'probeTemplate', 'stageReceipt')]
    deadline = request.get('deadlineAtMs')
    require(type(deadline) is int and type(now_ms) is int and 60000 < deadline-now_ms <= 240000, 'deadline')
    require(set(request) == {'protocol','operationId','replacementSha256','generationId','oldProviderId','oldOrigin',
                            'newProviderId','newOrigin','authorizationRef','deadlineAtMs','publishedFiles'}
            and request['protocol'] == 'address-only-pg-source-fence-v1'
            and request['operationId'] == operation and request['authorizationRef'] == materials['approvalRef']
            and request['replacementSha256'] == materials['replacementSha256']
            and request['generationId'] == 'production-20261006-v1' and request['publishedFiles'] == [], 'fence_binding')
    transition_fields = {'protocol','transitionId','authorizationRef','deadlineAtMs','oldState','originalManifest',
        'releaseRoot','releaseSha256','node','deployment','environment','nativeVerifier','resourcePolicy','walletServiceUser'}
    require(set(transition)-{'configuredOrigin'} == transition_fields
            and transition['protocol'] == 'address-only-configured-transition-v1'
            and type(transition['transitionId']) is str and re.fullmatch('[A-Za-z0-9_-]{1,64}',transition['transitionId'])
            and transition['deadlineAtMs'] == deadline and transition['authorizationRef'] == materials['approvalRef'], 'transition_binding')
    require(set(config) == {'protocol','operationId','fence','reconcile','exporter','validator','launcher','node','jobTemplate','outputDirectory'}
            and config['protocol'] == 'address-only-controller-v1' and config['operationId'] == operation
            and config['fence'] == materials['controllerPins']['fence']
            and config['node'] == transition['node'] == materials['tools']['node'], 'controller_binding')
    output = str(ROOT / ('address-only-run-'+operation))
    job_template = config['jobTemplate']
    require(config['outputDirectory'] == output and type(job_template) is dict
            and job_template.get('operationId') == operation and job_template.get('action') == 'plan'
            and job_template.get('outputDirectory') == output
            and job_template.get('sourceFence') == config['fence'], 'controller_job_binding')
    require(type(transition['resourcePolicy']) is dict
            and set(transition['resourcePolicy']) == set(CONFIGURED_POLICY)
            and all(type(transition['resourcePolicy'][key]) is type(value)
                    and transition['resourcePolicy'][key] == value
                    for key, value in CONFIGURED_POLICY.items()), 'resource_policy')
    for key in ('fence','reconcile','exporter','validator','launcher'):
        reader(validate_pin(config[key]), maximum=128*1024**2, collect=False)
    require(Path(materials['selfPin']['path']).name == 'execute-pg-source-replacement.py', 'executor_binding')
    reader.verify_wallet(transition['walletServiceUser'])
    require(stage.get('protocol') == 'address-only-code-stage-receipt-v1'
            and stage.get('status') == 'CODE_STAGED_ONLY' and stage.get('stageOnly') is True
            and stage.get('release',{}).get('root') == transition['releaseRoot']
            and stage['release'].get('releaseSha256') == transition['releaseSha256'], 'staged_release')
    def stage_pin(value):
        require(type(value) is dict and 'path' in value and 'sha256' in value, 'stage_pin')
        return validate_pin({key:value[key] for key in ('path','sha256')})
    require(stage.get('authorizationRef') == materials['approvalRef']
            and stage.get('transitionId') == transition['transitionId']
            and type(stage.get('nativeNode')) is dict
            and stage_pin(stage['nativeNode'].get('pin')) == transition['node']
            and type(stage.get('permanentPins')) is dict
            and set(stage['permanentPins']) == {'oldState','originalManifest'}
            and all(stage_pin(stage['permanentPins'][key]) == transition[key]
                    for key in ('oldState','originalManifest')), 'stage_binding')
    reader.verify_release(stage['release'])
    require(set(template) == {'input','target'}, 'import_shape')
    target = template['target']
    expected = {'systemIdentifier':'7693392208475083526','database':'address_radar','schema':'address_radar_business',
                'username':'address_radar_migrator','generation':'production-20261006-v1','service':'migrator',
                'serverAddress':'127.0.0.1','serverPort':5432}
    require(type(target) is dict and all(target.get(k)==v for k,v in expected.items())
            and type(target.get('schemaVersion')) is int and target['schemaVersion']>0
            and type(target.get('schemaFingerprint')) is str and DIGEST.fullmatch(target['schemaFingerprint']), 'production_target')
    source = document(template['input'])
    require(set(probe) == {'protocol','deadlineAtMs','deployment','environment','authority','settings','runtimeAuthority','credential','payload','maximumRunMs','maximumBodyBytes'}
            and probe['protocol'] == 'address-only-configured-source-probe-job-v1'
            and probe['deployment'] == transition['deployment'] and probe['environment'] == transition['environment']
            and type(probe['deadlineAtMs']) is int and now_ms<probe['deadlineAtMs']<=deadline
            and type(probe['maximumRunMs']) is int and 0<probe['maximumRunMs']<=5000
            and type(probe['maximumBodyBytes']) is int and 0<probe['maximumBodyBytes']<=2097152, 'probe_binding')
    deployment, environment = document(transition['deployment']), document(transition['environment'])
    driver = deployment.get('driver')
    require(type(driver) is dict and type(driver.get('schemaVersion')) is int
            and driver['schemaVersion'] > 0 and type(driver.get('schemaFingerprint')) is str
            and DIGEST.fullmatch(driver['schemaFingerprint'])
            and target['schemaVersion'] == driver['schemaVersion']
            and target['schemaFingerprint'] == driver['schemaFingerprint'], 'import_schema_binding')
    final = {'deployment':deployment,'environment':environment}
    for name,key in (('authority','AUTHORITY'),('settings','CONFIGURED_PREFLIGHT'),('deployment','DEPLOYMENT')):
        pin = {'path':environment.get('ADDRESS_RADAR_POSTGRES_'+key+'_FILE'),
               'sha256':environment.get('ADDRESS_RADAR_POSTGRES_'+key+'_SHA256')}
        require(validate_pin(pin) == probe[name], 'environment_pin_binding')
        final[name] = document(pin)
    for key in ('runtimeAuthority','credential','payload'):
        read(probe[key])
    for key in ('oldState','originalManifest','nativeVerifier'):
        read(transition[key]) if key != 'nativeVerifier' else reader(validate_pin(transition[key]),maximum=128*1024**2,collect=False)
    old, manifest = document(transition['oldState']), document(transition['originalManifest'])
    require(old.get('phase') == 'COMPLETE' and old.get('receipt',{}).get('sourceMonitoring') == 'waiting_configuration'
            and old.get('operationId') == manifest.get('operationId') == operation
            and manifest.get('generationId') == request['generationId'], 'original_binding')
    if 'configuredOrigin' in transition:
        origin = transition['configuredOrigin']
        require(type(origin) is dict and set(origin) == {'journal','receipt','releaseRoot','node'}, 'configured_origin_shape')
        journal, receipt = document(origin['journal']), document(origin['receipt'])
        require(journal.get('phase')=='COMPLETE' and journal.get('receipt')==receipt
                and receipt.get('releaseRoot')==origin['releaseRoot'], 'configured_origin_binding')
        reader(validate_pin(origin['node']), maximum=BINARY_LIMIT, collect=False)
    for flag in ('gatewayDeliveryEnabled','fomoEnabled','fullHistoricalMiningEnabled'):
        require(deployment.get(flag) is False, 'safety_flags')
    for flag in ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED','ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
                 'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED','ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED'):
        require(environment.get(flag)=='false','safety_flags')
    require(deployment.get('releaseRoot')==transition['releaseRoot'] and deployment.get('operationId')==operation
            and deployment.get('generationId')==request['generationId']
            and deployment.get('cutover',{}).get('addressOnly',{}).get('releaseSha256')==transition['releaseSha256'], 'deployment_binding')
    entry = stage['release']['entryPin']
    result = reader.validate_material(materials['tools']['node'], materials['materialValidator'], {
        'input':source,'replacementSha256':materials['replacementSha256'],'approvalRef':materials['approvalRef'],
        'generationId':request['generationId'],'releaseRoot':transition['releaseRoot'],'releaseSha256':transition['releaseSha256'],
        'entrySha256':entry['sha256'],'finalMaterial':final,
        'finalPins':{key:probe[key] for key in ('authority','deployment','settings')}})
    require(all(result.get(key)==request[key] for key in ('replacementSha256','generationId','oldProviderId','oldOrigin','newProviderId','newOrigin'))
            and result.get('approvalRef')==materials['approvalRef'], 'source_plan_binding')
    job = {key:materials[key] for key in PIN_FIELDS|{'operationId','approvalRef','replacementSha256','controllerPins','tools'}}
    job.update(protocol='address-only-source-replacement-execution-v1',deadlineAtMs=deadline,
        outputDirectory=str(ROOT/('source-replacement-execution-'+operation)),
        rotationDirectory=str(ROOT/('address-only-auth-'+materials['rotationNonce'])))
    return job


class ProtectedReader:
    def __init__(self):
        self.end = time.monotonic()+30
        self.sizes = {}
        self.io = 0
        self.dependencies = {}
        self.release_snapshots = {}
        self.wallets = []

    def check(self):
        require(time.monotonic()<self.end,'preparation_timeout')

    def __call__(self,pin,*,maximum=JSON_LIMIT,collect=True):
        self.check(); validate_pin(pin)
        path = Path(pin['path'])
        for parent in path.parents:
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'protected_parent')
        fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        stamp = lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_mtime_ns,s.st_ctime_ns)
        with os.fdopen(fd,'rb') as stream:
            before = os.fstat(stream.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1
                    and not before.st_mode&0o022 and 0<before.st_size<=maximum,'protected_file')
            self.sizes[str(path)] = before.st_size
            require(sum(self.sizes.values())<=384*1024**2,'unique_input_budget')
            digest, chunks, count = hashlib.sha256(), [], 0
            while True:
                self.check()
                raw = stream.read(min(65536,maximum+1-count))
                if not raw: break
                count += len(raw); self.io += len(raw)
                require(count<=maximum and self.io<=1024*1024**2,'input_budget')
                digest.update(raw)
                if collect: chunks.append(raw)
            after = os.fstat(stream.fileno())
        require(stamp(before)==stamp(after)==stamp(path.lstat()) and count==before.st_size
                and digest.hexdigest()==pin['sha256'],'pin_changed')
        identity = (dict(pin), maximum, stamp(before))
        previous = self.dependencies.get(str(path))
        require(previous is None or previous[0] == identity[0] and previous[2] == identity[2],
                'dependency_changed')
        self.dependencies[str(path)] = identity
        self.check()
        return b''.join(chunks) if collect else b''

    def verify_wallet(self,identity):
        require(type(identity) is dict and set(identity)=={'user','group','uid','gid'},'wallet_identity')
        require(all(type(identity[key]) is str and re.fullmatch('[a-z_][a-z0-9_-]{0,31}',identity[key])
                    for key in ('user','group'))
                and all(type(identity[key]) is int and 0<identity[key]<2**31 for key in ('uid','gid')),
                'wallet_identity')
        origin = pwd.getpwnam('address-radar')
        def getent(kind, name):
            self.check()
            return bounded_process(['/usr/bin/getent',kind,name],b'',
                min(3,max(.001,self.end-time.monotonic())),self.check).decode('utf-8')
        passwd=getent('passwd',identity['user']).strip().splitlines()
        groups=getent('group',identity['group']).strip().splitlines()
        require(len(passwd)==len(groups)==1,'wallet_identity')
        user,group=passwd[0].split(':'),groups[0].split(':')
        require(len(user)==7 and len(group)==4 and user[0]==identity['user'] and group[0]==identity['group']
                and user[2]==str(identity['uid']) and user[3]==str(identity['gid'])
                and group[2]==str(identity['gid']) and identity['uid']!=origin.pw_uid
                and identity['gid']!=origin.pw_gid,'wallet_identity')
        memberships=getent('initgroups',identity['user']).split()
        require(memberships and memberships[0]==identity['user']
                and set(memberships[1:]).issubset({str(identity['gid'])}), 'wallet_supplementary_groups')
        if identity not in self.wallets: self.wallets.append(dict(identity))

    def verify_release(self,release):
        root = Path(release['root'])
        require(root.parent==Path('/opt/address-radar/releases') and re.fullmatch('address-only-[a-z0-9-]{1,100}',root.name),'release_scope')
        def directory_snapshot():
            self.check()
            rows=[]
            for directory in (root,root/'scripts'):
                before=directory.lstat()
                require(stat.S_ISDIR(before.st_mode) and before.st_uid==before.st_gid==0
                        and stat.S_IMODE(before.st_mode)==0o555,'release_seal')
                names=tuple(sorted(os.listdir(directory)))
                after=directory.lstat()
                stamp=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_gid,
                                    value.st_mtime_ns,value.st_ctime_ns)
                require(stamp(before)==stamp(after),'release_directory_changed')
                rows.append((str(directory),stamp(before),names))
            require(rows[0][2]==('pg.mjs','scripts') and rows[1][2]==
                ('postgres-address-only-dispatch.mjs','postgres-service-entry.mjs'),'release_entries')
            return rows
        snapshot=directory_snapshot()
        previous=self.release_snapshots.get(str(root))
        require(previous is None or previous[1]==snapshot,'release_directory_changed')
        entries=[]
        for name in ('.','pg.mjs','scripts','scripts/postgres-address-only-dispatch.mjs','scripts/postgres-service-entry.mjs'):
            path=root/name; info=path.lstat(); directory=name in ('.','scripts')
            require(info.st_uid==0 and info.st_gid==0 and stat.S_IMODE(info.st_mode)==(0o555 if directory else 0o444)
                    and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)),'release_seal')
            entry={'path':name,'mode':stat.S_IMODE(info.st_mode),'kind':'directory' if directory else 'file'}
            if not directory:
                pin_key={'pg.mjs':'pgPin','scripts/postgres-address-only-dispatch.mjs':'dispatcherPin','scripts/postgres-service-entry.mjs':'entryPin'}[name]
                pinned=release[pin_key]
                require(pinned['path']==str(path),'release_pin_path')
                self({'path':str(path),'sha256':pinned['sha256']},maximum=16*1024**2,collect=False)
                entry.update(size=info.st_size,sha256=pinned['sha256'])
            entries.append(entry)
        digest=hashlib.sha256(''.join(json.dumps(row,separators=(',',':'))+'\n' for row in entries).encode()).hexdigest()
        require(digest==release['releaseSha256'],'release_inventory')
        require(directory_snapshot()==snapshot,'release_directory_changed')
        self.release_snapshots[str(root)]=(release,snapshot)

    def validate_material(self,node,validator,payload):
        raw=encode(payload); require(len(raw)<=2*1024**2,'validator_input_budget')
        self(node,maximum=BINARY_LIMIT,collect=False); self(validator,maximum=128*1024**2,collect=False)
        self.check()
        result=bounded_process([node['path'],'--no-global-search-paths',validator['path'],'--validate'],
            raw,min(5,max(.001,self.end-time.monotonic())),self.check)
        require(result,'material_validation')
        self(node,maximum=BINARY_LIMIT,collect=False); self(validator,maximum=128*1024**2,collect=False)
        value=json.loads(result)
        require(type(value) is dict,'material_validation')
        return value

    def revalidate(self):
        for pin, maximum, _ in list(self.dependencies.values()):
            self(pin,maximum=maximum,collect=False)
        for identity in list(self.wallets):
            self.verify_wallet(identity)
        for release, _ in list(self.release_snapshots.values()):
            self.verify_release(release)
        self.check()



def sync(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def write(path,raw):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())


def prepare(pin,destination):
    require(sys.platform=='linux' and os.geteuid()==0,'native_root')
    path=Path(destination)
    require(path.parent==ROOT and re.fullmatch('source-execution-preparation-[A-Za-z0-9_-]{1,64}',path.name),'output_scope')
    reader=ProtectedReader(); initial=reader(pin); materials=json.loads(initial)
    job=assemble(materials,reader,int(time.time()*1000))
    require(reader(pin)==initial,'materials_changed')
    reader.revalidate()
    reader.check(); require(job['deadlineAtMs']-int(time.time()*1000)>60000,'deadline')
    for parent in (ROOT,*ROOT.parents):
        info=parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'protected_parent')
    require(not os.path.lexists(job['outputDirectory']) and not os.path.lexists(job['rotationDirectory']),'attempt_collision')
    os.mkdir(path,0o700); sync(ROOT)
    raw=encode(job); job_pin={'path':str(path/'execution-job.json'),'sha256':hashlib.sha256(raw).hexdigest()}
    write(path/'execution-job.json',raw)
    receipt={'status':'PREPARED_NOT_EXECUTED','job':job_pin,'materials':pin,'retryAuthorized':False,'activationPerformed':False}
    reader.revalidate()
    reader.check(); require(job['deadlineAtMs']-int(time.time()*1000)>60000,'deadline')
    write(path/'preparation-receipt.json',encode(receipt)); sync(path); sync(ROOT)
    return receipt


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--materials',required=True); parser.add_argument('--materials-sha256',required=True)
    parser.add_argument('--output-directory',required=True); args=parser.parse_args()
    return prepare({'path':args.materials,'sha256':args.materials_sha256},args.output_directory)


if __name__=='__main__':
    try: print(json.dumps(main()))
    except BaseException:
        print(json.dumps({'status':'REFUSED_NOT_EXECUTED','retryAuthorized':False})); sys.exit(1)
