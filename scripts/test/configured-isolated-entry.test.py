"""Real activate entry with IO doubles; not native deployment evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import stat
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('configured_entry', Path(__file__).parents[1]/'activate-address-only-configured.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class EntryTests(unittest.TestCase):
    def fixture(self):
        scope = '/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef'
        pin = lambda name: {'path': scope+'/'+name, 'sha256': 'a'*64}
        target = {'database': 'radar_rehearsal_0123456789abcdef', 'schema': 'radar_rehearsal_0123456789abcdef',
                  'schemaFingerprint': 'a'*64, 'systemIdentifier': '123', 'serverAddress': '127.0.0.1', 'serverPort': 5432}
        original = {'protocol': 'address-only-v1', 'operationId': 'op', 'generationId': 'gen', 'target': target,
                    'importId': 'import', 'planSha256': 'b'*64, 'releaseSha256': 'c'*64,
                    **{key: False for key in m.SAFETY}}
        binding = {key: copy.deepcopy(original[key]) for key in ('operationId', 'generationId', 'target', 'importId', 'planSha256')}
        isolated = {'scope': scope, 'jobPin': pin('isolated-job'), 'target': target, 'generationId': 'gen', 'operationId': 'op'}
        old = {'phase': 'COMPLETE', 'receipt': {'sourceMonitoring': 'waiting_configuration'}, 'operationId': 'op',
               'manifestSha256': m.sha(m.encode(original)), 'measurement': {'binding': binding},
               'isolatedActivation': isolated, 'releaseRoot': scope+'/old-release', 'nodePath': scope+'/node'}
        request = {'protocol': 'address-only-configured-transition-v1', 'transitionId': 'next', 'authorizationRef': 'approved',
                   'deadlineAtMs': int(time.time()*1000)+120000, 'oldState': pin('state'), 'originalManifest': pin('manifest'),
                   'releaseRoot': scope+'/new-release', 'releaseSha256': 'd'*64, 'node': pin('node'),
                   'deployment': pin('deployment'), 'environment': pin('environment'), 'nativeVerifier': pin('verifier'),
                   'resourcePolicy': {'mode': 'configured'}, 'walletServiceUser': {}}
        deployment = {'cutover': {'addressOnly': m.derive_manifest(original, 'd'*64)}, 'releaseRoot': request['releaseRoot'],
                      'operationId': 'op', 'generationId': 'gen', 'cohortId': 'import', 'sources': {},
                      'wallet': {'enabled': True}, 'composition': {'enabled': True}, **{key: False for key in m.SAFETY}}
        environment = {'flag': 'false', 'ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE': scope+'/authority',
                       'ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256': 'a'*64}
        authority = {'credential': pin('credential'), 'privateKey': pin('key')}
        files = {'state': old, 'manifest': original, 'deployment': deployment, 'environment': environment, 'authority': authority}
        fence = SimpleNamespace(operation_id='op', state={'binding': copy.deepcopy(binding)}, close=Mock())
        recover = Mock(return_value=fence)
        module = SimpleNamespace(Deadline=lambda seconds: seconds, NativeSourceFence=SimpleNamespace(recover=recover))
        reconcile = Mock(side_effect=AssertionError('reconciliation_must_not_run'))
        controller = SimpleNamespace(load_module=lambda name, pin: module if name == 'configured_fence' else SimpleNamespace(reconcile_import=reconcile))
        base = SimpleNamespace(WAITING_POLICY={}, FLAGS=('flag',), protected_parent=lambda path: None,
            _verify_isolated_target=lambda *args: object(), _isolated_target=lambda cap: isolated,
            _isolated_config=lambda *args: None, _isolated_fence_scope=Mock())
        config = {'operationId': 'op', 'launcher': pin('generator'), 'fence': pin('fence'), 'reconcile': pin('reconcile')}
        return SimpleNamespace(scope=scope, original=original, old=old, request=request, deployment=deployment,
            environment=environment, authority=authority, files=files, fence=fence, recover=recover,
            reconcile=reconcile, module=module, controller=controller, base=base, config=config)

    def run_entry(self, f):
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m.os, 'uname', return_value=SimpleNamespace(sysname='Linux')), \
             patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace()), patch.object(m, 'resolve_wallet_identity', return_value=SimpleNamespace()), \
             patch.object(m.os, 'stat', return_value=SimpleNamespace(st_mode=stat.S_IFREG|0o555, st_uid=0)), \
             patch.object(m.os, 'access', return_value=True), \
             patch.object(m, 'read_pin', side_effect=lambda pin, **kwargs: m.encode(f.files[Path(pin['path']).name])):
            m.activate(f.base, f.controller, f.config, f.request)

    def test_wrong_recovered_target_and_generation_never_reconcile_or_act(self):
        for field, value in [('target', {'database': 'other'}), ('generationId', 'other')]:
            with self.subTest(field=field):
                f = self.fixture()
                f.fence.state['binding'][field] = value
                with self.assertRaisesRegex(ValueError, 'configured_isolated_binding_changed'):
                    self.run_entry(f)
                f.recover.assert_called_once()
                f.base._isolated_fence_scope.assert_called_once_with(f.module, Path(f.scope))
                f.reconcile.assert_not_called()
                f.fence.close.assert_called_once()

    def test_original_binding_mismatch_rejected_before_recover(self):
        f = self.fixture()
        f.old['measurement']['binding']['generationId'] = 'other'
        with self.assertRaisesRegex(ValueError, 'configured_isolated_binding_changed'):
            self.run_entry(f)
        f.recover.assert_not_called()
        f.reconcile.assert_not_called()

    def test_internally_consistent_origin_cannot_cross_capability_target_or_generation(self):
        for field, value in [('target', {'database': 'other'}), ('generationId', 'other')]:
            with self.subTest(field=field):
                f = self.fixture()
                f.original[field] = value
                f.old['measurement']['binding'][field] = copy.deepcopy(value)
                f.fence.state['binding'][field] = copy.deepcopy(value)
                f.old['manifestSha256'] = m.sha(m.encode(f.original))
                f.deployment['cutover']['addressOnly'] = m.derive_manifest(f.original, 'd'*64)
                if field == 'generationId':
                    f.deployment['generationId'] = value
                with self.assertRaisesRegex(ValueError, 'configured_isolated_binding_changed'):
                    self.run_entry(f)
                f.recover.assert_not_called()
                f.reconcile.assert_not_called()

    def test_fence_scope_rejected_before_recover(self):

        f = self.fixture()
        f.base._isolated_fence_scope.side_effect = ValueError('isolated_activation_fence_scope')
        with self.assertRaisesRegex(ValueError, 'isolated_activation_fence_scope'):
            self.run_entry(f)
        f.recover.assert_not_called()
        f.reconcile.assert_not_called()

    def test_new_request_and_nested_material_paths_rejected_before_recover(self):
        for fault in ('node', 'release', 'deployment', 'environment', 'authority'):
            with self.subTest(fault=fault):
                f = self.fixture()
                if fault == 'node': f.request['node']['path'] = '/outside/node'
                elif fault == 'release':
                    f.request['releaseRoot'] = '/outside/release'
                    f.deployment['releaseRoot'] = '/outside/release'
                elif fault == 'deployment': f.deployment['nested'] = {'path': '/outside/dependency'}
                elif fault == 'environment': f.environment['EXTRA_FILE'] = '/outside/environment'
                else: f.authority['privateKey']['path'] = '/outside/key'
                with self.assertRaisesRegex(ValueError, 'configured_isolated_material_scope'):
                    self.run_entry(f)
                f.recover.assert_not_called()
                f.reconcile.assert_not_called()


if __name__ == '__main__':
    unittest.main()
