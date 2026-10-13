#!/usr/bin/env python3
"""Measure a parent-established Linux source boundary; never activate or restore it."""
import argparse
import hashlib
import json
import os
import re
import stat
import sys
import subprocess
import time


class Refused(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Refused(reason)


class Deadline:
    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.started = clock()
        self.expires = self.started + seconds

    def clip(self, seconds):
        self.expires = min(self.expires, self.started + seconds)
        self.check()

    def check(self):
        require(self.clock() < self.expires, 'original-deadline')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def bounded_names(entries, limit, check):
    result = []
    for entry in entries:
        check()
        require(len(result) < limit, 'enumeration-budget')
        result.append(entry.name if hasattr(entry, 'name') else entry)
    return sorted(result)


def proc_start(raw):
    fields = raw[raw.rfind(')') + 2:].split()
    require(len(fields) >= 20 and fields[19].isdigit(), 'process-stat')
    return fields[19]


def validate_kernel_boundary(value):
    require(value.get('complete') is True, 'incomplete-census')
    parent = value['parent']
    require(parent['directory'] and parent['uid'] == 0 and parent['mode'] == 0o700,
            'namespace-permissions')
    require(bool(value['sources']), 'source-missing')
    for source in value['sources']:
        require(source['regular'] and source['uid'] == 0 and source['mode'] == 0o400
                and source['nlink'] == 1, 'source-permissions')
    handles = 0
    for process in value['processes']:
        require(process['uid'] == 0 or process['capabilities'] == 0, 'nonroot-capability')
        require(not any(item['writable'] for item in process['handles']), 'live-writable-handle')
        require(not any(item['writable'] for item in process['mappings']), 'live-writable-mapping')
        require(not process['mappings'], 'live-source-mapping')
        if process['handles'] or process['mappings']:
            require(process['scoped'], 'unscoped-source-access')
        handles += len(process['handles'])
    return dict(version=1, kernelAccessBoundaryMeasured=True,
                trustBoundary='trusted-root-administration', sourceHandles=handles,
                processesMeasured=len(value['processes']), signedProofsCreated=False,
                coordinatorEvidenceCreated=False)


def identity(value):
    return value.st_dev, value.st_ino


def attributes(value):
    return identity(value), value.st_uid, stat.S_IMODE(value.st_mode), value.st_nlink


def protected_read(path, limit, check, private=False):
    require(os.path.isabs(path) and os.path.normpath(path) == path, 'protected-path')
    parents = []
    parent = os.path.dirname(path)
    while True:
        check()
        value = os.lstat(parent)
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0
                and not stat.S_IMODE(value.st_mode) & 0o022, 'protected-ancestor')
        parents.append((parent, attributes(value)))
        if parent == '/':
            break
        parent = os.path.dirname(parent)
    value = os.lstat(path)
    require(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and value.st_nlink == 1
            and not stat.S_IMODE(value.st_mode) & 0o022 and value.st_size <= limit,
            'protected-file')
    if private:
        require(stat.S_IMODE(value.st_mode) == 0o600
                and stat.S_IMODE(os.lstat(os.path.dirname(path)).st_mode) == 0o700,
                'private-record')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(attributes(value) == attributes(before), 'protected-replaced')
        parts = []
        count = 0
        while True:
            check()
            part = os.read(fd, min(65536, limit + 1 - count))
            if not part:
                break
            parts.append(part)
            count += len(part)
            require(count <= limit, 'read-budget')
        after = os.fstat(fd)
        require(attributes(before) == attributes(after)
                and (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and attributes(os.lstat(path)) == attributes(after), 'protected-mutated')
        for name, pin in parents:
            require(attributes(os.lstat(name)) == pin, 'protected-ancestor-replaced')
        return b''.join(parts)
    finally:
        os.close(fd)


def proc_read(path, limit, check):
    check()
    with open(path, 'rb', buffering=0) as handle:
        result = handle.read(limit + 1)
    check()
    require(len(result) <= limit, 'process-read-budget')
    return result


def list_names(path, maximum, check):
    with os.scandir(path) as entries:
        return bounded_names(entries, maximum, check)


def validate_managed_measurement(record, properties, cgroup_identity, events, terminal=False):
    require(properties.get('Id') == record['unitId']
            and properties.get('InvocationID') == record['invocationId']
            and properties.get('ControlGroup') == record['cgroupPath']
            and properties.get('Transient') == 'yes', 'managed-identity')
    require(cgroup_identity == record['cgroupIdentity'], 'managed-cgroup')
    entries = {}
    for line in events.splitlines():
        pair = line.split()
        require(len(pair) == 2 and pair[0] not in entries
                and pair[0] in {'populated', 'frozen'} and pair[1] in {'0', '1'}, 'managed-events')
        entries[pair[0]] = pair[1]
    require('populated' in entries, 'managed-events')
    if terminal:
        require(properties.get('ActiveState') == 'inactive' and properties.get('SubState') == 'dead'
                and properties.get('Job') == '0', 'managed-terminal')
        require(entries['populated'] == '0', 'managed-populated')
    else:
        require(properties.get('ActiveState') == 'active' and properties.get('Job') == '0',
                'managed-admission')
        require(entries['populated'] == '1', 'managed-populated')


class ManagedUnitMonitor:
    """Retain cgroup/event descriptors before work; absence is never empty.

    The existing pinned external adapter still owns the permanent lease lock.
    This readonly monitor neither releases that lock nor launches/stops units.
    """
    def __init__(self, record, check):
        self.record = record
        self.check = check
        self.directory = None
        self.events_fd = None
        require(re.fullmatch('[A-Za-z0-9_.@:-]+[.]service', record['unitId']) is not None
                and re.fullmatch('[0-9a-f]{32}', record['invocationId']) is not None
                and record['cgroupPath'].startswith('/')
                and os.path.normpath(record['cgroupPath']) == record['cgroupPath'], 'managed-record')
        self.path = '/sys/fs/cgroup' + record['cgroupPath']
        try:
            parent = self.path
            while True:
                check()
                value = os.lstat(parent)
                require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0
                        and not stat.S_IMODE(value.st_mode) & 0o022, 'managed-ancestor')
                if parent == '/':
                    break
                parent = os.path.dirname(parent)
            self.directory = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            require(list(identity(os.fstat(self.directory))) == record['cgroupIdentity'], 'managed-cgroup')
            self.events_fd = os.open('cgroup.events', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                     dir_fd=self.directory)
            self.event_identity = identity(os.fstat(self.events_fd))
            self.assert_active()
        except Exception:
            self.close()
            raise

    def properties(self):
        self.check()
        code = protected_read(self.record['systemctlPath'], 256 * 1024 * 1024, self.check)
        require(hashlib.sha256(code).hexdigest() == self.record['systemctlSha256'], 'managed-code')
        owner = getattr(self.check, '__self__', None)
        timeout = min(2, owner.expires - owner.clock()) if isinstance(owner, Deadline) else 2
        require(timeout > 0, 'original-deadline')
        result = subprocess.run([self.record['systemctlPath'], 'show', self.record['unitId'],
                                 '--property=Id,InvocationID,ControlGroup,Transient,ActiveState,SubState,Job'],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        self.check()
        require(result.returncode == 0 and len(result.stdout) <= 16384, 'managed-query')
        properties = {}
        for line in result.stdout.decode().splitlines():
            pair = line.split('=', 1)
            require(len(pair) == 2 and pair[0] not in properties, 'managed-properties')
            properties[pair[0]] = pair[1]
        return properties

    def observation(self):
        self.check()
        require(self.directory is not None and self.events_fd is not None, 'managed-descriptor')
        require(identity(os.lstat(self.path)) == identity(os.fstat(self.directory)), 'managed-cgroup')
        live_event = os.stat('cgroup.events', dir_fd=self.directory, follow_symlinks=False)
        require(identity(live_event) == self.event_identity, 'managed-events-replaced')
        os.lseek(self.events_fd, 0, os.SEEK_SET)
        events = os.read(self.events_fd, 4097)
        require(len(events) <= 4096, 'managed-events')
        properties = self.properties()
        require(identity(os.lstat(self.path)) == identity(os.fstat(self.directory)), 'managed-cgroup')
        self.check()
        return properties, list(identity(os.fstat(self.directory))), events.decode()

    def assert_active(self):
        properties, pin, events = self.observation()
        validate_managed_measurement(self.record, properties, pin, events)

    def assert_terminal(self):
        properties, pin, events = self.observation()
        validate_managed_measurement(self.record, properties, pin, events, terminal=True)

    def close(self):
        for name in ('events_fd', 'directory'):
            fd = getattr(self, name, None)
            if fd is not None:
                setattr(self, name, None)
                os.close(fd)


def source_state(job, check):
    parent_path = job['sourceDirectory']
    check()
    ancestors = []
    ancestor = os.path.dirname(parent_path)
    while True:
        check()
        info = os.lstat(ancestor)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not stat.S_IMODE(info.st_mode) & 0o022, 'namespace-ancestor')
        ancestors.append((ancestor, attributes(info)))
        if ancestor == '/':
            break
        ancestor = os.path.dirname(ancestor)
    parent = os.lstat(parent_path)
    require(list(identity(parent)) == job['sourceDirectoryIdentity'], 'namespace-replaced')
    require(not os.listxattr(parent_path, follow_symlinks=False), 'namespace-xattrs')
    parent_record = dict(path=parent_path, uid=parent.st_uid,
                         mode=stat.S_IMODE(parent.st_mode), directory=stat.S_ISDIR(parent.st_mode))
    values = []
    identities = set()
    for pin in job['sources']:
        check()
        path = pin['path']
        require(os.path.dirname(path) == parent_path, 'source-outside-namespace')
        if pin.get('absent') is True:
            require(not os.path.lexists(path), 'absent-source-created')
            continue
        value = os.lstat(path)
        require(list(identity(value)) == pin['identity'], 'source-replaced')
        require(not os.listxattr(path, follow_symlinks=False), 'source-xattrs')
        values.append(dict(path=path, device=value.st_dev, inode=value.st_ino,
                           uid=value.st_uid, mode=stat.S_IMODE(value.st_mode),
                           nlink=value.st_nlink, regular=stat.S_ISREG(value.st_mode)))
        identities.add(identity(value))
    for path, pin in ancestors:
        check()
        require(attributes(os.lstat(path)) == pin, 'namespace-ancestor-replaced')
    return parent_record, values, identities


def measure_process(pid, source_ids, scopes, check, remaining):
    base = '/proc/' + pid
    start = proc_start(proc_read(base + '/stat', 16384, check).decode())
    tids = list_names(base + '/task', 4096, check)
    result = []
    for tid in tids:
        require(tid.isdigit(), 'unexpected-task')
        task = base + '/task/' + tid
        status = proc_read(task + '/status', 65536, check).decode()
        parsed = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
        uids = [int(item) for item in parsed['Uid'].split()]
        require(len(uids) == 4, 'process-uid')
        caps = 0
        for field in ('CapEff', 'CapPrm', 'CapAmb'):
            require(field in parsed, 'process-capabilities')
            caps |= int(parsed[field].strip(), 16)
        # A mixed root identity can regain privilege, and must remain within the root trust boundary.
        require(all(uid == 0 for uid in uids) or all(uid != 0 for uid in uids), 'mixed-root-identity')
        handles = []
        for number in list_names(task + '/fd', 8192, check):
            remaining[0] -= 1
            require(remaining[0] >= 0 and number.isdigit(), 'fd-budget')
            value = os.stat(task + '/fd/' + number)
            if identity(value) not in source_ids:
                continue
            info = proc_read(task + '/fdinfo/' + number, 16384, check).decode()
            flags = re.search(r'^flags:\s*([0-7]+)$', info, re.MULTILINE)
            require(flags is not None, 'fd-flags')
            handles.append(dict(writable=bool(int(flags[1], 8) & os.O_ACCMODE)))
        mappings = []
        raw_maps = proc_read(task + '/maps', 4 * 1024 * 1024, check).decode()
        for line in raw_maps.splitlines():
            fields = line.split(None, 5)
            require(len(fields) >= 5, 'mapping-format')
            major, minor = fields[3].split(':')
            device = os.makedev(int(major, 16), int(minor, 16))
            if (device, int(fields[4])) in source_ids:
                # Conservative: private writable mappings are refused as well.
                mappings.append(dict(writable='w' in fields[1]))
        scoped = False
        if handles or mappings:
            exe = os.readlink(task + '/exe')
            cgroup = proc_read(task + '/cgroup', 16384, check).decode()
            matches = [scope for scope in scopes if scope['uid'] == uids[0]
                       and scope['exePath'] == exe
                       and '0::' + scope['cgroupPath'] + '\n' == cgroup]
            require(len(matches) == 1, 'unscoped-source-access')
            scope = matches[0]
            code = protected_read(exe, 256 * 1024 * 1024, check)
            require(hashlib.sha256(code).hexdigest() == scope['exeSha256'], 'scope-code-changed')
            actual_argv = proc_read(task + '/cmdline', 65536, check).split(b'\0')
            require(actual_argv and actual_argv[-1] == b'', 'scope-argv')
            require([item.decode() for item in actual_argv[:-1]] == scope['argv'], 'scope-argv')
            for pin in scope['codePins']:
                raw = protected_read(pin['path'], 256 * 1024 * 1024, check)
                require(hashlib.sha256(raw).hexdigest() == pin['sha256'], 'scope-code-changed')
            monitor = ManagedUnitMonitor(scope, check)
            try:
                monitor.assert_active()
            finally:
                monitor.close()
            scoped = True
        result.append(dict(uid=uids[0], capabilities=caps, scoped=scoped,
                           handles=handles, mappings=mappings))
    require(list_names(base + '/task', 4096, check) == tids, 'task-set-changed')
    require(proc_start(proc_read(base + '/stat', 16384, check).decode()) == start, 'pid-reused')
    return result


def admission_check(job, check):
    control = '/etc/address-radar/sqlite-writer-admission/'
    records = {}
    for name in ('activation', 'policy', 'state'):
        raw = protected_read(control + name + '.json', 65536, check)
        value = json.loads(raw)
        require(raw == canonical(value), 'admission-canonical')
        records[name] = (value, hashlib.sha256(raw).hexdigest())
    activation = records['activation'][0]
    policy, policy_hash = records['policy']
    state, state_hash = records['state']
    require(activation['version'] == 1 and policy['version'] == 1 and state['version'] == 1
            and activation['policySha256'] == policy_hash == job['admissionPolicySha256']
            and activation['deploymentId'] == policy['deploymentId'] == state['deploymentId']
            and state['policySha256'] == policy_hash and state_hash == job['admissionStateSha256']
            and state['challengeId'] == policy['challengeId'] and state['admission'] == 'closed'
            and state['notBefore'] == policy['notBefore'] and state['notAfter'] == policy['notAfter']
            and policy['notBefore'] <= time.time() * 1000 < policy['notAfter']
            and policy['unresolvedScopes'] == [], 'admission-not-closed')
    active = {(item['path'], item['device'], item['inode']) for item in policy['sources']}
    paths = {pin['path'] for pin in job['sources']}
    base = [pin for pin in job['sources']
            if paths == {pin['path'], pin['path'] + '-wal', pin['path'] + '-shm'}]
    require(len(base) == 1 and not base[0].get('absent'), 'database-policy-unbound')
    pin = base[0]
    require((pin['path'], str(pin['identity'][0]), str(pin['identity'][1])) in active,
            'source-policy-unbound')


def collect(job, check):
    admission_check(job, check)
    parent, sources, source_ids = source_state(job, check)
    # Refuse the unarmed production layout before opening the process inventory.
    validate_kernel_boundary(dict(parent=parent, sources=sources, processes=[], complete=True))
    names = [name for name in list_names('/proc', 32768, check) if name.isdigit()]
    require(len(names) <= 4096, 'process-budget')
    processes = []
    remaining = [100000]
    for pid in names:
        processes.extend(measure_process(pid, source_ids, job['processScopes'], check, remaining))
    require([name for name in list_names('/proc', 32768, check) if name.isdigit()] == names,
            'process-set-changed')
    after_parent, after_sources, after_ids = source_state(job, check)
    require((parent, sources, source_ids) == (after_parent, after_sources, after_ids), 'source-mutated')
    admission_check(job, check)
    return validate_kernel_boundary(dict(parent=parent, sources=sources,
                                         processes=processes, complete=True))


def run_collector_under_boundary(job, collector, check, terminal_empty):
    """Integration port for the pinned external lease adapter, not a proof signer.

    The caller holds the existing managed lease through child exit. Its
    terminal_empty argument is a descriptor-retaining ManagedUnitMonitor
    admitted before work. A caller-supplied boolean is not accepted.
    """
    check()
    before = collect(job, check)
    result = collector(check)
    check()
    require(isinstance(terminal_empty, ManagedUnitMonitor), 'managed-terminal-unresolved')
    terminal_empty.assert_terminal()
    check()
    after = collect(job, check)
    check()
    return dict(collectorResult=result,
                beforeSha256=hashlib.sha256(canonical(before)).hexdigest(),
                afterSha256=hashlib.sha256(canonical(after)).hexdigest(),
                signedProofsCreated=False, coordinatorEvidenceCreated=False)


def run_managed_collector(job, check, lease, expiry_module, expiry_sha256, argv, limits):
    """Outside-wrapper integration using the frozen expiry helper's real lease.

    The caller enters managed_verifier_lease before invoking this function and
    retains its context until return. No terminal callback, retired cgroup or
    absence is accepted as an exit proof. The returned digests are measurements,
    not authority signatures or a claim of complete operator/deploy inventory.
    """
    check()
    require(type(expiry_sha256) is str and re.fullmatch('[0-9a-f]{64}', expiry_sha256),
            'lease-helper-pin')
    raw = protected_read(os.path.realpath(expiry_module.__file__), 1024 * 1024, check)
    require(hashlib.sha256(raw).hexdigest() == expiry_sha256, 'lease-helper-pin')
    require(isinstance(lease, expiry_module.ManagedUnitLease)
            and lease.role == 'verifier' and not lease.started, 'lease-verifier-required')
    require(set(limits) == {'runtime_seconds', 'memory_max_bytes', 'tasks_max', 'cpu_quota_percent'},
            'lease-limits')
    validate_job(job)
    before = collect(job, check)
    # Publish once outside the capability-free child. This is a kernel access
    # measurement, not complete signed scope inventory. Request reuse refuses.
    census_record = dict(version=1, nonce=lease.record['nonce'], request_nonce=lease.request_nonce,
                         record_sha256=lease.record_hash, census_job_sha256=hashlib.sha256(canonical(job)).hexdigest(),
                         before=before)
    directory = expiry_module.invocation_directory(lease.control)
    try:
        expiry_module.write_control_file(directory, lease.request_nonce + '-verifier.census.json', canonical(census_record))
    finally:
        os.close(directory)
    launched = lease.start_approved_unit(argv, **limits)
    binding = lease.binding
    systemctl = lease.record['artifacts']['managed']['systemctl']
    monitor = ManagedUnitMonitor(dict(unitId=binding['unit'], invocationId=binding['invocation_id'],
                cgroupPath=binding['control_group'], cgroupIdentity=binding['identity'],
                systemctlPath=systemctl['path'], systemctlSha256=systemctl['sha256']), check)
    try:
        check()
        terminal = lease.wait_terminal_and_empty()
        monitor.assert_terminal()
        check()
        require(lease.complete and terminal['status'] == 'quiescent'
                and re.fullmatch('[0-9a-f]{64}', terminal['receipt_sha256']), 'lease-terminal-unresolved')
        # The helper creates/pins a private request directory before launching. Its
        # exact registered argv/config/credential authority and sandbox are checked
        # by start_approved_unit; do not widen ReadWritePaths here.
        receipt_path = launched['proof_receipt_path']
        require(receipt_path == lease.binding['policy']['receipt_directory'] + '/proof.json',
                'lease-receipt-scope')
        receipt = protected_read(receipt_path, 1024 * 1024, check, private=True)
        after = collect(job, check)
        check()
        receipt_value = json.loads(receipt)
        finalized = None
        if receipt_value.get('kind') == 'independent-snapshot-artifact-check':
            require(receipt == canonical(receipt_value) and receipt_value.get('signedProofsCreated') is False
                    and receipt_value.get('fenceEstablished') is False, 'snapshot-receipt')
            finalized = dict(receipt_value,
                             beforeCensusSha256=hashlib.sha256(canonical(before)).hexdigest(),
                             afterCensusSha256=hashlib.sha256(canonical(after)).hexdigest())
        return dict(version=1, unit=launched['unit'], invocationId=launched['invocation_id'],
                    terminalReceiptSha256=terminal['receipt_sha256'],
                    collectorReceiptSha256=hashlib.sha256(receipt).hexdigest(),
                    finalizedSnapshotMeasurement=finalized,
                    beforeSha256=hashlib.sha256(canonical(before)).hexdigest(),
                    afterSha256=hashlib.sha256(canonical(after)).hexdigest(),
                    signedProofsCreated=False, coordinatorEvidenceCreated=False,
                    completeScopeInventoryClaimed=False)
    
    finally:
        monitor.close()


def validate_job(job):
    fields = {'version', 'sourceDirectory', 'sourceDirectoryIdentity', 'sources', 'processScopes',
              'scopeKinds', 'admissionPolicySha256', 'admissionStateSha256', 'durationSeconds'}
    require(set(job) == fields and job['version'] == 1, 'job-schema')
    require(type(job['durationSeconds']) is int and 1 <= job['durationSeconds'] <= 1800, 'job-budget')
    require(type(job['sourceDirectory']) is str and os.path.isabs(job['sourceDirectory'])
            and os.path.normpath(job['sourceDirectory']) == job['sourceDirectory'], 'source-directory')
    require(1 <= len(job['sources']) <= 3 and 1 <= len(job['processScopes']) <= 256, 'scope-budget')
    require(set(job['scopeKinds']) == {'service', 'timer', 'bridge', 'cron', 'operator', 'deploy',
                                     'external-input'}, 'scope-kinds-incomplete')
    require(len(job['scopeKinds']) == 7, 'scope-duplicate')
    for name in ('admissionPolicySha256', 'admissionStateSha256'):
        require(re.fullmatch('[0-9a-f]{64}', job[name]) is not None, 'job-pin')
    paths = set()
    for source in job['sources']:
        require(set(source) in ({'path', 'identity'}, {'path', 'absent'})
                and type(source['path']) is str and os.path.normpath(source['path']) == source['path']
                and source['path'] not in paths, 'source-schema')
        paths.add(source['path'])
        if 'absent' in source:
            require(source['absent'] is True, 'absence-schema')
        else:
            require(len(source['identity']) == 2
                    and all(type(item) is int and item >= 0 for item in source['identity']), 'source-pin')
    # The namespace must include the database plus both possible SQLite sidecars.
    bases = [path for path in paths if paths == {path, path + '-wal', path + '-shm'}]
    require(len(bases) == 1, 'sidecar-scope-incomplete')
    require(len(job['sourceDirectoryIdentity']) == 2
            and all(type(item) is int and item >= 0 for item in job['sourceDirectoryIdentity']), 'parent-pin')
    cgroups = set()
    for scope in job['processScopes']:
        require(set(scope) == {'uid', 'exePath', 'exeSha256', 'cgroupPath', 'unitId',
                               'invocationId', 'cgroupIdentity', 'systemctlPath', 'systemctlSha256',
                               'argv', 'codePins'}
                and type(scope['uid']) is int and scope['uid'] >= 0
                and os.path.isabs(scope['exePath']) and os.path.normpath(scope['exePath']) == scope['exePath']
                and re.fullmatch('[0-9a-f]{64}', scope['exeSha256']) is not None
                and re.fullmatch('/[A-Za-z0-9_.@:/-]+', scope['cgroupPath']) is not None
                and os.path.normpath(scope['cgroupPath']) == scope['cgroupPath'], 'process-scope')
        require(re.fullmatch('[A-Za-z0-9_.@:-]+[.]service', scope['unitId']) is not None
                and re.fullmatch('[0-9a-f]{32}', scope['invocationId']) is not None
                and len(scope['cgroupIdentity']) == 2
                and all(type(item) is int and item >= 0 for item in scope['cgroupIdentity'])
                and os.path.isabs(scope['systemctlPath'])
                and re.fullmatch('[0-9a-f]{64}', scope['systemctlSha256']) is not None
                and type(scope['argv']) is list and 2 <= len(scope['argv']) <= 64
                and all(type(item) is str and len(item) <= 4096 for item in scope['argv'])
                and 1 <= len(scope['codePins']) <= 32, 'process-entry-scope')
        for pin in scope['codePins']:
            require(set(pin) == {'path', 'sha256'} and os.path.isabs(pin['path'])
                    and re.fullmatch('[0-9a-f]{64}', pin['sha256']) is not None, 'process-code-pin')
        require(any(pin['path'] in scope['argv'] for pin in scope['codePins']), 'process-entry-unpinned')
        key = (scope['uid'], scope['exePath'], scope['cgroupPath'])
        require(key not in cgroups, 'duplicate-process-scope')
        cgroups.add(key)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--job-sha256', required=True)
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated
            and sys.dont_write_bytecode, 'native-platform')
    deadline = Deadline(30)
    check = deadline.check
    raw = protected_read(args.job, 65536, check, private=True)
    require(hashlib.sha256(raw).hexdigest() == args.job_sha256, 'job-hash')
    job = json.loads(raw)
    require(raw == canonical(job), 'job-canonical')
    validate_job(job)
    # Do not restart the job budget after loading or after a census.
    deadline.clip(job['durationSeconds'])
    measurement = collect(job, check)
    check()
    print(json.dumps(dict(status='measured', jobSha256=args.job_sha256,
                          measurementSha256=hashlib.sha256(canonical(measurement)).hexdigest(),
                          sourceHandles=measurement['sourceHandles'],
                          processesMeasured=measurement['processesMeasured'],
                          signedProofsCreated=False, coordinatorEvidenceCreated=False), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Unknown scope details, paths, credentials and process metadata are never echoed.
        print('{"status":"refused","code":"KERNEL_BOUNDARY_UNRESOLVED"}')
        sys.exit(2)
