import importlib.util
from pathlib import Path
import unittest
import contextlib
import json
import io
import os
import sqlite3
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('address_fence', Path(__file__).resolve().parents[1] / 'address-only-native-fence.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
original_command = m.Deadline.command

class FenceContracts(unittest.TestCase):
    def test_disk_budget_covers_backup_and_safety_reserve(self):
        self.assertEqual(m.required_backup_space([100, 20]), 240 + 3 * 1024**3)
        with self.assertRaises(ValueError): m.required_backup_space([-1])

    def test_source_inventory_must_include_exact_database_and_optional_sidecars(self):
        records = [{'path': m.SOURCE, 'device': 1, 'inode': 2, 'size': 100, 'uid': 997, 'gid': 987, 'mode': 0o644}]
        m.validate_source_inventory(records)
        with self.assertRaises(ValueError): m.validate_source_inventory(records + [dict(records[0])])
        with self.assertRaises(ValueError): m.validate_source_inventory([{**records[0], 'path': '/tmp/source.db'}])

    def test_open_write_or_mapping_refuses_fence(self):
        m.assert_no_source_writers([])
        for item in [{'pid': 1, 'writable': True}, {'pid': 1, 'mapped': True}]:
            with self.assertRaises(ValueError): m.assert_no_source_writers([item])

    def test_protected_fomo_units_are_not_stopped(self):
        self.assertTrue(set(m.PROTECTED_UNITS).isdisjoint(m.WRITER_UNITS))
        self.assertEqual(len(m.WRITER_UNITS), 17)

    def test_precommit_restore_requires_real_negative_import_check(self):
        invoked = []
        with self.assertRaisesRegex(ValueError, 'import_outcome'):
            m.require_uncommitted(lambda: {'importExists': True, 'outcomeKnown': True})
        with self.assertRaisesRegex(ValueError, 'import_outcome'):
            m.require_uncommitted(lambda: {'importExists': False, 'outcomeKnown': False})
        with self.assertRaisesRegex(ValueError, 'import_outcome'):
            m.require_uncommitted(lambda: {'importExists': False, 'outcomeKnown': True})


class NativeFenceRecovery(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source_dir = self.root / 'source'
        self.source_dir.mkdir(mode=0o750)
        self.source = self.source_dir / 'source.db'
        db = sqlite3.connect(self.source)
        db.execute('CREATE TABLE sample(value TEXT)')
        db.execute("INSERT INTO sample VALUES('baseline')")
        db.commit()
        db.close()
        self.source.chmod(0o640)
        self.masks = self.root / 'units'
        self.masks.mkdir(mode=0o700)
        self.runtime_masks = self.root / 'runtime'
        self.runtime_masks.mkdir(mode=0o700)
        self.backups = self.root / 'backups'
        self.backups.mkdir(mode=0o700)
        self.control = self.root / 'control'
        self.units = ('writer.service', 'writer.timer')
        self.states = {unit: self.state(unit, 'active') for unit in self.units}
        self.events = []
        self.protected = {'protected.service': {'InvocationID': 'original', 'MainPID': '42'}}
        patches = {
            'SOURCE': str(self.source), 'SOURCE_DIRECTORY': str(self.source_dir),
            'CONTROL': str(self.control), 'MASK_DIRECTORY': str(self.masks),
            'RUNTIME_MASK_DIRECTORY': str(self.runtime_masks), 'BACKUP_DIRECTORY': str(self.backups),
            'ROOT_UID': os.geteuid(), 'ROOT_GID': os.getegid(), 'WRITER_UNITS': self.units,
        }
        self.patchers = [patch.object(m, name, value, create=True) for name, value in patches.items()]
        self.patchers += [patch.object(m.sys, 'platform', 'linux'),
                          patch.object(m, 'protected_parent'),
                          patch.object(m, 'protected_identities', side_effect=lambda _: self.protected.copy()),
                          patch.object(m, 'unit_state', side_effect=lambda unit, _: self.states[unit].copy()),
                          patch.object(m, 'source_handles', return_value=[]),
                          patch.object(m.Deadline, 'command', new=self.command)]
        for item in self.patchers:
            item.start()
            self.addCleanup(item.stop)
        self.binding = {'operationId': 'operation_1', 'importId': 'import_1', 'generationId': 'generation_1',
                        'planSha256': 'a' * 64,
                        'target': {'database': 'radar', 'schema': 'business', 'schemaFingerprint': 'b' * 64,
                                   'systemIdentifier': '123456', 'serverAddress': '127.0.0.1', 'serverPort': 5432}}

    @staticmethod
    def state(unit, active):
        return {'Id': unit, 'ActiveState': active, 'SubState': 'running', 'MainPID': '0',
                'InvocationID': 'writer', 'LoadState': 'loaded', 'UnitFileState': 'enabled',
                'FragmentPath': '/usr/lib/systemd/system/' + unit, 'Names': unit,
                'TriggeredBy': 'writer.timer' if unit.endswith('.service') else '', 'Job': ''}

    def command(self, args):
        self.events.append(tuple(args))
        if args[1] in ('stop', 'start'):
            self.states[args[-1]]['ActiveState'] = 'inactive' if args[1] == 'stop' else 'active'
        if args[1] == 'daemon-reload':
            for unit in self.units:
                directory = self.masks / (unit + '.d')
                self.states[unit]['DropInPaths'] = ' '.join(str(path) for path in sorted(directory.glob('*.conf'))) if directory.exists() else ''
        return ''

    def local_unit(self, unit, existing_dropin=False):
        path = self.masks / unit
        path.write_text('[Unit]\nDescription=Original local unit\n', encoding='ascii')
        path.chmod(0o644)
        self.states[unit]['FragmentPath'] = str(path)
        if existing_dropin:
            directory = self.masks / (unit + '.d')
            directory.mkdir(mode=0o755)
            dropin = directory / '10-original.conf'
            dropin.write_text('[Unit]\nDescription=Original dropin\n', encoding='ascii')
            dropin.chmod(0o644)
            self.states[unit]['DropInPaths'] = str(dropin)
        return path

    def fence(self):
        fence = m.NativeSourceFence('operation_1', m.Deadline(30), import_binding=self.binding)
        self.addCleanup(fence.close)
        return fence

    def outcome(self, fence, exists=False, **changes):
        @contextlib.contextmanager
        def reconcile(binding, deadline):
            self.assertEqual(binding['operationId'], fence.operation_id)
            deadline.check()
            result = {'outcomeKnown': True, 'importExists': exists,
                      'importerExcluded': True, 'advisoryLockHeld': True,
                      'binding': binding.copy(), 'assert_alive_and_locked': self.alive_proof}
            result.update(changes)
            self.events.append(('outcome_enter',))
            try:
                yield result
            finally:
                self.events.append(('outcome_exit',))
        return reconcile

    @staticmethod
    def alive_proof():
        return {'backendPid': 123, 'transactionStartedAt': '2026-10-08 12:00:00+00',
                'lockHeld': True, 'idleTimeout': '0', 'isolation': 'read committed',
                'readOnly': 'on', 'importerSessions': 0}

    def test_lock_precedes_preflight_and_unresolved_journal_refuses_new_operation(self):
        fence = self.fence()
        with patch.object(m, 'preflight') as probe:
            with self.assertRaises(BlockingIOError):
                m.NativeSourceFence('operation_2', m.Deadline(30), import_binding=self.binding)
            probe.assert_not_called()
        fence.close()
        with patch.object(m, 'preflight') as probe:
            with self.assertRaisesRegex(ValueError, 'unresolved_journal'):
                m.NativeSourceFence('operation_2', m.Deadline(30), import_binding=self.binding)
            probe.assert_not_called()

    def test_persistent_masks_precede_stops_timers_first_and_restore_preserves_existing_mask(self):
        os.symlink('/dev/null', self.masks / 'writer.service')
        self.states['writer.service']['ActiveState'] = 'inactive'
        fence = self.fence()
        fence.stop_writers()
        self.assertTrue((self.masks / 'writer.timer').is_symlink())
        stops = [event[-1] for event in self.events if len(event) > 1 and event[1] == 'stop']
        self.assertEqual(stops, ['writer.timer', 'writer.service'])
        fence.restore_before_import(self.outcome(fence))
        self.assertTrue((self.masks / 'writer.service').is_symlink())
        self.assertFalse(os.path.lexists(self.masks / 'writer.timer'))
        self.assertEqual(self.states['writer.timer']['ActiveState'], 'active')
        self.assertEqual(self.events[-1], ('outcome_exit',))

    def test_local_unit_and_runtime_mask_fail_before_stop(self):
        for path in (self.masks / 'writer.service', self.runtime_masks / 'writer.service'):
            path.write_text('existing unit', encoding='ascii')
            with self.assertRaisesRegex(ValueError, 'unsupported_restart_mask'):
                self.fence()
            self.assertEqual(path.read_text(encoding='ascii'), 'existing unit')
            path.unlink()
        self.assertFalse(any(len(event) > 1 and event[1] == 'stop' for event in self.events))

    def test_journal_is_private_bounded_and_fsynced_before_mask(self):
        fence = self.fence()
        self.assertEqual((self.control / 'journal.json').stat().st_mode & 0o777, 0o600)
        real_link = os.link
        def inspect_intent(target, path, **kwargs):
            state = json.loads((self.control / 'journal.json').read_text())
            self.assertEqual(state['pending']['kind'], 'mask')
            return real_link(target, path, **kwargs)
        with patch.object(m.os, 'link', side_effect=inspect_intent), patch.object(m.os, 'fsync', wraps=os.fsync) as sync:
            fence.stop_writers()
            self.assertGreater(sync.call_count, 4)
        with self.assertRaisesRegex(ValueError, 'journal_budget'):
            fence.journal.write({**fence.state, 'oversized': 'x' * m.MAX_JOURNAL_BYTES})

    def test_crash_after_mask_before_ack_recovers_from_intent(self):
        fence = self.fence()
        real_link = os.link
        def crash(target, path, **kwargs):
            real_link(target, path, **kwargs)
            raise RuntimeError('simulated_crash')
        with patch.object(m.os, 'link', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'simulated_crash'):
                fence.stop_writers()
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        recovered.restore_before_import(self.outcome(recovered))
        self.assertFalse(os.path.lexists(self.masks / 'writer.service'))
        self.assertEqual(recovered.state['phase'], 'RESTORED')

    def test_expired_operation_uses_independent_recovery_budget(self):
        fence = self.fence()
        fence.stop_writers()
        fence.deadline.expires = 0
        fence.restore_before_import(self.outcome(fence), recovery_seconds=5)
        self.assertEqual(fence.state['phase'], 'RESTORED')

    def test_unknown_committed_or_unexcluded_outcomes_do_not_restore(self):
        fence = self.fence()
        fence.stop_writers()
        for changes in ({'outcomeKnown': False}, {'importerExcluded': False},
                        {'advisoryLockHeld': False}, {'importExists': True}, {'binding': {}}):
            with self.assertRaisesRegex(ValueError, 'import_outcome'):
                fence.restore_before_import(self.outcome(fence, **changes))
            self.assertTrue((self.masks / 'writer.timer').is_symlink())

    def test_all_identities_checked_before_any_restore_change(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        replacement = self.root / 'replacement'
        replacement.mkdir()
        self.source_dir.rename(self.root / 'original')
        replacement.rename(self.source_dir)
        with patch.object(m.os, 'fchown') as chown:
            with self.assertRaisesRegex(ValueError, 'restore_'):
                fence.restore_before_import(self.outcome(fence))
            chown.assert_not_called()

    def test_seal_precedes_backup_and_real_wal_survives_without_shm(self):
        writer = sqlite3.connect(self.source)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute("INSERT INTO sample VALUES('wal-only')")
        writer.commit()
        self.addCleanup(writer.close)
        fence = self.fence()
        fence.stop_writers()
        original_copy = m.copy_sealed_file
        def copy(row, destination, deadline):
            self.assertEqual(fence.state['phase'], 'SOURCE_SEALED')
            self.assertEqual(self.source.stat().st_mode & 0o777, 0o400)
            self.assertFalse(str(destination).endswith('-shm'))
            return original_copy(row, destination, deadline)
        with patch.object(m, 'copy_sealed_file', side_effect=copy):
            receipt = fence.backup_and_seal()
        db = sqlite3.connect(receipt['backup']['path'])
        try:
            self.assertEqual(db.execute('SELECT value FROM sample ORDER BY rowid').fetchall(),
                             [('baseline',), ('wal-only',)])
        finally:
            db.close()
        self.assertEqual(fence.state['phase'], 'BACKUP_DURABLE')
        self.assertEqual(receipt['protocol'], 'address-only-v1')

    def test_writer_handle_or_fomo_drift_refuses_backup(self):
        fence = self.fence()
        fence.stop_writers()
        with patch.object(m, 'source_handles', return_value=[{'writable': True}]):
            with self.assertRaisesRegex(ValueError, 'source_writer_remains'):
                fence.backup_and_seal()
        self.assertFalse(any(self.backups.iterdir()))
        self.protected['protected.service'] = {'InvocationID': 'changed'}
        with self.assertRaisesRegex(ValueError, 'fomo_process_changed'):
            fence.restore_before_import(self.outcome(fence))

    def test_partial_seal_crash_restores_original_permissions(self):
        fence = self.fence()
        fence.stop_writers()
        real_chmod = os.fchmod
        def crash(fd, mode):
            real_chmod(fd, mode)
            raise RuntimeError('simulated_seal_crash')
        with patch.object(m.os, 'fchmod', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'simulated_seal_crash'):
                fence.backup_and_seal()
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        recovered.restore_before_import(self.outcome(recovered))
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.source_dir.stat().st_mode & 0o777, 0o750)

    def test_mask_directory_fsync_failure_keeps_write_ahead_intent(self):
        fence = self.fence()
        original_sync = m.sync_directory
        def fail(path):
            if path == str(self.masks):
                raise OSError('mask_sync_failure')
            original_sync(path)
        with patch.object(m, 'sync_directory', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'mask_sync_failure'):
                fence.stop_writers()
        state = json.loads((self.control / 'journal.json').read_text())
        self.assertEqual(state['pending']['kind'], 'mask')

    def test_preexisting_masks_never_get_removed_after_crash(self):
        fence = self.fence()
        original_link = os.link
        def race(anchor, path, **kwargs):
            os.symlink('/dev/null', path)
            return original_link(anchor, path, **kwargs)
        with patch.object(m.os, 'link', side_effect=race):
            with self.assertRaises(FileExistsError):
                fence.stop_writers()
        with self.assertRaisesRegex(ValueError, 'restart_mask_replaced'):
            fence.restore_before_import(self.outcome(fence))
        self.assertTrue((self.masks / 'writer.timer').is_symlink())

    def test_cli_preflight_refuses_unresolved_journal_under_lock(self):
        fence = self.fence()
        fence.close()
        with patch.object(m.sys, 'argv', ['fence', '--preflight']), patch.object(m, 'preflight') as probe:
            with self.assertRaisesRegex(ValueError, 'unresolved_journal'):
                m.main()
            probe.assert_not_called()

    def test_binding_mutation_cannot_change_reconciliation_expectations(self):
        fence = self.fence()
        fence.stop_writers()
        @contextlib.contextmanager
        def changing(binding, deadline):
            binding['importId'] = 'different_import'
            yield {'binding': binding, 'outcomeKnown': True, 'importExists': False,
                   'importerExcluded': True, 'advisoryLockHeld': True}
        with self.assertRaisesRegex(ValueError, 'import_outcome'):
            fence.restore_before_import(changing)

    def test_import_intent_and_actual_commit_keep_source_fenced(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        fence.mark_import_intent()
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        receipt = recovered.reconcile_committed_import(self.outcome(recovered, exists=True, committedMatches=True))
        self.assertTrue(receipt['databaseImported'])
        self.assertFalse(receipt['activationEnabled'])
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o400)
        self.assertTrue((self.masks / 'writer.timer').is_symlink())
        with self.assertRaisesRegex(ValueError, 'invalid_restore_phase'):
            recovered.restore_before_import(self.outcome(recovered))

    def test_subprocess_closes_inherited_fds(self):
        with patch.object(m.subprocess, 'check_output', return_value=b'') as command:
            original_command(m.Deadline(5), ['systemctl', 'daemon-reload'])
            self.assertTrue(command.call_args.kwargs['close_fds'])

    def test_recovery_refuses_journal_with_foreign_source_paths(self):
        fence = self.fence()
        fence.state['sources'] = [{**fence.prepared['sourceFiles'][0], 'path': '/tmp/foreign'}]
        fence.journal.write(fence.state)
        fence.close()
        with self.assertRaisesRegex(ValueError, 'unexpected_source_inventory'):
            m.NativeSourceFence.recover(m.Deadline(30))

    def test_restored_operation_id_cannot_be_reused(self):
        fence = self.fence()
        fence.restore_before_import(self.outcome(fence))
        fence.close()
        with self.assertRaisesRegex(ValueError, 'operation_id_reused'):
            self.fence()

    def test_restore_crash_after_unmask_reinstates_exclusion_before_permissions(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        real_unlink = os.unlink
        def crash(path, **kwargs):
            real_unlink(path, **kwargs)
            if str(path).startswith(str(self.masks)):
                raise RuntimeError('unmask_crash')
        with patch.object(m.os, 'unlink', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'unmask_crash'):
                fence.restore_before_import(self.outcome(fence))
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        original_permissions = recovered._permissions
        def permissions(*args, **kwargs):
            self.assertTrue(all((self.masks / unit).is_symlink() for unit in self.units))
            return original_permissions(*args, **kwargs)
        with patch.object(recovered, '_permissions', side_effect=permissions):
            recovered.restore_before_import(self.outcome(recovered))
        self.assertEqual(recovered.state['phase'], 'RESTORED')

    def test_journal_update_failure_preserves_old_state_and_bounded_scratch(self):
        fence = self.fence()
        prior = (self.control / 'journal.json').read_bytes()
        with patch.object(m.os, 'replace', side_effect=OSError('rename_failure')):
            with self.assertRaisesRegex(OSError, 'rename_failure'):
                fence.journal.write({**fence.state, 'phase': 'WRITERS_BLOCKED'})
        self.assertEqual((self.control / 'journal.json').read_bytes(), prior)
        self.assertLessEqual((self.control / 'journal.next').stat().st_size, m.MAX_JOURNAL_BYTES)
        fence.journal.write(fence.state)
        self.assertFalse((self.control / 'journal.next').exists())

    def test_stop_dependency_on_protected_unit_is_refused_before_mutations(self):
        self.states['writer.service']['RequiredBy'] = m.PROTECTED_UNITS[0]
        with self.assertRaisesRegex(ValueError, 'unsupported_stop_propagation'):
            self.fence()
        self.assertFalse(any(self.masks.iterdir()))
        self.assertEqual(self.events, [])

    def test_staged_copy_crash_keeps_source_sealed_and_recoverable(self):
        fence = self.fence()
        fence.stop_writers()
        with patch.object(m, 'copy_sealed_file', side_effect=OSError('copy_crash')):
            with self.assertRaisesRegex(OSError, 'copy_crash'):
                fence.backup_and_seal()
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o400)
        self.assertEqual(fence.state['phase'], 'SOURCE_SEALED')
        self.assertIsNone(fence.state['backup'])
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        recovered.restore_before_import(self.outcome(recovered))
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o640)

    def test_measure_is_stable_and_does_not_rehash_source_or_backup(self):
        fence = self.fence()
        fence.stop_writers()
        receipt = fence.backup_and_seal()
        first = fence.measure()
        with patch.object(m.os, 'read', side_effect=AssertionError('unexpected_content_read')):
            second = fence.measure()
        self.assertEqual(first, second)
        self.assertEqual(first['backupSha256'], receipt['backup']['sha256'])
        self.assertEqual(len(first['fenceSha256']), 64)
        self.assertTrue(first['sourceSealed'])
        self.assertTrue(first['protectedProcessesUnchanged'])
        fence.mark_import_intent()
        self.assertEqual(fence.measure()['fenceSha256'], first['fenceSha256'])

    def test_child_measure_requires_retained_lock_and_same_operation(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        parent = fence.measure()
        self.assertEqual(m.measure_existing('operation_1', m.Deadline(30)), parent)
        with self.assertRaisesRegex(ValueError, 'measurement_operation_mismatch'):
            m.measure_existing('different', m.Deadline(30))
        fence.close()
        with self.assertRaisesRegex(ValueError, 'controller_lock_not_held'):
            m.measure_existing('operation_1', m.Deadline(30))

    def test_measure_rejects_early_phase_source_permission_drift_and_backup_stamp_drift(self):
        fence = self.fence()
        with self.assertRaisesRegex(ValueError, 'measurement_phase'):
            fence.measure()
        fence.stop_writers()
        receipt = fence.backup_and_seal()
        self.source.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'measurement_source_changed'):
            fence.measure()
        # chmod changes ctime even after reverting; the old seal must remain invalid.
        self.source.chmod(0o400)
        with self.assertRaisesRegex(ValueError, 'measurement_source_changed'):
            fence.measure()

    def test_measure_rejects_backup_mutation_and_writer_handles(self):
        fence = self.fence()
        fence.stop_writers()
        receipt = fence.backup_and_seal()
        with patch.object(m, 'source_handles', return_value=[{'writable': True}]):
            with self.assertRaisesRegex(ValueError, 'source_writer_remains'):
                fence.measure()
        backup = Path(receipt['backup']['path'])
        backup.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'measurement_backup_changed'):
            fence.measure()

    def test_measure_cli_returns_json_without_starting_any_writer(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        self.events.clear()
        output = io.StringIO()
        with patch.object(m.sys, 'argv', ['fence', '--measure', '--operation-id', 'operation_1']), contextlib.redirect_stdout(output):
            m.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result['protocol'], 'address-only-v1')
        self.assertTrue(result['writersBlocked'])
        self.assertEqual(self.events, [])

    def test_measure_rejects_incomplete_journal_action(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        fence.state['pending'] = {'kind': 'seal_file', 'subject': str(self.source)}
        fence.journal.write(fence.state)
        with self.assertRaisesRegex(ValueError, 'measurement_phase'):
            m.measure_existing('operation_1', m.Deadline(30))

    def test_measure_rejects_backup_rewrite_even_with_original_size_and_mtime(self):
        fence = self.fence()
        fence.stop_writers()
        receipt = fence.backup_and_seal()
        backup = Path(receipt['backup']['path'])
        original = backup.stat()
        backup.chmod(0o600)
        with backup.open('r+b') as file:
            file.seek(-1, os.SEEK_END)
            value = file.read(1)
            file.seek(-1, os.SEEK_END)
            file.write(bytes([value[0] ^ 1]))
        os.utime(backup, ns=(original.st_atime_ns, original.st_mtime_ns))
        backup.chmod(0o400)
        with self.assertRaisesRegex(ValueError, 'measurement_backup_changed'):
            fence.measure()

    def test_import_intent_requires_current_pinned_measurement(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        self.source.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'measurement_source_changed'):
            fence.mark_import_intent()
        self.assertEqual(fence.journal.read()['phase'], 'BACKUP_DURABLE')

    def test_unbound_plan_can_fence_backup_and_restore_but_cannot_measure_or_import(self):
        self.binding['planSha256'] = None
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        for action in (fence.measure, fence.mark_import_intent,
                       lambda: m.measure_existing('operation_1', m.Deadline(30))):
            with self.assertRaisesRegex(ValueError, 'import_plan_not_bound'):
                action()
        self.assertIsNone(fence.journal.read()['binding']['planSha256'])
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        recovered.restore_before_import(self.outcome(recovered))
        self.assertEqual(recovered.state['phase'], 'RESTORED')

    def test_bind_plan_atomically_pins_both_bindings_before_measurement(self):
        self.binding['planSha256'] = None
        fence = self.fence()
        with self.assertRaisesRegex(ValueError, 'invalid_plan_binding_phase'):
            fence.bind_import_plan('c' * 64)
        fence.stop_writers()
        fence.backup_and_seal()
        backup = fence.state['backup'].copy()
        self.assertIsNone(fence.state['measurement']['binding']['planSha256'])
        real_write = fence.journal.write
        writes = []
        def observe(state):
            self.assertEqual(state['binding']['planSha256'], 'c' * 64)
            self.assertEqual(state['measurement']['binding'], state['binding'])
            writes.append(state['phase'])
            return real_write(state)
        with patch.object(fence.journal, 'write', side_effect=observe):
            bound = fence.bind_import_plan('c' * 64)
        self.assertEqual(writes, ['BACKUP_DURABLE'])
        self.assertEqual(bound['planSha256'], 'c' * 64)
        self.assertIsNone(self.binding['planSha256'])
        self.assertEqual(fence.state['backup'], backup)
        measurement = fence.measure()
        self.assertEqual(measurement['binding']['planSha256'], 'c' * 64)
        self.assertEqual(m.measure_existing('operation_1', m.Deadline(30)), measurement)
        fence.bind_import_plan('c' * 64)
        self.assertEqual(fence.measure()['fenceSha256'], measurement['fenceSha256'])
        with self.assertRaisesRegex(ValueError, 'import_plan_already_bound'):
            fence.bind_import_plan('d' * 64)
        fence.mark_import_intent()
        with self.assertRaisesRegex(ValueError, 'invalid_plan_binding_phase'):
            fence.bind_import_plan('c' * 64)

    def test_failed_plan_binding_preserves_unbound_durable_state_and_can_retry(self):
        self.binding['planSha256'] = None
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        with patch.object(m.os, 'replace', side_effect=OSError('bind_crash')):
            with self.assertRaisesRegex(OSError, 'bind_crash'):
                fence.bind_import_plan('e' * 64)
        state = fence.journal.read()
        self.assertIsNone(state['binding']['planSha256'])
        self.assertIsNone(state['measurement']['binding']['planSha256'])
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        recovered.bind_import_plan('e' * 64)
        self.assertEqual(recovered.measure()['binding']['planSha256'], 'e' * 64)

    def test_null_plan_is_invalid_in_import_journal_phases(self):
        self.binding['planSha256'] = None
        fence = self.fence()
        for phase in ('IMPORT_INTENT', 'IMPORT_COMMITTED'):
            fence.state['phase'] = phase
            fence.journal.write(fence.state)
            fence.close()
            with self.assertRaisesRegex(ValueError, 'import_plan_not_bound'):
                m.NativeSourceFence.recover(m.Deadline(30))
            # The original journal writer is used only to inject the next corrupt fixture.

    def test_bind_plan_rejects_invalid_hashes_and_closed_controller(self):
        self.binding['planSha256'] = None
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        for value in (None, '', 'fake', 'g' * 64, 123):
            with self.assertRaisesRegex(ValueError, 'invalid_import_plan_hash'):
                fence.bind_import_plan(value)
        fence.close()
        with self.assertRaisesRegex(ValueError, 'controller_lock_not_held'):
            fence.bind_import_plan('f' * 64)

    def test_all_local_units_get_persistent_guards_without_replacing_originals(self):
        paths = [self.local_unit(unit, existing_dropin=True) for unit in self.units]
        originals = {str(path): (path.stat().st_ino, path.read_bytes()) for path in paths}
        dropins = {unit: (self.masks / (unit + '.d') / '10-original.conf').read_bytes() for unit in self.units}
        fence = self.fence()
        fence.stop_writers()
        self.assertEqual(set(fence.state['guards']), set(self.units))
        self.assertEqual(fence.state['masks'], {})
        for unit in self.units:
            guard = self.masks / (unit + '.d') / ('zzzz-address-only-operation_1.conf')
            self.assertTrue(guard.is_file())
            self.assertIn('ConditionPathExists=!' + fence.state['sentinel']['path'], guard.read_text())
        fence.backup_and_seal()
        measurement = fence.measure()
        self.assertEqual(set(measurement['restartExclusions']['guards']), set(self.units))
        fence.restore_before_import(self.outcome(fence))
        for path in paths:
            self.assertEqual((path.stat().st_ino, path.read_bytes()), originals[str(path)])
        for unit in self.units:
            directory = self.masks / (unit + '.d')
            self.assertEqual(sorted(path.name for path in directory.iterdir()), ['10-original.conf'])
            self.assertEqual((directory / '10-original.conf').read_bytes(), dropins[unit])

    def test_mixed_vendor_masks_and_local_guards_restore_only_owned_exclusions(self):
        path = self.local_unit('writer.service')
        original = path.read_bytes()
        fence = self.fence()
        fence.stop_writers()
        self.assertTrue((self.masks / 'writer.timer').is_symlink())
        self.assertTrue((self.masks / 'writer.service.d').is_dir())
        fence.backup_and_seal()
        fence.restore_before_import(self.outcome(fence))
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse((self.masks / 'writer.service.d').exists())
        self.assertFalse(os.path.lexists(self.masks / 'writer.timer'))

    def test_guard_link_crash_recovers_by_owned_inode(self):
        self.local_unit('writer.timer')
        self.local_unit('writer.service')
        fence = self.fence()
        real_link = os.link
        def crash(anchor, path, **kwargs):
            real_link(anchor, path, **kwargs)
            raise RuntimeError('guard_link_crash')
        with patch.object(m.os, 'link', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'guard_link_crash'):
                fence.stop_writers()
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        recovered.restore_before_import(self.outcome(recovered))
        self.assertEqual(recovered.state['phase'], 'RESTORED')
        self.assertTrue(all((self.masks / unit).is_file() for unit in self.units))
        self.assertFalse(any(self.masks.glob('*.d/*.conf')))

    def test_guard_removal_crash_is_reinstated_before_source_restore(self):
        self.local_unit('writer.service')
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        original_unlink = os.unlink
        def crash(path, **kwargs):
            original_unlink(path, **kwargs)
            if str(path).endswith('zzzz-address-only-operation_1.conf'):
                raise RuntimeError('guard_remove_crash')
        with patch.object(m.os, 'unlink', side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, 'guard_remove_crash'):
                fence.restore_before_import(self.outcome(fence))
        fence.close()
        recovered = m.NativeSourceFence.recover(m.Deadline(30))
        self.addCleanup(recovered.close)
        original_permissions = recovered._permissions
        def check(*args, **kwargs):
            self.assertTrue((self.masks / 'writer.service.d' / 'zzzz-address-only-operation_1.conf').exists())
            return original_permissions(*args, **kwargs)
        with patch.object(recovered, '_permissions', side_effect=check):
            recovered.restore_before_import(self.outcome(recovered))

    def test_guard_sentinel_or_effective_dropin_drift_refuses_measurement(self):
        self.local_unit('writer.service', existing_dropin=True)
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        self.states['writer.service']['DropInPaths'] = ''
        with self.assertRaisesRegex(ValueError, 'restart_guard_not_effective'):
            fence.measure()
        self.command(['systemctl', 'daemon-reload'])
        Path(fence.state['sentinel']['path']).unlink()
        with self.assertRaisesRegex(ValueError, 'restart_sentinel_changed'):
            fence.measure()

    def test_existing_local_configuration_drift_is_never_overwritten_on_restore(self):
        self.local_unit('writer.service', existing_dropin=True)
        fence = self.fence()
        fence.stop_writers()
        dropin = self.masks / 'writer.service.d' / '10-original.conf'
        dropin.write_text('[Unit]\nDescription=Administrator change\n', encoding='ascii')
        with self.assertRaisesRegex(ValueError, 'restart_original_changed'):
            fence.restore_before_import(self.outcome(fence))
        self.assertIn('Administrator change', dropin.read_text())
        self.assertTrue((self.masks / 'writer.service.d' / 'zzzz-address-only-operation_1.conf').exists())

    def test_later_condition_reset_dropin_fails_before_stop(self):
        self.local_unit('writer.service', existing_dropin=True)
        path = self.masks / 'writer.service.d' / 'zzzzz-reset.conf'
        path.write_text('[Unit]\nConditionPathExists=\n', encoding='ascii')
        self.states['writer.service']['DropInPaths'] += ' ' + str(path)
        with self.assertRaisesRegex(ValueError, 'unsupported_restart_guard_order'):
            self.fence()
        self.assertEqual(self.events, [])

    def test_guard_directory_sync_failure_keeps_write_ahead_guard_intent(self):
        self.local_unit('writer.timer')
        fence = self.fence()
        original_sync = m.sync_directory
        directory = str(self.masks / 'writer.timer.d')
        def fail(path):
            if path == directory:
                raise OSError('guard_sync_failure')
            original_sync(path)
        with patch.object(m, 'sync_directory', side_effect=fail):
            with self.assertRaisesRegex(OSError, 'guard_sync_failure'):
                fence.stop_writers()
        self.assertEqual(fence.journal.read()['pending']['kind'], 'guard')

    def test_guard_anchors_are_removed_only_after_successful_restore(self):
        self.local_unit('writer.service')
        fence = self.fence()
        fence.stop_writers()
        anchor = Path(fence._guard_anchor('writer.service'))
        self.assertTrue(anchor.exists())
        fence.restore_before_import(self.outcome(fence))
        self.assertEqual(fence.journal.read()['phase'], 'RESTORED')
        self.assertFalse(anchor.exists())

    def test_closed_controller_cannot_mutate_or_restore(self):
        fence = self.fence()
        fence.close()
        for action in (fence.stop_writers, fence.backup_and_seal,
                       lambda: fence.restore_before_import(self.outcome(fence))):
            with self.assertRaisesRegex(ValueError, 'controller_lock_not_held'):
                action()
        self.assertEqual(self.events, [])

    def test_restore_refuses_old_dictionary_and_boolean_guard_before_any_change(self):
        fence = self.fence()
        fence.stop_writers()
        for guard in (None, lambda: True, lambda: None):
            with patch.object(m.os, 'fchown') as chown:
                with self.assertRaisesRegex(ValueError, 'live_lock'):
                    fence.restore_before_import(self.outcome(fence, assert_alive_and_locked=guard))
                chown.assert_not_called()
            self.assertEqual(fence.journal.read()['phase'], 'WRITERS_BLOCKED')

    def test_lock_loss_between_chown_and_chmod_stops_next_permission_mutation(self):
        fence = self.fence()
        fence.stop_writers()
        fence.backup_and_seal()
        lost = False
        actual_chown = os.fchown
        def chown(fd, uid, gid):
            nonlocal lost
            actual_chown(fd, uid, gid)
            lost = True
        def guard():
            if lost:
                raise ValueError('connection_lost')
            return self.alive_proof()
        with patch.object(m.os, 'fchown', side_effect=chown), patch.object(m.os, 'fchmod') as chmod:
            with self.assertRaisesRegex(ValueError, 'connection_lost'):
                fence.restore_before_import(self.outcome(fence, assert_alive_and_locked=guard), recovery_seconds=0.2)
            chmod.assert_not_called()
        self.assertEqual(fence.journal.read()['phase'], 'RESTORE_INTENT')
        self.assertIsNone(getattr(fence, '_recovery_assertion', None))

    def test_long_restore_wait_rechecks_lock_and_never_records_restored(self):
        fence = self.fence()
        fence.stop_writers()
        polls = 0
        def state(unit, deadline):
            nonlocal polls
            polls += 1
            self.states[unit]['ActiveState'] = 'activating'
            return self.states[unit].copy()
        def guard():
            if polls >= 2:
                raise ValueError('wait_lock_lost')
            return self.alive_proof()
        with patch.object(m, 'unit_state', side_effect=state), patch.object(m.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, 'wait_lock_lost'):
                fence.restore_before_import(self.outcome(fence, assert_alive_and_locked=guard))
        self.assertGreaterEqual(polls, 2)
        self.assertEqual(fence.journal.read()['phase'], 'RESTORE_INTENT')

    def test_restored_write_requires_fresh_lock_check_after_final_invariants(self):
        fence = self.fence()
        fence.stop_writers()
        lost = False
        original = fence.assert_protected_unchanged
        def protected():
            nonlocal lost
            original()
            if fence.state['phase'] == 'RESTORE_INTENT':
                lost = True
        def guard():
            if lost:
                raise ValueError('final_lock_lost')
            return self.alive_proof()
        with patch.object(fence, 'assert_protected_unchanged', side_effect=protected):
            with self.assertRaisesRegex(ValueError, 'final_lock_lost'):
                fence.restore_before_import(self.outcome(fence, assert_alive_and_locked=guard))
        self.assertEqual(fence.journal.read()['phase'], 'RESTORE_INTENT')

class DiagnosticTests(unittest.TestCase):
    def test_allowlisted_measurement_failure_without_private_text(self):
        for code in ['measurement_phase', 'source_writer_remains', 'measurement_restart_exclusion_changed',
                     'fomo_process_changed', 'original_operation_deadline']:
            self.assertEqual(m.sanitized_fence_failure(ValueError(code))['diagnostic']['code'], code)
        for error in [ValueError('postgresql://role:secret@host'), RuntimeError('secret')]:
            self.assertEqual(m.sanitized_fence_failure(error)['diagnostic']['code'], 'unknown_failure')
        self.assertEqual(m.sanitized_fence_failure(PermissionError('private path'))['diagnostic']['code'], 'permission_denied')

if __name__ == '__main__': unittest.main()

