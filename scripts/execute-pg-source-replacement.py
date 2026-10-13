#!/usr/bin/env python3
"""One-attempt native source replacement. No credentials or child output are logged."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import struct
import stat
import subprocess
import sys
import time
import types

ROOT = Path('/var/lib/address-radar-maintenance-tools')
LIMIT = 1048576


def require(value, code):
    if not value:
        raise ValueError(code)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def read_pin(pin, maximum=LIMIT):
    require(type(pin) is dict and set(pin) == {'path', 'sha256'} and
            type(pin['sha256']) is str and re.fullmatch('[a-f0-9]{64}', pin['sha256']), 'pin')
    path = Path(pin['path'])
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'pin_path')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'pin_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= maximum, 'pin_file')
        raw = stream.read(maximum+1)
        after = os.fstat(stream.fileno())
    def stamp(s):
        return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    require(stamp(before) == stamp(after) == stamp(path.lstat()) and len(raw) == before.st_size
            and hashlib.sha256(raw).hexdigest() == pin['sha256'], 'pin_changed')
    return raw


def load(name, pin):
    raw = read_pin(pin, 4194304)
    module = types.ModuleType(name)
    module.__file__ = pin['path']
    exec(compile(raw, pin['path'], 'exec'), module.__dict__)
    return module


def publication_materials(actual, environment_pin):
    """Include immutable preflight settings, not only files managed by activation."""
    files = {}
    for path, record in sorted(actual.state['artifacts'].items()):
        if path.endswith('.json') or path.endswith('.env'):
            require(actual.file_descriptor(Path(path)) == record['desired'], 'publication_identity')
            files[path] = {'path': path, 'sha256': record['desired']['sha256']}
    environment = json.loads(read_pin(environment_pin))
    settings = {'path': environment.get('ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE'),
                'sha256': environment.get('ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256')}
    require(type(settings['path']) is str, 'published_settings_pin')
    read_pin(settings)
    require(settings['path'] not in files or files[settings['path']] == settings, 'publication_identity')
    files[settings['path']] = settings
    return list(files.values())


def group_exists(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # EPERM proves neither absence nor successful cleanup.
        return True


def drain_group(child):
    # A dead leader does not imply its process group has exited.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)
    end = time.monotonic()+5
    while group_exists(child.pid):
        require(time.monotonic() < end, "child_group_drain_uncertain")
        time.sleep(.01)


def bounded_child(argv, check, remaining):
    """Drain both pipes with a combined cap; abort kills and reaps the process group."""
    check()
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, close_fds=True, start_new_session=True,
        env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
    total = 0
    try:
        with selectors.DefaultSelector() as selector:
            for stream in (child.stdout, child.stderr):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map() or child.poll() is None:
                check()
                require(remaining() > 0, 'child_deadline')
                for key, _ in selector.select(min(.1, remaining())):
                    raw = os.read(key.fd, 8192)
                    total += len(raw)
                    require(total <= 65536, 'child_output_budget')
                    if not raw:
                        selector.unregister(key.fileobj)
            require(child.wait(timeout=1) == 0, 'child_failed_or_uncertain')
            require(not group_exists(child.pid), 'child_group_residual')
        check()
    finally:
        try:
            drain_group(child)
        finally:
            child.stdout.close()
            child.stderr.close()


def observe(pin):
    projection = json.loads(read_pin(pin))
    require(projection.get('approvalRef') == projection.get('authorizationRef'), 'observer_authorization')
    module_pin = projection.pop('nativeFenceModule')
    projection.pop('approvalRef')
    pg = load('replacement_observer_pg', module_pin)
    native = pg.Native(projection)
    native.validate(projection)
    fence = pg.PgSourceFence(native, projection)
    pg.private_path(native.directory, directory=True)
    pg.private_path(native.directory/'state.json')
    fence.state = json.loads((native.directory/'state.json').read_bytes())
    require(fence.state['requestSha256'] == fence.request_sha, 'observer_request')
    fence.fd = os.open(native.lock_path, os.O_RDONLY | os.O_NOFOLLOW)
    fence.observer = True
    try:
        return fence.measure()
    finally:
        fence.__exit__(None, None, None)



def execution_output(job, scope=None):
    """The traverseable isolated service scope is never a private audit parent."""
    output = Path(job['outputDirectory'])
    expected = (scope/'private'/('execution-'+job['operationId']) if scope is not None
                else ROOT/('source-replacement-execution-'+job['operationId']))
    require(output == expected, 'output_scope')
    return output


def isolated_scope(job, identity):
    """Reject production material before loading modules or constructing a fence."""
    suffix = identity['database'].removeprefix('radar_rehearsal_')
    scope = ROOT / ('isolated-source-replacement-' + suffix)
    def scoped(value):
        require(type(value) is str and Path(value).is_absolute()
                and str(Path(value)) == os.path.normpath(value)
                and Path(value).is_relative_to(scope) and Path(value) != scope, 'isolated_path_scope')
    for key in ('fenceRequest','adapter','sequence','controllerConfig','transition',
                'importTemplate','probeTemplate','selfPin','isolatedIdentity','isolatedRuntime'):
        scoped(job[key]['path'])
    if 'isolatedCompletedActivation' in job:
        for key, pin in job['isolatedCompletedActivation'].items():
            for value in (pin.values() if key == 'unitFragments' else [pin]):
                scoped(value['path'])
    scoped(job['rotationDirectory'])
    scoped(job['outputDirectory'])
    require(Path(job['rotationDirectory']).parent == scope
            and re.fullmatch('address-only-auth-[a-f0-9]{16}', Path(job['rotationDirectory']).name), 'isolated_rotation_scope')
    for pin in [*job['controllerPins'].values(), *job['tools'].values()]:
        scoped(pin['path'])
    def inspect(value):
        if isinstance(value, dict):
            for child in value.values(): inspect(child)
        elif isinstance(value, list):
            for child in value: inspect(child)
        elif isinstance(value, str) and value.startswith('/'):
            scoped(value)
    for key in ('controllerConfig','transition','fenceRequest','importTemplate','probeTemplate'):
        inspect(json.loads(read_pin(job[key])))
    target = json.loads(read_pin(job['importTemplate'])).get('target', {})
    require(target.get('systemIdentifier') == identity['systemIdentifier']
            and target.get('database') == identity['database']
            and target.get('schema') == identity['database']
            and target.get('username') == identity['username'], 'isolated_import_identity')
    return scope


def verify_isolated_manager(machine_id):
    """Authenticate the local manager socket in this PID namespace before systemctl."""
    require(not any(key.startswith(('DBUS_', 'SYSTEMD_')) for key in os.environ),
            'isolated_manager_environment')
    require(type(machine_id) is str and re.fullmatch('[a-f0-9]{32}', machine_id), 'isolated_manager_machine')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(3)
        channel.connect('/run/systemd/private')
        pid, uid, gid = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(pid == 1 and uid == 0, 'isolated_manager_peer')
        require(Path('/proc/1/comm').read_text().strip() == 'systemd'
                and Path('/etc/machine-id').read_text().strip() == machine_id, 'isolated_manager_machine')


def isolated_completed_activation(scope, pins):
    """Read-only admission of the exact original isolated COMPLETE publication."""
    require(type(pins) is dict and set(pins) == {'state','receipt','config','isolatedJob',
            'manifest','activationModule','unitFragments'}, 'isolated_complete_pins')
    services = ('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')
    require(set(pins['unitFragments']) == set(services), 'isolated_complete_fragments')
    for pin in [pins[key] for key in pins if key != 'unitFragments'] + list(pins['unitFragments'].values()):
        path = Path(pin['path'])
        require(path.is_absolute() and str(path) == os.path.normpath(str(path))
                and path.is_relative_to(scope) and path != scope, 'isolated_complete_scope')
        read_pin(pin, 128*1024**2 if pin == pins['activationModule'] else LIMIT)
    state, receipt, config, job, manifest = [json.loads(read_pin(pins[key]))
        for key in ('state','receipt','config','isolatedJob','manifest')]
    operation = config.get('operationId')
    require(type(operation) is str and re.fullmatch('[A-Za-z0-9_-]{1,80}', operation), 'isolated_complete_operation')
    output = scope/('address-only-run-'+operation)
    require(set(config) == {'protocol','operationId','fence','reconcile','exporter','validator','launcher','node','jobTemplate','outputDirectory'}
            and config.get('jobTemplate',{}).get('operationId') == operation
            and config['jobTemplate'].get('action') == 'plan' and config['jobTemplate'].get('outputDirectory') == str(output)
            and config['jobTemplate'].get('sourceFence') == config.get('fence')
            and config.get('protocol') == 'address-only-controller-v1' and config.get('outputDirectory') == str(output)
            and pins['state']['path'] == str(output/'activation-state.json')
            and pins['receipt']['path'] == str(output/'activation-receipt.json')
            and pins['manifest']['path'] == str(output/'address-only-manifest.json'), 'isolated_complete_paths')
    base = load('isolated_complete_activation',pins['activationModule'])
    require(state.get('protocol') == 'address-only-activation-state-v1' and state.get('phase') == 'COMPLETE'
            and state.get('pending') is None and state.get('operationId') == operation
            and state.get('receipt') == receipt and state.get('configSha256') == hashlib.sha256(base.encode(config)).hexdigest()
            and state.get('manifestSha256') == hashlib.sha256(base.encode(manifest)).hexdigest()
            and state.get('generator') == config.get('launcher'), 'isolated_complete_state')
    isolated = state.get('isolatedActivation', {})
    suffix = scope.name.removeprefix('isolated-source-replacement-')
    require(job.get('protocol') == 'address-only-isolated-activation-v1'
            and job.get('operationId') == operation and isolated == dict(job,scope=str(scope),jobPin=pins['isolatedJob'])
            and job.get('target',{}).get('database') == 'radar_rehearsal_'+suffix
            and job['target'].get('schema') == job['target']['database']
            and job['target'].get('systemIdentifier') != '7693392208475083526'
            and job.get('roles') == {service:'radar_'+suffix+'_'+service.replace('-','_') for service in services},
            'isolated_complete_job')
    binding = state.get('measurement',{}).get('binding',{})
    require(binding.get('target') == job['target'] and binding.get('generationId') == job.get('generationId')
            and all(binding.get(key) == manifest.get(key) for key in ('operationId','generationId','importId','planSha256'))
            and manifest.get('operationId') == operation
            and receipt.get('protocol') == 'address-only-activation-receipt-v1'
            and receipt.get('proofScope') == 'isolated-activation' and receipt.get('isolatedJob') == pins['isolatedJob']
            and receipt.get('operationId') == operation and receipt.get('generationId') == job['generationId']
            and receipt.get('attempt') == state.get('attempt')
            and receipt.get('sourceMonitoring') == 'waiting_configuration'
            and receipt.get('databaseImported') is True and receipt.get('businessReleaseSwitched') is True
            and receipt.get('monitoringCompleted') is False and receipt.get('gatewayDeliveryEnabled') is False
            and all(manifest.get(key) is False for key in ('gatewayDeliveryEnabled','fomoEnabled','fullHistoricalMiningEnabled')),
            'isolated_complete_receipt')
    for key in ('fence','reconcile','exporter','validator','launcher','node'):
        pin = config[key]
        require(Path(pin['path']).is_relative_to(scope), 'isolated_complete_tool_scope')
        read_pin(pin,128*1024**2)
    measured_node, _ = base.sealed_file(Path(config['node']['path']),128*1024**2,lambda:None)
    require(state.get('nodePath') == config['node']['path']
            and state.get('node') == measured_node and measured_node['sha256'] == config['node']['sha256']
            and Path(state['releaseRoot']).is_relative_to(scope)
            and receipt.get('releaseRoot') == state['releaseRoot'], 'isolated_complete_executables')
    require(base.release_inventory(state['releaseRoot'],lambda:None) == state['release']
            and receipt.get('releaseSha256') == state['release']['releaseSha256'] == manifest.get('releaseSha256'),
            'isolated_complete_release')
    import pwd
    adapter = object.__new__(base.NativeActivation)
    adapter.state, adapter.config = state, config
    adapter.node, adapter.release = Path(state['nodePath']), Path(state['releaseRoot'])
    adapter.directory, adapter.output = scope/'runtime'/('postgresql-'+operation), output
    adapter.account = pwd.getpwnam('address-radar')
    adapter.module = types.SimpleNamespace(MASK_DIRECTORY=str(scope/'units'))
    adapter.check = lambda: None
    def verify_body(path, raw, mode=0o600, owner=None):
        require(owner is None and mode == 0o644, 'isolated_complete_dropin_mode')
        desired = {'sha256':hashlib.sha256(raw).hexdigest(),'uid':0,'gid':0,'mode':mode}
        require(state['artifacts'].get(str(path),{}).get('desired') == desired
                and adapter.file_descriptor(path) == desired, 'isolated_complete_dropin_changed')
    # Reuse the reviewed publication body builder, replacing only its write port
    # with a read-only exact content/metadata comparison. No journal/fence exists.
    adapter.managed = verify_body
    for service in services:
        row = state.get('units',{}).get(service,{})
        require(all(row.get(key) is True for key in ('published','unguarded','started'))
                and isinstance(row.get('ready'),dict), 'isolated_complete_units')
        fragment = pins['unitFragments'][service]
        require(Path(fragment['path']) == scope/'units'/('address-radar-'+service+'.service'), 'isolated_complete_fragment_path')
        adapter.publish(service)
        for path in (adapter.directory/(service+'.env'),adapter.directory/'deployment.json',adapter.directory/'evidence.json'):
            desired = state['artifacts'].get(str(path),{}).get('desired')
            require(desired and adapter.file_descriptor(path) == desired, 'isolated_complete_artifact_changed')
    deployment_path = adapter.directory/'deployment.json'
    deployment_raw = deployment_path.read_bytes()
    require(hashlib.sha256(deployment_raw).hexdigest() == state['artifacts'][str(deployment_path)]['desired']['sha256']
            and adapter.file_descriptor(deployment_path) == state['artifacts'][str(deployment_path)]['desired'], 'isolated_complete_deployment_changed')
    deployment = json.loads(deployment_raw)
    require(deployment.get('sources') == {'mode':'waiting_configuration'} and deployment.get('cutover') == {'addressOnly':manifest}
            and deployment.get('releaseRoot') == state['releaseRoot'], 'isolated_complete_deployment')
    for pin in [pins[key] for key in pins if key != 'unitFragments'] + list(pins['unitFragments'].values()):
        read_pin(pin,128*1024**2 if pin == pins['activationModule'] else LIMIT)
    return adapter


def verify_isolated_runtime(scope, evidence, completed=None):
    """Use kernel/mount and live manager evidence, never a container marker."""
    require(set(evidence) == {'protocol','containerId','machineId','namespaces','hostNamespaces'}
            and evidence['protocol'] == 'address-only-disposable-launch-v1'
            and re.fullmatch('[a-f0-9]{64}', evidence['containerId']), 'isolated_launcher')
    verify_isolated_manager(evidence['machineId'])
    # Initial Linux namespaces cannot qualify as a private rehearsal container.
    require(set(evidence['namespaces']) == set(evidence['hostNamespaces']) == {'pid','mnt','net'}, 'isolated_launcher_namespaces')
    for name in ('pid','mnt','net'):
        own = os.stat('/proc/self/ns/' + name)
        init = os.stat('/proc/1/ns/' + name)
        require((own.st_dev, own.st_ino) == (init.st_dev, init.st_ino)
                and evidence['namespaces'][name] == os.readlink('/proc/self/ns/' + name)
                and evidence['namespaces'][name] != evidence['hostNamespaces'][name], 'isolated_namespace')
    mounts = Path('/proc/self/mountinfo').read_text().splitlines()
    sensitive = [ROOT, Path('/var/lib/address-radar-address-only-cutover'),
                 Path('/etc/systemd/system'), Path('/run/systemd'), Path('/run/dbus')]
    root_seen = False
    for line in mounts:
        left, right = line.split(' - ', 1)
        fields = left.split(); mount = Path(fields[4])
        require('\\' not in fields[4], 'isolated_mount_encoding')
        if mount == Path('/'):
            require(right.split()[0] == 'overlay', 'isolated_root_filesystem')
            root_seen = True
        else:
            private_runtime = right.split()[0] == 'tmpfs' and mount in (
                Path('/run'), Path('/run/systemd'), Path('/run/dbus'))
            require(private_runtime or not any(mount.is_relative_to(path) or path.is_relative_to(mount)
                            for path in sensitive), 'isolated_host_mount')
    require(root_seen, 'isolated_root_filesystem')
    def command(args):
        return subprocess.check_output(['/usr/bin/systemctl', *args], stdin=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=3, env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},
            close_fds=True).decode()
    publication = isolated_completed_activation(scope, completed) if completed is not None else None
    units = command(['list-unit-files','address-radar-*','--no-legend','--no-pager']).splitlines()
    expected = {'address-radar-' + name + '.service' for name in
                ('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')}
    require({line.split()[0] for line in units if line.strip()} == expected, 'isolated_units')
    for unit in sorted(expected):
        raw = command(['show',unit,'-p','FragmentPath','-p','DropInPaths','-p','EnvironmentFiles',
                       '-p','ExecStart','-p','User','-p','MainPID','-p','InvocationID','-p','ControlGroup',
                       '-p','MemoryMax','-p','TasksMax'])
        state = dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
        fragment = Path(state.get('FragmentPath',''))
        require(fragment.is_absolute() and fragment.resolve().is_relative_to(scope), 'isolated_unit_fragment')
        if publication is None:
            require(not state.get('DropInPaths','').strip(), 'isolated_unit_dropins')
            require(state.get('User') == 'nobody', 'isolated_unit_user')
        else:
            service = unit.removeprefix('address-radar-').removesuffix('.service')
            require(fragment.resolve() == Path(completed['unitFragments'][service]['path']), 'isolated_complete_fragment_path')
            dropins = state.get('DropInPaths','').split()
            require(len(dropins) == 1 and Path(dropins[0]).resolve() == publication.dropin(service), 'isolated_unit_dropins')
            require(state.get('User') == publication.account.pw_name
                    and state.get('MemoryMax') == str(256*1024**2) and state.get('TasksMax') == '64', 'isolated_complete_unit_limits')
            argv = 'argv[]='+str(publication.node)+' --no-global-search-paths '+str(publication.release/'scripts/postgres-address-only-dispatch.mjs')+' '+service+' ;'
            require(state.get('ExecStart','').count('path=') == 1 and argv in state['ExecStart'], 'isolated_complete_unit_exec')
            require(state.get('EnvironmentFiles') == str(publication.directory/(service+'.env'))+' (ignore_errors=no)', 'isolated_complete_unit_environment')
        require(str(scope) + '/' in state.get('ExecStart',''), 'isolated_unit_exec')
        environment = state.get('EnvironmentFiles','')
        match = re.fullmatch(r'([^\s]+) \(ignore_errors=no\)', environment.strip())
        require(match and Path(match[1]).is_relative_to(scope), 'isolated_unit_environment')
    if publication is not None:
        publication.unit = lambda service: dict(line.split('=',1) for line in command(['show','address-radar-'+service+'.service',
            '-p','MainPID','-p','InvocationID','-p','ControlGroup']).splitlines() if '=' in line)
        publication.verify_ready()


def execute(job_pin):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'native_root')
    job = json.loads(read_pin(job_pin))
    isolated = job.get("protocol") == "address-only-source-replacement-isolated-execution-v1"
    allowed = {'protocol','operationId','approvalRef','replacementSha256','deadlineAtMs',
        'outputDirectory','fenceRequest','adapter','sequence','controllerPins','controllerConfig',
        'transition','rotationDirectory','tools','importTemplate','probeTemplate','selfPin'}
    if isolated:
        allowed.update(("isolatedIdentity", "isolatedRuntime"))
        if "isolatedCompletedActivation" in job:
            allowed.add("isolatedCompletedActivation")
    require(set(job) == allowed, 'job_shape')
    require(isolated or job['protocol'] == 'address-only-source-replacement-execution-v1', 'job_protocol')
    identity = None
    if isolated:
        identity = json.loads(read_pin(job["isolatedIdentity"]))
        require(identity.get("protocol") == "address-only-isolated-rotation-v1"
            and identity.get("systemIdentifier") != "7693392208475083526"
            and re.fullmatch("radar_rehearsal_[a-f0-9]{16}", identity.get("database", ""))
            and re.fullmatch("radar_migrator_[a-f0-9]{16}", identity.get("username", "")), "isolated_identity")
    if isolated:
        scope = isolated_scope(job, identity)
        completed = job.get('isolatedCompletedActivation')
        if completed is not None:
            transition = json.loads(read_pin(job['transition']))
            original_job = json.loads(read_pin(completed['isolatedJob']))
            require(original_job.get('target',{}).get('database') == identity['database']
                    and original_job['target'].get('systemIdentifier') == identity['systemIdentifier'], 'isolated_complete_target_binding')
            require(completed['state'] == transition.get('oldState') and completed['manifest'] == transition.get('originalManifest')
                    and completed['config'] == job['controllerConfig'] and completed['activationModule'] == job['controllerPins']['activation'],
                    'isolated_complete_transition_binding')
        verify_isolated_runtime(scope, json.loads(read_pin(job["isolatedRuntime"])), completed=completed)
    require(type(job['operationId']) is str and re.fullmatch('[A-Za-z0-9_-]{1,64}',job['operationId']), 'operation')
    require(type(job['deadlineAtMs']) is int and 0 < job['deadlineAtMs']-int(time.time()*1000) <= 240000, 'deadline')
    ends = time.monotonic()+(job['deadlineAtMs']-int(time.time()*1000))/1000
    def check():
        require(time.monotonic() < ends and int(time.time()*1000) < job['deadlineAtMs'], 'deadline')
    def remaining():
        return max(0, min(ends-time.monotonic(), (job['deadlineAtMs']-int(time.time()*1000))/1000))
    adapter = load('replacement_adapter',job['adapter'])
    sequence = load('replacement_sequence',job['sequence'])
    pg = load('replacement_pg',job['controllerPins']['pgFence'])
    configured = load('replacement_configured',job['controllerPins']['configured'])
    base = load('replacement_activation',job['controllerPins']['activation'])
    controller = load('replacement_controller',job['controllerPins']['controller'])
    config = json.loads(read_pin(job['controllerConfig']))
    transition = json.loads(read_pin(job['transition']))
    request = json.loads(read_pin(job['fenceRequest']))
    require(request['publishedFiles'] == [] and request['operationId'] == job['operationId']
        and request['authorizationRef'] == job['approvalRef']
        and request['replacementSha256'] == job['replacementSha256']
        and request['deadlineAtMs'] == job['deadlineAtMs']
        and transition['deadlineAtMs'] <= job['deadlineAtMs'], 'request_binding')
    require(set(job['tools']) == {'python','node','rotation','rotationSupport','import','probe'}, 'tools')
    for pin in [*job['tools'].values(),job['selfPin']]:
        read_pin(pin,128*1024**2)
    require(Path(job['selfPin']['path']) == Path(__file__), 'self_pin')
    output = execution_output(job, scope if isolated else None)
    pg.private_path(output.parent,directory=True)
    output.mkdir(mode=0o700)
    pg.sync(output.parent)
    def write(name,value):
        path = output/name
        raw = encode(value)
        pg.durable(path,raw)
        return {'path':str(path),'sha256':pg.digest(raw)}
    write('intent.json',{'job':job_pin,'status':'ATTEMPTING','retryAuthorized':False})
    context = types.SimpleNamespace(adapter=None,handed_off=False,recovery_status='NOT_ATTEMPTED')
    class PublicationNative(pg.Native):
        def physical(self, recorded, *, expected_users=None):
            actual = context.adapter
            if actual is not None:
                actual.verify_published()
                published = {service: actual.account_for(service).pw_name for service in pg.SERVICES}
                require(expected_users is None or expected_users == published, 'publication_identity')
                expected_users = published
            return pg.Native.physical(self, recorded, expected_users=expected_users)

        def verify_publication(self, original):
            check()
            actual = context.adapter
            require(actual is not None and actual.state['phase'] == 'PUBLISHED', 'publication_edge')
            files = publication_materials(actual, transition['environment'])
            # The input pins remain immutable. The native verifier checks actual six unit environments.
            result = pg.Native.verify_publication(self,{**original,'publishedFiles':files})
            check()
            return result
    native = PublicationNative(request)
    with pg.PgSourceFence(native,request) as owner:
        context.owner = owner
        owned = adapter.native_owner_check(pg,owner,native.lock_path)
        def checked():
            check(); owned(); native.check()
        def child(tool,args):
            checked()
            pin = job['tools'][tool]
            read_pin(pin,128*1024**2)
            executable = job['tools']['python' if tool == 'rotation' else 'node']
            read_pin(executable,128*1024**2)
            prefix = ['-I','-B'] if tool == 'rotation' else ['--no-global-search-paths']
            bounded_child([executable['path'],*prefix,pin['path'],*args],checked,remaining)
            read_pin(pin,128*1024**2)
        def rotate():
            if isolated:
                pin = write("isolated-rotation-job.json", {"protocol":"address-only-isolated-rotation-job-v1",
                    "expectedIdentity":identity,"support":job["tools"]["rotationSupport"],
                    "operationId":job["operationId"],"approvalRef":job["approvalRef"],
                    "replacementSha256":job["replacementSha256"],"directory":job["rotationDirectory"]})
                child("rotation",["--isolated-test-job",pin["path"],"--isolated-test-job-sha256",pin["sha256"]])
                return
            child('rotation',['--support',job['tools']['rotationSupport']['path'],
                '--support-sha256',job['tools']['rotationSupport']['sha256'],
                '--directory',job['rotationDirectory'],'--operation-id',job['operationId'],
                '--approval-ref',job['approvalRef'],'--replacement-sha256',job['replacementSha256']])
        def pin_file(path):
            pg.private_path(path)
            raw = path.read_bytes()
            require(0 < len(raw) <= LIMIT,'receipt_budget')
            pin = {'path':str(path),'sha256':pg.digest(raw)}
            read_pin(pin)
            return pin
        def phase(name):
            checked()
            if name == 'import':
                template = json.loads(read_pin(job['importTemplate']))
                require(set(template) == {'input','target'},'import_template')
                projection = {**request,'approvalRef':job['approvalRef'],
                              'nativeFenceModule':job['controllerPins']['pgFence']}
                observer = write('observer-request.json',projection)
                import_job = {**template,'protocol':'address-only-source-contract-import-job-v1',
                    'operationId':job['operationId'],'approvalRef':job['approvalRef'],
                    'replacementSha256':job['replacementSha256'],'expiresAtMs':job['deadlineAtMs'],
                    'mode':'approved_cutover','rotation':{key:pin_file(Path(job['rotationDirectory'])/(key+'.json'))
                        for key in ('plan','intent','credential','receipt')},
                    'fence':{'python':job['tools']['python'],'tool':job['selfPin'],'request':observer}}
                if isolated:
                    require(template["target"]["systemIdentifier"] == identity["systemIdentifier"]
                        and template["target"]["database"] == identity["database"]
                        and template["target"]["schema"] == identity["database"]
                        and template["target"]["username"] == identity["username"], "isolated_import_identity")
                    import_job["mode"] = "isolated"
                    import_job["fence"] = {"isolatedProof":write("isolated-native-proof.json",owner.measure())}
                pin = write('import-job.json',import_job)
                child('import',['--job',pin['path'],'--job-sha256',pin['sha256']])
                receipt = json.loads(read_pin(pin_file(output/'source-contract-import-receipt.json')))
                require(receipt.get('committed') is True,'import_receipt')
            else:
                probe = json.loads(read_pin(job['probeTemplate']))
                require(probe['deployment'] == transition['deployment'] and probe['environment'] == transition['environment'],
                        'probe_transition_binding')
                probe['deadlineAtMs'] = min(job['deadlineAtMs'],int(time.time()*1000)+60000)
                pin = write('probe-job.json',probe)
                directory = output/'probe'
                child('probe',['--job',pin['path'],'--job-sha256',pin['sha256'],'--output-directory',str(directory)])
                receipt = json.loads(read_pin(pin_file(directory/'receipt.json')))
                require(receipt['result']['status'] == 'verified' and receipt['job'] == pin,'probe_receipt')
        def bind(gate):
            def edge(gate_owner,actual):
                require(gate_owner is owner,'gate_owner')
                require(context.adapter is None or context.adapter is actual,'gate_adapter')
                context.adapter = actual
                gate(actual)
            context.binding = adapter.bind_configured_controller(owner=owner,config=config,
                pins=job['controllerPins'],gate=edge,transition_id=transition['transitionId'],origin_request=transition)
            return gate
        def drain():
            while native.monotonic_ms() < owner.state['stoppedMonotonicMs']+60000:
                checked(); native.verify_guards(owner.body); native.physical(owner.state['recorded']); time.sleep(.2)
            owner.measure()
        def preflight():
            checked()
            pin = write('fresh-preflight-input.json',transition)
            configured.execute_native_preflight(base,controller,transition['nativeVerifier'],transition['node']['path'],
                Path(pin['path']),pin['sha256'],checked,int(remaining()*1000))
        context.bind_unguard_gate,context.rotate = bind,rotate
        context.bind_guards = owner.block
        context.verify_guards = owner.verify_guard_identities
        context.drain,context.phase = drain,phase
        context.publication = lambda actual: native.verify_publication(request)
        context.handoff = owner.handoff
        context.preserve = lambda: write('hold.json',{'status':'HOLD','retryAuthorized':False,
            'replacementSha256':job['replacementSha256'],'servicesActivated':False,
            'recoveryStatus':context.recovery_status})
        def stop():
            for service in pg.SERVICES:
                checked(); native.stop(service)
        def reblock():
            # Configured rollback may remove publication files. Do not reinterpret
            # the resulting base-unit identity as either approved publication.
            if context.adapter is not None:
                try:
                    context.adapter.verify_published()
                except (FileNotFoundError, ValueError):
                    native.verify_guards(owner.body)
                    stop()
                    raise ValueError('recovery_publication_unavailable') from None
            owner.block()
        try:
            result = sequence.run_transition(context,preflight,stop,
                lambda:context.binding.activate(transition),reblock)
        finally:
            if hasattr(context,'binding'):
                context.binding.close()
        write('complete.json',{'status':'COMPLETE','replacementSha256':job['replacementSha256'],
            'controllerResult':result,'retryAuthorized':False})
        return {'status':'COMPLETE','retryAuthorized':False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job')
    parser.add_argument('--job-sha256')
    parser.add_argument('--mode',choices=('execute','observe'),default='execute')
    parser.add_argument('--request')
    parser.add_argument('--request-sha256')
    args = parser.parse_args()
    if args.mode == 'observe':
        require(args.request and args.request_sha256 and not args.job,'observer_arguments')
        return observe({'path':args.request,'sha256':args.request_sha256})
    require(args.job and args.job_sha256 and not args.request,'execute_arguments')
    return execute({'path':args.job,'sha256':args.job_sha256})


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except BaseException:
        print(json.dumps({'status':'REFUSED_OR_UNCERTAIN_PRESERVE_FENCE','retryAuthorized':False}))
        sys.exit(1)
