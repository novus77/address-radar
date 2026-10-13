#!/usr/bin/env python3
"""Linux/root sidecar for a retained PRIVATE PG16 fixture.

Parent orchestration installs a root-owned, non-writable pinned copy, calls arm
once, pins the returned record hash, and installs an independent systemd timer.
No timer, service, network connection, SQL, SSH, or production access is performed.

arm --nonce HEX --record ABSOLUTE_PATH --ttl-seconds SECONDS
check|cleanup --nonce HEX --record ABSOLUTE_PATH --expected-sha256 HEX
cleanup additionally accepts --final for explicitly authorized early cleanup.
The record must live outside the fixture in a protected root-owned directory.
Only receipts and fixed error codes are printed; records contain no credentials.

Optional arm: --artifact-root /var/lib/address-radar-rehearsal-artifacts/NONCE
--artifact-control /var/lib/address-radar-rehearsal-artifact-control/NONCE
--artifact-code-pin relative/code.py=SHA256 (repeat for all audited code).
The fixed root adapter provisions both dedicated parent directories as 0700,
each nonce directory as 0700, and independent 48hex owner markers as 0600.
It creates control/lock once as a 0600 single-link file containing 48hex.
Neither control nor lock may ever be replaced or deleted. All adapter writers
use artifact_install_lease before arm and artifact_producer_lease after arm.
seal-artifacts irreversibly closes producers. Control/receipts survives cleanup.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pwd
import re
import secrets
import select
import signal
import stat
import subprocess
import sys
import tempfile
import time

BIN = '/usr/lib/postgresql/16/bin'
MAX_TTL = 10800
MAX_RECORD = 16384
MAX_FILE = 65536
MAX_ARTIFACT_FILE = 16 * 1024 * 1024
MAX_ENTRIES = 100000
MAX_DEPTH = 64
TREE_SECONDS = 10
DELETE_SECONDS = 15
STOP_SECONDS = 15
ARTIFACT_PARENT = '/var/lib/address-radar-rehearsal-artifacts'
CONTROL_PARENT = '/var/lib/address-radar-rehearsal-artifact-control'
FAILED_LEASE_FDS = []
STATE_KEYS = {'version', 'nonce', 'record_sha256', 'phase', 'private_pg',
              'artifacts', 'snapshot_sha256', 'producer'}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
RECORD_KEYS = {'version', 'nonce', 'root', 'uid', 'gid', 'created_at', 'deadline',
               'root_identity', 'data_identity', 'owner_pin', 'connection_pin',
               'system_identifier', 'pid', 'process_ticks', 'postmaster_start',
               'boot_id', 'binaries'}


class Refusal(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refusal(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode('ascii')


def identity(info):
    return [info.st_dev, info.st_ino]


def integer(value):
    return type(value) is int


class Budget:
    def __init__(self, seconds):
        self.until = time.monotonic() + seconds
        self.count = 0

    def check(self, depth):
        require(time.monotonic() < self.until and depth <= MAX_DEPTH, 'tree-bound')


def bounded_names(fd, budget, depth):
    names = []
    budget.check(depth)
    with os.scandir(fd) as entries:
        iterator = iter(entries)
        while True:
            budget.check(depth)
            try:
                entry = next(iterator)
            except StopIteration:
                break
            require(budget.count < MAX_ENTRIES, 'tree-bound')
            budget.count += 1
            names.append(entry.name)
    budget.check(depth)
    return sorted(names)


def mount_id(fd):
    # Inspect only this process's descriptors; detect same-device bind mounts.
    with open('/proc/self/fdinfo/' + str(fd), 'rt', encoding='ascii') as stream:
        text = stream.read(4096)
    match = re.search(r'^mnt_id:\s*([0-9]+)$', text, re.M)
    require(match is not None, 'mount-identity')
    return int(match.group(1))


def protected_path(path):
    require(os.path.isabs(path) and os.path.normpath(path) == path, 'authority-path')
    parts = path.split('/')[1:]
    current = '/'
    for index, part in enumerate(parts):
        current = os.path.join(current, part)
        info = os.lstat(current)
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0, 'authority-owner')
        writable = stat.S_IMODE(info.st_mode) & 0o022
        # A sticky /tmp ancestor is safe only with protected descendants.
        exception = current == '/tmp' and index < len(parts) - 1 and info.st_mode & stat.S_ISVTX
        require(not writable or exception, 'authority-mode')
        if index < len(parts) - 1:
            require(stat.S_ISDIR(info.st_mode), 'authority-directory')


def trusted_runtime():
    require(sys.platform == 'linux' and os.geteuid() == 0, 'runtime-root-linux')
    protected_path(os.path.abspath(__file__))


def read_at(directory, name, uid, mode=0o600, limit=MAX_FILE):
    fd = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == uid and
                stat.S_IMODE(before.st_mode) == mode and before.st_nlink == 1,
                'file-ownership')
        data = os.read(fd, limit + 1)
        require(len(data) <= limit and not os.read(fd, 1), 'file-size')
        after = os.fstat(fd)
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'file-race')
        require(identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) ==
                identity(before), 'file-race')
        return data, {'identity': identity(before), 'sha256': digest(data)}
    finally:
        os.close(fd)


def pin_binary(name):
    path = BIN + '/' + name
    protected_path(path)
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_mode & 0o111, 'binary-type')
        hasher = hashlib.sha256()
        while True:
            chunk = os.read(fd, 131072)
            if not chunk:
                break
            hasher.update(chunk)
        require(identity(os.lstat(path)) == identity(info), 'binary-race')
        return {'identity': identity(info), 'sha256': hasher.hexdigest()}
    finally:
        os.close(fd)


def run_private(record, executable, arguments):
    # No inherited PG*, loader, shell, credential, or locale environment.
    require(pin_binary(executable) == record['binaries'][executable], 'binary-changed')
    return subprocess.run([BIN + '/' + executable, *arguments],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=15, check=False,
                          cwd='/', env={'PATH': BIN, 'LC_ALL': 'C'},
                          user=record['uid'], group=record['gid'], extra_groups=[])


def process_identity(record):
    """Read only the recorded private PID, never enumerate or signal processes."""
    path = '/proc/' + str(record['pid'])
    try:
        fd = os.open(path, DIRECTORY)
    except FileNotFoundError:
        return None
    try:
        require(os.fstat(fd).st_uid == record['uid'], 'pid-owner')
        executable = os.stat('exe', dir_fd=fd)
        require(identity(executable) == record['binaries']['postgres']['identity'], 'pid-executable')
        require(os.readlink('exe', dir_fd=fd) == BIN + '/postgres', 'pid-executable')
        def proc_read(name):
            child = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=fd)
            try:
                value = os.read(child, MAX_FILE + 1)
                require(len(value) <= MAX_FILE, 'pid-data')
                return value
            finally:
                os.close(child)
        command = proc_read('cmdline').split(b'\0')
        require(command[0] == (BIN + '/postgres').encode() and
                any(command[i:i + 2] == [b'-D', (record['root'] + '/data').encode()]
                    for i in range(1, len(command) - 1)), 'pid-command')
        fields = proc_read('stat').rsplit(b')', 1)[1].split()
        require(len(fields) >= 20, 'pid-stat')
        ticks = int(fields[19])
        require(fields[0] not in (b'Z', b'X'), 'pid-state')
        require(identity(os.stat(path, follow_symlinks=False)) == identity(os.fstat(fd)), 'pid-race')
        return ticks
    finally:
        os.close(fd)


def pidfd_live(fd):
    poller = select.poll()
    poller.register(fd, select.POLLIN | select.POLLERR | select.POLLHUP)
    events = poller.poll(0)
    require(all(not event & select.POLLNVAL for _, event in events), 'pidfd-invalid')
    return not events


def stop_private(record, root, data):
    require(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'pidfd-unavailable')
    fd = os.pidfd_open(record['pid'], 0)
    try:
        require(pidfd_live(fd), 'pidfd-exited')
        _, before = read_at(data, 'postmaster.pid', record['uid'])
        require(check_identity(record, root, data) == record['process_ticks'], 'pid-reused')
        require(process_identity(record) == record['process_ticks'], 'pid-reused')
        _, after = read_at(data, 'postmaster.pid', record['uid'])
        require(before == after, 'pidfile-race')
        path_identity(record, root, data)
        require(pidfd_live(fd), 'pidfd-exited')
        # The kernel targets the open process reference, never a mutable PID file.
        signal.pidfd_send_signal(fd, signal.SIGINT, None, 0)
        poller = select.poll()
        poller.register(fd, select.POLLIN | select.POLLERR | select.POLLHUP)
        until = time.monotonic() + STOP_SECONDS
        while pidfd_live(fd):
            remaining = until - time.monotonic()
            require(remaining > 0, 'stop-timeout')
            poller.poll(min(100, max(1, int(remaining * 1000))))
    finally:
        os.close(fd)


def boot_id():
    with open('/proc/sys/kernel/random/boot_id', 'rt', encoding='ascii') as stream:
        value = stream.read(64).strip()
    require(re.fullmatch(r'[a-f0-9-]{36}', value) is not None, 'boot-identity')
    return value


@contextlib.contextmanager
def fixture(record):
    root = os.open(record['root'], DIRECTORY)
    data = None
    try:
        fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        info = os.fstat(root)
        require(info.st_uid == record['uid'] and stat.S_IMODE(info.st_mode) == 0o700,
                'root-ownership')
        if 'root_identity' in record:
            require(identity(info) == record['root_identity'], 'root-changed')
        data = os.open('data', DIRECTORY, dir_fd=root)
        info_data = os.fstat(data)
        require(info_data.st_uid == record['uid'] and stat.S_IMODE(info_data.st_mode) == 0o700 and
                info_data.st_dev == info.st_dev, 'data-ownership')
        if 'data_identity' in record:
            require(identity(info_data) == record['data_identity'], 'data-changed')
        yield root, data
    finally:
        if data is not None:
            os.close(data)
        os.close(root)


def path_identity(record, root, data):
    require(identity(os.lstat(record['root'])) == identity(os.fstat(root)) and
            identity(os.stat('data', dir_fd=root, follow_symlinks=False)) ==
            identity(os.fstat(data)), 'directory-race')


def connection(record, root):
    owner, owner_pin = read_at(root, 'owner', record['uid'])
    require(re.fullmatch(rb'[a-f0-9]{48}', owner) is not None, 'owner-marker')
    raw, connection_pin = read_at(root, 'connection.json', record['uid'])
    value = json.loads(raw)
    name = 'radar_rehearsal_' + record['nonce']
    require(type(value) is dict and set(value) ==
            {'host', 'port', 'database', 'schema', 'username', 'password', 'systemIdentifier', 'nonce'},
            'connection-fields')
    require(value['host'] == '127.0.0.1' and type(value['port']) is int and value['port'] == 5434 and
            value['database'] == name and value['schema'] == name + '_schema' and
            value['username'] == name + '_migrator' and value['nonce'] == record['nonce'] and
            isinstance(value['password'], str) and re.fullmatch(r'[a-f0-9]{64}', value['password']) and
            isinstance(value['systemIdentifier'], str) and
            re.fullmatch(r'[0-9]{1,20}', value['systemIdentifier']), 'connection-pin')
    if 'owner_pin' in record:
        require(owner_pin == record['owner_pin'] and connection_pin == record['connection_pin'] and
                value['systemIdentifier'] == record['system_identifier'], 'connection-changed')
    return owner_pin, connection_pin, value['systemIdentifier']


def pid_record(record, data, optional=False):
    try:
        raw, _ = read_at(data, 'postmaster.pid', record['uid'])
    except FileNotFoundError:
        require(optional, 'pid-missing')
        return None
    lines = raw.decode('ascii').splitlines()
    require(len(lines) >= 8 and re.fullmatch(r'[1-9][0-9]*', lines[0]) and
            lines[1] == record['root'] + '/data' and
            re.fullmatch(r'[1-9][0-9]*', lines[2]) and lines[3] == '5434' and
            lines[4] == record['root'] + '/socket' and lines[5] == '127.0.0.1' and
            lines[7].strip() == 'ready', 'postmaster-pin')
    pid, started = int(lines[0]), int(lines[2])
    require(pid > 1, 'pid-range')
    if 'pid' in record:
        require(pid == record['pid'] and started == record['postmaster_start'], 'pid-changed')
    return pid, started


def validate_record(record, nonce):
    require(type(record) is dict and set(record) in (RECORD_KEYS, RECORD_KEYS | {'artifacts'}), 'record-fields')
    require(record['version'] == 1 and record['nonce'] == nonce and
            record['root'] == '/tmp/radar_rehearsal_' + nonce, 'record-scope')
    require(all(integer(record[k]) for k in ('uid', 'gid', 'created_at', 'deadline',
                                            'pid', 'process_ticks', 'postmaster_start')),
            'record-integers')
    account = pwd.getpwnam('postgres')
    require(record['uid'] == account.pw_uid and record['gid'] == account.pw_gid and
            record['uid'] > 0 and record['pid'] > 1 and record['process_ticks'] > 0,
            'record-owner')
    require(0 < record['deadline'] - record['created_at'] <= MAX_TTL and
            record['created_at'] > 0 and record['postmaster_start'] <= record['created_at'],
            'record-deadline')
    require(record['boot_id'] == boot_id(), 'boot-changed')
    for key in ('root_identity', 'data_identity'):
        require(type(record[key]) is list and len(record[key]) == 2 and
                all(integer(x) and x >= 0 for x in record[key]), 'record-identity')
    require(type(record['binaries']) is dict and set(record['binaries']) ==
            {'pg_ctl', 'postgres', 'pg_controldata'}, 'record-binaries')
    for pin in [record['owner_pin'], record['connection_pin'], *record['binaries'].values()]:
        require(type(pin) is dict and set(pin) == {'identity', 'sha256'} and
                type(pin['identity']) is list and len(pin['identity']) == 2 and
                all(integer(x) and x >= 0 for x in pin['identity']) and
                isinstance(pin['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', pin['sha256']),
                'record-pin')
    require(isinstance(record['system_identifier'], str) and
            re.fullmatch(r'[0-9]{1,20}', record['system_identifier']), 'record-system')
    if 'artifacts' in record:
        value = record['artifacts']
        require(type(value) is dict and set(value) in ({'root', 'identity', 'owner_pin', 'code_pins', 'control'},
                                                 {'root', 'identity', 'owner_pin', 'code_pins', 'control', 'managed'}) and
                value['root'] == ARTIFACT_PARENT + '/' + nonce, 'artifact-record')
        require(type(value['identity']) is list and len(value['identity']) == 2 and
                all(integer(x) and x >= 0 for x in value['identity']), 'artifact-identity')
        require(type(value['code_pins']) is dict and bool(value['code_pins']), 'artifact-code-pins')
        for name in value['code_pins']:
            relative_name(name)
        for pin in [value['owner_pin'], *value['code_pins'].values()]:
            require(type(pin) is dict and set(pin) == {'identity', 'sha256'} and
                    type(pin['identity']) is list and len(pin['identity']) == 2 and
                    all(integer(x) and x >= 0 for x in pin['identity']) and
                    isinstance(pin['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', pin['sha256']),
                    'artifact-pin')
        control = value['control']
        require(type(control) is dict and set(control) == {'root', 'identity', 'owner_pin', 'lock_pin'} and
                control['root'] == CONTROL_PARENT + '/' + nonce, 'control-record')
        require(type(control['identity']) is list and len(control['identity']) == 2 and
                all(integer(x) and x >= 0 for x in control['identity']), 'control-identity')
        for pin in (control['owner_pin'], control['lock_pin']):
            require(type(pin) is dict and set(pin) == {'identity', 'sha256'} and
                    type(pin['identity']) is list and len(pin['identity']) == 2 and
                    all(integer(x) and x >= 0 for x in pin['identity']) and
                    isinstance(pin['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', pin['sha256']),
                    'control-pin')


        if 'managed' in value:
            pins = value['managed']
            require(type(pins) is dict and set(pins) == {'systemctl', 'systemd-run', 'helper', 'python'}, 'managed-record')
            for pin in pins.values():
                require(type(pin) is dict and set(pin) == {'path', 'identity', 'sha256'} and
                        isinstance(pin['path'], str) and os.path.isabs(pin['path']) and
                        os.path.normpath(pin['path']) == pin['path'] and type(pin['identity']) is list and
                        len(pin['identity']) == 2 and all(integer(x) and x >= 0 for x in pin['identity']) and
                        isinstance(pin['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', pin['sha256']), 'managed-record')
            require(pins['systemctl']['path'] == '/usr/bin/systemctl' and
                    pins['systemd-run']['path'] == '/usr/bin/systemd-run', 'managed-record')


def root_directory(fd):
    info = os.fstat(fd)
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'control-ownership')
    return info


@contextlib.contextmanager
def control_scope(nonce, expected=None, path=None):
    """Permanent lock, zero wait, never LOCK_UN on the shared description.

    Closing our FD preserves the kernel lock while any child still holds the
    inherited open description. Reopening a new lock inode is always refused.
    """
    path = expected['root'] if expected is not None else path
    require(path == CONTROL_PARENT + '/' + nonce, 'control-scope')
    protected_path(path)
    parent = os.open(CONTROL_PARENT, DIRECTORY)
    root = lock = None
    try:
        root_directory(parent)
        root = os.open(nonce, DIRECTORY, dir_fd=parent)
        info = root_directory(root)
        require(mount_id(root) == mount_id(parent), 'control-mount')
        if expected is not None:
            require(identity(info) == expected['identity'], 'control-replaced')
        marker, marker_pin = read_at(root, 'owner', 0)
        raw, lock_pin = read_at(root, 'lock', 0)
        require(re.fullmatch(rb'[a-f0-9]{48}', marker) is not None and
                re.fullmatch(rb'[a-f0-9]{48}', raw) is not None, 'control-marker')
        if expected is None:
            expected = {'root': path, 'identity': identity(info), 'owner_pin': marker_pin,
                        'lock_pin': lock_pin}
        require(marker_pin == expected['owner_pin'] and lock_pin == expected['lock_pin'], 'control-pin-changed')
        lock = os.open('lock', os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        lock_info = os.fstat(lock)
        require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid == 0 and
                stat.S_IMODE(lock_info.st_mode) == 0o600 and lock_info.st_nlink == 1 and
                identity(lock_info) == lock_pin['identity'] and mount_id(lock) == mount_id(root),
                'control-lock-replaced')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal('control-locked') from None
        # Verify the path again after acquiring the pinned description.
        _, actual_marker = read_at(root, 'owner', 0)
        _, actual_lock = read_at(root, 'lock', 0)
        require(actual_marker == expected['owner_pin'] and actual_lock == expected['lock_pin'] and
                identity(os.stat(nonce, dir_fd=parent, follow_symlinks=False)) == expected['identity'],
                'control-lock-replaced')
        yield root, lock, expected
    finally:
        if lock is not None:
            os.close(lock)
        if root is not None:
            os.close(root)
        os.close(parent)


def initial_state(record):
    return {'version': 1, 'nonce': record['nonce'], 'record_sha256': digest(canonical(record)),
            'phase': 'open', 'private_pg': 'unproven', 'artifacts': 'present', 'snapshot_sha256': None,
            'producer': None}


def absent_at(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    return False


def write_control_file(fd, name, data, replace=False):
    require(len(data) <= MAX_RECORD, 'control-file-size')
    target = '.state-' + secrets.token_hex(16) if replace else name
    child = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=fd)
    published = False
    try:
        os.fchmod(child, 0o600)
        with os.fdopen(child, 'wb', closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(child)
        if replace:
            os.rename(target, name, src_dir_fd=fd, dst_dir_fd=fd)
        published = True
        os.fsync(fd)
    finally:
        os.close(child)
        if replace and not published:
            os.unlink(target, dir_fd=fd)


def read_control_state(fd, record):
    raw, _ = read_at(fd, 'state.json', 0, limit=MAX_RECORD)
    value = json.loads(raw)
    require(type(value) is dict and set(value) == STATE_KEYS and canonical(value) == raw and
            value['version'] == 1 and value['nonce'] == record['nonce'] and
            value['record_sha256'] == digest(canonical(record)), 'control-state')
    require(value['phase'] in ('open', 'sealed', 'cleaning', 'deleted') and
            value['private_pg'] in ('unproven', 'deleted') and
            value['artifacts'] in ('present', 'deleted') and
            (value['snapshot_sha256'] is None or
             isinstance(value['snapshot_sha256'], str) and
             re.fullmatch(r'[a-f0-9]{64}', value['snapshot_sha256'])), 'control-state')
    require((value['phase'] == 'deleted') == (value['artifacts'] == 'deleted') and
            (value['phase'] not in ('sealed', 'deleted') or value['snapshot_sha256'] is not None),
            'control-state')
    if value['producer'] is not None:
        producer = value['producer']
        require(type(producer) is dict and set(producer) ==
                {'unit', 'request_nonce', 'role', 'phase', 'binding_sha256'}, 'producer-proof')
        require(producer['unit'] == unit_name(record['nonce'], producer['role'], producer['request_nonce']) and
                producer['phase'] in ('pending', 'bound', 'unresolved') and
                (producer['binding_sha256'] is None or isinstance(producer['binding_sha256'], str) and
                 re.fullmatch(r'[a-f0-9]{64}', producer['binding_sha256'])), 'producer-proof')
        require(value['phase'] == ('open' if producer['role'] == 'producer' else 'sealed'), 'producer-proof')
    return value


def update_control_state(fd, record, before, after):
    require(read_control_state(fd, record) == before, 'control-state-race')
    phases = {'open': {'open', 'sealed', 'cleaning'}, 'sealed': {'sealed', 'cleaning'},
              'cleaning': {'cleaning', 'deleted'}, 'deleted': {'deleted'}}
    require(after['phase'] in phases[before['phase']] and
            (before['private_pg'] != 'deleted' or after['private_pg'] == 'deleted') and
            (before['artifacts'] != 'deleted' or after['artifacts'] == 'deleted') and
            (before['snapshot_sha256'] is None or after['snapshot_sha256'] == before['snapshot_sha256']) and
            all(after[key] == before[key] for key in ('version', 'nonce', 'record_sha256')),
            'control-state-regression')
    write_control_file(fd, 'state.json', canonical(after), replace=True)
    return after


def manifest_digest(manifest):
    return digest(canonical([['/'.join(key), manifest[key]] for key in sorted(manifest)]))


def require_absent(path, code):
    try:
        os.lstat(path)
    except FileNotFoundError:
        return
    raise Refusal(code)


SYSTEMD_PROPERTIES = ('Id', 'LoadState', 'Transient', 'InvocationID', 'ControlGroup',
                      'ActiveState', 'SubState', 'Result', 'Type', 'ExitType', 'Restart',
                      'KillMode', 'RuntimeMaxUSec', 'TimeoutStopUSec', 'MemoryMax', 'TasksMax',
                      'CPUQuotaPerSecUSec', 'ProtectSystem', 'ReadOnlyPaths', 'ReadWritePaths',
                      'ProtectControlGroups', 'NoNewPrivileges', 'CapabilityBoundingSet')
UNIT_STOP_SECONDS = 10
UNIT_PROOF_SECONDS = 15
UNIT_LAUNCH_SECONDS = 5


def unit_name(nonce, role, request_nonce):
    require(re.fullmatch(r'[a-f0-9]{16}', nonce) is not None and
            re.fullmatch(r'[a-f0-9]{16}', request_nonce) is not None and
            role in ('producer', 'verifier', 'finalizer'), 'managed-unit-request')
    return 'radar-rehearsal-' + nonce + '-' + role + '-' + request_nonce + '.service'


def root_path_pin(path):
    protected_path(path)
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                info.st_size <= 256 * 1024 * 1024, 'managed-code-file')
        hasher = hashlib.sha256()
        until = time.monotonic() + 10
        while True:
            require(time.monotonic() < until, 'managed-code-bound')
            chunk = os.read(fd, 131072)
            if not chunk:
                break
            hasher.update(chunk)
        after = os.fstat(fd)
        require(identity(os.lstat(path)) == identity(info) and
                file_metadata(info) == file_metadata(after), 'managed-code-race')
        return {'path': path, 'identity': identity(info), 'sha256': hasher.hexdigest()}
    finally:
        os.close(fd)


def managed_pins():
    return {name: root_path_pin(path) for name, path in {
        'systemctl': '/usr/bin/systemctl', 'systemd-run': '/usr/bin/systemd-run',
        'helper': os.path.abspath(__file__), 'python': os.path.realpath(sys.executable)}.items()}


class SystemdBackend:
    def __init__(self, record):
        self.record = record
        require('managed' in record['artifacts'], 'managed-unit-unavailable')
        self.pins = record['artifacts']['managed']

    def run(self, executable, arguments, capture=False):
        pin = self.pins[executable]
        require(root_path_pin(pin['path']) == pin, 'managed-code-changed')
        if executable == 'systemd-run' and hasattr(self, 'launch_until'):
            require(time.monotonic() + self.launch_reserve <= self.launch_until and
                    time.time() + self.launch_reserve <= self.record['deadline'], 'managed-unit-budget')
        try:
            result = subprocess.run([pin['path'], *arguments], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, timeout=5, check=False,
                                    cwd='/', env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        except Exception:
            raise Refusal('managed-manager-unavailable') from None
        require(result.returncode == 0, 'managed-manager-failed')
        if capture:
            require(len(result.stdout) <= MAX_RECORD, 'managed-manager-output')
        return result

    def show(self, unit):
        result = self.run('systemctl', ['show', '--no-pager',
                         '--property=' + ','.join(SYSTEMD_PROPERTIES), unit], capture=True)
        values = {}
        for line in result.stdout.decode('ascii').splitlines():
            require('=' in line, 'managed-manager-output')
            key, value = line.split('=', 1)
            require(key in SYSTEMD_PROPERTIES and key not in values, 'managed-manager-output')
            values[key] = value
        require(set(values) == set(SYSTEMD_PROPERTIES), 'managed-manager-output')
        return values

    def launch(self, unit, command, policy, role):
        properties = {'Type': 'exec', 'ExitType': 'cgroup', 'Restart': 'no',
                      'KillMode': 'control-group', 'SendSIGKILL': 'yes',
                      'RuntimeMaxSec': str(policy['runtime_seconds']),
                      'TimeoutStopSec': str(UNIT_STOP_SECONDS),
                      'MemoryMax': str(policy['memory_max_bytes']), 'TasksMax': str(policy['tasks_max']),
                      'CPUQuota': str(policy['cpu_quota_percent']) + '%',
                      'StandardOutput': 'null', 'StandardError': 'null',
                      'Environment': 'LC_ALL=C PYTHONDONTWRITEBYTECODE=1',
                      'UnsetEnvironment': 'LD_PRELOAD LD_LIBRARY_PATH PYTHONPATH PYTHONHOME NODE_OPTIONS PGOPTIONS PGPASSWORD'}
        if role in ('verifier', 'finalizer'):
            properties.update({'ProtectSystem': 'strict',
                               'ReadOnlyPaths': self.record['artifacts']['root'],
                               'ReadWritePaths': managed_receipt_directory(self.record, unit, role),
                               'ProtectControlGroups': 'yes', 'NoNewPrivileges': 'yes',
                               'CapabilityBoundingSet': ''})
        arguments = ['--quiet', '--unit=' + unit]
        arguments.extend('--property=' + key + '=' + value for key, value in properties.items())
        self.run('systemd-run', [*arguments, '--', *command])


def native_timespan_usec(value):
    """Parse finite native systemctl timespans exactly, without float rounding."""
    require(isinstance(value, str) and 0 < len(value) <= 128, 'managed-unit-limits')
    if re.fullmatch(r'[0-9]+', value):
        return int(value)
    scales = {'us': 1, 'ms': 1000, 's': 1000000, 'min': 60000000,
              'h': 3600000000, 'd': 86400000000, 'w': 604800000000}
    total = 0
    position = 0
    for match in re.finditer(r'([0-9]+)(?:\.([0-9]{1,6}))?(us|ms|min|s|h|d|w)(?: |$)', value):
        require(match.start() == position, 'managed-unit-limits')
        scale = scales[match[3]]
        fraction = match[2] or ''
        numerator = int(match[1]) * 10 ** len(fraction) + int(fraction or '0')
        amount, remainder = divmod(numerator * scale, 10 ** len(fraction))
        require(remainder == 0, 'managed-unit-limits')
        total += amount
        position = match.end()
    require(position == len(value) and position > 0, 'managed-unit-limits')
    return total


def validate_unit_properties(props, unit, policy, role, artifact_root):
    require(props.get('Id') == unit and props.get('LoadState') == 'loaded' and
            props.get('Transient') == 'yes' and
            re.fullmatch(r'[a-f0-9]{32}', props.get('InvocationID', '')) is not None and
            props['InvocationID'] != '0' * 32, 'managed-unit-identity')
    group = props.get('ControlGroup', '')
    require(group.startswith('/') and group != '/' and os.path.normpath(group) == group and
            all(part not in ('.', '..', '') for part in group.split('/')[1:]), 'managed-cgroup-path')
    require(props.get('Type') == 'exec' and props.get('ExitType') == 'cgroup' and
            props.get('Restart') == 'no' and props.get('KillMode') == 'control-group', 'managed-unit-policy')
    expected_limits = {'RuntimeMaxUSec': policy['runtime_seconds'] * 1000000,
                       'TimeoutStopUSec': UNIT_STOP_SECONDS * 1000000,
                       'MemoryMax': policy['memory_max_bytes'], 'TasksMax': policy['tasks_max'],
                       'CPUQuotaPerSecUSec': policy['cpu_quota_percent'] * 10000}
    for key, value in expected_limits.items():
        actual = native_timespan_usec(props.get(key, '')) if key.endswith('USec') else int(props.get(key, '-1'))
        require(actual == value, 'managed-unit-limits')
    if role in ('verifier', 'finalizer'):
        require(props.get('ProtectSystem') == 'strict' and props.get('ReadOnlyPaths') == artifact_root and
                props.get('ReadWritePaths') == policy.get('receipt_directory') and
                isinstance(policy.get('receipt_directory'), str) and
                re.fullmatch(r'/var/lib/address-radar-rehearsal-artifact-control/[a-f0-9]{16}/receipts/[a-f0-9]{16}',
                             policy['receipt_directory']) is not None and
                props.get('ProtectControlGroups') in ('yes', 'true') and
                props.get('NoNewPrivileges') in ('yes', 'true') and
                props.get('CapabilityBoundingSet') in ('', '0'), 'managed-verifier-policy')
    return {'unit': unit, 'invocation_id': props['InvocationID'], 'control_group': group}


class ManagedCgroupProof:
    """Actual path from an authenticated, exact system-manager unit query only.

    No cgroup creation, cgroup.procs writes, controller enable or PID targeting.
    ENOENT/ENODEV, path replacement and manager retirement remain unresolved.
    """
    def __init__(self, binding, capture=False):
        self.binding = binding
        self.path = '/sys/fs/cgroup' + binding['control_group']
        protected_path(self.path)
        self.root = self.events = None
        try:
            self.root = os.open(self.path, DIRECTORY)
            info = os.fstat(self.root)
            require(info.st_uid == 0, 'managed-cgroup-owner')
            self.events = os.open('cgroup.events', os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=self.root)
            event_info = os.fstat(self.events)
            require(stat.S_ISREG(event_info.st_mode) and event_info.st_uid == 0 and
                    event_info.st_nlink == 1 and not event_info.st_mode & 0o022 and
                    mount_id(self.events) == mount_id(self.root), 'managed-cgroup-events')
            if capture:
                binding['identity'] = identity(info)
                binding['events_identity'] = identity(event_info)
            require(identity(info) == binding['identity'] and
                    identity(event_info) == binding['events_identity'], 'managed-cgroup-replaced')
        except Exception:
            self.close()
            raise

    def close(self):
        for name in ('events', 'root'):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def populated(self):
        require(identity(os.lstat(self.path)) == self.binding['identity'] and
                identity(os.stat('cgroup.events', dir_fd=self.root, follow_symlinks=False)) ==
                self.binding['events_identity'], 'managed-cgroup-replaced')
        os.lseek(self.events, 0, os.SEEK_SET)
        raw = os.read(self.events, 4097)
        require(len(raw) <= 4096, 'managed-cgroup-events')
        values = re.findall(rb'^populated ([01])$', raw, re.M)
        require(len(values) == 1, 'managed-cgroup-events')
        require(identity(os.lstat(self.path)) == self.binding['identity'], 'managed-cgroup-replaced')
        return values[0] == b'1'


def invocation_directory(control):
    try:
        os.mkdir('invocations', 0o700, dir_fd=control)
    except FileExistsError:
        pass
    fd = os.open('invocations', DIRECTORY, dir_fd=control)
    try:
        root_directory(fd)
        require(mount_id(fd) == mount_id(control), 'control-mount')
        return fd
    except Exception:
        os.close(fd)
        raise


def invocation_file(control, request_nonce, role, suffix):
    fd = os.open('invocations', DIRECTORY, dir_fd=control)
    try:
        root_directory(fd)
        require(mount_id(fd) == mount_id(control), 'control-mount')
        raw, _ = read_at(fd, request_nonce + '-' + role + '.' + suffix + '.json', 0, limit=MAX_RECORD)
        value = json.loads(raw)
        require(canonical(value) == raw, 'managed-invocation-record')
        return value, digest(raw)
    finally:
        os.close(fd)


def managed_receipt_directory(record, unit, role):
    request = unit.removesuffix('.service').rsplit('-', 1)[-1]
    require(unit == unit_name(record['nonce'], role, request), 'managed-unit-request')
    control = record['artifacts']['control']['root']
    require(control == '/var/lib/address-radar-rehearsal-artifact-control/' + record['nonce'],
            'managed-receipt-path')
    return control + '/receipts/' + request


def create_managed_receipt_directory(control, request_nonce):
    require(re.fullmatch(r'[a-f0-9]{16}', request_nonce) is not None, 'managed-unit-request')
    try:
        os.mkdir('receipts', 0o700, dir_fd=control)
    except FileExistsError:
        pass
    parent = os.open('receipts', DIRECTORY, dir_fd=control)
    try:
        root_directory(parent)
        require(mount_id(parent) == mount_id(control), 'control-mount')
        # Never reuse a producer/verifier/finalizer output inode, including failed requests.
        os.mkdir(request_nonce, 0o700, dir_fd=parent)
        fd = os.open(request_nonce, DIRECTORY, dir_fd=parent)
        try:
            info = root_directory(fd)
            require(mount_id(fd) == mount_id(control), 'control-mount')
            os.fsync(fd)
            os.fsync(parent)
            return identity(info)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def verify_managed_receipt_directory(record, binding):
    path = managed_receipt_directory(record, binding['unit'], binding['role'])
    require(binding['policy'].get('receipt_directory') == path, 'managed-receipt-path')
    protected_path(path)
    fd = os.open(path, DIRECTORY)
    control = os.open(record['artifacts']['control']['root'], DIRECTORY)
    try:
        # ReadWritePaths may bind-mount this exact inode into the unit sandbox.
        # External creation retains the same-mount guard; admission pins the
        # protected pathname, root ownership/mode and both directory identities.
        require(identity(root_directory(control)) == record['artifacts']['control']['identity'] and
                identity(root_directory(fd)) == binding['receipt_identity'], 'managed-receipt-replaced')
    finally:
        os.close(control)
        os.close(fd)
    return path + '/proof.json'


def managed_identity(binding, props, record):
    if binding['role'] in ('verifier', 'finalizer'):
        verify_managed_receipt_directory(record, binding)
    actual = validate_unit_properties(props, binding['unit'], binding['policy'], binding['role'],
                                      record['artifacts']['root'])
    require(all(actual[key] == binding[key] for key in actual), 'managed-unit-replaced')


def load_managed_binding(control, record, token):
    unit = unit_name(record['nonce'], token['role'], token['request_nonce'])
    require(token['unit'] == unit and token['phase'] in ('bound', 'unresolved') and
            token['binding_sha256'] is not None, 'managed-unit-unresolved')
    binding, sha256 = invocation_file(control, token['request_nonce'], token['role'], 'binding')
    require(sha256 == token['binding_sha256'] and binding['unit'] == unit and
            binding['record_sha256'] == digest(canonical(record)) and binding['role'] == token['role'],
            'managed-invocation-record')
    return binding


def terminal_empty(backend, record, binding, cgroup):
    before = backend.show(binding['unit'])
    managed_identity(binding, before, record)
    empty = not cgroup.populated()
    after = backend.show(binding['unit'])
    managed_identity(binding, after, record)
    return (empty and before['ActiveState'] == after['ActiveState'] == 'inactive' and
            before['SubState'] == after['SubState'] == 'dead' and not cgroup.populated())


def persist_managed_receipt(control, record, binding, status):
    value = {'version': 1, 'component': 'managed-' + binding['role'], 'status': status,
             'nonce': record['nonce'], 'record_sha256': digest(canonical(record)),
             'deadline': record['deadline'], 'unit': binding['unit'],
             'invocation_id': binding['invocation_id'], 'control_group': binding['control_group'],
             'identity': binding['identity'], 'events_identity': binding['events_identity']}
    require(status in ('quiescent', 'unresolved'), 'receipt-status')
    try:
        os.mkdir('receipts', 0o700, dir_fd=control)
    except FileExistsError:
        pass
    fd = os.open('receipts', DIRECTORY, dir_fd=control)
    try:
        root_directory(fd)
        require(mount_id(fd) == mount_id(control), 'control-mount')
        raw = canonical(value)
        write_control_file(fd, 'managed-' + binding['role'] + '-' + secrets.token_hex(16) + '.json', raw)
        return digest(raw)
    finally:
        os.close(fd)


def clear_quiescent_producer(control, record, state):
    token = state['producer']
    if token is None:
        return state
    binding = load_managed_binding(control, record, token)
    backend = SystemdBackend(record)
    with ManagedCgroupProof(binding) as cgroup:
        require(terminal_empty(backend, record, binding, cgroup), 'managed-unit-busy')
    persist_managed_receipt(control, record, binding, 'quiescent')
    return update_control_state(control, record, state, dict(state, producer=None))


class InstallLease:
    def __init__(self, root_fd, lock_fd, armed=False):
        self.root_fd, self.lock_fd, self.active = root_fd, lock_fd, True

    def spawn(self, *args, **kwargs):
        raise Refusal('producer-closed')

    def wait_all(self):
        pass


FINALIZER_SELECT_RELATIONS = (
    'full_data_preservation_operations', 'full_data_preservation_tables',
    'full_data_preservation_chunks', 'full_data_preservation_rows',
    'full_data_preservation_staged_completions',
)
FINALIZER_WRITE_POLICY = (
    ('operations', 'full_data_preservation_operations', 'UPDATE', ('completed',)),
    ('tables', 'full_data_preservation_tables', 'UPDATE',
     ('verified_chunk_count', 'verified_manifest_sha256', 'verified_row_count')),
    ('completion', 'full_data_preservation_staged_completions', 'INSERT',
     ('boundary_sha256', 'freeze_epoch', 'manifest_sha256', 'operation_id',
      'proofs_sha256', 'session_id', 'snapshot_sha256')),
)


def database_authority(control, root, record, expected_hash, role, argv=None, request_nonce=None):
    require(role in ('verifier', 'finalizer') and
            re.fullmatch(r'[a-f0-9]{64}', expected_hash or '') is not None,
            'verifier-db-readonly-required')
    filename = 'db-readonly.json' if role == 'verifier' else 'ledger-authority.json'
    raw, _ = read_at(control, filename, 0, limit=MAX_RECORD)
    require(secrets.compare_digest(digest(raw), expected_hash), 'verifier-db-readonly-pin')
    proof = json.loads(raw)
    keys = {'version', 'nonce', 'record_sha256', 'request_nonce', 'role', 'config_relative',
            'config_pin', 'credential_ref', 'system_identifier', 'username', 'entry',
            'measurement', 'ledger_targets'}
    require(type(proof) is dict and set(proof) == keys and canonical(proof) == raw and
            proof['version'] == 2 and proof['nonce'] == record['nonce'] and
            proof['record_sha256'] == digest(canonical(record)) and proof['role'] == role and
            proof['system_identifier'] == record['system_identifier'] and
            proof['username'] == 'radar_rehearsal_' + record['nonce'] + '_' + role,
            'verifier-db-readonly-proof')
    require(request_nonce is not None and proof['request_nonce'] == request_nonce,
            'managed-authority-invocation')
    config, pin = artifact_file(root, proof['config_relative'])
    require(pin == proof['config_pin'] and proof['credential_ref'] == digest(config),
            'verifier-db-readonly-pin')
    value = json.loads(config)
    require(value.get('host') == '127.0.0.1' and type(value.get('port')) is int and value['port'] == 5434 and
            value.get('database') == 'radar_rehearsal_' + record['nonce'] and
            value.get('nonce') == record['nonce'] and value.get('systemIdentifier') == record['system_identifier'] and
            value.get('username') == proof['username'], 'verifier-db-readonly-config')
    entry = proof['entry']
    require(type(entry) is dict and set(entry) == {'code_relative', 'execution_pin', 'argv_sha256', 'kind'} and
            entry['code_relative'] in record['artifacts']['code_pins'] and
            entry['kind'] == ('readonly-verifier' if role == 'verifier' else 'native-ledger-uow'),
            'managed-authority-entry')
    require(type(argv) is list and len(argv) == 3 and
            argv[1] == record['artifacts']['root'] + '/' + entry['code_relative'] and
            argv[2] == record['artifacts']['root'] + '/' + proof['config_relative'] and
            entry['argv_sha256'] == digest(canonical(argv)) and
            root_path_pin(argv[0]) == entry['execution_pin'], 'managed-authority-command')
    measured = proof['measurement']
    fields = {'adapter_pin', 'catalog_sha256', 'session', 'reachable_roles', 'owned_objects',
              'unsafe_role_attributes', 'set_reachable_write_paths', 'write_grants', 'measured_at'}
    if role == 'finalizer':
        fields.add('select_grants')
    require(type(measured) is dict and set(measured) == fields and
            root_path_pin(measured['adapter_pin']['path']) == measured['adapter_pin'] and
            re.fullmatch(r'[a-f0-9]{64}', measured['catalog_sha256']) is not None and
            type(measured['measured_at']) is int and
            record['created_at'] <= measured['measured_at'] <= int(time.time()) < record['deadline'],
            'managed-authority-measurement')
    session = measured['session']
    require(type(session) is dict and set(session) == {'session_user', 'current_user', 'database',
            'system_identifier', 'backend_pid', 'transaction_read_only'} and
            session['session_user'] == session['current_user'] == proof['username'] and
            session['database'] == value['database'] and session['system_identifier'] == record['system_identifier'] and
            type(session['backend_pid']) is int and session['backend_pid'] > 0 and
            session['transaction_read_only'] is (role == 'verifier') and
            measured['reachable_roles'] == [proof['username']] and
            measured['owned_objects'] == [] and measured['unsafe_role_attributes'] == [] and
            measured['set_reachable_write_paths'] == [], 'managed-authority-measurement')
    if role == 'verifier':
        require(proof['ledger_targets'] is None and measured['write_grants'] == [], 'managed-authority-acl')
    else:
        targets = proof['ledger_targets']
        require(type(targets) is dict and set(targets) == {'operations', 'tables', 'completion'}, 'managed-authority-acl')
        relations = []
        grants = []
        schema = 'radar_rehearsal_' + record['nonce'] + '_schema'
        require(measured['select_grants'] == sorted(schema + '.' + relation
                for relation in FINALIZER_SELECT_RELATIONS), 'managed-authority-acl')
        for key, relation, operation, columns in FINALIZER_WRITE_POLICY:
            target = targets[key]
            require(type(target) is dict and set(target) == {'relation', 'columns'} and
                    target['relation'] == schema + '.' + relation, 'managed-authority-acl')
            actual = target['columns']
            require(type(actual) is list and actual == sorted(set(actual)) and
                    all(isinstance(column, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,62}', column)
                        for column in actual) and
                    actual == list(columns), 'managed-authority-acl')
            relations.append(target['relation'])
            grants.append({'relation': target['relation'], 'operation': operation, 'columns': actual})
        require(len(set(relations)) == 3 and measured['write_grants'] == grants, 'managed-authority-acl')
    return expected_hash


def readonly_receipt(control, root, record, expected_hash, argv=None, request_nonce=None):
    return database_authority(control, root, record, expected_hash, 'verifier', argv, request_nonce)


class ManagedUnitLease:
    def __init__(self, record, record_path, record_hash, request_nonce, role, control, root, state,
                 db_readonly_hash=None):
        self.record, self.record_path, self.record_hash = record, record_path, record_hash
        self.request_nonce, self.role, self.control, self.root = request_nonce, role, control, root
        self.unit = unit_name(record['nonce'], role, request_nonce)
        self.state = state
        self.db_readonly_hash = db_readonly_hash
        self.backend = SystemdBackend(record)
        self.binding = self.cgroup = None
        self.started = self.complete = False
        self.receipt = None

    def start_approved_unit(self, argv, *, runtime_seconds, memory_max_bytes, tasks_max, cpu_quota_percent):
        require(not self.started, 'managed-unit-reused')
        require(type(argv) in (list, tuple) and 2 <= len(argv) <= 128 and
                all(isinstance(value, str) for value in argv) and
                sum(len(value) for value in argv) <= MAX_FILE, 'producer-command')
        require(all(integer(value) for value in (runtime_seconds, memory_max_bytes, tasks_max, cpu_quota_percent)) and
                1 <= runtime_seconds <= 3300 and 64 * 1024 * 1024 <= memory_max_bytes <= 1024 * 1024 * 1024 and
                1 <= tasks_max <= 128 and 1 <= cpu_quota_percent <= 100, 'managed-unit-limits')
        now = int(time.time())
        budget = runtime_seconds + UNIT_STOP_SECONDS + UNIT_PROOF_SECONDS
        require(self.record['created_at'] <= now < self.record['deadline'], 'managed-unit-budget')
        self.until = time.monotonic() + min(budget, self.record['deadline'] - now)
        expires_at = min(now + budget, self.record['deadline'])
        argv = list(argv)
        argv[0] = os.path.realpath(argv[0])
        execution_pin = root_path_pin(argv[0])
        code_name = None
        for name in self.record['artifacts']['code_pins']:
            if argv[1] == self.record['artifacts']['root'] + '/' + name:
                code_name = name
        require(code_name is not None, 'managed-command-code')
        artifact_proof(self.root, self.record['artifacts'])
        if self.role in ('verifier', 'finalizer'):
            database_authority(self.control, self.root, self.record, self.db_readonly_hash,
                               self.role, argv, self.request_nonce)
        policy = {'runtime_seconds': runtime_seconds, 'memory_max_bytes': memory_max_bytes,
                  'tasks_max': tasks_max, 'cpu_quota_percent': cpu_quota_percent}
        receipt_identity = None
        if self.role in ('verifier', 'finalizer'):
            policy['receipt_directory'] = managed_receipt_directory(self.record, self.unit, self.role)
            receipt_identity = create_managed_receipt_directory(self.control, self.request_nonce)
        header = {'version': 1, 'unit': self.unit, 'role': self.role, 'request_nonce': self.request_nonce,
                  'record_sha256': self.record_hash, 'command_sha256': digest(canonical(argv)),
                  'code_name': code_name, 'execution_pin': execution_pin, 'policy': policy,
                  'deadline': expires_at, 'db_readonly_sha256': self.db_readonly_hash,
                  'receipt_identity': receipt_identity}
        pins = self.record['artifacts']['managed']
        for key in ('helper', 'python'):
            require(root_path_pin(pins[key]['path']) == pins[key], 'managed-code-changed')
        remaining = min(self.until - time.monotonic(), self.record['deadline'] - time.time())
        clipped_runtime = min(runtime_seconds, int(remaining) - UNIT_STOP_SECONDS - UNIT_PROOF_SECONDS - UNIT_LAUNCH_SECONDS)
        require(clipped_runtime >= 1, 'managed-unit-budget')
        policy['runtime_seconds'] = clipped_runtime
        directory = invocation_directory(self.control)
        try:
            # Permanent O_EXCL tombstone: a request can never be started twice.
            write_control_file(directory, self.request_nonce + '-' + self.role + '.request.json', canonical(header))
        finally:
            os.close(directory)
        self.started = True
        token = {'unit': self.unit, 'role': self.role, 'request_nonce': self.request_nonce,
                 'phase': 'pending', 'binding_sha256': None}
        self.state = update_control_state(self.control, self.record, self.state, dict(self.state, producer=token))
        command = [pins['python']['path'], pins['helper']['path'], 'managed-workload',
                   '--nonce', self.record['nonce'], '--record', self.record_path,
                   '--expected-sha256', self.record_hash, '--request-nonce', self.request_nonce,
                   '--role', self.role, '--', *argv]
        self.backend.launch_until = self.until
        self.backend.launch_reserve = (policy['runtime_seconds'] + UNIT_STOP_SECONDS +
                                       UNIT_PROOF_SECONDS + UNIT_LAUNCH_SECONDS)
        self.backend.launch(self.unit, command, policy, self.role)
        props = self.backend.show(self.unit)
        require(props['ActiveState'] in ('activating', 'active'), 'managed-admission-state')
        identity_fields = validate_unit_properties(props, self.unit, policy, self.role, self.record['artifacts']['root'])
        binding = dict(header, **{key: value for key, value in identity_fields.items() if key != 'unit'})
        self.cgroup = ManagedCgroupProof(binding, capture=True)
        self.binding = binding
        props_after = self.backend.show(self.unit)
        managed_identity(binding, props_after, self.record)
        require(props_after['ActiveState'] in ('activating', 'active') and self.cgroup.populated(), 'managed-admission-state')
        raw = canonical(binding)
        directory = invocation_directory(self.control)
        try:
            write_control_file(directory, self.request_nonce + '-' + self.role + '.binding.json', raw)
        finally:
            os.close(directory)
        token = dict(token, phase='bound', binding_sha256=digest(raw))
        self.state = update_control_state(self.control, self.record, self.state, dict(self.state, producer=token))
        # Publish admission last. A worker never takes the permanent writer lock.
        directory = invocation_directory(self.control)
        try:
            write_control_file(directory, self.request_nonce + '-' + self.role + '.admit.json',
                               canonical({'binding_sha256': token['binding_sha256']}))
        finally:
            os.close(directory)
        require(time.monotonic() < self.until, 'managed-unit-timeout')
        return {'unit': self.unit, 'invocation_id': binding['invocation_id'],
                'proof_receipt_path': (policy['receipt_directory'] + '/proof.json'
                                       if self.role in ('verifier', 'finalizer') else None)}

    def wait_terminal_and_empty(self):
        require(self.binding is not None and self.cgroup is not None, 'managed-unit-unresolved')
        if self.complete:
            return self.receipt
        while True:
            require(time.monotonic() < self.until, 'managed-unit-timeout')
            if terminal_empty(self.backend, self.record, self.binding, self.cgroup):
                self.receipt = {'status': 'quiescent', 'receipt_sha256':
                                persist_managed_receipt(self.control, self.record, self.binding, 'quiescent')}
                current = read_control_state(self.control, self.record)
                require(current['producer']['unit'] == self.unit, 'producer-proof')
                self.state = update_control_state(self.control, self.record, current, dict(current, producer=None))
                self.complete = True
                return self.receipt
            time.sleep(0.05)

    def unresolved(self):
        if self.started:
            current = read_control_state(self.control, self.record)
            if current['producer'] is not None:
                token = dict(current['producer'], phase='unresolved')
                update_control_state(self.control, self.record, current, dict(current, producer=token))
            if self.binding is not None:
                persist_managed_receipt(self.control, self.record, self.binding, 'unresolved')

    def close(self):
        if self.cgroup is not None:
            self.cgroup.close()


def control_reader(record):
    """Read-only gate view; must not take the outside wrapper's writer lock."""
    expected = record['artifacts']['control']
    protected_path(expected['root'])
    root = os.open(expected['root'], DIRECTORY)
    try:
        info = root_directory(root)
        require(identity(info) == expected['identity'], 'control-replaced')
        _, marker = read_at(root, 'owner', 0)
        _, lock = read_at(root, 'lock', 0)
        require(marker == expected['owner_pin'] and lock == expected['lock_pin'], 'control-pin-changed')
        return root
    except Exception:
        os.close(root)
        raise


def managed_workload(record, record_hash, request_nonce, role, argv):
    """Gate inside the systemd-owned unit. No filesystem writes before exec."""
    unit = unit_name(record['nonce'], role, request_nonce)
    control = control_reader(record)
    root = None
    try:
        header, _ = invocation_file(control, request_nonce, role, 'request')
        require(header['unit'] == unit and header['record_sha256'] == record_hash and
                header['command_sha256'] == digest(canonical(argv)), 'managed-invocation-record')
        require(root_path_pin(argv[0]) == header['execution_pin'], 'managed-code-changed')
        until = time.monotonic() + min(30, max(0, header['deadline'] - int(time.time())))
        while True:
            require(time.monotonic() < until and int(time.time()) < header['deadline'], 'managed-admission-timeout')
            try:
                admit, _ = invocation_file(control, request_nonce, role, 'admit')
                break
            except FileNotFoundError:
                time.sleep(0.05)
        binding, sha256 = invocation_file(control, request_nonce, role, 'binding')
        require(admit == {'binding_sha256': sha256} and
                binding['unit'] == unit and binding['record_sha256'] == record_hash and
                binding['command_sha256'] == header['command_sha256'] and
                os.environ.get('INVOCATION_ID') == binding['invocation_id'], 'managed-admission-identity')
        state = read_control_state(control, record)
        token = state['producer']
        require(token is not None and token['unit'] == unit and token['phase'] == 'bound' and
                token['binding_sha256'] == sha256 and
                state['phase'] == ('open' if role == 'producer' else 'sealed'), 'managed-admission-state')
        with open('/proc/self/cgroup', 'rt', encoding='ascii') as stream:
            membership = stream.read(4096)
        require('0::' + binding['control_group'] in membership.splitlines(), 'managed-admission-membership')
        with ManagedCgroupProof(binding) as cgroup:
            require(cgroup.populated(), 'managed-admission-membership')
        root = os.open(record['artifacts']['root'], DIRECTORY)
        artifact_proof(root, record['artifacts'])
        require(argv[1] == record['artifacts']['root'] + '/' + header['code_name'], 'managed-command-code')
        if role in ('verifier', 'finalizer'):
            verify_managed_receipt_directory(record, binding)
            database_authority(control, root, record, header['db_readonly_sha256'], role, argv, request_nonce)
        os.chdir(record['artifacts']['root'])
        environment = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1'}
        os.execve(argv[0], argv, environment)
    finally:
        if root is not None:
            os.close(root)
        os.close(control)


@contextlib.contextmanager
def managed_unit_lease(nonce, record_path, expected_sha256, request_nonce, role, db_readonly_sha256=None):
    trusted_runtime()
    unit_name(nonce, role, request_nonce)
    record = load_record(record_path, expected_sha256, nonce)
    require('artifacts' in record and 'managed' in record['artifacts'], 'managed-unit-unavailable')
    expected = record['artifacts']
    with control_scope(nonce, expected=expected['control']) as (control, lock, _):
        state = read_control_state(control, record)
        require(state['phase'] == ('open' if role == 'producer' else 'sealed'), 'producer-sealed')
        state = clear_quiescent_producer(control, record, state)
        require(record['created_at'] <= int(time.time()) < record['deadline'], 'producer-expired')
        with artifact_scope(expected['root'], nonce, expected=expected) as (root, _):
            if role in ('verifier', 'finalizer'):
                require(manifest_digest(tree_manifest(root, 0, artifacts=True)) == state['snapshot_sha256'], 'artifact-mutated')
                require(re.fullmatch(r'[a-f0-9]{64}', db_readonly_sha256 or '') is not None,
                        'verifier-db-readonly-required')
            lease = ManagedUnitLease(record, record_path, expected_sha256, request_nonce, role,
                                     control, root, state, db_readonly_sha256)
            try:
                yield lease
            finally:
                try:
                    require(lease.started, 'managed-unit-not-started')
                    lease.wait_terminal_and_empty()
                    if role in ('verifier', 'finalizer'):
                        require(manifest_digest(tree_manifest(root, 0, artifacts=True)) == state['snapshot_sha256'], 'artifact-mutated')
                except BaseException:
                    if lease.started and not lease.complete:
                        FAILED_LEASE_FDS.append(os.dup(lock))
                        try:
                            lease.unresolved()
                        except Exception:
                            pass
                    raise
                finally:
                    lease.close()


def managed_producer_lease(nonce, record_path, expected_sha256, request_nonce):
    return managed_unit_lease(nonce, record_path, expected_sha256, request_nonce, 'producer')


def managed_verifier_lease(nonce, record_path, expected_sha256, request_nonce, *, db_readonly_sha256):
    return managed_unit_lease(nonce, record_path, expected_sha256, request_nonce, 'verifier', db_readonly_sha256)


def managed_finalizer_lease(nonce, record_path, expected_sha256, request_nonce, *, ledger_authority_sha256):
    return managed_unit_lease(nonce, record_path, expected_sha256, request_nonce,
                              'finalizer', ledger_authority_sha256)


@contextlib.contextmanager
def artifact_install_lease(nonce, artifact_root, artifact_control):
    """Static installation only, before the first arm attempt; never recreate.

    The adapter exclusively provisions directories/markers/lock first, then
    uses this lease for code installation. It must not install through a raw
    second lock or create these paths again after sealing/cleanup.
    """
    trusted_runtime()
    require(re.fullmatch(r'[a-f0-9]{16}', nonce) is not None and
            artifact_root == ARTIFACT_PARENT + '/' + nonce, 'artifact-scope')
    with control_scope(nonce, path=artifact_control) as (control, lock, _):
        require(absent_at(control, 'state.json') and absent_at(control, 'arm.intent'), 'producer-closed')
        protected_path(artifact_root)
        root = os.open(artifact_root, DIRECTORY)
        try:
            root_directory(root)
            marker, _ = artifact_file(root, 'owner')
            require(re.fullmatch(rb'[a-f0-9]{48}', marker) is not None, 'artifact-owner-marker')
            lease = InstallLease(root, lock)
            try:
                yield lease
            finally:
                lease.active = False
                lease.wait_all()
        finally:
            os.close(root)


def artifact_producer_lease(nonce, record_path, expected_sha256, request_nonce):
    """Compatibility name for the managed producer API; no manual cgroup join."""
    return managed_producer_lease(nonce, record_path, expected_sha256, request_nonce)


def seal_artifacts(record):
    require('artifacts' in record, 'artifact-not-configured')
    expected = record['artifacts']
    with control_scope(record['nonce'], expected=expected['control']) as (control, _, _):
        state = read_control_state(control, record)
        require(state['phase'] in ('open', 'sealed'), 'producer-sealed')
        state = clear_quiescent_producer(control, record, state)
        with artifact_scope(expected['root'], record['nonce'], expected=expected) as (root, _):
            snapshot = manifest_digest(tree_manifest(root, 0, artifacts=True))
            require(state['snapshot_sha256'] is None or state['snapshot_sha256'] == snapshot, 'artifact-mutated')
            after = dict(state, phase='sealed', snapshot_sha256=snapshot)
            update_control_state(control, record, state, after)
    return {'action': 'seal-artifacts', 'status': 'sealed', 'deadline': record['deadline']}


def relative_name(name):
    require(isinstance(name, str) and len(name) <= 4096 and
            re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', name) is not None and
            all(part not in ('.', '..') for part in name.split('/')) and
            len(name.split('/')) <= MAX_DEPTH, 'artifact-relative-path')


def artifact_file(root, name):
    relative_name(name)
    parent = os.dup(root)
    try:
        for part in name.split('/')[:-1]:
            child = os.open(part, DIRECTORY, dir_fd=parent)
            try:
                info = os.fstat(child)
                require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and
                        mount_id(child) == mount_id(root), 'artifact-directory')
            except Exception:
                os.close(child)
                raise
            os.close(parent)
            parent = child
        fd = os.open(name.split('/')[-1], os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            require(mount_id(fd) == mount_id(root), 'artifact-mount')
        finally:
            os.close(fd)
        return read_at(parent, name.split('/')[-1], 0, limit=MAX_ARTIFACT_FILE)
    finally:
        os.close(parent)


def artifact_proof(root, expected):
    info = os.fstat(root)
    require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and
            identity(info) == expected['identity'], 'artifact-ownership')
    marker, marker_pin = artifact_file(root, 'owner')
    require(re.fullmatch(rb'[a-f0-9]{48}', marker) is not None and
            marker_pin == expected['owner_pin'], 'artifact-owner-marker')
    for name, pin in expected['code_pins'].items():
        _, actual = artifact_file(root, name)
        require(actual == pin, 'artifact-code-changed')


@contextlib.contextmanager
def artifact_scope(path, nonce, expected=None, requested=None):
    """Kuhn writer API: flock the namespace directory FD for the whole batch.

    All writers use LOCK_EX on this same directory inode before creating,
    replacing, appending, or unlinking artifacts. Cleanup uses LOCK_EX|LOCK_NB.
    Never replace the namespace directory itself. Pins/marker are immutable.
    """
    require(path == ARTIFACT_PARENT + '/' + nonce, 'artifact-scope')
    protected_path(path)
    parent = os.open(ARTIFACT_PARENT, DIRECTORY)
    root = None
    try:
        require(os.fstat(parent).st_uid == 0 and stat.S_IMODE(os.fstat(parent).st_mode) == 0o700,
                'artifact-parent')
        root = os.open(nonce, DIRECTORY, dir_fd=parent)
        try:
            fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refusal('artifact-locked') from None
        info = os.fstat(root)
        require(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and
                mount_id(root) == mount_id(parent), 'artifact-ownership')
        if expected is None:
            require(type(requested) is dict and bool(requested), 'artifact-code-pins')
            marker, marker_pin = artifact_file(root, 'owner')
            require(re.fullmatch(rb'[a-f0-9]{48}', marker) is not None, 'artifact-owner-marker')
            codes = {}
            for name, wanted in requested.items():
                require(re.fullmatch(r'[a-f0-9]{64}', wanted) is not None, 'artifact-code-hash')
                _, pin = artifact_file(root, name)
                require(secrets.compare_digest(pin['sha256'], wanted), 'artifact-code-hash')
                codes[name] = pin
            expected = {'root': path, 'identity': identity(info), 'owner_pin': marker_pin,
                        'code_pins': codes}
        artifact_proof(root, expected)
        require(identity(os.stat(nonce, dir_fd=parent, follow_symlinks=False)) == expected['identity'],
                'artifact-directory-race')
        yield root, expected
    finally:
        if root is not None:
            os.close(root)
        os.close(parent)


def load_record(path, expected_hash, nonce):
    require(re.fullmatch(r'[a-f0-9]{64}', expected_hash or '') is not None, 'expected-hash')
    protected_path(path)
    parent = os.open(os.path.dirname(path), DIRECTORY)
    try:
        raw, _ = read_at(parent, os.path.basename(path), 0, limit=MAX_RECORD)
    finally:
        os.close(parent)
    require(secrets.compare_digest(digest(raw), expected_hash), 'record-hash')
    record = json.loads(raw)
    require(canonical(record) == raw, 'record-canonical')
    validate_record(record, nonce)
    return record


def check_identity(record, root, data):
    path_identity(record, root, data)
    connection(record, root)
    version, _ = read_at(data, 'PG_VERSION', record['uid'])
    require(version.strip() == b'16', 'pg-version')
    for name, pin in record['binaries'].items():
        require(pin_binary(name) == pin, 'binary-changed')
    pid_record(record, data, optional=True)
    ticks = process_identity(record)
    require(ticks is None or ticks == record['process_ticks'], 'pid-reused')
    path_identity(record, root, data)
    return ticks


def arm(nonce, path, ttl, now=None, artifact_root=None, artifact_code_pins=None, artifact_control=None):
    require(integer(ttl) and 0 < ttl <= MAX_TTL, 'ttl-range')
    if artifact_root is None:
        require(not artifact_code_pins and artifact_control is None, 'artifact-arguments')
        return arm_record(nonce, path, ttl, now)
    require(not path.startswith(artifact_root + '/'), 'record-location')
    require(artifact_control is not None, 'artifact-control-required')
    with control_scope(nonce, path=artifact_control) as (control, _, control_pin):
        require(absent_at(control, 'state.json') and absent_at(control, 'arm.intent'), 'control-already-armed')
        with artifact_scope(artifact_root, nonce, requested=artifact_code_pins) as (_, artifacts):
            artifacts = dict(artifacts, control=control_pin, managed=managed_pins())
            # Even a failed arm attempt permanently closes pre-arm installation.
            write_control_file(control, 'arm.intent', canonical({'nonce': nonce, 'version': 1}))
            receipt = arm_record(nonce, path, ttl, now, artifacts)
            record = load_record(path, receipt['record_sha256'], nonce)
            write_control_file(control, 'state.json', canonical(initial_state(record)))
            return receipt


def arm_record(nonce, path, ttl, now=None, artifacts=None):
    require(integer(ttl) and 0 < ttl <= MAX_TTL, 'ttl-range')
    require(os.path.isabs(path) and os.path.normpath(path) == path and
            not path.startswith('/tmp/radar_rehearsal_' + nonce + '/'), 'record-location')
    protected_path(os.path.dirname(path))
    account = pwd.getpwnam('postgres')
    require(account.pw_uid > 0, 'postgres-owner')
    created = int(time.time()) if now is None else now
    record = {'version': 1, 'nonce': nonce, 'root': '/tmp/radar_rehearsal_' + nonce,
              'uid': account.pw_uid, 'gid': account.pw_gid,
              'created_at': created, 'deadline': created + ttl, 'boot_id': boot_id(),
              'binaries': {name: pin_binary(name) for name in ('pg_ctl', 'postgres', 'pg_controldata')}}
    if artifacts is not None:
        record['artifacts'] = artifacts
    with fixture(record) as (root, data):
        record['root_identity'] = identity(os.fstat(root))
        record['data_identity'] = identity(os.fstat(data))
        record['owner_pin'], record['connection_pin'], record['system_identifier'] = connection(record, root)
        record['pid'], record['postmaster_start'] = pid_record(record, data)
        record['process_ticks'] = process_identity(record)
        require(record['process_ticks'] is not None, 'arm-not-live')
        validate_record(record, nonce)
        check_identity(record, root, data)
        result = run_private(record, 'pg_controldata', ['-D', record['root'] + '/data'])
        require(result.returncode == 0, 'control-failed')
        matches = re.findall(rb'^Database system identifier:\s*([0-9]+)\s*$', result.stdout, re.M)
        require(matches == [record['system_identifier'].encode()], 'control-system')
        check_identity(record, root, data)
        raw = canonical(record)
        parent = os.open(os.path.dirname(path), DIRECTORY)
        try:
            fd = os.open(os.path.basename(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                         0o600, dir_fd=parent)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(raw)
                    stream.flush()
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)
        finally:
            os.close(parent)
    return {'action': 'arm', 'status': 'armed', 'record_sha256': digest(raw), 'deadline': record['deadline']}


def file_metadata(info):
    return (info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            stat.S_IMODE(info.st_mode), info.st_nlink)


def tree_manifest(root, uid, artifacts=False):
    manifest = {}
    budget = Budget(TREE_SECONDS)
    root_mount = mount_id(root)
    def walk(fd, prefix):
        for name in bounded_names(fd, budget, len(prefix)):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            require(info.st_uid == uid and info.st_dev == os.fstat(root).st_dev and
                    (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) and
                    not info.st_mode & 0o022 and
                    (stat.S_ISDIR(info.st_mode) or info.st_nlink == 1), 'tree-unknown')
            if artifacts:
                require(stat.S_IMODE(info.st_mode) == (0o700 if stat.S_ISDIR(info.st_mode) else 0o600),
                        'artifact-mode')
            key = prefix + (name,)
            content_hash = None
            if stat.S_ISREG(info.st_mode) and artifacts:
                child = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    require(mount_id(child) == root_mount, 'tree-mount')
                finally:
                    os.close(child)
                _, pin = read_at(fd, name, uid, limit=MAX_ARTIFACT_FILE)
                require(pin['identity'] == identity(info), 'tree-race')
                content_hash = pin['sha256']
            manifest[key] = (identity(info), stat.S_IFMT(info.st_mode),
                             file_metadata(info) if stat.S_ISREG(info.st_mode) else None, content_hash)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, DIRECTORY, dir_fd=fd)
                try:
                    require(identity(os.fstat(child)) == identity(info) and
                            mount_id(child) == root_mount, 'tree-race')
                    walk(child, key)
                finally:
                    os.close(child)
    walk(root, ())
    return manifest


def delete_owned(record, root, data):
    """Rename into root-owned staging, then compare inode before any deletion.

    Unknown initial trees are refused without deletion. A concurrent mutation
    during deletion may leave a partially cleaned, quarantined fixture; recovery
    requires parent inspection, never a guessed cleanup of an unknown path.
    """
    manifest = tree_manifest(root, record['uid'])
    check_identity(record, root, data)
    def confirm():
        connection(record, root)
        require(process_identity(record) is None, 'postmaster-live')
        require(pid_record(record, data, optional=True) is None, 'pid-still-present')
    delete_namespace(record['root'], root, record['root_identity'], record['uid'],
                     manifest, confirm)


def delete_namespace(path, root, expected_identity, uid, manifest, confirm, artifacts=False):
    confirm()
    parent_path = os.path.dirname(path)
    parent = os.open(parent_path, DIRECTORY)
    vault_path = tempfile.mkdtemp(prefix='radar_expiry_quarantine_', dir=parent_path)
    os.chmod(vault_path, 0o700)
    vault = os.open(vault_path, DIRECTORY)
    moved = False
    complete = False
    budget = Budget(DELETE_SECONDS)
    root_mount = mount_id(root)
    try:
        require(os.fstat(vault).st_uid == os.geteuid() and stat.S_IMODE(os.fstat(vault).st_mode) == 0o700 and
                mount_id(vault) == mount_id(parent),
                'quarantine-owner')
        name = os.path.basename(path)
        require(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == expected_identity,
                'root-race')
        os.rename(name, 'fixture', src_dir_fd=parent, dst_dir_fd=vault)
        moved = True
        require(identity(os.stat('fixture', dir_fd=vault, follow_symlinks=False)) == expected_identity,
                'root-race')
        require(tree_manifest(root, uid, artifacts) == manifest, 'tree-race')
        confirm()
        def remove_children(fd, prefix):
            expected = {key[-1] for key in manifest if key[:-1] == prefix}
            require(set(bounded_names(fd, budget, len(prefix))) == expected, 'tree-race')
            for child_name in sorted(expected):
                budget.check(len(prefix))
                key = prefix + (child_name,)
                entry_identity, kind, metadata, content_hash = manifest[key]
                before = os.stat(child_name, dir_fd=fd, follow_symlinks=False)
                require(identity(before) == entry_identity and before.st_uid == uid and
                        stat.S_IFMT(before.st_mode) == kind and
                        (metadata is None or file_metadata(before) == metadata), 'delete-race')
                token = 'entry_' + secrets.token_hex(16)
                os.rename(child_name, token, src_dir_fd=fd, dst_dir_fd=vault)
                info = os.stat(token, dir_fd=vault, follow_symlinks=False)
                require(identity(info) == entry_identity and info.st_uid == uid and
                        stat.S_IFMT(info.st_mode) == kind, 'delete-race')
                if kind == stat.S_IFDIR:
                    child = os.open(token, DIRECTORY, dir_fd=vault)
                    try:
                        require(identity(os.fstat(child)) == entry_identity and
                                mount_id(child) == root_mount, 'delete-race')
                        remove_children(child, key)
                    finally:
                        os.close(child)
                    os.rmdir(token, dir_fd=vault)
                else:
                    require(info.st_nlink == 1, 'delete-hardlink')
                    require(file_metadata(info)[:2] == metadata[:2] and
                            stat.S_IMODE(info.st_mode) == metadata[3], 'delete-race')
                    child = os.open(token, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=vault)
                    try:
                        require(identity(os.fstat(child)) == entry_identity and
                                mount_id(child) == root_mount, 'delete-race')
                    finally:
                        os.close(child)
                    if content_hash is not None:
                        _, actual = read_at(vault, token, uid, limit=MAX_ARTIFACT_FILE)
                        require(actual['identity'] == entry_identity and
                                actual['sha256'] == content_hash, 'artifact-mutated')
                    budget.check(len(prefix))
                    os.unlink(token, dir_fd=vault)
            require(not bounded_names(fd, budget, len(prefix)), 'tree-race')
        remove_children(root, ())
        require(identity(os.stat('fixture', dir_fd=vault, follow_symlinks=False)) == expected_identity,
                'root-race')
        os.rmdir('fixture', dir_fd=vault)
        complete = True
    finally:
        os.close(vault)
        os.close(parent)
        # Keep all quarantined evidence on failure; do not restore a raced name.
        if complete or not moved:
            os.rmdir(vault_path)


def cleanup_artifacts_locked(record, control=None, state=None):
    expected = record['artifacts']
    if state is not None and state['artifacts'] == 'deleted':
        require_absent(expected['root'], 'artifact-recreated')
        return {'status': 'already-deleted'}
    with artifact_scope(expected['root'], record['nonce'], expected=expected) as (root, _):
        manifest = tree_manifest(root, os.fstat(root).st_uid, artifacts=True)
        if state is not None:
            snapshot = manifest_digest(manifest)
            require(state['snapshot_sha256'] is None or state['snapshot_sha256'] == snapshot, 'artifact-mutated')
            after = dict(state, phase='cleaning', snapshot_sha256=snapshot)
            state = update_control_state(control, record, state, after)
        def confirm():
            artifact_proof(root, expected)
        delete_namespace(expected['root'], root, expected['identity'], os.fstat(root).st_uid,
                         manifest, confirm, artifacts=True)
        if state is not None:
            update_control_state(control, record, state, dict(state, phase='deleted', artifacts='deleted'))
    return {'status': 'deleted'}


def cleanup_artifacts(record):
    expected = record['artifacts']
    with control_scope(record['nonce'], expected=expected['control']) as (control, _, _):
        state = read_control_state(control, record)
        state = clear_quiescent_producer(control, record, state)
        return cleanup_artifacts_locked(record, control, state)


def safe_failure(error):
    # Only internal fixed refusal codes are public; OS paths/output stay private.
    public = {'pid-reused', 'pidfile-race', 'pidfd-exited', 'pidfd-unavailable', 'stop-timeout',
              'postmaster-live', 'pid-still-present', 'pid-missing', 'pid-changed', 'status-unknown',
              'root-ownership', 'root-changed', 'root-race', 'data-ownership', 'data-changed',
              'directory-race', 'file-ownership', 'file-race', 'tree-unknown', 'tree-bound',
              'tree-race', 'tree-mount', 'delete-race', 'artifact-mutated', 'artifact-code-changed',
              'artifact-owner-marker', 'artifact-ownership', 'artifact-locked', 'artifact-recreated',
              'control-locked', 'control-replaced', 'control-pin-changed', 'control-lock-replaced',
              'control-state', 'control-state-race', 'control-state-regression', 'control-ownership',
              'producer-sealed', 'producer-expired', 'private-pg-recreated', 'binary-changed',
              'producer-cgroup-busy', 'producer-cgroup-replaced', 'producer-cgroup-events',
              'producer-cgroup-required', 'producer-proof',
              'managed-unit-unresolved', 'managed-unit-busy', 'managed-unit-replaced',
              'managed-cgroup-replaced', 'managed-unit-timeout', 'managed-manager-failed',
              'managed-manager-unavailable', 'managed-unit-identity', 'managed-unit-budget',
              'managed-unit-limits', 'managed-unit-policy', 'managed-invocation-record',
              'verifier-db-readonly-required', 'verifier-db-readonly-proof', 'verifier-db-readonly-pin',
              'connection-changed', 'clock-regressed', 'cleanup-not-authorized',
              'private-pg-absence-unproven'}
    reason = str(error) if isinstance(error, Refusal) and str(error) in public else 'operation-failed'
    return {'status': 'refused', 'reason': reason}


def persist_receipt(control, record, component, result):
    require(component in ('private-pg', 'artifacts'), 'receipt-component')
    require(result['status'] in ('deleted', 'already-deleted', 'refused'), 'receipt-status')
    safe = {'status': result['status']}
    if result['status'] == 'refused':
        safe['reason'] = safe_failure(Refusal(result.get('reason', 'operation-failed')))['reason']
    value = {'version': 1, 'component': component, 'nonce': record['nonce'],
             'record_sha256': digest(canonical(record)), 'deadline': record['deadline'],
             'result': safe}
    try:
        os.mkdir('receipts', 0o700, dir_fd=control)
    except FileExistsError:
        pass
    fd = os.open('receipts', DIRECTORY, dir_fd=control)
    try:
        root_directory(fd)
        require(mount_id(fd) == mount_id(control), 'control-mount')
        raw = canonical(value)
        filename = component + '-' + secrets.token_hex(16) + '.json'
        write_control_file(fd, filename, raw)
        return digest(raw)
    finally:
        os.close(fd)


def private_cleanup_result(record, final, current, proven=False):
    try:
        if proven:
            require_absent(record['root'], 'private-pg-recreated')
            return {'status': 'already-deleted'}
        operate('cleanup', record, final, current)
        return {'status': 'deleted'}
    except FileNotFoundError:
        return safe_failure(Refusal('private-pg-absence-unproven'))
    except Exception as error:
        return safe_failure(error)


def attach_receipt(control, record, name, result):
    try:
        result['receipt_sha256'] = persist_receipt(control, record, name, result)
    except Exception:
        result['receipt_status'] = 'refused'


def cleanup_components(record, final=False, now=None):
    current = int(time.time()) if now is None else now
    require(current >= record['created_at'], 'clock-regressed')
    require(final or current >= record['deadline'], 'cleanup-not-authorized')
    receipt = {'action': 'cleanup', 'deadline': record['deadline'],
               'authority': 'final' if final else 'expired'}
    if 'artifacts' in record:
        try:
            with control_scope(record['nonce'], expected=record['artifacts']['control']) as (control, _, _):
                state = read_control_state(control, record)
                state = clear_quiescent_producer(control, record, state)
                receipt['private_pg'] = private_cleanup_result(record, final, current,
                                                              state['private_pg'] == 'deleted')
                if receipt['private_pg']['status'] == 'deleted':
                    try:
                        state = update_control_state(control, record, state, dict(state, private_pg='deleted'))
                    except Exception:
                        receipt['private_pg']['proof_status'] = 'not-persisted'
                attach_receipt(control, record, 'private-pg', receipt['private_pg'])
                try:
                    receipt['artifacts'] = cleanup_artifacts_locked(record, control, state)
                except Exception as error:
                    receipt['artifacts'] = safe_failure(error)
                attach_receipt(control, record, 'artifacts', receipt['artifacts'])
        except Exception as error:
            receipt['artifacts'] = safe_failure(error)
            if 'private_pg' not in receipt:
                # A busy/unknown invocation forbids any cleanup work. There is
                # no fallback that stops PG while an artifact producer lives.
                receipt['private_pg'] = safe_failure(error)
    else:
        receipt['private_pg'] = private_cleanup_result(record, final, current)
        receipt['artifacts'] = {'status': 'not-configured'}
    statuses = (receipt['private_pg']['status'], receipt['artifacts']['status'])
    successes = {'deleted', 'already-deleted'}
    durable = all('receipt_status' not in receipt[key] and 'proof_status' not in receipt[key]
                  for key in ('private_pg', 'artifacts'))
    receipt['status'] = 'deleted' if durable and statuses[0] in successes and statuses[1] in successes | {'not-configured'} else (
        'partial' if any(status in successes for status in statuses) else 'refused')
    return receipt


def check_components(record):
    if 'artifacts' not in record:
        return operate('check', record)
    expected = record['artifacts']
    with control_scope(record['nonce'], expected=expected['control']) as (control, _, _):
        state = read_control_state(control, record)
        state = clear_quiescent_producer(control, record, state)
        current = int(time.time())
        require(current >= record['created_at'], 'clock-regressed')
        if state['private_pg'] == 'deleted':
            require_absent(record['root'], 'private-pg-recreated')
            receipt = {'action': 'check', 'status': 'expired' if current >= record['deadline'] else 'retained',
                       'deadline': record['deadline'], 'private_pg': {'status': 'already-deleted'}}
        else:
            receipt = operate('check', record)
        if state['artifacts'] == 'deleted':
            require_absent(expected['root'], 'artifact-recreated')
            receipt['artifacts'] = {'status': 'already-deleted'}
        else:
            with artifact_scope(expected['root'], record['nonce'], expected=expected) as (root, _):
                snapshot = manifest_digest(tree_manifest(root, 0, artifacts=True))
                require(state['snapshot_sha256'] is None or snapshot == state['snapshot_sha256'], 'artifact-mutated')
            receipt['artifacts'] = {'status': 'verified', 'phase': state['phase']}
        return receipt


def operate(action, record, final=False, now=None):
    current = int(time.time()) if now is None else now
    require(current >= record['created_at'], 'clock-regressed')
    expired = current >= record['deadline']
    with fixture(record) as (root, data):
        ticks = check_identity(record, root, data)
        if action == 'check':
            return {'action': 'check', 'status': 'expired' if expired else 'retained',
                    'deadline': record['deadline'], 'postmaster_live': ticks is not None}
        require(action == 'cleanup' and (expired or final), 'cleanup-not-authorized')
        if ticks is not None:
            require(pid_record(record, data) is not None, 'pid-missing')
            stop_private(record, root, data)
        require(check_identity(record, root, data) is None, 'postmaster-live')
        require(pid_record(record, data, optional=True) is None, 'pid-still-present')
        result = run_private(record, 'pg_ctl', ['-D', record['root'] + '/data', 'status'])
        require(result.returncode == 3, 'status-unknown')
        check_identity(record, root, data)
        delete_owned(record, root, data)
    return {'action': 'cleanup', 'status': 'deleted', 'authority': 'final' if final else 'expired',
            'deadline': record['deadline']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('arm', 'check', 'cleanup', 'seal-artifacts', 'managed-workload'))
    parser.add_argument('--nonce', required=True)
    parser.add_argument('--record', required=True)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--ttl-seconds', type=int)
    parser.add_argument('--final', action='store_true')
    parser.add_argument('--artifact-root')
    parser.add_argument('--artifact-control')
    parser.add_argument('--artifact-code-pin', action='append', default=[])
    parser.add_argument('--request-nonce')
    parser.add_argument('--role', choices=('producer', 'verifier', 'finalizer'))
    args, payload = parser.parse_known_args(argv)
    args.payload = payload
    try:
        require(re.fullmatch(r'[a-f0-9]{16}', args.nonce) is not None, 'nonce-format')
        require(not args.final or args.action == 'cleanup', 'final-action')
        trusted_runtime()
        if args.action == 'managed-workload':
            require(args.request_nonce is not None and args.role is not None and not args.final and
                    args.ttl_seconds is None and args.artifact_root is None and args.artifact_control is None and
                    not args.artifact_code_pin, 'managed-workload-arguments')
            record = load_record(args.record, args.expected_sha256, args.nonce)
            payload = args.payload[1:] if args.payload[:1] == ['--'] else args.payload
            require(len(payload) >= 2, 'producer-command')
            managed_workload(record, args.expected_sha256, args.request_nonce, args.role, payload)
            return 1
        require(args.request_nonce is None and args.role is None and not args.payload, 'managed-workload-arguments')
        if args.action == 'arm':
            require(args.expected_sha256 is None and not args.final and args.ttl_seconds is not None,
                    'arm-arguments')
            pins = {}
            for value in args.artifact_code_pin:
                require('=' in value, 'artifact-code-pin-argument')
                name, sha256 = value.split('=', 1)
                relative_name(name)
                require(name not in pins, 'artifact-code-pin-duplicate')
                pins[name] = sha256
            receipt = arm(args.nonce, args.record, args.ttl_seconds,
                          artifact_root=args.artifact_root, artifact_code_pins=pins,
                          artifact_control=args.artifact_control)
        else:
            require(args.ttl_seconds is None, 'deadline-immutable')
            require(args.artifact_root is None and args.artifact_control is None and
                    not args.artifact_code_pin, 'artifact-arguments')
            record = load_record(args.record, args.expected_sha256, args.nonce)
            if args.action == 'cleanup':
                receipt = cleanup_components(record, args.final)
            elif args.action == 'seal-artifacts':
                receipt = seal_artifacts(record)
            else:
                receipt = check_components(record)
            receipt['record_sha256'] = args.expected_sha256
        print(canonical(receipt).decode('ascii'))
        return 1 if receipt['status'] in ('partial', 'refused') else 0
    except Refusal as error:
        print(canonical(safe_failure(error)).decode('ascii'))
        return 1
    except Exception:
        # Exception messages, subprocess output and paths may contain secrets.
        print('{"reason":"operation-failed","status":"refused"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
