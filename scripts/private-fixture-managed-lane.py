#!/usr/bin/env python3
"""Explicit sealed private-PG5434 CUD lane; verifier describes only OS sandbox.

Reuses frozen lifecycle lock/state/cgroup/receipt proofs. It does not use or
fabricate a readonly DB authority. Trusted root approves the exact authority
record/hash and measured collector bytes; arbitrary commands are never admitted.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import time


class Refused(Exception):
    pass


def require(value, reason):
    if not value:
        raise Refused(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def protected_bytes(path, maximum=1024 * 1024):
    require(os.path.isabs(path) and os.path.normpath(path) == path, 'protected-path')
    until = time.monotonic() + 5
    parents = []
    parent = os.path.dirname(path)
    while True:
        require(time.monotonic() < until, 'protected-deadline')
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not stat.S_IMODE(info.st_mode) & 0o022, 'protected-parent')
        parents.append((parent, (info.st_dev, info.st_ino)))
        if parent == '/':
            break
        parent = os.path.dirname(parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not stat.S_IMODE(before.st_mode) & 0o022 and before.st_size <= maximum, 'protected-file')
        parts, amount = [], 0
        while True:
            require(time.monotonic() < until, 'protected-deadline')
            part = os.read(fd, min(65536, maximum + 1 - amount))
            if not part:
                break
            amount += len(part)
            require(amount <= maximum, 'protected-bound')
            parts.append(part)
        metadata = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns,
                              v.st_ctime_ns, v.st_uid, v.st_mode, v.st_nlink)
        require(metadata(before) == metadata(os.fstat(fd)) == metadata(os.lstat(path)), 'protected-mutated')
        for name, pin in parents:
            live = os.lstat(name)
            require(stat.S_ISDIR(live.st_mode) and live.st_uid == 0
                    and not stat.S_IMODE(live.st_mode) & 0o022
                    and (live.st_dev, live.st_ino) == pin, 'protected-parent-replaced')
        return b''.join(parts)
    finally:
        os.close(fd)


def load_expiry(path, expected_sha256):
    require(re.fullmatch('[a-f0-9]{64}', expected_sha256), 'expiry-code-pin')
    raw = protected_bytes(path)
    require(hashlib.sha256(raw).hexdigest() == expected_sha256, 'expiry-code-pin')
    spec = importlib.util.spec_from_loader('pinned_private_lane_expiry', loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = path
    exec(compile(raw, path, 'exec'), module.__dict__)
    return module


def authority(path, expected_sha256):
    require(re.fullmatch('[a-f0-9]{64}', expected_sha256), 'authority-pin')
    raw = protected_bytes(path, 65536)
    require(hashlib.sha256(raw).hexdigest() == expected_sha256, 'authority-pin')
    require(stat.S_IMODE(os.lstat(path).st_mode) == 0o600
            and stat.S_IMODE(os.lstat(os.path.dirname(path)).st_mode) == 0o700, 'private-authority')
    value = json.loads(raw)
    require(raw == canonical(value), 'authority-canonical')
    return value


def validate_authority(value, record, request_nonce):
    require(set(value) == {'version', 'lane', 'nonce', 'requestNonce', 'expiryRecordSha256',
                          'expiresAt', 'runtime', 'controlData', 'launcherName', 'laneName', 'jobName',
                          'jobPayloadSha256', 'targets', 'limits'}, 'authority-schema')
    require(value['version'] == 1 and value['lane'] == 'private-pg5434-cud'
            and value['nonce'] == record['nonce'] and value['requestNonce'] == request_nonce
            and re.fullmatch('[a-f0-9]{16}', request_nonce)
            and value['expiryRecordSha256'] == hashlib.sha256(canonical(record)).hexdigest()
            and type(value['expiresAt']) is int and record['created_at'] < value['expiresAt'] <= record['deadline'],
            'authority-binding')
    root = record['artifacts']['root']
    require(root == '/var/lib/address-radar-rehearsal-artifacts/' + record['nonce'], 'artifact-root')
    for key in ('launcherName', 'laneName'):
        name = value[key]
        require(type(name) is str and re.fullmatch('[A-Za-z0-9_.-]+', name)
                and name in record['artifacts']['code_pins'], 'registered-entry')
    require(type(value['jobName']) is str and re.fullmatch('[A-Za-z0-9_.-]+', value['jobName'])
            and re.fullmatch('[a-f0-9]{64}', value['jobPayloadSha256']), 'registered-job')
    require(set(value['runtime']) == {'path', 'sha256'} and os.path.isabs(value['runtime']['path'])
            and re.fullmatch('[a-f0-9]{64}', value['runtime']['sha256']), 'registered-runtime')
    require(type(value['targets']) is list and 1 <= len(value['targets']) <= 2, 'targets')
    prefix = 'radar_rehearsal_' + record['nonce']
    for target in value['targets']:
        require(set(target) == {'database', 'schema', 'role', 'systemIdentifier', 'serverAddress', 'serverPort'}, 'target-schema')
        require(target['serverAddress'] == '127.0.0.1' and target['serverPort'] == 5434
                and target['systemIdentifier'] == record['system_identifier'], 'target-server')
        for key in ('database', 'schema', 'role'):
            require(type(target[key]) is str and re.fullmatch(re.escape(prefix) + '(?:_[a-z]+)?', target[key]), 'target-nonce')
        require(target['role'] != 'postgres' and target['schema'] not in ('public', 'pg_catalog'), 'target-role')
    require(set(value['controlData']) == {'path', 'sha256'}
            and value['controlData']['path'] == '/usr/lib/postgresql/16/bin/pg_controldata'
            and re.fullmatch('[a-f0-9]{64}', value['controlData']['sha256']), 'control-data-pin')
    limits = value['limits']
    require(set(limits) == {'runtime_seconds', 'memory_max_bytes', 'tasks_max', 'cpu_quota_percent'}
            and all(type(item) is int for item in limits.values())
            and 1 <= limits['runtime_seconds'] <= 1800
            and 64 * 1024 ** 2 <= limits['memory_max_bytes'] <= 256 * 1024 ** 2
            and 1 <= limits['tasks_max'] <= 32 and 1 <= limits['cpu_quota_percent'] <= 100, 'lane-limits')
    return [value['runtime']['path'], root + '/' + value['launcherName'],
            '--job', root + '/' + value['jobName']]


def validate_job_binding(job, approved, record, request_nonce):
    payload = dict(job)
    payload.pop('privateFixtureAuthoritySha256', None)
    require(hashlib.sha256(canonical(payload)).hexdigest() == approved['jobPayloadSha256'], 'job-payload-pin')
    require(job['privateFixtureAuthoritySha256'] == approved['_sha256']
            and job['managedRequestNonce'] == request_nonce and job['fixture']['nonce'] == record['nonce']
            and job['expiryRecordSha256'] == approved['expiryRecordSha256'], 'collector-job-binding')
    require(len(approved['targets']) == 2, 'compatibility-targets')
    for item, target in zip((job['candidate'], job['compatible']), approved['targets']):
        raw = protected_bytes(item['optionsPath'], 65536)
        require(hashlib.sha256(raw).hexdigest() == item['optionsSha256'], 'credential-config-pin')
        options = json.loads(raw)
        actual = options['target']
        require(actual['database'] == target['database'] and actual['schema'] == target['schema']
                and actual['username'] == target['role'], 'credential-target')
    # The measured native Node entry validates URL, actual session/SET reachability
    # and private postmaster identity before the first rehearsal CUD operation.


def capture_fixture(expiry, record, control_data, until):
    """Outside-root readonly measurement; no privileged SQL or secrets in argv."""
    require(time.monotonic() < until, 'lane-budget')
    require(control_data['path'] == '/usr/lib/postgresql/16/bin/pg_controldata'
            and re.fullmatch('[a-f0-9]{16}', record['nonce'])
            and record['root'] == '/tmp/radar_rehearsal_' + record['nonce'], 'private-control-data-scope')
    pin = expiry.root_path_pin(control_data['path'])
    require(pin['sha256'] == control_data['sha256'], 'control-data-pin')
    with expiry.fixture(record) as (root, data):
        require(expiry.check_identity(record, root, data) == record['process_ticks'], 'private-postmaster-required')
        result = subprocess.run([control_data['path'], '-D', record['root'] + '/data'],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=min(2, max(0.001, until - time.monotonic())), cwd='/',
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                                user=record['uid'], group=record['gid'], extra_groups=[])
        require(time.monotonic() < until and result.returncode == 0 and len(result.stdout) <= 65536, 'control-data-read')
        identifiers = re.findall(rb'^Database system identifier:\s*([0-9]+)\s*$', result.stdout, re.M)
        require(len(identifiers) == 1 and identifiers[0].decode() == record['system_identifier'], 'private-system-identity')
        require(expiry.check_identity(record, root, data) == record['process_ticks'], 'private-postmaster-required')
    return dict(version=1, nonce=record['nonce'], record_sha256=hashlib.sha256(canonical(record)).hexdigest(),
                pid=record['pid'], process_ticks=record['process_ticks'], uid=record['uid'],
                root_identity=record['root_identity'], data_identity=record['data_identity'],
                system_identifier=record['system_identifier'], port=5434)


def exec_registered(argv, binding):
    invocation = binding['invocation_id']
    require(type(invocation) is str and re.fullmatch('[a-f0-9]{32}', invocation)
            and invocation == os.environ.get('INVOCATION_ID'), 'lane-invocation-env')
    os.execve(argv[0], argv, {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
                            'INVOCATION_ID': invocation})


def publish_fixture(expiry, control, record, request, control_data, until):
    require(re.fullmatch('[a-f0-9]{16}', request), 'fixture-request')
    proof = dict(capture_fixture(expiry, record, control_data, until), request_nonce=request)
    raw = canonical(proof)
    directory = expiry.invocation_directory(control)
    try:
        # Frozen write_control_file uses O_EXCL: request reuse never overwrites proof.
        expiry.write_control_file(directory, request + '-verifier.fixture.json', raw)
    finally:
        os.close(directory)
    return proof, hashlib.sha256(raw).hexdigest()


def verify_terminal_fixture(expiry, control, record, request, control_data, until, binding):
    proof, digest = expiry.invocation_file(control, request, 'verifier', 'fixture')
    expected = binding['private_fixture_process_receipt_sha256']
    require(digest == expected and hashlib.sha256(canonical(proof)).hexdigest() == expected
            and proof['request_nonce'] == request, 'fixture-receipt-mutated')
    measured = dict(capture_fixture(expiry, record, control_data, until), request_nonce=request)
    require(canonical(measured) == canonical(proof), 'fixture-terminal-mutated')


@contextlib.contextmanager
def private_fixture_managed_lease(expiry, nonce, record_path, record_sha256, request_nonce,
                                  authority_path, authority_sha256):
    operation_started = time.monotonic()
    expiry.trusted_runtime()
    record = expiry.load_record(record_path, record_sha256, nonce)
    approved = authority(authority_path, authority_sha256)
    argv = validate_authority(approved, record, request_nonce)
    raw_job = protected_bytes(argv[3], 65536)
    job = json.loads(raw_job)
    require(raw_job == canonical(job), 'job-canonical')
    validate_job_binding(job, dict(approved, _sha256=authority_sha256), record, request_nonce)
    argv += ['--job-sha256', hashlib.sha256(raw_job).hexdigest()]
    with expiry.control_scope(nonce, expected=record['artifacts']['control']) as (control, lock, _):
        state = expiry.read_control_state(control, record)
        require(state['phase'] == 'sealed' and state['artifacts'] == 'present', 'sealed-required')
        state = expiry.clear_quiescent_producer(control, record, state)
        require(state['producer'] is None, 'lane-busy')
        with expiry.artifact_scope(record['artifacts']['root'], nonce, expected=record['artifacts']) as (root, _):
            require(expiry.manifest_digest(expiry.tree_manifest(root, 0, artifacts=True)) == state['snapshot_sha256'], 'sealed-mutated')
            class PrivateFixtureLease(expiry.ManagedUnitLease):
                lane = 'private-pg5434-cud'
                def start_approved_unit(self, requested_argv, **limits):
                    require(list(requested_argv) == argv and limits == approved['limits'] and not self.started, 'registered-command')
                    original = operation_started
                    now = time.time()
                    require(record['created_at'] <= now < min(record['deadline'], approved['expiresAt']), 'lane-expired')
                    runtime = limits['runtime_seconds']
                    reserve = expiry.UNIT_STOP_SECONDS + expiry.UNIT_PROOF_SECONDS + expiry.UNIT_LAUNCH_SECONDS
                    self.until = min(original + runtime + reserve, time.monotonic() + record['deadline'] - now,
                                     time.monotonic() + approved['expiresAt'] - now)
                    execution = expiry.root_path_pin(argv[0])
                    require(execution['sha256'] == approved['runtime']['sha256'], 'runtime-pin')
                    expiry.artifact_proof(root, record['artifacts'])
                    own = record['artifacts']['root'] + '/' + approved['laneName']
                    require(os.path.realpath(__file__) == own, 'lane-entry-path')
                    job_raw = protected_bytes(argv[3], 65536)
                    require(hashlib.sha256(job_raw).hexdigest() == argv[5], 'job-pin')
                    job = json.loads(job_raw)
                    validate_job_binding(job, dict(approved, _sha256=authority_sha256), record, request_nonce)
                    policy = dict(limits, receipt_directory=expiry.managed_receipt_directory(record, self.unit, 'verifier'))
                    receipt_identity = expiry.create_managed_receipt_directory(control, request_nonce)
                    _, fixture_sha256 = publish_fixture(expiry, control, record, request_nonce, approved['controlData'], self.until)
                    clipped = min(runtime, int(self.until - time.monotonic()) - reserve)
                    require(clipped >= 1, 'lane-budget')
                    policy['runtime_seconds'] = clipped
                    header = dict(version=1, unit=self.unit, role='verifier', request_nonce=request_nonce,
                                  record_sha256=record_sha256, command_sha256=expiry.digest(expiry.canonical(argv)),
                                  code_name=approved['launcherName'], execution_pin=execution, policy=policy,
                                  deadline=min(int(time.time() + self.until - time.monotonic()), record['deadline'], approved['expiresAt']),
                                  db_readonly_sha256=None, receipt_identity=receipt_identity,
                                  private_fixture_process_receipt_sha256=fixture_sha256,
                                  private_fixture_authority_sha256=authority_sha256, lane='private-pg5434-cud')
                    directory = expiry.invocation_directory(control)
                    try:
                        expiry.write_control_file(directory, request_nonce + '-verifier.request.json', expiry.canonical(header))
                    finally:
                        os.close(directory)
                    self.started = True
                    token = dict(unit=self.unit, role='verifier', request_nonce=request_nonce, phase='pending', binding_sha256=None)
                    self.state = expiry.update_control_state(control, record, self.state, dict(self.state, producer=token))
                    pins = record['artifacts']['managed']
                    for key in ('python', 'helper'):
                        require(expiry.root_path_pin(pins[key]['path']) == pins[key], 'lifecycle-pin')
                    command = [pins['python']['path'], own, '--workload', '--expiry', pins['helper']['path'],
                               '--expiry-code-sha256', pins['helper']['sha256'], '--nonce', nonce,
                               '--record', record_path, '--record-sha256', record_sha256,
                               '--request', request_nonce, '--authority', authority_path, '--authority-sha256', authority_sha256]
                    self.backend.launch_until = self.until
                    self.backend.launch_reserve = clipped + reserve
                    self.backend.launch(self.unit, command, policy, 'verifier')
                    props = self.backend.show(self.unit)
                    require(props['ActiveState'] in ('activating', 'active'), 'lane-admission')
                    fields = expiry.validate_unit_properties(props, self.unit, policy, 'verifier', record['artifacts']['root'])
                    binding = dict(header, **{key: item for key, item in fields.items() if key != 'unit'})
                    self.cgroup = expiry.ManagedCgroupProof(binding, capture=True)
                    self.binding = binding
                    expiry.managed_identity(binding, self.backend.show(self.unit), record)
                    require(self.cgroup.populated(), 'lane-admission')
                    directory = expiry.invocation_directory(control)
                    try:
                        raw = expiry.canonical(binding)
                        expiry.write_control_file(directory, request_nonce + '-verifier.binding.json', raw)
                        token = dict(token, phase='bound', binding_sha256=expiry.digest(raw))
                        self.state = expiry.update_control_state(control, record, self.state, dict(self.state, producer=token))
                        expiry.write_control_file(directory, request_nonce + '-verifier.admit.json',
                                                  expiry.canonical(dict(binding_sha256=token['binding_sha256'])))
                    finally:
                        os.close(directory)
                    require(time.monotonic() < self.until, 'lane-budget')
                    return dict(unit=self.unit, invocation_id=binding['invocation_id'],
                                proof_receipt_path=policy['receipt_directory'] + '/proof.json')
                def jobs_settled(self):
                    require(time.monotonic() < self.until, 'lane-budget')
                    result = self.backend.run('systemctl', ['show', '--no-pager', '--property=Job', self.unit], capture=True)
                    require(time.monotonic() < self.until, 'lane-budget')
                    return result.stdout == b'Job=0\n'

                def wait_terminal_and_empty(self):
                    require(self.binding is not None and self.cgroup is not None, 'lane-unresolved')
                    if self.complete:
                        return self.receipt
                    while True:
                        require(time.monotonic() < self.until, 'lane-budget')
                        if self.jobs_settled() and expiry.terminal_empty(self.backend, record, self.binding, self.cgroup) and self.jobs_settled():
                            # Retain descriptors and revalidate immediately before
                            # publishing completion; no retired/missing group proof.
                            require(expiry.terminal_empty(self.backend, record, self.binding, self.cgroup), 'lane-terminal-race')
                            verify_terminal_fixture(expiry, control, record, request_nonce,
                                                    approved['controlData'], self.until, self.binding)
                            require(self.jobs_settled() and expiry.terminal_empty(self.backend, record, self.binding, self.cgroup),
                                    'lane-terminal-race')
                            self.receipt = dict(status='quiescent', receipt_sha256=
                                                expiry.persist_managed_receipt(control, record, self.binding, 'quiescent'))
                            current = expiry.read_control_state(control, record)
                            require(current['producer']['unit'] == self.unit, 'lane-state')
                            self.state = expiry.update_control_state(control, record, current, dict(current, producer=None))
                            self.complete = True
                            return self.receipt
                        time.sleep(0.05)

            lease = PrivateFixtureLease(record, record_path, record_sha256, request_nonce,
                                        'verifier', control, root, state, None)
            try:
                yield lease
            finally:
                try:
                    require(lease.started, 'lane-not-started')
                    lease.wait_terminal_and_empty()
                    require(expiry.manifest_digest(expiry.tree_manifest(root, 0, artifacts=True)) == state['snapshot_sha256'], 'sealed-mutated')
                except BaseException:
                    if lease.started and not lease.complete:
                        expiry.FAILED_LEASE_FDS.append(os.dup(lock))
                        try:
                            lease.unresolved()
                        except Exception:
                            pass
                    raise
                finally:
                    lease.close()


def workload(args):
    expiry = load_expiry(args.expiry, args.expiry_code_sha256)
    expiry.trusted_runtime()
    record = expiry.load_record(args.record, args.record_sha256, args.nonce)
    approved = authority(args.authority, args.authority_sha256)
    argv = validate_authority(approved, record, args.request)
    raw_job = protected_bytes(argv[3], 65536)
    require(raw_job == canonical(json.loads(raw_job)), 'job-canonical')
    validate_job_binding(json.loads(raw_job), dict(approved, _sha256=args.authority_sha256), record, args.request)
    argv += ['--job-sha256', hashlib.sha256(raw_job).hexdigest()]
    control = expiry.control_reader(record)
    try:
        header, _ = expiry.invocation_file(control, args.request, 'verifier', 'request')
        require(header['lane'] == 'private-pg5434-cud' and header['db_readonly_sha256'] is None
                and header['private_fixture_authority_sha256'] == args.authority_sha256
                and header['command_sha256'] == expiry.digest(expiry.canonical(argv)), 'lane-header')
        until = time.monotonic() + min(30, max(0, min(header['deadline'], approved['expiresAt']) - time.time()))
        while True:
            require(time.monotonic() < until, 'admission-timeout')
            try:
                admit, _ = expiry.invocation_file(control, args.request, 'verifier', 'admit')
                break
            except FileNotFoundError:
                time.sleep(0.05)
        binding, pin = expiry.invocation_file(control, args.request, 'verifier', 'binding')
        require(admit == dict(binding_sha256=pin) and binding['lane'] == 'private-pg5434-cud'
                and binding['record_sha256'] == args.record_sha256
                and binding['command_sha256'] == header['command_sha256']
                and binding['private_fixture_authority_sha256'] == args.authority_sha256
                and binding['invocation_id'] == os.environ.get('INVOCATION_ID'), 'lane-binding')
        state = expiry.read_control_state(control, record)
        require(state['phase'] == 'sealed' and state['producer']['phase'] == 'bound'
                and state['producer']['unit'] == binding['unit']
                and state['producer']['role'] == 'verifier'
                and state['producer']['request_nonce'] == args.request
                and state['producer']['binding_sha256'] == pin, 'lane-state')
        with open('/proc/self/cgroup', encoding='ascii') as handle:
            require(handle.read(4097).strip() == '0::' + binding['control_group'], 'lane-membership')
        with expiry.ManagedCgroupProof(binding) as cgroup:
            require(cgroup.populated(), 'lane-membership')
        root = os.open(record['artifacts']['root'], expiry.DIRECTORY)
        try:
            expiry.artifact_proof(root, record['artifacts'])
            require(expiry.manifest_digest(expiry.tree_manifest(root, 0, artifacts=True)) == state['snapshot_sha256'], 'sealed-mutated')
            require(expiry.root_path_pin(argv[0]) == header['execution_pin'], 'runtime-pin')
            expiry.verify_managed_receipt_directory(record, binding)
            raw = protected_bytes(argv[3], 65536)
            require(hashlib.sha256(raw).hexdigest() == argv[5], 'job-pin')
            validate_job_binding(json.loads(raw), dict(approved, _sha256=args.authority_sha256), record, args.request)
            require(time.time() < min(header['deadline'], approved['expiresAt']), 'lane-expired')
            os.chdir(record['artifacts']['root'])
            exec_registered(argv, binding)
        finally:
            os.close(root)
    finally:
        os.close(control)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workload', action='store_true', required=True)
    for name in ('expiry', 'expiry-code-sha256', 'nonce', 'record', 'record-sha256', 'request', 'authority', 'authority-sha256'):
        parser.add_argument('--' + name, required=True)
    try:
        workload(parser.parse_args())
    except Exception:
        print('{"status":"private-fixture-lane-refused"}')
        sys.exit(2)
