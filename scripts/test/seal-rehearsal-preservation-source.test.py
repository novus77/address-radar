import hashlib
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
SPEC = importlib.util.spec_from_file_location('source_sealer', Path(__file__).parents[1] / 'seal-rehearsal-preservation-source.py')
M = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(M)

class FakeNative:
    def __init__(self): self.values = {}; self.sets = []; self.leases = set(); self.crash = None
    def key(self, fd):
        info = os.fstat(fd); return info.st_dev, info.st_ino
    def flags(self, fd): return self.values.get(self.key(fd), 64)
    def set_flags(self, fd, flags):
        key = self.key(fd); self.values[key] = flags; self.sets.append(key)
        if self.crash == len(self.sets): raise RuntimeError('after_flag_crash')
    def lease(self, fd): self.leases.add(self.key(fd))
    def release(self, fd): self.leases.discard(self.key(fd))
    def publish(self, fd, temporary, final):
        # Local filesystems lack Linux renameat2; seam preserves no-replace semantics.
        os.link(temporary, final, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False); os.unlink(temporary, dir_fd=fd)

class Cases(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name); self.source = self.root / 'source'; self.control = self.root / 'control'
        self.source.mkdir(mode=0o700); self.control.mkdir(mode=0o700); (self.control / 'lock').write_bytes(b'lock'); (self.control / 'lock').chmod(0o600)
        body = b'{"chunk":"body"}'; self.name = 'table-0000-chunk-000000.json'; (self.source / self.name).write_bytes(body); (self.source / self.name).chmod(0o600)
        self.chunk_pin = M.digest(body)
        manifest = {'operationId': 'operation', 'snapshotSha256': 'b' * 64, 'catalogFingerprint': 'c' * 64, 'limits': {'maximumChunkBytes': 1024}, 'tables': [{'name': 'table', 'rowCount': 1, 'chunks': [{'file': self.name, 'table': 'table', 'ordinal': 0, 'startRow': 0, 'rowCount': 1, 'sha256': self.chunk_pin}]}]}
        raw = M.canonical(manifest); (self.source / 'manifest.json').write_bytes(raw); (self.source / 'manifest.json').chmod(0o600)
        self.policy = {'manifest': M.digest(raw), 'snapshot': 'b' * 64, 'catalog': 'c' * 64, 'operation': 'operation', 'tables': 1, 'chunks': 1, 'rows': 1, 'manifestBytes': len(raw)}
        self.native = FakeNative(); self.validations = 0
    def tearDown(self): self.tmp.cleanup()
    def validator(self, state):
        self.validations += 1
        self.assertEqual(len(self.native.leases), 2)
        info = os.stat(self.source)
        return {'status': 'source-validated', 'manifestSha256': self.policy['manifest'], 'operationId': 'operation', 'snapshotSha256': 'b' * 64, 'tables': 1, 'chunks': 1, 'rows': 1, 'rootIdentity': [info.st_dev, info.st_ino], 'totalBytes': (self.source / 'manifest.json').stat().st_size + (self.source / self.name).stat().st_size, 'files': {'manifest.json': self.policy['manifest'], self.name: self.chunk_pin}}
    def engine(self, validator=None):
        engine = M.Sealer(str(self.source), str(self.control), validator or self.validator, 'd' * 64, 'e' * 64, native=self.native, uid=os.getuid(), policy=self.policy)
        # The CLI requires root-protected ancestors; temp fixtures have /tmp ancestors.
        engine.protected = lambda path: None
        return engine
    def prepared(self): return M.digest((self.control / 'prepared.json').read_bytes())
    def test_full_validation_precedes_flags_and_preserves_bits(self):
        def validator(state):
            self.assertEqual(self.native.sets, []); return self.validator(state)
        result = self.engine(validator).run('seal')
        self.assertEqual(result['status'], 'sealed'); self.assertEqual(len(self.native.sets), 3)
        self.assertTrue(all(value == 80 for value in self.native.values.values())); self.assertEqual(self.native.leases, set())
    def test_bad_raw_hash_never_sets_flags(self):
        (self.source / self.name).write_bytes(b'bad')
        with self.assertRaisesRegex(M.Refused, 'source_digest'): self.engine().run('seal')
        self.assertEqual(self.native.sets, []); self.assertFalse((self.control / 'prepared.json').exists())
    def test_native_validator_failure_never_sets_flags(self):
        with self.assertRaisesRegex(RuntimeError, 'invalid'): self.engine(lambda _: (_ for _ in ()).throw(RuntimeError('invalid'))).run('seal')
        self.assertEqual(self.native.sets, [])
    def test_symlink_rejected(self):
        (self.source / self.name).unlink(); (self.source / self.name).symlink_to(self.source / 'manifest.json')
        with self.assertRaises(OSError): self.engine().run('seal')
        self.assertEqual(self.native.sets, [])
    def test_hardlink_rejected(self):
        os.link(self.source / self.name, self.source / 'alias')
        with self.assertRaisesRegex(M.Refused, 'source_file'): self.engine().run('seal')
    def test_known_intent_recovers_after_flag_before_done(self):
        self.native.crash = 1
        with self.assertRaisesRegex(RuntimeError, 'after_flag_crash'): self.engine().run('seal')
        self.native.crash = None; pin = self.prepared(); result = self.engine().run('recover', pin)
        self.assertEqual(result['status'], 'sealed'); self.assertEqual(self.validations, 2)
    def test_unknown_journal_fails_closed(self):
        (self.control / 'unknown').write_text('unknown')
        with self.assertRaisesRegex(M.Refused, 'unknown_journal_state'): self.engine().run('seal')
        self.assertEqual(self.native.sets, [])
    def test_recovery_wrong_pin_fails_closed(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        self.native.crash = None
        with self.assertRaisesRegex(M.Refused, 'recovery_binding'): self.engine().run('recover', '0' * 64)
        self.assertEqual(len(self.native.sets), 1)
    def test_lost_lease_refuses_without_flags(self):
        engine = self.engine(); engine.lost = True
        with self.assertRaisesRegex(M.Refused, 'deadline_or_lease_lost'): engine.run('seal')
        self.assertEqual(self.native.sets, [])
    def test_unknown_flags_not_overwritten(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        key = self.native.sets[0]; self.native.values[key] = 128; self.native.crash = None
        with self.assertRaisesRegex(M.Refused, 'unknown_flags'): self.engine().run('recover', self.prepared())
        self.assertEqual(len(self.native.sets), 1)
    def test_recovery_rehashes_mutated_chunk_before_any_new_flag(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        self.native.crash = None; (self.source / self.name).write_bytes(b'changed')
        with self.assertRaisesRegex(M.Refused, 'source_digest'): self.engine().run('recover', self.prepared())
        self.assertEqual(len(self.native.sets), 1)
    def test_existing_complete_recovery_revalidates(self):
        result = self.engine().run('seal'); again = self.engine().run('recover', self.prepared())
        self.assertEqual(result, again); self.assertEqual(len(self.native.sets), 3); self.assertEqual(self.validations, 2)


    def test_resource_gate_runs_before_raw_hash_and_flags(self):
        engine = self.engine(); engine.resource_check = lambda: (_ for _ in ()).throw(M.Refused('resource_gate'))
        with self.assertRaisesRegex(M.Refused, 'resource_gate'): engine.run('seal')
        self.assertEqual(self.native.sets, [])
    def test_skipped_journal_event_is_unknown(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        self.native.crash = None; (self.control / '0001-intent.json').write_bytes(b'{}'); (self.control / '0001-intent.json').chmod(0o600)
        with self.assertRaisesRegex(M.Refused, 'noncontiguous_journal'): self.engine().run('recover', self.prepared())
        self.assertEqual(len(self.native.sets), 1)
    def test_partial_publish_temp_is_unknown_not_removed(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        self.native.crash = None; path = self.control / '0000-done.json.tmp'; path.write_bytes(b'partial')
        with self.assertRaisesRegex(M.Refused, 'unknown_journal_state'): self.engine().run('recover', self.prepared())
        self.assertTrue(path.exists()); self.assertEqual(len(self.native.sets), 1)
    def test_source_replacement_is_not_recovered(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        self.native.crash = None; path = self.source / self.name; body = path.read_bytes(); path.rename(self.source / 'old'); path.write_bytes(body); path.chmod(0o600)
        with self.assertRaisesRegex(M.Refused, 'source_identity_changed'): self.engine().run('recover', self.prepared())
        self.assertEqual(len(self.native.sets), 1)
    def test_altered_code_pin_cannot_recover(self):
        self.native.crash = 1
        with self.assertRaises(RuntimeError): self.engine().run('seal')
        engine = self.engine(); engine.code_pin = 'f' * 64
        with self.assertRaisesRegex(M.Refused, 'recovery_binding'): engine.run('recover', self.prepared())
    def test_original_bound_reserves_exit_grace(self):
        engine = self.engine(); engine.began -= 1801
        with self.assertRaisesRegex(M.Refused, 'deadline_or_lease_lost'): engine.run('seal')
        self.assertEqual(self.native.sets, [])

    def test_control_inventory_stops_before_unbounded_collection(self):
        class Scan:
            seen = 0
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def __iter__(self):
                while True:
                    self.seen += 1
                    yield type('Entry', (), {'name': 'extra-' + str(self.seen)})()
        scan = Scan()
        with patch.object(M.os, 'scandir', return_value=scan):
            with self.assertRaisesRegex(M.Refused, 'journal_file_count'): self.engine().run('seal')
        self.assertEqual(scan.seen, 10)  # Three source entries => cap nine, reject tenth.
        self.assertEqual(self.native.sets, [])
    def test_control_inventory_checks_deadline_during_iteration(self):
        engine = self.engine()
        class Scan:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def __iter__(self):
                engine.began -= 1801
                yield type('Entry', (), {'name': 'lock'})()
        with patch.object(M.os, 'scandir', return_value=Scan()):
            with self.assertRaisesRegex(M.Refused, 'deadline_or_lease_lost'): engine.run('seal')
        self.assertEqual(self.native.sets, [])
    def initialization_failure(self, point):
        state = self.engine(); child = Mock(); child.stdout = Mock()
        child.poll.side_effect = [None, 0]
        child.wait.return_value = 0
        selector = Mock()
        if point == 'register': selector.register.side_effect = RuntimeError('init_failed')
        with patch.object(M.verify_node.__globals__['sys'], 'platform', M.sys.platform), \
             patch.object(M, 'verify_node', return_value=M.NODE_PATH), \
             patch.object(M.subprocess, 'Popen', return_value=child), \
             patch.object(M.os, 'pidfd_open', create=True, side_effect=RuntimeError('init_failed') if point == 'pidfd' else None, return_value=777), \
             patch.object(M.selectors, 'DefaultSelector', side_effect=RuntimeError('init_failed') if point == 'selector' else None, return_value=selector), \
             patch.object(M.signal, 'pidfd_send_signal', create=True) as send, \
             patch.object(M.os, 'close') as close:
            with self.assertRaisesRegex(RuntimeError, 'init_failed'): M.run_validator(state, '/fixed-validator')
            child.wait.assert_called()
            child.stdout.close.assert_called_once()
            if point == 'pidfd': send.assert_not_called(); close.assert_not_called()
            else: send.assert_called_once_with(777, M.signal.SIGTERM); close.assert_called_once_with(777)
            if point == 'register': selector.close.assert_called_once()
    def test_pidfd_failure_waits_actual_exit_without_numeric_signal(self): self.initialization_failure('pidfd')
    def test_selector_construction_failure_retires_child(self): self.initialization_failure('selector')
    def test_selector_registration_failure_retires_child(self): self.initialization_failure('register')
    def test_spawn_failure_has_no_unowned_child_cleanup(self):
        with patch.object(M, 'verify_node', return_value=M.NODE_PATH), patch.object(M.subprocess, 'Popen', side_effect=RuntimeError('spawn_failed')), patch.object(M.os, 'pidfd_open', create=True) as pin:
            with self.assertRaisesRegex(RuntimeError, 'spawn_failed'): M.run_validator(self.engine(), '/fixed-validator')
            pin.assert_not_called()

    def test_runtime_fixed_official_pin(self):
        self.assertEqual(M.NODE_SHA256, '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c')
        self.assertNotIn('/usr/local/bin', M.NODE_PATH)
    def test_runtime_rejects_untrusted_owner_before_read(self):
        info = Mock(st_mode=stat.S_IFREG | 0o500, st_uid=1001, st_gid=0, st_nlink=1, st_size=M.NODE_SIZE)
        engine = self.engine(); engine.native.flags = lambda _: M.IMMUTABLE
        with patch.object(M.os, 'open', side_effect=[10, 11]), patch.object(M.os, 'fstat', return_value=info), patch.object(M.os, 'close'), patch.object(M.os, 'read') as read:
            with self.assertRaisesRegex(M.Refused, 'runtime_owner_size'): M.verify_node(engine)
            read.assert_not_called()
    def test_runtime_rejects_wrong_digest(self):
        info = Mock(st_mode=stat.S_IFREG | 0o500, st_uid=0, st_gid=0, st_nlink=1, st_size=3)
        engine = self.engine(); engine.native.flags = lambda _: M.IMMUTABLE
        with patch.object(M, 'NODE_SIZE', 3), patch.object(M.os, 'open', side_effect=[10, 11]), patch.object(M.os, 'fstat', return_value=info), patch.object(M.os, 'close'), patch.object(M.os, 'read', side_effect=[b'bad', b'']):
            with self.assertRaisesRegex(M.Refused, 'runtime_digest'): M.verify_node(engine)

    def test_running_window_preserves_restore_cleanup_reserve(self):
        engine = self.engine(); engine.watchdog_monotonic = M.time.monotonic() + 319
        with self.assertRaisesRegex(M.Refused, 'maintenance_reserve'): engine.run('seal')
        self.assertEqual(self.native.sets, [])
    def window_admission(self, remaining=2200, active='active', command_ok=True, pin_ok=True):
        engine = self.engine(); nonce='a'*16; baseline={'nonce':nonce,'helperSha256':M.MAINT_SHA256,'capturedMonotonicUs':1000000000,'deadlineMonotonicUs':4600000000}
        raw=M.canonical(baseline); pin=M.digest(raw); engine.read_fd=lambda fd, maximum: raw if maximum==131072 else b'helper'
        def probe(argv):
            if argv[0].endswith('systemctl') and '--value' not in argv: return 'Id=address-radar-maintenance-'+nonce+'.timer\nLoadState=loaded\nActiveState='+active+'\nSubState=waiting\nUnit=address-radar-maintenance-'+nonce+'.service'
            if 'GetUnit' in argv: return 'o "/org/freedesktop/systemd1/unit/fixed"'
            if 'get-property' in argv:return 't 4300000000'
            command='/usr/bin/python3 /var/lib/address-radar-maintenance/'+nonce+'/helper.py restore --nonce '+nonce+' --baseline-sha256 '+pin+' --watchdog'
            return '{ argv[]='+command+' ; }' if command_ok else '{ argv[]=/wrong ; }'
        original_digest=M.digest
        with patch.object(M.os,'open',return_value=10),patch.object(M.os,'close'),patch.object(M,'digest',side_effect=lambda value:M.MAINT_SHA256 if value==b'helper' else original_digest(value)),patch.object(M.time,'monotonic',return_value=4300-remaining):
            result=M.admit_source_window(engine,nonce,pin if pin_ok else '0'*64,probe)
        return engine,result
    def test_actual_timer_admission_binds_original_deadline(self):
        engine,result=self.window_admission();self.assertEqual(engine.watchdog_monotonic,4300);self.assertEqual(result['scope'],'source-only-no-window-mutation')
    def test_insufficient_window_never_admitted(self):
        with self.assertRaisesRegex(M.Refused,'maintenance_admission_budget'):self.window_admission(2179)
    def test_nonwaiting_timer_never_admitted(self):
        with self.assertRaisesRegex(M.Refused,'maintenance_timer_state'):self.window_admission(active='inactive')
    def test_wrong_restore_command_never_admitted(self):
        with self.assertRaisesRegex(M.Refused,'maintenance_restore_command'):self.window_admission(command_ok=False)
    def test_wrong_baseline_pin_never_admitted(self):
        with self.assertRaisesRegex(M.Refused,'maintenance_baseline_pin'):self.window_admission(pin_ok=False)

    def test_metadata_binding_sampling_is_bounded_but_force_is_immediate(self):
        engine = self.engine(); engine.root_fd = os.open(self.source, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with patch.object(M.os, 'lstat', wraps=M.os.lstat) as observe:
                engine.check(force_bindings=True); first = observe.call_count
                for _ in range(100): engine.check()
                self.assertEqual(observe.call_count, first)
                engine.check(force_bindings=True)
                self.assertEqual(observe.call_count, first + 1)
        finally: os.close(engine.root_fd)

if __name__ == '__main__': unittest.main()

