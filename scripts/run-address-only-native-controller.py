#!/usr/bin/env python3
"""Own source isolation through a bounded address-only import and reconciliation."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import sqlite3
import stat
import subprocess
import time

ROOT = Path('/var/lib/address-radar-maintenance-tools')
MAXIMUM_BYTES = 4 * 1024 * 1024


def require(value, reason):
    if not value:
        raise ValueError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def pinned_read(pin, maximum=MAXIMUM_BYTES):
    require(isinstance(pin, dict) and set(pin) == {'path', 'sha256'}, 'invalid_pin')
    path = Path(pin['path'])
    require(path.is_absolute() and str(path) == os.path.normpath(str(path))
            and ROOT in path.parents, 'out_of_scope_pin')
    require(re.fullmatch(r'[a-f0-9]{64}', pin['sha256']), 'invalid_digest')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o022, 'unsafe_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= maximum, 'unsafe_file')
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_uid, s.st_gid,
                       s.st_mode, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)
    require(stamp(before) == stamp(after) == stamp(path.lstat())
            and len(raw) == before.st_size and digest(raw) == pin['sha256'], 'pin_changed')
    return raw


def load_module(name, pin):
    pinned_read(pin)
    spec = importlib.util.spec_from_file_location(name, pin['path'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_private(directory, name, raw):
    require(re.fullmatch(r'[a-z-]+\.json', name) and len(raw) <= MAXIMUM_BYTES, 'output_budget')
    fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {'path': str(directory / name), 'sha256': digest(raw)}


def validate_config(config):
    require(isinstance(config, dict) and set(config) == {
        'protocol', 'operationId', 'fence', 'reconcile', 'exporter', 'validator',
        'launcher', 'node', 'jobTemplate', 'outputDirectory'}, 'controller_fields')
    require(config['protocol'] == 'address-only-controller-v1'
            and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', config['operationId']), 'controller_protocol')
    output = Path(config['outputDirectory'])
    require(output.parent == ROOT and output.name == 'address-only-run-' + config['operationId'],
            'controller_output')
    job = config['jobTemplate']
    require(isinstance(job, dict) and job.get('operationId') == config['operationId']
            and job.get('action') == 'plan' and job.get('outputDirectory') == str(output)
            and job.get('sourceFence') == config['fence'], 'controller_job_binding')
    return config


def child_diagnostic(stdout, stderr, returncode, elapsed_ms, reason):
    # Never persist arbitrary child strings, exception text, arguments or credentials.
    allowed = {'address-only-native-refused-or-uncertain', 'address-only-native-import-committed',
               'address-only-native-prepared-not-imported', 'address-only-plan-hashed-not-imported'}
    value = {}
    try:
        parsed = json.loads(stdout)
        if isinstance(parsed, dict) and parsed.get('status') in allowed:
            value['status'] = parsed['status']
            diagnostic = parsed.get('diagnostic')
            stages = {'job', 'seed', 'runtime_load', 'plan', 'publication', 'fence_measure', 'credential',
                      'pg_load', 'runtime_execute', 'runtime_authority', 'import_authority', 'receipt'}
            codes = {'unknown_failure', 'job_fields', 'job_protocol', 'job_pin', 'job_output', 'activation_clock',
                     'job_target', 'job_review', 'job_budgets', 'job_numeric_budgets', 'job_budget_order',
                     'native_root_required', 'arguments', 'native_deadline', 'protected_pin', 'protected_parent',
                     'protected_file', 'protected_file_changed', 'protected_parent_changed', 'protected_digest',
                     'output_path', 'output_parent', 'private_output', 'output_budget', 'publication_already_exists',
                     'native_fence_measurement', 'fresh_credential_required', 'native_runtime_authority', 'native_import_authority',
                     'runtime_invalid_limits', 'runtime_invalid_target', 'runtime_invalid_capability', 'runtime_missing_verified_ports'}
            if isinstance(diagnostic, dict) and diagnostic.get('stage') in stages and diagnostic.get('code') in codes:
                value['diagnostic'] = {'stage': diagnostic['stage'], 'code': diagnostic['code']}
    except (ValueError, UnicodeError):
        pass
    return {'protocol': 'address-only-child-diagnostic-v1', 'returnCode': returncode,
            'elapsedMs': elapsed_ms, 'reason': reason, 'stdoutBytes': len(stdout),
            'stderrBytes': len(stderr), 'child': value, 'rawOutputPersisted': False,
            'originalExceptionAvailable': False}


def bounded_child(arguments, seconds=70, diagnostic=None):
    child = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    selector.register(child.stderr, selectors.EVENT_READ)
    started = time.monotonic()
    end, output, completed = started + seconds, bytearray(), False
    errors, reason = bytearray(), 'launcher_interrupted'
    try:
        while selector.get_map():
            remaining = end - time.monotonic()
            require(remaining > 0, 'launcher_deadline')
            for key, _ in selector.select(min(remaining, 1)):
                buffer = output if key.fileobj is child.stdout else errors
                chunk = os.read(key.fileobj.fileno(), 65537 - len(buffer))
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    buffer.extend(chunk)
                    require(len(buffer) <= 65536, 'launcher_output_budget')
        require(child.wait(timeout=max(0.001, end - time.monotonic())) == 0,
                'launcher_refused_or_uncertain')
        completed = True
        reason = 'success'
        return bytes(output)
    except ValueError as error:
        if str(error) in ('launcher_deadline', 'launcher_output_budget', 'launcher_refused_or_uncertain'):
            reason = str(error)
        raise
    finally:
        selector.close()
        if not completed:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if child.poll() is None:
                child.wait(timeout=2)
        child.stdout.close(); child.stderr.close()
        if diagnostic is not None:
            diagnostic(child_diagnostic(bytes(output), bytes(errors), child.returncode,
                                        int((time.monotonic() - started) * 1000), reason))


def reconcile_failed_import(fence, reconcile):
    if fence.state['phase'] == 'IMPORT_COMMITTED':
        fence.reconcile_committed_import(reconcile.reconcile_import)
        fence.measure()
        return True
    if fence.state['phase'] == 'IMPORT_INTENT':
        fence.deadline = type(fence.deadline)(120)
        with reconcile.reconcile_import(fence.state['binding'], fence.deadline) as outcome:
            outcome['assert_alive_and_locked']()
            committed = outcome['committedMatches']
        if committed:
            fence.reconcile_committed_import(reconcile.reconcile_import)
            return True
    if fence.state['phase'] not in ('IMPORT_COMMITTED', 'RESTORED'):
        fence.restore_before_import(reconcile.reconcile_import)
    return fence.state['phase'] == 'IMPORT_COMMITTED'


def execute(config):
    require(os.geteuid() == 0, 'native_root_required')
    config = validate_config(config)
    for key in ('launcher', 'node'):
        pinned_read(config[key], 128 * 1024 * 1024)
    fence_module = load_module('address_only_fence', config['fence'])
    reconcile = load_module('address_only_reconcile', config['reconcile'])
    exporter = load_module('address_only_exporter', config['exporter'])
    validator = load_module('address_only_validator', config['validator'])
    deadline = fence_module.Deadline(600)
    directory = Path(config['outputDirectory'])
    require(not directory.exists(), 'operation_output_exists')
    require(ROOT.lstat().st_uid == 0 and not ROOT.lstat().st_mode & 0o022, 'unsafe_output_root')
    os.umask(0o077)
    directory.mkdir(mode=0o700)
    job = json.loads(json.dumps(config['jobTemplate']))
    for key in ('runtimeModule', 'pgModule', 'credential'):
        pinned_read(job[key], 16384 if key == 'credential' else MAXIMUM_BYTES)
    credential = json.loads(pinned_read(job['credential'], 16384))
    require(credential.get('host') == '127.0.0.1' and credential.get('port') == 5432
            and credential.get('database') == 'address_radar'
            and credential.get('user') == 'address_radar_migrator'
            and isinstance(credential.get('password'), str) and len(credential['password']) >= 32
            and type(credential.get('expiresAtMs')) is int
            and credential['expiresAtMs'] > int(time.time() * 1000) + 660000,
            'credential_not_fresh_for_controller')
    target_keys = ('database', 'schema', 'schemaFingerprint', 'systemIdentifier', 'serverAddress', 'serverPort')
    binding = {'operationId': config['operationId'], 'importId': job['review']['importId'],
               'generationId': job['review']['generationId'], 'planSha256': None,
               'target': {key: job['target'][key] for key in target_keys}}
    fence_module.validate_binding(binding, config['operationId'], allow_unbound=True)
    reconcile.validate_target(binding)
    fence = fence_module.NativeSourceFence(config['operationId'], deadline, import_binding=binding)
    try:
        fence.stop_writers()
        backup = fence.backup_and_seal()['backup']
        captured = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        connection = sqlite3.connect('file:' + backup['path'] + '?mode=ro&immutable=1', uri=True)
        try:
            connection.set_progress_handler(lambda: (deadline.check(), 0)[1], 1000)
            connection.execute('BEGIN')
            seed = exporter.select_seed(connection, captured, check=deadline.check)
            connection.rollback()
        finally:
            connection.close()
        seed_raw = exporter.canonical(seed)
        require(len(seed_raw) <= MAXIMUM_BYTES, 'seed_byte_budget')
        validator.prepare(seed, digest(seed_raw))
        job['seed'] = write_private(directory, 'address-only-seed.json', seed_raw)
        job['review']['seedSha256'] = job['seed']['sha256']
        job['review']['importedAt'] = int(time.time() * 1000)
        job['activatedAt'] = job['review']['importedAt']

        def launch(action):
            deadline.check()
            current = json.loads(json.dumps(job))
            current['action'] = action
            current['budget']['deadlineAtMs'] = int(time.time() * 1000) + 60000
            pin = write_private(directory, action + '-job.json', canonical(current))
            output = bounded_child([config['node']['path'], '--no-global-search-paths',
                config['launcher']['path'], '--job', pin['path'], '--job-sha256', pin['sha256']],
                seconds=min(70, max(0.001, deadline.expires - time.monotonic())),
                diagnostic=lambda value: write_private(directory, action + '-child-diagnostic.json', canonical(value)))
            value = json.loads(output)
            require(value.get('operationId') == config['operationId'], 'launcher_operation_changed')
            deadline.check()
            return value

        plan = launch('plan')
        require(plan.get('status') == 'address-only-plan-hashed-not-imported', 'plan_not_prepared')
        fence.bind_import_plan(plan['planSha256'])
        launch('prepare')
        fence.mark_import_intent()
        try:
            imported = launch('import')
            require(imported.get('status') == 'address-only-native-import-committed', 'import_ack_invalid')
        except Exception:
            require(reconcile_failed_import(fence, reconcile), 'import_confirmed_absent')
        fence.reconcile_committed_import(reconcile.reconcile_import)
        measured = fence.measure()
        receipt = {'protocol': 'address-only-controller-receipt-v1', 'operationId': config['operationId'],
            'databaseImported': True, 'businessReleaseSwitched': False, 'gatewayDeliveryEnabled': False,
            'walletCount': plan['walletCount'], 'entityCount': plan['entityCount'],
            'planSha256': plan['planSha256'], 'backupSha256': measured['backupSha256'],
            'fenceSha256': measured['fenceSha256'], 'phase': 'IMPORT_COMMITTED'}
        write_private(directory, 'controller-receipt.json', canonical(receipt))
        return receipt
    except BaseException:
        # Unknown commits are reconciled before any decision to restore source writes.
        reconcile_failed_import(fence, reconcile)
        raise
    finally:
        fence.close()


def recover(config):
    require(os.geteuid() == 0, 'native_root_required')
    config = validate_config(config)
    fence_module = load_module('address_only_fence_recovery', config['fence'])
    reconcile = load_module('address_only_reconcile_recovery', config['reconcile'])
    fence = fence_module.NativeSourceFence.recover(fence_module.Deadline(120))
    try:
        require(fence.operation_id == config['operationId'], 'recovery_operation_changed')
        committed = reconcile_failed_import(fence, reconcile)
        return {'protocol': 'address-only-controller-recovery-v1', 'operationId': config['operationId'],
            'databaseImported': committed, 'phase': fence.state['phase'],
            'businessReleaseSwitched': False, 'gatewayDeliveryEnabled': False}
    finally:
        fence.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--config-sha256', required=True)
    parser.add_argument('--recover', action='store_true')
    args = parser.parse_args()
    config = json.loads(pinned_read({'path': args.config, 'sha256': args.config_sha256}, 65536))
    print(json.dumps(recover(config) if args.recover else execute(config)))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"refused-or-recovery-required","databaseOutcomeKnown":false,"gatewayDeliveryEnabled":false}')
        raise SystemExit(1)
