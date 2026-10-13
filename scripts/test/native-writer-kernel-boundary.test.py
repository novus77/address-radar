import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'native-writer-kernel-boundary.py'
SPEC = importlib.util.spec_from_file_location('kernel_boundary', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BoundaryTests(unittest.TestCase):
    def boundary(self):
        return {'sources': [dict(path='/private/source.sqlite', device=1, inode=2,
                                 uid=0, mode=0o400, nlink=1, regular=True)],
                'parent': dict(path='/private', uid=0, mode=0o700, directory=True),
                'processes': [], 'complete': True}

    def test_closed_permission_boundary_is_measured_not_invented(self):
        result = MODULE.validate_kernel_boundary(self.boundary())
        self.assertEqual(result['sourceHandles'], 0)
        self.assertTrue(result['kernelAccessBoundaryMeasured'])
        self.assertFalse(result['signedProofsCreated'])

    def test_original_postgres_owned_source_is_not_closed(self):
        value = self.boundary()
        value['sources'][0].update(uid=997, mode=0o644)
        with self.assertRaisesRegex(MODULE.Refused, 'source-permissions'):
            MODULE.validate_kernel_boundary(value)

    def test_nonroot_directory_access_refused(self):
        value = self.boundary()
        value['parent']['mode'] = 0o750
        with self.assertRaisesRegex(MODULE.Refused, 'namespace-permissions'):
            MODULE.validate_kernel_boundary(value)

    def test_preexisting_writable_fd_is_not_revoked_by_chmod(self):
        value = self.boundary()
        value['processes'] = [dict(uid=997, capabilities=0, scoped=True,
                                   handles=[dict(writable=True)], mappings=[])]
        with self.assertRaisesRegex(MODULE.Refused, 'live-writable-handle'):
            MODULE.validate_kernel_boundary(value)

    def test_shared_writable_mapping_refused(self):
        value = self.boundary()
        value['processes'] = [dict(uid=997, capabilities=0, scoped=True,
                                   handles=[], mappings=[dict(writable=True)])]
        with self.assertRaisesRegex(MODULE.Refused, 'live-writable-mapping'):
            MODULE.validate_kernel_boundary(value)

    def test_unscoped_read_handle_is_not_hidden(self):
        value = self.boundary()
        value['processes'] = [dict(uid=997, capabilities=0, scoped=False,
                                   handles=[dict(writable=False)], mappings=[])]
        with self.assertRaisesRegex(MODULE.Refused, 'unscoped-source-access'):
            MODULE.validate_kernel_boundary(value)

    def test_nonroot_privilege_can_bypass_discretionary_access(self):
        value = self.boundary()
        value['processes'] = [dict(uid=997, capabilities=2, scoped=True,
                                   handles=[], mappings=[])]
        with self.assertRaisesRegex(MODULE.Refused, 'nonroot-capability'):
            MODULE.validate_kernel_boundary(value)

    def test_incomplete_measurement_never_becomes_closed(self):
        value = self.boundary()
        value['complete'] = False
        with self.assertRaisesRegex(MODULE.Refused, 'incomplete-census'):
            MODULE.validate_kernel_boundary(value)

    def test_bounded_scandir_rejects_without_sorting_all_entries(self):
        with self.assertRaisesRegex(MODULE.Refused, 'enumeration-budget'):
            MODULE.bounded_names(iter(['1', '2', '3']), 2, lambda: None)

    def test_pid_start_parser_handles_parentheses_in_comm(self):
        fields = ['S'] + ['0'] * 18 + ['12345'] + ['0'] * 8
        self.assertEqual(MODULE.proc_start('8 (weird ) name) ' + ' '.join(fields)), '12345')

    def test_readonly_handle_requires_explicit_scope_even_root(self):
        value = self.boundary()
        value['processes'] = [dict(uid=0, capabilities=0, scoped=False,
                                   handles=[dict(writable=False)], mappings=[])]
        with self.assertRaisesRegex(MODULE.Refused, 'unscoped-source-access'):
            MODULE.validate_kernel_boundary(value)

    def test_scoped_root_readonly_collector_can_read(self):
        value = self.boundary()
        value['processes'] = [dict(uid=0, capabilities=0, scoped=True,
                                   handles=[dict(writable=False)], mappings=[])]
        self.assertEqual(MODULE.validate_kernel_boundary(value)['sourceHandles'], 1)



# These tests are also discoverable when importing the suite via unittest.
class NativeBoundaryRegressionTests(unittest.TestCase):
    def test_original_budget_is_not_reset_after_job_loading(self):
        from unittest.mock import Mock
        clock = Mock(return_value=100.0)
        deadline = MODULE.Deadline(30, clock)
        clock.return_value = 105.0
        with self.assertRaisesRegex(MODULE.Refused, 'original-deadline'):
            deadline.clip(1)

    def test_pid_reuse_is_rejected_after_empty_fd_measurement(self):
        from unittest.mock import patch
        calls = [0]
        def read(path, limit, check):
            if path.endswith('/stat'):
                calls[0] += 1
                fields = ['S'] + ['0'] * 18 + [str(10 + calls[0])] + ['0'] * 8
                return ('4 (safe) ' + ' '.join(fields)).encode()
            if path.endswith('/status'):
                return b'Uid:\t997 997 997 997\nCapEff:\t0\nCapPrm:\t0\nCapAmb:\t0\n'
            if path.endswith('/maps'):
                return b''
            raise AssertionError(path)
        with patch.object(MODULE, 'proc_read', side_effect=read), \
                patch.object(MODULE, 'list_names', side_effect=lambda path, limit, check: ['4'] if path.endswith('/task') else []):
            with self.assertRaisesRegex(MODULE.Refused, 'pid-reused'):
                MODULE.measure_process('4', {(1, 2)}, [], lambda: None, [100])

    def test_disappearing_process_does_not_prove_empty(self):
        from unittest.mock import patch
        with patch.object(MODULE, 'proc_read', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                MODULE.measure_process('4', {(1, 2)}, [], lambda: None, [100])

    def test_sidecars_bind_to_database_policy_not_fake_writer_entries(self):
        from unittest.mock import patch
        policy = dict(version=1, deploymentId='deployment', challengeId='challenge',
                      notBefore=0, notAfter=9999999999999, unresolvedScopes=[],
                      sources=[dict(path='/private/db', device='1', inode='2')])
        policy_hash = MODULE.hashlib.sha256(MODULE.canonical(policy)).hexdigest()
        activation = dict(version=1, deploymentId='deployment', policySha256=policy_hash)
        state = dict(version=1, deploymentId='deployment', policySha256=policy_hash,
                     challengeId='challenge', admission='closed', notBefore=0,
                     notAfter=9999999999999)
        state_hash = MODULE.hashlib.sha256(MODULE.canonical(state)).hexdigest()
        records = dict(activation=activation, policy=policy, state=state)
        job = dict(admissionPolicySha256=policy_hash, admissionStateSha256=state_hash,
                   sources=[dict(path='/private/db', identity=[1, 2]),
                            dict(path='/private/db-wal', identity=[1, 3]),
                            dict(path='/private/db-shm', identity=[1, 4])])
        with patch.object(MODULE, 'protected_read', side_effect=lambda path, *args, **kwargs:
                          MODULE.canonical(records[MODULE.os.path.basename(path).split('.')[0]])):
            MODULE.admission_check(job, lambda: None)

    def test_collector_failure_does_not_create_success_receipt(self):
        from unittest.mock import Mock, patch
        collector = Mock(side_effect=ValueError('private diagnostic'))
        proof = dict(kernelAccessBoundaryMeasured=True)
        with patch.object(MODULE, 'collect', return_value=proof):
            with self.assertRaises(ValueError):
                MODULE.run_collector_under_boundary({}, collector, lambda: None,
                                                    lambda: True)

    def test_missing_terminal_empty_proof_refuses_collector_receipt(self):
        from unittest.mock import Mock, patch
        with patch.object(MODULE, 'collect', return_value={'kernelAccessBoundaryMeasured': True}):
            with self.assertRaisesRegex(MODULE.Refused, 'managed-terminal-unresolved'):
                MODULE.run_collector_under_boundary({}, Mock(return_value={'actual': True}),
                                                    lambda: None, lambda: False)

class ManagedMeasurementTests(unittest.TestCase):
    def record(self):
        return dict(unitId='address-radar-verifier-fixture.service',
                    invocationId='a' * 32, cgroupPath='/system.slice/address-radar-verifier-fixture.service',
                    cgroupIdentity=[1, 9])

    def actual(self):
        return dict(Id='address-radar-verifier-fixture.service', InvocationID='a' * 32,
                    ControlGroup='/system.slice/address-radar-verifier-fixture.service',
                    Transient='yes', ActiveState='inactive', SubState='dead', Job='0')

    def test_terminal_requires_actual_inactive_empty_identity_bound_unit(self):
        MODULE.validate_managed_measurement(self.record(), self.actual(), [1, 9],
                                            'populated 0\nfrozen 0\n', terminal=True)

    def test_missing_cgroup_is_not_empty(self):
        with self.assertRaises(MODULE.Refused):
            MODULE.validate_managed_measurement(self.record(), self.actual(), None,
                                                '', terminal=True)

    def test_reused_invocation_refused_even_empty(self):
        actual = self.actual()
        actual['InvocationID'] = 'b' * 32
        with self.assertRaisesRegex(MODULE.Refused, 'managed-identity'):
            MODULE.validate_managed_measurement(self.record(), actual, [1, 9],
                                                'populated 0\n', terminal=True)

    def test_replaced_cgroup_refused_even_empty(self):
        with self.assertRaisesRegex(MODULE.Refused, 'managed-cgroup'):
            MODULE.validate_managed_measurement(self.record(), self.actual(), [1, 10],
                                                'populated 0\n', terminal=True)

    def test_inactive_populated_unit_is_not_closed(self):
        with self.assertRaisesRegex(MODULE.Refused, 'managed-populated'):
            MODULE.validate_managed_measurement(self.record(), self.actual(), [1, 9],
                                                'populated 1\n', terminal=True)

    def test_jobs_not_settled_refuses_terminal(self):
        actual = self.actual()
        actual['Job'] = '42 start'
        with self.assertRaisesRegex(MODULE.Refused, 'managed-terminal'):
            MODULE.validate_managed_measurement(self.record(), actual, [1, 9],
                                                'populated 0\n', terminal=True)

    def test_unknown_event_format_not_treated_empty(self):
        with self.assertRaisesRegex(MODULE.Refused, 'managed-events'):
            MODULE.validate_managed_measurement(self.record(), self.actual(), [1, 9],
                                                'populated 0\npopulated 1\n', terminal=True)


class ManagedCollectorIntegrationTests(unittest.TestCase):
    def test_readonly_mapping_is_not_drained(self):
        value = BoundaryTests().boundary()
        value['processes'] = [dict(uid=0, capabilities=0, scoped=True,
                                   handles=[], mappings=[dict(writable=False)])]
        with self.assertRaisesRegex(MODULE.Refused, 'live-source-mapping'):
            MODULE.validate_kernel_boundary(value)

    def exercise(self, terminal_failure=False, receipt_replaced=False):
        from types import SimpleNamespace
        from unittest.mock import patch
        events = []
        class Lease:
            role, started, complete = 'verifier', False, False
            record = {'nonce': 'a' * 16, 'artifacts': {'managed': {'systemctl': {'path': '/pinned/systemctl', 'sha256': 'd' * 64}}}}
            request_nonce, record_hash, control = 'b' * 16, 'c' * 64, 10
            binding = {'unit': 'unit.service', 'invocation_id': 'a' * 32,
                       'control_group': '/system.slice/unit.service', 'identity': [1, 2],
                       'policy': {'receipt_directory': '/protected/receipts/request'}}
            def start_approved_unit(self, argv, **limits):
                events.append('launch')
                self.started = True
                return dict(unit='unit.service', invocation_id='a' * 32,
                            proof_receipt_path='/protected/receipts/request/proof.json')
            def wait_terminal_and_empty(self):
                events.append('terminal')
                if terminal_failure:
                    raise MODULE.Refused('managed-unit-unresolved')
                self.complete = True
                return dict(status='quiescent', receipt_sha256='b' * 64)
        lease = Lease()
        helper = SimpleNamespace(__file__='/protected/expiry.py', ManagedUnitLease=Lease,
                                 invocation_directory=lambda control: 99,
                                 write_control_file=lambda fd, name, raw: events.append('publish-census'))
        def read(path, limit, check, private=False):
            if path == '/protected/expiry.py':
                return b'helper'
            events.append('receipt')
            self.assertTrue(private)
            if receipt_replaced:
                raise MODULE.Refused('protected-replaced')
            return b'{"kind":"compatibility"}'
        def census(job, check):
            events.append('census')
            return dict(actual=True)
        class Monitor:
            def __init__(self, record, check):
                events.append('monitor-active')
            def assert_terminal(self):
                events.append('monitor-terminal')
            def close(self):
                events.append('monitor-close')
        with patch.object(MODULE, 'ManagedUnitMonitor', Monitor), \
                patch.object(MODULE, 'protected_read', side_effect=read), \
                patch.object(MODULE, 'validate_job'), \
                patch.object(MODULE, 'collect', side_effect=census), \
                patch.object(MODULE.os, 'close'):
            result = MODULE.run_managed_collector({}, lambda: None, lease, helper,
                MODULE.hashlib.sha256(b'helper').hexdigest(), ['/pinned/node', '/pinned/entry'],
                dict(runtime_seconds=10, memory_max_bytes=67108864, tasks_max=8, cpu_quota_percent=10))
        return events, result

    def test_actual_lease_terminal_proof_precedes_receipt_and_final_census(self):
        events, result = self.exercise()
        self.assertEqual(events, ['census', 'publish-census', 'launch', 'monitor-active', 'terminal', 'monitor-terminal', 'receipt', 'census', 'monitor-close'])
        self.assertFalse(result['completeScopeInventoryClaimed'])
        self.assertFalse(result['signedProofsCreated'])

    def test_unresolved_unit_never_advances_to_final_census(self):
        with self.assertRaisesRegex(MODULE.Refused, 'managed-unit-unresolved'):
            self.exercise(terminal_failure=True)

    def test_replaced_receipt_refuses_even_after_terminal_empty(self):
        with self.assertRaisesRegex(MODULE.Refused, 'protected-replaced'):
            self.exercise(receipt_replaced=True)

if __name__ == '__main__':
    unittest.main()
