#!/usr/bin/env python3
"""Host-free tests: private operations, /proc, binaries and root trust are mocked."""
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'preservation-fixture-expiry.py'
SPEC = importlib.util.spec_from_file_location('fixture_expiry', SOURCE)
expiry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(expiry)


class ExpiryTests(unittest.TestCase):
    def setUp(self):
        self.mount_patch = patch.object(expiry, 'mount_id', return_value=7)
        self.mount_patch.start()
        self.addCleanup(self.mount_patch.stop)
        self.nonce = '0123456789abcdef'
        self.root = '/tmp/radar_rehearsal_' + self.nonce
        self.uid = os.getuid()
        self.pin = {'identity': [1, 2], 'sha256': 'a' * 64}
        self.record = {
            'version': 1, 'nonce': self.nonce, 'root': self.root,
            'uid': 999, 'gid': 999, 'created_at': 1000, 'deadline': 11800,
            'root_identity': [1, 3], 'data_identity': [1, 4],
            'owner_pin': copy.deepcopy(self.pin), 'connection_pin': copy.deepcopy(self.pin),
            'system_identifier': '12345', 'pid': 1234, 'process_ticks': 123,
            'postmaster_start': 900, 'boot_id': 'b' * 36,
            'binaries': {name: copy.deepcopy(self.pin)
                         for name in ('pg_ctl', 'postgres', 'pg_controldata')},
        }

    def validate(self, value=None):
        with patch.object(expiry.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=999, pw_gid=999)), \
             patch.object(expiry, 'boot_id', return_value='b' * 36):
            expiry.validate_record(value or self.record, self.nonce)

    @contextlib.contextmanager
    def operations(self, ticks=None, status=3):
        with patch.object(expiry, 'fixture') as fixture, \
             patch.object(expiry, 'check_identity', return_value=ticks) as check, \
             patch.object(expiry, 'pid_record', return_value=None) as pid, \
             patch.object(expiry, 'run_private', return_value=types.SimpleNamespace(returncode=status)) as run, \
             patch.object(expiry, 'delete_owned') as delete:
            fixture.return_value.__enter__.return_value = (10, 11)
            yield check, pid, run, delete

    def test_exact_max_deadline(self):
        self.validate()
        for ttl in (0, -1, 10801):
            with self.subTest(ttl=ttl):
                value = copy.deepcopy(self.record)
                value['deadline'] = value['created_at'] + ttl
                with self.assertRaises(expiry.Refusal):
                    self.validate(value)

    def test_invalid_authority_records(self):
        mutations = [('root', '/var/lib/postgresql/16/main'), ('nonce', 'f' * 16),
                     ('uid', 0), ('pid', 1), ('process_ticks', 0), ('deadline', True),
                     ('boot_id', 'c' * 36), ('postmaster_start', 1001)]
        for key, value in mutations:
            with self.subTest(key=key):
                record = copy.deepcopy(self.record)
                record[key] = value
                with self.assertRaises(expiry.Refusal):
                    self.validate(record)

    def test_expiry_boundary_and_final(self):
        for now, final, allowed in ((11799, False, False), (11800, False, True),
                                    (1000, True, True), (999, True, False)):
            with self.subTest(now=now, final=final), self.operations() as (_, _, run, delete):
                if allowed:
                    self.assertEqual(expiry.operate('cleanup', self.record, final, now)['status'], 'deleted')
                    delete.assert_called_once()
                    self.assertEqual(run.call_args.args[2], ['-D', self.root + '/data', 'status'])
                else:
                    with self.assertRaises(expiry.Refusal):
                        expiry.operate('cleanup', self.record, final, now)
                    run.assert_not_called()
                    delete.assert_not_called()

    def test_check_never_stops_or_deletes(self):
        with self.operations() as (_, _, run, delete):
            self.assertEqual(expiry.operate('check', self.record, now=11800)['status'], 'expired')
            run.assert_not_called()
            delete.assert_not_called()

    def test_bounded_private_stop(self):
        with self.operations() as (check, pid, run, delete):
            check.side_effect = [123, None, None]
            pid.return_value = None
            pid.side_effect = [(1234, 900), None]
            run.return_value = types.SimpleNamespace(returncode=3)
            with patch.object(expiry, 'stop_private') as stop:
                expiry.operate('cleanup', self.record, now=11800)
                stop.assert_called_once_with(self.record, 10, 11)
            self.assertEqual(run.call_args.args[2], ['-D', self.root + '/data', 'status'])
            delete.assert_called_once()

    def test_stop_failure_no_delete(self):
        with self.operations(ticks=123, status=1) as (_, pid, _, delete):
            pid.return_value = (1234, 900)
            with patch.object(expiry, 'stop_private', side_effect=expiry.Refusal('stop-timeout')), \
                 self.assertRaises(expiry.Refusal):
                expiry.operate('cleanup', self.record, now=11800)
            delete.assert_not_called()

    def test_live_after_stop_no_delete(self):
        with self.operations(ticks=123, status=0) as (_, pid, _, delete):
            pid.return_value = (1234, 900)
            with patch.object(expiry, 'stop_private'), self.assertRaises(expiry.Refusal):
                expiry.operate('cleanup', self.record, now=11800)
            delete.assert_not_called()

    def test_unknown_status_no_delete(self):
        for status in (0, 1, 2, 4):
            with self.subTest(status=status), self.operations(status=status) as (_, _, _, delete):
                with self.assertRaises(expiry.Refusal):
                    expiry.operate('cleanup', self.record, now=11800)
                delete.assert_not_called()

    def test_unknown_ownership_no_operations(self):
        with self.operations() as (check, _, run, delete):
            check.side_effect = expiry.Refusal('root-ownership')
            with self.assertRaises(expiry.Refusal):
                expiry.operate('cleanup', self.record, now=11800)
            run.assert_not_called()
            delete.assert_not_called()

    def test_pid_reuse_and_identity_race(self):
        with patch.object(expiry, 'path_identity'), patch.object(expiry, 'connection'), \
             patch.object(expiry, 'read_at', return_value=(b'16\n', {})), \
             patch.object(expiry, 'pin_binary', return_value=self.pin), \
             patch.object(expiry, 'pid_record'), \
             patch.object(expiry, 'process_identity', return_value=124):
            with self.assertRaisesRegex(expiry.Refusal, 'pid-reused'):
                expiry.check_identity(self.record, 10, 11)
        with patch.object(expiry.os, 'lstat', return_value=types.SimpleNamespace(st_dev=1, st_ino=99)), \
             patch.object(expiry.os, 'fstat', return_value=types.SimpleNamespace(st_dev=1, st_ino=3)):
            with self.assertRaisesRegex(expiry.Refusal, 'directory-race'):
                expiry.path_identity(self.record, 10, 11)

    def test_symlink_and_hardlink_file_refusal(self):
        with tempfile.TemporaryDirectory() as path:
            fd = os.open(path, expiry.DIRECTORY)
            try:
                Path(path, 'original').write_bytes(b'private')
                os.chmod(Path(path, 'original'), 0o600)
                os.symlink('original', Path(path, 'owner'))
                with self.assertRaises(OSError):
                    expiry.read_at(fd, 'owner', self.uid)
                os.unlink(Path(path, 'owner'))
                os.link(Path(path, 'original'), Path(path, 'owner'))
                with self.assertRaises(expiry.Refusal):
                    expiry.read_at(fd, 'owner', self.uid)
            finally:
                os.close(fd)

    def test_read_inode_race(self):
        with tempfile.TemporaryDirectory() as path:
            Path(path, 'owner').write_bytes(b'a' * 48)
            os.chmod(Path(path, 'owner'), 0o600)
            fd = os.open(path, expiry.DIRECTORY)
            try:
                with patch.object(expiry.os, 'stat', return_value=types.SimpleNamespace(st_dev=0, st_ino=0)):
                    with self.assertRaisesRegex(expiry.Refusal, 'file-race'):
                        expiry.read_at(fd, 'owner', self.uid)
            finally:
                os.close(fd)

    def test_tree_unknown_no_deletion(self):
        with tempfile.TemporaryDirectory() as path:
            Path(path, 'retained').write_bytes(b'evidence')
            os.chmod(Path(path, 'retained'), 0o600)
            os.symlink('/never/access', Path(path, 'unknown'))
            fd = os.open(path, expiry.DIRECTORY)
            try:
                with patch.object(expiry.os, 'unlink') as unlink, patch.object(expiry.os, 'rename') as rename:
                    with self.assertRaisesRegex(expiry.Refusal, 'tree-unknown'):
                        expiry.delete_owned(dict(self.record, uid=self.uid), fd, fd)
                    unlink.assert_not_called()
                    rename.assert_not_called()
            finally:
                os.close(fd)
            self.assertEqual(Path(path, 'retained').read_bytes(), b'evidence')

    def test_tree_owner_refusal(self):
        with tempfile.TemporaryDirectory() as path:
            Path(path, 'unknown').write_bytes(b'evidence')
            fd = os.open(path, expiry.DIRECTORY)
            try:
                with self.assertRaises(expiry.Refusal):
                    expiry.tree_manifest(fd, self.uid + 1)
            finally:
                os.close(fd)

    def test_connection_pin_no_credentials_in_record(self):
        connection = {'host': '127.0.0.1', 'port': 5434,
                      'database': 'radar_rehearsal_' + self.nonce,
                      'schema': 'radar_rehearsal_' + self.nonce + '_schema',
                      'username': 'radar_rehearsal_' + self.nonce + '_migrator',
                      'password': 'd' * 64, 'systemIdentifier': '12345', 'nonce': self.nonce}
        values = [(b'e' * 48, self.pin), (json.dumps(connection).encode(), self.pin)]
        with patch.object(expiry, 'read_at', side_effect=values):
            self.assertEqual(expiry.connection(self.record, 10)[2], '12345')
        connection['host'] = '/var/run/postgresql'
        with patch.object(expiry, 'read_at', side_effect=[values[0], (json.dumps(connection).encode(), self.pin)]):
            with self.assertRaises(expiry.Refusal):
                expiry.connection(self.record, 10)
        self.assertNotIn('d' * 64, expiry.canonical(self.record).decode())

    def test_record_hash_and_deadline_immutable(self):
        raw = expiry.canonical(self.record)
        with patch.object(expiry, 'protected_path'), patch.object(expiry.os, 'open', return_value=10), \
             patch.object(expiry.os, 'close'), patch.object(expiry, 'read_at', return_value=(raw, {})), \
             patch.object(expiry, 'validate_record'):
            self.assertEqual(expiry.load_record('/root/record', hashlib.sha256(raw).hexdigest(), self.nonce), self.record)
            with self.assertRaisesRegex(expiry.Refusal, 'record-hash'):
                expiry.load_record('/root/record', '0' * 64, self.nonce)
        with patch.object(expiry, 'trusted_runtime'), patch.object(expiry, 'load_record') as load:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(expiry.main(['cleanup', '--nonce', self.nonce, '--record', '/root/record',
                                             '--expected-sha256', 'a' * 64, '--ttl-seconds', '10800']), 1)
            load.assert_not_called()

    def test_arm_rejects_ttl_before_access(self):
        with patch.object(expiry, 'protected_path') as access:
            for ttl in (0, -1, 10801):
                with self.assertRaises(expiry.Refusal):
                    expiry.arm(self.nonce, '/root/record', ttl)
            access.assert_not_called()

    def test_runner_is_private_and_bounded(self):
        with patch.object(expiry, 'pin_binary', return_value=self.pin), \
             patch.object(expiry.subprocess, 'run') as run:
            expiry.run_private(self.record, 'pg_ctl', ['-D', self.root + '/data', 'status'])
            args, kwargs = run.call_args
            self.assertEqual(args[0][0], expiry.BIN + '/pg_ctl')
            self.assertEqual(kwargs['timeout'], 15)
            self.assertEqual(kwargs['user'], 999)
            self.assertEqual(kwargs['extra_groups'], [])
            self.assertEqual(kwargs['env'], {'PATH': expiry.BIN, 'LC_ALL': 'C'})
            self.assertEqual(kwargs['stderr'], expiry.subprocess.DEVNULL)

    def test_errors_do_not_leak(self):
        output = io.StringIO()
        with patch.object(expiry, 'trusted_runtime', side_effect=OSError('password-secret')), \
             contextlib.redirect_stdout(output):
            self.assertEqual(expiry.main(['check', '--nonce', self.nonce, '--record', '/root/record',
                                         '--expected-sha256', 'a' * 64]), 1)
        self.assertNotIn('password-secret', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['reason'], 'operation-failed')

    @contextlib.contextmanager
    def pidfd_mocks(self):
        with patch.object(expiry.os, 'pidfd_open', return_value=30, create=True) as opened, \
             patch.object(expiry.signal, 'pidfd_send_signal', create=True) as sent, \
             patch.object(expiry.os, 'close') as closed, \
             patch.object(expiry, 'pidfd_live', side_effect=[True, True, False]) as live, \
             patch.object(expiry, 'read_at', return_value=(b'pid', self.pin)) as read, \
             patch.object(expiry, 'check_identity', return_value=123) as check, \
             patch.object(expiry, 'process_identity', return_value=123), \
             patch.object(expiry, 'path_identity'):
            yield opened, sent, closed, live, read, check

    def test_pidfd_correct_target_and_fast_signal(self):
        with self.pidfd_mocks() as (opened, sent, closed, _, _, _), \
             patch.object(expiry.select, 'poll', create=True):
            expiry.stop_private(self.record, 10, 11)
            opened.assert_called_once_with(1234, 0)
            sent.assert_called_once_with(30, expiry.signal.SIGINT, None, 0)
            closed.assert_called_once_with(30)

    def test_pidfd_reused_pid_no_signal(self):
        with self.pidfd_mocks() as (_, sent, closed, _, _, check):
            check.return_value = 124
            with self.assertRaisesRegex(expiry.Refusal, 'pid-reused'):
                expiry.stop_private(self.record, 10, 11)
            sent.assert_not_called()
            closed.assert_called_once_with(30)

    def test_mutating_pidfile_no_signal(self):
        with self.pidfd_mocks() as (_, sent, _, _, read, _):
            read.side_effect = [(b'pid', self.pin), (b'changed', dict(self.pin, sha256='b' * 64))]
            with self.assertRaisesRegex(expiry.Refusal, 'pidfile-race'):
                expiry.stop_private(self.record, 10, 11)
            sent.assert_not_called()

    def test_exited_pidfd_no_signal(self):
        with self.pidfd_mocks() as (_, sent, _, live, _, _):
            live.side_effect = [True, False]
            with self.assertRaisesRegex(expiry.Refusal, 'pidfd-exited'):
                expiry.stop_private(self.record, 10, 11)
            sent.assert_not_called()

    def test_pidfd_timeout_no_delete_or_fallback(self):
        with self.pidfd_mocks() as (_, sent, _, live, _, _), \
             patch.object(expiry.select, 'poll', create=True), \
             patch.object(expiry.time, 'monotonic', side_effect=[0, expiry.STOP_SECONDS + 1]), \
             patch.object(expiry, 'run_private') as run:
            live.side_effect = None
            live.return_value = True
            with self.assertRaisesRegex(expiry.Refusal, 'stop-timeout'):
                expiry.stop_private(self.record, 10, 11)
            sent.assert_called_once()
            run.assert_not_called()

    def test_incremental_enumeration_bound_before_sort(self):
        consumed = []
        def entries():
            for index in range(100):
                consumed.append(index)
                yield types.SimpleNamespace(name=str(index))
        with patch.object(expiry, 'MAX_ENTRIES', 3), patch.object(expiry.os, 'scandir') as scan:
            scan.return_value.__enter__.return_value = entries()
            with self.assertRaisesRegex(expiry.Refusal, 'tree-bound'):
                expiry.bounded_names(10, expiry.Budget(10), 0)
            self.assertEqual(len(consumed), 4)

    def test_depth_and_time_bounds_before_enumeration(self):
        with patch.object(expiry.os, 'scandir') as scan:
            with self.assertRaises(expiry.Refusal):
                expiry.bounded_names(10, expiry.Budget(10), expiry.MAX_DEPTH + 1)
            with self.assertRaises(expiry.Refusal):
                expiry.bounded_names(10, expiry.Budget(-1), 0)
            scan.assert_not_called()

    def test_artifact_namespace_exact_and_locked(self):
        with self.assertRaisesRegex(expiry.Refusal, 'artifact-scope'):
            with expiry.artifact_scope('/var/lib/business', self.nonce):
                self.fail('unexpected authorization')
        info = types.SimpleNamespace(st_uid=0, st_mode=0o40700)
        with patch.object(expiry, 'protected_path'), patch.object(expiry.os, 'open', return_value=10), \
             patch.object(expiry.os, 'close'), patch.object(expiry.os, 'fstat', return_value=info), \
             patch.object(expiry.fcntl, 'flock', side_effect=BlockingIOError), \
             patch.object(expiry, 'artifact_proof') as proof:
            with self.assertRaisesRegex(expiry.Refusal, 'artifact-locked'):
                with expiry.artifact_scope(expiry.ARTIFACT_PARENT + '/' + self.nonce, self.nonce):
                    self.fail('unexpected lock')
            proof.assert_not_called()

    def test_correct_artifacts_cleanup_without_pg(self):
        # Mock the root trust boundary; perform real fd-relative deletion only
        # inside a test-owned temporary directory using its actual UID.
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent, 'namespace')
            path.mkdir(mode=0o700)
            for name in ('owner', 'runner.mjs', 'config.json', 'authority.json', 'stdout', 'evidence'):
                Path(path, name).write_bytes(b'private credential material')
                os.chmod(Path(path, name), 0o600)
            fd = os.open(path, expiry.DIRECTORY)
            record = dict(self.record, artifacts={'root': str(path), 'identity': expiry.identity(os.fstat(fd))})
            try:
                with patch.object(expiry, 'artifact_scope') as scope, \
                     patch.object(expiry, 'artifact_proof'), patch.object(expiry, 'process_identity') as process:
                    scope.return_value.__enter__.return_value = (fd, record['artifacts'])
                    self.assertEqual(expiry.cleanup_artifacts_locked(record)['status'], 'deleted')
                    process.assert_not_called()
                self.assertFalse(path.exists())
                self.assertEqual(list(Path(parent).iterdir()), [])
            finally:
                os.close(fd)

    def test_artifact_credentials_removed_when_pg_refuses(self):
        record = dict(self.record, artifacts={'root': 'not-disclosed', 'control': {}})
        with self.control_mocks(record), patch.object(expiry, 'operate', side_effect=expiry.Refusal('pid-reused')), \
             patch.object(expiry, 'cleanup_artifacts_locked', return_value={'status': 'deleted'}) as clean:
            result = expiry.cleanup_components(record, now=11800)
            self.assertEqual(result['status'], 'partial')
            self.assertEqual(result['private_pg']['reason'], 'pid-reused')
            self.assertEqual(result['artifacts']['status'], 'deleted')
            clean.assert_called_once()
            self.assertNotIn('not-disclosed', json.dumps(result))

    def test_artifact_failure_sanitized_separately(self):
        record = dict(self.record, artifacts={'root': 'secret-path', 'control': {}})
        with self.control_mocks(record), patch.object(expiry, 'operate'), \
             patch.object(expiry, 'cleanup_artifacts_locked', side_effect=OSError('credential-secret')):
            result = expiry.cleanup_components(record, now=11800)
            self.assertEqual(result['status'], 'partial')
            self.assertEqual(result['artifacts']['reason'], 'operation-failed')
            self.assertNotIn('credential-secret', json.dumps(result))
            self.assertNotIn('secret-path', json.dumps(result))

    def test_no_component_cleanup_before_deadline(self):
        with patch.object(expiry, 'operate') as pg, patch.object(expiry, 'cleanup_artifacts') as artifacts:
            with self.assertRaises(expiry.Refusal):
                expiry.cleanup_components(dict(self.record, artifacts={}), now=11799)
            pg.assert_not_called()
            artifacts.assert_not_called()

    def test_artifact_mutation_no_delete(self):
        with tempfile.TemporaryDirectory() as parent:
            path = Path(parent, 'namespace')
            path.mkdir(mode=0o700)
            Path(path, 'credential').write_bytes(b'original')
            os.chmod(Path(path, 'credential'), 0o600)
            fd = os.open(path, expiry.DIRECTORY)
            try:
                manifest = expiry.tree_manifest(fd, self.uid, artifacts=True)
                Path(path, 'credential').write_bytes(b'changed')
                with patch.object(expiry.os, 'unlink') as unlink:
                    with self.assertRaisesRegex(expiry.Refusal, 'tree-race'):
                        expiry.delete_namespace(str(path), fd, expiry.identity(os.fstat(fd)), self.uid,
                                                manifest, lambda: None, artifacts=True)
                    unlink.assert_not_called()
            finally:
                os.close(fd)

    def test_unknown_root_still_refused_inside_fixture(self):
        with tempfile.TemporaryDirectory() as path:
            Path(path, 'root-artifact').write_bytes(b'unknown')
            os.chmod(Path(path, 'root-artifact'), 0o600)
            fd = os.open(path, expiry.DIRECTORY)
            try:
                with self.assertRaisesRegex(expiry.Refusal, 'tree-unknown'):
                    expiry.tree_manifest(fd, self.uid + 1)
            finally:
                os.close(fd)

    def test_bind_mount_refused(self):
        with tempfile.TemporaryDirectory() as path:
            Path(path, 'nested').mkdir(mode=0o700)
            fd = os.open(path, expiry.DIRECTORY)
            try:
                with patch.object(expiry, 'mount_id', side_effect=[7, 8]):
                    with self.assertRaisesRegex(expiry.Refusal, 'tree-race'):
                        expiry.tree_manifest(fd, self.uid)
            finally:
                os.close(fd)

    def test_namespace_record_pins_and_no_path_escape(self):
        record = dict(self.record, artifacts={
            'root': expiry.ARTIFACT_PARENT + '/' + self.nonce, 'identity': [1, 5],
            'owner_pin': self.pin, 'code_pins': {'runner.mjs': self.pin},
            'control': {'root': expiry.CONTROL_PARENT + '/' + self.nonce, 'identity': [1, 6],
                        'owner_pin': self.pin, 'lock_pin': self.pin}})
        self.validate(record)
        record['artifacts']['code_pins'] = {'../business': self.pin}
        with self.assertRaises(expiry.Refusal):
            self.validate(record)

    @contextlib.contextmanager
    def control_mocks(self, record, state=None):
        value = state or expiry.initial_state(record)
        with patch.object(expiry, 'control_scope') as scope, \
             patch.object(expiry, 'read_control_state', return_value=value), \
             patch.object(expiry, 'update_control_state', side_effect=lambda fd, rec, old, new: new), \
             patch.object(expiry, 'persist_receipt', return_value='a' * 64):
            scope.return_value.__enter__.return_value = (20, 21, record['artifacts'].get('control', {}))
            yield scope

    @contextlib.contextmanager
    def real_control(self):
        # Root ownership is the only mocked filesystem boundary. Lock identity,
        # flock, state replacement and receipts use actual test-owned files.
        original_read = expiry.read_at
        original_fstat = expiry.os.fstat
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary, 'control')
            parent.mkdir(mode=0o700)
            root = parent / self.nonce
            root.mkdir(mode=0o700)
            for name, byte in (('owner', b'a'), ('lock', b'b')):
                (root / name).write_bytes(byte * 48)
                os.chmod(root / name, 0o600)
            def root_check(fd):
                info = original_fstat(fd)
                expiry.require(info.st_uid == self.uid and info.st_mode & 0o777 == 0o700, 'control-ownership')
                return info
            def read(fd, name, uid, **kwargs):
                return original_read(fd, name, uid, **kwargs)
            def fstat(fd):
                info = original_fstat(fd)
                return types.SimpleNamespace(**{
                    name: 0 if name == 'st_uid' else getattr(info, name)
                    for name in ('st_uid', 'st_mode', 'st_dev', 'st_ino', 'st_nlink',
                                 'st_size', 'st_mtime_ns', 'st_ctime_ns')})
            with patch.object(expiry, 'CONTROL_PARENT', str(parent)), \
                 patch.object(expiry, 'protected_path'), patch.object(expiry, 'root_directory', side_effect=root_check), \
                 patch.object(expiry, 'read_at', side_effect=read), \
                 patch.object(expiry.os, 'fstat', side_effect=fstat):
                yield root

    def test_permanent_lock_replacement_refused(self):
        with self.real_control() as root:
            with expiry.control_scope(self.nonce, path=str(root)) as (_, _, pin):
                pass
            replacement = root / 'replacement'
            replacement.write_bytes(b'b' * 48)
            os.chmod(replacement, 0o600)
            os.replace(replacement, root / 'lock')
            with self.assertRaisesRegex(expiry.Refusal, 'control-pin-changed'):
                with expiry.control_scope(self.nonce, expected=pin):
                    self.fail('replacement accepted')

    def test_stale_control_inode_refused(self):
        with self.real_control() as root:
            with expiry.control_scope(self.nonce, path=str(root)) as (_, _, pin):
                pass
            pin = dict(pin, identity=[0, 0])
            with self.assertRaisesRegex(expiry.Refusal, 'control-replaced'):
                with expiry.control_scope(self.nonce, expected=pin):
                    self.fail('stale namespace accepted')

    def test_shared_lock_busy_is_nonblocking(self):
        with self.real_control() as root:
            with expiry.control_scope(self.nonce, path=str(root)) as (_, _, pin):
                with self.assertRaisesRegex(expiry.Refusal, 'control-locked'):
                    with expiry.control_scope(self.nonce, expected=pin):
                        self.fail('second lease accepted')

    def test_atomic_seal_and_no_regression(self):
        with self.real_control() as root:
            with expiry.control_scope(self.nonce, path=str(root)) as (fd, _, _):
                state = expiry.initial_state(self.record)
                expiry.write_control_file(fd, 'state.json', expiry.canonical(state))
                sealed = dict(state, phase='sealed', snapshot_sha256='a' * 64)
                expiry.update_control_state(fd, self.record, state, sealed)
                self.assertEqual(expiry.read_control_state(fd, self.record), sealed)
                with self.assertRaisesRegex(expiry.Refusal, 'control-state-regression'):
                    expiry.update_control_state(fd, self.record, sealed, state)
                self.assertTrue((root / 'lock').exists())

    def test_sealed_producer_cannot_open_namespace(self):
        record = dict(self.record, artifacts={'root': 'never-open', 'control': {}, 'managed': {}})
        state = dict(expiry.initial_state(record), phase='sealed', snapshot_sha256='a' * 64)
        with self.control_mocks(record, state), patch.object(expiry, 'trusted_runtime'), \
             patch.object(expiry, 'load_record', return_value=record), \
             patch.object(expiry, 'artifact_scope') as artifacts:
            with self.assertRaisesRegex(expiry.Refusal, 'producer-sealed'):
                with expiry.artifact_producer_lease(self.nonce, '/root/record', 'a' * 64, 'b' * 16):
                    self.fail('sealed producer accepted')
            artifacts.assert_not_called()

    def test_deleted_producer_cannot_recreate(self):
        record = dict(self.record, artifacts={'root': 'never-open', 'control': {}, 'managed': {}})
        state = dict(expiry.initial_state(record), phase='deleted', artifacts='deleted', snapshot_sha256='a' * 64)
        with self.control_mocks(record, state), patch.object(expiry, 'trusted_runtime'), \
             patch.object(expiry, 'load_record', return_value=record), \
             patch.object(expiry, 'artifact_scope') as artifacts:
            with self.assertRaisesRegex(expiry.Refusal, 'producer-sealed'):
                with expiry.artifact_producer_lease(self.nonce, '/root/record', 'a' * 64, 'b' * 16):
                    self.fail('recreation accepted')
            artifacts.assert_not_called()




    def test_deleted_artifact_recreation_never_deleted(self):
        with tempfile.TemporaryDirectory() as path:
            record = dict(self.record, artifacts={'root': path})
            state = dict(expiry.initial_state(record), phase='deleted', artifacts='deleted', snapshot_sha256='a' * 64)
            with patch.object(expiry, 'artifact_scope') as scope:
                with self.assertRaisesRegex(expiry.Refusal, 'artifact-recreated'):
                    expiry.cleanup_artifacts_locked(record, 20, state)
                scope.assert_not_called()

    def test_missing_pg_is_not_deletion_proof(self):
        record = dict(self.record, artifacts={'root': 'credentials', 'control': {}})
        with self.control_mocks(record), patch.object(expiry, 'operate', side_effect=FileNotFoundError), \
             patch.object(expiry, 'cleanup_artifacts_locked', return_value={'status': 'deleted'}) as clean:
            result = expiry.cleanup_components(record, now=11800)
            self.assertEqual(result['private_pg']['reason'], 'private-pg-absence-unproven')
            self.assertEqual(result['artifacts']['status'], 'deleted')
            self.assertEqual(result['status'], 'partial')
            clean.assert_called_once()

    def test_durable_pg_deletion_allows_later_artifact_cleanup(self):
        record = dict(self.record, artifacts={'root': 'credentials', 'control': {}})
        state = dict(expiry.initial_state(record), private_pg='deleted')
        with self.control_mocks(record, state), patch.object(expiry, 'operate') as pg, \
             patch.object(expiry, 'require_absent'), \
             patch.object(expiry, 'cleanup_artifacts_locked', return_value={'status': 'deleted'}):
            result = expiry.cleanup_components(record, now=11800)
            self.assertEqual(result['private_pg']['status'], 'already-deleted')
            self.assertEqual(result['status'], 'deleted')
            pg.assert_not_called()

    def test_control_and_separate_sanitized_receipts_survive(self):
        with self.real_control() as root:
            with expiry.control_scope(self.nonce, path=str(root)) as (fd, _, pin):
                pg_hash = expiry.persist_receipt(fd, self.record, 'private-pg', {'status': 'refused', 'reason': 'pid-reused'})
                artifact_hash = expiry.persist_receipt(fd, self.record, 'artifacts', {'status': 'deleted'})
            files = list((root / 'receipts').iterdir())
            self.assertEqual(len(files), 2)
            hashes = {hashlib.sha256(file.read_bytes()).hexdigest() for file in files}
            self.assertEqual(hashes, {pg_hash, artifact_hash})
            for file in files:
                value = json.loads(file.read_bytes())
                self.assertNotIn('password', value)
                self.assertNotIn('owner_pin', value)
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with expiry.control_scope(self.nonce, expected=pin):
                pass
            self.assertTrue((root / 'owner').exists())
            self.assertTrue((root / 'lock').exists())

    def test_unknown_refusal_text_is_sanitized(self):
        self.assertEqual(expiry.safe_failure(expiry.Refusal('credential-secret'))['reason'], 'operation-failed')

    def test_prearm_install_blocked_after_arm_intent(self):
        with self.real_control() as root:
            (root / 'arm.intent').write_bytes(b'published')
            os.chmod(root / 'arm.intent', 0o600)
            with patch.object(expiry, 'trusted_runtime'), patch.object(expiry, 'ARTIFACT_PARENT', '/unused'):
                with self.assertRaisesRegex(expiry.Refusal, 'producer-closed'):
                    with expiry.artifact_install_lease(self.nonce, '/unused/' + self.nonce, str(root)):
                        self.fail('reinstall accepted')

    def test_expired_producer_never_opens_artifacts(self):
        record = dict(self.record, artifacts={'root': 'never-open', 'control': {}, 'managed': {}})
        with self.control_mocks(record), patch.object(expiry, 'trusted_runtime'), \
             patch.object(expiry, 'load_record', return_value=record), \
             patch.object(expiry.time, 'time', return_value=11800), \
             patch.object(expiry, 'artifact_scope') as artifacts:
            with self.assertRaisesRegex(expiry.Refusal, 'producer-expired'):
                with expiry.artifact_producer_lease(self.nonce, '/root/record', 'a' * 64, 'b' * 16):
                    self.fail('expired producer accepted')
            artifacts.assert_not_called()



    def test_busy_permanent_lock_blocks_both_cleanup_components(self):
        record = dict(self.record, artifacts={'root': 'credentials', 'control': {}})
        with patch.object(expiry, 'control_scope', side_effect=expiry.Refusal('control-locked')), \
             patch.object(expiry, 'operate') as pg, patch.object(expiry, 'cleanup_artifacts_locked') as artifacts:
            result = expiry.cleanup_components(record, now=11800)
            self.assertEqual(result['status'], 'refused')
            pg.assert_not_called()
            artifacts.assert_not_called()







    def managed_record(self):
        return dict(self.record, artifacts={'root': '/private/artifacts', 'control': {},
                    'code_pins': {'runner.mjs': self.pin}, 'managed': {}})

    def managed_props(self, role='producer'):
        unit = expiry.unit_name(self.nonce, role, 'b' * 16)
        policy = {'runtime_seconds': 60, 'memory_max_bytes': 67108864, 'tasks_max': 8,
                  'cpu_quota_percent': 25}
        if role in ('verifier', 'finalizer'):
            policy['receipt_directory'] = '/var/lib/address-radar-rehearsal-artifact-control/' + self.nonce + '/receipts/' + 'b' * 16
        props = {key: '' for key in expiry.SYSTEMD_PROPERTIES}
        props.update({'Id': unit, 'LoadState': 'loaded', 'Transient': 'yes', 'InvocationID': 'c' * 32,
                      'ControlGroup': '/system.slice/' + unit, 'ActiveState': 'active', 'SubState': 'running',
                      'Result': 'success', 'Type': 'exec', 'ExitType': 'cgroup', 'Restart': 'no',
                      'KillMode': 'control-group', 'RuntimeMaxUSec': '60000000', 'TimeoutStopUSec': '10000000',
                      'MemoryMax': '67108864', 'TasksMax': '8', 'CPUQuotaPerSecUSec': '250000',
                      'ProtectSystem': 'strict', 'ReadOnlyPaths': '/private/artifacts',
                      'ReadWritePaths': policy.get('receipt_directory', ''),
                      'ProtectControlGroups': 'yes', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': ''})
        binding = dict(expiry.validate_unit_properties(props, unit, policy, role, '/private/artifacts'),
                       policy=policy, role=role, record_sha256='a' * 64, identity=[1, 2], events_identity=[1, 3])
        return props, binding

    def test_managed_unit_derivation_no_arbitrary_path(self):
        self.assertEqual(expiry.unit_name(self.nonce, 'producer', 'b' * 16),
                         'radar-rehearsal-' + self.nonce + '-producer-' + 'b' * 16 + '.service')
        for role, request in (('postgresql', 'b' * 16), ('producer', '../production'), ('verifier', 'b' * 32)):
            with self.assertRaises(expiry.Refusal):
                expiry.unit_name(self.nonce, role, request)

    def test_managed_properties_identity_and_limits(self):
        props, binding = self.managed_props()
        for key, value in (('Transient', 'no'), ('InvocationID', '0' * 32), ('Id', 'postgresql.service'),
                           ('ControlGroup', '/'), ('ControlGroup', '/system.slice/../production'),
                           ('MemoryMax', '18446744073709551615'), ('ExitType', 'main'), ('Restart', 'always')):
            with self.subTest(key=key, value=value):
                with self.assertRaises(expiry.Refusal):
                    expiry.validate_unit_properties(dict(props, **{key: value}), binding['unit'],
                                                    binding['policy'], 'producer', '/private/artifacts')

    def test_managed_verifier_policy_mandatory(self):
        props, binding = self.managed_props('verifier')
        for key, value in (('ProtectSystem', 'no'), ('ReadOnlyPaths', ''), ('CapabilityBoundingSet', 'cap_sys_admin'),
                           ('NoNewPrivileges', 'no'), ('ProtectControlGroups', 'no')):
            with self.assertRaisesRegex(expiry.Refusal, 'managed-verifier-policy'):
                expiry.validate_unit_properties(dict(props, **{key: value}), binding['unit'],
                                                binding['policy'], 'verifier', '/private/artifacts')

    def test_terminal_empty_requires_exact_inactive_and_empty(self):
        record = self.managed_record()
        props, binding = self.managed_props()
        backend = unittest.mock.Mock()
        cgroup = unittest.mock.Mock()
        cgroup.populated.return_value = False
        backend.show.return_value = props
        self.assertFalse(expiry.terminal_empty(backend, record, binding, cgroup))
        backend.show.return_value = dict(props, ActiveState='inactive', SubState='dead')
        self.assertTrue(expiry.terminal_empty(backend, record, binding, cgroup))
        cgroup.populated.return_value = True
        self.assertFalse(expiry.terminal_empty(backend, record, binding, cgroup))

    def test_terminal_retirement_is_not_empty_substitute(self):
        record = self.managed_record()
        props, binding = self.managed_props()
        backend = unittest.mock.Mock()
        backend.show.return_value = dict(props, ActiveState='inactive', SubState='dead', ControlGroup='')
        cgroup = unittest.mock.Mock()
        with self.assertRaises(expiry.Refusal):
            expiry.terminal_empty(backend, record, binding, cgroup)
        cgroup.populated.assert_not_called()

    def test_invocation_restart_rejected(self):
        record = self.managed_record()
        props, binding = self.managed_props()
        backend = unittest.mock.Mock()
        backend.show.return_value = dict(props, InvocationID='d' * 32)
        with self.assertRaisesRegex(expiry.Refusal, 'managed-unit-replaced'):
            expiry.terminal_empty(backend, record, binding, unittest.mock.Mock())

    def test_inode_replacement_and_missing_cgroup_fail_closed(self):
        props, binding = self.managed_props()
        proof = expiry.ManagedCgroupProof.__new__(expiry.ManagedCgroupProof)
        proof.path, proof.binding = '/sys/fs/cgroup' + binding['control_group'], binding
        with patch.object(expiry.os, 'lstat', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                proof.populated()
        with patch.object(expiry.os, 'lstat', return_value=types.SimpleNamespace(st_dev=1, st_ino=99)):
            with self.assertRaisesRegex(expiry.Refusal, 'managed-cgroup-replaced'):
                proof.populated()

    def test_pending_unit_blocks_cleanup_and_pg(self):
        record = self.managed_record()
        token = {'role': 'producer', 'request_nonce': 'b' * 16,
                 'unit': expiry.unit_name(self.nonce, 'producer', 'b' * 16),
                 'phase': 'pending', 'binding_sha256': None}
        state = dict(expiry.initial_state(record), producer=token)
        with self.control_mocks(record, state), patch.object(expiry, 'operate') as pg, \
             patch.object(expiry, 'cleanup_artifacts_locked') as artifacts:
            receipt = expiry.cleanup_components(record, now=11800)
            self.assertEqual(receipt['status'], 'refused')
            self.assertEqual(receipt['artifacts']['reason'], 'managed-unit-unresolved')
            pg.assert_not_called()
            artifacts.assert_not_called()

    def test_missing_managed_cgroup_keeps_cleanup_unresolved(self):
        record = self.managed_record()
        token = {'role': 'producer', 'request_nonce': 'b' * 16,
                 'unit': expiry.unit_name(self.nonce, 'producer', 'b' * 16),
                 'phase': 'bound', 'binding_sha256': 'a' * 64}
        state = dict(expiry.initial_state(record), producer=token)
        with self.control_mocks(record, state), patch.object(expiry, 'load_managed_binding', return_value={}), \
             patch.object(expiry, 'SystemdBackend'), patch.object(expiry, 'ManagedCgroupProof', side_effect=FileNotFoundError), \
             patch.object(expiry, 'operate') as pg:
            self.assertEqual(expiry.cleanup_components(record, now=11800)['status'], 'refused')
            pg.assert_not_called()

    def test_systemd_launch_uses_unit_limits_not_manual_join(self):
        record = self.managed_record()
        record['artifacts']['managed'] = {}
        record['artifacts']['control']['root'] = '/var/lib/address-radar-rehearsal-artifact-control/' + self.nonce
        backend = expiry.SystemdBackend(record)
        policy = {'runtime_seconds': 60, 'memory_max_bytes': 67108864, 'tasks_max': 8, 'cpu_quota_percent': 25}
        with patch.object(backend, 'run') as run:
            backend.launch(expiry.unit_name(self.nonce, 'verifier', 'b' * 16), ['python', 'gate'], policy, 'verifier')
            arguments = run.call_args.args[1]
            self.assertIn('--property=ExitType=cgroup', arguments)
            self.assertIn('--property=MemoryMax=67108864', arguments)
            self.assertIn('--property=RuntimeMaxSec=60', arguments)
            self.assertIn('--property=ProtectSystem=strict', arguments)
            self.assertIn('--property=ReadWritePaths=' + record['artifacts']['control']['root'] + '/receipts/' + 'b' * 16, arguments)
            self.assertIn('--property=CapabilityBoundingSet=', arguments)
            self.assertNotIn('--scope', arguments)

    def test_readwrite_exception_is_exact_request_receipt_directory(self):
        for role in ('verifier', 'finalizer'):
            props, binding = self.managed_props(role)
            expected = binding['policy']['receipt_directory']
            for wrong in ('', '/private/artifacts', expected.rsplit('/receipts/', 1)[0],
                          expected + '/..', expected + ' ' + '/private/artifacts',
                          expected[:-16] + 'd' * 16):
                with self.assertRaisesRegex(expiry.Refusal, 'managed-verifier-policy'):
                    expiry.validate_unit_properties(dict(props, ReadWritePaths=wrong), binding['unit'],
                        binding['policy'], role, '/private/artifacts')

    def test_managed_receipt_path_never_accepts_whole_control_or_artifacts(self):
        record = self.managed_record()
        unit = expiry.unit_name(self.nonce, 'finalizer', 'b' * 16)
        record['artifacts']['control']['root'] = '/var/lib/address-radar-rehearsal-artifact-control/' + self.nonce
        self.assertEqual(expiry.managed_receipt_directory(record, unit, 'finalizer'),
                         record['artifacts']['control']['root'] + '/receipts/' + 'b' * 16)
        record['artifacts']['control']['root'] = '/private/artifacts'
        with self.assertRaisesRegex(expiry.Refusal, 'managed-receipt-path'):
            expiry.managed_receipt_directory(record, unit, 'finalizer')

    def receipt_binding_fixture(self):
        record = self.managed_record()
        control = '/var/lib/address-radar-rehearsal-artifact-control/' + self.nonce
        record['artifacts']['control'] = {'root': control, 'identity': [1, 10]}
        unit = expiry.unit_name(self.nonce, 'verifier', 'b' * 16)
        binding = {'unit': unit, 'role': 'verifier', 'receipt_identity': [1, 20],
                   'policy': {'receipt_directory': control + '/receipts/' + 'b' * 16}}
        return record, binding

    def test_sandbox_receipt_bindmount_keeps_exact_inode_without_mount_id_check(self):
        record, binding = self.receipt_binding_fixture()
        infos = {10: types.SimpleNamespace(st_dev=1, st_ino=20),
                 20: types.SimpleNamespace(st_dev=1, st_ino=10)}
        with patch.object(expiry, 'protected_path') as protect, \
             patch.object(expiry.os, 'open', side_effect=[10, 20]), \
             patch.object(expiry.os, 'close'), \
             patch.object(expiry, 'root_directory', side_effect=lambda fd: infos[fd]), \
             patch.object(expiry, 'mount_id', side_effect=AssertionError('sandbox mount IDs must not be compared')):
            self.assertEqual(expiry.verify_managed_receipt_directory(record, binding),
                             binding['policy']['receipt_directory'] + '/proof.json')
            protect.assert_called_once_with(binding['policy']['receipt_directory'])

    def test_sandbox_receipt_replacement_and_abnormal_owner_still_refused(self):
        for mutation in ('receipt', 'control', 'owner', 'symlink'):
            record, binding = self.receipt_binding_fixture()
            infos = {10: types.SimpleNamespace(st_dev=1, st_ino=20),
                     20: types.SimpleNamespace(st_dev=1, st_ino=10)}
            if mutation == 'receipt':
                infos[10].st_ino = 99
            elif mutation == 'control':
                infos[20].st_ino = 99
            def checked(fd):
                if mutation == 'owner':
                    raise expiry.Refusal('abnormal-owner')
                return infos[fd]
            with patch.object(expiry, 'protected_path', side_effect=(expiry.Refusal('symlink') if mutation == 'symlink' else None)), \
                 patch.object(expiry.os, 'open', side_effect=[10, 20]), \
                 patch.object(expiry.os, 'close'), \
                 patch.object(expiry, 'root_directory', side_effect=checked):
                with self.assertRaises(expiry.Refusal):
                    expiry.verify_managed_receipt_directory(record, binding)

    def test_external_receipt_creation_still_rejects_other_mount(self):
        with patch.object(expiry.os, 'mkdir'), patch.object(expiry.os, 'open', return_value=10), \
             patch.object(expiry.os, 'close'), patch.object(expiry, 'root_directory'), \
             patch.object(expiry, 'mount_id', side_effect=[1, 2]):
            with self.assertRaisesRegex(expiry.Refusal, 'control-mount'):
                expiry.create_managed_receipt_directory(20, 'b' * 16)

    def test_managed_output_directory_cannot_be_recreated(self):
        with tempfile.TemporaryDirectory() as path:
            control = os.open(path, expiry.DIRECTORY)
            try:
                with patch.object(expiry, 'root_directory', side_effect=os.fstat), \
                     patch.object(expiry, 'mount_id', return_value=1):
                    first = expiry.create_managed_receipt_directory(control, 'b' * 16)
                    self.assertEqual(len(first), 2)
                    with self.assertRaises(FileExistsError):
                        expiry.create_managed_receipt_directory(control, 'b' * 16)
            finally:
                os.close(control)

    def test_managed_verifier_requires_db_readonly_receipt(self):
        with self.assertRaisesRegex(expiry.Refusal, 'verifier-db-readonly-required'):
            expiry.readonly_receipt(20, 10, self.record, None)
        with patch.object(expiry, 'read_at', return_value=(b'{}', {})):
            with self.assertRaisesRegex(expiry.Refusal, 'verifier-db-readonly-pin'):
                expiry.readonly_receipt(20, 10, self.record, 'a' * 64)

    def authority_fixture(self, role='verifier'):
        record = self.managed_record()
        username = 'radar_rehearsal_' + self.nonce + '_' + role
        config = {'host': '127.0.0.1', 'port': 5434, 'database': 'radar_rehearsal_' + self.nonce,
                  'nonce': self.nonce, 'systemIdentifier': '12345', 'username': username, 'password': 'secret'}
        config_raw = expiry.canonical(config)
        argv = ['/usr/bin/node', '/private/artifacts/runner.mjs', '/private/artifacts/config.json']
        proof = {'version': 2, 'nonce': self.nonce, 'record_sha256': expiry.digest(expiry.canonical(record)),
                 'request_nonce': 'b' * 16, 'role': role, 'config_relative': 'config.json',
                 'config_pin': self.pin, 'credential_ref': expiry.digest(config_raw),
                 'system_identifier': '12345', 'username': username,
                 'entry': {'code_relative': 'runner.mjs', 'execution_pin': self.pin,
                           'argv_sha256': expiry.digest(expiry.canonical(argv)),
                           'kind': 'readonly-verifier' if role == 'verifier' else 'native-ledger-uow'},
                 'measurement': {'adapter_pin': dict(self.pin, path='/protected/adapter'),
                                 'catalog_sha256': 'c' * 64, 'measured_at': record['created_at'],
                                 'session': {'session_user': username, 'current_user': username,
                                             'database': config['database'], 'system_identifier': '12345',
                                             'backend_pid': 123, 'transaction_read_only': role == 'verifier'},
                                 'reachable_roles': [username], 'owned_objects': [],
                                 'unsafe_role_attributes': [], 'set_reachable_write_paths': [], 'write_grants': []},
                 'ledger_targets': None}
        if role == 'finalizer':
            prefix = 'radar_rehearsal_' + self.nonce + '_schema.'
            proof['measurement']['select_grants'] = sorted(prefix + name for name in (
                'full_data_preservation_operations', 'full_data_preservation_tables',
                'full_data_preservation_chunks', 'full_data_preservation_rows',
                'full_data_preservation_staged_completions'))
            proof['ledger_targets'] = {
                'operations': {'relation': prefix + 'full_data_preservation_operations', 'columns': ['completed']},
                'tables': {'relation': prefix + 'full_data_preservation_tables', 'columns': ['verified_chunk_count', 'verified_manifest_sha256', 'verified_row_count']},
                'completion': {'relation': prefix + 'full_data_preservation_staged_completions', 'columns': ['boundary_sha256', 'freeze_epoch', 'manifest_sha256', 'operation_id', 'proofs_sha256', 'session_id', 'snapshot_sha256']}}
            proof['measurement']['write_grants'] = [dict(proof['ledger_targets'][key], operation=operation)
                for key, operation in [('operations', 'UPDATE'), ('tables', 'UPDATE'), ('completion', 'INSERT')]]
        return record, proof, config_raw, argv

    def check_authority(self, record, proof, config, argv, role):
        raw = expiry.canonical(proof)
        def root_pin(path):
            return proof['measurement']['adapter_pin'] if path == '/protected/adapter' else self.pin
        with patch.object(expiry, 'read_at', return_value=(raw, {})), \
             patch.object(expiry, 'artifact_file', return_value=(config, self.pin)), \
             patch.object(expiry, 'root_path_pin', side_effect=root_pin), \
             patch.object(expiry.time, 'time', return_value=record['created_at'] + 1):
            return expiry.database_authority(20, 10, record, expiry.digest(raw), role, argv, 'b' * 16)

    def test_readonly_receipt_binds_actual_command_config_and_credentials(self):
        record, proof, config, argv = self.authority_fixture()
        self.check_authority(record, proof, config, argv, 'verifier')
        for bad in [argv[:2], argv[:2] + ['/other/config'], ['/other/node'] + argv[1:], argv + ['--config', '/other']]:
            with self.assertRaises(expiry.Refusal):
                self.check_authority(record, proof, config, bad, 'verifier')
        with self.assertRaises(expiry.Refusal):
            self.check_authority(record, proof, config + b' ', argv, 'verifier')

    def test_authority_rejects_boolean_and_owner_set_reachable_write(self):
        record, proof, config, argv = self.authority_fixture()
        for field, value in [('owned_objects', ['business']), ('reachable_roles', ['postgres']),
                             ('set_reachable_write_paths', ['function']), ('write_grants', ['UPDATE'])]:
            changed = json.loads(json.dumps(proof))
            changed['measurement'][field] = value
            with self.assertRaises(expiry.Refusal):
                self.check_authority(record, changed, config, argv, 'verifier')
        proof['readonly_verified'] = True
        with self.assertRaises(expiry.Refusal):
            self.check_authority(record, proof, config, argv, 'verifier')

    def test_finalizer_exact_column_grants_and_native_entry(self):
        record, proof, config, argv = self.authority_fixture('finalizer')
        self.check_authority(record, proof, config, argv, 'finalizer')
        proof['measurement']['write_grants'][0]['columns'] = ['completed', 'business']
        with self.assertRaises(expiry.Refusal):
            self.check_authority(record, proof, config, argv, 'finalizer')
        record, proof, config, argv = self.authority_fixture('finalizer')
        proof['entry']['kind'] = 'migration-runtime'
        with self.assertRaises(expiry.Refusal):
            self.check_authority(record, proof, config, argv, 'finalizer')

    def test_finalizer_select_is_fixed_to_five_native_ledgers(self):
        for replacement in ('extra', 'missing', 'wrong'):
            record, proof, config, argv = self.authority_fixture('finalizer')
            grants = proof['measurement']['select_grants']
            if replacement == 'extra':
                grants.append('public.business')
            elif replacement == 'missing':
                grants.pop()
            else:
                grants[0] = 'radar_rehearsal_' + self.nonce + '_schema.business'
            grants.sort()
            with self.assertRaisesRegex(expiry.Refusal, 'managed-authority-acl'):
                self.check_authority(record, proof, config, argv, 'finalizer')

    def test_finalizer_matching_measurement_cannot_change_fixed_relation(self):
        for key in ('operations', 'tables', 'completion'):
            record, proof, config, argv = self.authority_fixture('finalizer')
            proof['ledger_targets'][key]['relation'] = 'radar_rehearsal_' + self.nonce + '_schema.business'
            for grant in proof['measurement']['write_grants']:
                grant['relation'] = proof['ledger_targets'][key]['relation'] if grant['operation'] == (
                    'INSERT' if key == 'completion' else 'UPDATE') and grant['columns'] == proof['ledger_targets'][key]['columns'] else grant['relation']
            with self.assertRaisesRegex(expiry.Refusal, 'managed-authority-acl'):
                self.check_authority(record, proof, config, argv, 'finalizer')

    def test_finalizer_matching_measurement_cannot_change_fixed_columns(self):
        for index, key in enumerate(('operations', 'tables', 'completion')):
            record, proof, config, argv = self.authority_fixture('finalizer')
            columns = list(proof['ledger_targets'][key]['columns'])
            columns[0] = 'business_write'
            columns.sort()
            proof['ledger_targets'][key]['columns'] = columns
            proof['measurement']['write_grants'][index]['columns'] = columns
            with self.assertRaisesRegex(expiry.Refusal, 'managed-authority-acl'):
                self.check_authority(record, proof, config, argv, 'finalizer')

    def test_finalizer_rejects_completion_update_and_extra_writes(self):
        for mutation in ('update', 'extra', 'schema'):
            record, proof, config, argv = self.authority_fixture('finalizer')
            if mutation == 'update':
                proof['measurement']['write_grants'][2]['operation'] = 'UPDATE'
            elif mutation == 'extra':
                proof['measurement']['write_grants'].append({'relation': 'business', 'operation': 'UPDATE', 'columns': ['value']})
            else:
                relation = 'public.full_data_preservation_operations'
                proof['ledger_targets']['operations']['relation'] = relation
                proof['measurement']['write_grants'][0]['relation'] = relation
            with self.assertRaisesRegex(expiry.Refusal, 'managed-authority-acl'):
                self.check_authority(record, proof, config, argv, 'finalizer')

    def test_native_systemctl_formatted_timespans(self):
        self.assertEqual(expiry.native_timespan_usec('10s'), 10000000)
        self.assertEqual(expiry.native_timespan_usec('500ms'), 500000)
        self.assertEqual(expiry.native_timespan_usec('1min 500ms'), 60500000)
        self.assertEqual(expiry.native_timespan_usec('1.250s'), 1250000)
        for value in ['infinity', '-1s', '1ns', '1.0000001s', '10s trailing', ' 10s']:
            with self.assertRaises(expiry.Refusal):
                expiry.native_timespan_usec(value)
        props, binding = self.managed_props()
        props.update(RuntimeMaxUSec='1min', TimeoutStopUSec='10s', CPUQuotaPerSecUSec='250ms')
        expiry.validate_unit_properties(props, binding['unit'], binding['policy'], 'producer', '/private/artifacts')

    def test_finalizer_api_never_opens_producer(self):
        with patch.object(expiry, 'managed_unit_lease') as managed:
            expiry.managed_finalizer_lease(self.nonce, '/record', 'a' * 64, 'b' * 16,
                                           ledger_authority_sha256='c' * 64)
            self.assertEqual(managed.call_args.args[-2:], ('finalizer', 'c' * 64))

    def test_launch_checks_original_budget_after_executable_pin(self):
        record = self.managed_record()
        record['artifacts']['managed'] = {'systemd-run': dict(self.pin, path='/usr/bin/systemd-run')}
        backend = expiry.SystemdBackend(record)
        backend.launch_until, backend.launch_reserve = 100, 35
        with patch.object(expiry, 'root_path_pin', return_value=record['artifacts']['managed']['systemd-run']), \
             patch.object(expiry.time, 'monotonic', return_value=66), \
             patch.object(expiry.subprocess, 'run') as launch:
            with self.assertRaisesRegex(expiry.Refusal, 'managed-unit-budget'):
                backend.run('systemd-run', [])
            launch.assert_not_called()

    def test_setup_cost_clips_runtime_and_preserves_original_deadline(self):
        record = self.managed_record()
        record['artifacts']['managed'] = {'helper': dict(self.pin, path='/helper'),
                                          'python': dict(self.pin, path='/python')}
        with patch.object(expiry, 'SystemdBackend'):
            lease = expiry.ManagedUnitLease(record, '/record', 'a' * 64, 'b' * 16, 'producer',
                                            20, 10, expiry.initial_state(record))
        with patch.object(expiry.time, 'time', return_value=record['created_at']), \
             patch.object(expiry.time, 'monotonic', side_effect=[100, 110]), \
             patch.object(expiry, 'root_path_pin', side_effect=lambda path: dict(self.pin, path=path)), \
             patch.object(expiry, 'artifact_proof'), \
             patch.object(expiry, 'invocation_directory', side_effect=RuntimeError('capture')):
            with self.assertRaisesRegex(RuntimeError, 'capture'):
                lease.start_approved_unit(['/node', '/private/artifacts/runner.mjs'],
                    runtime_seconds=60, memory_max_bytes=67108864, tasks_max=8, cpu_quota_percent=25)
        self.assertEqual(lease.until, 185)
        lease.backend.launch.assert_not_called()

    def test_wait_never_resets_original_monotonic_deadline(self):
        record = self.managed_record()
        with patch.object(expiry, 'SystemdBackend'):
            lease = expiry.ManagedUnitLease(record, '/record', 'a' * 64, 'b' * 16, 'producer',
                                            20, 10, expiry.initial_state(record))
        lease.binding, lease.cgroup, lease.until = {}, unittest.mock.Mock(), 10
        with patch.object(expiry.time, 'monotonic', return_value=10), \
             patch.object(expiry, 'terminal_empty') as terminal:
            with self.assertRaisesRegex(expiry.Refusal, 'managed-unit-timeout'):
                lease.wait_terminal_and_empty()
            terminal.assert_not_called()
        self.assertEqual(lease.until, 10)

    def test_request_tombstone_never_reused(self):
        with tempfile.TemporaryDirectory() as path:
            fd = os.open(path, expiry.DIRECTORY)
            try:
                expiry.write_control_file(fd, 'request.json', b'{}')
                with self.assertRaises(FileExistsError):
                    expiry.write_control_file(fd, 'request.json', b'{}')
            finally:
                os.close(fd)

    def test_gate_does_not_execute_before_admission(self):
        record = self.managed_record()
        argv = ['/usr/bin/node', '/private/artifacts/runner.mjs']
        header = {'unit': expiry.unit_name(self.nonce, 'producer', 'b' * 16),
                  'record_sha256': 'a' * 64, 'command_sha256': expiry.digest(expiry.canonical(argv)),
                  'execution_pin': self.pin, 'deadline': 1001}
        with patch.object(expiry, 'control_reader', return_value=20), \
             patch.object(expiry, 'invocation_file', side_effect=[(header, 'a' * 64), FileNotFoundError]), \
             patch.object(expiry, 'root_path_pin', return_value=self.pin), \
             patch.object(expiry.os, 'close'), patch.object(expiry.os, 'execve') as execute, \
             patch.object(expiry.time, 'time', return_value=1000), \
             patch.object(expiry.time, 'monotonic', side_effect=[0, 0, 2]), patch.object(expiry.time, 'sleep'):
            with self.assertRaisesRegex(expiry.Refusal, 'managed-admission-timeout'):
                expiry.managed_workload(record, 'a' * 64, 'b' * 16, 'producer', argv)
            execute.assert_not_called()

    def test_unit_wait_race_does_not_clear_active_proof(self):
        record = self.managed_record()
        with patch.object(expiry, 'SystemdBackend'):
            lease = expiry.ManagedUnitLease(record, '/record', 'a' * 64, 'b' * 16, 'producer',
                                            20, 10, expiry.initial_state(record))
        _, binding = self.managed_props()
        lease.binding, lease.cgroup, lease.until = binding, unittest.mock.Mock(), 100
        with patch.object(expiry.time, 'monotonic', return_value=0), \
             patch.object(expiry, 'terminal_empty', side_effect=FileNotFoundError), \
             patch.object(expiry, 'update_control_state') as update:
            with self.assertRaises(FileNotFoundError):
                lease.wait_terminal_and_empty()
            self.assertFalse(lease.complete)
            update.assert_not_called()

    def test_independent_unit_receipt_before_active_proof_clear(self):
        record = self.managed_record()
        state = dict(expiry.initial_state(record), producer={'unit': expiry.unit_name(self.nonce, 'producer', 'b' * 16)})
        with patch.object(expiry, 'SystemdBackend'):
            lease = expiry.ManagedUnitLease(record, '/record', 'a' * 64, 'b' * 16, 'producer', 20, 10, state)
        _, binding = self.managed_props()
        lease.binding, lease.cgroup, lease.until = binding, unittest.mock.Mock(), 100
        events = []
        with patch.object(expiry.time, 'monotonic', return_value=0), patch.object(expiry, 'terminal_empty', return_value=True), \
             patch.object(expiry, 'persist_managed_receipt', side_effect=lambda *args: events.append('receipt') or 'a' * 64), \
             patch.object(expiry, 'read_control_state', return_value=state), \
             patch.object(expiry, 'update_control_state', side_effect=lambda fd, rec, old, new: events.append('clear') or new):
            self.assertEqual(lease.wait_terminal_and_empty()['status'], 'quiescent')
            self.assertEqual(events, ['receipt', 'clear'])

    def test_managed_workload_cli_preserves_payload_and_contract(self):
        output = io.StringIO()
        record = self.managed_record()
        with patch.object(expiry, 'trusted_runtime'), patch.object(expiry, 'load_record', return_value=record), \
             patch.object(expiry, 'managed_workload') as gate, contextlib.redirect_stdout(output):
            expiry.main(['managed-workload', '--nonce', self.nonce, '--record', '/record',
                         '--expected-sha256', 'a' * 64, '--request-nonce', 'b' * 16, '--role', 'producer',
                         '--', '/usr/bin/node', '/private/artifacts/runner.mjs', '--mode', 'verify'])
            self.assertEqual(gate.call_args.args[-1], ['/usr/bin/node', '/private/artifacts/runner.mjs', '--mode', 'verify'])



if __name__ == '__main__':
    unittest.main()
