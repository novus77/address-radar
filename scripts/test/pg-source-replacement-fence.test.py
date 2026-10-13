import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location('pg_source_fence', Path(__file__).parents[1] / 'pg-source-replacement-fence.py')
m = importlib.util.module_from_spec(spec)
if spec.loader:
    spec.loader.exec_module(m)

class FenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def origin_snapshot(self, native, fence):
        return {'protocol':'address-only-source-origin-observation-v1',
            'transitionSha256':'a'*64,'originStateSha256':'b'*64,'originReceiptSha256':'c'*64,
            'operationId':'original','generationId':'gen','binding':{},'oldState':{},'originalManifest':{},
            'configuredOrigin':None,'sourceJournalSha256':'e'*64,'measurementSha256':'f'*64,
            'services':{service:{'ready':{'mainPid':42,'invocationId':'invocation'},
                'unit':{key:native.unit(service).get(key) for key in ('MainPID','InvocationID','ControlGroup','User')}} for service in m.SERVICES},
            'artifacts':{}}

    def test_source_origin_is_persisted_before_stop_and_not_rehydrated(self):
        native,request,fence=self.make()
        with fence:
            snapshot=self.origin_snapshot(native,fence)
            token=fence.record_source_origin(snapshot,artifact_identities={"/fixture/unit":{}})
            self.assertEqual(fence.source_origin_record(token)['snapshot'],snapshot)
            self.assertIn('sourceOrigin',json.loads((native.directory/'state.json').read_bytes()))
            fence.block();native.now+=60001
            self.assertEqual(fence.source_origin_record(token)['operationId'],request['operationId'])
        with m.PgSourceFence(native,request) as recovered:
            with self.assertRaisesRegex(ValueError,'source_origin_capability'):
                recovered.source_origin_record(token)
            with self.assertRaisesRegex(ValueError,'source_origin_capture'):
                recovered.record_source_origin(snapshot,artifact_identities={"/fixture/unit":{}})

    def test_source_origin_rejects_identity_boot_and_journal_drift(self):
        for fault in ('pid','boot','journal','late'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as directory:
                original=self.root;self.root=Path(directory)
                try:native,request,fence=self.make()
                finally:self.root=original
                with fence:
                    snapshot=self.origin_snapshot(native,fence)
                    if fault=='pid':snapshot['services']['scanner']['ready']['mainPid']=999
                    if fault=='late':fence.block()
                    if fault in ('pid','late'):
                        with self.assertRaisesRegex(ValueError,'source_origin_capture'):fence.record_source_origin(snapshot,artifact_identities={"/fixture/unit":{}})
                        continue
                    token=fence.record_source_origin(snapshot,artifact_identities={"/fixture/unit":{}})
                    if fault=='boot':native.boot='other'
                    else:
                        fence.state['sourceOrigin']['snapshot']['transitionSha256']='f'*64;fence.save()
                    with self.assertRaisesRegex(ValueError,'source_origin_'):fence.source_origin_record(token)

    def test_native_implementation_exists(self):
        self.assertTrue(callable(getattr(m, 'PgSourceFence', None)))

    def test_guard_uses_pid1_condition_and_privileged_prestart_not_unprivileged_stat(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            body = native.guard_path(m.SERVICES[0]).read_text()
            self.assertIn('ConditionPathExists=!' + str(native.sentinel), body)
            self.assertIn('ExecStartPre=+/usr/bin/test ! -e ' + str(native.sentinel), body)

    def make(self):
        native = FakeNative(self.root)
        request = {'protocol': 'address-only-pg-source-fence-v1', 'operationId': 'source-test',
            'replacementSha256': 'a' * 64, 'generationId': 'gen', 'oldProviderId': 'helius-source',
            'oldOrigin': 'https://helius.example', 'newProviderId': 'publicnode-source',
            'newOrigin': 'https://solana-rpc.publicnode.com', 'authorizationRef': 'user-approved',
            'deadlineAtMs': native.now + 180000, 'publishedFiles': []}
        return native, request, m.PgSourceFence(native, request)

    def test_same_controller_lock_excludes_another_owner(self):
        native, request, fence = self.make()
        with fence:
            with self.assertRaisesRegex(ValueError, 'controller_busy'):
                with m.PgSourceFence(native, request):
                    pass

    def test_real_subprocess_cannot_acquire_retained_controller_lock(self):
        native, request, fence = self.make()
        program = "import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);\ntry:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(37)\nsys.exit(0)"
        with fence:
            result = subprocess.run([sys.executable, '-c', program, str(native.lock_path)], timeout=3, capture_output=True)
            self.assertEqual(result.returncode, 37)

    def test_real_crash_leaves_durable_guards_and_releases_only_lock(self):
        native, request, fence = self.make()
        program = """import importlib.util,os,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('fixture',sys.argv[1]);t=importlib.util.module_from_spec(s);s.loader.exec_module(t)
n=t.FakeNative(Path(sys.argv[2]));r=__import__('json').loads(sys.argv[3])
with t.m.PgSourceFence(n,r) as f:
 f.block()
 os._exit(41)
"""
        # A separate directory avoids borrowing this test's own fixture guard path.
        child_root = self.root / 'child'
        child_root.mkdir()
        result = subprocess.run([sys.executable, '-c', program, str(Path(__file__).resolve()),
            str(child_root), json.dumps(request)], timeout=3, capture_output=True)
        self.assertEqual(result.returncode, 41, result.stderr.decode())
        self.assertTrue((child_root / 'blocked').exists())
        self.assertEqual(len(list((child_root / 'guards').glob('*.conf'))), 6)
        recovered_native = FakeNative(child_root)
        with m.PgSourceFence(recovered_native, request) as recovered:
            recovered.block()
            self.assertTrue(recovered_native.sentinel.exists())

    def test_persistent_block_survives_parent_exit_and_recovery_restarts_window(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            self.assertTrue(fence.measure()['processesExited'])
        self.assertTrue(native.sentinel.exists())
        with m.PgSourceFence(native, request) as recovered:
            recovered.block()
            with self.assertRaisesRegex(ValueError, 'full_window'):
                recovered.measure()
            native.now += 60001
            self.assertTrue(recovered.measure()['acquisitionsBlocked'])

    def test_expired_lease_is_not_proof_when_request_process_is_alive(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.live_process = True
            with self.assertRaisesRegex(ValueError, 'processes_remain'):
                fence.measure()
            self.assertTrue(native.sentinel.exists())

    def test_descendant_cgroup_tasks_refuse_drain(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.populated = True
            with self.assertRaisesRegex(ValueError, 'cgroup_populated'):
                fence.measure()

    def test_failed_handoff_keeps_every_guard_and_sentinel(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.publication_valid = False
            with self.assertRaisesRegex(ValueError, 'published_binding'):
                fence.handoff()
            self.assertTrue(native.sentinel.exists())
            self.assertEqual(len(list(native.guards.glob('*.conf'))), 6)

    def test_uncertain_publication_never_unfences(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.publication_uncertain = True
            with self.assertRaisesRegex(RuntimeError, 'uncertain'):
                fence.handoff()
            self.assertTrue(native.sentinel.exists())

    def test_handoff_rechecks_publication_before_and_after_guard_release(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            receipt = fence.handoff()
            self.assertEqual(receipt['phase'], 'HANDED_OFF')
            self.assertGreaterEqual(native.publication_checks, 2)
            self.assertFalse(native.sentinel.exists())
            self.assertTrue(all(native.states[s]['MainPID'] == '0' for s in m.SERVICES))

    def test_crash_during_handoff_keeps_sentinel_and_recovery_blocks_again(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.fail_guard_remove = True
            with self.assertRaises(OSError):
                fence.handoff()
            self.assertTrue(native.sentinel.exists())
        native.fail_guard_remove = False
        with m.PgSourceFence(native, request) as recovered:
            recovered.block()
            self.assertEqual(len(list(native.guards.glob('*.conf'))), 6)
            self.assertTrue(native.sentinel.exists())

    def test_maintenance_cannot_be_claimed_completed_or_activate_services(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            proof = fence.measure()
            self.assertFalse(proof['servicesActivated'])
            self.assertEqual(proof['replacementSha256'], request['replacementSha256'])
            self.assertEqual(proof['pendingRequestCount'], 0)
            self.assertEqual(native.starts, 0)

    def test_changed_request_does_not_reuse_persisted_window(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
        other = dict(request, replacementSha256='b' * 64)
        with self.assertRaisesRegex(ValueError, 'operation_conflict'):
            with m.PgSourceFence(native, other):
                pass

    def test_recovery_accepts_fresh_bounded_deadline_but_restarts_full_window(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
        renewed = dict(request, deadlineAtMs=native.now + 239000)
        with m.PgSourceFence(native, renewed) as recovered:
            recovered.block()
            with self.assertRaisesRegex(ValueError, 'full_window'):
                recovered.measure()
            self.assertEqual(recovered.state['initialRequestSha256'], m.digest(m.encode(request)))
            self.assertEqual(recovered.state['requestSha256'], m.digest(m.encode(renewed)))

    def test_owner_persists_all_six_creation_identities(self):
        native,request,fence = self.make()
        with fence:
            fence.block()
            records = fence.state['guardIdentities']
            self.assertEqual(set(records),set(m.SERVICES))
            self.assertEqual(json.loads((native.directory/'state.json').read_bytes())['guardIdentities'],records)
            for service in m.SERVICES:
                self.assertEqual(records[service]['inode'],native.guard_path(service).stat().st_ino)
                self.assertEqual(records[service]['sha256'],m.digest(fence.body))

    def test_recovered_owner_does_not_adopt_same_body_replacement(self):
        native,request,fence = self.make()
        with fence:fence.block()
        path = native.guard_path('scanner');body = path.read_bytes()
        path.rename(self.root/'old-guard');path.write_bytes(body);path.chmod(0o600)
        with m.PgSourceFence(native,request) as recovered:
            with self.assertRaisesRegex(ValueError,'pg_guard_changed'):recovered.block()
            self.assertTrue(native.sentinel.exists())

    def test_unrecorded_preexisting_guard_is_not_adopted(self):
        native,request,fence = self.make()
        with fence:
            path = native.guard_path('scanner');m.durable(path,fence.body)
            with self.assertRaisesRegex(ValueError,'pg_guard_identity_unavailable'):fence.block()
            self.assertTrue(path.exists())

    def test_measure_rejects_same_body_replacement(self):
        native,request,fence = self.make()
        with fence:
            fence.block();native.now += 60001
            path = native.guard_path('scanner');body=path.read_bytes()
            path.rename(self.root/'old-guard');path.write_bytes(body);path.chmod(0o600)
            with self.assertRaisesRegex(ValueError,'pg_guard_changed'):fence.measure()

    def test_boot_change_requires_fresh_physical_drain_and_window(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.boot = 'different-boot'
            with self.assertRaisesRegex(ValueError, 'boot_changed'):
                fence.measure()

    def test_wall_clock_jump_does_not_complete_monotonic_window(self):
        native, request, fence = self.make()
        with fence:
            fence.block()
            native.now += 60001
            native.monotonic_ms = lambda: native.now - 60001
            with self.assertRaisesRegex(ValueError, 'full_window'):
                fence.measure()

class PublicationTests(unittest.TestCase):
    def fixture(self, misplaced=None, missing_wallet=False):
        from unittest.mock import patch
        from types import SimpleNamespace
        request = {'generationId': 'gen', 'oldProviderId': 'helius-source',
            'oldOrigin': 'https://helius.example', 'newProviderId': 'publicnode-source',
            'newOrigin': 'https://solana-rpc.publicnode.com'}
        authority = {'generationId': 'gen', 'validator': {'reviewedProviderBindings': [{
            'chain': 'solana', 'sourceProviderId': request['newProviderId'],
            'sourceEndpoint': request['newOrigin'], 'replayProviderId': 'official-replay',
            'replayEndpoint': 'https://api.mainnet-beta.solana.com'}]}}
        deployment = {'generationId': 'gen', 'walletExecution': {'solana': {
            'providerId': request['newProviderId'], 'endpoint': request['newOrigin']}},
            'gatewayDeliveryEnabled': False, 'fomoEnabled': False, 'fullHistoricalMiningEnabled': False}
        settings = {'providerContracts': [{'providerId': request['newProviderId'],
            'origin': request['newOrigin'], 'windowMs': 60000, 'maximumRequests': 60, 'maximumConcurrency': 1}]}
        bodies = {'/authority': m.encode(authority), '/deployment': m.encode(deployment), '/settings': m.encode(settings)}
        units = {}
        for service in m.SERVICES:
            values = {'RADAR_RPC_SOLANA_HTTP_URL': request['newOrigin']}
            material = [('ADDRESS_RADAR_POSTGRES_DEPLOYMENT', '/deployment'),
                ('ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT', '/settings')]
            if (service == 'wallet-monitor' and not missing_wallet) or service == misplaced:
                material.append(('ADDRESS_RADAR_POSTGRES_AUTHORITY', '/authority'))
            for key, path in material:
                values[key + '_FILE'] = path
                values[key + '_SHA256'] = m.digest(bodies[path])
            for flag in ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
                         'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED'):
                values[flag] = 'false'
            path = '/env-' + service
            bodies[path] = ''.join(key + '=' + json.dumps(value) + '\n' for key, value in values.items()).encode()
            units[service] = {'User': 'fixture', 'EnvironmentFiles': path + ' (ignore_errors=no)', 'ExecStart': 'node dispatch'}
        request['publishedFiles'] = [{'path': path, 'sha256': m.digest(raw)} for path, raw in bodies.items()]
        native = SimpleNamespace(unit=lambda service: units[service])
        return request, native, patch.object(m, 'pinned', side_effect=lambda pin, **_: bodies[pin['path']]), patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1234))

    def test_real_publication_validator_accepts_six_controller_environments(self):
        request, native, pins, accounts = self.fixture()
        with pins, accounts:
            self.assertIn('sha256', m.Native.verify_publication(native, request))

    def test_authority_on_any_non_wallet_service_is_refused(self):
        for service in m.SERVICES:
            if service == 'wallet-monitor':
                continue
            with self.subTest(service=service):
                request, native, pins, accounts = self.fixture(misplaced=service)
                with pins, accounts, self.assertRaisesRegex(ValueError, 'unexpected_service_authority'):
                    m.Native.verify_publication(native, request)

    def test_wallet_authority_is_required(self):
        request, native, pins, accounts = self.fixture(missing_wallet=True)
        with pins, accounts, self.assertRaisesRegex(ValueError, 'published_material_pin'):
            m.Native.verify_publication(native, request)

class FakeNative:
    def __init__(self, root):
        self.root = root
        self.lock_path = root / 'controller.lock'
        self.directory = root / 'operation'
        self.guards = root / 'guards'
        self.guards.mkdir(exist_ok=True)
        self.sentinel = root / 'blocked'
        self.now = 1000000
        self.boot = 'fixture-boot'
        self.live_process = False
        self.populated = False
        self.publication_valid = True
        self.publication_uncertain = False
        self.publication_checks = 0
        self.fail_guard_remove = False
        self.starts = 0
        self.states = {s: {'MainPID': '42', 'ActiveState': 'active', 'SubState': 'running',
            'ControlGroup': '/fixture/' + s, 'User': 'fixture', 'Job': '', 'InvocationID':'invocation'} for s in getattr(m, 'SERVICES', ())}

    def clock(self): return self.now
    def monotonic_ms(self): return self.now
    def boot_id(self): return self.boot
    def validate(self, request): pass
    def guard_path(self, service): return self.guards / (service + '.conf')
    def unit(self, service): return dict(self.states[service])
    def reload(self): pass
    def stop(self, service):
        self.states[service].update(MainPID='0', ActiveState='inactive', SubState='dead')
    def physical(self, recorded):
        m.require(not self.live_process, 'processes_remain')
        m.require(not self.populated, 'cgroup_populated')
    def verify_guards(self, body):
        for s in m.SERVICES:
            m.require(self.guard_path(s).read_bytes() == body, 'guard_changed')
    def verify_publication(self, request):
        self.publication_checks += 1
        if self.publication_uncertain: raise RuntimeError('uncertain')
        m.require(self.publication_valid, 'published_binding')
        return {'sha256': 'c' * 64}
    def remove_guard(self, service):
        if self.fail_guard_remove: raise OSError('fixture interruption')
        self.guard_path(service).unlink()

    def release(self):
        if self.fail_guard_remove: raise OSError('fixture interruption')
        self.sentinel.unlink()

if __name__ == '__main__': unittest.main()
