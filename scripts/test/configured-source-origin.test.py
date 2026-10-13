"""Read-only origin capture and consumer boundary tests; OS ports are doubles here."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('configured_origin', Path(__file__).parents[1]/'activate-address-only-configured.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.adapter = SimpleNamespace(check=Mock(), source_safe=Mock())
        self.live = Mock(return_value={'mode': 'healthy'})

    def test_default_still_checks_live_readiness(self):
        self.assertEqual(m.verify_source_origin_boundary(None, {}, {}, {}, self.adapter, self.live), {'mode':'healthy'})
        self.live.assert_called_once()

    def test_default_propagates_dead_pid(self):
        self.live.side_effect = ValueError('readiness_main_pid_mismatch')
        with self.assertRaisesRegex(ValueError, 'readiness_main_pid_mismatch'):
            m.verify_source_origin_boundary(None, {}, {}, {}, self.adapter, self.live)

    def test_unbound_issuer_never_calls_a_forged_capability(self):
        verify = Mock(side_effect=AssertionError('capability callback must not run'))
        for cap in (SimpleNamespace(verify=verify), {'drained':True}, True, [], 'drained'):
            with self.subTest(cap=type(cap).__name__), patch.object(m, 'SOURCE_ORIGIN_ISSUER_SHA256', None):
                with self.assertRaisesRegex(ValueError, 'source_origin_issuer_unbound'):
                    m.verify_source_origin_boundary(cap, {}, {}, {}, self.adapter, self.live)
        verify.assert_not_called()
        self.adapter.source_safe.assert_not_called()
        self.live.assert_not_called()

    def test_accessor_on_capability_is_not_evaluated(self):
        class Forged:
            @property
            def verify(self):
                raise AssertionError('untrusted getter executed')
        with patch.object(m, 'SOURCE_ORIGIN_ISSUER_SHA256', None):
            with self.assertRaisesRegex(ValueError, 'source_origin_issuer_unbound'):
                m.verify_source_origin_boundary(Forged(), {}, {}, {}, self.adapter, self.live)

    def test_fixed_issuer_rejection_propagates_without_live_fallback_or_source_action(self):
        # Negative consumer-port tests only. These doubles are never positive
        # issuance evidence; native registry/owner tests belong to the issuer.
        for reason in ('source_origin_not_issued','owner_changed','controller_lock_not_held',
                       'boot_changed','source_origin_request_changed','source_origin_artifact_changed',
                       'source_origin_binding_changed','full_window','cgroup_populated'):
            with self.subTest(reason=reason):
                cap = object()
                verify = Mock(side_effect=ValueError(reason))
                issuer = SimpleNamespace(verify_issued_source_origin_capability=verify)
                request, state, receipt = {'transitionId':'next'}, {'phase':'COMPLETE'}, {'releaseSha256':'a'*64}
                with patch.object(m,'_source_origin_issuer',return_value=issuer):
                    with self.assertRaisesRegex(ValueError, reason):
                        m.verify_source_origin_boundary(cap, request, state, receipt, self.adapter, self.live)
                verify.assert_called_once_with(cap, request, state, receipt, self.adapter)
        self.live.assert_not_called()
        self.adapter.source_safe.assert_not_called()


class CaptureTests(unittest.TestCase):
    def fixture(self):
        binding = {'operationId':'op','generationId':'gen','target':{'database':'fixture'},'importId':'import','planSha256':'a'*64}
        original = {'protocol':'address-only-v1',**binding,'releaseSha256':'b'*64}
        state = {'phase':'COMPLETE','pending':None,'operationId':'op','receipt':{'sourceMonitoring':'waiting_configuration'},
            'manifestSha256':m.sha(m.encode(original)), 'measurement':{'binding':binding},
            'releaseRoot':'/fixture/release','nodePath':'/fixture/node','release':{'releaseSha256':'b'*64},
            'artifacts':{'/fixture/runtime.env':{'desired':{'sha256':'c'*64}}},
            'units':{'scanner':{'ready':{'mainPid':12,'childPid':13,'invocationId':'inv',
                'nonce':'1'*32,'mainStartTime':'123','childStartTime':'124'}}}}
        pin = lambda path:{'path':path,'sha256':'d'*64}
        request = {'protocol':'address-only-configured-transition-v1','transitionId':'next',
            'deadlineAtMs':int(m.time.time()*1000)+120000,'oldState':pin('/fixture/state'),'originalManifest':pin('/fixture/manifest')}
        unit = {'ActiveState':'active','MainPID':'12','InvocationID':'inv','ControlGroup':'/system.slice/fixture',
            'User':'fixture','ExecStart':'{ path=/fixture/node ; argv[]=/fixture/node fixture-command ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=12 ; code=(null) ; status=0/0 }','EnvironmentFiles':'/fixture/runtime.env','DropInPaths':'/fixture/dropin'}
        adapter = SimpleNamespace(state=state, release=Path('/fixture/release'), node=Path('/fixture/node'),
            verify_ready=Mock(), unit=Mock(side_effect=lambda service:copy.deepcopy(unit)),
            dropin=lambda service:Path('/fixture/dropin'), file_descriptor=Mock(return_value={'sha256':'c'*64}))
        module = SimpleNamespace(Deadline=lambda seconds:seconds,Journal=lambda:SimpleNamespace(read=lambda:{'binding':binding}))
        base = SimpleNamespace(SERVICES=('scanner',),protected_parent=lambda path:None,
            NativeActivation=Mock(return_value=adapter),release_inventory=Mock(return_value=state['release']),
            sealed_file=Mock(return_value=({'sha256':'e'*64},None)))
        controller = SimpleNamespace(validate_config=Mock(),load_module=Mock(return_value=module))
        files = {'/fixture/state':state,'/fixture/manifest':original}
        return SimpleNamespace(base=base,controller=controller,request=request,state=state,unit=unit,adapter=adapter,files=files)

    def capture(self, f):
        with patch.object(m,'read_pin',side_effect=lambda pin, **kwargs:m.encode(f.files[pin['path']])):
            return m.capture_source_origin(f.base,f.controller,{'operationId':'op','fence':{}},f.request,check=lambda:None)

    def test_capture_contains_bound_inputs_artifacts_and_current_process_identity(self):
        f = self.fixture()
        result = self.capture(f)
        self.assertEqual(result['transitionSha256'], m.sha(m.encode(f.request)))
        self.assertEqual(result['originStateSha256'], m.sha(m.encode(f.state)))
        self.assertEqual(result['originReceiptSha256'],m.sha(m.encode(f.state['receipt'])))
        self.assertEqual(result['binding'], f.state['measurement']['binding'])
        self.assertEqual(result['services']['scanner']['ready']['nonce'],'1'*32)
        self.assertEqual(result['services']['scanner']['unit']['ControlGroup'], f.unit['ControlGroup'])
        self.assertIn('/fixture/runtime.env',result['artifacts']['artifacts'])
        self.assertEqual(f.adapter.verify_ready.call_count,2)

    def test_target_generation_operation_mismatch_refused(self):
        for field in ('target','generationId','operationId'):
            f = self.fixture()
            f.state['measurement']['binding'][field]='changed'
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'source_origin_binding_changed'):
                self.capture(f)
            f.adapter.verify_ready.assert_not_called()

    def test_capture_dead_readiness_refuses(self):
        f=self.fixture();f.adapter.verify_ready.side_effect=ValueError('readiness_main_pid_mismatch')
        with self.assertRaisesRegex(ValueError,'readiness_main_pid_mismatch'):self.capture(f)

    def test_changed_runtime_artifact_refuses(self):
        f=self.fixture();f.adapter.file_descriptor.return_value={'sha256':'f'*64}
        with self.assertRaisesRegex(ValueError,'source_origin_artifact_changed'):self.capture(f)

    def test_missing_dropin_refuses(self):
        f=self.fixture();f.unit['DropInPaths']=''
        with self.assertRaisesRegex(ValueError,'source_origin_dropin_missing'):self.capture(f)

    def test_systemd_execstart_runtime_updates_do_not_change_static_snapshot(self):
        f = self.fixture()
        prefix = '{ path=/fixture/node ; argv[]=/fixture/node --no-global-search-paths /fixture/release/scripts/postgres-address-only-dispatch.mjs scanner ; ignore_errors=no'
        f.unit['ExecStart'] = prefix+' ; start_time=[Sun 2026-10-11 12:00:00 UTC] ; stop_time=[n/a] ; pid=12 ; code=(null) ; status=0/0 }'
        before = m.source_origin_artifact_snapshot(f.base, f.adapter, lambda:None)
        f.unit['ExecStart'] = prefix+' ; start_time=[Sun 2026-10-11 12:00:00 UTC] ; stop_time=[Sun 2026-10-11 12:01:00 UTC] ; pid=12 ; code=exited ; status=0/0 }'
        after = m.source_origin_artifact_snapshot(f.base, f.adapter, lambda:None)
        self.assertEqual(before, after)
        f.unit['ExecStart'] = f.unit['ExecStart'].replace('/fixture/node', '/fixture/other-node')
        changed = m.source_origin_artifact_snapshot(f.base, f.adapter, lambda:None)
        self.assertNotEqual(before, changed)

    def test_unknown_execstart_shape_and_multiple_commands_refused(self):
        f=self.fixture()
        for value in ('', 'fixture-command', f.unit['ExecStart']+' '+f.unit['ExecStart'],
                      f.unit['ExecStart'].replace(' ; pid=', ' ; unknown='),
                      f.unit['ExecStart']+'\n', 'x'*16385):
            with self.subTest(length=len(value)),self.assertRaisesRegex(ValueError,'source_origin_exec_shape'):
                m.source_origin_exec_configuration(value)

    def test_unit_restarts_between_live_checks_refuses(self):
        f=self.fixture();f.unit['MainPID']='99'
        with self.assertRaisesRegex(ValueError,'source_origin_not_live'):self.capture(f)


if __name__=='__main__':unittest.main()
