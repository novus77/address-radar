import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('activation', Path(__file__).parents[1] / 'activate-address-only-postgres.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def credential(self, service='scanner'):
        return {'connectionString': 'postgresql://address_radar_scanner:secret%25value@127.0.0.1:5432/address_radar',
                'gatewayDeliveryEnabled': False, 'service': service, 'username': 'address_radar_scanner'}

    def test_native_credential_shape_and_url(self):
        value = self.credential()
        self.assertEqual(m.credential_url(value, 'scanner'), value['connectionString'])
        for change in [{'service': 'console'}, {'username': 'root'}, {'gatewayDeliveryEnabled': True},
                       {'connectionString': value['connectionString'] + '?sslmode=disable'},
                       {'connectionString': value['connectionString'].replace('127.0.0.1', 'localhost')},
                       {'connectionString': value['connectionString'].replace('postgresql:', 'postgres:')}]:
            with self.assertRaises(ValueError) as error:
                m.credential_url(dict(value, **change), 'scanner')
            self.assertNotIn('secret', str(error.exception))

    def test_permissions_ignore_restrictive_umask(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'evidence.json'
            old = os.umask(0o077)
            try: m.durable(path, b'{}', 0o444)
            finally: os.umask(old)
            self.assertEqual(path.stat().st_mode & 0o777, 0o444)

    def test_module_load_and_stale_capacity_are_not_live_capacity(self):
        expected = {'nodeSha256': 'a' * 64, 'releaseSha256': 'b' * 64, 'bootId': 'boot'}
        value = dict(expected, scope='six-services-live-waiting-startup', measuredAtMs=1000, readyServices=6,
                     sourceMonitoringCompleted=False, steadyStateCapacityVerified=False)
        m.validate_capacity(value, expected, 61000)
        for change in [{'scope': 'six-process-module-startup-only'}, {'measuredAtMs': 999},
                       {'readyServices': 5}, {'bootId': 'other'}, {'nodeSha256': 'c' * 64}]:
            with self.assertRaises(ValueError): m.validate_capacity(dict(value, **change), expected, 61000)

    def test_progress_is_write_ahead_and_all_dropins_precede_unguard(self):
        events = []
        class Journal:
            state = {'phase': 'PREPARED', 'units': {s: {} for s in m.SERVICES}}
            def action(self, kind, subject, operation):
                events.append(('intent', kind, subject)); operation(); events.append(('done', kind, subject))
            def save(self): events.append(('save', self.state['phase']))
        class Adapter:
            def publish(self, service): events.append(('publish', service))
            def verify_published(self): events.append(('verified',))
            def unguard(self, service): events.append(('unguard', service))
            def reload(self): events.append(('reload',))
            def fresh(self): events.append(('fresh',))
            def start(self, service): events.append(('start', service))
            def ready(self): return {s: {'service': s} for s in m.SERVICES}
            def capacity(self): return {'scope': 'six-services-live-waiting-startup'}
            def reblock(self): events.append(('reblock',))
            def complete(self): return {'businessReleaseSwitched': True}
        m.activate_units(Journal(), Adapter())
        first = next(i for i, e in enumerate(events) if e[0] == 'unguard')
        self.assertEqual(sum(e[0] == 'publish' for e in events[:first]), 6)
        self.assertEqual(events[0], ('intent', 'publish', 'scanner'))
        self.assertNotIn(('reblock',), events)

    def test_readiness_failure_reblocks_and_never_claims_success(self):
        class Journal:
            state = {'phase': 'PREPARED', 'units': {s: {} for s in m.SERVICES}}
            def action(self, kind, subject, operation): operation()
            def save(self): pass
        class Adapter:
            def __init__(self): self.blocked = False; self.completed = False
            def publish(self, service): pass
            def verify_published(self): pass
            def unguard(self, service): pass
            def reload(self): pass
            def fresh(self): pass
            def start(self, service): pass
            def ready(self): raise ValueError('readiness_not_bound')
            def capacity(self): raise AssertionError('no fake capacity')
            def reblock(self): self.blocked = True
            def complete(self): self.completed = True
        adapter = Adapter(); journal = Journal()
        with self.assertRaises(ValueError): m.activate_units(journal, adapter)
        self.assertTrue(adapter.blocked); self.assertFalse(adapter.completed)
        self.assertEqual(journal.state['phase'], 'BLOCKED')

    def test_atomic_journal_reloads_interrupted_intent(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'state.json'
            with patch.object(m, 'ROOT_UID', os.geteuid()), patch.object(m, 'ROOT_GID', os.getegid()):
                journal = m.ActivationJournal(path, {'operationId': 'op', 'phase': 'PREPARED'})
                with self.assertRaises(KeyboardInterrupt):
                    journal.action('unguard', 'scanner', lambda: (_ for _ in ()).throw(KeyboardInterrupt()))
                again = m.ActivationJournal(path, None)
                self.assertEqual(again.state['pending'], {'kind': 'unguard', 'subject': 'scanner'})




class RecoveryRegressions(unittest.TestCase):
    def test_environment_preserves_url_and_digest_names_without_disclosure(self):
        value = {'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256': 'a' * 64,
                 'ADDRESS_RADAR_POSTGRES_URL': 'postgresql://role:quote"and\\backslash@127.0.0.1:5432/address_radar'}
        text = m.environment_file(value).decode()
        for line in text.splitlines():
            key, raw = line.split('=', 1)
            self.assertEqual(json.loads(raw), value[key])
        with self.assertRaises(ValueError): m.environment_file({'X': 'secret\nline'})

    def test_interrupted_managed_publication_replays_without_clobbering_user_file(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'ROOT_UID', os.geteuid()), patch.object(m, 'ROOT_GID', os.getegid()), patch.object(m, 'protected_parent'):
            state = {'operationId': 'op', 'phase': 'PREPARED', 'artifacts': {}}
            journal = m.ActivationJournal(Path(root) / 'state.json', state)
            adapter = m.NativeActivation.__new__(m.NativeActivation)
            adapter.state, adapter.journal, adapter.config, adapter.check = state, journal, {'operationId': 'op'}, lambda: None
            path = Path(root) / 'owned.env'
            original = m.os.replace
            with patch.object(m.os, 'replace', side_effect=lambda source, target: (_ for _ in ()).throw(KeyboardInterrupt()) if str(target) == str(path) else original(source, target)):
                with self.assertRaises(KeyboardInterrupt): adapter.managed(path, b'not-logged', 0o600)
            again = m.ActivationJournal(Path(root) / 'state.json', None)
            adapter.state = again.state; adapter.journal = again
            adapter.managed(path, b'not-logged', 0o600)
            self.assertEqual(path.read_bytes(), b'not-logged')
            user = Path(root) / 'user.conf'; user.write_text('preserve')
            with self.assertRaisesRegex(ValueError, 'unowned_activation_file'): adapter.managed(user, b'overwrite')
            self.assertEqual(user.read_text(), 'preserve')

    def test_capacity_cannot_retimestamp_old_host_observation(self):
        from types import SimpleNamespace
        class CgroupPath:
            def __init__(self, path): self.path = str(path)
            def __truediv__(self, name): return CgroupPath(self.path + '/' + name)
            def read_text(self):
                if self.path.endswith('memory.max'): return str(m.WAITING_MEMORY_MAX)
                if self.path.endswith('pids.max'): return str(m.WAITING_TASKS_MAX)
                return '100' if self.path.endswith('memory.current') else '200'
        expected = {'nodeSha256': 'a' * 64, 'releaseSha256': 'b' * 64, 'bootId': 'boot'}
        adapter = SimpleNamespace(verify_ready=lambda: None, fresh=lambda: None, source_safe=lambda: None,
            state={'resources': dict(expected, measuredAtMs=1)}, expected_resources=lambda: expected,
            unit=lambda service: {'ControlGroup': '/system.slice/address-radar-' + service + '.service', 'MainPID': '100'})
        with patch.object(m, 'Path', CgroupPath), patch.object(m.time, 'time', return_value=61):
            with self.assertRaisesRegex(ValueError, 'resource_evidence_stale'):
                m.NativeActivation.capacity(adapter)

    def test_readiness_never_accepts_only_active_or_wrong_binding(self):
        from types import SimpleNamespace
        adapter = m.NativeActivation.__new__(m.NativeActivation)
        adapter.account = SimpleNamespace(pw_uid=1001, pw_gid=1001)
        adapter.config = {'operationId': 'op'}
        adapter.state = {'attempt': 'a' * 32, 'measurement': {'binding': {'generationId': 'generation'}}, 'release': {'releaseSha256': 'b' * 64}}
        adapter.unit = lambda service: {'ActiveState': 'active', 'MainPID': '123', 'InvocationID': 'invocation', 'ControlGroup': '/system.slice/unit'}
        value = {'relayProtocol': 'address-only-ready-relay-v1', 'type': 'postgres-service-ready', 'service': 'scanner',
            'operationId': 'op', 'generationId': 'generation', 'releaseSha256': 'b' * 64, 'nonce': 'c' * 32,
            'attempt': 'a' * 32, 'childPid': 124}
        for change in [{'operationId': 'other'}, {'generationId': 'other'}, {'releaseSha256': 'd' * 64}, {'attempt': 'e' * 32}]:
            with self.assertRaises(ValueError): adapter.validate_ready(dict(value, **change), (123, 1001, 1001))
        with self.assertRaisesRegex(ValueError, 'main_pid'): adapter.validate_ready(value, (999, 1001, 1001))

class WaitingResourcePolicyTests(unittest.TestCase):
    def host(self):
        return {'totalRamBytes': 5 * 1024**3 // 2, 'availableRamBytes': 2 * 1024**3,
                'availableDiskBytes': 3 * 1024**3}

    def test_exact_host_thresholds_and_one_byte_below(self):
        m.validate_waiting_host(self.host(), prestart=True)
        for key in self.host():
            value = self.host(); value[key] -= 1
            with self.assertRaises(ValueError): m.validate_waiting_host(value, prestart=True)

    def test_live_memory_does_not_reapply_prestart_headroom(self):
        value = self.host(); value['availableRamBytes'] = 512 * 1024**2
        m.validate_waiting_host(value)
        with self.assertRaises(ValueError): m.validate_waiting_host(value, prestart=True)
        self.assertEqual(6 * m.WAITING_MEMORY_MAX + 1024**3, self.host()['totalRamBytes'])

    def test_exact_limits_reject_unbounded_or_different_values(self):
        m.validate_waiting_limits(str(m.WAITING_MEMORY_MAX), '64')
        for memory, tasks in [('max', '64'), (str(m.WAITING_MEMORY_MAX), 'max'),
                              (str(m.WAITING_MEMORY_MAX - 1), '64'), (str(m.WAITING_MEMORY_MAX), '65')]:
            with self.assertRaises(ValueError): m.validate_waiting_limits(memory, tasks)

    def test_dropin_limits_require_explicit_waiting_policy(self):
        from types import SimpleNamespace
        adapter = m.NativeActivation.__new__(m.NativeActivation)
        adapter.state = {}
        with self.assertRaisesRegex(ValueError, 'explicit_waiting'): adapter.publish('scanner')
        adapter.state = {'waitingResourcePolicy': dict(m.WAITING_POLICY)}
        adapter.account = SimpleNamespace(pw_name='address-radar', pw_gid=os.getegid())
        adapter.directory = Path('/etc/address-radar/test'); adapter.node = Path('/node'); adapter.release = Path('/release')
        adapter.dropin = lambda service: Path('/test.conf')
        published = []
        adapter.managed = lambda path, body, mode: published.append(body.decode())
        adapter.publish('scanner')
        self.assertIn('MemoryMax=268435456\nTasksMax=64\n', published[0])

class IsolatedCredentialBoundaryTests(unittest.TestCase):
    def value(self):
        return {'connectionString':'postgresql://address_radar_scanner:fixture@127.0.0.1:5432/radar_rehearsal_0123456789abcdef',
                'gatewayDeliveryEnabled':False,'service':'scanner','username':'address_radar_scanner'}

    def test_default_production_rejects_rehearsal_database(self):
        with self.assertRaisesRegex(ValueError,'service_credential_target'):
            m.credential_url(self.value(),'scanner')

    def test_arbitrary_isolated_target_dictionary_is_not_authority(self):
        with self.assertRaisesRegex(ValueError,'isolated_activation_authority'):
            m.credential_url(self.value(),'scanner',isolated_target={'database':'radar_rehearsal_0123456789abcdef'})

    def test_production_entry_has_no_unreviewed_database_override(self):
        with self.assertRaises(TypeError):
            m.activate(None,{},None,expectedDatabase='radar_rehearsal_0123456789abcdef')

    def test_isolated_entry_requires_a_real_pinned_job(self):
        with self.assertRaises(ValueError):
            m.activate_isolated(None,{},None,{'path':'/tmp/untrusted','sha256':'a'*64})

class IsolatedManagerBoundaryTests(unittest.TestCase):
    def invoke(self, *, peer=(1,0,0), extra_mount='', environment=None, machine_after=None):
        from types import SimpleNamespace
        from unittest.mock import MagicMock
        mounts='1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / /run rw - tmpfs tmpfs rw\n'+extra_mount
        machine='1'*32
        reads=0
        def read(path, *args, **kwargs):
            nonlocal reads
            if str(path) == '/proc/1/comm': return 'systemd\n'
            if str(path) == '/proc/self/mountinfo': return mounts
            if str(path) == '/etc/machine-id':
                reads+=1
                return machine if reads == 1 or machine_after is None else machine_after
            raise AssertionError('unexpected isolated runtime read')
        channel=MagicMock()
        channel.__enter__.return_value=channel
        channel.getsockopt.return_value=m.struct.pack('3i',*peer)
        controller=MagicMock()
        with patch.dict(m.os.environ,environment or {},clear=True), \
             patch.object(m.os,'geteuid',return_value=0), \
             patch.object(m.os,'uname',return_value=SimpleNamespace(sysname='Linux')), \
             patch.object(m.os,'stat',return_value=SimpleNamespace(st_dev=1,st_ino=42)), \
             patch.object(Path,'read_text',read), patch.object(m.socket,'SO_PEERCRED',17,create=True), \
             patch.object(m.socket,'socket',return_value=channel), \
             patch.object(m,'_activate') as activate:
            with self.assertRaises(ValueError) as refused:
                m.activate_isolated(controller,{},None,{'path':'/unread','sha256':'a'*64})
            controller.pinned_read.assert_not_called()
            activate.assert_not_called()
        return str(refused.exception),channel

    def test_ancestor_manager_peer_is_rejected_before_any_controller_action(self):
        for peer in ((900,0,0),(1,1000,1000)):
            reason,channel=self.invoke(peer=peer)
            self.assertEqual(reason,'isolated_activation_manager_peer')
            channel.connect.assert_called_once_with('/run/systemd/private')

    def test_environment_overrides_are_rejected_before_socket_or_controller(self):
        for key in ('DBUS_SYSTEM_BUS_ADDRESS','DBUS_SESSION_BUS_ADDRESS','SYSTEMD_BUS_ADDRESS','SYSTEMD_UNIT_PATH'):
            reason,channel=self.invoke(environment={key:'fixture'})
            self.assertEqual(reason,'isolated_activation_manager_environment')
            channel.connect.assert_not_called()

    def test_host_manager_mount_and_ancestor_bind_are_rejected(self):
        for target in ('/run','/run/systemd','/run/systemd/private','/run/dbus','/var/lib/address-radar','/var/lib/address-radar/address-radar.db'):
            reason,_=self.invoke(extra_mount='3 1 8:1 / '+target+' rw - ext4 /dev/fixture rw\n')
            self.assertEqual(reason,'isolated_activation_mount')

    def test_changed_local_machine_identity_is_rejected(self):
        reason,_=self.invoke(machine_after='2'*32)
        self.assertEqual(reason,'isolated_activation_manager_machine')

class IsolatedSourcePathTests(unittest.TestCase):
    def test_only_fixed_source_and_scoped_control_are_accepted(self):
        from types import SimpleNamespace
        scope=Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
        module=SimpleNamespace(CONTROL=str(scope/'control'),MASK_DIRECTORY=str(scope/'units'),
            BACKUP_DIRECTORY=str(scope/'backup'),SOURCE_DIRECTORY='/var/lib/address-radar',
            SOURCE='/var/lib/address-radar/address-radar.db')
        with patch.object(m,'protected_parent') as protected:
            m._isolated_fence_scope(module,scope)
            protected.assert_called_once_with(Path(module.SOURCE))
            module.SOURCE=str(scope/'source.db')
            with self.assertRaisesRegex(ValueError,'isolated_activation_source_path'):
                m._isolated_fence_scope(module,scope)
            module.SOURCE='/var/lib/address-radar/address-radar.db'
            module.CONTROL='/var/lib/address-radar-address-only-cutover'
            with self.assertRaisesRegex(ValueError,'isolated_activation_fence_scope'):
                m._isolated_fence_scope(module,scope)

if __name__ == '__main__': unittest.main()


