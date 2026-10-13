#!/usr/bin/env python3
"""Managed readonly independent artifact checker; never sign or assert a fence."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import time


class Refused(Exception):
    pass


def require(value, reason):
    if not value:
        raise Refused(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def protected(path, deadline, maximum=1024 * 1024):
    require(os.path.isabs(path) and os.path.normpath(path) == path, 'protected-path')
    parents = []
    parent = os.path.dirname(path)
    while True:
        require(time.monotonic() < deadline, 'original-deadline')
        value = os.lstat(parent)
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0
                and not stat.S_IMODE(value.st_mode) & 0o022, 'protected-ancestor')
        parents.append((parent, (value.st_dev, value.st_ino)))
        if parent == '/':
            break
        parent = os.path.dirname(parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and before.st_nlink == 1 and not stat.S_IMODE(before.st_mode) & 0o022
                and before.st_size <= maximum, 'protected-file')
        parts, count = [], 0
        while True:
            require(time.monotonic() < deadline, 'original-deadline')
            part = os.read(fd, min(65536, maximum + 1 - count))
            if not part:
                break
            count += len(part)
            require(count <= maximum, 'read-budget')
            parts.append(part)
        pin = lambda value: (value.st_dev, value.st_ino, value.st_size,
                             value.st_mtime_ns, value.st_ctime_ns, value.st_uid,
                             value.st_mode, value.st_nlink)
        require(pin(before) == pin(os.fstat(fd)) == pin(os.lstat(path)), 'protected-mutated')
        for name, identity in parents:
            live = os.lstat(name)
            require(stat.S_ISDIR(live.st_mode) and live.st_uid == 0
                    and not stat.S_IMODE(live.st_mode) & 0o022
                    and (live.st_dev, live.st_ino) == identity, 'protected-ancestor-replaced')
        return b''.join(parts)
    finally:
        os.close(fd)


def record(path, sha256, deadline):
    require(re.fullmatch('[a-f0-9]{64}', sha256), 'record-pin')
    raw = protected(path, deadline)
    require(hashlib.sha256(raw).hexdigest() == sha256, 'record-pin')
    value = json.loads(raw)
    require(raw == canonical(value), 'canonical-record')
    require(stat.S_IMODE(os.lstat(path).st_mode) == 0o600
            and stat.S_IMODE(os.lstat(os.path.dirname(path)).st_mode) == 0o700, 'private-record')
    return value


def load(pin, name, deadline):
    raw = protected(pin['path'], deadline)
    require(hashlib.sha256(raw).hexdigest() == pin['sha256'], 'code-pin')
    # Execute the bytes already validated, never reopen a mutable import path.
    spec = importlib.util.spec_from_loader(name, loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = pin['path']
    exec(compile(raw, pin['path'], 'exec'), module.__dict__)
    return module


def validate_binding(job, expiry, binding):
    nonce, request = job['nonce'], job['requestNonce']
    require(re.fullmatch('[a-f0-9]{16}', nonce) and re.fullmatch('[a-f0-9]{16}', request), 'request')
    control = '/var/lib/address-radar-rehearsal-artifact-control/' + nonce
    unit = 'radar-rehearsal-' + nonce + '-verifier-' + request + '.service'
    directory = control + '/receipts/' + request
    require(expiry['nonce'] == nonce and expiry['artifacts']['control']['root'] == control
            and binding['unit'] == unit and binding['role'] == 'verifier'
            and binding['request_nonce'] == request
            and binding['record_sha256'] == job['expirySha256']
            and job['bindingPath'] == control + '/invocations/' + request + '-verifier.binding.json'
            and binding['policy']['receipt_directory'] == directory, 'managed-binding')
    producer = job['producerDirectory']
    root = expiry['artifacts']['root']
    require(root == '/var/lib/address-radar-rehearsal-artifacts/' + nonce
            and os.path.isabs(producer) and os.path.normpath(producer) == producer
            and producer.startswith(root + '/'), 'producer-namespace')
    require(job['measurementPath'] == producer + '/measurement.json', 'measurement-path')
    return directory


class WorkArea:
    """Exclusive request child; preflight all ownership before any unlink.

    Only the managed root process creates work. Trusted administrators are not
    treated as hostile; no other UID may mutate this namespace.
    """
    maximum = 10000
    maximum_depth = 16

    def __init__(self, parent, deadline, check):
        self.path = parent + '/snapshot-work'
        self.parent_path, self.deadline, self.check = parent, deadline, check
        self.uid = os.geteuid()
        self.parent = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.fd = None
        try:
            self.parent_pin = os.fstat(self.parent)
            self.owned(self.parent_pin, True)
            os.mkdir('snapshot-work', 0o700, dir_fd=self.parent)
            self.fd = os.open('snapshot-work', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.parent)
            self.pin = os.fstat(self.fd)
            self.mount = self.mount_id(self.fd)
            require(self.mount == self.mount_id(self.parent), 'work-mount')
            self.cleaned = False
        except Exception:
            if self.fd is not None: os.close(self.fd)
            os.close(self.parent)
            raise

    @staticmethod
    def identity(info):
        return info.st_dev, info.st_ino

    @staticmethod
    def metadata(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def mount_id(self, fd):
        if sys.platform != 'linux':
            return os.fstat(fd).st_dev  # Local fixtures only; native main requires Linux.
        with open('/proc/self/fdinfo/' + str(fd), encoding='ascii') as handle:
            raw = handle.read(4097)
        ids = re.findall(r'^mnt_id:\s*([0-9]+)$', raw, re.M)
        require(len(raw) <= 4096 and len(ids) == 1, 'work-mount-proof')
        return ids[0]

    def owned(self, info, directory):
        require(info.st_uid == self.uid and not stat.S_IMODE(info.st_mode) & 0o022
                and (stat.S_ISDIR(info.st_mode) if directory else
                     stat.S_ISREG(info.st_mode) and info.st_nlink == 1), 'work-ownership')

    def guard(self):
        require(time.monotonic() < self.deadline, 'cleanup-original-deadline')
        self.check()
        for info in (os.fstat(self.parent), os.lstat(self.parent_path)):
            self.owned(info, True)
            require(self.identity(info) == self.identity(self.parent_pin), 'work-parent-replaced')
        if not self.cleaned:
            live = os.stat('snapshot-work', dir_fd=self.parent, follow_symlinks=False)
            self.owned(live, True)
            require(self.identity(live) == self.identity(self.pin)
                    and self.identity(os.fstat(self.fd)) == self.identity(self.pin), 'work-replaced')

    def clean(self):
        self.guard()
        require(not self.cleaned, 'work-already-cleaned')
        nodes, opened = [], []
        count, size = 0, 0
        def scan(fd, depth):
            nonlocal count, size
            require(depth <= self.maximum_depth, 'cleanup-depth')
            before = os.fstat(fd)
            self.owned(before, True)
            require(self.mount_id(fd) == self.mount, 'cleanup-mount')
            children = []
            # Incremental bounds apply before accumulation; never sorted(listdir).
            with os.scandir(fd) as entries:
                for entry in entries:
                    self.guard()
                    count += 1
                    require(count <= self.maximum, 'cleanup-count')
                    info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    directory = stat.S_ISDIR(info.st_mode)
                    self.owned(info, directory)
                    child = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                                    | (os.O_DIRECTORY if directory else 0), dir_fd=fd)
                    opened.append(child)
                    require(len(opened) <= 512, 'cleanup-fd-budget')
                    require(self.metadata(info) == self.metadata(os.fstat(child))
                            and self.mount_id(child) == self.mount, 'cleanup-replaced-or-mount')
                    if directory: scan(child, depth + 1)
                    else: size += info.st_size
                    children.append((entry.name, info, child, directory))
            require(self.metadata(before) == self.metadata(os.fstat(fd)), 'cleanup-mutated')
            nodes.append((fd, children, before))
        try:
            scan(self.fd, 0)
            # Full second identity pass still precedes the first destructive step.
            for fd, children, before in nodes:
                self.guard()
                require(self.metadata(before) == self.metadata(os.fstat(fd)), 'cleanup-mutated')
                for name, info, child, directory in children:
                    require(self.metadata(info) == self.metadata(os.stat(name, dir_fd=fd, follow_symlinks=False))
                            == self.metadata(os.fstat(child)), 'cleanup-mutated')
            for fd, children, _ in nodes:  # Postorder: all descriptors remain live.
                for name, info, child, directory in children:
                    self.guard()
                    live = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    self.owned(live, directory)
                    require(self.identity(live) == self.identity(info)
                            and self.mount_id(child) == self.mount, 'cleanup-mutated')
                    if directory: os.rmdir(name, dir_fd=fd)
                    else:
                        require(self.metadata(live) == self.metadata(info), 'cleanup-mutated')
                        os.unlink(name, dir_fd=fd)
            self.guard()
            os.rmdir('snapshot-work', dir_fd=self.parent)
            self.cleaned = True
            os.fsync(self.parent)
            return dict(version=1, workRemoved=True, removedEntries=count, removedBytes=size,
                        retainedBusinessWork=False)
        finally:
            for fd in reversed(opened): os.close(fd)

    def retained_audit(self):
        self.guard()
        require(self.cleaned, 'work-retained')
        count = 0
        with os.scandir(self.parent) as entries:
            for entry in entries:
                self.guard()
                count += 1
                require(count <= 1 and entry.name == 'proof.json', 'retained-unknown')
                info = os.stat(entry.name, dir_fd=self.parent, follow_symlinks=False)
                self.owned(info, False)
                require(stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 1024 * 1024,
                        'retained-proof-ownership')
        return dict(version=1, retainedReceiptCount=count, retainedBusinessWork=False)

    def __enter__(self): return self

    def __exit__(self, kind, value, traceback):
        try:
            if not self.cleaned: self.clean()
        finally:
            os.close(self.fd)
            os.close(self.parent)


def main(argv=None):
    started = time.monotonic()
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--job-sha256', required=True)
    args = parser.parse_args(argv)
    require(sys.platform == 'linux' and os.geteuid() == 0 and sys.flags.isolated
            and sys.dont_write_bytecode, 'native-runtime')
    deadline = started + 30
    job = record(args.job, args.job_sha256, deadline)
    require(set(job) == {'version', 'nonce', 'requestNonce', 'expiryPath', 'expirySha256',
                        'bindingPath', 'kernel', 'verifier', 'collector', 'helper',
                        'censusPath', 'censusSha256', 'producerDirectory', 'measurementPath',
                        'measurementSha256', 'deadlineSeconds', 'minimumFreeBytes', 'operationId'}, 'job-schema')
    require(job['version'] == 1 and type(job['deadlineSeconds']) is int
            and 1 <= job['deadlineSeconds'] <= 1800 and type(job['minimumFreeBytes']) is int
            and job['minimumFreeBytes'] >= 0, 'job-budget')
    # All work, including initial protected reads, is charged to original start.
    deadline = started + job['deadlineSeconds']
    expiry = record(job['expiryPath'], job['expirySha256'], deadline)
    binding_raw = protected(job['bindingPath'], deadline)
    binding = json.loads(binding_raw)
    require(binding_raw == canonical(binding) and stat.S_IMODE(os.lstat(job['bindingPath']).st_mode) == 0o600,
            'private-binding')
    binding_sha256 = hashlib.sha256(binding_raw).hexdigest()
    admit_path = job['bindingPath'].removesuffix('binding.json') + 'admit.json'
    admit_raw = protected(admit_path, deadline)
    require(json.loads(admit_raw) == dict(binding_sha256=binding_sha256)
            and admit_raw == canonical(json.loads(admit_raw)), 'managed-admit-chain')
    directory = validate_binding(job, expiry, binding)
    require(binding['invocation_id'] == os.environ.get('INVOCATION_ID'), 'managed-invocation')
    deadline = min(deadline, time.monotonic() + min(expiry['deadline'], binding['deadline']) - time.time())
    kernel = load(job['kernel'], 'pinned_kernel_boundary', deadline)
    verifier = load(job['verifier'], 'pinned_snapshot_verifier', deadline)
    collector = load(job['collector'], 'pinned_snapshot_collector', deadline)
    helper = load(job['helper'], 'pinned_snapshot_helper', deadline)
    census = record(job['censusPath'], job['censusSha256'], deadline)
    kernel.validate_job(census)
    measurement = record(job['measurementPath'], job['measurementSha256'], deadline)
    managed = dict(unitId=binding['unit'], invocationId=binding['invocation_id'],
                   cgroupPath=binding['control_group'], cgroupIdentity=binding['identity'],
                   systemctlPath=expiry['artifacts']['managed']['systemctl']['path'],
                   systemctlSha256=expiry['artifacts']['managed']['systemctl']['sha256'])
    def check():
        require(time.monotonic() < deadline, 'original-deadline')
        require(record(job['bindingPath'], binding_sha256, deadline) == binding, 'binding-changed')
        live = os.lstat(directory)
        require(stat.S_ISDIR(live.st_mode) and live.st_uid == 0 and stat.S_IMODE(live.st_mode) == 0o700
                and [live.st_dev, live.st_ino] == binding['receipt_identity'], 'receipt-replaced')
    with_monitor = kernel.ManagedUnitMonitor(managed, check)
    try:
        check()
        with_monitor.assert_active()
        outside_path = job['bindingPath'].removesuffix('binding.json') + 'census.json'
        outside_raw = protected(outside_path, deadline)
        outside = json.loads(outside_raw)
        require(outside_raw == canonical(outside) and outside['version'] == 1
                and outside['nonce'] == job['nonce'] and outside['request_nonce'] == job['requestNonce']
                and outside['record_sha256'] == job['expirySha256']
                and outside['census_job_sha256'] == job['censusSha256']
                and outside['before']['kernelAccessBoundaryMeasured'] is True, 'outside-census-binding')
        kernel.admission_check(census, check)
        parent, sources, _ = kernel.source_state(census, check)
        kernel.validate_kernel_boundary(dict(parent=parent, sources=sources, processes=[], complete=True))
        work_deadline = deadline - 10
        require(time.monotonic() < work_deadline, 'cleanup-reserve')
        with WorkArea(directory, deadline, check) as work:
            result = verifier.verify_snapshot_artifacts(measurement, job['producerDirectory'],
                     work.path + '/independent', helper, collector, work_deadline,
                     job['minimumFreeBytes'], job['operationId'], check)
            paths = {item['path'] for item in census['sources']}
            bases = [item for item in census['sources']
                     if paths == {item['path'], item['path'] + '-wal', item['path'] + '-shm'}]
            require(len(bases) == 1 and not bases[0].get('absent'), 'current-source-scope')
            result.update(verifier.verify_current_source_snapshot(measurement, bases[0],
                          work.path + '/current-source', helper, collector, work_deadline,
                          job['minimumFreeBytes'], job['operationId'], check))
            result['workCleanup'] = work.clean()
            result['retainedAuditBeforePublication'] = work.retained_audit()
        result['completedAt'] = verifier.instant()
        kernel.admission_check(census, check)
        with_monitor.assert_active()
        check()
        # Outside wrapper adds real before/after census digests only after this
        # unit reaches strict terminal-empty; do not fake an in-sandbox scan.
        result.update(jobSha256=args.job_sha256, managedBindingSha256=binding_sha256)
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            require([info.st_dev, info.st_ino] == binding['receipt_identity'], 'receipt-replaced')
            output = os.open('proof.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            try:
                raw = canonical(result)
                offset = 0
                while offset < len(raw):
                    check()
                    written = os.write(output, raw[offset:])
                    require(written > 0, 'receipt-write')
                    offset += written
                os.fsync(output)
                check()
                os.fsync(fd)
            finally:
                os.close(output)
        finally:
            os.close(fd)
    finally:
        with_monitor.close()
    print('{"status":"independent-snapshot-measured","signedProofsCreated":false,"fenceEstablished":false}')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"independent-snapshot-refused","signedProofsCreated":false,"fenceEstablished":false}')
        sys.exit(2)
