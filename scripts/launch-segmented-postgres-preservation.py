#!/usr/bin/python3
"""EXACT3 registered launcher. Managed lease owns termination and exit proof."""
import hashlib
import json
import os
import re
import stat
import sys
import time

NODE_SHA256 = '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c'
NODE_PATH = '/var/lib/address-radar-maintenance-tools/native-node-' + NODE_SHA256 + '/node'
NODE_SIZE = 126595440

ARTIFACT_PARENT = '/var/lib/address-radar-rehearsal-artifacts'
CONTROL_PARENT = '/var/lib/address-radar-rehearsal-artifact-control'


def require(value, reason):
    if not value:
        raise ValueError('segmented_launcher_' + reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def protected_bytes(path, maximum):
    require(os.path.isabs(path) and os.path.realpath(path) == path, 'path')
    directory = os.path.dirname(path)
    while directory != '/':
        info = os.lstat(directory)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'ancestor')
        directory = os.path.dirname(directory)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and
                not info.st_mode & 0o077 and 0 < info.st_size <= maximum, 'file')
        raw = bytearray()
        while len(raw) <= maximum:
            part = os.read(fd, min(65536, maximum + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        require(0 < len(raw) <= maximum, 'size')
        after = os.fstat(fd)
        require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (os.lstat(path).st_dev, os.lstat(path).st_ino) == (info.st_dev, info.st_ino), 'race')
        return bytes(raw)
    finally:
        os.close(fd)


def launch_spec(arguments, read=protected_bytes, now_ms=None, include_budget=False):
    require(len(arguments) == 1, 'arguments')
    path = arguments[0]
    match = re.fullmatch(ARTIFACT_PARENT + r'/([a-f0-9]{16})/([A-Za-z0-9_-]+\.json)', path)
    require(match, 'arguments')
    raw = read(path, 1048576)
    config = json.loads(raw)
    require(config.get('version') == 2 and config.get('nonce') == match[1] and
            config.get('stage') in ('calibrate', 'import', 'verify', 'finalize'), 'config')
    invocation = config.get('invocation', {})
    request, deadline, timeout = (invocation.get(k) for k in ('requestNonce', 'deadlineAtMs', 'timeoutMs'))
    now = int(time.time() * 1000) if now_ms is None else now_ms
    require(isinstance(request, str) and re.fullmatch(r'[a-f0-9]{16}', request) and
            type(deadline) is int and type(timeout) is int and
            10000 < timeout <= (180000 if config['stage'] == 'calibrate' else 900000), 'budget')
    root, control = ARTIFACT_PARENT + '/' + match[1], CONTROL_PARENT + '/' + match[1]
    role = {'calibrate': 'producer', 'import': 'producer', 'verify': 'verifier', 'finalize': 'finalizer'}[config['stage']]
    authority_name = {'producer': 'prepared-configs.json', 'verifier': 'db-readonly.json', 'finalizer': 'ledger-authority.json'}[role]
    authority = json.loads(read(control + '/' + authority_name, 1048576))
    config_hash = hashlib.sha256(raw).hexdigest()
    if role == 'producer':
        require(authority.get('version') == 1 and authority.get('nonce') == match[1] and
                authority.get('configs', {}).get(match[2]) == config_hash, 'config_pin')
    else:
        require(authority.get('version') == 2 and authority.get('nonce') == match[1] and
                authority.get('role') == role and authority.get('request_nonce') == request and
                authority.get('config_relative') == match[2] and authority.get('credential_ref') == config_hash,
                'config_pin')
    for name, key in [('segmented-runner.mjs', 'runnerSha256'), ('source-reader.py', 'sourceReaderSha256'),
                      ('segmented-authority.mjs', 'authorityModuleSha256')]:
        require(re.fullmatch(r'[a-f0-9]{64}', config.get(key, '')) and
                hashlib.sha256(read(root + '/' + name, 2097152)).hexdigest() == config[key], 'code_pin')
    header = json.loads(read(control + '/invocations/' + request + '-' + role + '.request.json', 1048576))
    full_argv = [os.path.realpath(sys.executable), root + '/launch-segmented-postgres-preservation.py', path]
    require(header.get('unit') == 'radar-rehearsal-' + match[1] + '-' + role + '-' + request + '.service' and
            header.get('role') == role and header.get('request_nonce') == request and
            header.get('command_sha256') == hashlib.sha256(canonical(full_argv)).hexdigest(), 'managed_command')
    require(header.get('version') == 1 and re.fullmatch(r'[a-f0-9]{64}', header.get('record_sha256', '')) and
            type(header.get('deadline')) is int and type(header.get('policy', {}).get('runtime_seconds')) is int and
            1 <= header['policy']['runtime_seconds'] <= (180 if config['stage'] == 'calibrate' else 900), 'managed_budget')
    clipped = min(header['deadline'] * 1000 - 25000, now + header['policy']['runtime_seconds'] * 1000, now + timeout)
    require(clipped > now + 10000, 'managed_clipped_budget')
    output = control + '/receipts/' + (request + '/' if role != 'producer' else '') + request + '-' + config['stage'] + '.json'
    argv = ['/usr/bin/ionice', '-c', '3', '/usr/bin/nice', '-n', '19', NODE_PATH,
            '--max-old-space-size=96', '--expose-gc', root + '/segmented-runner.mjs', path]
    return (argv, output, clipped) if include_budget else (argv, output)


def verify_node():
    import array
    import fcntl
    def flags(fd):
        value = array.array('I', [0]); fcntl.ioctl(fd, 0x80086601, value, True)
        return value[0]
    cursor = os.path.dirname(NODE_PATH)
    while cursor != '/':
        info = os.lstat(cursor)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'runtime_ancestor')
        cursor = os.path.dirname(cursor)
    directory = os.open(os.path.dirname(NODE_PATH), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    began = time.monotonic()
    try:
        require(flags(directory) & 0x10, 'runtime_directory_immutable')
        fd = os.open(NODE_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0 and before.st_nlink == 1 and not before.st_mode & 0o077 and before.st_mode & 0o100 and before.st_size == NODE_SIZE, 'runtime_owner_size')
        require(flags(fd) & 0x10, 'runtime_immutable')
        value = hashlib.sha256(); total = 0
        while True:
            require(time.monotonic() - began < 10, 'runtime_deadline')
            raw = os.read(fd, 65536)
            if not raw: break
            total += len(raw); require(total <= NODE_SIZE, 'runtime_size'); value.update(raw)
        after, current = os.fstat(fd), os.lstat(NODE_PATH)
        keys = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_nlink', 'st_mtime_ns', 'st_ctime_ns')
        require(all(getattr(before, k) == getattr(after, k) == getattr(current, k) for k in keys), 'runtime_race')
        require(total == NODE_SIZE and value.hexdigest() == NODE_SHA256, 'runtime_digest')
        return NODE_PATH
    finally:
        if fd is not None: os.close(fd)
        os.close(directory)

def spawn_pinned(argv):
    import subprocess
    child = None
    try:
        child = subprocess.Popen(argv, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1'})
        return child, os.pidfd_open(child.pid)
    except BaseException:
        if child is not None:
            # No pidfd authority: await actual exit, or managed whole-cgroup kill.
            # Never signal a numeric PID or report retirement from local exit.
            while child.poll() is None:
                try: child.wait(timeout=0.1)
                except subprocess.TimeoutExpired: pass
        raise

def main():
    require(os.geteuid() == 0, 'root')
    verify_node()
    argv, output, deadline_ms = launch_spec(sys.argv[1:], include_budget=True)
    directory = os.path.dirname(output)
    cursor = directory
    while cursor != '/':
        info = os.lstat(cursor)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, 'output_ancestor')
        cursor = os.path.dirname(cursor)
        if cursor == '/var/lib':
            break
    require(os.path.realpath(directory) == directory, 'output_path')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.dup2(fd, 1)
    if fd != 1:
        os.close(fd)
    null = os.open('/dev/null', os.O_RDWR)
    os.dup2(null, 0)
    os.dup2(null, 2)
    if null > 2:
        os.close(null)
    import signal
    import subprocess
    until = time.monotonic() + (deadline_ms - time.time() * 1000) / 1000
    # Initialization failure cannot return while an unpinned child remains alive.
    child, pidfd = spawn_pinned(argv)
    peak, minimum_memory, minimum_disk, maximum_psi = 0, 2 ** 63, 2 ** 63, 0.0
    started = time.monotonic()
    try:
        group = [line.split(':', 2)[2].strip() for line in open('/proc/self/cgroup') if line.startswith('0::')]
        require(len(group) == 1 and group[0].startswith('/') and '..' not in group[0].split('/'), 'resource_cgroup')
        memory_path = '/sys/fs/cgroup' + group[0] + '/memory.current'
        while child.poll() is None:
            used = int(open(memory_path).read().strip())
            available = next(int(line.split()[1]) * 1024 for line in open('/proc/meminfo') if line.startswith('MemAvailable:'))
            space = os.statvfs('/tmp/radar_rehearsal_' + sys.argv[1].split('/')[-2] + '/data')
            disk = space.f_bavail * space.f_frsize
            psi = float(next(part.split('=')[1] for line in open('/proc/pressure/memory') if line.startswith('some ') for part in line.split() if part.startswith('avg10=')))
            peak, minimum_memory, minimum_disk, maximum_psi = max(peak, used), min(minimum_memory, available), min(minimum_disk, disk), max(maximum_psi, psi)
            require(time.monotonic() < until and time.time() * 1000 < deadline_ms and used <= 268435456 and
                    available >= 1073741824 and disk >= 5368709120 and psi <= 1, 'resource_bound')
            time.sleep(0.1)
        require(child.wait(timeout=10) == 0 and peak > 0, 'child_exit')
        evidence = {'version': 1, 'peakMemoryBytes': peak, 'minimumAvailableMemoryBytes': minimum_memory,
                    'minimumFreeBytes': minimum_disk, 'maximumMemoryPsiAvg10': maximum_psi,
                    'elapsedMs': int((time.monotonic() - started) * 1000), 'deadlineAtMs': deadline_ms}
        resource_fd = os.open(output + '.resources.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            raw = canonical(evidence)
            require(os.write(resource_fd, raw) == len(raw), 'resource_write')
            os.fsync(resource_fd)
        finally:
            os.close(resource_fd)
    except BaseException:
        # No numeric PID/PGID signalling after poll/wait; descendants are stopped by the managed unit.
        for kind, seconds in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            try:
                signal.pidfd_send_signal(pidfd, kind)
                child.wait(timeout=seconds)
                break
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
        raise
    finally:
        os.close(pidfd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit(1)

# Imported by the protected controller after measured unit retirement, never by the workload.
MAX_PROOF_BYTES = 4 * 1024 * 1024


def rename_noreplace(directory_fd, source, destination):
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    require(rename is not None, 'atomic_publish_unavailable')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(directory_fd, source.encode(), directory_fd, destination.encode(), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def proof_binding(value):
    keys = {'nonce', 'request_nonce', 'stage', 'record_sha256', 'unit', 'invocation_id',
            'control_group', 'cgroup_identity', 'config_sha256', 'runner_sha256', 'source_reader_sha256'}
    require(type(value) is dict and set(value) == keys, 'proof_binding')
    require(re.fullmatch(r'[a-f0-9]{16}', value['nonce']) and
            re.fullmatch(r'[a-f0-9]{16}', value['request_nonce']) and
            value['stage'] in ('import', 'verify', 'finalize'), 'proof_binding')
    role = {'import': 'producer', 'verify': 'verifier', 'finalize': 'finalizer'}[value['stage']]
    require(value['unit'] == 'radar-rehearsal-' + value['nonce'] + '-' + role + '-' + value['request_nonce'] + '.service' and
            re.fullmatch(r'[a-f0-9]{32}', value['invocation_id']) and value['invocation_id'] != '0' * 32 and
            isinstance(value['control_group'], str) and value['control_group'].startswith('/') and
            value['control_group'] != '/' and os.path.normpath(value['control_group']) == value['control_group'] and
            all(part not in ('', '.', '..') for part in value['control_group'].split('/')[1:]), 'proof_unit')
    require(type(value['cgroup_identity']) is list and len(value['cgroup_identity']) == 2 and
            all(type(v) is int and v >= 0 for v in value['cgroup_identity']), 'proof_cgroup')
    require(all(re.fullmatch(r'[a-f0-9]{64}', value[k]) for k in
                ('record_sha256', 'config_sha256', 'runner_sha256', 'source_reader_sha256')), 'proof_pins')
    return value['request_nonce'] + '-' + value['stage'] + '.proof.json'


def proof_bytes(body, binding):
    proof_binding(binding)
    require(type(body) is dict and body.get('version') == 2 and body.get('stage') == binding['stage'] and
            body.get('requestNonce') == binding['request_nonce'] and body.get('productionAuthorized') is False and
            body.get('grantsBusinessEligibility') is False, 'proof_content_binding')
    require(body.get('parityComplete') is (binding['stage'] == 'finalize'), 'proof_completion')
    raw = canonical(body)
    value = {'version': 1, 'binding': binding, 'body_sha256': hashlib.sha256(raw).hexdigest(), 'body': body}
    envelope = canonical(value)
    require(0 < len(envelope) <= MAX_PROOF_BYTES, 'proof_size')
    return envelope


def publish_proof_at(directory_fd, body, binding, *, expected_uid=0, atomic_publish=rename_noreplace):
    """Caller holds the verified permanent control writer lock; never overwrites evidence."""
    import secrets
    name = proof_binding(binding)
    directory = os.fstat(directory_fd)
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == expected_uid and
            stat.S_IMODE(directory.st_mode) == 0o700, 'proof_directory')
    raw = proof_bytes(body, binding)
    temporary = '.' + name + '-' + secrets.token_hex(8) + '.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=directory_fd)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == expected_uid and info.st_nlink == 1 and
                stat.S_IMODE(info.st_mode) == 0o600, 'proof_file')
        offset = 0
        while offset < len(raw):
            written = os.write(fd, raw[offset:])
            require(written > 0, 'proof_write')
            offset += written
        os.fsync(fd)
        after = os.fstat(fd)
        path_info = os.stat(temporary, dir_fd=directory_fd, follow_symlinks=False)
        require((after.st_dev, after.st_ino) == (path_info.st_dev, path_info.st_ino) and
                after.st_size == len(raw) and after.st_nlink == 1, 'proof_write_race')
        # Linux RENAME_NOREPLACE atomically publishes a single-link inode. No rename/link fallback.
        atomic_publish(directory_fd, temporary, name)
        os.fsync(directory_fd)
        return {'name': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    finally:
        os.close(fd)
        # Do not delete any final or temporary evidence on failure.


def read_proof_at(directory_fd, name, expected_binding, expected_sha256, *, expected_uid=0):
    require(name == proof_binding(expected_binding) and re.fullmatch(r'[a-f0-9]{64}', expected_sha256), 'proof_reference')
    directory = os.fstat(directory_fd)
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == expected_uid and
            stat.S_IMODE(directory.st_mode) == 0o700, 'proof_directory')
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == expected_uid and before.st_nlink == 1 and
                stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= MAX_PROOF_BYTES, 'proof_file')
        chunks, size = [], 0
        while True:
            part = os.read(fd, min(65536, MAX_PROOF_BYTES + 1 - size))
            if not part:
                break
            chunks.append(part)
            size += len(part)
            require(size <= MAX_PROOF_BYTES, 'proof_size')
        raw = b''.join(chunks)
        after = os.fstat(fd)
        path_info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (before.st_dev, before.st_ino) == (path_info.st_dev, path_info.st_ino) and
                after.st_nlink == 1 and hashlib.sha256(raw).hexdigest() == expected_sha256, 'proof_read_race_or_pin')
        value = json.loads(raw)
        require(type(value) is dict and set(value) == {'version', 'binding', 'body_sha256', 'body'} and
                value['version'] == 1 and value['binding'] == expected_binding and canonical(value) == raw and
                value['body_sha256'] == hashlib.sha256(canonical(value['body'])).hexdigest() and
                proof_bytes(value['body'], expected_binding) == raw, 'proof_content_binding')
        return value['body']
    finally:
        os.close(fd)


def publish_measured_stage_proof(helper, record, request_nonce, stage):
    """Actual fixed-helper unit/cgroup queries gate publication; no retired=True input."""
    require(stage in ('import', 'verify', 'finalize'), 'proof_stage')
    role = {'import': 'producer', 'verify': 'verifier', 'finalize': 'finalizer'}[stage]
    expected = record['artifacts']['control']
    with helper.control_scope(record['nonce'], expected=expected) as (control, _, _):
        header, _ = helper.invocation_file(control, request_nonce, role, 'request')
        managed, _ = helper.invocation_file(control, request_nonce, role, 'binding')
        require(header['record_sha256'] == helper.digest(helper.canonical(record)) and
                managed['record_sha256'] == header['record_sha256'] and
                managed['request_nonce'] == request_nonce and managed['role'] == role and
                managed['unit'] == helper.unit_name(record['nonce'], role, request_nonce), 'proof_managed_binding')
        with helper.ManagedCgroupProof(managed) as cgroup:
            require(helper.terminal_empty(helper.SystemdBackend(record), record, managed, cgroup), 'proof_retirement_unresolved')
        root = os.open(record['artifacts']['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        receipts = os.open('receipts', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=control)
        try:
            helper.root_directory(receipts)
            output_fd = os.dup(receipts) if role == 'producer' else os.open(request_nonce, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=receipts)
            try:
                helper.root_directory(output_fd)
                raw, _ = helper.read_at(output_fd, request_nonce + '-' + stage + '.json', 0, limit=MAX_PROOF_BYTES)
                resource_raw, _ = helper.read_at(output_fd, request_nonce + '-' + stage + '.json.resources.json', 0, limit=16384)
                resources = json.loads(resource_raw)
                require(resources['version'] == 1 and 0 < resources['peakMemoryBytes'] <= 268435456 and
                        resources['minimumAvailableMemoryBytes'] >= 1073741824 and resources['minimumFreeBytes'] >= 5368709120 and
                        0 <= resources['maximumMemoryPsiAvg10'] <= 1 and 0 <= resources['elapsedMs'] <= 900000, 'proof_resources')
            finally:
                os.close(output_fd)
            body = json.loads(raw)
            body['resources'] = resources
            metrics = body.get('nativeMetrics', {})
            require(all(type(metrics.get(k)) is int and 0 <= metrics[k] <= 1000000 for k in
                        ('physicalSqlStatements', 'commitAttempts', 'acknowledgedCommits', 'acknowledgedRollbacks')) and
                    metrics.get('uncertainCommit') is False and metrics['commitAttempts'] == metrics['acknowledgedCommits'], 'proof_native_ack')
            if stage == 'finalize':
                require(body.get('result', {}).get('completed') is True and
                        body['result'].get('completionOutcome') in ('acknowledged', 'reconciled'), 'proof_native_completion')
            else:
                require(body.get('result', {}).get('completed') is not True, 'proof_premature_completion')
            require(header['code_name'] == 'launch-segmented-postgres-preservation.py', 'proof_entry')
            # Native launcher argv is EXACT3; config provenance is bound to the protected request header.
            configs = [name for name in record['artifacts']['code_pins'] if name == header['code_name']]
            require(configs == [header['code_name']], 'proof_registered_entry')
            config_ref = body.get('configRelative')
            require(isinstance(config_ref, str) and re.fullmatch(r'[A-Za-z0-9_-]+\.json', config_ref), 'proof_config_reference')
            config_raw, config_pin = helper.artifact_file(root, config_ref)
            config = json.loads(config_raw)
            argv = [header['execution_pin']['path'], record['artifacts']['root'] + '/' + header['code_name'], record['artifacts']['root'] + '/' + config_ref]
            require(header['command_sha256'] == helper.digest(helper.canonical(argv)) and
                    config['nonce'] == record['nonce'] and config['stage'] == stage and
                    config['invocation']['requestNonce'] == request_nonce and
                    body.get('configSha256') == config_pin['sha256'], 'proof_command_binding')
            binding = {'nonce': record['nonce'], 'request_nonce': request_nonce, 'stage': stage,
                       'record_sha256': header['record_sha256'], 'unit': managed['unit'],
                       'invocation_id': managed['invocation_id'], 'control_group': managed['control_group'],
                       'cgroup_identity': managed['identity'], 'config_sha256': config_pin['sha256'],
                       'runner_sha256': config['runnerSha256'], 'source_reader_sha256': config['sourceReaderSha256']}
            require(binding['runner_sha256'] == record['artifacts']['code_pins']['segmented-runner.mjs']['sha256'] and
                    binding['source_reader_sha256'] == record['artifacts']['code_pins']['source-reader.py']['sha256'], 'proof_code_binding')
            return publish_proof_at(receipts, body, binding)
        finally:
            os.close(receipts)
            os.close(root)


def publish_authority(helper, record, raw):
    """Only a measured native controller produces raw; helper revalidates fixed ACL and pins."""
    proof = json.loads(raw)
    require(canonical(proof) == raw and proof.get('version') == 2 and proof.get('nonce') == record['nonce'] and
            proof.get('record_sha256') == helper.digest(helper.canonical(record)) and
            proof.get('role') in ('verifier', 'finalizer'), 'authority_binding')
    name = 'db-readonly.json' if proof['role'] == 'verifier' else 'ledger-authority.json'
    with helper.control_scope(record['nonce'], expected=record['artifacts']['control']) as (control, _, _):
        state = helper.read_control_state(control, record)
        require(state['phase'] == 'sealed', 'authority_unsealed')
        helper.clear_quiescent_producer(control, record, state)
        with helper.artifact_scope(record['artifacts']['root'], record['nonce'], expected=record['artifacts']) as (root, _):
            require(helper.manifest_digest(helper.tree_manifest(root, 0, artifacts=True)) == state['snapshot_sha256'], 'authority_artifact_mutation')
            helper.write_control_file(control, name, raw, replace=True)
            argv = [proof['entry']['execution_pin']['path'], record['artifacts']['root'] + '/' + proof['entry']['code_relative'],
                    record['artifacts']['root'] + '/' + proof['config_relative']]
            helper.database_authority(control, root, record, helper.digest(raw), proof['role'], argv, proof['request_nonce'])
    return {'name': name, 'sha256': helper.digest(raw)}


def run_managed_stage(helper, record_path, record_sha256, nonce, config_path, runtime_seconds, authority_sha256=None):
    record = helper.load_record(record_path, record_sha256, nonce)
    root = record['artifacts']['root']
    require(re.fullmatch(re.escape(root) + r'/[A-Za-z0-9_-]+\.json', config_path), 'managed_config_path')
    config = json.loads(protected_bytes(config_path, 1048576))
    stage, request = config['stage'], config['invocation']['requestNonce']
    require(config['nonce'] == nonce and stage in ('import', 'verify', 'finalize') and
            type(runtime_seconds) is int and 11 <= runtime_seconds <= 900, 'managed_stage')
    args = (nonce, record_path, record_sha256, request)
    lease = helper.managed_producer_lease(*args) if stage in ('calibrate', 'import') else (
        helper.managed_verifier_lease(*args, db_readonly_sha256=authority_sha256) if stage == 'verify' else
        helper.managed_finalizer_lease(*args, ledger_authority_sha256=authority_sha256))
    argv = ['/usr/bin/python3', root + '/launch-segmented-postgres-preservation.py', config_path]
    with lease as admitted:
        mapping = {'version': 1, 'nonce': nonce, 'record_sha256': record_sha256, 'request_nonce': request,
                   'role': 'producer' if stage in ('calibrate', 'import') else 'verifier' if stage == 'verify' else 'finalizer'}
        # The caller publishes the parent invocation mapping before starting a unit.
        admitted.start_approved_unit(argv, runtime_seconds=runtime_seconds, memory_max_bytes=268435456,
                                     tasks_max=64, cpu_quota_percent=50)
        admitted.wait_terminal_and_empty()
    proof = publish_measured_stage_proof(helper, record, request, stage)
    if stage == 'verify':
        with helper.control_scope(nonce, expected=record['artifacts']['control']) as (control, _, _):
            try:
                raw, _ = helper.read_at(control, 'proof-journal.json', 0, limit=helper.MAX_RECORD)
                journal = json.loads(raw)
            except FileNotFoundError:
                journal = {'version': 1, 'nonce': nonce, 'recordSha256': record_sha256, 'proofs': []}
            require(journal['nonce'] == nonce and journal['recordSha256'] == record_sha256 and
                    all(p['requestNonce'] != request for p in journal['proofs']), 'proof_journal_duplicate')
            journal['proofs'].append(dict(proof, requestNonce=request))
            replace_journal_at(control, canonical(journal))
    with helper.control_scope(nonce, expected=record['artifacts']['control']) as (control, _, _):
        receipts = os.open('receipts', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=control)
        try:
            envelope_raw, _ = helper.read_at(receipts, proof['name'], 0, limit=MAX_PROOF_BYTES)
            require(hashlib.sha256(envelope_raw).hexdigest() == proof['sha256'], 'published_proof_pin')
            envelope = json.loads(envelope_raw)
            body = read_proof_at(receipts, proof['name'], envelope['binding'], proof['sha256'])
        finally:
            os.close(receipts)
    return dict(proof, report=body)


def replace_journal_at(control, raw):
    """The verified helper writer lock serializes this bounded mutable index; proofs stay immutable."""
    import secrets
    info = os.fstat(control)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700 and
            0 < len(raw) <= 1048576, 'journal_directory_or_size')
    temporary = '.proof-journal-' + secrets.token_hex(8)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=control)
    try:
        offset = 0
        while offset < len(raw):
            written = os.write(fd, raw[offset:]); require(written > 0, 'journal_write'); offset += written
        os.fsync(fd)
        os.rename(temporary, 'proof-journal.json', src_dir_fd=control, dst_dir_fd=control)
        os.fsync(control)
    finally:
        os.close(fd)
