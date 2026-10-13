import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest

path = Path(__file__).parents[1] / 'run-pg-source-replacement.py'
spec = importlib.util.spec_from_file_location('source_stage', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class StageTests(unittest.TestCase):
    def test_recovery_failure_preserves_primary_and_marks_hold(self):
        context = FakeContext([], failure='probe')
        def recovery():
            raise FileNotFoundError('removed-publication')
        with self.assertRaisesRegex(ValueError, '^probe$'):
            m.run_transition(context, lambda: None, lambda: None, lambda: None, recovery)
        self.assertEqual(context.recovery_status, 'UNVERIFIED_HOLD')
        self.assertEqual(context.calls[-1], 'preserve-fence')
        self.assertFalse(context._gate.active)

    def test_verified_reblock_is_distinct_from_uncertain_recovery(self):
        context = FakeContext([], failure='probe')
        with self.assertRaisesRegex(ValueError, '^probe$'):
            m.run_transition(context, lambda: None, lambda: None, lambda: None, lambda: None)
        self.assertEqual(context.recovery_status, 'VERIFIED_BLOCKED')

    def test_hold_write_failure_never_masks_primary_failure(self):
        for recovery_fails in (False, True):
            with self.subTest(recovery_fails=recovery_fails):
                context = FakeContext([])
                primary = ValueError('primary')
                def fail():
                    raise primary
                def recovery():
                    if recovery_fails:
                        raise FileNotFoundError('removed-publication')
                def preserve():
                    raise OSError('disk-full')
                context.preserve = preserve
                try:
                    with self.assertRaises(ValueError) as raised:
                        m.run_transition(context, fail, lambda: None, lambda: None, recovery)
                    self.assertIs(raised.exception, primary)
                    self.assertFalse(context.hold_persisted)
                    self.assertFalse(context._gate.active)
                    self.assertEqual(context.recovery_status,
                        'UNVERIFIED_HOLD' if recovery_fails else 'VERIFIED_BLOCKED')
                finally:
                    context._tmp.cleanup()

    def test_successful_hold_persistence_is_explicit(self):
        context = FakeContext([], failure='probe')
        with self.assertRaisesRegex(ValueError, '^probe$'):
            m.run_transition(context, lambda: None, lambda: None, lambda: None, lambda: None)
        self.assertTrue(context.hold_persisted)

    def test_entry_exists(self):

        self.assertTrue(callable(getattr(m, 'run_transition', None)))

    def test_same_owner_order_and_no_early_handoff(self):
        calls = []
        context = FakeContext(calls)
        result = m.run_transition(context, lambda: calls.append('preflight'), lambda: calls.append('controller-stop'),
            lambda: (context.before_unguard(context.adapter), calls.append('start-new'), 'ready')[2], lambda: calls.append('reblock'))
        self.assertEqual(result, 'ready')
        self.assertEqual(calls, ['rotation', 'bind-native-guards', 'verify-native-guards', 'controller-stop', 'physical-drain-window',
            'import', 'probe', 'preflight', 'publish-bindings', 'handoff', 'start-new'])

    def test_probe_defer_never_publishes_or_unfences(self):
        calls = []
        context = FakeContext(calls, failure='probe')
        with self.assertRaisesRegex(ValueError, 'probe'):
            m.run_transition(context, lambda: calls.append('preflight'), lambda: calls.append('controller-stop'),
                lambda: calls.append('deploy'), lambda: calls.append('reblock'))
        self.assertNotIn('deploy', calls)
        self.assertNotIn('handoff', calls)
        self.assertEqual(calls[-2:], ['reblock', 'preserve-fence'])

    def test_uncertain_import_never_retries(self):
        calls = []
        context = FakeContext(calls, failure='import')
        with self.assertRaises(ValueError):
            m.run_transition(context, lambda: None, lambda: None, lambda: None, lambda: calls.append('reblock'))
        self.assertEqual(calls.count('import'), 1)
        self.assertNotIn('probe', calls)

    def test_preflight_failure_preserves_original_and_pg_fences(self):
        calls = []
        context = FakeContext(calls)
        def fail(): raise ValueError('preflight')
        with self.assertRaises(ValueError):
            m.run_transition(context, fail, lambda: None, lambda: calls.append('deploy'), lambda: calls.append('reblock'))
        self.assertEqual(calls[-2:], ['reblock', 'preserve-fence'])

    def test_handoff_requires_actual_adapter_not_receipt_json(self):
        calls = []
        context = FakeContext(calls)
        with self.assertRaisesRegex(ValueError, 'adapter_identity'):
            m.before_unguard(context, object())
        self.assertNotIn('handoff', calls)

    def test_borrowed_fence_closes_duplicate_not_parent_lock(self):
        with tempfile.TemporaryDirectory() as root:
            import fcntl
            lock = Path(root) / 'controller.lock'
            parent = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
            owner = types.SimpleNamespace(fd=parent, owned=lambda: None, n=types.SimpleNamespace(lock_path=lock))
            class Legacy:
                @classmethod
                def recover(cls, deadline):
                    self = cls.__new__(cls)
                    self._lock_control(deadline)
                    return self
                def close(self):
                    fcntl.flock(self.lock, fcntl.LOCK_UN)
                    os.close(self.lock)
            module = types.SimpleNamespace(NativeSourceFence=Legacy, CONTROL=str(root),
                private_directory=lambda *_args, **_kwargs: None, private_file=lambda _s: None,
                Journal=lambda: object())
            recovered = m.delegated_fence_type(module, owner).recover(object())
            self.assertNotEqual(recovered.lock, parent)
            recovered.close()
            program = "import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(37)"
            try:
                result = subprocess.run([sys.executable, '-c', program, str(lock)], timeout=3, capture_output=True)
                self.assertEqual(result.returncode, 37)
                os.fstat(parent)
            finally: os.close(parent)

    def test_executable_refuses_until_native_binding_exists(self):
        result = subprocess.run([sys.executable, str(path)], capture_output=True, timeout=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"native_stage_binding_not_implemented", result.stderr)

    def test_deploy_without_handoff_is_not_success(self):
        calls = []
        context = FakeContext(calls)
        with self.assertRaisesRegex(ValueError, "handoff_not_completed"):
            m.run_transition(context, lambda: None, lambda: None, lambda: "ready", lambda: calls.append("reblock"))
        self.assertEqual(calls[-2:], ["reblock", "preserve-fence"])

class FakeContext:
    def __init__(self, calls, failure=None):
        self.calls, self.failure = calls, failure
        self.adapter = object()
        self.handed_off = False
        self.owner = types.SimpleNamespace(owned=lambda: None)
    def rotate(self): self.calls.append('rotation')
    def bind_guards(self): self.calls.append('bind-native-guards')
    def drain(self): self.calls.append('physical-drain-window')
    def phase(self, name):
        self.calls.append(name)
        if name == self.failure: raise ValueError(name)
    def preserve(self): self.calls.append('preserve-fence')
    def publication(self, adapter):
        if adapter is not self.adapter: raise ValueError('adapter_identity')
        self.calls.append('publish-bindings')
    def handoff(self): self.calls.append('handoff')
    def before_unguard(self, adapter): return m.before_unguard(self, adapter)

 

# Real flock owners for sequencing tests; service/controller ports remain doubles.
_old_context_init = FakeContext.__init__
def _context_init(self, calls, failure=None):
    _old_context_init(self, calls, failure)
    self._tmp = tempfile.TemporaryDirectory()
    self._path = Path(self._tmp.name) / 'controller.lock'
    self._fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
    import fcntl
    fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    self.owner = types.SimpleNamespace(fd=self._fd, owned=lambda: None,
        n=types.SimpleNamespace(lock_path=self._path))
    self._gate = None

def _context_close(self):
    fd = getattr(self, '_fd', None)
    if fd is not None:
        os.close(fd)
        self._fd = None
    tmp = getattr(self, '_tmp', None)
    if tmp is not None:
        tmp.cleanup()

FakeContext.__init__ = _context_init
FakeContext.__del__ = _context_close
FakeContext.bind_unguard_gate = lambda self, gate: setattr(self, '_gate', gate) or gate
FakeContext.verify_guards = lambda self: self.calls.append('verify-native-guards')
FakeContext.before_unguard = lambda self, adapter: self._gate(adapter)


class SafetyTests(unittest.TestCase):
    def test_guards_are_verified_before_stop(self):
        calls = []
        context = FakeContext(calls)
        def stop():
            self.assertEqual(calls[-1], 'verify-native-guards')
            calls.append('stop')
        def deploy():
            context.before_unguard(context.adapter)
        m.run_transition(context, lambda: None, stop, deploy, lambda: None)
        self.assertLess(calls.index('verify-native-guards'), calls.index('stop'))

    def test_unbound_gate_fails_before_rotation_or_stop(self):
        calls = []
        context = FakeContext(calls)
        context.bind_unguard_gate = lambda gate: None
        with self.assertRaisesRegex(ValueError, 'unguard_gate_not_bound'):
            m.run_transition(context, lambda: None, lambda: calls.append('stop'),
                lambda: calls.append('start'), lambda: calls.append('reblock'))
        self.assertNotIn('rotation', calls)
        self.assertNotIn('stop', calls)
        self.assertNotIn('start', calls)

    def test_gate_rejects_preflight_start_and_is_revoked_on_failure(self):
        calls = []
        context = FakeContext(calls)
        def premature_start():
            context.before_unguard(context.adapter)
            calls.append('start')
        with self.assertRaisesRegex(ValueError, 'unguard_gate_inactive'):
            m.run_transition(context, premature_start, lambda: None,
                premature_start, lambda: calls.append('reblock'))
        self.assertNotIn('start', calls)
        self.assertNotIn('handoff', calls)
        with self.assertRaisesRegex(ValueError, 'unguard_gate_inactive'):
            context.before_unguard(context.adapter)

    def test_unlock_via_duplicate_is_detected_before_import(self):
        import fcntl
        calls = []
        context = FakeContext(calls)
        def drain():
            duplicate = os.dup(context.owner.fd)
            try:
                fcntl.flock(duplicate, fcntl.LOCK_UN)
            finally:
                os.close(duplicate)
        context.drain = drain
        with self.assertRaisesRegex(ValueError, 'controller_lock_not_retained'):
            m.run_transition(context, lambda: None, lambda: None,
                lambda: calls.append('start'), lambda: calls.append('reblock'))
        self.assertNotIn('import', calls)
        self.assertNotIn('start', calls)
        self.assertEqual(calls[-2:], ['reblock', 'preserve-fence'])

    def test_gate_revoked_after_success(self):
        context = FakeContext([])
        m.run_transition(context, lambda: None, lambda: None,
            lambda: context.before_unguard(context.adapter), lambda: None)
        with self.assertRaisesRegex(ValueError, 'unguard_gate_inactive'):
            context.before_unguard(context.adapter)


if __name__ == '__main__': unittest.main()
