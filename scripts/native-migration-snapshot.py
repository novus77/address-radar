#!/usr/bin/env python3
"""Independent lossless snapshot measurements; never manufactures a fence or authorization."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import stat
import sys
import time

MAX_JSON = 65536
CONTROL = '/etc/address-radar/sqlite-writer-admission'


def need(value, code):
    if not value:
        raise RuntimeError(code)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def protected(path, maximum=MAX_JSON):
    path = Path(path)
    need(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'path_invalid')
    parents = []
    for parent in (path.parent, *path.parent.parents):
        info = os.lstat(parent)
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'ancestor_unprotected')
        parents.append((parent, info.st_dev, info.st_ino))
    before = os.lstat(path)
    need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
         and not before.st_mode & 0o022 and before.st_size <= maximum, 'file_unprotected')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'file_replaced')
        chunks, size = [], 0
        while True:
            raw = os.read(fd, min(65536, maximum + 1 - size))
            if not raw:
                break
            chunks.append(raw)
            size += len(raw)
            need(size <= maximum, 'file_bound')
        after = os.fstat(fd)
        live = os.lstat(path)
        need((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) ==
             (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
             and (live.st_dev, live.st_ino) == (before.st_dev, before.st_ino), 'file_replaced')
        for parent, dev, ino in parents:
            info = os.lstat(parent)
            need((info.st_dev, info.st_ino) == (dev, ino) and info.st_uid == 0
                 and stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022, 'ancestor_replaced')
        return b''.join(chunks)
    finally:
        os.close(fd)


def protected_json(path, pin=None):
    raw = protected(path)
    if pin is not None:
        need(hashlib.sha256(raw).hexdigest() == pin, 'json_pin_changed')
    value = json.loads(raw)
    need(encoded(value) == raw, 'json_noncanonical')
    return value


def load_helper(path, pin):
    raw = protected(path, 1048576)
    need(hashlib.sha256(raw).hexdigest() == pin, 'helper_pin_changed')
    # Execute the already measured bytes, not a second pathname lookup.
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('measured_snapshot_helper', loader=None))
    module.__file__ = path
    exec(compile(raw, path, 'exec'), module.__dict__)
    return module


def source_identity(path):
    info = os.lstat(path)
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'source_type_unknown')
    return {'path': str(path), 'device': str(info.st_dev), 'inode': str(info.st_ino)}


def closed_control(policy_pin, source, now):
    marker = protected_json(CONTROL + '/activation.json')
    need(marker.get('version') == 1 and marker.get('policySha256') == policy_pin, 'activation_changed')
    policy = protected_json(CONTROL + '/policy.json', policy_pin)
    state = protected_json(CONTROL + '/state.json')
    need(state.get('admission') == 'closed' and state.get('policySha256') == policy_pin
         and state.get('deploymentId') == policy.get('deploymentId') == marker.get('deploymentId')
         and state.get('challengeId') == policy.get('challengeId')
         and state.get('notBefore') == policy.get('notBefore')
         and state.get('notAfter') == policy.get('notAfter')
         and policy['notBefore'] <= now < policy['notAfter']
         and policy.get('unresolvedScopes') == [], 'admission_unresolved')
    expected = next((item for item in policy['sources'] if item['path'] == str(source)), None)
    need(expected is not None and all(expected[key] == source_identity(source)[key]
                                    for key in ('path', 'device', 'inode')), 'source_identity_changed')
    return policy, digest(state)


def collect_snapshot(source, output, helper, deadline, reserve, operation_id, check=lambda: None):
    """Real SQLite operations, also testable on local fixture databases without claiming native fencing."""
    need(time.monotonic() < deadline, 'snapshot_deadline')
    check()
    before = source_identity(source)
    output.mkdir(mode=0o700)
    backup = output / 'snapshot.sqlite'
    snapshot = helper.snapshot(source, backup, operation_id, deadline, reserve, 256, 0)
    check()
    bundle = output / 'bundle'
    exported = helper.export(backup, bundle, operation_id, snapshot['backupSha256'], deadline,
                             reserve, 1048576, 256, False)
    restored = helper.restore(bundle, output / 'restored.sqlite', deadline, reserve)
    manifest = helper.validate_bundle(bundle, deadline)
    need(exported['completed'] and restored['preservationVerified'], 'snapshot_parity_failed')
    check()
    need(source_identity(source) == before and time.monotonic() < deadline, 'source_or_deadline_changed')
    tables = [{'name': table['name'], 'rowCount': str(table['rowCount']),
               'sha256': table['contentSha256']} for table in manifest['tables']]
    return {'version': 1, 'kind': 'native-snapshot-measurement', 'source': before,
            'snapshotSha256': snapshot['backupSha256'], 'tables': tables,
            'tableCensusSha256': digest(tables), 'catalogFingerprint': manifest['catalogFingerprint'],
            'parityReceiptSha256': digest(restored), 'restoreReceiptSha256': digest(restored),
            'sourceWrites': False, 'signedProofsCreated': False, 'fenceEstablished': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--job-sha256', required=True)
    args = parser.parse_args()
    need(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated
         and sys.dont_write_bytecode, 'native_runtime_required')
    job = protected_json(args.job, args.job_sha256)
    need(set(job) == {'version', 'source', 'output', 'operationId', 'deadlineSeconds',
                     'minimumFreeBytes', 'admissionPolicySha256', 'helperPath', 'helperSha256'}, 'job_fields')
    need(job['version'] == 1 and isinstance(job['deadlineSeconds'], int)
         and 0 < job['deadlineSeconds'] <= 1800 and isinstance(job['minimumFreeBytes'], int)
         and job['minimumFreeBytes'] >= 0, 'job_budget')
    source = Path(job['source'])
    policy, state_pin = closed_control(job['admissionPolicySha256'], source, int(time.time() * 1000))
    remaining = (policy['notAfter'] - time.time() * 1000) / 1000
    deadline = time.monotonic() + min(job['deadlineSeconds'], remaining)
    output = Path(job['output'])
    need(output.is_absolute() and str(output) == os.path.normpath(str(output))
         and re.fullmatch(r'/var/lib/address-radar-migration-evidence/[a-f0-9]{16}/snapshots/[a-f0-9]{32}', str(output)), 'output_path')
    # Parent must be a separately approved private namespace. Never write into the source tree.
    parent = os.lstat(output.parent)
    need(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and stat.S_IMODE(parent.st_mode) == 0o700
         and output.parent != source.parent and not output.exists() and not output.is_symlink(), 'output_unprotected')
    for ancestor in output.parent.parents:
        info = os.lstat(ancestor)
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'output_ancestor_unprotected')
    helper = load_helper(job['helperPath'], job['helperSha256'])
    def check():
        need(time.monotonic() < deadline, 'snapshot_deadline')
        _, current = closed_control(job['admissionPolicySha256'], source, int(time.time() * 1000))
        need(current == state_pin, 'admission_changed_during_snapshot')
    started = int(time.time() * 1000)
    receipt = collect_snapshot(source, output, helper, deadline, job['minimumFreeBytes'], job['operationId'], check)
    receipt.update(startedAtMs=started, completedAtMs=int(time.time() * 1000),
                   jobSha256=args.job_sha256, admissionStateSha256=state_pin,
                   helperSha256=job['helperSha256'])
    target = output / 'measurement.json'
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        raw = encoded(receipt)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    print(json.dumps({'status': 'snapshot-measured', 'measurementSha256': digest(receipt),
                      'tables': len(receipt['tables']), 'signedProofsCreated': False,
                      'fenceEstablished': False}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"snapshot-refused","signedProofsCreated":false,"fenceEstablished":false}')
        sys.exit(2)
