#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'discovery_fixture', Path(__file__).with_name('migration-authority-discovery.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
m = fixture.m


class CommandBudgetTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture.DiscoveryTests()
        self.fixture.setUp()

    def test_exhausted_budget_is_not_reported_as_process_replacement(self):
        self.fixture.policy['limits']['maximumCommands'] = 15
        report = self.fixture.collect()
        self.assertEqual(report['commandsExecuted'], 15)
        self.assertIn('COMMAND_BUDGET_EXHAUSTED', report['blockers'])
        self.assertIn('FOMO_PROCESS_IDENTITY_UNRESOLVED', report['blockers'])
        self.assertNotIn('FOMO_PROCESS_IDENTITY_CHANGED', report['blockers'])
        self.assertNotIn('OPERATION_BOUND', report['blockers'])
        self.assertFalse(report['fomoIdentityStable'])
        self.assertFalse(report['inventoryComplete'])

    def test_surface_queries_preserve_final_fomo_checks(self):
        policy = self.fixture.policy
        policy.update(version=2, surfaces=dict(m.V2_SURFACES), expectedHost='host',
                      sourceFiles=['/source.db', '/source.db-wal', '/source.db-shm'],
                      sourcePins=[{'path': path, 'identity': [1, index], 'uid': 0}
                                  for index, path in enumerate(
                                      ['/source.db', '/source.db-wal', '/source.db-shm'])])
        def consume(policy, report, query, *args):
            for _ in range(40):
                query('systemctl', ['list-jobs', '--no-legend', '--no-pager'])
        with patch.object(m, 'collect_v2_surfaces', side_effect=consume):
            report = m.collect_inventory(policy, self.fixture.execute, self.fixture.clock,
                process_reader=self.fixture.process, source_reader=lambda paths: policy['sourcePins'],
                host_reader=lambda: 'host')
        self.assertEqual(report['commandsExecuted'], policy['limits']['maximumCommands'])
        self.assertIn('SURFACE_COMMAND_BUDGET_RESERVED', report['blockers'])
        self.assertTrue(report['fomoIdentityStable'])
        self.assertNotIn('FOMO_PROCESS_IDENTITY_CHANGED', report['blockers'])
        self.assertNotIn('COMMAND_BUDGET_EXHAUSTED', report['blockers'])
        self.assertFalse(report['inventoryComplete'])

    def test_actual_process_replacement_still_fails_closed(self):
        self.fixture.test_fomo_pid_replacement_and_missing_identity_fail_closed()

    def test_time_exhaustion_remains_operation_bound(self):
        self.fixture.test_budget_exhaustion_never_claims_complete_or_executes_more()


if __name__ == '__main__':
    unittest.main()
