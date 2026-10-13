import importlib.util
import json
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'activate-production-postgres-migrator.py'
spec = importlib.util.spec_from_file_location('activation_logging', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SuppressionTests(unittest.TestCase):
    def observation(self):
        return {'settings': dict(module.LOGGING_EXPECTATIONS), 'extensions': ['plpgsql']}

    def test_same_session_separate_ack_before_sensitive_request(self):
        calls = []
        observation = self.observation()
        class Session:
            def exchange(self, sql):
                calls.append(sql)
                if len(calls) == 1:
                    self.safe_ack = True
                    return json.dumps(observation).encode()
                self.assert_safe = self.safe_ack
                return b'native-result\n'
        session = Session()
        result = module.suppressed_sql(session, "SELECT 'SCRAM-SHA-256$fixture';", lambda: None)
        self.assertEqual(result, b'native-result\n')
        self.assertNotIn('SCRAM-SHA-256', calls[0])
        self.assertIn('SCRAM-SHA-256', calls[1])
        self.assertTrue(session.assert_safe)
        self.assertEqual(len(calls), 2)

    def test_unsafe_audit_hooks_or_failed_logging_confirmation_never_send_sensitive_sql(self):
        for key, value in [('log_statement', 'all'), ('shared_preload_libraries', 'pgaudit'),
                           ('session_preload_libraries', 'auto_explain'), ('debug_print_parse', 'on'), ('pgaudit.log', 'all')]:
            observation = self.observation(); observation['settings'][key] = value; calls = []
            class Session:
                def exchange(self, sql): calls.append(sql); return json.dumps(observation).encode()
            with self.assertRaises(module.Refused): module.suppressed_sql(Session(), "SELECT 'SCRAM-SHA-256$fixture';", lambda: None)
            self.assertEqual(len(calls), 1)
        observation = self.observation(); observation['extensions'].append('unreviewed_audit')
        with self.assertRaises(module.Refused): module.validate_logging_observation(observation)

    def test_password_comparison_uses_bootstrap_only_actual_catalog_not_masked_view(self):
        adapter = module.NativeAdapter.__new__(module.NativeAdapter)
        adapter.prepared = {'provisioning': {'roles': ['address_radar_migrator']}}
        adapter.p = {'database': 'address_radar'}
        calls = []
        def capture(sql):
            calls.append(sql)
            raise module.Refused('captured-before-execution')
        adapter.sql = capture
        with self.assertRaises(module.Refused): adapter.root_identity({'scramVerifier': 'SCRAM-SHA-256$fixture'})
        self.assertIn('FROM pg_authid WHERE', calls[0])
        self.assertIn('member=pg_authid.oid', calls[0])
        self.assertNotIn('FROM pg_roles WHERE', calls[0])

    def test_cleanup_after_reaped_child_never_reads_expired_budget_or_signals(self):
        calls = []
        class Child:
            def poll(self): return 0
            def wait(self, timeout): raise AssertionError('already reaped')
        def budget(): raise AssertionError('remaining must not be queried after exit')
        module.close_owned_child(Child(), 123, budget, lambda *args: calls.append(args))
        self.assertEqual(calls, [])

    def test_expired_budget_terminates_only_stable_owned_pidfd_and_waits_for_ack(self):
        calls = []
        class Child:
            def poll(self): return None
            def wait(self, timeout): calls.append(('wait', timeout)); return -9
        def budget(): raise module.Refused('budget')
        module.close_owned_child(Child(), 123, budget, lambda *args: calls.append(('pidfd',) + args))
        self.assertEqual(calls[0][0:2], ('pidfd', 123))
        self.assertEqual(calls[1], ('wait', 5))

    def test_unknown_owned_child_close_never_becomes_ack(self):
        class Child:
            def poll(self): return None
            def wait(self, timeout): raise module.subprocess.TimeoutExpired('owned-child', timeout)
        with self.assertRaises(module.Refused): module.close_owned_child(Child(), 123, lambda: 0.01, lambda *args: None)


if __name__ == '__main__': unittest.main()
