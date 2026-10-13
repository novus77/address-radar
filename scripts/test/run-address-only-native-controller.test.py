import copy
import contextlib
import importlib.util
from pathlib import Path
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('controller', Path(__file__).parents[1] / 'run-address-only-native-controller.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ControllerTests(unittest.TestCase):
    def config(self):
        pin = {'path': str(m.ROOT / 'tool.py'), 'sha256': 'a' * 64}
        output = str(m.ROOT / 'address-only-run-op')
        return {'protocol': 'address-only-controller-v1', 'operationId': 'op',
                **{key: copy.deepcopy(pin) for key in ('fence', 'reconcile', 'exporter', 'validator', 'launcher', 'node')},
                'outputDirectory': output, 'jobTemplate': {'operationId': 'op', 'action': 'plan',
                    'outputDirectory': output, 'sourceFence': pin}}

    def test_explicit_protocol(self):
        m.validate_config(self.config())

    def test_rejects_unknown_fields(self):
        config = self.config()
        config['ignoreFailure'] = True
        with self.assertRaises(ValueError):
            m.validate_config(config)

    def test_rejects_outside_output(self):
        config = self.config()
        config['outputDirectory'] = '/tmp/address-only-run-op'
        with self.assertRaises(ValueError):
            m.validate_config(config)

    def test_rejects_cross_operation_job(self):
        for key, value in [('operationId', 'other'), ('action', 'import'),
                           ('outputDirectory', '/tmp/other'), ('sourceFence', {})]:
            with self.subTest(key=key):
                config = self.config()
                config['jobTemplate'][key] = value
                with self.assertRaises(ValueError):
                    m.validate_config(config)

    def test_rejects_unpinned_external_path_before_open(self):
        with self.assertRaises(ValueError):
            m.pinned_read({'path': '/tmp/tool.py', 'sha256': 'a' * 64})

    def test_bounded_child_success(self):
        self.assertEqual(m.bounded_child([sys.executable, '-c', 'print("ok")']), b'ok\n')

    def test_bounded_child_rejects_overflow(self):
        with self.assertRaisesRegex(ValueError, 'launcher_output_budget'):
            m.bounded_child([sys.executable, '-c', 'import sys; sys.stdout.write("x"*100000)'])

    def test_bounded_child_retires_timeout(self):
        with self.assertRaisesRegex(ValueError, 'launcher_deadline'):
            m.bounded_child([sys.executable, '-c', 'import time; time.sleep(10)'], seconds=0.05)

    def test_failure_diagnostic_is_bounded_and_does_not_disclose_child_secrets(self):
        captured = []
        program = "import sys; print('{\"status\":\"address-only-native-refused-or-uncertain\",\"password\":\"secret\"}'); sys.stderr.write('postgresql://role:secret@host'); sys.exit(3)"
        with self.assertRaisesRegex(ValueError, 'launcher_refused_or_uncertain'):
            m.bounded_child([sys.executable, '-c', program], diagnostic=captured.append)
        self.assertEqual(captured[0]['returnCode'], 3)
        self.assertEqual(captured[0]['child']['status'], 'address-only-native-refused-or-uncertain')
        self.assertNotIn('secret', str(captured))

    def test_timeout_and_stderr_overflow_capture_safe_reason(self):
        for program, seconds, reason in [('import time; time.sleep(10)', 0.05, 'launcher_deadline'),
                ('import sys; sys.stderr.write("x"*100000)', 5, 'launcher_output_budget')]:
            captured = []
            with self.assertRaisesRegex(ValueError, reason):
                m.bounded_child([sys.executable, '-c', program], seconds=seconds, diagnostic=captured.append)
            self.assertEqual(captured[0]['reason'], reason)
            self.assertLessEqual(captured[0]['stderrBytes'], 65537)

    def test_diagnostic_private_persistence(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            value = m.child_diagnostic(b'not json secret', b'secret', 1, 20, 'launcher_refused_or_uncertain')
            pin = m.write_private(Path(root), 'import-child-diagnostic.json', m.canonical(value))
            self.assertEqual(Path(pin['path']).stat().st_mode & 0o777, 0o600)
            self.assertNotIn('secret', Path(pin['path']).read_text())

    def boundary(self, committed):
        @contextlib.contextmanager
        def reconcile(binding, deadline):
            yield {'committedMatches': committed, 'assert_alive_and_locked': lambda: None}
        fence = SimpleNamespace(state={'phase': 'IMPORT_INTENT', 'binding': {}},
            deadline=SimpleNamespace, restore_before_import=Mock(), reconcile_committed_import=Mock())
        fence.deadline = lambda seconds: None
        class Deadline:
            def __init__(self, seconds=1):
                self.seconds = seconds
        fence.deadline = Deadline()
        def mark(callback):
            fence.state['phase'] = 'IMPORT_COMMITTED'
        fence.reconcile_committed_import.side_effect = mark
        return fence, SimpleNamespace(reconcile_import=reconcile)

    def test_matching_commit_never_restores(self):
        fence, reconcile = self.boundary(True)
        self.assertTrue(m.reconcile_failed_import(fence, reconcile))
        fence.restore_before_import.assert_not_called()
        fence.reconcile_committed_import.assert_called_once()

    def test_absent_commit_restores_only_after_classification(self):
        fence, reconcile = self.boundary(False)
        self.assertFalse(m.reconcile_failed_import(fence, reconcile))
        fence.restore_before_import.assert_called_once()
        fence.reconcile_committed_import.assert_not_called()

    def test_unknown_commit_never_restores(self):
        fence, reconcile = self.boundary(False)
        reconcile.reconcile_import = Mock(side_effect=ValueError('unknown'))
        with self.assertRaisesRegex(ValueError, 'unknown'):
            m.reconcile_failed_import(fence, reconcile)
        fence.restore_before_import.assert_not_called()


if __name__ == '__main__':
    unittest.main()
