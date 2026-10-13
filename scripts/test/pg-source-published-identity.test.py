"""Published identities retain physical drain checks for both service users."""
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('published_identity_fence',
    Path(__file__).parents[1] / 'pg-source-replacement-fence.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PublishedIdentityTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / 'proc').mkdir()
        self.native = m.Native.__new__(m.Native)
        self.native.check = lambda: None
        self.states = {service: {'User': 'original', 'MainPID': '0', 'ActiveState': 'inactive',
            'SubState': 'dead', 'Job': '', 'ControlGroup': '/system.slice/address-radar-' + service + '.service'}
            for service in m.SERVICES}
        self.recorded = {service: dict(state) for service, state in self.states.items()}
        self.native.unit = lambda service: dict(self.states[service])
        self.expected = {service: 'original' for service in m.SERVICES}
        self.expected['wallet-monitor'] = 'wallet'
        accounts = {'original': 1001, 'wallet': 1101, 'root': 0, 'unknown': 2001}
        account_patch = patch.object(m.pwd, 'getpwnam', side_effect=lambda name:
            types.SimpleNamespace(pw_uid=accounts[name]))
        account_patch.start()
        self.addCleanup(account_patch.stop)
        def path(value):
            if value == '/proc':
                return self.root / 'proc'
            if value == '/sys/fs/cgroup':
                return self.root / 'cgroup'
            return Path(value)
        path_patch = patch.object(m, 'Path', side_effect=path)
        path_patch.start()
        self.addCleanup(path_patch.stop)

    def measure(self, expected=None):
        m.Native.physical(self.native, self.recorded, expected_users=expected)

    def test_identity_change_requires_explicit_published_binding(self):
        self.states['wallet-monitor']['User'] = 'wallet'
        with self.assertRaisesRegex(ValueError, 'service_identity_changed'):
            self.measure()
        self.measure(self.expected)

    def test_unbound_and_root_identity_changes_are_refused(self):
        for name in ('unknown', 'root'):
            self.states['wallet-monitor']['User'] = name
            with self.assertRaisesRegex(ValueError, 'service_identity_changed'):
                self.measure(self.expected)
        self.expected['wallet-monitor'] = 'root'
        with self.assertRaisesRegex(ValueError, 'service_identity_changed'):
            self.measure(self.expected)

    def test_old_and_new_user_processes_both_prevent_drain(self):
        self.states['wallet-monitor']['User'] = 'wallet'
        process = self.root / 'proc' / '42'
        process.mkdir()
        for uid in (1001, 1101):
            (process / 'status').write_text('Uid:\t' + '\t'.join([str(uid)] * 4) + '\n')
            with self.assertRaisesRegex(ValueError, 'processes_remain'):
                self.measure(self.expected)

    def test_published_identity_does_not_bypass_running_unit_or_cgroup(self):
        self.states['wallet-monitor'].update(User='wallet', MainPID='42')
        with self.assertRaisesRegex(ValueError, 'unit_not_exited'):
            self.measure(self.expected)
        self.states['wallet-monitor']['MainPID'] = '0'
        group = self.root / 'cgroup' / 'system.slice' / 'address-radar-wallet-monitor.service'
        group.mkdir(parents=True)
        (group / 'cgroup.events').write_text('populated 1\n')
        with self.assertRaisesRegex(ValueError, 'cgroup_populated'):
            self.measure(self.expected)

    def test_partial_identity_binding_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'published_service_identity_shape'):
            self.measure({'wallet-monitor': 'wallet'})


if __name__ == '__main__':
    unittest.main()
