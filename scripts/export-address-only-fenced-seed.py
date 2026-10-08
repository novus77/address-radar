#!/usr/bin/env python3
"""Capture only the reviewed address registry after a real native source fence."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import stat
import sys
import time
import types

SOURCE = '/var/lib/address-radar/address-radar.db'
MAXIMUM_ROWS = 10000
MAXIMUM_BYTES = 4 * 1024 * 1024
RULES = {'historicalEvidenceImported': False, 'historicalJobsImported': False,
         'legacyLifecycleIsNotNewCapabilityProof': True, 'gatewayDeliveryEnabled': False,
         'activationAuthorizedByExport': False}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


class OperationDeadline:
    def __init__(self, seconds=30):
        self.started = time.monotonic()
        self.expires = self.started + seconds

    def shorten(self, seconds):
        self.expires = min(self.expires, self.started + seconds)

    def check(self):
        require(time.monotonic() < self.expires, 'original_operation_deadline')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def select_seed(connection, captured_at, source=SOURCE, check=lambda: None):
    # SQLite refuses oversized records before converting TEXT/BLOB values to Python.
    # Reserve expansion space for ASCII JSON escapes and object/container overhead.
    previous = connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, min(
        connection.getlimit(sqlite3.SQLITE_LIMIT_LENGTH), max(1, MAXIMUM_BYTES // 8)))
    try:
        return select_bounded_seed(connection, captured_at, source, check)
    finally:
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, previous)


def select_bounded_seed(connection, captured_at, source, check):
    used = 1024

    def rows(sql, values=()):
        nonlocal used
        check()
        result = connection.execute(sql + ' LIMIT 10001', values)
        names = [item[0] for item in result.description]
        selected = []
        for row in result:
            check()
            value = dict(zip(names, row))
            used += len(canonical(value)) + 2
            require(used <= MAXIMUM_BYTES, 'seed_byte_budget')
            require(len(selected) < MAXIMUM_ROWS, 'address_registry_row_budget')
            selected.append(value)
        return selected

    wallets = rows("SELECT * FROM wallet_identities WHERE "
                   "(confidence='confirmed' AND source='manual') OR "
                   "(confidence='high' AND source='fomolens_manual') ORDER BY account_id,chain_family,address")
    require(wallets, 'empty_confirmed_address_registry')
    accounts = sorted({row['account_id'] for row in wallets})

    def selected(table, column, ids):
        require(table in {'fomo_accounts', 'entity_accounts', 'trader_entities',
                         'trader_profiles', 'trader_monitoring_policy'}, 'table_not_allowlisted')
        require(column in {'account_id', 'entity_id', 'trader_id'}, 'column_not_allowlisted')
        result = []
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            result.extend(rows('SELECT * FROM ' + table + ' WHERE ' + column + ' IN (' +
                               ','.join('?' for _ in chunk) + ') ORDER BY ' + column, chunk))
            require(len(result) <= MAXIMUM_ROWS, 'address_registry_row_budget')
        return result

    links = selected('entity_accounts', 'account_id', accounts)
    entities = sorted({row['entity_id'] for row in links})
    tables = {'wallet_identities': wallets, 'fomo_accounts': selected('fomo_accounts', 'account_id', accounts),
              'entity_accounts': links, 'trader_entities': selected('trader_entities', 'entity_id', entities),
              'trader_profiles': selected('trader_profiles', 'entity_id', entities),
              'trader_monitoring_policy': selected('trader_monitoring_policy', 'trader_id', entities)}
    return {'format': 'address-only-seed-v1', 'capturedAt': captured_at,
            'sourceDatabase': source, 'rules': dict(RULES), 'tables': tables}


def checked_parents(path, check, include_self=False):
    parents = [Path(path)] if include_self else []
    parents.extend(Path(path).parents)
    pins = []
    for parent in parents:
        check()
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'unprotected_parent')
        pins.append((str(parent), info.st_dev, info.st_ino))
    return pins


def recheck_parents(pins, check):
    for parent, device, inode in pins:
        check()
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
                and (info.st_dev, info.st_ino) == (device, inode), 'protected_parent_changed')


def private_output_directory(parent, check):
    require(os.path.isabs(parent) and os.path.normpath(parent) == parent, 'invalid_output_parent')
    pins = checked_parents(parent, check, True)
    info = os.lstat(parent)
    require(stat.S_IMODE(info.st_mode) == 0o700, 'output_not_private')
    fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        live = os.fstat(fd)
        require((live.st_dev, live.st_ino) == pins[0][1:], 'output_parent_changed')
        recheck_parents(pins, check)
        return fd, pins
    except BaseException:
        os.close(fd)
        raise


def protected(path, maximum, check=lambda: None):
    check()
    require(os.path.isabs(path) and os.path.normpath(path) == path, 'absolute_protected_path_required')
    parents = checked_parents(path, check)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stamp = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                          info.st_ctime_ns, info.st_mode, info.st_uid, info.st_nlink)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and before.st_size <= maximum, 'unprotected_file')
        raw = bytearray()
        while len(raw) <= maximum:
            check()
            chunk = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        require(len(raw) <= maximum and stamp(before) == stamp(os.fstat(fd)) == stamp(os.lstat(path)),
                'protected_file_changed')
        recheck_parents(parents, check)
        return bytes(raw)
    finally:
        os.close(fd)


def pinned_record(pin, check=lambda: None):
    raw = protected(pin['path'], MAXIMUM_BYTES, check)
    require(sha(raw) == pin['sha256'], 'record_digest_mismatch')
    require(stat.S_IMODE(os.lstat(pin['path']).st_mode) == 0o600, 'record_not_private')
    value = json.loads(raw)
    require(canonical(value) == raw, 'record_not_canonical')
    check()
    return value


def pinned_module(pin, name, check=lambda: None):
    raw = protected(pin['path'], 1024 * 1024, check)
    require(sha(raw) == pin['sha256'], 'code_digest_mismatch')
    module = types.ModuleType(name)
    module.__file__ = pin['path']
    check()
    exec(compile(raw, pin['path'], 'exec'), module.__dict__)
    check()
    return module


def capture(job, deadline=None):
    deadline = deadline or OperationDeadline()
    deadline.check()
    require(set(job) == {'version', 'kernelEntry', 'kernelJob', 'seedValidator', 'seedOutput'}
            and job['version'] == 1, 'unsupported_capture_job')
    kernel = pinned_module(job['kernelEntry'], 'pinned_kernel_boundary', deadline.check)
    validator = pinned_module(job['seedValidator'], 'pinned_seed_validator', deadline.check)
    kernel_job = pinned_record(job['kernelJob'], deadline.check)
    kernel.validate_job(kernel_job)
    deadline.shorten(min(30, kernel_job['durationSeconds']))
    deadline.check()
    require(kernel_job['sourceDirectory'] == os.path.dirname(SOURCE)
            and {row['path'] for row in kernel_job['sources']} ==
                {SOURCE, SOURCE + '-wal', SOURCE + '-shm'}, 'unexpected_source_scope')
    output = job['seedOutput']
    require(isinstance(output, str) and os.path.isabs(output) and os.path.normpath(output) == output
            and output.startswith('/var/lib/address-radar-maintenance-tools/'), 'unexpected_output_namespace')
    directory, pins = private_output_directory(os.path.dirname(output), deadline.check)
    try:
        before = kernel.collect(kernel_job, deadline.check)
        captured_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        connection = sqlite3.connect('file:' + SOURCE + '?mode=ro', uri=True, timeout=1)
        try:
            connection.execute('PRAGMA query_only=ON')
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline.expires), 1000)
            connection.execute('BEGIN')
            seed = select_seed(connection, captured_at, check=deadline.check)
            body = canonical(seed)
            require(len(body) <= MAXIMUM_BYTES, 'seed_byte_budget')
            deadline.check()
            candidate = validator.prepare(seed, sha(body))
            connection.execute('ROLLBACK')
        finally:
            connection.close()
        after = kernel.collect(kernel_job, deadline.check)
        deadline.check()
        receipt = {'status': 'fenced-address-only-seed-captured', 'sourceDatabase': SOURCE,
                   'capturedAt': captured_at, 'seedSha256': sha(body),
                   'wallets': len(candidate['wallets']), 'entities': len(candidate['settings']),
                   'beforeBoundarySha256': sha(kernel.canonical(before)),
                   'afterBoundarySha256': sha(kernel.canonical(after)),
                   'sourceWrites': False, 'databaseImported': False,
                   'activationAuthorized': False, 'gatewayDeliveryEnabled': False}
        name = os.path.basename(output)
        require(name not in ('', '.', '..'), 'invalid_output_name')
        for filename, raw in [(name, body), (name + '.receipt.json', canonical(receipt))]:
            recheck_parents(pins, deadline.check)
            fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            try:
                view = memoryview(raw)
                while view:
                    deadline.check()
                    written = os.write(fd, view)
                    require(written > 0, 'output_write_failed')
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
        os.fsync(directory)
        recheck_parents(pins, deadline.check)
        return receipt
    finally:
        os.close(directory)


def main():
    deadline = OperationDeadline()
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--job-sha256', required=True)
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated
            and sys.dont_write_bytecode, 'native_isolated_root_required')
    # A native signal also interrupts synchronous parsing/code execution, not just cooperative I/O.
    def expired(_signal, _frame):
        raise TimeoutError('original_operation_deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline.expires - time.monotonic()))
    try:
        job = pinned_record({'path': args.job, 'sha256': args.job_sha256}, deadline.check)
        print(json.dumps(capture(job, deadline)))
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"fenced-capture-refused","databaseImported":false,"activationAuthorized":false}')
        sys.exit(2)
