#!/usr/bin/env python3
"""Recoverable address-only PostgreSQL handoff; never restore SQLite after commit."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import selectors
import shutil
import socket
import stat
import struct
import subprocess
import time
import urllib.parse

SERVICES = ('scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console')
RELEASE = '/opt/address-radar/releases/address-only-pg-20261008-v2'
NODE = '/opt/address-radar/native-address-only-20261008/node'
AUTH = '/var/lib/address-radar-maintenance-tools/address-only-runtime-auth-2d77b313f6e82f20'
FLAGS = ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
         'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED')
ROOT_UID, ROOT_GID = 0, 0
MAXIMUM_BYTES = 524288
WAITING_MEMORY_MAX = 256 * 1024**2
WAITING_TASKS_MAX = 64
WAITING_POLICY = {'mode': 'waiting_configuration', 'minimumDiskBytes': 3 * 1024**3,
    'minimumTotalRamBytes': 5 * 1024**3 // 2, 'minimumPrestartAvailableRamBytes': 2 * 1024**3,
    'serviceMemoryMaxBytes': WAITING_MEMORY_MAX, 'serviceTasksMax': WAITING_TASKS_MAX}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def encode(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_uid, info.st_gid,
            info.st_mode, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)


def protected_parent(path):
    require(Path(path).is_absolute() and str(path) == os.path.normpath(str(path)), 'canonical_path_required')
    for parent in Path(path).parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == ROOT_UID and not info.st_mode & 0o022,
                'unsafe_publication_parent')


def private_json(path, maximum=MAXIMUM_BYTES):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == ROOT_UID and before.st_nlink == 1
                and not before.st_mode & 0o077 and 0 < before.st_size <= maximum, 'unsafe_private_input')
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    require(stamp(before) == stamp(after) == stamp(os.lstat(path)) and len(raw) == before.st_size,
            'private_input_changed')
    return json.loads(raw)


def durable(path, raw, mode=0o600, owner=None):
    require(len(raw) <= MAXIMUM_BYTES, 'publication_budget')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        if owner is not None:
            os.fchown(stream.fileno(), owner.pw_uid, owner.pw_gid)
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())
    sync_directory(path.parent)


class ActivationJournal:
    """Root-private, bounded atomic journal. Caller retains the native controller lock."""
    def __init__(self, path, initial, check=lambda: None):
        self.path, self.check = Path(path), check
        if os.path.lexists(path):
            self.state = private_json(path)
        else:
            require(initial is not None, 'activation_journal_missing')
            self.state = initial
            self.save()

    def save(self):
        self.check()
        raw = encode(self.state)
        require(len(raw) <= MAXIMUM_BYTES, 'activation_journal_budget')
        temporary = self.path.with_name('.' + self.path.name + '.tmp')
        if os.path.lexists(temporary):
            info = temporary.lstat()
            require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe_journal_temporary')
            os.unlink(temporary)
        durable(temporary, raw)
        self.check()
        os.replace(temporary, self.path)
        sync_directory(self.path.parent)

    def action(self, kind, subject, operation):
        self.state['pending'] = {'kind': kind, 'subject': subject}
        self.save()
        self.check()
        result = operation()
        self.check()
        self.state['pending'] = None
        self.save()
        return result


class _IsolatedActivationTarget:
    pass


_verified_isolated_targets = __import__('weakref').WeakKeyDictionary()
_ISOLATED_ROOT = Path('/var/lib/address-radar-maintenance-tools')
_PRODUCTION_SYSTEM = '7693392208475083526'


def _isolated_target(value):
    require(type(value) is _IsolatedActivationTarget and value in _verified_isolated_targets,
            'isolated_activation_authority')
    body = _verified_isolated_targets[value]
    require(int(time.time() * 1000) < body['deadlineAtMs'], 'isolated_activation_expired')
    return json.loads(json.dumps(body))


def _isolated_kernel():
    require(not any(key.startswith(('DBUS_', 'SYSTEMD_')) for key in os.environ),
            'isolated_activation_manager_environment')
    require(os.geteuid() == 0 and os.uname().sysname == 'Linux'
            and Path('/proc/1/comm').read_text().strip() == 'systemd', 'isolated_activation_runtime')
    for name, initial in (('pid',4026531836),('mnt',4026531841),('net',4026531992)):
        own, init = os.stat('/proc/self/ns/'+name), os.stat('/proc/1/ns/'+name)
        require((own.st_dev,own.st_ino) == (init.st_dev,init.st_ino) and own.st_ino != initial,
                'isolated_activation_namespace')
    root_seen = False
    sensitive = (_ISOLATED_ROOT,Path('/etc/systemd/system'),Path('/var/lib/address-radar-address-only-cutover'),
                 Path('/run/systemd'),Path('/run/dbus'),Path('/var/lib/address-radar'))
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        left,right = line.split(' - ',1); mounted = Path(left.split()[4])
        require(chr(92) not in str(mounted), 'isolated_activation_mount')
        if mounted == Path('/'):
            require(right.split()[0] == 'overlay', 'isolated_activation_mount');root_seen = True
        else:
            private_runtime = right.split()[0] == 'tmpfs' and mounted in (
                Path('/run'),Path('/run/systemd'),Path('/run/dbus'))
            require(private_runtime or not any(mounted.is_relative_to(p) or p.is_relative_to(mounted) for p in sensitive),
                    'isolated_activation_mount')
    require(root_seen, 'isolated_activation_mount')
    machine = Path('/etc/machine-id').read_text().strip()
    require(re.fullmatch('[a-f0-9]{32}',machine), 'isolated_activation_manager_machine')
    # The socket must belong to this namespace's PID 1, not an ancestor manager.
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as channel:
        channel.settimeout(3)
        channel.connect('/run/systemd/private')
        pid,uid,_ = struct.unpack('3i',channel.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        require(pid == 1 and uid == 0, 'isolated_activation_manager_peer')
        require(Path('/proc/1/comm').read_text().strip() == 'systemd'
                and Path('/etc/machine-id').read_text().strip() == machine,
                'isolated_activation_manager_machine')


def _isolated_fence_scope(module, scope):
    require(all(Path(value).is_relative_to(scope) for value in
                (module.CONTROL,module.MASK_DIRECTORY,module.BACKUP_DIRECTORY)),
            'isolated_activation_fence_scope')
    # Evidence and the executable retain the production path inside the private root filesystem.
    require(module.SOURCE_DIRECTORY == '/var/lib/address-radar'
            and module.SOURCE == '/var/lib/address-radar/address-radar.db',
            'isolated_activation_source_path')
    protected_parent(Path(module.SOURCE))


def _isolated_config(controller, config, scope):
    require(isinstance(config,dict) and set(config) == {'protocol','operationId','fence','reconcile','exporter',
        'validator','launcher','node','jobTemplate','outputDirectory'}, 'isolated_activation_config')
    require(config['protocol'] == 'address-only-controller-v1'
            and isinstance(config['operationId'],str) and re.fullmatch(r'[A-Za-z0-9_-]{1,80}',config['operationId'])
            and Path(config['outputDirectory']) == scope/('address-only-run-'+config['operationId']),
            'isolated_activation_config')
    job = config['jobTemplate']
    require(isinstance(job,dict) and job.get('operationId') == config['operationId'] and job.get('action') == 'plan'
            and job.get('outputDirectory') == config['outputDirectory'] and job.get('sourceFence') == config['fence'],
            'isolated_activation_config')
    for key in ('fence','reconcile','exporter','validator','launcher','node'):
        controller.pinned_read(config[key],128*1024**2 if key == 'node' else 4*1024**2)
    return config


def _verify_isolated_target(controller, config, generator, pin, release, node):
    require(controller is not None, 'isolated_activation_pin')
    _isolated_kernel()
    job = json.loads(controller.pinned_read(pin,65536))
    require(isinstance(job,dict) and set(job) == {'protocol','operationId','target','generationId','roles','deadlineAtMs'}
            and job['protocol'] == 'address-only-isolated-activation-v1', 'isolated_activation_job')
    target = job['target']
    require(isinstance(target,dict) and set(target) == {'database','schema','schemaFingerprint','systemIdentifier','serverAddress','serverPort'},
            'isolated_activation_target')
    database = target['database']
    require(type(database) is str and re.fullmatch(r'radar_rehearsal_[a-f0-9]{16}',database)
            and target['schema'] == database and target['systemIdentifier'] != _PRODUCTION_SYSTEM
            and type(target['systemIdentifier']) is str and re.fullmatch(r'[1-9][0-9]{0,19}',target['systemIdentifier'])
            and type(target['schemaFingerprint']) is str and re.fullmatch(r'[a-f0-9]{64}',target['schemaFingerprint'])
            and target['serverAddress'] == '127.0.0.1' and type(target['serverPort']) is int and target['serverPort'] == 5432,
            'isolated_activation_target')
    suffix = database.removeprefix('radar_rehearsal_')
    scope = _ISOLATED_ROOT/('isolated-source-replacement-'+suffix)
    roles = {s:'radar_'+suffix+'_'+s.replace('-','_') for s in SERVICES}
    require(job['roles'] == roles and job['operationId'] == config.get('operationId')
            and type(job['generationId']) is str and re.fullmatch(r'isolated-recovery-[a-f0-9]{16}',job['generationId'])
            and type(job['deadlineAtMs']) is int and 0 < job['deadlineAtMs']-int(time.time()*1000) <= 240000,
            'isolated_activation_binding')
    def scoped(value):
        require(type(value) is str and Path(value).is_absolute() and value == os.path.normpath(value)
                and Path(value).is_relative_to(scope) and Path(value) != scope, 'isolated_activation_scope')
        protected_parent(Path(value))
    def inspect(value):
        if isinstance(value,dict):
            for child in value.values():inspect(child)
        elif isinstance(value,list):
            for child in value:inspect(child)
        elif type(value) is str and value.startswith('/'):scoped(value)
    inspect(config);inspect(generator);inspect(pin);scoped(release);scoped(node)
    _isolated_config(controller,config,scope)
    controller.pinned_read(generator)
    role_list = ','.join("'"+value+"'" for value in roles.values())
    sql = """BEGIN READ ONLY; SET LOCAL statement_timeout='2000ms'; SET LOCAL lock_timeout='1000ms';
SELECT json_build_object('systemIdentifier',(pg_catalog.pg_control_system()).system_identifier::text,
'database',current_database(),'schema',n.schema_name,'generationId',n.generation_id,
'roles',(SELECT json_agg(rolname ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname IN (%s)
AND rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication
AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit=1))
FROM %s.business_schema_identity n WHERE n.singleton=true LIMIT 2; ROLLBACK;""" % (role_list,database)
    observed = subprocess.run(['/usr/bin/sudo','-n','-u','postgres','/usr/lib/postgresql/16/bin/psql',
        '-X','-qAt','-v','ON_ERROR_STOP=1','-h','/var/run/postgresql','-p','5432','-d',database,'-c',sql],
        stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=3,
        env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},close_fds=True)
    require(observed.returncode == 0 and 0 < len(observed.stdout) <= 8192, 'isolated_activation_pg_identity')
    identity = json.loads(observed.stdout)
    require(identity == {'systemIdentifier':target['systemIdentifier'],'database':database,'schema':database,
        'generationId':job['generationId'],'roles':sorted(roles.values())}, 'isolated_activation_pg_identity')
    capability = _IsolatedActivationTarget()
    _verified_isolated_targets[capability] = dict(job,scope=str(scope),jobPin=dict(pin))
    return capability


def activate_isolated(controller, config, generator, isolated_job, release=RELEASE, node=NODE):
    capability = _verify_isolated_target(controller,config,generator,isolated_job,release,node)
    return _activate(controller,config,generator,release,node,isolated_target=capability)


def credential_url(value, service, *, isolated_target=None):
    require(isinstance(value, dict) and set(value) == {'connectionString', 'gatewayDeliveryEnabled', 'service', 'username'},
            'service_credential_fields')
    isolated = _isolated_target(isolated_target) if isolated_target is not None else None
    role = isolated['roles'].get(service) if isolated else 'address_radar_' + service.replace('-', '_')
    database = isolated['target']['database'] if isolated else 'address_radar'
    require(service in SERVICES and value['service'] == service and value['username'] == role
            and value['gatewayDeliveryEnabled'] is False and isinstance(value['connectionString'], str),
            'service_credential_binding')
    raw = value['connectionString']
    require(0 < len(raw) <= 16384 and not any(ord(c) < 33 or ord(c) == 127 for c in raw)
            and not re.search(r'%(?![a-fA-F0-9]{2})', raw), 'service_credential_url')
    try:
        url = urllib.parse.urlsplit(raw)
        valid = (url.scheme == 'postgresql' and url.hostname == '127.0.0.1' and url.port == 5432
                 and url.path == '/' + database and not url.query and not url.fragment
                 and '?' not in raw and '#' not in raw
                 and urllib.parse.unquote(url.username or '') == role and bool(url.password))
    except (ValueError, UnicodeError):
        valid = False
    require(valid, 'service_credential_target')
    return raw


def environment_file(environment):
    require(all(re.fullmatch('[A-Z][A-Z0-9_]*', key) and isinstance(value, str)
                and not any(ord(c) < 32 or ord(c) == 127 for c in value)
                for key, value in environment.items()), 'environment_injection')
    return ''.join(key + '=' + json.dumps(value, ensure_ascii=False) + '\n'
                   for key, value in sorted(environment.items())).encode()


def validate_capacity(value, expected, now_ms, live=True):
    require(isinstance(value, dict) and type(value.get('measuredAtMs')) is int
            and 0 <= now_ms - value['measuredAtMs'] <= 60000
            and all(value.get(key) == item for key, item in expected.items()), 'resource_evidence_stale_or_unbound')
    if live:
        require(value.get('scope') == 'six-services-live-waiting-startup' and value.get('readyServices') == 6
                and value.get('steadyStateCapacityVerified') is False
                and value.get('sourceMonitoringCompleted') is False, 'live_waiting_capacity_required')


def validate_waiting_host(host, prestart=False):
    require(host.get('totalRamBytes', 0) >= WAITING_POLICY['minimumTotalRamBytes'], 'waiting_host_total_ram_below_policy')
    require(host.get('availableDiskBytes', 0) >= WAITING_POLICY['minimumDiskBytes'], 'waiting_host_disk_below_policy')
    if prestart:
        require(host.get('availableRamBytes', 0) >= WAITING_POLICY['minimumPrestartAvailableRamBytes'],
                'waiting_prestart_available_ram_below_policy')


def validate_waiting_limits(memory_max, pids_max):
    require(memory_max == str(WAITING_MEMORY_MAX) and pids_max == str(WAITING_TASKS_MAX),
            'waiting_cgroup_limits_mismatch')


def activate_units(journal, adapter):
    """No guard release until ALL six replacements are durable and effectively loaded."""
    try:
        for service in SERVICES:
            journal.action('publish', service, lambda service=service: adapter.publish(service))
            journal.state['units'][service]['published'] = True
            journal.save()
        journal.action('reload-blocked', 'six-services', adapter.reload)
        adapter.verify_published()
        journal.state['phase'] = 'PUBLISHED'; journal.save()
        for service in SERVICES:
            adapter.fresh()
            journal.action('unguard', service, lambda service=service: adapter.unguard(service))
            journal.state['units'][service]['unguarded'] = True
            journal.save()
        journal.action('reload-postgresql', 'six-services', adapter.reload)
        adapter.verify_published()
        for service in SERVICES:
            adapter.fresh()
            journal.action('start', service, lambda service=service: adapter.start(service))
            journal.state['units'][service]['started'] = True
            journal.save()
        journal.state['phase'] = 'WAITING_READY'; journal.save()
        ready = adapter.ready()
        require(set(ready) == set(SERVICES), 'six_bound_readiness_required')
        for service in SERVICES:
            journal.state['units'][service]['ready'] = ready[service]
        journal.state['capacity'] = adapter.capacity()
        journal.state['phase'] = 'READY'; journal.save()
        receipt = adapter.complete()
        journal.state['receipt'] = receipt
        journal.state['phase'] = 'COMPLETE'; journal.save()
        return receipt
    except BaseException:
        journal.state['phase'] = 'REBLOCK_REQUIRED'; journal.save()
        adapter.reblock()
        journal.state['phase'] = 'BLOCKED'; journal.save()
        raise


def sealed_file(path, maximum, check):
    protected_parent(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == ROOT_UID and before.st_nlink == 1
                and not before.st_mode & 0o222 and 0 < before.st_size <= maximum, 'unsealed_runtime')
        digest, body = hashlib.sha256(), bytearray()
        while True:
            check()
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            digest.update(chunk)
            if maximum <= 4 * 1024**2:
                body.extend(chunk)
        require(stamp(before) == stamp(os.fstat(fd)) == stamp(os.lstat(path)), 'sealed_runtime_changed')
        return {'sha256': digest.hexdigest(), 'stamp': list(stamp(before)), 'size': before.st_size}, bytes(body)
    finally:
        os.close(fd)


def release_inventory(root, check):
    protected_parent(Path(root) / 'placeholder')
    digest, pins, total = hashlib.sha256(), {}, 0
    device = os.lstat(root).st_dev
    def walk(path):
        nonlocal total
        check()
        info = path.lstat()
        require(len(pins) < 10000 and info.st_dev == device and info.st_uid == ROOT_UID
                and not info.st_mode & 0o222 and not stat.S_ISLNK(info.st_mode), 'unsealed_release')
        name = path.relative_to(root).as_posix() if path != root else '.'
        pins[str(path)] = list(stamp(info))
        record = {'path': name, 'mode': stat.S_IMODE(info.st_mode), 'kind': 'directory' if path.is_dir() else 'file'}
        if path.is_dir():
            digest.update(encode(record) + b'\n')
            for child in sorted(path.iterdir()):
                walk(child)
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_release_file')
            total += info.st_size
            require(total <= 128 * 1024**2, 'release_byte_budget')
            pin, _ = sealed_file(path, 128 * 1024**2, check)
            record.update(size=info.st_size, sha256=pin['sha256'])
            digest.update(encode(record) + b'\n')
    root = Path(root)
    walk(root)
    return {'releaseSha256': digest.hexdigest(), 'entries': len(pins), 'bytes': total, 'pins': pins}


class ReadinessSocket:
    def __init__(self, path, group, check):
        self.path, self.check = Path(path), check
        self.selector, self.connections = selectors.DefaultSelector(), {}
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.server.bind(str(path))
            os.chown(path, ROOT_UID, group); os.chmod(path, 0o620)
            self.server.listen(8); self.server.setblocking(False)
            self.selector.register(self.server, selectors.EVENT_READ)
        except BaseException:
            self.server.close(); self.selector.close(); raise

    def receive(self, seconds, validate):
        end, ready = time.monotonic() + seconds, {}
        while len(ready) < 6:
            self.check()
            require(time.monotonic() < end, 'six_service_readiness_timeout')
            for key, _ in self.selector.select(min(0.25, max(0, end - time.monotonic()))):
                if key.fileobj is self.server:
                    connection, _ = self.server.accept(); connection.setblocking(False)
                    require(len(self.connections) < 16, 'readiness_connection_budget')
                    credentials = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    self.connections[connection] = [bytearray(), credentials, time.monotonic()]
                    self.selector.register(connection, selectors.EVENT_READ)
                else:
                    connection = key.fileobj
                    buffer, peer, _ = self.connections[connection]
                    chunk = connection.recv(2049 - len(buffer)); buffer.extend(chunk)
                    require(len(buffer) <= 2048, 'readiness_message_budget')
                    if not chunk or b'\n' in buffer:
                        try:
                            value = json.loads(buffer)
                            proof = validate(value, peer)
                            require(proof['service'] not in ready, 'duplicate_service_readiness')
                            ready[proof['service']] = proof
                        finally:
                            self.selector.unregister(connection); connection.close(); del self.connections[connection]
            for _, _, started in self.connections.values():
                require(time.monotonic() - started <= 3, 'readiness_partial_message_timeout')
        return ready

    def close(self):
        for connection in self.connections:
            connection.close()
        self.selector.close(); self.server.close()
        if os.path.lexists(self.path):
            info = self.path.lstat()
            require(stat.S_ISSOCK(info.st_mode) and info.st_uid == ROOT_UID, 'readiness_socket_replaced')
            os.unlink(self.path)


class NativeActivation:
    def __init__(self, controller, config, generator, fence_module, fence, journal, release, node, *, isolated_target=None):
        self.controller, self.config, self.generator = controller, config, generator
        self.module, self.fence, self.journal = fence_module, fence, journal
        self.state, self.release, self.node = journal.state, Path(release), Path(node)
        self.output = Path(config['outputDirectory'])
        self.isolated_target = isolated_target
        isolated = _isolated_target(isolated_target) if isolated_target is not None else None
        self.directory = (Path(isolated['scope']) / 'runtime' if isolated else Path('/etc/address-radar')) / ('postgresql-' + config['operationId'])
        self.auth = Path(isolated['scope']) / 'auth' if isolated else Path(AUTH)
        self.account = pwd.getpwnam('address-radar')
        self.listener = None
        self.check = fence._check_recovery_guard

    def file_descriptor(self, path):
        info = os.lstat(path)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAXIMUM_BYTES,
                'activation_file_changed')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(fd, MAXIMUM_BYTES + 1)
            require(stamp(info) == stamp(os.fstat(fd)) == stamp(os.lstat(path)), 'activation_file_changed')
        finally:
            os.close(fd)
        return {'sha256': sha(raw), 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}

    def managed(self, path, raw, mode=0o600, owner=None):
        path = Path(path); protected_parent(path)
        uid, gid = (owner.pw_uid, owner.pw_gid) if owner else (ROOT_UID, ROOT_GID)
        desired = {'sha256': sha(raw), 'uid': uid, 'gid': gid, 'mode': mode}
        old = self.state['artifacts'].get(str(path))
        if os.path.lexists(path):
            require(old is not None and self.file_descriptor(path) in (old['desired'], old.get('previous')),
                    'unowned_activation_file')
        temporary = path.with_name('.activation-' + sha(self.config['operationId'].encode())[:16] + '-' + path.name + '.tmp')
        require(old is not None or not os.path.lexists(temporary), 'unowned_activation_temporary')
        previous = self.file_descriptor(path) if os.path.lexists(path) else None
        self.state['artifacts'][str(path)] = {'desired': desired, 'previous': previous}
        def publish():
            if os.path.lexists(temporary):
                info = temporary.lstat()
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                        and info.st_uid in (ROOT_UID, uid) and not info.st_mode & 0o022, 'unsafe_activation_temporary')
                os.unlink(temporary)
            durable(temporary, raw, mode, owner)
            self.check()
            os.replace(temporary, path); sync_directory(path.parent)
        self.journal.action('file', str(path), publish)
        require(self.file_descriptor(path) == desired, 'activation_publication_mismatch')

    def ensure_directory(self, path, mode):
        path = Path(path); protected_parent(path)
        if not os.path.lexists(path):
            self.journal.action('mkdir', str(path), lambda: os.mkdir(path, mode))
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == ROOT_UID and not info.st_mode & 0o022,
                'unsafe_activation_directory')
        self.journal.action('chmod-directory', str(path), lambda: os.chmod(path, mode, follow_symlinks=False))
        sync_directory(path.parent)

    def dropin(self, service):
        return Path(self.module.MASK_DIRECTORY) / ('address-radar-' + service + '.service.d') / (
            '99-address-only-postgresql-' + self.config['operationId'] + '.conf')

    def source_safe(self):
        self.check(); self.fence._assert_sentinel(); self.fence._verify_source_identities()
        measured = self.state['measurement']
        for unit, record in self.fence.state['guards'].items():
            self.check()
            require(self.module.configuration_stamp(self.module.MASK_DIRECTORY + '/' + unit) == record['fragment'],
                    'activation_original_fragment_changed')
            for path, original in record['originalDropins'].items():
                require(self.module.configuration_stamp(path) == original, 'activation_original_dropin_changed')
            directory = Path(self.module.MASK_DIRECTORY) / (unit + '.d')
            expected_directory = record['originalDirectory'] or record['createdDirectory']
            require(self.module.directory_stamp(str(directory)) == expected_directory, 'activation_unit_directory_changed')
            additional = tuple(getattr(self.fence, '_controller_guard_entries', lambda _unit: ())(unit))
            require(additional in ((), ('zzzzzz-address-radar-pg-source-fence.conf',)),
                    'activation_invalid_controller_guard')
            allowed = set(record['originalEntries']) | {self.fence._guard_name()} | set(additional)
            service = next((s for s in SERVICES if unit == 'address-radar-' + s + '.service'), None)
            replacement = self.dropin(service) if service else None
            if replacement and os.path.lexists(replacement):
                artifact = self.state['artifacts'].get(str(replacement))
                require(artifact is not None and self.file_descriptor(replacement) in
                        (artifact['desired'], artifact.get('previous')), 'activation_dropin_changed')
                allowed.add(replacement.name)
            require(set(os.listdir(directory)) <= allowed and set(record['originalEntries']) <= set(os.listdir(directory)),
                    'activation_untracked_dropin')
            guard = Path(self.fence._guard_path(unit))
            if os.path.lexists(guard):
                self.guard_identity(unit, guard)
            else:
                require(replacement is not None and os.path.lexists(replacement), 'activation_writer_exclusion_missing')
            if service is None:
                current = self.module.unit_state(unit, self.fence.deadline)
                require(current.get('ActiveState') in ('inactive', 'failed') and not current.get('Job', '').strip()
                        and sorted(current.get('DropInPaths', '').split()) == sorted(record['effectiveDropins'] + [str(guard)]),
                        'non_postgresql_writer_reactivated')
        for unit in self.fence.state['masks']:
            require(self.fence._owned_mask(unit), 'non_postgresql_mask_changed')
            current = self.module.unit_state(unit, self.fence.deadline)
            require(current.get('ActiveState') in ('inactive', 'failed') and not current.get('Job', '').strip(),
                    'non_postgresql_writer_reactivated')
        for row in measured['sources']:
            require(self.module.file_stamp(row['path']) == row, 'activation_source_changed')
        require(self.module.file_stamp(measured['backup']['path']) == measured['backup']['stamp'], 'activation_backup_changed')
        require(self.module.directory_stamp(self.module.SOURCE_DIRECTORY) == measured['sourceDirectory'], 'activation_source_directory_changed')
        self.module.assert_no_source_writers(self.module.source_handles(
            measured['sources'] + [measured['backup']['stamp']], self.fence.deadline))
        self.fence.assert_protected_unchanged()

    def guard_identity(self, unit, path):
        actual = self.module.configuration_stamp(str(path), linked=True)
        expected = self.fence.state['guards'][unit]['identity']
        require((actual['device'], actual['inode']) == (expected['device'], expected['inode'])
                and actual['sha256'] == sha(self.fence._guard_body()) and actual['mode'] == 0o600,
                'activation_guard_changed')

    def unguard(self, service):
        self.source_safe()
        unit = 'address-radar-' + service + '.service'
        path = Path(self.fence._guard_path(unit))
        self.guard_identity(unit, path)
        # Keep the directory: it now contains an owned PG drop-in and may contain user files.
        self.check(); os.unlink(path); sync_directory(path.parent)

    def reload(self):
        self.check(); self.fence.deadline.command(['/usr/bin/systemctl', 'daemon-reload']); self.check()

    def unit(self, service):
        self.check()
        raw = self.fence.deadline.command(['/usr/bin/systemctl', 'show', 'address-radar-' + service + '.service',
            '-p', 'MainPID', '-p', 'InvocationID', '-p', 'ControlGroup', '-p', 'ActiveState', '-p', 'User',
            '-p', 'ExecStart', '-p', 'EnvironmentFiles', '-p', 'DropInPaths', '-p', 'MemoryMax', '-p', 'TasksMax'])
        self.check()
        return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

    def verify_published(self):
        self.source_safe()
        for service in SERVICES:
            self.check()
            path = self.dropin(service)
            require(self.file_descriptor(path) == self.state['artifacts'][str(path)]['desired'], 'activation_dropin_changed')
            state = self.unit(service)
            validate_waiting_limits(state.get('MemoryMax'), state.get('TasksMax'))
            argv = 'argv[]=' + str(self.node) + ' --no-global-search-paths ' + str(self.release / 'scripts/postgres-address-only-dispatch.mjs') + ' ' + service + ' ;'
            require(state.get('User') == self.account.pw_name and state.get('ExecStart', '').count('path=') == 1
                    and argv in state['ExecStart'] and str(path) in state.get('DropInPaths', '').split()
                    and state.get('EnvironmentFiles') == str(self.directory / (service + '.env')) + ' (ignore_errors=no)',
                    'effective_postgresql_unit_mismatch')

    def publish(self, service):
        require(self.state.get('waitingResourcePolicy') == WAITING_POLICY, 'explicit_waiting_resource_policy_required')
        import grp
        group = grp.getgrgid(self.account.pw_gid).gr_name
        body = ('[Service]\nUser=' + self.account.pw_name + '\nGroup=' + group + '\nSupplementaryGroups=\n'
            'EnvironmentFile=\nEnvironmentFile=' + str(self.directory / (service + '.env')) + '\n'
            'ExecStart=\nExecStart=' + str(self.node) + ' --no-global-search-paths ' + str(self.release)
            + '/scripts/postgres-address-only-dispatch.mjs ' + service + '\nWorkingDirectory=' + str(self.release) + '\n'
            'MemoryMax=' + str(WAITING_MEMORY_MAX) + '\nTasksMax=' + str(WAITING_TASKS_MAX) + '\n'
            'NoNewPrivileges=yes\nUnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_COMPILE_CACHE NODE_PG_FORCE_NATIVE TSX_TSCONFIG_PATH\n')
        self.managed(self.dropin(service), body.encode(), 0o644)

    def reblock(self):
        # A crash may interrupt any of these idempotent, write-ahead steps. Never remove user files.
        self.source_safe()
        for service in SERVICES:
            unit = 'address-radar-' + service + '.service'
            path, anchor = Path(self.fence._guard_path(unit)), Path(self.fence._guard_anchor(unit))
            self.guard_identity(unit, anchor)
            if os.path.lexists(path):
                self.guard_identity(unit, path)
            else:
                self.journal.action('reblock', service, lambda path=path, anchor=anchor: (os.link(anchor, path), sync_directory(path.parent)))
        self.journal.action('reload-reblocked', 'six-services', self.reload)
        for service in SERVICES:
            self.journal.action('stop-pg', service, lambda service=service: self.fence.deadline.command(
                ['/usr/bin/systemctl', 'stop', '--no-block', 'address-radar-' + service + '.service']))
        end = time.monotonic() + 20
        for service in SERVICES:
            while self.unit(service).get('ActiveState') not in ('inactive', 'failed'):
                self.check(); require(time.monotonic() < end, 'postgresql_reblock_stop_timeout'); time.sleep(0.1)
        for service in SERVICES:
            path = self.dropin(service)
            if os.path.lexists(path):
                row = self.state['artifacts'].get(str(path))
                require(row is not None and self.file_descriptor(path) in (row['desired'], row.get('previous')), 'unowned_activation_dropin')
                self.journal.action('remove-owned-pg-dropin', service, lambda path=path: (os.unlink(path), sync_directory(path.parent)))
            self.state['units'][service] = {}
        self.journal.action('reload-native-guards', 'six-services', self.reload)
        self.fence._assert_writers_blocked(); self.source_safe()
        if str(self.output / 'activation-receipt.json') in self.state['artifacts']:
            self.managed(self.output / 'activation-receipt.json', encode({'operationId': self.config['operationId'],
                'databaseImported': True, 'businessReleaseSwitched': False, 'status': 'blocked-preserve-postgres',
                'gatewayDeliveryEnabled': False, 'sourceMonitoring': 'waiting_configuration'}))

    def host(self):
        memory = {}
        with open('/proc/meminfo') as stream:
            for line in stream:
                if line.startswith(('MemTotal:', 'MemAvailable:')):
                    memory[line.split(':')[0]] = int(line.split()[1]) * 1024
        disk = shutil.disk_usage('/var/lib/postgresql')
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        require(memory.get('MemAvailable', 0) > 0 and disk.free > 0 and re.fullmatch('[a-f0-9-]{36}', boot), 'host_resources_unavailable')
        return {'bootId': boot, 'availableRamBytes': memory['MemAvailable'], 'totalRamBytes': memory['MemTotal'],
                'availableDiskBytes': disk.free, 'totalDiskBytes': disk.total}

    def fresh(self):
        self.check()
        pins = dict(self.state['release']['pins']); pins[str(self.node)] = self.state['node']['stamp']
        for path, expected in pins.items():
            require(list(stamp(os.lstat(path))) == expected, 'activation_runtime_changed')
        host = self.host()
        require(self.state.get('waitingResourcePolicy') == WAITING_POLICY, 'explicit_waiting_resource_policy_required')
        validate_waiting_host(host)
        require(host['bootId'] == self.state['bootId'], 'activation_host_rebooted')
        value = {'scope': 'host-runtime-prestart', 'measuredAtMs': int(time.time() * 1000),
                 'nodeSha256': self.state['node']['sha256'], 'releaseSha256': self.state['release']['releaseSha256'],
                 **host, 'steadyStateCapacityVerified': False, 'sourceMonitoringCompleted': False}
        validate_capacity(value, self.expected_resources(), int(time.time() * 1000), live=False)
        self.state['resources'] = value; self.journal.save()

    def expected_resources(self):
        return {'nodeSha256': self.state['node']['sha256'], 'releaseSha256': self.state['release']['releaseSha256'], 'bootId': self.state['bootId']}

    def readable_preflight(self):
        program = """import os,sys,hashlib
for path,digest in zip(sys.argv[1:5:2],sys.argv[2:5:2]):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW); raw=os.read(fd,524289);os.close(fd)
 if hashlib.sha256(raw).hexdigest()!=digest:raise SystemExit(1)
for path in sys.argv[5:]:
 try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 except PermissionError:continue
 else:os.close(fd);raise SystemExit(2)
"""
        arguments = ['/usr/bin/python3', '-I', '-B', '-c', program,
            str(self.directory / 'deployment.json'), self.state['artifacts'][str(self.directory / 'deployment.json')]['desired']['sha256'],
            str(self.directory / 'evidence.json'), self.state['artifacts'][str(self.directory / 'evidence.json')]['desired']['sha256'],
            *[str(self.directory / (s + '.env')) for s in SERVICES]]
        self.check()
        child = subprocess.run(arguments, user=self.account.pw_uid, group=self.account.pw_gid, extra_groups=[],
            env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=10, close_fds=True)
        require(child.returncode == 0, 'actual_service_uid_permissions_failed'); self.check()

    def prepare(self, manifest):
        self.source_safe()
        self.state['attempt'] = secrets.token_hex(16); self.journal.save()
        self.ensure_directory(self.directory, 0o755)
        reviewed = {'manifest': manifest, 'releaseRoot': str(self.release),
            'execution': {'maximumEntries': self.state['release']['entries'], 'maximumBytes': self.state['release']['bytes']},
            'roles': (_isolated_target(self.isolated_target)['roles'] if self.isolated_target is not None else {s: 'address_radar_' + s.replace('-', '_') for s in SERVICES}), 'intervalMs': 15000}
        input_path = self.output / 'waiting-deployment-input.json'
        self.managed(input_path, encode(reviewed))
        generated = json.loads(self.controller.bounded_child([str(self.node), '--no-global-search-paths', self.generator['path'], str(input_path)], seconds=60))
        deployment, environment = generated['deployment'], generated['environment']
        require(deployment['sources'] == {'mode': 'waiting_configuration'} and deployment['cutover'] == {'addressOnly': manifest}
                and deployment['releaseRoot'] == str(self.release) and deployment['execution'] == reviewed['execution']
                and deployment['executionFormat'] == 'compiled-esm' and all(environment.get(name) == 'false' for name in FLAGS),
                'activation_configuration_changed')
        self.state['waitingResourcePolicy'] = dict(WAITING_POLICY); self.journal.save()
        raw = encode(deployment)
        self.managed(self.directory / 'deployment.json', raw, 0o400, self.account)
        measured = self.state['measurement']
        evidence = {'protocol': 'address-only-native-startup-evidence-v1',
            **{key: manifest[key] for key in ('operationId', 'importId', 'generationId', 'releaseSha256', 'backupSha256', 'fenceSha256')},
            'deploymentSha256': sha(raw), 'safetyEnvironmentSha256': sha(encode([[name, 'false'] for name in FLAGS])),
            'measuredAt': int(time.time() * 1000), 'sourceEpoch': [
                {'path': row['path'], **{key: str(row[key]) for key in ('device', 'inode', 'size', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs')}}
                for row in measured['sources']], 'sourceSealed': True, 'importCommitted': True,
            'gatewayDeliveryEnabled': False, 'fomoEnabled': False, 'fullHistoricalMiningEnabled': False}
        evidence_raw = encode(evidence); self.managed(self.directory / 'evidence.json', evidence_raw, 0o444)
        run = Path('/run/address-radar-activation'); self.ensure_directory(run, 0o711)
        socket_path = run / (sha(self.config['operationId'].encode())[:16] + '-' + self.state['attempt'][:16] + '.sock')
        self.listener = ReadinessSocket(socket_path, self.account.pw_gid, self.check)
        entry_pin, _ = sealed_file(self.release / 'scripts/postgres-service-entry.mjs', 128 * 1024**2, self.check)
        environment.update({'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE': str(self.directory / 'deployment.json'),
            'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256': sha(raw), 'ADDRESS_RADAR_POSTGRES_ENTRY_SHA256': entry_pin['sha256'],
            'ADDRESS_RADAR_POSTGRES_RELEASE_SHA256': manifest['releaseSha256'],
            'ADDRESS_RADAR_POSTGRES_ADDRESS_ONLY_EVIDENCE_FILE': str(self.directory / 'evidence.json'),
            'ADDRESS_RADAR_POSTGRES_ADDRESS_ONLY_EVIDENCE_SHA256': sha(evidence_raw),
            'ADDRESS_RADAR_POSTGRES_ACTIVATION_SOCKET': str(socket_path), 'ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT': self.state['attempt'],
            'ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION': manifest['operationId'], 'ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION': manifest['generationId']})
        for service in SERVICES:
            value = private_json(self.auth / (service + '.json'), 65536)
            env = dict(environment, ADDRESS_RADAR_POSTGRES_URL=credential_url(value, service, isolated_target=self.isolated_target))
            self.managed(self.directory / (service + '.env'), environment_file(env))
        self.readable_preflight(); self.fresh()
        validate_waiting_host(self.state['resources'], prestart=True)
        self.state['phase'] = 'PREPARED'; self.journal.save()

    def start(self, service):
        # Check the full startup headroom only before the first service consumes it.
        if not any(row.get('started') for row in self.state['units'].values()):
            self.fresh(); validate_waiting_host(self.state['resources'], prestart=True)
        self.check(); self.fence.deadline.command(['/usr/bin/systemctl', 'start', '--no-block', 'address-radar-' + service + '.service']); self.check()

    def process(self, pid, service, child=False, parent=None):
        require(type(pid) is int and pid > 1, 'readiness_pid_invalid')
        base = Path('/proc') / str(pid)
        before = (base / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        status = dict(line.split(':', 1) for line in (base / 'status').read_text().splitlines() if ':' in line)
        require(all(int(uid) == self.account.pw_uid for uid in status['Uid'].split()), 'readiness_uid_mismatch')
        if child:
            require(int(status['PPid']) == parent, 'readiness_child_parent_mismatch')
        require(os.path.realpath(base / 'exe') == os.path.realpath(self.node), 'readiness_node_mismatch')
        expected = [str(self.node), '--no-global-search-paths', str(self.release / 'scripts' / (
            'postgres-service-entry.mjs' if child else 'postgres-address-only-dispatch.mjs')), service]
        raw = (base / 'cmdline').read_bytes()
        require(len(raw) <= 16384 and raw.rstrip(b'\0').split(b'\0') == [part.encode() for part in expected], 'readiness_argv_mismatch')
        cgroup = (base / 'cgroup').read_text().strip()
        after = (base / 'stat').read_text().rsplit(')', 1)[1].split()[19]
        require(before == after, 'readiness_pid_reused')
        return {'startTime': before, 'cgroup': cgroup}

    def validate_ready(self, value, peer):
        require(isinstance(value, dict) and set(value) == {'relayProtocol', 'type', 'service', 'operationId', 'generationId',
                'releaseSha256', 'nonce', 'attempt', 'childPid'}, 'readiness_fields')
        require(value['relayProtocol'] == 'address-only-ready-relay-v1' and value['type'] == 'postgres-service-ready'
                and value['service'] in SERVICES and value['operationId'] == self.config['operationId']
                and value['generationId'] == self.state['measurement']['binding']['generationId']
                and value['releaseSha256'] == self.state['release']['releaseSha256'] and value['attempt'] == self.state['attempt']
                and isinstance(value['nonce'], str) and re.fullmatch('[a-f0-9]{32}', value['nonce']), 'readiness_binding_mismatch')
        pid, uid, gid = peer
        require(uid == self.account.pw_uid and gid == self.account.pw_gid, 'readiness_peer_mismatch')
        service = value['service']; unit = self.unit(service)
        require(str(pid) == unit.get('MainPID') and unit.get('InvocationID') and unit.get('ControlGroup'), 'readiness_main_pid_mismatch')
        main = self.process(pid, service)
        worker = self.process(value['childPid'], service, child=True, parent=pid)
        require(main['cgroup'] == worker['cgroup'] == '0::' + unit['ControlGroup'], 'readiness_unit_cgroup_mismatch')
        environment = (Path('/proc') / str(value['childPid']) / 'environ').read_bytes()
        require(len(environment) <= 65536 and b'ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE=' + value['nonce'].encode() in environment.split(b'\0'),
                'readiness_launch_nonce_mismatch')
        return {**value, 'mainPid': pid, 'invocationId': unit['InvocationID'], 'mainStartTime': main['startTime'], 'childStartTime': worker['startTime']}

    def ready(self):
        require(self.listener is not None, 'readiness_listener_missing')
        result = self.listener.receive(60, self.validate_ready)
        self.source_safe(); return result

    def verify_ready(self):
        for service in SERVICES:
            expected = self.state['units'][service].get('ready')
            require(isinstance(expected, dict), 'six_bound_readiness_required')
            value = {key: expected[key] for key in ('relayProtocol', 'type', 'service', 'operationId', 'generationId', 'releaseSha256', 'nonce', 'attempt', 'childPid')}
            actual = self.validate_ready(value, (expected['mainPid'], self.account.pw_uid, self.account.pw_gid))
            require(actual == expected, 'service_restarted_after_readiness')

    def capacity(self):
        self.verify_ready(); self.fresh()
        units = {}
        for service in SERVICES:
            unit = self.unit(service); group = unit['ControlGroup']
            require(group.startswith('/system.slice/') and '..' not in group.split('/'), 'capacity_cgroup_scope')
            path = Path('/sys/fs/cgroup' + group)
            current, peak = int((path / 'memory.current').read_text()), int((path / 'memory.peak').read_text())
            require(current > 0 and peak >= current, 'live_service_memory_unavailable')
            memory_max = (path / 'memory.max').read_text().strip()
            pids_max = (path / 'pids.max').read_text().strip()
            validate_waiting_limits(memory_max, pids_max)
            require(current <= WAITING_MEMORY_MAX, 'waiting_service_memory_above_policy')
            units[service] = {'memoryCurrentBytes': current, 'memoryPeakBytes': peak,
                'memoryMax': memory_max, 'pidsMax': pids_max, 'mainPid': int(unit['MainPID'])}
        value = {**self.state['resources'], 'scope': 'six-services-live-waiting-startup',
            'measuredAtMs': self.state['resources']['measuredAtMs'], 'readyServices': 6, 'services': units,
            'steadyStateCapacityVerified': False, 'sourceMonitoringCompleted': False}
        validate_capacity(value, self.expected_resources(), int(time.time() * 1000)); self.source_safe()
        return value

    def complete(self):
        self.verify_ready(); self.source_safe()
        validate_capacity(self.state['capacity'], self.expected_resources(), int(time.time() * 1000))
        receipt = {'protocol': 'address-only-activation-receipt-v1', 'operationId': self.config['operationId'],
            'generationId': self.state['measurement']['binding']['generationId'], 'releaseSha256': self.state['release']['releaseSha256'],
            'attempt': self.state['attempt'], 'databaseImported': True, 'businessReleaseSwitched': True,
            'sourceMonitoring': 'waiting_configuration', 'monitoringCompleted': False,
            'gatewayDeliveryEnabled': False, 'releaseRoot': str(self.release), 'acceptance': 'six-services-live-ready-waiting',
            'resourceMeasuredAtMs': self.state['capacity']['measuredAtMs'], 'steadyStateCapacityVerified': False}
        if self.isolated_target is not None:
            receipt.update(proofScope='isolated-activation', isolatedJob=_isolated_target(self.isolated_target)['jobPin'])
        self.managed(self.output / 'activation-receipt.json', encode(receipt))
        return receipt


def activate(controller, config, generator, release=RELEASE, node=NODE):
    return _activate(controller, config, generator, release, node)


def _activate(controller, config, generator, release=RELEASE, node=NODE, *, isolated_target=None):
    require(os.geteuid() == ROOT_UID and os.uname().sysname == 'Linux', 'native_root_linux_required')
    isolated = _isolated_target(isolated_target) if isolated_target is not None else None
    config = _isolated_config(controller,config,Path(isolated['scope'])) if isolated else controller.validate_config(config)
    controller.pinned_read(generator)
    protected_parent(Path(config['outputDirectory']) / 'activation-state.json')
    module = controller.load_module('activation_fence', config['fence'])
    reconcile = controller.load_module('activation_reconcile', config['reconcile'])
    if isolated:
        scope = Path(isolated['scope'])
        _isolated_fence_scope(module,scope)
    fence = module.NativeSourceFence.recover(module.Deadline(240))
    adapter = None
    try:
        require(fence.operation_id == config['operationId'], 'activation_operation_changed')
        require(all('address-radar-' + service + '.service' in fence.state['guards'] for service in SERVICES), 'local_unit_guard_required')
        if isolated:
            require(fence.state['binding']['target'] == isolated['target'] and fence.state['binding']['generationId'] == isolated['generationId'], 'isolated_activation_fence_binding')
        output = Path(config['outputDirectory']); manifest = private_json(output / 'address-only-manifest.json')
        state_path = output / 'activation-state.json'
        previous = private_json(state_path) if os.path.lexists(state_path) else None
        if previous is None:
            fence.reconcile_committed_import(reconcile.reconcile_import)
            measured = fence.measure()
            require(all(manifest[key] == measured['binding'][key] for key in ('operationId', 'importId', 'generationId', 'planSha256'))
                    and manifest['backupSha256'] == measured['backupSha256'] and manifest['fenceSha256'] == measured['fenceSha256'], 'manifest_fence_changed')
            previous = {'protocol': 'address-only-activation-state-v1', 'operationId': config['operationId'], 'phase': 'PREPARED',
                'configSha256': sha(encode(config)), 'generator': generator, 'manifestSha256': sha(encode(manifest)),
                'releaseRoot': release, 'nodePath': node, 'measurement': measured,
                'units': {s: {} for s in SERVICES}, 'artifacts': {}, 'pending': None}
        if isolated and 'isolatedActivation' not in previous:
            require(not os.path.lexists(state_path), 'isolated_activation_resume')
            previous['isolatedActivation'] = isolated
        require(previous.get('isolatedActivation') == isolated, 'isolated_activation_resume')
        require(previous['protocol'] == 'address-only-activation-state-v1' and previous['operationId'] == config['operationId']
                and previous['configSha256'] == sha(encode(config)) and previous['generator'] == generator
                and previous['manifestSha256'] == sha(encode(manifest)) and previous['releaseRoot'] == release and previous['nodePath'] == node,
                'activation_resume_binding_changed')
        fence.deadline = module.Deadline(240)
        with reconcile.reconcile_import(fence.state['binding'], fence.deadline) as outcome:
            fence._validate_outcome(outcome, fence.state['binding'])
            require(outcome.get('committedMatches') is True and outcome.get('importExists') is True, 'activation_committed_import_required')
            with fence._recovery_guard(outcome):
                journal = ActivationJournal(state_path, previous, fence._check_recovery_guard)
                adapter = NativeActivation(controller, config, generator, module, fence, journal, release, node, isolated_target=isolated_target) if isolated else NativeActivation(controller, config, generator, module, fence, journal, release, node)
                if journal.state['phase'] != 'PREPARED' or journal.state.get('pending') or journal.state['artifacts']:
                    if journal.state['phase'] == 'COMPLETE':
                        try:
                            adapter.verify_ready(); journal.state['capacity'] = adapter.capacity(); journal.save()
                            return journal.state['receipt']
                        except Exception:
                            pass
                    adapter.reblock(); journal.state['phase'] = 'BLOCKED'; journal.save()
                runtime, _ = sealed_file(Path(node), 128 * 1024**2, fence._check_recovery_guard)
                require(runtime['sha256'] == config['node']['sha256'], 'activation_node_pin_changed')
                inventory = release_inventory(release, fence._check_recovery_guard)
                require(inventory['releaseSha256'] == manifest['releaseSha256'], 'activation_release_pin_changed')
                _, dispatcher = sealed_file(Path(release) / 'scripts/postgres-address-only-dispatch.mjs', 4 * 1024**2, fence._check_recovery_guard)
                require(b'address-only-ready-relay-v1' in dispatcher, 'readiness_relay_required_rebuild_v2')
                journal.state.update(node=runtime, release=inventory, bootId=adapter.host()['bootId'])
                journal.save()
                try:
                    adapter.prepare(manifest)
                    return activate_units(journal, adapter)
                except BaseException:
                    if journal.state['phase'] not in ('BLOCKED', 'REBLOCK_REQUIRED'):
                        journal.state['phase'] = 'REBLOCK_REQUIRED'; journal.save()
                        adapter.reblock(); journal.state['phase'] = 'BLOCKED'; journal.save()
                    raise
    finally:
        try:
            if adapter and adapter.listener:
                adapter.listener.close()
        finally:
            fence.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('controller', 'controller-sha256', 'config', 'config-sha256', 'generator', 'generator-sha256'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--release-root', default=RELEASE)
    parser.add_argument('--node', default=NODE)
    args = parser.parse_args()
    require(os.geteuid() == ROOT_UID, 'native_root_required')
    # Reuse the controller's independently pinned reader only after checking its own protected path.
    path = Path(args.controller); pin, _ = sealed_file(path, 4 * 1024**2, lambda: None)
    require(pin['sha256'] == args.controller_sha256, 'controller_pin')
    spec = importlib.util.spec_from_file_location('activation_controller', path)
    controller = importlib.util.module_from_spec(spec); spec.loader.exec_module(controller)
    config = json.loads(controller.pinned_read({'path': args.config, 'sha256': args.config_sha256}, 65536))
    print(json.dumps(activate(controller, config, {'path': args.generator, 'sha256': args.generator_sha256}, args.release_root, args.node)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"activation-blocked-or-recovery-required","databaseRollbackAuthorized":false,"gatewayDeliveryEnabled":false}')
        raise SystemExit(1)
