#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import types
import unittest

spec = importlib.util.spec_from_file_location(
    'discovery', Path(__file__).resolve().parents[1] / 'migration-authority-discovery.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeContractTests(unittest.TestCase):
    def exercise(self, users, observed, manager_active=True, extra_services=0):
        report = {'coverage': {'systemListings': {name: 'complete' for name in
                  ('units', 'unit-files', 'timers', 'sessions')}},
                  'listings': {'units': [{'unit': 'user@1000.service'}] if observed else [],
                               'unit-files': [], 'timers': [], 'sessions': [
                                   {'session': '410', 'uid': '1000', 'owner': 'ubuntu'}] if observed else []},
                  'listingFailures': []}
        report['listings']['units'] += [
            {'unit': 'address-radar-extra-' + str(index) + '.service'}
            for index in range(extra_services)]
        policy = {'approvedUsers': users, 'sourcePins': [], 'limits': {'maximumListingRows': 512}}
        blockers, calls = [], []
        def query(tool, args):
            calls.append((tool, args))
            if tool == 'loginctl':
                self.assertEqual([arg for arg in args if arg.startswith('--property=')],
                                 ['--property=' + name for name in m.SESSION_PROPERTIES])
                return 'Id=410\nUser=1000\nName=ubuntu'
            if args[0] != 'show':
                return ''
            unit = args[-1]
            if unit.startswith('user@'):
                active = manager_active and unit == 'user@1000.service'
                return ('Id=' + unit + '\nLoadState=loaded\nActiveState=' +
                        ('active' if active else 'inactive') + '\nMainPID=' + ('100' if active else '0'))
            values = {key: '' for key in m.SERVICE_PROPERTIES}
            values.update(Id=unit, LoadState='loaded', MainPID='0', ActiveState='inactive')
            return '\n'.join(key + '=' + values[key] for key in m.SERVICE_PROPERTIES)
        m.collect_v2_surfaces(policy, report, query, lambda: 1, 30, blockers.append,
            m.new_admission(), lambda user: types.SimpleNamespace(pw_uid=1000 if user == 'ubuntu' else 0),
            lambda *args: {'coverage': 'complete'}, lambda *args: {'coverage': 'complete'})
        return report, blockers, calls

    def test_login_session_uses_individual_property_arguments(self):
        report, blockers, _ = self.exercise(['ubuntu'], True)
        self.assertEqual(report['coverage']['sessions'], 'complete')
        self.assertNotIn('SESSION_IDENTITY_UNRESOLVED', blockers)

    def test_unobserved_inactive_manager_is_measured_not_required_active(self):
        report, blockers, _ = self.exercise(['root', 'ubuntu'], True)
        self.assertEqual(report['coverage']['userManagers'], 'complete')
        self.assertNotIn('USER_MANAGER_UNRESOLVED', blockers)
        self.assertEqual(len(report['userManagers']), 2)

    def test_observed_inactive_manager_remains_unresolved(self):
        report, blockers, _ = self.exercise(['ubuntu'], True, manager_active=False)
        self.assertEqual(report['coverage']['userManagers'], 'partial')
        self.assertIn('USER_MANAGER_UNRESOLVED', blockers)

    def test_metadata_covers_measured_host_size_without_truncation(self):
        report, blockers, _ = self.exercise([], False, extra_services=24)
        self.assertEqual(len(report['observedUnitMetadata']), 24)
        self.assertEqual(report['coverage']['unitMetadata'], 'complete')
        self.assertNotIn('OBSERVED_UNIT_METADATA_BOUND', blockers)

    def test_excess_metadata_remains_partial(self):
        report, blockers, _ = self.exercise([], False, extra_services=33)
        self.assertEqual(len(report['observedUnitMetadata']), 32)
        self.assertEqual(report['coverage']['unitMetadata'], 'partial')
        self.assertIn('OBSERVED_UNIT_METADATA_BOUND', blockers)

    def test_revised_discovery_budgets_preserve_other_limits(self):
        self.assertEqual(m.seed_policy(2)['limits']['maximumCommands'], 64)
        self.assertEqual(m.seed_policy(1)['limits']['maximumCommands'], 32)
        self.assertEqual(m.KERNEL_BOUNDS['maximumProcesses'], 256)
        self.assertEqual(m.KERNEL_BOUNDS['maximumTotalFds'], 4096)
        self.assertEqual(m.KERNEL_BOUNDS['maximumTotalMapsBytes'], 8388608)
        self.assertEqual(m.seed_policy(2)['limits']['operationSeconds'], 30)


if __name__ == '__main__':
    unittest.main()
