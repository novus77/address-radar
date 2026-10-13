#!/usr/bin/env python3
"""Dedicated address-only source fence; the importing parent retains the lock."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import time

SOURCE = '/var/lib/address-radar/address-radar.db'
SOURCE_DIRECTORY = '/var/lib/address-radar'
CONTROL = '/var/lib/address-radar-address-only-cutover'
MASK_DIRECTORY = '/etc/systemd/system'
RUNTIME_MASK_DIRECTORY = '/run/systemd/system'
BACKUP_DIRECTORY = '/var/backups/address-radar'
ROOT_UID = 0
ROOT_GID = 0
MAX_JOURNAL_BYTES = 256 * 1024
MAX_CONFIGURATION_BYTES = 64 * 1024
PHASES = ('PREPARED', 'WRITERS_BLOCKED', 'SOURCE_SEALED', 'BACKUP_DURABLE',
          'IMPORT_INTENT', 'IMPORT_COMMITTED', 'RESTORE_INTENT', 'RESTORED')
PROTECTED_UNITS = ('fomo-radar-collector.service', 'fomo-radar-login.service', 'fomo-radar-novnc.service')
WRITER_UNITS = tuple('address-radar-' + name + '.service' for name in
    ('scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console',
     'fomo-verification-sync', 'backup', 'migrate')) + (
    'fomo-address-radar-input-sync.service', 'fomo-address-radar-backup.service',
    'fomo-radar-protocol-audit.service', 'address-radar-backup.timer',
    'address-radar-fomo-verification-sync.timer', 'fomo-address-radar-backup.timer',
    'fomo-address-radar-input-sync.timer', 'fomo-radar-protocol-audit.timer')


def require(value, reason):
    if not value:
        raise ValueError(reason)


def required_backup_space(sizes):
    require(all(isinstance(size, int) and size >= 0 for size in sizes), 'invalid_source_sizes')
    return 2 * sum(sizes) + 3 * 1024**3


def validate_source_inventory(records):
    paths = [row['path'] for row in records]
    require(SOURCE in paths and len(paths) == len(set(paths))
            and set(paths).issubset({SOURCE, SOURCE + '-wal', SOURCE + '-shm'}), 'unexpected_source_inventory')
    for row in records:
        require(all(type(row[key]) is int and row[key] >= 0
                    for key in ('device', 'inode', 'size', 'uid', 'gid', 'mode')), 'invalid_source_metadata')
        require(row['mode'] <= 0o7777, 'invalid_source_metadata')


def assert_no_source_writers(handles):
    require(not any(row.get('writable') or row.get('mapped') for row in handles), 'source_writer_remains')


def require_uncommitted(check_import):
    result = check_import()
    require(isinstance(result, dict) and result.get('outcomeKnown') is True
            and result.get('importExists') is False and result.get('importerExcluded') is True
            and result.get('advisoryLockHeld') is True
            and callable(result.get('assert_alive_and_locked')), 'import_outcome_not_confirmed_absent')


class Deadline:
    def __init__(self, seconds=600):
        require(type(seconds) in (int, float) and 0 < seconds <= 600, 'invalid_deadline_budget')
        self.expires = time.monotonic() + seconds

    def check(self):
        require(time.monotonic() < self.expires, 'original_operation_deadline')

    def command(self, args):
        self.check()
        remaining = self.expires - time.monotonic()
        return subprocess.check_output(args, timeout=min(10, remaining), stderr=subprocess.DEVNULL,
                                       close_fds=True, stdin=subprocess.DEVNULL).decode()


def unit_state(unit, deadline):
    raw = deadline.command(['systemctl', 'show', unit, '-p', 'Id', '-p', 'ActiveState',
                            '-p', 'SubState', '-p', 'MainPID', '-p', 'InvocationID', '-p', 'LoadState',
                            '-p', 'UnitFileState', '-p', 'FragmentPath', '-p', 'Names',
                            '-p', 'TriggeredBy', '-p', 'Job', '-p', 'User', '-p', 'Group',
                            '-p', 'RequiredBy', '-p', 'BoundBy', '-p', 'ConsistsOf', '-p', 'PropagatesStopTo',
                            '-p', 'DropInPaths'])
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def protected_identities(deadline):
    return {unit: unit_state(unit, deadline) for unit in PROTECTED_UNITS}


def inventory():
    records = []
    for path in (SOURCE, SOURCE + '-wal', SOURCE + '-shm'):
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            continue
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'unsafe_source_file')
        records.append({'path': path, 'device': info.st_dev, 'inode': info.st_ino,
                        'size': info.st_size, 'uid': info.st_uid, 'gid': info.st_gid,
                        'mode': stat.S_IMODE(info.st_mode), 'mtimeNs': info.st_mtime_ns})
    validate_source_inventory(records)
    return records


def protected_parent(path):
    for parent in Path(path).parents:
        value = os.lstat(parent)
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == ROOT_UID
                and not value.st_mode & 0o022, 'unprotected_ancestor')


def source_handles(records, deadline):
    identities = {(row['device'], row['inode']) for row in records}
    pids = [name for name in os.listdir('/proc') if name.isdecimal()]
    require(len(pids) <= 4096, 'process_budget')
    result, inspected = [], 0
    for pid in pids:
        deadline.check()
        directory = '/proc/' + pid + '/fd'
        try:
            descriptors = os.listdir(directory)
            require(len(descriptors) <= 8192, 'process_fd_budget')
            for descriptor in descriptors:
                deadline.check()
                inspected += 1
                require(inspected <= 100000, 'total_fd_budget')
                try:
                    info = os.stat(directory + '/' + descriptor)
                    if (info.st_dev, info.st_ino) not in identities:
                        continue
                    with open('/proc/' + pid + '/fdinfo/' + descriptor) as file:
                        values = dict(line.strip().split(':', 1) for line in file if ':' in line)
                    flags = int(values['flags'].strip(), 8)
                    result.append({'pid': int(pid), 'writable': bool(flags & os.O_ACCMODE), 'mapped': False})
                except FileNotFoundError:
                    continue
            with open('/proc/' + pid + '/maps') as file:
                text = file.read(4 * 1024 * 1024 + 1)
            require(len(text) <= 4 * 1024 * 1024, 'maps_budget')
            for line in text.splitlines():
                parts = line.split(None, 5)
                if len(parts) < 5:
                    continue
                major, minor = (int(part, 16) for part in parts[3].split(':'))
                if (os.makedev(major, minor), int(parts[4])) in identities:
                    result.append({'pid': int(pid), 'writable': 'w' in parts[1], 'mapped': True})
        except FileNotFoundError:
            # A vanished process has closed its descriptors; sealed paths prevent new non-root opens.
            continue
    return result


def preflight(deadline):
    require(sys.platform == 'linux' and os.geteuid() == ROOT_UID, 'native_root_required')
    protected_parent(SOURCE_DIRECTORY)
    directory = os.lstat(SOURCE_DIRECTORY)
    require(stat.S_ISDIR(directory.st_mode) and not directory.st_mode & 0o022, 'unsafe_source_directory')
    records = inventory()
    space = os.statvfs(BACKUP_DIRECTORY)
    free = space.f_bavail * space.f_frsize
    require(free >= required_backup_space([row['size'] for row in records]), 'insufficient_backup_space')
    return {'sourceFiles': records, 'sourceDirectory': {'uid': directory.st_uid, 'gid': directory.st_gid,
            'mode': stat.S_IMODE(directory.st_mode), 'device': directory.st_dev, 'inode': directory.st_ino},
            'writerStates': {unit: unit_state(unit, deadline) for unit in WRITER_UNITS},
            'protectedProcesses': protected_identities(deadline), 'diskFreeBytes': free}


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_directory(path, create=False):
    protected_parent(path)
    if create and not os.path.lexists(path):
        os.mkdir(path, 0o700)
        sync_directory(str(Path(path).parent))
    value = os.lstat(path)
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == ROOT_UID
            and stat.S_IMODE(value.st_mode) == 0o700, 'unsafe_private_directory')


def private_file(value):
    require(stat.S_ISREG(value.st_mode) and value.st_uid == ROOT_UID and value.st_nlink == 1
            and stat.S_IMODE(value.st_mode) == 0o600, 'unsafe_private_file')


def validate_binding(binding, operation_id, allow_unbound=False):
    require(isinstance(binding, dict) and set(binding) ==
            {'operationId', 'importId', 'generationId', 'planSha256', 'target'}, 'invalid_import_binding')
    require(binding['operationId'] == operation_id and
            all(isinstance(binding[key], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', binding[key])
                for key in ('importId', 'generationId')),
            'invalid_import_binding')
    plan = binding['planSha256']
    require(plan is not None or allow_unbound, 'import_plan_not_bound')
    require((plan is None and allow_unbound) or
            (isinstance(plan, str) and re.fullmatch(r'[a-f0-9]{64}', plan)), 'invalid_import_binding')
    target = binding['target']
    require(isinstance(target, dict) and set(target) ==
            {'database', 'schema', 'schemaFingerprint', 'systemIdentifier', 'serverAddress', 'serverPort'},
            'invalid_import_target')
    require(all(isinstance(target[key], str) and re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', target[key])
                for key in ('database', 'schema')) and target['schema'] not in ('public', 'information_schema')
            and not target['schema'].startswith('pg_')
            and isinstance(target['schemaFingerprint'], str) and re.fullmatch(r'[a-f0-9]{64}', target['schemaFingerprint'])
            and isinstance(target['systemIdentifier'], str) and re.fullmatch(r'[1-9][0-9]{0,19}', target['systemIdentifier'])
            and int(target['systemIdentifier']) <= 18446744073709551615
            and target['serverAddress'] == '127.0.0.1' and target['serverPort'] == 5432, 'invalid_import_target')


class Journal:
    """A torn update leaves either the prior state or its durable write-ahead intent."""
    def __init__(self):
        self.path = CONTROL + '/journal.json'

    def read(self):
        if not os.path.lexists(self.path):
            return None
        fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            private_file(os.fstat(fd))
            with os.fdopen(fd, 'rb', closefd=False) as file:
                body = file.read(MAX_JOURNAL_BYTES + 1)
            require(len(body) <= MAX_JOURNAL_BYTES, 'journal_budget')
            value = json.loads(body)
            require(isinstance(value, dict) and value.get('protocol') == 'address-only-v1'
                    and value.get('phase') in PHASES, 'invalid_journal')
            return value
        finally:
            os.close(fd)

    def write(self, state):
        body = json.dumps(state, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')
        require(len(body) <= MAX_JOURNAL_BYTES, 'journal_budget')
        # One bounded scratch file; validate before truncating an interrupted update.
        temporary = CONTROL + '/journal.next'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            private_file(os.fstat(fd))
            os.ftruncate(fd, 0)
            with os.fdopen(fd, 'wb', closefd=False) as file:
                file.write(body)
                file.flush()
                os.fsync(fd)
            os.replace(temporary, self.path)
            sync_directory(CONTROL)
        finally:
            os.close(fd)


def copy_sealed_file(row, destination, deadline):
    fd = os.open(row['path'], os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (row['device'], row['inode'], row['size'], row['mtimeNs'])
                and before.st_uid == ROOT_UID and stat.S_IMODE(before.st_mode) == 0o400, 'sealed_source_changed')
        output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(output, 'wb', closefd=False) as file:
                remaining = row['size']
                while remaining:
                    deadline.check()
                    chunk = os.read(fd, min(65536, remaining))
                    require(chunk, 'source_short_read')
                    file.write(chunk)
                    remaining -= len(chunk)
                file.flush()
                os.fsync(output)
            after = os.fstat(fd)
            require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'source_changed_during_copy')
        finally:
            os.close(output)
    finally:
        os.close(fd)


def file_stamp(path):
    value = os.lstat(path)
    require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1, 'measurement_unsafe_file')
    return {'path': path, 'device': value.st_dev, 'inode': value.st_ino, 'size': value.st_size,
            'uid': value.st_uid, 'gid': value.st_gid, 'mode': stat.S_IMODE(value.st_mode),
            'mtimeNs': value.st_mtime_ns, 'ctimeNs': value.st_ctime_ns}


def directory_stamp(path):
    value = os.lstat(path)
    require(stat.S_ISDIR(value.st_mode), 'measurement_unsafe_directory')
    return {'path': path, 'device': value.st_dev, 'inode': value.st_ino,
            'uid': value.st_uid, 'gid': value.st_gid, 'mode': stat.S_IMODE(value.st_mode)}


def measurement_digest(measurement):
    body = json.dumps(measurement, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')
    require(len(body) <= MAX_JOURNAL_BYTES, 'journal_budget')
    return hashlib.sha256(body).hexdigest()


def configuration_stamp(path, linked=False):
    protected_parent(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == ROOT_UID
                and before.st_nlink in ((1, 2) if linked else (1,))
                and not before.st_mode & 0o022 and before.st_size <= MAX_CONFIGURATION_BYTES,
                'unsafe_unit_configuration')
        with os.fdopen(fd, 'rb', closefd=False) as file:
            body = file.read(MAX_CONFIGURATION_BYTES + 1)
        after = os.fstat(fd)
        require(len(body) <= MAX_CONFIGURATION_BYTES
                and (before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'unit_configuration_changed')
        return {'path': path, 'device': before.st_dev, 'inode': before.st_ino, 'size': before.st_size,
                'uid': before.st_uid, 'gid': before.st_gid, 'mode': stat.S_IMODE(before.st_mode),
                'mtimeNs': before.st_mtime_ns, 'ctimeNs': before.st_ctime_ns,
                'sha256': hashlib.sha256(body).hexdigest()}
    finally:
        os.close(fd)


def create_private_content(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(fd, ROOT_UID, ROOT_GID)
        with os.fdopen(fd, 'wb', closefd=False) as file:
            file.write(body)
            file.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(str(Path(path).parent))


class NativeSourceFence:
    """The native parent owns the local lock; no subprocess inherits it.

    Reconciliation is a trusted context-manager port, not a readiness boolean.
    It must exclude all importers, hold the operation's PostgreSQL advisory lock,
    probe the exact target, and query its actual ledger AFTER acquiring that lock.
    Both exclusions must remain held until the context exits, including rollback.
    Root jobs outside the reviewed unit inventory must be excluded by the native
    controller; DAC and a /proc scan cannot fence an arbitrary future root writer.
    """
    def __init__(self, operation_id, deadline, *, import_binding):
        self._lock_control(deadline)
        try:
            previous = self.journal.read()
            require(previous is None or previous['phase'] == 'RESTORED', 'unresolved_journal')
            require(isinstance(operation_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,96}', operation_id),
                    'invalid_operation_id')
            validate_binding(import_binding, operation_id, allow_unbound=True)
            require(not os.path.lexists(CONTROL + '/restored-' + operation_id + '.json'), 'operation_id_reused')
            if previous:
                require(previous['operationId'] != operation_id, 'operation_id_reused')
                archived = CONTROL + '/restored-' + previous['operationId'] + '.json'
                require(not os.path.lexists(archived), 'operation_id_reused')
                os.rename(self.journal.path, archived)
                sync_directory(CONTROL)
            self.operation_id = operation_id
            self.prepared = preflight(deadline)
            guards = self._validate_restart_exclusion()
            self.state = {'protocol': 'address-only-v1', 'operationId': operation_id, 'phase': 'PREPARED',
                          'binding': json.loads(json.dumps(import_binding)), 'prepared': self.prepared,
                          'sources': [], 'masks': {}, 'guards': guards, 'sentinel': None,
                          'pending': None, 'backup': None, 'measurement': None}
            self.journal.write(self.state)
        except BaseException:
            self.close()
            raise

    def _lock_control(self, deadline):
        require(sys.platform == 'linux' and os.geteuid() == ROOT_UID, 'native_root_required')
        self.deadline = deadline
        self.lock = None
        private_directory(CONTROL, create=True)
        fd = os.open(CONTROL + '/controller.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            private_file(os.fstat(fd))
            os.set_inheritable(fd, False)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.lock = fd
            os.fsync(fd)
            sync_directory(CONTROL)
        except BaseException:
            os.close(fd)
            raise
        self.journal = Journal()

    @classmethod
    def recover(cls, deadline):
        self = cls.__new__(cls)
        self._lock_control(deadline)
        try:
            self.state = self.journal.read()
            require(self.state is not None and self.state['phase'] != 'RESTORED', 'no_unresolved_journal')
            require(set(self.state) == {'protocol', 'operationId', 'phase', 'binding', 'prepared',
                                       'sources', 'masks', 'guards', 'sentinel', 'pending', 'backup', 'measurement'}, 'invalid_journal')
            self.operation_id = self.state['operationId']
            require(re.fullmatch(r'[A-Za-z0-9_-]{1,96}', self.operation_id), 'invalid_journal')
            validate_binding(self.state['binding'], self.operation_id,
                             allow_unbound=self.state['phase'] not in ('IMPORT_INTENT', 'IMPORT_COMMITTED'))
            self.prepared = self.state['prepared']
            validate_source_inventory(self.prepared['sourceFiles'])
            if self.state['sources']:
                validate_source_inventory(self.state['sources'])
            require(set(self.prepared['writerStates']) == set(WRITER_UNITS)
                    and set(self.state['masks']).issubset(WRITER_UNITS)
                    and set(self.state['guards']).issubset(WRITER_UNITS)
                    and set(self.state['masks']).isdisjoint(self.state['guards']), 'journal_unit_inventory_changed')
            original = self.prepared['sourceDirectory']
            require(set(original) == {'uid', 'gid', 'mode', 'device', 'inode'}
                    and all(type(value) is int and value >= 0 for value in original.values())
                    and original['mode'] <= 0o7777, 'invalid_journal')
            for record in self.state['masks'].values():
                require(isinstance(record, dict) and set(record) == {'device', 'inode'}
                        and all(type(value) is int and value >= 0 for value in record.values()), 'invalid_journal')
            return self
        except BaseException:
            self.close()
            raise

    def _save(self, phase=None, pending=None):
        self.deadline.check()
        self._check_recovery_guard()
        if phase:
            self.state['phase'] = phase
        self.state['pending'] = pending
        self.journal.write(self.state)

    def _action(self, kind, subject, action):
        self._save(pending={'kind': kind, 'subject': subject})
        self._check_recovery_guard()
        action()
        self._save()

    def _check_recovery_guard(self):
        guard = getattr(self, '_recovery_assertion', None)
        if guard is None:
            return
        self.deadline.check()
        proof = guard()
        require(isinstance(proof, dict) and proof.get('lockHeld') is True
                and proof.get('idleTimeout') == '0' and proof.get('isolation') == 'read committed'
                and proof.get('readOnly') == 'on' and type(proof.get('importerSessions')) is int
                and proof['importerSessions'] == 0 and type(proof.get('backendPid')) is int
                and proof['backendPid'] > 0 and isinstance(proof.get('transactionStartedAt'), str)
                and 0 < len(proof['transactionStartedAt']) <= 128, 'recovery_live_lock_proof_required')
        identity = (proof['backendPid'], proof['transactionStartedAt'])
        previous = getattr(self, '_recovery_lock_identity', None)
        require(previous is None or previous == identity, 'recovery_live_lock_connection_changed')
        self._recovery_lock_identity = identity
        self.deadline.check()

    @contextlib.contextmanager
    def _recovery_guard(self, result):
        guard = result.get('assert_alive_and_locked')
        require(callable(guard), 'recovery_live_lock_guard_required')
        require(getattr(self, '_recovery_assertion', None) is None, 'recovery_guard_already_active')
        self._recovery_assertion, self._recovery_lock_identity = guard, None
        try:
            self._check_recovery_guard()
            yield
        finally:
            self._recovery_assertion, self._recovery_lock_identity = None, None

    def assert_protected_unchanged(self):
        require(protected_identities(self.deadline) == self.prepared['protectedProcesses'], 'fomo_process_changed')

    @staticmethod
    def _is_mask(path):
        return (os.path.islink(path) and os.lstat(path).st_uid == ROOT_UID
                and os.readlink(path) == '/dev/null')

    def _validate_restart_exclusion(self):
        require(set(PROTECTED_UNITS).isdisjoint(WRITER_UNITS), 'protected_writer_overlap')
        protected_parent(MASK_DIRECTORY + '/placeholder')
        guards = {}
        needs_mask = False
        for unit, state in self.prepared['writerStates'].items():
            path = MASK_DIRECTORY + '/' + unit
            require(not os.path.lexists(RUNTIME_MASK_DIRECTORY + '/' + unit), 'unsupported_restart_mask')
            local = state.get('FragmentPath') == path and not self._is_mask(path)
            require(not os.path.lexists(path) or self._is_mask(path) or local, 'unsupported_restart_mask')
            require(state.get('Id') == unit and state.get('LoadState') in ('loaded', 'masked', 'not-found')
                    and state.get('ActiveState') in ('active', 'inactive', 'failed')
                    and not state.get('Job', '').strip()
                    and set(state.get('Names', unit).split()).issubset({unit})
                    and set(state.get('TriggeredBy', '').split()).issubset(WRITER_UNITS)
                    and state.get('UnitFileState', '') in ('enabled', 'disabled', 'static', 'indirect', 'masked', ''),
                    'unsupported_restart_mask')
            # Local fragments stay in place and receive an independently owned drop-in.
            fragment = state.get('FragmentPath', '')
            require(local or not fragment or fragment == '/dev/null' or
                    fragment in ('/usr/lib/systemd/system/' + unit, '/lib/systemd/system/' + unit),
                    'unsupported_restart_mask')
            require(all(set(state.get(key, '').split()).issubset(WRITER_UNITS)
                        for key in ('RequiredBy', 'BoundBy', 'ConsistsOf', 'PropagatesStopTo')),
                    'unsupported_stop_propagation')
            if local:
                guards[unit] = self._snapshot_guard(unit, state)
            elif not self._is_mask(path):
                needs_mask = True
        if needs_mask:
            require(os.stat(MASK_DIRECTORY).st_dev == os.stat(CONTROL).st_dev, 'unsupported_restart_mask_filesystem')
        return guards

    def _guard_name(self):
        return 'zzzz-address-only-' + self.operation_id + '.conf'

    def _guard_path(self, unit):
        return MASK_DIRECTORY + '/' + unit + '.d/' + self._guard_name()

    def _guard_anchor(self, unit):
        return MASK_DIRECTORY + '/.address-only-' + self.operation_id + '-' + unit + '.guard-anchor'

    def _guard_body(self):
        return ('[Unit]\nConditionPathExists=!' + CONTROL + '/restart-blocked-' + self.operation_id + '\n').encode('ascii')

    def _snapshot_guard(self, unit, state):
        fragment = configuration_stamp(MASK_DIRECTORY + '/' + unit)
        directory = MASK_DIRECTORY + '/' + unit + '.d'
        original_directory, entries = None, []
        if os.path.lexists(directory):
            protected_parent(directory + '/placeholder')
            original_directory = directory_stamp(directory)
            entries = sorted(os.listdir(directory))
            require(len(entries) <= 128, 'unit_dropin_budget')
            require(all(name < self._guard_name() for name in entries if name.endswith('.conf')),
                    'unsupported_restart_guard_order')
        paths = state.get('DropInPaths', '').split()
        require(len(paths) <= 64 and len(paths) == len(set(paths)), 'unit_dropin_budget')
        originals = {}
        for path in paths:
            self.deadline.check()
            require(path.startswith(('/etc/systemd/system/', '/usr/lib/systemd/system/', '/lib/systemd/system/',
                                     MASK_DIRECTORY + '/')) and path.endswith('.conf'), 'unsupported_restart_guard_path')
            require(Path(path).name < self._guard_name(), 'unsupported_restart_guard_order')
            originals[path] = configuration_stamp(path)
        # Also pin local files hidden by an effective drop-in of the same name elsewhere.
        for name in entries:
            if name.endswith('.conf'):
                self.deadline.check()
                originals[directory + '/' + name] = configuration_stamp(directory + '/' + name)
        return {'fragment': fragment, 'originalDropins': originals, 'effectiveDropins': sorted(paths),
                'originalDirectory': original_directory, 'originalEntries': entries,
                'createdDirectory': None, 'identity': None}

    def _controller_guard_entries(self, unit):
        # Only the pinned source-replacement subclass supplies a live owner-bound guard.
        return ()

    def _verify_guard_originals(self, unit):
        record = self.state['guards'][unit]
        require(configuration_stamp(MASK_DIRECTORY + '/' + unit) == record['fragment'], 'restart_original_changed')
        for path, expected in record['originalDropins'].items():
            self.deadline.check()
            require(configuration_stamp(path) == expected, 'restart_original_changed')
        directory = MASK_DIRECTORY + '/' + unit + '.d'
        if os.path.lexists(directory):
            protected_parent(directory + '/placeholder')
            actual = directory_stamp(directory)
            expected = record['originalDirectory'] or record['createdDirectory']
            require(expected is None or actual == expected, 'restart_guard_directory_replaced')
            entries = set(os.listdir(directory))
            additional = tuple(self._controller_guard_entries(unit))
            require(additional in ((), ('zzzzzz-address-radar-pg-source-fence.conf',)),
                    'invalid_controller_guard')
            require(len(entries) <= 129 + len(additional)
                    and entries - {self._guard_name()} - set(additional) == set(record['originalEntries']),
                    'restart_original_changed')
        else:
            require(record['originalDirectory'] is None, 'restart_original_changed')

    def _assert_sentinel(self):
        sentinel = self.state['sentinel']
        require(isinstance(sentinel, dict) and sentinel.get('path') ==
                CONTROL + '/restart-blocked-' + self.operation_id, 'restart_sentinel_changed')
        try:
            actual = file_stamp(sentinel['path'])
        except FileNotFoundError:
            raise ValueError('restart_sentinel_changed') from None
        require(actual == sentinel and actual['uid'] == ROOT_UID and actual['mode'] == 0o600,
                'restart_sentinel_changed')

    def _owned_guard(self, unit):
        self._verify_guard_originals(unit)
        path = self._guard_path(unit)
        if not os.path.lexists(path):
            return False
        stamp = configuration_stamp(path, linked=True)
        identity = self.state['guards'][unit]['identity']
        require(identity is not None and (stamp['device'], stamp['inode']) ==
                (identity['device'], identity['inode']) and stamp['mode'] == 0o600
                and stamp['sha256'] == hashlib.sha256(self._guard_body()).hexdigest(), 'restart_guard_replaced')
        return True

    def _ensure_guard_directory(self, unit):
        directory = MASK_DIRECTORY + '/' + unit + '.d'
        if not os.path.lexists(directory):
            require(self.state['guards'][unit]['originalDirectory'] is None, 'restart_original_changed')
            def create():
                os.mkdir(directory, 0o755)
                sync_directory(MASK_DIRECTORY)
                self.state['guards'][unit]['createdDirectory'] = directory_stamp(directory)
            self._action('guard_directory', unit, create)

    def _prepare_guard(self, unit):
        self._verify_guard_originals(unit)
        self._ensure_guard_directory(unit)
        anchor = self._guard_anchor(unit)
        def create():
            create_private_content(anchor, self._guard_body())
            info = os.lstat(anchor)
            self.state['guards'][unit]['identity'] = {'device': info.st_dev, 'inode': info.st_ino}
        self._action('guard_anchor', unit, create)
        self._action('guard', unit, lambda: self._install_mask(anchor, self._guard_path(unit)))
        sync_directory(MASK_DIRECTORY + '/' + unit + '.d')

    def _reinstall_guard(self, unit):
        self._assert_sentinel()
        if not self._owned_guard(unit):
            self._ensure_guard_directory(unit)
            anchor = self._guard_anchor(unit)
            stamp = configuration_stamp(anchor, linked=True)
            identity = self.state['guards'][unit]['identity']
            require(identity is not None and (stamp['device'], stamp['inode']) ==
                    (identity['device'], identity['inode'])
                    and stamp['sha256'] == hashlib.sha256(self._guard_body()).hexdigest(), 'restart_guard_anchor_replaced')
            self._action('guard', unit, lambda: self._install_mask(anchor, self._guard_path(unit)))
            sync_directory(MASK_DIRECTORY + '/' + unit + '.d')

    def _remove_guard(self, unit):
        path = self._guard_path(unit)
        if self._owned_guard(unit):
            def remove():
                os.unlink(path)
                sync_directory(str(Path(path).parent))
            self._action('unguard', unit, remove)
        record = self.state['guards'][unit]
        directory = MASK_DIRECTORY + '/' + unit + '.d'
        if record['originalDirectory'] is None and record['createdDirectory'] is not None and os.path.lexists(directory):
            require(directory_stamp(directory) == record['createdDirectory'] and not os.listdir(directory),
                    'restart_guard_directory_replaced')
            def remove_directory():
                os.rmdir(directory)
                sync_directory(MASK_DIRECTORY)
                record['createdDirectory'] = None
            self._action('unguard_directory', unit, remove_directory)

    def _cleanup_guard_anchors(self):
        # These are inert once RESTORED is durable; they are never needed for replay again.
        require(self.state['phase'] == 'RESTORED', 'invalid_restore_phase')
        for unit, record in self.state['guards'].items():
            self.deadline.check()
            anchor = self._guard_anchor(unit)
            if record['identity'] is None or not os.path.lexists(anchor):
                continue
            stamp = configuration_stamp(anchor)
            require((stamp['device'], stamp['inode']) ==
                    (record['identity']['device'], record['identity']['inode'])
                    and stamp['sha256'] == hashlib.sha256(self._guard_body()).hexdigest(), 'restart_guard_anchor_replaced')
            self._check_recovery_guard()
            os.unlink(anchor)
            sync_directory(MASK_DIRECTORY)

    def _ordered_units(self, timers_first=True):
        return sorted(WRITER_UNITS, key=lambda unit: (unit.endswith('.timer') != timers_first, unit))

    def _owned_mask(self, unit):
        record = self.state['masks'][unit]
        path = MASK_DIRECTORY + '/' + unit
        if not os.path.lexists(path):
            return False
        info = os.lstat(path)
        require(self._is_mask(path) and (info.st_dev, info.st_ino) ==
                (record['device'], record['inode']), 'restart_mask_replaced')
        return True

    def _install_mask(self, anchor, path):
        self._check_recovery_guard()
        os.link(anchor, path, follow_symlinks=False)
        sync_directory(str(Path(path).parent))

    def _remove_mask(self, path):
        self._check_recovery_guard()
        os.unlink(path)
        sync_directory(MASK_DIRECTORY)

    def stop_writers(self):
        self._require_controller()
        require(self.state['phase'] == 'PREPARED' and self.state['pending'] is None, 'invalid_fence_phase')
        self.assert_protected_unchanged()
        self._validate_restart_exclusion()
        if self.state['guards']:
            sentinel = CONTROL + '/restart-blocked-' + self.operation_id
            def create_sentinel():
                create_private_content(sentinel, b'address-only-v1\n')
                self.state['sentinel'] = file_stamp(sentinel)
            self._action('sentinel', self.operation_id, create_sentinel)
        anchors = CONTROL + '/mask-anchors'
        private_directory(anchors, create=True)
        for unit in self._ordered_units():
            if unit in self.state['guards']:
                self._prepare_guard(unit)
                continue
            path = MASK_DIRECTORY + '/' + unit
            if self._is_mask(path):
                continue
            anchor = anchors + '/' + self.operation_id + '-' + unit
            os.symlink('/dev/null', anchor)
            sync_directory(anchors)
            info = os.lstat(anchor)
            self.state['masks'][unit] = {'device': info.st_dev, 'inode': info.st_ino}
            # The durable anchor identifies OUR mask even if the process dies before acknowledgement.
            self._action('mask', unit, lambda: self._install_mask(anchor, path))
        self._action('reload', 'systemd', lambda: self.deadline.command(['systemctl', 'daemon-reload']))
        for unit in self._ordered_units():
            self._action('stop', unit, lambda: self.deadline.command(['systemctl', 'stop', '--no-block', unit]))
            self._wait_unit(unit, running=False)
        self._assert_writers_blocked()
        self.assert_protected_unchanged()
        self._save('WRITERS_BLOCKED')

    def _wait_unit(self, unit, running):
        while True:
            self.deadline.check()
            self._check_recovery_guard()
            state = unit_state(unit, self.deadline)
            self._check_recovery_guard()
            if running and state.get('ActiveState') == 'active':
                return
            if not running and state.get('ActiveState') in ('inactive', 'failed') and not state.get('Job', '').strip():
                return
            time.sleep(0.05)

    def _assert_writers_blocked(self):
        if self.state['guards']:
            self._assert_sentinel()
        for unit in WRITER_UNITS:
            if unit in self.state['guards']:
                require(self._owned_guard(unit), 'restart_guard_missing')
            else:
                require(self._owned_mask(unit) if unit in self.state['masks'] else
                        self._is_mask(MASK_DIRECTORY + '/' + unit), 'writer_mask_missing')
            state = unit_state(unit, self.deadline)
            if unit in self.state['guards']:
                expected = self.state['guards'][unit]['effectiveDropins'] + [self._guard_path(unit)]
                expected += [MASK_DIRECTORY + '/' + unit + '.d/' + name
                             for name in self._controller_guard_entries(unit)]
                require(sorted(state.get('DropInPaths', '').split()) == sorted(expected)
                        and state.get('FragmentPath') == MASK_DIRECTORY + '/' + unit,
                        'restart_guard_not_effective')
            require(state.get('ActiveState') in ('inactive', 'failed') and not state.get('Job', '').strip(),
                    'writer_reactivated')

    def _exclusion_measurement(self):
        guards = {}
        for unit, record in self.state['guards'].items():
            require(self._owned_guard(unit), 'restart_guard_missing')
            guards[unit] = {'guard': configuration_stamp(self._guard_path(unit), linked=True),
                            'fragment': record['fragment'], 'originalDropins': record['originalDropins']}
        if guards:
            self._assert_sentinel()
        return json.loads(json.dumps({'guards': guards, 'sentinel': self.state['sentinel'],
                                     'masks': self.state['masks']}))

    def _reinstate_restore_exclusion(self):
        # Rollback may have crashed after unmasking. Reuse only our durable anchor,
        # never replace an administrator's unit or another inode's /dev/null mask.
        anchors = CONTROL + '/mask-anchors'
        if self.state['masks']:
            private_directory(anchors)
        for unit in self.state['guards']:
            self._reinstall_guard(unit)
        for unit in self.state['masks']:
            if not self._owned_mask(unit):
                anchor = anchors + '/' + self.operation_id + '-' + unit
                info = os.lstat(anchor)
                record = self.state['masks'][unit]
                require(self._is_mask(anchor) and (info.st_dev, info.st_ino) ==
                        (record['device'], record['inode']), 'restart_mask_anchor_replaced')
                self._action('mask', unit,
                             lambda: self._install_mask(anchor, MASK_DIRECTORY + '/' + unit))
        self._action('reload', 'systemd', lambda: self.deadline.command(['systemctl', 'daemon-reload']))
        for unit in self._ordered_units():
            self._action('stop', unit, lambda: self.deadline.command(['systemctl', 'stop', '--no-block', unit]))
            self._wait_unit(unit, running=False)
        self._assert_writers_blocked()

    def _verify_source_identities(self, restoring=False):
        prefix = 'restore_' if restoring else 'seal_'
        original = self.prepared['sourceDirectory']
        info = os.lstat(SOURCE_DIRECTORY)
        require(stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) ==
                (original['device'], original['inode']), prefix + 'parent_replaced')
        actual = inventory()
        if not self.state['sources']:
            # Before the final inventory is journaled, stop/checkpoint may remove sidecars.
            # No source permissions have been changed in this phase.
            original_db = next(row for row in self.prepared['sourceFiles'] if row['path'] == SOURCE)
            current_db = next(row for row in actual if row['path'] == SOURCE)
            require((original_db['device'], original_db['inode']) ==
                    (current_db['device'], current_db['inode']), prefix + 'source_replaced')
            originals = {row['path']: row for row in self.prepared['sourceFiles']}
            for row in actual:
                if row['path'] in originals:
                    old = originals[row['path']]
                    require((row['device'], row['inode']) == (old['device'], old['inode']), prefix + 'source_replaced')
            return []
        expected = self.state['sources']
        require({row['path'] for row in actual} == {row['path'] for row in expected}, prefix + 'inventory_changed')
        by_path = {row['path']: row for row in actual}
        for row in expected:
            found = by_path[row['path']]
            require((found['device'], found['inode']) == (row['device'], row['inode']), prefix + 'source_replaced')
        return expected

    def _permissions(self, path, uid, gid, mode, directory=False):
        self.deadline.check()
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else 0))
        try:
            expected = self.prepared['sourceDirectory'] if directory else next(
                row for row in self.state['sources'] if row['path'] == path)
            info = os.fstat(fd)
            require((info.st_dev, info.st_ino) == (expected['device'], expected['inode'])
                    and (stat.S_ISDIR(info.st_mode) if directory else
                         stat.S_ISREG(info.st_mode) and info.st_nlink == 1), 'permission_target_replaced')
            self._check_recovery_guard()
            os.fchown(fd, uid, gid)
            self._check_recovery_guard()
            os.fchmod(fd, mode)
            self._check_recovery_guard()
            os.fsync(fd)
        finally:
            os.close(fd)

    def backup_and_seal(self):
        self._require_controller()
        require(self.state['phase'] == 'WRITERS_BLOCKED' and self.state['pending'] is None, 'writers_not_stopped')
        self._assert_writers_blocked()
        self.assert_protected_unchanged()
        records = inventory()
        original = next(row for row in self.prepared['sourceFiles'] if row['path'] == SOURCE)
        current = next(row for row in records if row['path'] == SOURCE)
        require((original['device'], original['inode']) == (current['device'], current['inode']), 'source_replaced')
        self.state['sources'] = records
        self._save()
        self._action('seal_directory', SOURCE_DIRECTORY,
                     lambda: self._permissions(SOURCE_DIRECTORY, ROOT_UID, ROOT_GID, 0o755, directory=True))
        self._verify_source_identities()
        for row in records:
            self._action('seal_file', row['path'],
                         lambda: self._permissions(row['path'], ROOT_UID, ROOT_GID, 0o400))
        assert_no_source_writers(source_handles(records, self.deadline))
        self._verify_source_identities()
        self._assert_writers_blocked()
        self.assert_protected_unchanged()
        self._save('SOURCE_SEALED')
        free = os.statvfs(BACKUP_DIRECTORY)
        require(free.f_bavail * free.f_frsize >= required_backup_space([row['size'] for row in records]),
                'insufficient_backup_space')
        backup_dir = BACKUP_DIRECTORY + '/address-only-' + self.operation_id
        protected_parent(backup_dir)
        self._action('backup_directory', backup_dir, lambda: private_directory(backup_dir, create=True))
        staging = backup_dir + '/staging'
        private_directory(staging, create=True)
        for row in records:
            if row['path'] != SOURCE + '-shm':
                copy_sealed_file(row, staging + '/source.db' + row['path'][len(SOURCE):], self.deadline)
        sync_directory(staging)
        backup = backup_dir + '/source.sqlite'
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        # Only the private disposable copy is writable. SQLite rebuilds SHM and reads committed WAL.
        with contextlib.ExitStack() as connections:
            self.deadline.check()
            source = connections.enter_context(contextlib.closing(sqlite3.connect(staging + '/source.db', timeout=1)))
            source.set_progress_handler(lambda: int(time.monotonic() >= self.deadline.expires), 1000)
            # Recover WAL into the disposable DB before allocating the second complete copy.
            require(source.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0] == 0,
                    'staging_checkpoint_failed')
            self.deadline.check()
            target = connections.enter_context(contextlib.closing(sqlite3.connect(backup, timeout=1)))
            source.backup(target, pages=128, progress=lambda *_: self.deadline.check())
            target.set_progress_handler(lambda: int(time.monotonic() >= self.deadline.expires), 1000)
            require(target.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'backup_integrity_failed')
        fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW)
        digest = hashlib.sha256()
        try:
            private_file(os.fstat(fd))
            os.fchown(fd, ROOT_UID, ROOT_GID)
            os.fchmod(fd, 0o400)
            os.fsync(fd)
            before_hash = file_stamp(backup)
            while True:
                self.deadline.check()
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                digest.update(chunk)
            require(file_stamp(backup) == before_hash, 'backup_changed_during_digest')
        finally:
            os.close(fd)
        sync_directory(backup_dir)
        self._verify_source_identities()
        assert_no_source_writers(source_handles(records, self.deadline))
        self._assert_writers_blocked()
        self.assert_protected_unchanged()
        self.state['backup'] = {'path': backup, 'sha256': digest.hexdigest(), 'stamp': before_hash}
        self.state['measurement'] = {
            'protocol': 'address-only-v1', 'operationId': self.operation_id,
            'binding': json.loads(json.dumps(self.state['binding'])),
            'backup': json.loads(json.dumps(self.state['backup'])),
            'sources': [file_stamp(row['path']) for row in records],
            'sourceDirectory': directory_stamp(SOURCE_DIRECTORY),
            'protectedProcesses': json.loads(json.dumps(self.prepared['protectedProcesses'])),
            'writerUnits': sorted(WRITER_UNITS),
            'restartExclusions': self._exclusion_measurement(),
        }
        self._save('BACKUP_DURABLE')
        return {'protocol': 'address-only-v1', 'operationId': self.operation_id,
                'backup': self.state['backup'].copy(), 'sources': records,
                'sourceSealed': True, 'protectedProcessesUnchanged': True, 'databaseImported': False}

    def _assert_retained_lock(self):
        require(self.lock is not None, 'controller_lock_not_held')
        fd_info = os.fstat(self.lock)
        path_info = os.lstat(CONTROL + '/controller.lock')
        private_file(fd_info)
        require((fd_info.st_dev, fd_info.st_ino) == (path_info.st_dev, path_info.st_ino),
                'controller_lock_replaced')
        if getattr(self, '_external_lock', False):
            try:
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            fcntl.flock(self.lock, fcntl.LOCK_UN)
            raise ValueError('controller_lock_not_held')

    def _require_controller(self):
        self._assert_retained_lock()
        require(not getattr(self, '_external_lock', False), 'controller_lock_not_owned')

    def measure(self):
        """Read-only bounded measurement; seal digest is stable across import phases.

        Backup content is hashed once at creation and pinned by root-private journal
        metadata including inode/size/mtime/ctime. Calls inspect stamps and handles,
        not database contents. This port grants neither import nor activation.
        """
        self.deadline.check()
        self._assert_retained_lock()
        state = self.journal.read()
        require(state is not None and state.get('operationId') == self.operation_id,
                'measurement_operation_mismatch')
        require(state.get('phase') in ('BACKUP_DURABLE', 'IMPORT_INTENT', 'IMPORT_COMMITTED')
                and state.get('pending') is None and isinstance(state.get('measurement'), dict), 'measurement_phase')
        self.state, self.prepared = state, state['prepared']
        sealed = state['measurement']
        validate_binding(state['binding'], self.operation_id)
        require(sealed.get('protocol') == 'address-only-v1' and sealed.get('operationId') == self.operation_id
                and sealed.get('binding') == state['binding'] and sealed.get('backup') == state['backup']
                and sealed.get('writerUnits') == sorted(WRITER_UNITS)
                and sealed.get('protectedProcesses') == self.prepared['protectedProcesses'], 'measurement_binding')
        validate_source_inventory(sealed['sources'])
        require({row['path'] for row in inventory()} == {row['path'] for row in sealed['sources']},
                'measurement_source_changed')
        for row in sealed['sources']:
            require(row['uid'] == ROOT_UID and row['gid'] == ROOT_GID and row['mode'] == 0o400
                    and file_stamp(row['path']) == row, 'measurement_source_changed')
        expected_directory = sealed['sourceDirectory']
        require(expected_directory['uid'] == ROOT_UID and expected_directory['gid'] == ROOT_GID
                and expected_directory['mode'] == 0o755
                and directory_stamp(SOURCE_DIRECTORY) == expected_directory, 'measurement_source_directory_changed')
        backup = sealed['backup']
        require(backup['path'] == BACKUP_DIRECTORY + '/address-only-' + self.operation_id + '/source.sqlite',
                'measurement_backup_path')
        private_directory(str(Path(backup['path']).parent))
        stamp = file_stamp(backup['path'])
        require(stamp == backup['stamp'] and stamp['uid'] == ROOT_UID and stamp['gid'] == ROOT_GID
                and stamp['mode'] == 0o400 and re.fullmatch(r'[a-f0-9]{64}', backup['sha256']),
                'measurement_backup_changed')
        self._assert_writers_blocked()
        require(sealed.get('restartExclusions') == self._exclusion_measurement(), 'measurement_restart_exclusion_changed')
        assert_no_source_writers(source_handles(sealed['sources'] + [stamp], self.deadline))
        self.assert_protected_unchanged()
        # Recheck cheap stamps after the process/service scan, including the retained lock.
        for row in sealed['sources']:
            require(file_stamp(row['path']) == row, 'measurement_source_changed')
        require(file_stamp(backup['path']) == stamp, 'measurement_backup_changed')
        require(directory_stamp(SOURCE_DIRECTORY) == expected_directory, 'measurement_source_directory_changed')
        self._assert_retained_lock()
        require(self.journal.read() == state, 'measurement_journal_changed')
        self.deadline.check()
        return {'protocol': 'address-only-v1', 'operationId': self.operation_id,
                'binding': json.loads(json.dumps(state['binding'])),
                'backupSha256': backup['sha256'], 'fenceSha256': measurement_digest(sealed),
                'backup': json.loads(json.dumps(backup)), 'sources': json.loads(json.dumps(sealed['sources'])),
                'sourceDirectory': expected_directory.copy(),
                'protectedProcesses': json.loads(json.dumps(sealed['protectedProcesses'])),
                'restartExclusions': json.loads(json.dumps(sealed['restartExclusions'])),
                'sourceSealed': True, 'writersBlocked': True, 'protectedProcessesUnchanged': True,
                'backupVerified': True, 'activationEnabled': False}

    def bind_import_plan(self, plan_sha256):
        """Pin the genuine post-seal plan atomically before publishing any fence digest."""
        self.deadline.check()
        self._require_controller()
        require(isinstance(plan_sha256, str) and re.fullmatch(r'[a-f0-9]{64}', plan_sha256),
                'invalid_import_plan_hash')
        state = self.journal.read()
        require(state is not None and state.get('operationId') == self.operation_id
                and state.get('phase') == 'BACKUP_DURABLE' and state.get('pending') is None
                and isinstance(state.get('measurement'), dict), 'invalid_plan_binding_phase')
        validate_binding(state['binding'], self.operation_id, allow_unbound=True)
        require(state['measurement']['binding'] == state['binding'], 'measurement_binding')
        require(state['binding']['planSha256'] in (None, plan_sha256), 'import_plan_already_bound')
        candidate = json.loads(json.dumps(state))
        candidate['binding']['planSha256'] = plan_sha256
        candidate['measurement']['binding']['planSha256'] = plan_sha256
        self.deadline.check()
        self.journal.write(candidate)
        self.state, self.prepared = candidate, candidate['prepared']
        return json.loads(json.dumps(candidate['binding']))

    def mark_import_intent(self):
        require(self.state['phase'] == 'BACKUP_DURABLE', 'invalid_fence_phase')
        self.measure()
        self._save('IMPORT_INTENT')
        return json.loads(json.dumps(self.state['binding']))

    def reconcile_committed_import(self, check_import, recovery_seconds=120):
        self._require_controller()
        self.deadline = Deadline(recovery_seconds)
        binding = json.loads(json.dumps(self.state['binding']))
        with check_import(json.loads(json.dumps(binding)), self.deadline) as result, contextlib.ExitStack() as recovery:
            self._validate_outcome(result, binding)
            recovery.enter_context(self._recovery_guard(result))
            require(result.get('importExists') is True and result.get('committedMatches') is True,
                    'import_outcome_not_confirmed_committed')
            require(self.state['phase'] in ('IMPORT_INTENT', 'IMPORT_COMMITTED'), 'invalid_fence_phase')
            self._assert_writers_blocked()
            self._verify_source_identities()
            self.assert_protected_unchanged()
            self._save('IMPORT_COMMITTED')
        return {'protocol': 'address-only-v1', 'databaseImported': True, 'activationEnabled': False}

    @staticmethod
    def _validate_outcome(result, binding):
        require(isinstance(result, dict) and result.get('outcomeKnown') is True
                and type(result.get('importExists')) is bool and result.get('importerExcluded') is True
                and result.get('advisoryLockHeld') is True and result.get('binding') == binding,
                'import_outcome_not_reconciled_under_exclusion')

    def restore_before_import(self, check_import, recovery_seconds=120):
        self._require_controller()
        require(self.state['phase'] not in ('IMPORT_COMMITTED', 'RESTORED'), 'invalid_restore_phase')
        self.deadline = Deadline(recovery_seconds)
        binding = json.loads(json.dumps(self.state['binding']))
        # The trusted context must keep both exclusions alive through every restore mutation.
        with check_import(json.loads(json.dumps(binding)), self.deadline) as result, contextlib.ExitStack() as recovery:
            self._validate_outcome(result, binding)
            recovery.enter_context(self._recovery_guard(result))
            require_uncommitted(lambda: result)
            self.assert_protected_unchanged()
            records = self._verify_source_identities(restoring=True)
            # Validate ALL masks and ALL source identities before changing any permissions.
            for unit in self.state['masks']:
                self._owned_mask(unit)
            for unit in self.state['guards']:
                self._owned_guard(unit)
            self._save('RESTORE_INTENT')
            if self.state['sources']:
                self._reinstate_restore_exclusion()
                records = self._verify_source_identities(restoring=True)
                self.assert_protected_unchanged()
            for row in records:
                self._action('restore_file', row['path'],
                             lambda: self._permissions(row['path'], row['uid'], row['gid'], row['mode']))
            if self.state['sources']:
                original = self.prepared['sourceDirectory']
                self._action('restore_directory', SOURCE_DIRECTORY,
                             lambda: self._permissions(SOURCE_DIRECTORY, original['uid'], original['gid'],
                                                       original['mode'], directory=True))
            for unit in self.state['masks']:
                if self._owned_mask(unit):
                    self._action('unmask', unit, lambda: self._remove_mask(MASK_DIRECTORY + '/' + unit))
            for unit in self.state['guards']:
                self._remove_guard(unit)
            self._action('reload', 'systemd', lambda: self.deadline.command(['systemctl', 'daemon-reload']))
            for unit in self._ordered_units(timers_first=False):
                state = self.prepared['writerStates'][unit]
                if state.get('ActiveState') == 'active':
                    self._action('start', unit, lambda: self.deadline.command(['systemctl', 'start', '--no-block', unit]))
                    self._wait_unit(unit, running=True)
            self.assert_protected_unchanged()
            self._save('RESTORED')
            self._cleanup_guard_anchors()

    def close(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None


def measure_existing(operation_id, deadline):
    """Importer-child port: never acquires control or writes journal/source/unit state."""
    require(sys.platform == 'linux' and os.geteuid() == ROOT_UID, 'native_root_required')
    require(isinstance(operation_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,96}', operation_id),
            'invalid_operation_id')
    private_directory(CONTROL)
    observer = NativeSourceFence.__new__(NativeSourceFence)
    observer.lock = os.open(CONTROL + '/controller.lock', os.O_RDONLY | os.O_NOFOLLOW)
    observer._external_lock = True
    observer.deadline, observer.operation_id, observer.journal = deadline, operation_id, Journal()
    try:
        return observer.measure()
    finally:
        observer.close()


FENCE_DIAGNOSTIC_CODES = frozenset(["active", "ascii", "assert_alive_and_locked", "automation", "backup", "backup_changed_during_digest", "backup_directory", "backup_integrity_failed", "binding", "console", "controller_lock_not_held", "controller_lock_not_owned", "controller_lock_replaced", "database", "device", "disabled", "enabled", "failed", "flags", "fomo_process_changed", "fragment", "gid", "guard", "guard_anchor", "guard_directory", "guards", "identity", "import_outcome_not_confirmed_absent", "import_outcome_not_confirmed_committed", "import_outcome_not_reconciled_under_exclusion", "import_plan_already_bound", "import_plan_not_bound", "inactive", "indirect", "information_schema", "inode", "insufficient_backup_space", "invalid_deadline_budget", "invalid_fence_phase", "invalid_import_binding", "invalid_import_plan_hash", "invalid_import_target", "invalid_journal", "invalid_operation_id", "invalid_plan_binding_phase", "invalid_restore_phase", "invalid_source_metadata", "invalid_source_sizes", "inventory_changed", "isolation", "journal_budget", "journal_unit_inventory_changed", "kind", "linux", "loaded", "mapped", "maps_budget", "mask", "masked", "masks", "measurement", "measurement_backup_changed", "measurement_backup_path", "measurement_binding", "measurement_journal_changed", "measurement_operation_mismatch", "measurement_phase", "measurement_restart_exclusion_changed", "measurement_source_changed", "measurement_source_directory_changed", "measurement_unsafe_directory", "measurement_unsafe_file", "migrate", "mode", "native_root_required", "no_unresolved_journal", "operation_id_required", "operation_id_reused", "original_operation_deadline", "parent_replaced", "path", "pending", "permission_target_replaced", "pg_", "phase", "pid", "prepared", "process_budget", "process_fd_budget", "protected_writer_overlap", "protocol", "public", "recovery_guard_already_active", "recovery_live_lock_connection_changed", "recovery_live_lock_guard_required", "recovery_live_lock_proof_required", "reload", "restart_guard_anchor_replaced", "restart_guard_directory_replaced", "restart_guard_missing", "restart_guard_not_effective", "restart_guard_replaced", "restart_mask_anchor_replaced", "restart_mask_replaced", "restart_original_changed", "restart_sentinel_changed", "restore_", "restore_directory", "restore_file", "scanner", "schema", "seal_", "seal_directory", "seal_file", "sealed_source_changed", "sentinel", "sha256", "show", "size", "source_changed_during_copy", "source_replaced", "source_short_read", "source_writer_remains", "sources", "staging_checkpoint_failed", "stamp", "start", "static", "status", "stop", "store_true", "subject", "systemctl", "systemd", "target", "total_fd_budget", "uid", "unexpected_operation_id", "unexpected_source_inventory", "unguard", "unguard_directory", "unit_configuration_changed", "unit_dropin_budget", "unmask", "unprotected_ancestor", "unresolved_journal", "unsafe_private_directory", "unsafe_private_file", "unsafe_source_directory", "unsafe_source_file", "unsafe_unit_configuration", "unsupported_restart_guard_order", "unsupported_restart_guard_path", "unsupported_restart_mask", "unsupported_restart_mask_filesystem", "unsupported_stop_propagation", "writable", "writer_mask_missing", "writer_reactivated", "writers_not_stopped", "unknown_failure", "permission_denied", "file_not_found", "os_error", "subprocess_timeout", "subprocess_failed", "invalid_json"])

def sanitized_fence_failure(error):
    code = str(error) if type(error) is ValueError and str(error) in FENCE_DIAGNOSTIC_CODES else 'unknown_failure'
    if isinstance(error, PermissionError): code = 'permission_denied'
    elif isinstance(error, FileNotFoundError): code = 'file_not_found'
    elif isinstance(error, subprocess.TimeoutExpired): code = 'subprocess_timeout'
    elif isinstance(error, subprocess.CalledProcessError): code = 'subprocess_failed'
    elif isinstance(error, OSError): code = 'os_error'
    return {'status': 'address-only-native-refused', 'activationEnabled': False,
            'diagnostic': {'code': code}}


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--measure', action='store_true')
    parser.add_argument('--operation-id')
    args = parser.parse_args()
    if args.measure:
        require(args.operation_id is not None, 'operation_id_required')
        print(json.dumps(measure_existing(args.operation_id, Deadline(60)), sort_keys=True))
        return
    require(args.operation_id is None, 'unexpected_operation_id')
    controller = NativeSourceFence.__new__(NativeSourceFence)
    controller._lock_control(Deadline(60))
    try:
        state = controller.journal.read()
        require(state is None or state['phase'] == 'RESTORED', 'unresolved_journal')
        result = preflight(controller.deadline)
    finally:
        controller.close()
    print(json.dumps({'status': 'address-only-native-preflight', 'sourceBytes': sum(row['size'] for row in result['sourceFiles']),
                      'diskFreeBytes': result['diskFreeBytes'], 'writerUnitsMeasured': len(result['writerStates']),
                      'protectedUnitsMeasured': len(result['protectedProcesses']),
                      'servicesStopped': False, 'sourceSealed': False, 'databaseImported': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(sanitized_fence_failure(error), sort_keys=True))
        sys.exit(2)
