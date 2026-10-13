import copy
import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'private-fixture-managed-lane.py'
SPEC = importlib.util.spec_from_file_location('private_lane', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrivateLanePolicyTests(unittest.TestCase):
    def fixture(self):
        nonce, request = 'a' * 16, 'b' * 16
        prefix = 'radar_rehearsal_' + nonce
        record = dict(nonce=nonce, created_at=100, deadline=1000, system_identifier='123',
                      artifacts=dict(root='/var/lib/address-radar-rehearsal-artifacts/' + nonce,
                                     code_pins={'launcher.mjs': {}, 'lane.py': {}}))
        value = dict(version=1, lane='private-pg5434-cud', nonce=nonce, requestNonce=request,
                     expiryRecordSha256=MODULE.hashlib.sha256(MODULE.canonical(record)).hexdigest(),
                     expiresAt=900, runtime=dict(path='/opt/node', sha256='c' * 64),
                     controlData=dict(path='/usr/lib/postgresql/16/bin/pg_controldata', sha256='e' * 64),
                     launcherName='launcher.mjs', laneName='lane.py', jobName='job.json', jobPayloadSha256='d' * 64,
                     targets=[dict(database=prefix, schema=prefix + '_candidate', role=prefix + '_candidate',
                                   systemIdentifier='123', serverAddress='127.0.0.1', serverPort=5434),
                              dict(database=prefix, schema=prefix + '_compatible', role=prefix + '_compatible',
                                   systemIdentifier='123', serverAddress='127.0.0.1', serverPort=5434)],
                     limits=dict(runtime_seconds=10, memory_max_bytes=64 * 1024 ** 2, tasks_max=8, cpu_quota_percent=10))
        return value, record, request

    def test_registered_command_is_derived_not_caller_argv(self):
        value, record, request = self.fixture()
        argv = MODULE.validate_authority(value, record, request)
        self.assertEqual(argv, ['/opt/node', record['artifacts']['root'] + '/launcher.mjs',
                               '--job', record['artifacts']['root'] + '/job.json'])
        self.assertNotIn('password', ' '.join(argv))

    def test_production_ports_hosts_databases_and_roles_refused(self):
        for key, item in [('serverPort', 5432), ('serverAddress', 'localhost'),
                          ('database', 'production'), ('schema', 'public'), ('role', 'postgres'),
                          ('role', 'radar_rehearsal_' + 'e' * 16 + '_candidate'), ('systemIdentifier', 'other')]:
            value, record, request = self.fixture()
            value['targets'][0][key] = item
            with self.assertRaises(MODULE.Refused):
                MODULE.validate_authority(value, record, request)

    def test_unknown_entries_arguments_or_expiry_extension_refused(self):
        for key, item in [('launcherName', '../launcher'), ('laneName', 'unknown.py'),
                          ('expiresAt', 1001), ('lane', 'readonly'), ('requestNonce', 'e' * 16)]:
            value, record, request = self.fixture()
            value[key] = item
            with self.assertRaises(MODULE.Refused):
                MODULE.validate_authority(value, record, request)
        value, record, request = self.fixture()
        value['argv'] = ['/bin/sh', '-c', 'arbitrary']
        with self.assertRaises(MODULE.Refused):
            MODULE.validate_authority(value, record, request)

    def test_limits_cannot_expand_or_be_booleans(self):
        for key, item in [('runtime_seconds', 1801), ('memory_max_bytes', 300 * 1024 ** 2),
                          ('tasks_max', 33), ('cpu_quota_percent', True)]:
            value, record, request = self.fixture()
            value['limits'][key] = item
            with self.assertRaises(MODULE.Refused):
                MODULE.validate_authority(value, record, request)

    def test_no_implicit_authority_from_same_record_contents(self):
        value, record, request = self.fixture()
        value['expiryRecordSha256'] = 'f' * 64
        with self.assertRaises(MODULE.Refused):
            MODULE.validate_authority(value, record, request)



class JobPayloadTests(PrivateLanePolicyTests):
    def test_authority_job_chain_has_no_hash_self_reference(self):
        from unittest.mock import patch
        value, record, request = self.fixture()
        options = []
        items = []
        for index, target in enumerate(value['targets']):
            raw = MODULE.canonical(dict(target=dict(database=target['database'], schema=target['schema'], username=target['role'])))
            path = '/protected/options-' + str(index) + '.json'
            options.append((path, raw))
            items.append(dict(optionsPath=path, optionsSha256=MODULE.hashlib.sha256(raw).hexdigest()))
        job = dict(managedRequestNonce=request, fixture=dict(nonce=record['nonce']),
                   expiryRecordSha256=value['expiryRecordSha256'], candidate=items[0], compatible=items[1])
        value['jobPayloadSha256'] = MODULE.hashlib.sha256(MODULE.canonical(job)).hexdigest()
        authority_sha = MODULE.hashlib.sha256(MODULE.canonical(value)).hexdigest()
        job['privateFixtureAuthoritySha256'] = authority_sha
        with patch.object(MODULE, 'protected_bytes', side_effect=lambda path, maximum: dict(options)[path]):
            MODULE.validate_job_binding(job, dict(value, _sha256=authority_sha), record, request)
            job['candidate']['optionsSha256'] = '0' * 64
            with self.assertRaisesRegex(MODULE.Refused, 'job-payload-pin'):
                MODULE.validate_job_binding(job, dict(value, _sha256=authority_sha), record, request)

    def test_no_readonly_measurement_is_accepted_for_private_cud(self):
        value, record, request = self.fixture()
        value['db_readonly_sha256'] = 'f' * 64
        with self.assertRaisesRegex(MODULE.Refused, 'authority-schema'):
            MODULE.validate_authority(value, record, request)

    def test_candidate_and_retained_release_may_share_the_same_private_role(self):
        value, record, request = self.fixture()
        value['targets'][1] = copy.deepcopy(value['targets'][0])
        MODULE.validate_authority(value, record, request)


class OutsideFixtureMeasurementTests(unittest.TestCase):
    def exercise(self, output=b'Database system identifier: 123\n', ticks=10, path='/usr/lib/postgresql/16/bin/pg_controldata'):
        import contextlib
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        nonce = 'a' * 16
        record = dict(nonce=nonce, root='/tmp/radar_rehearsal_' + nonce, system_identifier='123',
                      process_ticks=10, pid=900, uid=997, gid=997, root_identity=[1, 2], data_identity=[1, 3])
        @contextlib.contextmanager
        def fixture(record):
            yield 10, 11
        expiry = SimpleNamespace(root_path_pin=lambda path: {'sha256': 'c' * 64},
                                 fixture=fixture, check_identity=Mock(return_value=ticks))
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout=output))
        with patch.object(MODULE.subprocess, 'run', run):
            result = MODULE.capture_fixture(expiry, record, dict(path=path, sha256='c' * 64),
                                             MODULE.time.monotonic() + 10)
        return result, run, expiry

    def test_actual_readonly_binary_command_is_exact_private_path_without_credentials(self):
        result, run, expiry = self.exercise()
        argv = run.call_args.args[0]
        self.assertEqual(argv, ['/usr/lib/postgresql/16/bin/pg_controldata', '-D', '/tmp/radar_rehearsal_' + 'a' * 16 + '/data'])
        self.assertEqual(run.call_args.kwargs['user'], 997)
        self.assertEqual(result['port'], 5434)
        self.assertEqual(expiry.check_identity.call_count, 2)
        self.assertNotIn('password', str(result))

    def test_missing_or_reused_postmaster_is_not_identity_proof(self):
        for ticks in [None, 11]:
            with self.assertRaisesRegex(MODULE.Refused, 'private-postmaster-required'):
                self.exercise(ticks=ticks)

    def test_wrong_or_ambiguous_control_identity_fails_closed(self):
        for output in [b'Database system identifier: 124\n',
                       b'Database system identifier: 123\nDatabase system identifier: 123\n']:
            with self.assertRaisesRegex(MODULE.Refused, 'private-system-identity'):
                self.exercise(output=output)

    def test_no_arbitrary_executable(self):
        with self.assertRaisesRegex(MODULE.Refused, 'private-control-data-scope'):
            self.exercise(path='/bin/sh')


class ReviewedAdmissionTests(unittest.TestCase):
    def test_exec_transfers_only_verified_invocation(self):
        from unittest.mock import patch
        binding = {'invocation_id': 'd' * 32}
        with patch.dict(MODULE.os.environ, {'INVOCATION_ID': 'd' * 32, 'SECRET': 'never'}, clear=True), patch.object(MODULE.os, 'execve') as execute:
            MODULE.exec_registered(['/opt/node', '/pinned/launcher'], binding)
            self.assertEqual(execute.call_args.args[2], {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'INVOCATION_ID': 'd' * 32})
        with patch.dict(MODULE.os.environ, {'INVOCATION_ID': 'e' * 32}, clear=True), patch.object(MODULE.os, 'execve') as execute:
            with self.assertRaises(MODULE.Refused):
                MODULE.exec_registered(['/opt/node'], binding)
            execute.assert_not_called()

    def test_fixture_receipt_is_request_bound_and_exclusive(self):
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        expiry = SimpleNamespace(invocation_directory=Mock(return_value=90), write_control_file=Mock())
        record = {'nonce': 'a' * 16}
        with patch.object(MODULE, 'capture_fixture', return_value={'pid': 900}), patch.object(MODULE.os, 'close'):
            proof, digest = MODULE.publish_fixture(expiry, 80, record, 'b' * 16, {}, 999)
        self.assertEqual(proof, {'pid': 900, 'request_nonce': 'b' * 16})
        self.assertEqual(digest, MODULE.hashlib.sha256(MODULE.canonical(proof)).hexdigest())
        self.assertEqual(expiry.write_control_file.call_args.args, (90, 'b' * 16 + '-verifier.fixture.json', MODULE.canonical(proof)))
        expiry.write_control_file.side_effect = FileExistsError()
        with patch.object(MODULE, 'capture_fixture', return_value={'pid': 900}), patch.object(MODULE.os, 'close'):
            with self.assertRaises(FileExistsError):
                MODULE.publish_fixture(expiry, 80, record, 'b' * 16, {}, 999)

    def test_terminal_remeasurement_rejects_pidreuse_or_receipt_mutation(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        proof = {'pid': 900, 'process_ticks': 10, 'request_nonce': 'b' * 16}
        digest = MODULE.hashlib.sha256(MODULE.canonical(proof)).hexdigest()
        expiry = SimpleNamespace(invocation_file=lambda *args: (proof, digest))
        binding = {'private_fixture_process_receipt_sha256': digest}
        with patch.object(MODULE, 'capture_fixture', return_value={'pid': 900, 'process_ticks': 10}):
            MODULE.verify_terminal_fixture(expiry, 80, {}, 'b' * 16, {}, 999, binding)
        with patch.object(MODULE, 'capture_fixture', return_value={'pid': 900, 'process_ticks': 11}):
            with self.assertRaises(MODULE.Refused):
                MODULE.verify_terminal_fixture(expiry, 80, {}, 'b' * 16, {}, 999, binding)
        expiry.invocation_file = lambda *args: (proof, '0' * 64)
        with patch.object(MODULE, 'capture_fixture') as capture:
            with self.assertRaises(MODULE.Refused):
                MODULE.verify_terminal_fixture(expiry, 80, {}, 'b' * 16, {}, 999, binding)
            capture.assert_not_called()


if __name__ == '__main__':
    unittest.main()
