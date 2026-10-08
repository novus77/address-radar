#!/usr/bin/env python3
import copy
import importlib.util
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('discovery', Path(__file__).resolve().parents[1] / 'migration-authority-discovery.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Clock:
    def __init__(self):
        self.now = 100.0
    def __call__(self):
        return self.now


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.policy = m.seed_policy()
        self.policy['runtimePins'] = {name: {'path': '/protected/' + name, 'sha256': 'a' * 64,
            'identity': [1, index + 1]} for index, name in enumerate(m.RUNTIME_NAMES)}
        self.clock = Clock()
        self.calls = []
        self.pids = {unit: index + 100 for index, unit in enumerate(m.KNOWN_UNITS)}

    def execute(self, tool, args, timeout, maximum):
        self.calls.append((tool, args, timeout, maximum))
        if args[0] == 'show':
            unit = args[-1]
            values = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
                      'MainPID': str(self.pids[unit]), 'ControlGroup': '/system.slice/' + unit,
                      'InvocationID': 'b' * 32, 'User': 'fomo-radar' if unit in m.FOMO else 'address-radar',
                      'Group': 'fomo-radar' if unit in m.FOMO else 'address-radar',
                      'FragmentPath': '/etc/systemd/system/' + unit, 'DropInPaths': '',
                      'TimeoutStopUSec': '1min 30s', 'TimeoutStartUSec': '1min 30s', 'KillMode': 'control-group'}
            return '\n'.join(key + '=' + values[key] for key in m.SERVICE_PROPERTIES)
        if args[0] == 'list-units':
            return '\n'.join(unit + ' loaded active running Description' for unit in m.KNOWN_UNITS)
        if args[0] == 'list-unit-files':
            return '\n'.join(unit + ' enabled enabled' for unit in m.KNOWN_UNITS)
        return ''

    def process(self, pid):
        return {'pid': pid, 'uid': 1000, 'gid': 1000, 'startTicks': '123', 'exe': '/protected/runtime'}

    def collect(self, **kwargs):
        return m.collect_inventory(self.policy, self.execute, self.clock, process_reader=self.process,
            source_reader=lambda paths: [], host_reader=lambda: 'observed-host', **kwargs)

    def test_seed_contains_known_runtime_but_no_fake_complete_scope_or_pins(self):
        seed = m.seed_policy()
        self.assertEqual(set(row['unit'] for row in seed['knownUnits']), set(m.MAIN + m.FOMO))
        self.assertIsNone(seed['runtimePins'])
        self.assertEqual(seed['sourceFiles'], [])
        self.assertEqual(seed['approvedUsers'], [])
        with self.assertRaises(m.Refusal):
            m.validate_policy(seed)

    def test_discovery_is_readonly_unsigned_and_reports_unknown_admission(self):
        report = self.collect()
        for key in m.FALSE_CLAIMS:
            self.assertIs(report[key], False)
        self.assertIn('SOURCE_SCOPE_UNBOUND', report['blockers'])
        self.assertIn('OPERATOR_SCOPE_UNKNOWN', report['blockers'])
        self.assertIn('DEPLOY_SCOPE_UNKNOWN', report['blockers'])
        self.assertIn('EXTERNAL_INPUT_SCOPE_UNKNOWN', report['blockers'])
        self.assertIn('FD_AND_MMAP_CLOSURE_NOT_ACQUIRED', report['blockers'])
        self.assertTrue(all(args[0] in ('show', 'list-units', 'list-unit-files', 'list-timers', 'list-jobs', 'list-sessions') for _, args, _, _ in self.calls))
        self.assertEqual(report['fomoIdentityStable'], True)

    def test_unknown_runtime_unit_is_blocker_not_silently_approved(self):
        original = self.execute
        def executor(tool, args, timeout, maximum):
            output = original(tool, args, timeout, maximum)
            return output + '\nunknown-writer.service loaded active running payload-secret' if args[0] == 'list-units' else output
        report = m.collect_inventory(self.policy, executor, self.clock, process_reader=self.process,
            source_reader=lambda paths: [], host_reader=lambda: 'host')
        self.assertIn('UNREVIEWED_SYSTEM_UNIT', report['blockers'])
        self.assertNotIn('payload-secret', json.dumps(report))

    def test_budget_exhaustion_never_claims_complete_or_executes_more(self):
        self.policy['limits']['operationSeconds'] = 1
        self.policy['limits']['commandSeconds'] = 1
        original = self.execute
        def executor(*args):
            result = original(*args)
            self.clock.now += 2
            return result
        report = m.collect_inventory(self.policy, executor, self.clock, process_reader=self.process,
            source_reader=lambda paths: [], host_reader=lambda: 'host')
        self.assertEqual(len(self.calls), 1)
        self.assertIn('OPERATION_BOUND', report['blockers'])
        self.assertFalse(report['inventoryComplete'])

    def test_fomo_pid_replacement_and_missing_identity_fail_closed(self):
        counts = {}
        def reader(pid):
            counts[pid] = counts.get(pid, 0) + 1
            row = self.process(pid)
            if pid == self.pids[m.FOMO[0]] and counts[pid] > 1:
                row['startTicks'] = '999'
            return row
        report = m.collect_inventory(self.policy, self.execute, self.clock, process_reader=reader,
            source_reader=lambda paths: [], host_reader=lambda: 'host')
        self.assertIn('FOMO_PROCESS_IDENTITY_CHANGED', report['blockers'])
        self.assertFalse(report['fomoIdentityStable'])

    def test_output_and_directory_enumeration_limits_block(self):
        def executor(tool, args, timeout, maximum):
            return 'x' * (maximum + 1)
        report = m.collect_inventory(self.policy, executor, self.clock, process_reader=self.process,
            source_reader=lambda paths: [], host_reader=lambda: 'host')
        self.assertIn('OUTPUT_BOUND', report['blockers'])
        with self.assertRaises(m.Refusal):
            m.parse_listing('units', '\n'.join('extra%d.service loaded active running' % n for n in range(257)), 256)

    def test_policy_refuses_mutation_tools_missing_known_units_and_unknown_fields(self):
        for change in (lambda p: p['knownUnits'].pop(), lambda p: p.update(sign=True),
                       lambda p: p['runtimePins']['systemctl'].update(path='/tmp/not-protected'),
                       lambda p: p['limits'].update(operationSeconds=31)):
            policy = copy.deepcopy(self.policy)
            change(policy)
            with self.assertRaises(m.Refusal):
                m.validate_policy(policy)

    def test_root_metadata_guards_refuse_owner_mode_hardlink_symlink(self):
        good = types.SimpleNamespace(st_mode=0o100600, st_uid=0, st_nlink=1, st_size=10)
        m.check_regular(good, 64, exact_mode=0o600)
        for key, value in [('st_uid', 1), ('st_mode', 0o100644), ('st_nlink', 2), ('st_mode', 0o120600)]:
            bad = copy.copy(good); setattr(bad, key, value)
            with self.assertRaises(m.Refusal):
                m.check_regular(bad, 64, exact_mode=0o600)

    def test_cli_seed_is_offline_and_does_not_invoke_runtime(self):
        with patch.object(m, 'native_runtime', side_effect=AssertionError('native forbidden')), \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(m.main(['seed']), 0)
            value = json.loads(output.getvalue())
        self.assertEqual(value['status'], 'offline-discovery-seed')
        self.assertFalse(value['scopeApproved'])

    def test_subprocess_error_is_sanitized(self):
        def executor(*args):
            raise RuntimeError('SECRET credentials from stderr')
        report = m.collect_inventory(self.policy, executor, self.clock, process_reader=self.process,
            source_reader=lambda paths: [], host_reader=lambda: 'host')
        self.assertIn('COMMAND_UNAVAILABLE', report['blockers'])
        self.assertNotIn('SECRET', json.dumps(report))

    def test_source_identity_change_is_blocker_not_census_proof(self):
        self.policy['sourceFiles'] = ['/approved/source.db', '/approved/source.db-wal', '/approved/source.db-shm']
        with patch.object(m, 'source_metadata'):
            snapshots = iter([[{'path': '/approved/source.db', 'identity': [1, 2]}],
                              [{'path': '/approved/source.db', 'identity': [1, 3]}]])
            report = m.collect_inventory(self.policy, self.execute, self.clock,
                process_reader=self.process, source_reader=lambda paths: next(snapshots), host_reader=lambda: 'host')
        self.assertIn('SOURCE_IDENTITY_CHANGED', report['blockers'])
        self.assertFalse(report['scopeApproved'])

    def test_ancestor_and_open_file_replacement_fail_closed(self):
        before = types.SimpleNamespace(st_dev=1, st_ino=2, st_size=10, st_mtime_ns=20, st_ctime_ns=30)
        replaced = copy.copy(before); replaced.st_ino = 99
        with patch.object(m.os, 'fstat', return_value=before), patch.object(m.os, 'lstat', return_value=replaced):
            with self.assertRaisesRegex(m.Refusal, 'FILE_REPLACED'):
                m.stable_file('/protected/file', 10, before, [])
        ancestor = types.SimpleNamespace(st_dev=1, st_ino=99, st_mode=0o40700, st_uid=0)
        with patch.object(m.os, 'fstat', return_value=before), \
             patch.object(m.os, 'lstat', side_effect=[before, ancestor]):
            with self.assertRaisesRegex(m.Refusal, 'ANCESTOR_REPLACED'):
                m.stable_file('/protected/file', 10, before, [('/protected', [1, 3])])

    def test_inventory_uses_remaining_original_deadline_not_new_budget(self):
        report = self.collect(not_after=self.clock.now)
        self.assertEqual(self.calls, [])
        self.assertIn('OPERATION_BOUND', report['blockers'])
        self.assertFalse(report['inventoryComplete'])

    def test_no_raw_cmdline_environment_or_mutating_command_in_native_allowlist(self):
        for tool, args in [('systemctl', ['stop', m.MAIN[0]]), ('systemctl', ['start', m.MAIN[0]]),
                           ('systemctl', ['set-property', m.MAIN[0]]), ('loginctl', ['terminate-session', '1'])]:
            with self.assertRaisesRegex(m.Refusal, 'COMMAND_SCOPE'):
                m.native_execute({}, self.policy, tool, args, 1, 1024)
        self.assertNotIn('Environment', m.SERVICE_PROPERTIES)
        self.assertNotIn('ExecStart', m.SERVICE_PROPERTIES)

    def test_main_keeps_policy_runtime_and_inventory_on_original_deadline(self):
        result = {key: False for key in m.FALSE_CLAIMS}
        with patch.object(m.time, 'monotonic', side_effect=[100, 101]), \
             patch.object(m, 'load_policy', return_value=self.policy), \
             patch.object(m, 'native_runtime', return_value={}) as runtime, \
             patch.object(m, 'collect_inventory', return_value=result) as collect, \
             patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(m.main(['discover', '--policy', '/root/policy.json', '--policy-sha256', 'a' * 64,
                                     '--expected-entry-sha256', 'b' * 64]), 1)
        self.assertEqual(runtime.call_args.args[-1], 130)
        self.assertEqual(collect.call_args.kwargs['not_after'], 130)


    def test_native_argv_rejects_unapproved_reads_and_remote_transport(self):
        for args in (['show', '--property=Environment', m.MAIN[0]],
                     ['show', '--host=other-host', m.MAIN[0]],
                     ['show', '--no-pager', '--property=' + ','.join(m.SERVICE_PROPERTIES), 'unknown.service'],
                     ['list-jobs', '--no-legend', '--no-pager', '--host=other-host']):
            with self.assertRaisesRegex(m.Refusal, 'COMMAND_SCOPE'):
                m.native_execute({}, self.policy, 'systemctl', args, 1, 1024)

    def test_source_reader_cannot_return_late_metadata_as_accepted_inventory(self):
        def late(paths):
            self.clock.now += 31
            return []
        report = m.collect_inventory(self.policy, self.execute, self.clock,
            process_reader=self.process, source_reader=late, host_reader=lambda: 'host')
        self.assertEqual(self.calls, [])
        self.assertIn('OPERATION_BOUND', report['blockers'])
        self.assertFalse(report['inventoryComplete'])




class NativeListingRegressionTests(unittest.TestCase):
    def test_escaped_units_preserved_without_decoding(self):
        token = r'systemd-fsck@dev-disk-by\x2did-virtio\x2dUCLOUD_DISK_VDB.service'
        rows = m.parse_listing('units', token + ' loaded active running Description', 512)
        self.assertEqual(rows[0]['unit'], token)
        upper = r'systemd-fsck@dev-disk-by\x2Dlabel-BOOT.service'
        self.assertEqual(m.parse_listing('units', upper + ' loaded active running', 512)[0]['unit'], upper)
        for bad in (r'bad\xGG.service', r'bad\n.service', 'bad;command.service'):
            with self.assertRaises(m.Refusal):
                m.parse_listing('units', bad + ' loaded active running', 512)

    def test_actual_unit_file_count_and_explicit_ceiling(self):
        raw = '\n'.join('native-%d.service enabled' % index for index in range(291))
        self.assertEqual(len(m.parse_listing('unit-files', raw, 512)), 291)
        excess = '\n'.join('native-%d.service enabled' % index for index in range(513))
        with self.assertRaises(m.ListingRefusal) as caught:
            m.parse_listing('unit-files', excess, 512)
        self.assertEqual(caught.exception.detail['reason'], 'LISTING_BOUND')
        self.assertEqual(caught.exception.detail['rowsParsed'], 512)
        self.assertEqual(caught.exception.detail['lineIndex'], 513)


class ListingPolicyBudgetRegressionTests(unittest.TestCase):
    def policy(self):
        value = m.seed_policy()
        value['runtimePins'] = {
            name: {'path': '/protected/' + name, 'sha256': 'a' * 64,
                   'identity': [1, index + 1]}
            for index, name in enumerate(m.RUNTIME_NAMES)}
        return value

    def test_512_policy_preserves_other_budgets(self):
        policy = self.policy()
        m.validate_policy(policy)
        self.assertEqual(policy['limits']['maximumListingRows'], 512)
        self.assertEqual(policy['limits']['operationSeconds'], 30)
        self.assertEqual(policy['limits']['maximumOutputBytes'], 65536)
        policy['limits']['maximumListingRows'] = 256
        m.validate_policy(policy)

    def test_bounds_remain_explicit(self):
        for key, value in (('maximumListingRows', 513),
                           ('maximumOutputBytes', 65537),
                           ('operationSeconds', 31),
                           ('maximumCommands', 65)):
            policy = self.policy()
            policy['limits'][key] = value
            with self.assertRaises(m.Refusal):
                m.validate_policy(policy)


class V2FailureDispositionTests(unittest.TestCase):
    def test_query_failure_remains_surface_failure(self):
        report = {'coverage': {'systemListings': {'sessions': 'complete'}},
                  'listings': {'sessions': [{'session': '410', 'uid': 1000, 'owner': 'ubuntu'}]},
                  'listingFailures': []}
        policy = {'approvedUsers': ['ubuntu'], 'sourcePins': [],
                  'limits': {'maximumListingRows': 512}}
        blockers = []
        m.collect_v2_surfaces(policy, report, lambda *args: None, lambda: 1, 30,
            blockers.append, m.new_admission(),
            lambda user: types.SimpleNamespace(pw_uid=1000),
            lambda *args: {'coverage': 'partial'}, lambda *args: {'coverage': 'partial'})
        self.assertIn('SESSION_QUERY_UNRESOLVED', blockers)
        self.assertIn('USER_MANAGER_QUERY_UNRESOLVED', blockers)
        self.assertEqual(report['coverage']['sessions'], 'partial')

    def test_kernel_vanished_process_is_measured_unresolved(self):
        class Entries:
            def __enter__(self):
                return iter([types.SimpleNamespace(name='123')])
            def __exit__(self, *args):
                return False
        with patch.object(m.os, 'scandir', return_value=Entries()), \
             patch.object(m, 'read_process', side_effect=FileNotFoundError()):
            result = m.collect_kernel_metadata([], 30, lambda: 1)
        self.assertEqual(result['coverage'], 'partial')
        self.assertEqual(result['dispositions'], [{'pid': 123,
            'stage': 'process-identity-before', 'disposition': 'PROCESS_DISAPPEARED'}])


class ObservedBridgeMetadataTests(unittest.TestCase):
    def test_measured_bridge_identity_does_not_establish_admission(self):
        unit = 'fomo-address-radar-input-sync.service'
        report = {'coverage': {'systemListings': {name: 'complete' for name in
                  ('units', 'unit-files', 'timers', 'sessions')}},
                  'listings': {'sessions': [], 'timers': [{'units':
                  ['fomo-address-radar-input-sync.timer', unit]}]}, 'listingFailures': []}
        policy = {'approvedUsers': [], 'sourcePins': [], 'limits': {'maximumListingRows': 512}}
        blockers, calls = [], []
        def query(tool, args):
            calls.append((tool, args))
            values = {key: '' for key in m.SERVICE_PROPERTIES}
            values.update(Id=unit, LoadState='loaded', MainPID='0', ActiveState='inactive')
            return '\n'.join(key + '=' + values[key] for key in m.SERVICE_PROPERTIES)
        admission = m.new_admission()
        m.collect_v2_surfaces(policy, report, query, lambda: 1, 30, blockers.append,
            admission, None, lambda *args: {'coverage': 'complete'},
            lambda *args: {'coverage': 'complete'})
        self.assertEqual(report['observedUnitMetadata'][0]['unit'], unit)
        self.assertFalse(report['observedUnitMetadata'][0]['admissionClosed'])
        self.assertIn(unit, admission['units'])
        self.assertIn('BRIDGE_ADMISSION_NOT_PROVEN', blockers)
        self.assertEqual(calls[0][1][-2:], ('--', unit))

class GlobalManagerScopeTests(unittest.TestCase):
    def exercise(self, approved, extra=None):
        units = [{'unit': 'user@1000.service', 'state': ['loaded', 'active', 'running']}]
        if extra: units.append({'unit': extra, 'state': ['loaded', 'active', 'running']})
        report = {'coverage': {'systemListings': {name: 'complete' for name in
                  ('units', 'unit-files', 'timers', 'sessions')}},
                  'listings': {'units': units, 'unit-files': [], 'timers': [], 'sessions': []},
                  'listingFailures': []}
        policy = {'approvedUsers': approved, 'sourcePins': [], 'limits': {'maximumListingRows': 512}}
        blockers = []
        def query(tool, args):
            if args[0] == 'show':
                return 'Id=' + args[-1] + '\nLoadState=loaded\nActiveState=active\nMainPID=100'
            return ''
        m.collect_v2_surfaces(policy, report, query, lambda: 1, 30, blockers.append,
            m.new_admission(), lambda user: types.SimpleNamespace(pw_uid=1000),
            lambda *args: {'coverage': 'complete'}, lambda *args: {'coverage': 'complete'})
        return report, blockers

    def test_all_observed_managers_are_actually_queried(self):
        report, blockers = self.exercise(['ubuntu'])
        self.assertEqual(report['coverage']['userManagers'], 'complete')
        self.assertEqual(report['userManagerInventory']['observedUids'], [1000])
        self.assertNotIn('USER_MANAGER_GLOBAL_CLOSURE_UNRESOLVED', blockers)

    def test_unknown_global_uid_never_disappears_from_scope(self):
        report, blockers = self.exercise(['ubuntu'], 'user@2000.service')
        self.assertEqual(report['coverage']['userManagers'], 'partial')
        self.assertIn('USER_MANAGER_UNAPPROVED_UID', blockers)
        self.assertEqual(report['userManagerInventory']['unapprovedUids'], [2000])

    def test_empty_approved_subset_is_not_complete(self):
        report, blockers = self.exercise([])
        self.assertEqual(report['coverage']['userManagers'], 'partial')
        self.assertIn('USER_MANAGER_UNAPPROVED_UID', blockers)


class InertProcessIdentityTests(unittest.TestCase):
    def exercise(self, state, flags, changed=False, allowed=True):
        fields = [state, '0', '0', '0', '0', '0', str(flags)] + ['0'] * 12 + ['123']
        raw = ('123 (measured process) ' + ' '.join(fields)).encode()
        after = raw.replace(b'123', b'124', 1) if changed else raw
        info = types.SimpleNamespace(st_dev=1, st_ino=2, st_uid=0, st_gid=0)
        with patch.object(m.os, 'open', side_effect=[10, 11, 12]), \
             patch.object(m.os, 'close'), patch.object(m.os, 'fstat', return_value=info), \
             patch.object(m.os, 'stat', return_value=info), \
             patch.object(m.os, 'read', side_effect=[raw, after]), \
             patch.object(m.os, 'readlink', side_effect=FileNotFoundError()):
            return m.read_process(123, allow_inert=allowed)

    def test_kernel_thread_and_zombie_have_measured_classification(self):
        self.assertEqual(self.exercise('S', 0x200000)['resourceClass'], 'kernel-thread')
        self.assertEqual(self.exercise('Z', 0)['resourceClass'], 'zombie')

    def test_userspace_missing_exe_and_v1_zombie_still_refuse(self):
        with self.assertRaises(FileNotFoundError): self.exercise('S', 0)
        with self.assertRaises(m.Refusal): self.exercise('Z', 0, allowed=False)


class InertResourceCensusTests(unittest.TestCase):
    def exercise(self, descriptors=False, maps=b'', changed=False):
        class Entries:
            def __init__(self, rows): self.rows = rows
            def __enter__(self): return iter(self.rows)
            def __exit__(self, *args): return False
        pid = types.SimpleNamespace(name='123')
        fd = types.SimpleNamespace(name='4', path='/proc/123/fd/4')
        listings = [Entries([pid]), Entries([fd] if descriptors else []),
                    Entries([pid, types.SimpleNamespace(name='124')] if changed else [pid])]
        process = {'pid': 123, 'uid': 0, 'gid': 0, 'startTicks': '123', 'exe': None,
                   'resourceClass': 'kernel-thread'}
        with patch.object(m.os, 'scandir', side_effect=listings), \
             patch.object(m, 'read_process', return_value=process), \
             patch.object(m.os, 'stat', return_value=types.SimpleNamespace(st_dev=1, st_ino=2)), \
             patch('builtins.open', return_value=io.BytesIO(maps)):
            return m.collect_kernel_metadata([], 30, lambda: 1)

    def test_empty_inert_is_measured_not_blanket_skipped(self):
        result = self.exercise()
        self.assertEqual(result['coverage'], 'complete')
        self.assertEqual(result['dispositions'][0]['disposition'], 'MEASURED_EMPTY_KERNEL_THREAD')
        self.assertEqual(result['processesExamined'], 1)

    def test_nonempty_inert_fd_or_mapping_is_unresolved(self):
        for options in ({'descriptors': True}, {'maps': b'1000-2000 r--p 0 00:00 0\n'}):
            result = self.exercise(**options)
            self.assertEqual(result['coverage'], 'partial')
            self.assertEqual(result['dispositions'][0]['disposition'], 'KERNEL_INERT_RESOURCES')

    def test_new_process_after_scan_is_never_complete(self):
        result = self.exercise(changed=True)
        self.assertEqual(result['coverage'], 'partial')
        self.assertIn('KERNEL_PROCESS_SET_UNRESOLVED', result['errors'])


if __name__ == '__main__':
    unittest.main()
