import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('launcher', Path(__file__).resolve().parents[1] / 'launch-segmented-postgres-preservation.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def fixture(self, stage='verify', request='b' * 16):
        nonce, code = 'a' * 16, b'fixed pinned code'
        root, control = launcher.ARTIFACT_PARENT + '/' + nonce, launcher.CONTROL_PARENT + '/' + nonce
        pin = hashlib.sha256(code).hexdigest()
        config = {'version': 2, 'nonce': nonce, 'stage': stage, 'runnerSha256': pin,
                  'sourceReaderSha256': pin, 'authorityModuleSha256': pin,
                  'invocation': {'requestNonce': request, 'deadlineAtMs': 901000, 'timeoutMs': 900000}}
        raw = json.dumps(config).encode()
        path = root + '/call.json'
        role = {'import': 'producer', 'verify': 'verifier', 'finalize': 'finalizer'}[stage]
        sha = hashlib.sha256(raw).hexdigest()
        authority = {'version': 1, 'nonce': nonce, 'configs': {'call.json': sha}} if role == 'producer' else {
            'version': 2, 'nonce': nonce, 'role': role, 'request_nonce': request,
            'config_relative': 'call.json', 'credential_ref': sha}
        argv = [os.path.realpath(sys.executable), root + '/launch-segmented-postgres-preservation.py', path]
        header = {'version': 1, 'record_sha256': 'c' * 64, 'deadline': 926, 'policy': {'runtime_seconds': 900}, 'unit': 'radar-rehearsal-' + nonce + '-' + role + '-' + request + '.service',
                  'role': role, 'request_nonce': request, 'command_sha256': hashlib.sha256(launcher.canonical(argv)).hexdigest()}
        def read(name, maximum):
            if name == path:
                return raw
            if name.startswith(control + '/invocations/'):
                return json.dumps(header).encode()
            if name.startswith(control + '/'):
                return json.dumps(authority).encode()
            return code
        return [path], read

    def test_exact_three_helper_argv_becomes_single_config_launcher(self):
        args, read = self.fixture()
        argv, output = launcher.launch_spec(args, read, 1000)
        self.assertEqual(argv[:9], ['/usr/bin/ionice', '-c', '3', '/usr/bin/nice', '-n', '19',
                                   launcher.NODE_PATH, '--max-old-space-size=96', '--expose-gc'])
        self.assertEqual(argv[10:], args)
        self.assertEqual(output, launcher.CONTROL_PARENT + '/' + 'a' * 16 + '/receipts/' + 'b' * 16 + '/' + 'b' * 16 + '-verify.json')

    def test_all_stage_outputs_are_control_receipts(self):
        for stage in ('import', 'verify', 'finalize'):
            args, read = self.fixture(stage)
            self.assertTrue(launcher.launch_spec(args, read, 1000)[1].endswith('-' + stage + '.json'))

    def test_no_argv_shortcut(self):
        args, read = self.fixture()
        for arguments in [args + ['deadline'], ['/tmp/call.json'],
                          [launcher.ARTIFACT_PARENT + '/' + 'a' * 16 + '/../call.json']]:
            with self.assertRaises(ValueError):
                launcher.launch_spec(arguments, read, 1000)

    def test_protected_config_pin_required(self):
        args, read = self.fixture()
        def changed(path, maximum):
            raw = read(path, maximum)
            if path.endswith('/db-readonly.json'):
                value = json.loads(raw)
                value['credential_ref'] = 'c' * 64
                return json.dumps(value).encode()
            return raw
        with self.assertRaises(ValueError):
            launcher.launch_spec(args, changed, 1000)

    def test_terminal_identity_not_fabricated_by_config(self):
        args, read = self.fixture()
        def changed(path, maximum):
            raw = read(path, maximum)
            if '/invocations/' in path:
                value = json.loads(raw)
                value['command_sha256'] = 'c' * 64
                return json.dumps(value).encode()
            return raw
        with self.assertRaises(ValueError):
            launcher.launch_spec(args, changed, 1000)

    def test_output_names_unique_per_request(self):
        args, read = self.fixture()
        first = launcher.launch_spec(args, read, 1000)[1]
        args, read = self.fixture(request='c' * 16)
        self.assertNotEqual(first, launcher.launch_spec(args, read, 1000)[1])



class ProofTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.temporary = tempfile.TemporaryDirectory()
        self.path = self.temporary.name
        os.chmod(self.path, 0o700)
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY)
        self.binding = {'nonce': 'a' * 16, 'request_nonce': 'b' * 16, 'stage': 'verify',
                        'record_sha256': 'c' * 64, 'unit': 'radar-rehearsal-' + 'a' * 16 + '-verifier-' + 'b' * 16 + '.service',
                        'invocation_id': 'd' * 32, 'control_group': '/system.slice/exact.service',
                        'cgroup_identity': [1, 2], 'config_sha256': 'e' * 64,
                        'runner_sha256': 'f' * 64, 'source_reader_sha256': '1' * 64}
        self.body = {'version': 2, 'stage': 'verify', 'requestNonce': 'b' * 16,
                     'productionAuthorized': False, 'grantsBusinessEligibility': False, 'parityComplete': False}

    def tearDown(self):
        os.close(self.fd)
        self.temporary.cleanup()

    @staticmethod
    def simulated_noreplace(fd, source, destination):
        # Local syscall seam only. Production has no link/rename fallback.
        os.link(source, destination, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(source, dir_fd=fd)

    def publish(self):
        return launcher.publish_proof_at(self.fd, self.body, self.binding,
                                         expected_uid=os.getuid(), atomic_publish=self.simulated_noreplace)

    def test_exclusive_roundtrip_and_no_overwrite(self):
        proof = self.publish()
        self.assertEqual(launcher.read_proof_at(self.fd, proof['name'], self.binding, proof['sha256'], expected_uid=os.getuid()), self.body)
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(os.stat(proof['name'], dir_fd=self.fd).st_nlink, 1)

    def test_symlink_and_hardlink_are_refused(self):
        proof = self.publish()
        os.link(proof['name'], 'another', src_dir_fd=self.fd, dst_dir_fd=self.fd)
        with self.assertRaises(ValueError):
            launcher.read_proof_at(self.fd, proof['name'], self.binding, proof['sha256'], expected_uid=os.getuid())
        os.unlink('another', dir_fd=self.fd)
        os.unlink(proof['name'], dir_fd=self.fd)
        os.symlink('another', proof['name'], dir_fd=self.fd)
        with self.assertRaises(OSError):
            launcher.read_proof_at(self.fd, proof['name'], self.binding, proof['sha256'], expected_uid=os.getuid())

    def test_binding_size_and_digest_refusal(self):
        proof = self.publish()
        changed = dict(self.binding, runner_sha256='2' * 64)
        with self.assertRaises(ValueError):
            launcher.read_proof_at(self.fd, proof['name'], changed, proof['sha256'], expected_uid=os.getuid())
        with self.assertRaises(ValueError):
            launcher.read_proof_at(self.fd, proof['name'], self.binding, '2' * 64, expected_uid=os.getuid())
        self.body['oversize'] = 'x' * launcher.MAX_PROOF_BYTES
        with self.assertRaises(ValueError):
            self.publish()


class AtomicAndManagedTests(unittest.TestCase):
    def test_actual_renameat2_noreplace_flag_and_errno(self):
        from unittest.mock import patch
        import ctypes
        class Rename:
            def __init__(self, result): self.result, self.calls = result, []
            def __call__(self, *args): self.calls.append(args); return self.result
        class Lib: pass
        lib = Lib(); lib.renameat2 = Rename(0)
        with patch('ctypes.CDLL', return_value=lib):
            launcher.rename_noreplace(7, 'temporary', 'final')
        self.assertEqual(lib.renameat2.calls, [(7, b'temporary', 7, b'final', 1)])
        lib.renameat2 = Rename(-1)
        with patch('ctypes.CDLL', return_value=lib), patch('ctypes.get_errno', return_value=17):
            with self.assertRaises(FileExistsError): launcher.rename_noreplace(7, 'temporary', 'final')

    def test_managed_stage_waits_empty_before_proof_publication(self):
        from unittest.mock import patch
        from contextlib import contextmanager
        events = []
        nonce, request, sha = 'a' * 16, 'b' * 16, 'c' * 64
        root = launcher.ARTIFACT_PARENT + '/' + nonce
        config = {'nonce': nonce, 'stage': 'import', 'invocation': {'requestNonce': request}}
        class Lease:
            def start_approved_unit(self, argv, **limits):
                events.append('start'); self.argv = argv
                self_test.assertEqual(limits['runtime_seconds'], 180)
                self_test.assertEqual(limits['memory_max_bytes'], 268435456)
            def wait_terminal_and_empty(self): events.append('empty')
        self_test = self
        class Helper:
            @staticmethod
            def load_record(*args): return {'nonce': nonce, 'artifacts': {'root': root, 'control': {}}}
            @staticmethod
            @contextmanager
            def managed_producer_lease(*args):
                events.append('lease'); yield Lease(); events.append('lease-exit')
            @staticmethod
            @contextmanager
            def control_scope(*args, **kwargs): yield (4, 5, 6)
            @staticmethod
            def read_at(*args, **kwargs): return (b'{"binding":{}}', {})
        proof = {'name': request+'-import.proof.json', 'sha256': hashlib.sha256(b'{"binding":{}}').hexdigest()}
        with patch.object(launcher, 'protected_bytes', return_value=json.dumps(config).encode()), \
             patch.object(launcher, 'publish_measured_stage_proof', side_effect=lambda *args: (events.append('publish') or proof)), \
             patch.object(launcher, 'read_proof_at', return_value={'stage': 'import'}), \
             patch('os.open', return_value=10), patch('os.close'):
            result = launcher.run_managed_stage(Helper, '/record', sha, nonce, root+'/call.json', 180)
        self.assertEqual(events, ['lease', 'start', 'empty', 'lease-exit', 'publish'])
        self.assertEqual(result['report']['stage'], 'import')

    def test_shortened_managed_budget_rejected_despite_fresh_config(self):
        args, read = LauncherTests().fixture()
        def changed(path, maximum):
            raw = read(path, maximum)
            if '/invocations/' in path:
                header = json.loads(raw); header['deadline'] = 30; return json.dumps(header).encode()
            return raw
        with self.assertRaisesRegex(ValueError, 'managed_clipped_budget'):
            launcher.launch_spec(args, changed, 1000)

class WriterOrderingTests(ProofTests):
    def test_size_refusal_precedes_exclusive_creation(self):
        from unittest.mock import patch
        self.body['oversize'] = 'x' * launcher.MAX_PROOF_BYTES
        with patch('os.open') as create:
            with self.assertRaisesRegex(ValueError, 'proof_size'):
                self.publish()
            create.assert_not_called()

    def test_file_fsync_precedes_atomic_publish_and_directory_fsync_follows(self):
        from unittest.mock import patch
        events = []
        real_fsync = os.fsync
        def synced(fd):
            events.append('directory-fsync' if fd == self.fd else 'file-fsync')
            return real_fsync(fd)
        def publish(fd, source, destination):
            events.append('publish')
            return self.simulated_noreplace(fd, source, destination)
        with patch('os.fsync', side_effect=synced):
            launcher.publish_proof_at(self.fd, self.body, self.binding, expected_uid=os.getuid(), atomic_publish=publish)
        self.assertEqual(events, ['file-fsync', 'publish', 'directory-fsync'])

    def test_invalid_directory_rejected_before_file_creation(self):
        from unittest.mock import patch
        os.chmod(self.path, 0o755)
        with patch('os.open') as create:
            with self.assertRaisesRegex(ValueError, 'proof_directory'): self.publish()
            create.assert_not_called()

class RuntimeTests(unittest.TestCase):
    def test_official_runtime_is_fixed_for_every_stage(self):
        self.assertEqual(launcher.NODE_SHA256, '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c')
        for stage in ('import', 'verify', 'finalize'):
            args, read = LauncherTests().fixture(stage)
            self.assertEqual(launcher.launch_spec(args, read, 1000)[0][6], launcher.NODE_PATH)
    def test_runtime_failure_precedes_output_creation(self):
        from unittest.mock import patch
        with patch.object(launcher.os, 'geteuid', return_value=0), patch.object(launcher, 'verify_node', side_effect=ValueError('runtime_refused')), patch.object(launcher.os, 'open') as create:
            with self.assertRaisesRegex(ValueError, 'runtime_refused'): launcher.main()
            create.assert_not_called()

class SpawnLifecycleTests(unittest.TestCase):
    def test_pidfd_failure_waits_actual_exit_without_signal(self):
        import subprocess
        from unittest.mock import Mock, patch
        child = Mock(pid=999)
        child.poll.side_effect = [None, None, 0]
        child.wait.side_effect = [subprocess.TimeoutExpired('fixed', .1), 0]
        with patch('subprocess.Popen', return_value=child), patch.object(launcher.os, 'pidfd_open', create=True, side_effect=OSError('pin_failed')), patch('os.kill') as numeric:
            with self.assertRaisesRegex(OSError, 'pin_failed'): launcher.spawn_pinned(['fixed'])
            self.assertEqual(child.wait.call_count, 2)
            numeric.assert_not_called()
    def test_spawn_failure_never_attempts_pin(self):
        from unittest.mock import patch
        with patch('subprocess.Popen', side_effect=OSError('spawn_failed')), patch.object(launcher.os, 'pidfd_open', create=True) as pin:
            with self.assertRaisesRegex(OSError, 'spawn_failed'): launcher.spawn_pinned(['fixed'])
            pin.assert_not_called()
    def test_success_returns_actual_pidfd(self):
        from unittest.mock import Mock, patch
        child = Mock(pid=999)
        with patch('subprocess.Popen', return_value=child), patch.object(launcher.os, 'pidfd_open', create=True, return_value=123) as pin:
            self.assertEqual(launcher.spawn_pinned(['fixed']), (child, 123))
            pin.assert_called_once_with(999)

if __name__ == '__main__':
    unittest.main()
