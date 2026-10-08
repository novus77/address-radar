#!/usr/bin/env python3
"""Pinned root read-only discovery. Not a signer, admission barrier or trust loader.

Offline: helper.py seed
Native (parent review required): PINNED_PYTHON -I -B PINNED_HELPER discover
  --policy ROOT0600_POLICY --policy-sha256 CANONICAL_SHA256
  --expected-entry-sha256 REVIEWED_HELPER_SHA256

Seed runtimePins=None must be replaced with measured python/systemctl/loginctl
{path,sha256,identity:[dev,ino]} records, then independently profile/hash-approved.
Unknown operator/deploy/external/cron/bridge scope remains blocked by design.
No database content, cmdline/environ, mutation, signing or key generation exists.
"""
import argparse
import hashlib
import json
import os
import pwd
import re
import selectors
import socket
import stat
import subprocess
import sys
import time

MAIN = tuple('address-radar-' + name + '.service' for name in (
    'scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console'))
FOMO = ('fomo-radar-collector.service', 'fomo-radar-login.service', 'fomo-radar-novnc.service')
KNOWN_UNITS = MAIN + FOMO
RUNTIME_NAMES = ('python', 'systemctl', 'loginctl')
FALSE_CLAIMS = ('inventoryComplete', 'fenceEstablished', 'preparationReady', 'writeAuthorized',
                'activationEnabled', 'signedProofsCreated', 'scopeApproved')
SERVICE_PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlGroup',
    'InvocationID', 'User', 'Group', 'FragmentPath', 'DropInPaths', 'TimeoutStopUSec',
    'TimeoutStartUSec', 'KillMode')
UNKNOWN_SCOPES = ('bridge', 'cron', 'operator', 'deploy', 'external-input')
HASH = re.compile(r'^[a-f0-9]{64}$')
UNIT = re.compile(r'^(?:[A-Za-z0-9_@:.\-]|\\x[0-9A-Fa-f]{2}){1,200}\.(service|timer)$')
TOKEN = re.compile(r'^[A-Za-z0-9_.@:/+\-]{0,256}$')
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
MAX_POLICY = 65536
LISTING_COMMANDS = (
    ('units', 'systemctl', ('list-units', '--all', '--full', '--plain', '--no-legend', '--no-pager', '--type=service,timer')),
    ('unit-files', 'systemctl', ('list-unit-files', '--full', '--no-legend', '--no-pager', '--type=service,timer')),
    ('timers', 'systemctl', ('list-timers', '--all', '--full', '--no-legend', '--no-pager')),
    ('jobs', 'systemctl', ('list-jobs', '--no-legend', '--no-pager')),
    ('sessions', 'loginctl', ('list-sessions', '--no-legend', '--no-pager')),
)

V2_SURFACES = {'userManagers': 'approved-users-only', 'operatorSessions': 'listed-sessions',
    'cron': 'system-and-approved-user-spools', 'kernel': 'all-procs-source-holder-discovery',
    'unitMetadata': 'bounded-observed-system-units'}
MANAGER_PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'MainPID')
SESSION_PROPERTIES = ('Id', 'User', 'Name', 'Leader', 'State', 'Service', 'Type', 'Class', 'Remote', 'RemoteHost')
KERNEL_BOUNDS = {'maximumProcesses': 256, 'maximumFdsEach': 256, 'maximumTotalFds': 4096,
    'maximumMapsBytesEach': 262144, 'maximumTotalMapsBytes': 8388608}
CRON_ROOTS = ('/etc/crontab', '/etc/anacrontab', '/etc/cron.d', '/etc/cron.hourly',
    '/etc/cron.daily', '/etc/cron.weekly', '/etc/cron.monthly', '/var/spool/cron/atjobs', '/var/spool/at')


class Refusal(Exception):
    pass


class ListingRefusal(Refusal):
    def __init__(self, code, surface, index, line, rows, maximum):
        super().__init__(code)
        self.rows = rows
        self.detail = {'surface': surface, 'reason': code, 'lineIndex': index,
            'lineSha256': digest(line.encode()), 'rowsParsed': len(rows), 'maximumRows': maximum}



def need(ok, code):
    if not ok:
        raise Refusal(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def absolute(value):
    return (isinstance(value, str) and len(value) <= 1024 and value.startswith('/') and
            os.path.normpath(value) == value and not re.search(r'[\x00-\x20\x7f]', value))


def seed_policy(version=1):
    value = {'version': 1, 'mode': 'readonly-discovery', 'expectedHost': None,
        'knownUnits': [{'unit': unit, 'category': 'main' if unit in MAIN else 'fomo-protected'}
                       for unit in KNOWN_UNITS],
        'sourceFiles': [], 'approvedUsers': [], 'unresolvedScopes': list(UNKNOWN_SCOPES),
        'runtimePins': None, 'limits': {'operationSeconds': 30, 'commandSeconds': 2,
            'maximumCommands': 32, 'maximumOutputBytes': 65536, 'maximumListingRows': 512}}
    if version == 2:
        value.update(version=2, surfaces=dict(V2_SURFACES), sourcePins=None)
        value['limits']['maximumCommands'] = 64
    return value


def exact(value, keys):
    need(type(value) is dict and set(value) == set(keys), 'POLICY_FIELDS')


def validate_policy(value):
    need(len(canonical(value)) <= MAX_POLICY, 'POLICY_BOUND')
    fields = ('version', 'mode', 'expectedHost', 'knownUnits', 'sourceFiles', 'approvedUsers',
              'unresolvedScopes', 'runtimePins', 'limits')
    if value.get('version') == 2:
        fields += ('surfaces', 'sourcePins')
    exact(value, fields)
    need(value['version'] in (1, 2) and value['mode'] == 'readonly-discovery', 'POLICY_MODE')
    need(value['knownUnits'] == seed_policy()['knownUnits'] and
         value['unresolvedScopes'] == list(UNKNOWN_SCOPES), 'POLICY_SCOPE')
    need(value['expectedHost'] is None or isinstance(value['expectedHost'], str) and
         re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,252}', value['expectedHost']), 'POLICY_HOST')
    files = value['sourceFiles']
    need(type(files) is list and (not files or len(files) == 3 and all(absolute(path) for path in files)
         and files[1] == files[0] + '-wal' and files[2] == files[0] + '-shm'), 'POLICY_SOURCE')
    users = value['approvedUsers']
    need(type(users) is list and len(users) <= 8 and len(set(users)) == len(users) and
         all(isinstance(user, str) and re.fullmatch(r'[a-z_][a-z0-9_-]{0,63}', user) for user in users), 'POLICY_USERS')
    pins = value['runtimePins']
    exact(pins, RUNTIME_NAMES)
    for name, pin in pins.items():
        exact(pin, ('path', 'sha256', 'identity'))
        need(absolute(pin['path']) and not pin['path'].startswith(('/tmp/', '/var/tmp/', '/home/', '/proc/', '/dev/', '/sys/', '/run/'))
             and isinstance(pin['sha256'], str) and HASH.fullmatch(pin['sha256']) and
             type(pin['identity']) is list and len(pin['identity']) == 2 and
             all(type(item) is int and item >= 0 for item in pin['identity']), 'POLICY_RUNTIME')
    bounds = value['limits']
    exact(bounds, ('operationSeconds', 'commandSeconds', 'maximumCommands', 'maximumOutputBytes', 'maximumListingRows'))
    maximums = {'operationSeconds': 30, 'commandSeconds': 3, 'maximumCommands': 64,
                'maximumOutputBytes': 65536, 'maximumListingRows': 512}
    need(all(type(bounds[name]) is int and 1 <= bounds[name] <= limit for name, limit in maximums.items())
         and bounds['commandSeconds'] <= bounds['operationSeconds'], 'POLICY_LIMITS')
    if value['version'] == 2:
        need(value['surfaces'] == V2_SURFACES and len(files) == 3 and value['expectedHost'] is not None,
             'V2_SCOPE')
        need(type(value['sourcePins']) is list and len(value['sourcePins']) == 3, 'SOURCE_PINS')
        for path, pin in zip(files, value['sourcePins']):
            exact(pin, ('path', 'identity', 'uid'))
            need(pin['path'] == path and type(pin['uid']) is int and pin['uid'] >= 0 and
                 type(pin['identity']) is list and len(pin['identity']) == 2 and
                 all(type(item) is int and item >= 0 for item in pin['identity']), 'SOURCE_PINS')
    return value


def check_directory(info, exact_mode=None):
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022 and
         (exact_mode is None or stat.S_IMODE(info.st_mode) == exact_mode), 'DIRECTORY_PERMISSION')


def check_regular(info, maximum, exact_mode=None):
    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
         info.st_size <= maximum and not info.st_mode & 0o022 and
         (exact_mode is None or stat.S_IMODE(info.st_mode) == exact_mode), 'FILE_PERMISSION')


def identity(info):
    return [info.st_dev, info.st_ino]


def open_protected(path, maximum, mode=None):
    need(absolute(path) and path != '/', 'PROTECTED_PATH')
    directory = os.open('/', DIRECTORY)
    pins = []
    current = ''
    fd = None
    try:
        check_directory(os.fstat(directory))
        for part in path.split('/')[1:-1]:
            child = os.open(part, DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            check_directory(info)
            current += '/' + part
            need(identity(os.lstat(current)) == identity(info), 'ANCESTOR_REPLACED')
            pins.append((current, identity(info)))
        if mode == 0o600:
            check_directory(os.fstat(directory), 0o700)
        fd = os.open(path.split('/')[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        info = os.fstat(fd)
        check_regular(info, maximum, mode)
        for ancestor, pin in pins:
            current_info = os.lstat(ancestor)
            check_directory(current_info)
            need(identity(current_info) == pin, 'ANCESTOR_REPLACED')
        need(identity(os.lstat(path)) == identity(info), 'FILE_REPLACED')
        return fd, info, pins
    except BaseException:
        if fd is not None:
            os.close(fd)
        raise
    finally:
        os.close(directory)


def stable_file(path, fd, before, pins):
    after = os.fstat(fd)
    need((identity(before), before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
         (identity(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
         identity(os.lstat(path)) == identity(before), 'FILE_REPLACED')
    for ancestor, pin in pins:
        current = os.lstat(ancestor)
        check_directory(current)
        need(identity(current) == pin, 'ANCESTOR_REPLACED')


def hash_file(path, fd, before, pins, until):
    hasher = hashlib.sha256()
    total = 0
    while True:
        need(time.monotonic() < until, 'RUNTIME_BOUND')
        raw = os.read(fd, 65536)
        if not raw:
            break
        total += len(raw)
        need(total <= 268435456, 'RUNTIME_BOUND')
        hasher.update(raw)
    stable_file(path, fd, before, pins)
    return hasher.hexdigest()


def load_policy(path, expected_hash):
    need(isinstance(expected_hash, str) and HASH.fullmatch(expected_hash), 'POLICY_PIN')
    fd, before, pins = open_protected(path, MAX_POLICY, 0o600)
    try:
        raw = bytearray()
        until = time.monotonic() + 2
        while True:
            need(time.monotonic() < until, 'POLICY_BOUND')
            chunk = os.read(fd, min(65536, MAX_POLICY + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
            need(len(raw) <= MAX_POLICY, 'POLICY_BOUND')
        stable_file(path, fd, before, pins)
        need(digest(raw) == expected_hash, 'POLICY_PIN')
        value = json.loads(raw)
        need(canonical(value) == raw, 'POLICY_CANONICAL')
        return validate_policy(value)
    finally:
        os.close(fd)


def native_runtime(policy, expected_entry_hash, not_after=None):
    need(sys.platform.startswith('linux') and os.geteuid() == 0 and sys.flags.isolated and
         sys.dont_write_bytecode, 'ISOLATED_LINUX_ROOT_REQUIRED')
    need(isinstance(expected_entry_hash, str) and HASH.fullmatch(expected_entry_hash), 'ENTRY_PIN')
    until = min(time.monotonic() + 30, not_after if not_after is not None else float('inf'))
    entry = os.path.abspath(__file__)
    fd, info, pins = open_protected(entry, 1048576, 0o600)
    try:
        need(hash_file(entry, fd, info, pins, until) == expected_entry_hash, 'ENTRY_PIN')
    finally:
        os.close(fd)
    opened = {}
    try:
        for name in RUNTIME_NAMES:
            pin = policy['runtimePins'][name]
            fd, info, pins = open_protected(pin['path'], 268435456)
            opened[name] = (fd, info, pins)
            need(identity(info) == pin['identity'] and hash_file(pin['path'], fd, info, pins, until) == pin['sha256'], 'RUNTIME_PIN')
            if name == 'python':
                need(os.path.realpath(sys.executable) == pin['path'], 'PYTHON_PIN')
        return opened
    except BaseException:
        for fd, _, _ in opened.values():
            os.close(fd)
        raise


def native_execute(opened, policy, tool, args, timeout, maximum, admission=None):
    allowed = {(name, values) for _, name, values in LISTING_COMMANDS}
    allowed.update(('systemctl', ('show', '--no-pager', '--property=' + ','.join(SERVICE_PROPERTIES), unit))
                   for unit in KNOWN_UNITS)
    if policy['version'] == 2 and admission is not None:
        allowed.update(('systemctl', ('show', '--no-pager', '--property=' + ','.join(SERVICE_PROPERTIES), '--', unit))
                       for unit in admission['units'])
        allowed.update(('systemctl', ('show', '--no-pager', '--property=' + ','.join(MANAGER_PROPERTIES), '--', unit))
                       for unit in admission['managers'])
        allowed.update(('loginctl', ('show-session', '--no-pager',
                       *('--property=' + name for name in SESSION_PROPERTIES), '--', session))
                       for session in admission['sessions'])
        for user in admission['users']:
            for _, tool_name, values in LISTING_COMMANDS:
                if tool_name == 'systemctl':
                    allowed.add(('systemctl', (*values, '--user', '--machine=' + user + '@.host')))
    need((tool, tuple(args)) in allowed, 'COMMAND_SCOPE')
    fd, before, pins = opened[tool]
    stable_file(policy['runtimePins'][tool]['path'], fd, before, pins)
    deadline = time.monotonic() + timeout
    child = subprocess.Popen(['/proc/self/fd/' + str(fd), *args], pass_fds=(fd,),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'SYSTEMD_PAGER': '', 'SYSTEMD_COLORS': '0'})
    selector = selectors.DefaultSelector()
    output = bytearray()
    total = 0
    try:
        selector.register(child.stdout, selectors.EVENT_READ, True)
        selector.register(child.stderr, selectors.EVENT_READ, False)
        while selector.get_map():
            need(time.monotonic() < deadline, 'COMMAND_BOUND')
            for key, _ in selector.select(min(.05, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                total += len(chunk)
                need(total <= maximum, 'OUTPUT_BOUND')
                if key.data:
                    output.extend(chunk)
        need(child.wait(timeout=max(.001, deadline - time.monotonic())) == 0 and
             time.monotonic() < deadline, 'COMMAND_FAILED')
        stable_file(policy['runtimePins'][tool]['path'], fd, before, pins)
        return output.decode('ascii')
    finally:
        selector.close()
        if child.poll() is None:
            # Only this collector's own read-only query subprocess is terminated.
            child.kill()
            child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()


def read_process(pid, allow_inert=False):
    need(type(pid) is int and pid > 0, 'PROCESS_IDENTITY_UNAVAILABLE')
    fd = os.open('/proc/' + str(pid), DIRECTORY)
    try:
        info = os.fstat(fd)
        def probe():
            child = os.open('stat', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                raw = os.read(child, 4097)
                need(len(raw) <= 4096 and raw.split(b' ', 1)[0] == str(pid).encode(), 'PROCESS_BOUND')
                fields = raw.rsplit(b')', 1)[1].split()
                need(len(fields) >= 20 and fields[19].isdigit() and fields[6].isdigit(), 'PROCESS_BOUND')
                need(fields[0] != b'X' and (allow_inert or fields[0] != b'Z'), 'PROCESS_IDENTITY_UNAVAILABLE')
                kind = 'zombie' if fields[0] == b'Z' else (
                    'kernel-thread' if int(fields[6]) & 0x200000 else 'userspace')
                return fields[19].decode('ascii'), kind
            finally:
                os.close(child)
        start, kind = probe()
        try:
            exe = os.readlink('exe', dir_fd=fd)
            need(absolute(exe), 'PROCESS_IDENTITY_UNAVAILABLE')
        except FileNotFoundError:
            if not allow_inert or kind not in ('kernel-thread', 'zombie'):
                raise
            exe = None
        need(probe() == (start, kind) and identity(os.stat('/proc/' + str(pid))) == identity(info),
             'PROCESS_IDENTITY_CHANGED')
        result = {'pid': pid, 'uid': info.st_uid, 'gid': info.st_gid, 'startTicks': start, 'exe': exe}
        if allow_inert:
            result['resourceClass'] = kind
        return result
    finally:
        os.close(fd)


def source_metadata(paths):
    result = []
    for path in paths:
        info = os.lstat(path)
        need(stat.S_ISREG(info.st_mode), 'SOURCE_IDENTITY_UNAVAILABLE')
        result.append({'path': path, 'identity': identity(info), 'uid': info.st_uid,
                       'mode': stat.S_IMODE(info.st_mode)})
    return result


def parse_listing(surface, raw, maximum):
    rows = []
    for index, line in enumerate(raw.splitlines(), 1):
        if not line.strip():
            continue
        if len(rows) >= maximum:
            raise ListingRefusal('LISTING_BOUND', surface, index, line, rows, maximum)
        fields = line.split()
        if fields and fields[0] in ('\u25cf', '\u25cb'):
            fields = fields[1:]
        if surface in ('units', 'unit-files'):
            if len(fields) < 2 or not UNIT.fullmatch(fields[0]):
                raise ListingRefusal('LISTING_UNKNOWN', surface, index, line, rows, maximum)
            rows.append({'unit': fields[0], 'state': fields[1:4] if surface == 'units' else fields[1:3]})
        elif surface == 'timers':
            names = [field for field in fields if UNIT.fullmatch(field)]
            if not names or not any(name.endswith('.timer') for name in names):
                raise ListingRefusal('LISTING_UNKNOWN', surface, index, line, rows, maximum)
            rows.append({'units': names})
        elif surface == 'jobs':
            if len(fields) < 4 or not fields[0].isdigit() or not UNIT.fullmatch(fields[1]):
                raise ListingRefusal('LISTING_UNKNOWN', surface, index, line, rows, maximum)
            rows.append({'job': fields[0], 'unit': fields[1], 'kind': fields[2], 'state': fields[3]})
        else:
            if (len(fields) < 3 or not fields[1].isdigit() or not TOKEN.fullmatch(fields[0]) or
                    not re.fullmatch(r'[a-z_][a-z0-9_-]{0,63}', fields[2])):
                raise ListingRefusal('LISTING_UNKNOWN', surface, index, line, rows, maximum)
            rows.append({'session': fields[0], 'uid': fields[1], 'owner': fields[2]})
    return rows


def new_admission():
    return {name: set() for name in ('units', 'managers', 'sessions', 'users')}


def collect_cron_metadata(users, deadline, clock):
    files, errors = [], []
    paths = list(dict.fromkeys(list(CRON_ROOTS) + ['/var/spool/cron/crontabs']
                              + ['/var/spool/cron/crontabs/' + user for user in users]))
    count = 0
    for path in paths:
        if clock() >= deadline:
            errors.append('CRON_TIME_BOUND')
            break
        try:
            info = os.lstat(path)
            candidates = [path]
            if stat.S_ISDIR(info.st_mode):
                candidates = []
                with os.scandir(path) as entries:
                    for entry in entries:
                        count += 1
                        if count > 64 or clock() >= deadline:
                            errors.append('CRON_ENUMERATION_BOUND')
                            break
                        candidates.append(path + '/' + entry.name)
            for candidate in candidates:
                count += 1
                if count > 64 or clock() >= deadline:
                    errors.append('CRON_ENUMERATION_BOUND')
                    break
                before = os.lstat(candidate)
                need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'CRON_FILE_TYPE')
                need(before.st_size <= 16384, 'CRON_FILE_BOUND')
                fd = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    opened = os.fstat(fd)
                    need(identity(opened) == identity(before), 'CRON_REPLACED')
                    raw = os.read(fd, 16385)
                    after = os.fstat(fd)
                    need(len(raw) <= 16384 and identity(os.lstat(candidate)) == identity(before)
                         and (after.st_size, after.st_mtime_ns, after.st_ctime_ns) ==
                         (before.st_size, before.st_mtime_ns, before.st_ctime_ns), 'CRON_REPLACED')
                    files.append({'path': candidate, 'identity': identity(before),
                                  'uid': before.st_uid, 'mode': stat.S_IMODE(before.st_mode),
                                  'sha256': hashlib.sha256(raw).hexdigest()})
                finally:
                    os.close(fd)
        except FileNotFoundError:
            files.append({'path': path, 'absent': True})
        except (OSError, Refusal):
            errors.append('CRON_UNRESOLVED')
    return {'coverage': 'partial' if errors else 'complete', 'files': files,
            'errors': sorted(set(errors)), 'approval': 'unreviewed'}


def collect_kernel_metadata(pins, deadline, clock):
    matches, errors, dispositions = [], [], []
    count = total_fds = total_maps = 0
    observed_pids = set()
    identities = {tuple(pin['identity']) for pin in pins}
    paths = {pin['path'] for pin in pins}
    try:
        with os.scandir('/proc') as entries:
            for entry in entries:
                if not entry.name.isdigit():
                    continue
                count += 1
                if count > KERNEL_BOUNDS['maximumProcesses'] or clock() >= deadline:
                    errors.append('KERNEL_PROCESS_OR_TIME_BOUND')
                    break
                pid = int(entry.name)
                observed_pids.add(pid)
                stage = 'process-identity-before'
                try:
                    before = read_process(pid, allow_inert=True)
                    stage = 'file-descriptors'
                    fd_count = 0
                    with os.scandir('/proc/' + entry.name + '/fd') as descriptors:
                        for descriptor in descriptors:
                            fd_count += 1
                            total_fds += 1
                            if (fd_count > KERNEL_BOUNDS['maximumFdsEach'] or
                                    total_fds > KERNEL_BOUNDS['maximumTotalFds'] or clock() >= deadline):
                                raise Refusal('KERNEL_FD_BOUND')
                            info = os.stat(descriptor.path)
                            if tuple(identity(info)) in identities:
                                matches.append({'pid': pid, 'startTicks': before['startTicks'],
                                                'kind': 'fd', 'identity': identity(info)})
                    stage = 'memory-maps'
                    with open('/proc/' + entry.name + '/maps', 'rb') as mapping:
                        raw = mapping.read(KERNEL_BOUNDS['maximumMapsBytesEach'] + 1)
                    total_maps += len(raw)
                    need(len(raw) <= KERNEL_BOUNDS['maximumMapsBytesEach'] and
                         total_maps <= KERNEL_BOUNDS['maximumTotalMapsBytes'], 'KERNEL_MAPS_BOUND')
                    for line in raw.decode('utf-8', 'strict').splitlines():
                        fields = line.split(None, 5)
                        need(len(fields) >= 5, 'KERNEL_MAPS_FORMAT')
                        major, minor = fields[3].split(':')
                        ino = int(fields[4])
                        dev = os.makedev(int(major, 16), int(minor, 16))
                        if (dev, ino) in identities or (len(fields) == 6 and fields[5] in paths):
                            matches.append({'pid': pid, 'startTicks': before['startTicks'],
                                            'kind': 'map', 'identity': [dev, ino],
                                            'permissions': fields[1]})
                    stage = 'process-identity-after'
                    need(read_process(pid, allow_inert=True) == before, 'KERNEL_PROCESS_CHANGED')
                    if before.get('resourceClass') in ('kernel-thread', 'zombie'):
                        stage = 'inert-resource-validation'
                        need(fd_count == 0 and raw == b'', 'KERNEL_INERT_RESOURCES')
                        dispositions.append({'pid': pid, 'stage': 'resources-verified',
                            'disposition': 'MEASURED_EMPTY_' + before['resourceClass'].upper().replace('-', '_')})
                except (OSError, ValueError, UnicodeError, Refusal) as error:
                    reason = 'PROCESS_DISAPPEARED' if isinstance(error, FileNotFoundError) else (
                        'ACCESS_DENIED' if isinstance(error, PermissionError) else (
                        str(error) if isinstance(error, Refusal) and str(error) in
                        ('KERNEL_FD_BOUND', 'KERNEL_MAPS_BOUND', 'KERNEL_PROCESS_CHANGED', 'KERNEL_INERT_RESOURCES')
                        else 'IDENTITY_OR_METADATA_UNRESOLVED'))
                    dispositions.append({'pid': pid, 'stage': stage, 'disposition': reason})
                    errors.append('KERNEL_PROCESS_UNRESOLVED')
    except OSError:
        errors.append('KERNEL_ENUMERATION_UNRESOLVED')
    try:
        after_pids = set()
        with os.scandir('/proc') as entries:
            for entry in entries:
                if not entry.name.isdigit():
                    continue
                need(len(after_pids) < KERNEL_BOUNDS['maximumProcesses'] and clock() < deadline, 'KERNEL_PROCESS_OR_TIME_BOUND')
                after_pids.add(int(entry.name))
        need(after_pids == observed_pids, 'KERNEL_PROCESS_SET_CHANGED')
    except (OSError, Refusal):
        errors.append('KERNEL_PROCESS_SET_UNRESOLVED')
    return {'coverage': 'partial' if errors else 'complete', 'processesExamined': count,
            'descriptorsExamined': total_fds, 'mapsBytes': total_maps,
            'sourceHolders': matches, 'dispositions': dispositions,
            'errors': sorted(set(errors)), 'bounds': KERNEL_BOUNDS}


def collect_v2_surfaces(policy, report, query, clock, deadline, block, admission,
                        user_lookup, cron_reader, kernel_reader):
    report['cronMetadata'] = cron_reader(policy['approvedUsers'], deadline, clock)
    report['coverage']['cron'] = report['cronMetadata']['coverage']
    report['kernelMetadata'] = kernel_reader(policy['sourcePins'], deadline, clock)
    report['coverage']['kernel'] = report['kernelMetadata']['coverage']
    report['processCoverage'] = 'bounded-all-procs-source-holder-discovery'
    report['operatorSessions'] = []
    sessions_ok = report['coverage']['systemListings'].get('sessions') == 'complete'
    for session in report['listings'].get('sessions', []):
        admission['sessions'].add(session['session'])
        raw = query('loginctl', ('show-session', '--no-pager',
                    *('--property=' + name for name in SESSION_PROPERTIES), '--', session['session']))
        if raw is None:
            sessions_ok = False
            block('SESSION_QUERY_UNRESOLVED')
            continue
        values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        if (values.get('Id') != session['session'] or values.get('User') != str(session['uid'])
                or values.get('Name') != session['owner']):
            sessions_ok = False
            block('SESSION_IDENTITY_UNRESOLVED')
        else:
            report['operatorSessions'].append({key: values.get(key, '') for key in SESSION_PROPERTIES})
    report['coverage']['sessions'] = 'complete' if sessions_ok else 'partial'
    report['userManagers'] = []
    manager_uids, queried_uids = set(), set()
    observed_uids = set()
    for surface in ('units', 'unit-files'):
        for row in report['listings'].get(surface, []):
            match = re.fullmatch(r'user@([0-9]+)[.]service', row.get('unit', ''))
            if match:
                observed_uids.add(int(match[1]))
    for session in report['listings'].get('sessions', []):
        observed_uids.add(int(session['uid']))
    manager_complete = all(report['coverage']['systemListings'].get(name) == 'complete'
                           for name in ('units', 'unit-files', 'sessions'))
    for user in policy['approvedUsers']:
        try:
            account = user_lookup(user)
            need(type(account.pw_uid) is int and account.pw_uid >= 0
                 and account.pw_uid not in manager_uids, 'USER_ACCOUNT_UNRESOLVED')
            manager_uids.add(account.pw_uid)
        except Exception:
            manager_complete = False
            block('USER_ACCOUNT_UNRESOLVED')
            continue
        unit = 'user@' + str(account.pw_uid) + '.service'
        admission['managers'].add(unit)
        raw = query('systemctl', ('show', '--no-pager',
                    '--property=' + ','.join(MANAGER_PROPERTIES), '--', unit))
        if raw is None:
            manager_complete = False
            block('USER_MANAGER_QUERY_UNRESOLVED')
            continue
        values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        report['userManagers'].append({'user': user, 'uid': account.pw_uid, 'properties': values})
        if (set(values) == set(MANAGER_PROPERTIES) and values.get('Id') == unit
                and values.get('LoadState') == 'loaded' and values.get('ActiveState') == 'inactive'
                and values.get('MainPID') == '0' and account.pw_uid not in observed_uids):
            continue
        if (set(values) != set(MANAGER_PROPERTIES) or values.get('Id') != unit
                or values.get('LoadState') != 'loaded' or values.get('ActiveState') != 'active'
                or not values.get('MainPID', '').isdigit() or int(values['MainPID']) == 0):
            manager_complete = False
            block('USER_MANAGER_UNRESOLVED')
            continue
        queried_uids.add(account.pw_uid)
        admission['users'].add(user)
        for surface, tool, args in LISTING_COMMANDS:
            if tool != 'systemctl':
                continue
            raw = query(tool, args + ('--user', '--machine=' + user + '@.host'))
            if raw is None:
                manager_complete = False
                block('USER_LISTING_QUERY_UNRESOLVED')
                continue
            try:
                rows = parse_listing(surface, raw, policy['limits']['maximumListingRows'])
                report.setdefault('userListings', []).append({'user': user, 'surface': surface, 'rows': rows})
            except ListingRefusal as error:
                report['listingFailures'].append(error.detail)
                manager_complete = False
                block('USER_LISTING_INCOMPLETE')
    unknown_uids = observed_uids - manager_uids
    if unknown_uids:
        manager_complete = False
        block('USER_MANAGER_UNAPPROVED_UID')
    if not observed_uids.issubset(queried_uids):
        manager_complete = False
    report['userManagerInventory'] = {'observedUids': sorted(observed_uids),
        'approvedUids': sorted(manager_uids), 'queriedUids': sorted(queried_uids),
        'unapprovedUids': sorted(unknown_uids)}
    report['coverage']['userManagers'] = 'complete' if manager_complete else 'partial'
    report['observedUnitMetadata'] = []
    candidates = set()
    for row in report['listings'].get('units', []):
        unit = row.get('unit', '')
        if unit.endswith('.service') and unit.startswith(('address-radar-', 'fomo-')):
            candidates.add(unit)
    for row in report['listings'].get('timers', []):
        for unit in row.get('units', []):
            if unit.endswith('.service') and unit.startswith(('address-radar-', 'fomo-')):
                candidates.add(unit)
    candidates.difference_update(KNOWN_UNITS)
    complete = all(report['coverage']['systemListings'].get(surface) == 'complete'
                   for surface in ('units', 'unit-files', 'timers'))
    if len(candidates) > 32:
        complete = False
        block('OBSERVED_UNIT_METADATA_BOUND')
    for unit in sorted(candidates)[:32]:
        admission['units'].add(unit)
        raw = query('systemctl', ('show', '--no-pager',
                    '--property=' + ','.join(SERVICE_PROPERTIES), '--', unit))
        if raw is None:
            complete = False
            block('OBSERVED_UNIT_QUERY_UNRESOLVED')
            continue
        values = {}
        valid = True
        for line in raw.splitlines():
            if '=' not in line:
                valid = False
                break
            key, value = line.split('=', 1)
            if key not in SERVICE_PROPERTIES or key in values or len(value) > 2048 or any(
                    ord(char) < 32 or ord(char) == 127 for char in value):
                valid = False
                break
            values[key] = value
        if (not valid or set(values) != set(SERVICE_PROPERTIES) or values.get('Id') != unit
                or values.get('LoadState') != 'loaded' or not values.get('MainPID', '').isdigit()):
            complete = False
            block('OBSERVED_UNIT_IDENTITY_UNRESOLVED')
            continue
        report['observedUnitMetadata'].append({'unit': unit, 'properties': values,
                                               'admissionClosed': False})
    report['coverage']['unitMetadata'] = 'complete' if complete else 'partial'
    if report['coverage']['userManagers'] != 'complete':
        block('USER_MANAGER_GLOBAL_CLOSURE_UNRESOLVED')
    block('BRIDGE_ADMISSION_NOT_PROVEN')


def collect_inventory(policy, execute, clock=time.monotonic, *, process_reader=read_process,
                      source_reader=source_metadata, host_reader=socket.gethostname, not_after=None,
                      admission=None, user_lookup=pwd.getpwnam, cron_reader=None, kernel_reader=None):
    validate_policy(policy)
    bounds = policy['limits']
    start = clock()
    deadline = min(start + bounds['operationSeconds'], not_after if not_after is not None else float('inf'))
    report = {'version': 1, 'kind': 'readonly-discovery', 'readOnly': True,
        'policySha256': digest(canonical(policy)), 'observedHost': host_reader(), 'commandsExecuted': 0,
        'knownUnits': [], 'listings': {}, 'listingFailures': [], 'sourceMetadata': [], 'blockers': [],
        'coverage': {'systemListings': {}, 'userManagers': 'not-requested', 'sessions': 'not-requested',
                     'cron': 'not-requested', 'kernel': 'not-requested', 'unitMetadata': 'known-roots-only',
                     'bridge': 'unknown', 'deploy': 'unknown', 'external-input': 'unknown'},
        'processCoverage': 'known-service-root-pids-only', 'fomoIdentityStable': False,
        **{key: False for key in FALSE_CLAIMS}}
    def block(code):
        if code not in report['blockers']:
            report['blockers'].append(code)
    for code in ('READ_ONLY_DISCOVERY_NOT_A_FENCE', 'BRIDGE_SCOPE_UNKNOWN', 'CRON_AND_AT_SCOPE_UNKNOWN',
                 'OPERATOR_SCOPE_UNKNOWN', 'DEPLOY_SCOPE_UNKNOWN', 'EXTERNAL_INPUT_SCOPE_UNKNOWN',
                 'USER_MANAGERS_NOT_ENUMERATED', 'FD_AND_MMAP_CLOSURE_NOT_ACQUIRED'):
        block(code)
    if policy['expectedHost'] is None:
        block('HOST_BINDING_UNAPPROVED')
    elif report['observedHost'] != policy['expectedHost']:
        block('HOST_BINDING_CHANGED')
    if not policy['sourceFiles']:
        block('SOURCE_SCOPE_UNBOUND')
    def budget():
        need(start <= clock() < deadline, 'OPERATION_BOUND')
        need(report['commandsExecuted'] < bounds['maximumCommands'], 'COMMAND_BUDGET_EXHAUSTED')
    def query(tool, args):
        try:
            budget()
            report['commandsExecuted'] += 1
            raw = execute(tool, args, min(bounds['commandSeconds'], deadline - clock()), bounds['maximumOutputBytes'])
            need(start <= clock() < deadline, 'OPERATION_BOUND')
            need(isinstance(raw, str) and len(raw.encode()) <= bounds['maximumOutputBytes'], 'OUTPUT_BOUND')
            return raw
        except Refusal as error:
            block(str(error) if str(error) in ('OPERATION_BOUND', 'COMMAND_BUDGET_EXHAUSTED', 'OUTPUT_BOUND', 'COMMAND_BOUND', 'COMMAND_FAILED',
                  'RUNTIME_PIN', 'FILE_REPLACED', 'ANCESTOR_REPLACED') else 'COMMAND_UNAVAILABLE')
        except Exception:
            block('COMMAND_UNAVAILABLE')
        return None
    def surface_query(tool, args):
        # Preserve the final protected-process identity checks within the original budget.
        if report['commandsExecuted'] + len(FOMO) >= bounds['maximumCommands']:
            block('SURFACE_COMMAND_BUDGET_RESERVED')
            return None
        return query(tool, args)
    def observe(unit):
        raw = query('systemctl', ['show', '--no-pager', '--property=' + ','.join(SERVICE_PROPERTIES), unit])
        if raw is None:
            return None
        fields = {}
        for line in raw.splitlines():
            key, separator, value = line.partition('=')
            need(separator and key in SERVICE_PROPERTIES and key not in fields and len(value) <= 2048 and
                 not re.search(r'[\x00-\x1f\x7f]', value), 'UNIT_PROPERTIES_UNKNOWN')
            fields[key] = value
        need(set(fields) == set(SERVICE_PROPERTIES) and fields['Id'] == unit and
             fields['LoadState'] == 'loaded' and fields['MainPID'].isdigit(), 'UNIT_PROPERTIES_UNKNOWN')
        pid = int(fields['MainPID'])
        process = None
        if pid:
            need(start <= clock() < deadline, 'OPERATION_BOUND')
            process = process_reader(pid)
            need(start <= clock() < deadline, 'OPERATION_BOUND')
        if unit in FOMO:
            need(fields['ActiveState'] == 'active' and fields['SubState'] == 'running' and process is not None,
                 'FOMO_PROCESS_IDENTITY_UNAVAILABLE')
        return {'unit': unit, 'properties': fields, 'process': process}
    try:
        budget()
        before_source = source_reader(policy['sourceFiles'])
        need(start <= clock() < deadline, 'OPERATION_BOUND')
        for unit in FOMO + MAIN:
            try:
                item = observe(unit)
                if item is not None:
                    report['knownUnits'].append(item)
            except Exception:
                block('FOMO_PROCESS_IDENTITY_UNAVAILABLE' if unit in FOMO else 'KNOWN_UNIT_IDENTITY_UNAVAILABLE')
        for surface, tool, args in LISTING_COMMANDS:
            raw = query(tool, args)
            if raw is None:
                continue
            try:
                rows = parse_listing(surface, raw, bounds['maximumListingRows'])
                report['listings'][surface] = rows
                report['coverage']['systemListings'][surface] = 'complete'
                if any(row.get('unit') not in KNOWN_UNITS for row in rows if 'unit' in row):
                    block('UNREVIEWED_SYSTEM_UNIT')
                if surface == 'timers' and rows:
                    block('TIMER_SCOPES_UNREVIEWED')
                if surface == 'jobs' and rows:
                    block('INFLIGHT_SYSTEM_JOBS_OBSERVED')
                if surface == 'sessions' and rows:
                    block('OPERATOR_SESSIONS_UNREVIEWED')
            except ListingRefusal as error:
                report['listings'][surface] = error.rows
                report['listingFailures'].append(dict(error.detail, stdoutSha256=digest(raw.encode()),
                                                     stdoutBytes=len(raw.encode())))
                report['coverage']['systemListings'][surface] = 'partial'
                block('LISTING_INCOMPLETE')
        if policy['version'] == 2:
            actual_pins = [{key: item[key] for key in ('path', 'identity', 'uid')} for item in before_source]
            if actual_pins != policy['sourcePins'] or report['observedHost'] != policy['expectedHost']:
                block('V2_HOST_OR_SOURCE_PIN_CHANGED')
            else:
                collect_v2_surfaces(policy, report, surface_query, clock, deadline, block,
                    admission if admission is not None else new_admission(), user_lookup,
                    cron_reader or collect_cron_metadata, kernel_reader or collect_kernel_metadata)
        first_fomo = {item['unit']: item for item in report['knownUnits'] if item['unit'] in FOMO}
        unchanged = len(first_fomo) == len(FOMO)
        identity_measured = unchanged
        identity_changed = False
        for unit in FOMO:
            try:
                after = observe(unit)
                if after is None or unit not in first_fomo:
                    identity_measured = False
                elif first_fomo[unit] != after:
                    identity_changed = True
                unchanged = unchanged and after is not None and first_fomo.get(unit) == after
            except Exception:
                unchanged = False
                identity_measured = False
        report['fomoIdentityStable'] = unchanged
        if identity_changed:
            block('FOMO_PROCESS_IDENTITY_CHANGED')
        if not identity_measured:
            block('FOMO_PROCESS_IDENTITY_UNRESOLVED')
        need(start <= clock() < deadline, 'OPERATION_BOUND')
        after_source = source_reader(policy['sourceFiles'])
        need(start <= clock() < deadline, 'OPERATION_BOUND')
        if before_source != after_source:
            block('SOURCE_IDENTITY_CHANGED')
        report['sourceMetadata'] = before_source
    except Refusal as error:
        block('OPERATION_BOUND' if str(error) == 'OPERATION_BOUND' else 'SOURCE_IDENTITY_UNAVAILABLE')
    except Exception:
        block('SOURCE_IDENTITY_UNAVAILABLE')
    report['inventoryComplete'] = (all(report['coverage'].get(kind) == 'complete' for kind in
        ('userManagers', 'sessions', 'cron', 'kernel', 'unitMetadata', 'bridge', 'deploy', 'external-input')) and
        all(report['coverage']['systemListings'].get(kind) == 'complete' for kind in
            ('units', 'unit-files', 'timers', 'jobs', 'sessions')))
    report['elapsedMs'] = max(0, int((clock() - start) * 1000))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('seed', 'seed-v2', 'discover'))
    parser.add_argument('--policy')
    parser.add_argument('--policy-sha256')
    parser.add_argument('--expected-entry-sha256')
    args = parser.parse_args(argv)
    opened = {}
    try:
        if args.action in ('seed', 'seed-v2'):
            need(args.policy is None and args.policy_sha256 is None and args.expected_entry_sha256 is None, 'ARGUMENTS')
            seed = seed_policy(2 if args.action == 'seed-v2' else 1)
            result = {'status': 'offline-discovery-seed', 'policy': seed,
                      'policySha256': digest(canonical(seed)), 'scopeApproved': False,
                      'signedProofsCreated': False, 'productionReadiness': False}
        else:
            need(args.policy is not None and args.policy_sha256 is not None and
                 args.expected_entry_sha256 is not None, 'ARGUMENTS')
            original_deadline = time.monotonic() + 30
            policy = load_policy(args.policy, args.policy_sha256)
            need(time.monotonic() < original_deadline, 'OPERATION_BOUND')
            opened = native_runtime(policy, args.expected_entry_sha256, original_deadline)
            admission = new_admission()
            result = collect_inventory(policy, lambda tool, values, timeout, maximum:
                native_execute(opened, policy, tool, values, timeout, maximum, admission),
                not_after=original_deadline, admission=admission)
            result['collectorEntrySha256'] = args.expected_entry_sha256
            result['runtimePins'] = policy['runtimePins']
        raw = canonical(result)
        need(len(raw) <= 1048576, 'REPORT_BOUND')
        print(raw.decode('ascii'))
        return 0 if args.action in ('seed', 'seed-v2') else 1
    except Exception:
        print('{"status":"refused","reason":"DISCOVERY_REFUSED","scopeApproved":false,"signedProofsCreated":false,"productionReadiness":false}')
        return 2
    finally:
        for fd, _, _ in opened.values():
            os.close(fd)


if __name__ == '__main__':
    sys.exit(main())
