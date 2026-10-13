import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

TEMP_PARENT = Path(tempfile.gettempdir()).resolve()

SPEC = importlib.util.spec_from_file_location('preparation', Path(__file__).parents[1] / 'prepare-production-postgres-target.py')
sys.dont_write_bytecode = True
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)
SERVICES = ('scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console')

def plan():
    resources = {'pools': {service: {'instances': 1, 'maximumConnections': 1} for service in SERVICES},
        'maximumPendingOperations': 0, 'connectionTimeoutMs': 1000, 'idleTimeoutMs': 1000,
        'statementTimeoutMs': 2000, 'lockTimeoutMs': 1000, 'idleTransactionTimeoutMs': 2000,
        'shutdownTimeoutMs': 2000, 'workMemKb': 2048, 'serverMaximumConnections': 16,
        'postgresReservedConnections': 2, 'otherHostConnections': 0, 'migrationConnections': 1,
        'operatorConnections': 1, 'backupConnections': 1, 'maximumMeasurementAgeMs': 60000}
    fingerprint = hashlib.sha256(json.dumps(resources, separators=(',', ':')).encode()).hexdigest()
    return {'version': 1, 'operationId': 'prepare-1', 'hostId': 'host-1', 'machineId': 'a' * 32,
        'target': {'version': 16, 'cluster': 'radarproduction', 'host': '127.0.0.1', 'port': 5432,
            'dataDirectory': '/var/lib/postgresql/16/radarproduction', 'configDirectory': '/etc/postgresql/16/radarproduction',
            'socketDirectory': '/var/run/postgresql'},
        'database': 'address_radar', 'schema': 'radar_business', 'generation': 'generation-1',
        'migratorRole': 'radar_migrator', 'serviceRoles': {s: 'radar_' + s.replace('-', '_') for s in SERVICES},
        'resources': resources, 'capacity': {'status': 'measured', 'hostId': 'host-1', 'measurementRef': 'protected:measurement-1',
            'resourcePolicyFingerprint': fingerprint, 'measuredAt': '2026-10-06T00:00:00.000Z', 'validUntil': '2026-10-06T00:01:00.000Z',
            'availableRamBytes': '1000', 'measuredPeakRamBytes': '600', 'ramMarginBytes': '100',
            'availableDiskBytes': '1000', 'measuredPeakDiskBytes': '500', 'measuredPeakWalBytes': '100',
            'measuredPeakTempBytes': '100', 'diskMarginBytes': '100'},
        'settings': {'sharedBuffersKb': 8192, 'maxWalSizeMb': 256, 'maintenanceWorkMemKb': 8192,
            'superuserReservedConnections': 1, 'reservedConnections': 1},
        'emptyTargetGuard': {'minimumAvailableMemoryBytes': '1000', 'minimumFreeDiskBytes': '1000', 'maximumMemoryPsiAvg10': 1},
        'ownership': {name: {'uid': 0, 'gid': 0, 'mode': 0o700 if name in ('data', 'config') else 0o644}
            for name in ('data', 'config', 'mainConfig', 'hba', 'generatedConfig')},
        'startupUnit': {'fragmentPath': '/usr/lib/systemd/system/postgresql@.service', 'fragmentSha256': 'c' * 64,
            'dropIns': [], 'execStart': '{ path=/usr/bin/mock-start ; argv[]=/usr/bin/mock-start --start ; ignore_errors=no ; }', 'user': '', 'group': '', 'environmentFiles': ''},
        'tools': {name: {'path': '/usr/bin/' + name, 'sha256': 'b' * 64} for name in
            ('pg_createcluster', 'pg_ctlcluster', 'pg_controldata', 'runuser', 'psql', 'systemctl', 'busctl')},
        'configAncestors': {path: {'uid': 0 if path in ('/', '/etc') else 110,
            'gid': 0 if path in ('/', '/etc') else 114, 'mode': 0o755, 'device': '1', 'inode': str(index + 1)}
            for index, path in enumerate(('/', '/etc', '/etc/postgresql', '/etc/postgresql/16'))},
        'stageTimeoutSeconds': 180, 'operationTimeoutSeconds': 900}

NOW = 1791244800000

class MemoryStorage:
    def __init__(self):
        self.journal = None
        self.secret = None
    def load(self):
        return copy.deepcopy(self.journal)
    def save(self, value):
        self.journal = copy.deepcopy(value)
    def ensure_secrets(self, roles):
        if self.secret is None:
            self.secret = {role: 'mock-private-secret' for role in roles}
        return {'identity': 'mock-receipt-1'}

class Adapter:
    def __init__(self):
        self.receipts = {}
        self.calls = []
        self.fail = None
        self.foreign = False
        self.machine_id = 'a' * 32
    def observe(self, prepared):
        return {'machineId': self.machine_id, 'portAvailable': not self.receipts,
            'foreignObjects': self.foreign, 'stages': copy.deepcopy(self.receipts)}
    def apply(self, stage, prepared):
        self.calls.append(stage)
        if self.fail == stage:
            raise RuntimeError('sensitive-host-output')
        self.receipts[stage] = {'identity': stage + '-oid-123', 'planSha256': prepared['planSha256']}
        return copy.deepcopy(self.receipts[stage])

class PreparationTests(unittest.TestCase):
    def test_empty_target_accepts_explicit_unknown_full_capacity_without_claiming_it(self):
        candidate = plan()
        candidate['capacity'] = None
        result = module.prepare_target(candidate, Adapter(), MemoryStorage(), NOW)
        self.assertFalse(result['fullCapacityProved'])
        self.assertFalse(result['credentialsInstalled'])
        self.assertFalse(result['rolesLoginEnabled'])

    def test_example_preserves_unresolved_nulls_and_cannot_execute(self):
        example = module.example()
        self.assertIsNone(example['capacity'])
        self.assertIsNone(example['schema'])
        self.assertIsNone(example['settings']['sharedBuffersKb'])
        self.assertEqual(set(module.schema()['required']), set(example))
        with self.assertRaises((module.Refused, TypeError)):
            module.validate_plan(example, NOW)

    def test_default_cli_is_offline_and_invalid_apply_binding_never_constructs_host_adapter(self):
        candidate = plan()
        candidate['capacity'] = None
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            path = Path(parent) / 'plan.json'
            path.write_text(json.dumps(candidate))
            with patch.object(module.sys, 'argv', ['prepare', '--plan', str(path)]), patch.object(module, 'NativeAdapter', side_effect=AssertionError('host must not run')):
                self.assertFalse(module.cli()['hostObserved'])
            with patch.object(module.sys, 'argv', ['prepare', '--plan', str(path), '--mode', 'apply', '--approved-plan-sha256', 'wrong', '--private-directory', str(Path(parent) / 'private')]), patch.object(module, 'NativeAdapter', side_effect=AssertionError('host must not run')):
                with self.assertRaises(module.Refused): module.cli()
            self.assertFalse((Path(parent) / 'private').exists())

    def test_native_sql_material_is_nologin_template0_and_has_no_schema_install(self):
        candidate = plan()
        candidate['capacity'] = None
        prepared = module.validate_plan(candidate, NOW)
        adapter = object.__new__(module.NativeAdapter)
        adapter.p = prepared
        adapter.deadline = float('inf')
        adapter.resource_guard = lambda: None
        adapter.config_ancestor_identity = lambda: adapter.p['plan']['configAncestors']
        statements = []
        adapter.sql = lambda text, database='postgres': statements.append(text)
        adapter.observe = lambda _: {'stages': {stage: {'planSha256': prepared['planSha256']} for stage in module.STAGES}}
        for stage in ('roles', 'database', 'lockdown'):
            adapter.apply(stage, prepared)
        text = '\n'.join(statements)
        self.assertEqual(text.count('CREATE ROLE '), 7)
        self.assertEqual(text.count(' NOLOGIN '), 7)
        self.assertIn('TEMPLATE template0', text)
        self.assertIn('OWNER "radar_migrator"', text)
        self.assertNotIn('CREATE SCHEMA', text)
        self.assertNotIn('PASSWORD', text)
        self.assertNotIn('DROP ', text)

    def test_duplicate_json_and_implicit_guard_defaults_are_rejected(self):
        with self.assertRaises(module.Refused): module.strict_json('{"x":1,"x":2}')
        candidate = plan()
        del candidate['emptyTargetGuard']['minimumAvailableMemoryBytes']
        with self.assertRaises(module.Refused): module.validate_plan(candidate, NOW)

    def test_complete_preparation_is_not_activation_and_rerun_is_noop(self):
        adapter, storage = Adapter(), MemoryStorage()
        result = module.prepare_target(plan(), adapter, storage, NOW)
        self.assertEqual(result['status'], 'prepared')
        self.assertFalse(result['productionMigrationReady'])
        self.assertTrue(result['schemaDeferred'])
        first = list(adapter.calls)
        module.prepare_target(plan(), adapter, storage, NOW)
        self.assertEqual(adapter.calls, first)
        self.assertNotIn('mock-private-secret', json.dumps(result))
        self.assertNotIn('mock-private-secret', json.dumps(storage.journal))

    def test_missing_resources_no_defaults(self):
        candidate = plan()
        del candidate['resources']['workMemKb']
        with self.assertRaises(module.Refused):
            module.validate_plan(candidate, NOW)

    def test_exact_resource_fingerprint_matches_existing_planner_order(self):
        candidate = plan()
        result = module.validate_plan(candidate, NOW)
        self.assertEqual(result['resourcePolicyFingerprint'], candidate['capacity']['resourcePolicyFingerprint'])

    def test_rejects_capacity_budget_collisions_and_acceptance(self):
        for change in ('capacity', 'connections', 'roles', 'acceptance', 'stale', 'settings', 'unknown'):
            candidate = plan()
            if change == 'capacity': candidate['capacity']['availableRamBytes'] = '1'
            if change == 'connections': candidate['resources']['serverMaximumConnections'] = 2
            if change == 'roles': candidate['serviceRoles']['console'] = candidate['migratorRole']
            if change == 'acceptance': candidate['target']['port'] = 5433
            if change == 'stale': candidate['capacity']['measuredAt'] = '2026-10-05T00:00:00.000Z'
            if change == 'settings': del candidate['settings']['sharedBuffersKb']
            if change == 'unknown': candidate['trustedReviewer'] = 'invented'
            with self.subTest(change=change), self.assertRaises(module.Refused):
                module.validate_plan(candidate, NOW)

    def test_unknown_existing_objects_are_not_adopted(self):
        adapter, storage = Adapter(), MemoryStorage()
        adapter.foreign = True
        with self.assertRaises(module.Refused): module.prepare_target(plan(), adapter, storage, NOW)
        self.assertEqual(adapter.calls, [])

    def test_partial_failure_preserves_objects_and_pending_blocks_retry(self):
        adapter, storage = Adapter(), MemoryStorage()
        adapter.fail = 'database'
        with self.assertRaises(module.Refused) as failure: module.prepare_target(plan(), adapter, storage, NOW)
        self.assertNotIn('sensitive-host-output', str(failure.exception))
        self.assertIn('roles', adapter.receipts)
        self.assertEqual(storage.journal['pending'], 'database')
        calls = list(adapter.calls)
        with self.assertRaises(module.Refused): module.prepare_target(plan(), adapter, storage, NOW)
        self.assertEqual(adapter.calls, calls)

    def test_changed_ack_identity_and_plan_are_rejected(self):
        adapter, storage = Adapter(), MemoryStorage()
        module.prepare_target(plan(), adapter, storage, NOW)
        adapter.receipts['roles']['identity'] = 'another-owner'
        with self.assertRaises(module.Refused): module.prepare_target(plan(), adapter, storage, NOW)
        candidate = plan()
        candidate['generation'] = 'generation-2'
        with self.assertRaises(module.Refused): module.prepare_target(candidate, adapter, storage, NOW)

    def test_host_identity_mismatch_precedes_mutation(self):
        adapter, storage = Adapter(), MemoryStorage()
        adapter.machine_id = 'c' * 32
        with self.assertRaises(module.Refused): module.prepare_target(plan(), adapter, storage, NOW)
        self.assertEqual(adapter.calls, [])

    def test_private_storage_modes_and_secret_stability(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'private'
            store = module.PrivateStorage(root, owner_uid=os.getuid())
            store.save({'version': 1})
            store.ensure_secrets(['radar_migrator'])
            body = (root / 'secrets.json').read_bytes()
            store.ensure_secrets(['radar_migrator'])
            self.assertEqual(body, (root / 'secrets.json').read_bytes())
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((root / 'journal.json').stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((root / 'secrets.json').stat().st_mode), 0o600)

    def test_private_storage_rejects_symlink_and_unsafe_existing_root(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'unsafe'
            root.mkdir(mode=0o755)
            with self.assertRaises(module.Refused): module.PrivateStorage(root, owner_uid=os.getuid())
            link = Path(parent) / 'link'
            link.symlink_to(root)
            with self.assertRaises(module.Refused): module.PrivateStorage(link, owner_uid=os.getuid())

    def test_private_storage_does_not_adopt_unknown_existing_files(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'private'
            root.mkdir(mode=0o700)
            (root / 'unrelated.json').write_text('{}')
            with self.assertRaises(module.Refused): module.PrivateStorage(root, owner_uid=os.getuid())

    def test_acknowledged_secret_change_is_rejected_without_rotation(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            store = module.PrivateStorage(Path(parent) / 'private', owner_uid=os.getuid())
            candidate = plan()
            module.prepare_target(candidate, Adapter(), store, NOW)
            adapter = Adapter()
            adapter.receipts = copy.deepcopy(store.load()['acknowledged'])
            values = json.loads((store.path / 'secrets.json').read_text())
            values[candidate['migratorRole']] = 'z' * 43
            store.write('secrets.json', values, replace=True)
            with self.assertRaises(module.Refused): module.prepare_target(candidate, adapter, store, NOW)

class NativeRegressionTests(unittest.TestCase):
    def adapter(self):
        candidate = plan(); candidate['capacity'] = None
        adapter = object.__new__(module.NativeAdapter)
        adapter.p = module.validate_plan(candidate, NOW)
        adapter.deadline = float('inf')
        adapter.resource_guard = lambda: None
        adapter.config_ancestor_identity = lambda: adapter.p['plan']['configAncestors']
        adapter.assert_recovery_quiescence = lambda: None
        return adapter

    def test_unsafe_ancestor_is_rejected_before_creation_or_chmod(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            unsafe = Path(parent) / 'unsafe'; unsafe.mkdir(mode=0o777); unsafe.chmod(0o777)
            root = unsafe / 'private'
            with patch.object(module.os, 'fchmod', side_effect=AssertionError('no chmod')):
                with self.assertRaises(module.Refused): module.PrivateStorage(root, os.getuid())
            self.assertFalse(root.exists())

    def test_symlink_ancestor_never_creates_private_root(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            base = Path(parent); real = base / 'real'; real.mkdir(); (base / 'alias').symlink_to(real)
            with self.assertRaises(module.Refused): module.PrivateStorage(base / 'alias' / 'private', os.getuid())
            self.assertFalse((real / 'private').exists())

    def test_directory_replacement_rejects_all_private_operations(self):
        for operation in ('save', 'ensure_secrets', 'lock'):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
                root = Path(parent) / 'private'; store = module.PrivateStorage(root, os.getuid())
                root.rename(Path(parent) / 'original'); root.mkdir(mode=0o700)
                with self.assertRaises(module.Refused):
                    if operation == 'save': store.save({})
                    elif operation == 'ensure_secrets': store.ensure_secrets(['radar_migrator'])
                    else:
                        with store.lock(): pass
                self.assertEqual(list(root.iterdir()), [])
                store.close()

    def test_rename_race_never_writes_replacement_directory(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'private'; store = module.PrivateStorage(root, os.getuid())
            original_replace = os.replace
            def raced_replace(src, dst, **kwargs):
                root.rename(Path(parent) / 'original'); root.mkdir(mode=0o700)
                self.assertEqual(kwargs['src_dir_fd'], store.fd)
                self.assertEqual(kwargs['dst_dir_fd'], store.fd)
                original_replace(src, dst, **kwargs)
            with patch.object(module.os, 'replace', side_effect=raced_replace):
                with self.assertRaises(module.Refused): store.save({})
            self.assertEqual(list(root.iterdir()), [])
            store.close()

    def test_private_file_open_is_bound_to_prior_inode(self):
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'private'; store = module.PrivateStorage(root, os.getuid()); store.save({})
            original_open = os.open
            def raced_open(name, flags, *args, **kwargs):
                if name == 'journal.json':
                    (root / name).rename(root / 'old'); (root / name).write_text('{}'); (root / name).chmod(0o600)
                return original_open(name, flags, *args, **kwargs)
            with patch.object(module.os, 'open', side_effect=raced_open):
                with self.assertRaises(module.Refused): store.read('journal.json')
            store.close()

    def test_expired_budget_never_starts_process(self):
        adapter = self.adapter(); adapter.deadline = 0
        with patch.object(module.subprocess, 'Popen', side_effect=AssertionError('must not launch')):
            with self.assertRaises(module.Refused): adapter.command('psql', [])

    def test_budget_expiring_during_pins_never_starts_process(self):
        adapter = self.adapter()
        def pin(spec):
            adapter.deadline = 0
            return spec['path']
        adapter.pinned_file = pin
        with patch.object(module.subprocess, 'Popen', side_effect=AssertionError('must not launch')):
            with self.assertRaises(module.Refused): adapter.command('psql', [])

    def test_wrapper_uses_same_pin_pipeline_and_blocks_launch(self):
        adapter = self.adapter(); checked = []
        def pin(spec):
            checked.append(spec['path'])
            if spec['path'].endswith('/runuser'): raise module.Refused('tool_ancestor')
            return spec['path']
        adapter.pinned_file = pin
        with patch.object(module.subprocess, 'Popen', side_effect=AssertionError('must not launch')):
            with self.assertRaises(module.Refused): adapter.command('psql', [], postgres=True)
        self.assertEqual(checked, ['/usr/bin/psql', '/usr/bin/runuser'])

    def test_expired_configure_never_opens_mutation_fd(self):
        adapter = self.adapter(); adapter.deadline = 0
        with patch.object(module.os, 'open', side_effect=AssertionError('must not mutate')):
            with self.assertRaises(module.Refused): adapter.apply('configure', adapter.p)

    def test_ownership_stamp_rejects_uid_gid_mode_changes(self):
        from types import SimpleNamespace
        adapter = self.adapter()
        info = {'st_mode': stat.S_IFDIR | 0o700, 'st_uid': 0, 'st_gid': 0, 'st_nlink': 2, 'st_dev': 1, 'st_ino': 2}
        for key, value in (('st_uid', 1), ('st_gid', 1), ('st_mode', stat.S_IFDIR | 0o755)):
            with self.subTest(key=key), patch.object(module.Path, 'lstat', return_value=SimpleNamespace(**{**info, key: value})):
                with self.assertRaises(module.Refused): adapter.owned_stamp(Path('/candidate'), 'data', True)

    def rules(self, adapter):
        values = [('local', ['all'], ['postgres'], None, None, 'peer'), ('local', ['all'], ['all'], None, None, 'reject'),
            ('host', ['all'], ['all'], '127.0.0.1', '255.255.255.255', 'reject'),
            ('host', ['all'], ['all'], '::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'reject')]
        return [{'rule_number': i, 'line_number': i, 'file_name': adapter.p['plan']['target']['configDirectory'] + '/pg_hba.conf',
            'error': None, 'options': None, **dict(zip(('type', 'database', 'user_name', 'address', 'netmask', 'auth_method'), row))}
            for i, row in enumerate(values, 1)]

    def test_effective_hba_rejects_auth_errors_includes_and_extra_rules(self):
        adapter = self.adapter(); rules = self.rules(adapter)
        self.assertEqual(adapter.validate_hba_rules(rules), rules)
        for key, value in (('auth_method', 'trust'), ('error', 'parse error'), ('file_name', '/other'), ('options', ['map=foreign'])):
            altered = copy.deepcopy(rules); altered[0][key] = value
            with self.subTest(key=key), self.assertRaises(module.Refused): adapter.validate_hba_rules(altered)
        with self.assertRaises(module.Refused): adapter.validate_hba_rules(rules + [rules[0]])
        self.assertNotIn(b'trust', adapter.hba_configuration())

    def test_instance_overrides_collide_but_template_alone_does_not(self):
        adapter = self.adapter()
        with patch.object(module.Path, 'exists', side_effect=lambda path=None: False), patch.object(module.Path, 'is_symlink', return_value=False):
            self.assertFalse(adapter.instance_collisions())
        with patch.object(module.Path, 'exists', return_value=True):
            self.assertTrue(adapter.instance_collisions())

    def test_effective_startup_unit_is_pinned_not_assumed(self):
        adapter = self.adapter(); adapter.instance_collisions = lambda: False
        adapter.pinned_file = lambda spec: spec['path']
        unit = adapter.p['plan']['startupUnit']
        body = 'LoadState=loaded\nFragmentPath=' + unit['fragmentPath'] + '\nDropInPaths=\nExecStart=' + unit['execStart'] + '\nUser=\nGroup=\nEnvironmentFiles=\n'
        adapter.command = lambda *args, **kwargs: body.encode()
        self.assertEqual(adapter.startup_identity()['effective']['ExecStart'], module.static_exec_start(unit['execStart']))
        adapter.command = lambda *args, **kwargs: body.replace('/usr/bin/mock-start', '/usr/bin/unknown-command').encode()
        with self.assertRaises(module.Refused): adapter.startup_identity()

    def test_live_settings_include_actual_paths_and_all_resource_caps(self):
        adapter = self.adapter(); expected = adapter.live_expected()
        self.assertEqual(expected['data_directory'], adapter.p['plan']['target']['dataDirectory'])
        self.assertEqual(expected['listen_addresses'], '127.0.0.1')
        self.assertEqual(expected['max_connections'], '16')
        self.assertEqual(expected['shared_buffers'], str(8192 * 1024))
        self.assertEqual(set(expected), {'data_directory', 'config_file', 'hba_file', 'listen_addresses', 'unix_socket_directories',
            'max_connections', 'superuser_reserved_connections', 'reserved_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem', 'max_wal_size'})

    def test_startup_ack_ignores_only_process_time_and_result_fields(self):
        adapter = self.adapter(); adapter.instance_collisions = lambda: False; adapter.pinned_file = lambda spec: spec['path']
        unit = adapter.p['plan']['startupUnit']
        def observation(dynamic, static=None):
            value = (static or unit['execStart'])[:-1] + dynamic + ' }'
            return ('LoadState=loaded\nFragmentPath=' + unit['fragmentPath'] + '\nDropInPaths=\nExecStart=' + value + '\nUser=\nGroup=\nEnvironmentFiles=\n').encode()
        adapter.command = lambda *args, **kwargs: observation('start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 ;')
        before = adapter.startup_identity()
        adapter.command = lambda *args, **kwargs: observation('start_time=[Tue 2026-10-06 01:00:00 UTC] ; stop_time=[n/a] ; pid=123 ; code=exited ; status=0 ;')
        self.assertEqual(adapter.startup_identity(), before)
        for old, new in (('/usr/bin/mock-start', '/usr/bin/foreign-start'), ('--start', '--foreign'), ('ignore_errors=no', 'ignore_errors=yes')):
            adapter.command = lambda *args, old=old, new=new, **kwargs: observation('', unit['execStart'].replace(old, new))
            with self.subTest(new=new), self.assertRaises(module.Refused): adapter.startup_identity()
        with self.assertRaises(module.Refused): module.static_exec_start(unit['execStart'] + unit['execStart'])

    def test_new_config_0755_becomes_0700_without_owner_takeover(self):
        adapter = self.adapter()
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'config'; root.mkdir(mode=0o755); root.chmod(0o755)
            adapter.p['plan']['target']['configDirectory'] = str(root)
            adapter.p['plan']['ownership']['config'] = {'uid': os.getuid(), 'gid': os.getgid(), 'mode': 0o700}
            original_lstat = Path.lstat
            def protected_ancestors(path):
                info = original_lstat(path)
                if path != root:
                    from types import SimpleNamespace
                    return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
                return info
            before = root.stat()
            with patch.object(module.Path, 'lstat', autospec=True, side_effect=protected_ancestors): adapter.protect_created_config()
            after = root.stat()
            self.assertEqual((before.st_dev, before.st_ino, before.st_uid, before.st_gid), (after.st_dev, after.st_ino, after.st_uid, after.st_gid))
            self.assertEqual(stat.S_IMODE(after.st_mode), 0o700)

    def test_new_config_wrong_owner_or_mode_is_never_chmodded(self):
        from types import SimpleNamespace
        adapter = self.adapter()
        for uid, mode in ((1, 0o755), (0, 0o777)):
            with patch.object(module.Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid, st_gid=0)), patch.object(module.os, 'fchmod', side_effect=AssertionError('no ownership takeover')):
                with self.assertRaises(module.Refused): adapter.protect_created_config()

    def test_cluster_conversion_precedes_observed_ack(self):
        adapter = self.adapter(); calls = []
        adapter.command = lambda *args, **kwargs: calls.append('native-create')
        adapter.protect_created_config = lambda: calls.append('protect-config')
        adapter.observe = lambda _: (calls.append('observe') or {'stages': {'cluster': {'planSha256': adapter.p['planSha256']}}})
        adapter.apply('cluster', adapter.p)
        self.assertEqual(calls, ['native-create', 'protect-config', 'observe'])

    def test_missing_show_environment_requires_pinned_typed_empty_list(self):
        adapter = self.adapter(); adapter.instance_collisions = lambda: False
        unit = adapter.p['plan']['startupUnit']; calls = []
        adapter.pinned_file = lambda spec: spec['path']
        show = ('LoadState=loaded\nFragmentPath=' + unit['fragmentPath'] + '\nDropInPaths=\nExecStart=' + unit['execStart'] + '\nUser=\nGroup=\n').encode()
        def command(tool, arguments, **kwargs):
            calls.append((tool, arguments))
            if tool == 'systemctl': return show
            return b'{"type":"a(sb)","data":[]}\n'
        adapter.command = command
        self.assertEqual(adapter.startup_identity()['effective']['EnvironmentFiles'], '')
        self.assertEqual([tool for tool, _ in calls], ['systemctl', 'busctl'])
        self.assertIn('/org/freedesktop/systemd1/unit/postgresql_4016_2dradarproduction_2eservice', calls[1][1])
        self.assertEqual(calls[1][1][-2:], ['org.freedesktop.systemd1.Service', 'EnvironmentFiles'])
        self.assertIn('--json=short', calls[1][1])
        self.assertFalse(any(value in ('GetUnit', 'LoadUnit', 'RefUnit', 'UnrefUnit') for _, args in calls for value in args))

    def test_environment_fallback_rejects_wrong_type_nonempty_and_unknown_property(self):
        adapter = self.adapter(); adapter.instance_collisions = lambda: False; adapter.pinned_file = lambda spec: spec['path']
        unit = adapter.p['plan']['startupUnit']
        show = ('LoadState=loaded\nFragmentPath=' + unit['fragmentPath'] + '\nDropInPaths=\nExecStart=' + unit['execStart'] + '\nUser=\nGroup=\n').encode()
        for reply in (b'{"type":"as","data":[]}', b'{"type":"a(sb)","data":[["/unexpected",false]]}',
                b'{"type":"a(sb)"}', b'{"type":"a(sb)","data":[],"extra":true}', b'{"type":"a(sb)","data":null}'):
            def command(tool, arguments, **kwargs):
                if tool == 'systemctl': return show
                return reply
            adapter.command = command
            with self.subTest(reply=reply), self.assertRaises(module.Refused): adapter.startup_identity()
        adapter.command = lambda tool, arguments, **kwargs: show if tool == 'systemctl' else b's "wrong-type"'
        with self.assertRaises(module.Refused): adapter.startup_identity()

    def test_verified_empty_environment_does_not_adopt_missing_loadstate(self):
        adapter = self.adapter(); adapter.instance_collisions = lambda: False; adapter.pinned_file = lambda spec: spec['path']
        unit = adapter.p['plan']['startupUnit']
        show = ('FragmentPath=' + unit['fragmentPath'] + '\nDropInPaths=\nExecStart=' + unit['execStart'] + '\nUser=\nGroup=\n').encode()
        def command(tool, arguments, **kwargs):
            if tool == 'systemctl': return show
            return b'{"type":"a(sb)","data":[]}'
        adapter.command = command
        with self.assertRaises(module.Refused): adapter.startup_identity()

    def test_missing_busctl_pin_is_rejected_offline(self):
        candidate = plan(); del candidate['tools']['busctl']
        with self.assertRaises(module.Refused): module.validate_plan(candidate, NOW)

    def test_direct_property_failure_is_not_treated_as_empty_after_unit_gc(self):
        adapter = self.adapter(); adapter.instance_collisions = lambda: False; adapter.pinned_file = lambda spec: spec['path']
        unit = adapter.p['plan']['startupUnit']
        show = ('LoadState=loaded\nFragmentPath=' + unit['fragmentPath'] + '\nDropInPaths=\nExecStart=' + unit['execStart'] + '\nUser=\nGroup=\n').encode()
        def command(tool, arguments, **kwargs):
            if tool == 'systemctl': return show
            self.assertIn('get-property', arguments)
            self.assertNotIn('GetUnit', arguments)
            raise module.Refused('host_command_failed')
        adapter.command = command
        with self.assertRaisesRegex(module.Refused, 'host_command_failed'): adapter.startup_identity()

    def test_config_ancestor_pins_admit_only_exact_reviewed_postgres_directories(self):
        from types import SimpleNamespace
        adapter = self.adapter()
        del adapter.config_ancestor_identity
        pins = adapter.p['plan']['configAncestors']
        def info(path):
            pin = pins[str(path)]
            return SimpleNamespace(st_uid=pin['uid'], st_gid=pin['gid'], st_mode=stat.S_IFDIR | pin['mode'],
                st_dev=int(pin['device']), st_ino=int(pin['inode']))
        with patch.object(module.Path, 'lstat', autospec=True, side_effect=info):
            self.assertEqual(adapter.config_ancestor_identity(), pins)
        for field, replacement in (('st_uid', 111), ('st_gid', 115), ('st_mode', stat.S_IFDIR | 0o777),
                ('st_mode', stat.S_IFLNK | 0o755), ('st_dev', 9), ('st_ino', 99)):
            def changed(path):
                result = info(path)
                if str(path) == '/etc/postgresql': setattr(result, field, replacement)
                return result
            with self.subTest(field=field, replacement=replacement), patch.object(module.Path, 'lstat', autospec=True, side_effect=changed):
                with self.assertRaises(module.Refused): adapter.config_ancestor_identity()

    def test_config_ancestor_plan_requires_exact_paths_and_identity_fields(self):
        for failure in ('missing', 'extra', 'inode', 'writable'):
            candidate = plan()
            if failure == 'missing': del candidate['configAncestors']['/etc']
            if failure == 'extra': candidate['configAncestors']['/foreign'] = candidate['configAncestors']['/etc']
            if failure == 'inode': del candidate['configAncestors']['/etc']['inode']
            if failure == 'writable': candidate['configAncestors']['/etc']['mode'] = 0o777
            with self.subTest(failure=failure), self.assertRaises(module.Refused): module.validate_plan(candidate, NOW)

    def test_changed_config_ancestor_prevents_normalization_mutation(self):
        adapter = self.adapter()
        adapter.config_ancestor_identity = lambda: (_ for _ in ()).throw(module.Refused('config_ancestor_changed'))
        with patch.object(module.os, 'fchmod', side_effect=AssertionError('shared directory must not change')):
            with self.assertRaises(module.Refused): adapter.protect_created_config()

    def test_config_ancestor_arbitrary_owner_is_rejected(self):
        for uid, gid in ((111, 114), (110, 115), (0, 114)):
            candidate = plan(); candidate['configAncestors']['/etc/postgresql'].update(uid=uid, gid=gid)
            with self.subTest(uid=uid, gid=gid), self.assertRaises(module.Refused): module.validate_plan(candidate, NOW)

    def test_configure_uses_bound_fd_and_generated_spec_mode(self):
        from contextlib import contextmanager
        adapter = self.adapter()
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent) / 'config'; root.mkdir(mode=0o700)
            for name, mode in (('postgresql.conf', 0o644), ('pg_hba.conf', 0o640)):
                (root / name).write_bytes(b'initial\n'); (root / name).chmod(mode)
            for key, mode in (('mainConfig', 0o644), ('hba', 0o640), ('generatedConfig', 0o644)):
                adapter.p['plan']['ownership'][key] = {'uid': os.getuid(), 'gid': os.getgid(), 'mode': mode}
            @contextmanager
            def bound():
                fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try: yield fd, lambda: None
                finally: os.close(fd)
            adapter.bound_config_directory = bound
            adapter.observe = lambda _: {'stages': {'configure': {'planSha256': adapter.p['planSha256']}}}
            opened = []; original_open = os.open
            def tracked(name, flags, *args, **kwargs):
                if isinstance(name, str) and name.endswith('.conf'):
                    self.assertIn('dir_fd', kwargs); self.assertFalse(name.startswith('/')); opened.append(name)
                return original_open(name, flags, *args, **kwargs)
            with patch.object(module.os, 'open', side_effect=tracked): adapter.apply('configure', adapter.p)
            self.assertEqual(opened, ['address-radar-preparation.conf', 'pg_hba.conf', 'postgresql.conf'])
            self.assertEqual(stat.S_IMODE((root / opened[0]).stat().st_mode), 0o644)
            self.assertEqual((root / 'pg_hba.conf').read_bytes(), adapter.hba_configuration())

class RecoveryTests(unittest.TestCase):
    def fixture(self):
        candidate = plan(); candidate['capacity'] = None
        original = copy.deepcopy(candidate); original.pop('configAncestors')
        prepared = module.validate_plan(candidate, NOW)
        store = MemoryStorage()
        store.lock = lambda: module.nullcontext()
        store.has = lambda name: False
        old_sha = module.digest(module.encoded(original))
        store.journal = {'version': 1, 'operationId': original['operationId'], 'planSha256': old_sha,
            'machineId': original['machineId'], 'acknowledged': {}, 'pending': 'cluster',
            'secretsPrepared': False, 'secretIdentity': None}
        inventory = {'data': [{'path': '.', 'mode': 0o700, 'ctimeNs': '1'}],
            'config': [{'path': '.', 'mode': 0o755, 'ctimeNs': '1'}]}
        measured = {'inventory': inventory, 'systemIdentifier': '123', 'controlSha256': 'c' * 64}
        evidence = module.recovery_evidence_schema()
        evidence.update(originalPlanSha256=old_sha, currentPlanSha256=prepared['planSha256'],
            originalJournalSha256=module.digest(module.encoded(store.journal)), systemIdentifier='123',
            controlSha256='c' * 64, inventory=copy.deepcopy(inventory),
            inventoryLimits={'maximumEntries': 100, 'maximumBytes': '1000'})
        evidence['originalJournalIdentity'] = {'uid': 0, 'gid': 0, 'mode': 0o600, 'device': '1', 'inode': '2',
            'nlink': 1, 'size': '100', 'ctimeNs': '1'}
        store.identity = lambda name: {'uid': 0, 'gid': 0, 'mode': 0o600, 'device': '1', 'inode': '2',
            'nlink': 1, 'size': '100', 'ctimeNs': '1'}
        evidence['recoveryAuthority'] = {'kind': 'independently-authenticated-original-execution',
            'principal': 'mock-parent-verifier', 'approvalRef': 'mock-original-evidence'}
        for key in ('plan', 'source'):
            evidence['originalArtifacts'][key] = {'path': '/protected/' + key,
                'sha256': old_sha if key == 'plan' else module.ORIGINAL_RECOVERY_SOURCE_SHA256,
                'uid': 0, 'gid': 0, 'mode': 0o600, 'device': '1', 'inode': '2'}
        provenance = {'preflight': b'original-preflight-record', 'attempt': b'original-attempt-record'}
        for key in provenance: evidence['provenance'][key]['bytesSha256'] = module.digest(provenance[key])
        class RecoveryAdapter:
            def __init__(self): self.protected = False; self.calls = []; self.fail = False; self.changed = False
            def bind_recovery_source(self, path): self.source_path = path
            def read_recovery_artifact(self, pin):
                return module.encoded(original) if pin['path'].endswith('/plan') else b'original-source'
            def measure_recovery_target(self, limits):
                self.calls.append('measure')
                result = copy.deepcopy(measured)
                if self.changed: result['systemIdentifier'] = '999'
                if self.protected: result['inventory']['config'][0].update(mode=0o700, ctimeNs='2')
                return result
            def protect_created_config(self):
                self.calls.append('normalize')
                assert store.journal['pending'] == 'cluster-reconciliation'
                if self.fail: raise RuntimeError('private-host-detail')
                self.protected = True
            def observe(self, current):
                self.calls.append('observe')
                return {'machineId': original['machineId'], 'foreignObjects': False, 'portAvailable': True,
                    'stages': {'cluster': {'planSha256': current['planSha256'], 'systemIdentifier': '123'}}}
        return original, candidate, evidence, provenance, RecoveryAdapter(), store

    def test_explicit_recovery_authenticates_bytes_and_acknowledges_only_measured_cluster(self):
        args = self.fixture(); original, current, evidence, provenance, adapter, store = args
        contexts = []
        def verifier(bytes_by_kind, context):
            self.assertEqual(bytes_by_kind, provenance); contexts.append(context); return context
        result = module.recover_pending_cluster(original, current, evidence, provenance, verifier, adapter, store, NOW)
        self.assertEqual(result['status'], 'cluster_reconciled'); self.assertFalse(result['productionMigrationReady'])
        self.assertEqual(store.journal['pending'], None); self.assertEqual(set(store.journal['acknowledged']), {'cluster'})
        self.assertEqual(store.journal['planSha256'], evidence['currentPlanSha256'])
        self.assertEqual(store.journal['recovery']['binding'], contexts[0])
        self.assertEqual(adapter.calls, ['measure', 'measure', 'normalize', 'measure', 'observe'])

    def test_no_provenance_or_self_asserted_bool_cannot_mutate_pending(self):
        for response in (None, True, {}):
            original, current, evidence, provenance, adapter, store = self.fixture()
            with self.subTest(response=response), self.assertRaises(module.Refused):
                module.recover_pending_cluster(original, current, evidence, provenance, lambda *args: response, adapter, store, NOW)
            self.assertEqual(store.journal['pending'], 'cluster'); self.assertEqual(adapter.calls, [])

    def test_changed_plan_source_journal_target_or_provenance_refuses_without_normalization(self):
        for failure in ('plan', 'source', 'journal', 'journalIdentity', 'target', 'provenance'):
            original, current, evidence, provenance, adapter, store = self.fixture()
            if failure == 'plan': current['settings']['sharedBuffersKb'] += 1
            if failure == 'source': evidence['originalSourceSha256'] = 'f' * 64
            if failure == 'journal': store.journal['operationId'] = 'another'
            if failure == 'journalIdentity': evidence['originalJournalIdentity']['inode'] = '99'
            if failure == 'target': adapter.changed = True
            if failure == 'provenance': provenance['attempt'] = b'newly-minted-record'
            with self.subTest(failure=failure), self.assertRaises(module.Refused):
                module.recover_pending_cluster(original, current, evidence, provenance, lambda _, context: context, adapter, store, NOW)
            self.assertNotIn('normalize', adapter.calls)

    def test_interrupted_recovery_preserves_intent_and_never_replays(self):
        original, current, evidence, provenance, adapter, store = self.fixture(); adapter.fail = True
        with self.assertRaisesRegex(module.Refused, 'recovery_failed_preserved'):
            module.recover_pending_cluster(original, current, evidence, provenance, lambda _, context: context, adapter, store, NOW)
        self.assertEqual(store.journal['pending'], 'cluster-reconciliation')
        calls = list(adapter.calls)
        with self.assertRaises(module.Refused):
            module.recover_pending_cluster(original, current, evidence, provenance, lambda _, context: context, adapter, store, NOW)
        self.assertEqual(adapter.calls, calls)

    def test_success_cannot_be_replayed_with_old_evidence(self):
        args = self.fixture(); original, current, evidence, provenance, adapter, store = args
        module.recover_pending_cluster(original, current, evidence, provenance, lambda _, context: context, adapter, store, NOW)
        with self.assertRaises(module.Refused):
            module.recover_pending_cluster(original, current, evidence, provenance, lambda _, context: context, adapter, store, NOW)

    def test_native_inventory_measures_all_bytes_and_rejects_extras_types_and_budget(self):
        adapter = NativeRegressionTests().adapter()
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            data = Path(parent) / 'data'; config = Path(parent) / 'config'; data.mkdir(); config.mkdir()
            (data / 'PG_VERSION').write_bytes(b'16\n'); (data / 'base').mkdir(); (data / 'base' / 'relation').write_bytes(b'opaque-target-bytes')
            (data / 'global').mkdir(); (data / 'global' / 'pg_control').write_bytes(b'raw-pg-control-bytes')
            (config / 'postgresql.conf').write_bytes(b'initial-config')
            adapter.p['plan']['target']['dataDirectory'] = str(data)
            adapter.p['plan']['target']['configDirectory'] = str(config)
            adapter.command = lambda *args, **kwargs: b'Database system identifier: 123\nDatabase cluster state: shut down\n'
            limits = {'maximumEntries': 100, 'maximumBytes': '10000'}
            first = adapter.measure_recovery_target(limits)
            self.assertEqual(first['systemIdentifier'], '123')
            self.assertEqual(first['controlSha256'], module.digest(b'raw-pg-control-bytes'))
            self.assertNotEqual(first['controlSha256'], module.digest(b'Database system identifier: 123\nDatabase cluster state: shut down\n'))
            row = next(row for row in first['inventory']['data'] if row['path'] == 'base/relation')
            self.assertEqual(row['sha256'], module.digest(b'opaque-target-bytes'))
            self.assertEqual(row['inode'], str((data / 'base' / 'relation').stat().st_ino))
            with self.assertRaises(module.Refused): adapter.measure_recovery_target({'maximumEntries': 1, 'maximumBytes': '10000'})
            with self.assertRaises(module.Refused): adapter.measure_recovery_target({'maximumEntries': 100, 'maximumBytes': '1'})
            (data / 'postmaster.pid').write_bytes(b'123')
            with self.assertRaises(module.Refused): adapter.measure_recovery_target(limits)
            (data / 'postmaster.pid').unlink()
            (config / 'link').symlink_to(config / 'postgresql.conf')
            with self.assertRaises(module.Refused): adapter.measure_recovery_target(limits)

class OperatorRecoveryTests(unittest.TestCase):
    def fixture(self):
        original, current, evidence, transcripts, adapter, store = RecoveryTests().fixture()
        evidence['recoveryAuthority'] = {'kind': 'operator-reviewed-controller-transcript',
            'principal': 'mock-human-operator', 'approvalRef': 'mock-explicit-recovery-review'}
        review = module.operator_recovery_review_template(); review['evidence'] = evidence
        artifacts = {'/protected/plan': module.encoded(original), '/protected/source': b'original-source'}
        for key, body in transcripts.items():
            path = '/protected/controller-' + key
            artifacts[path] = body
            review['controllerTranscripts'][key] = {'path': path, 'sha256': module.digest(body),
                'uid': 0, 'gid': 0, 'mode': 0o600, 'device': '1', 'inode': '3'}
        body = module.encoded(review); artifacts['/protected/review'] = body
        pin = {'path': '/protected/review', 'sha256': module.digest(body), 'uid': 0, 'gid': 0,
            'mode': 0o600, 'device': '1', 'inode': '4'}
        adapter.read_recovery_artifact = lambda candidate: artifacts[candidate['path']]
        return current, review, pin, artifacts, adapter, store

    def test_operator_review_is_distinct_authority_and_digest_bound_not_historical_proof(self):
        current, review, pin, artifacts, adapter, store = self.fixture()
        result = module.execute_operator_recovery(current, pin, pin['sha256'], store, adapter, NOW)
        self.assertEqual(result['recoveryAuthorityKind'], 'operator-reviewed-controller-transcript')
        self.assertFalse(result['historicalDurableProofClaimed']); self.assertFalse(result['trustIssued'])
        self.assertEqual(store.journal['recovery']['operatorReviewSha256'], pin['sha256'])
        self.assertEqual(store.journal['pending'], None)

    def test_unapproved_or_unprotected_review_never_changes_pending(self):
        for failure in ('digest', 'owner', 'mode'):
            current, review, pin, artifacts, adapter, store = self.fixture()
            approved = pin['sha256']
            if failure == 'digest': approved = 'f' * 64
            if failure == 'owner': pin['uid'] = 110
            if failure == 'mode': pin['mode'] = 0o644
            with self.subTest(failure=failure), self.assertRaises(module.Refused):
                module.execute_operator_recovery(current, pin, approved, store, adapter, NOW)
            self.assertEqual(store.journal['pending'], 'cluster'); self.assertEqual(adapter.calls, [])

    def test_review_cannot_expand_scope_claim_history_or_ignore_unclosed_children(self):
        for failure in ('start', 'history', 'children', 'extra'):
            current, review, pin, artifacts, adapter, store = self.fixture()
            if failure == 'start': review['scope']['start'] = True
            if failure == 'history': review['historicalDurableProofClaimed'] = True
            if failure == 'children': review['reviewedObservations']['currentMutationProcessesAbsent'] = False
            if failure == 'extra': review['newAuthority'] = True
            artifacts[pin['path']] = module.encoded(review); pin['sha256'] = module.digest(artifacts[pin['path']])
            with self.subTest(failure=failure), self.assertRaises(module.Refused):
                module.execute_operator_recovery(current, pin, pin['sha256'], store, adapter, NOW)
            self.assertEqual(store.journal['pending'], 'cluster')

    def test_changed_controller_bytes_or_context_do_not_gain_ack(self):
        for failure in ('bytes', 'context'):
            current, review, pin, artifacts, adapter, store = self.fixture()
            if failure == 'bytes': artifacts['/protected/controller-attempt'] = b'replaced-record'
            if failure == 'context': review['evidence']['originalPlanSha256'] = 'e' * 64
            if failure == 'context':
                artifacts[pin['path']] = module.encoded(review); pin['sha256'] = module.digest(artifacts[pin['path']])
            with self.subTest(failure=failure), self.assertRaises(module.Refused):
                module.execute_operator_recovery(current, pin, pin['sha256'], store, adapter, NOW)
            self.assertNotIn('normalize', adapter.calls)

    def test_cli_recovery_requires_explicit_review_before_native_adapter_or_storage(self):
        candidate = plan(); candidate['capacity'] = None
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            path = Path(parent) / 'plan.json'; path.write_text(json.dumps(candidate))
            with patch.object(module.sys, 'argv', ['prepare', '--mode', 'recover-cluster', '--plan', str(path)]), \
                    patch.object(module, 'NativeAdapter', side_effect=AssertionError('no host')):
                with self.assertRaises(module.Refused): module.cli()

    def test_cli_runs_only_explicit_reviewed_recovery_not_regular_apply(self):
        current, review, pin, artifacts, adapter, store = self.fixture()
        adapter.resource_guard = lambda: None; adapter.remaining = lambda: 900
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            plan_path = Path(parent) / 'plan.json'; plan_path.write_text(json.dumps(current))
            pin_path = Path(parent) / 'review-pin.json'; pin_path.write_text(json.dumps(pin))
            argv = ['prepare', '--mode', 'recover-cluster', '--plan', str(plan_path), '--private-directory', '/protected/state',
                '--recovery-review-pin', str(pin_path), '--approved-recovery-review-sha256', pin['sha256']]
            with patch.object(module.sys, 'argv', argv), patch.object(module.time, 'time', return_value=NOW / 1000), \
                    patch.object(module, 'NativeAdapter', return_value=adapter), patch.object(module, 'secure_stat'), \
                    patch.object(module, 'PrivateStorage', return_value=store):
                result = module.cli()
            self.assertEqual(result['status'], 'cluster_reconciled')
            self.assertFalse(result['historicalDurableProofClaimed'])
            self.assertEqual(store.journal['recovery']['controllerTranscriptOrigin'], 'posthoc-controller-history-copy')
            self.assertNotIn('native-create', adapter.calls)

class RecoveryQuiescenceTests(unittest.TestCase):
    def test_native_process_measurement_rejects_mutators_and_unreadable_proc_without_argv_output(self):
        adapter = NativeRegressionTests().adapter()
        adapter.assert_recovery_quiescence = module.NativeAdapter.assert_recovery_quiescence.__get__(adapter)
        adapter.bind_recovery_source('/protected/original-prepare.py')
        # Synthetic /proc tree only; socket operations are mocked, never probe a host.
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            root = Path(parent); process = root / '12345'; process.mkdir()
            stat_body = b'12345 (mock) ' + b' '.join([b'S'] + [b'0'] * 18 + [b'77'])
            (process / 'stat').write_bytes(stat_body)
            original_read_bytes = Path.read_bytes; original_open = os.open
            def proc_read(path):
                return original_read_bytes(process / path.name) if str(path).startswith('/proc/12345/') else original_read_bytes(path)
            def proc_open(path, *args, **kwargs):
                return original_open(process / Path(path).name if str(path).startswith('/proc/12345/') else path, *args, **kwargs)
            with patch.object(module, 'bounded_entry_names', return_value=['12345']), \
                    patch.object(module.Path, 'read_bytes', autospec=True, side_effect=proc_read), \
                    patch.object(module.os, 'open', side_effect=proc_open), \
                    patch.object(module.socket, 'socket') as socket_mock:
                for body in (b'/usr/bin/perl\0/usr/bin/pg_createcluster\0', b'/usr/bin/initdb\0',
                        b'python3\0/protected/original-prepare.py\0', b'postgres\0-D\0/var/lib/postgresql/16/radarproduction\0'):
                    (process / 'cmdline').write_bytes(body)
                    with self.subTest(body=body), self.assertRaisesRegex(module.Refused, 'recovery_mutation_process_present'):
                        adapter.assert_recovery_quiescence()
                (process / 'cmdline').write_bytes(b'postgres: 16/radaracceptance checkpointer\0')
                adapter.assert_recovery_quiescence()
                with patch.object(module.os, 'open', side_effect=PermissionError('private argv must not leak')):
                    with self.assertRaisesRegex(module.Refused, 'recovery_process_visibility_unknown'): adapter.assert_recovery_quiescence()
                socket_mock.return_value.bind.side_effect = OSError('occupied')
                with self.assertRaisesRegex(module.Refused, 'recovery_target_listener_or_bind_unknown'): adapter.assert_recovery_quiescence()

class ActualOriginalPlanCompatibilityTests(unittest.TestCase):
    @unittest.skipUnless(Path('/private/tmp/address-radar-production-target-20261006-plan.json').is_file()
        and Path('/private/tmp/address-radar-production-target-20261006-recovery-plan.json').is_file(),
        'Operator-captured local plan fixtures are not portable repository fixtures')
    def test_actual_d70_original_and_current_plan_compatibility_before_mutation(self):
        original = module.strict_json(Path('/private/tmp/address-radar-production-target-20261006-plan.json').read_bytes())
        current = module.strict_json(Path('/private/tmp/address-radar-production-target-20261006-recovery-plan.json').read_bytes())
        self.assertNotIn('configAncestors', original)
        self.assertEqual(module.digest(module.encoded(original)), '5d468ae9c2acd2464814deeee28bf2d0ca9f91b1721c729cae91d82996311385')
        prepared = module.validate_plan(current, NOW)
        self.assertEqual(prepared['planSha256'], 'b8e9bd6ec46723e0eeb45915c12c86d61168d24569c934bce70039bafe2e0b46')
        without_additive_field = copy.deepcopy(prepared['plan']); without_additive_field.pop('configAncestors')
        self.assertEqual(without_additive_field, original)
        # Exercise the recovery API with actual plan inputs and synthetic measurement ports.
        _, _, evidence, provenance, adapter, store = RecoveryTests().fixture()
        old_sha = module.digest(module.encoded(original))
        store.journal.update(operationId=original['operationId'], machineId=original['machineId'], planSha256=old_sha)
        evidence.update(originalPlanSha256=old_sha, currentPlanSha256=prepared['planSha256'],
            originalJournalSha256=module.digest(module.encoded(store.journal)))
        evidence['originalArtifacts']['plan']['sha256'] = old_sha
        adapter.read_recovery_artifact = lambda pin: module.encoded(original) if pin['path'].endswith('/plan') else b'original-source'
        adapter.observe = lambda _: {'machineId': original['machineId'], 'foreignObjects': False, 'portAvailable': True,
            'stages': {'cluster': {'planSha256': prepared['planSha256'], 'systemIdentifier': '123'}}}
        result = module.recover_pending_cluster(original, current, evidence, provenance, lambda _, context: context, adapter, store, NOW)
        self.assertEqual(result['status'], 'cluster_reconciled')
        self.assertEqual(store.journal['planSha256'], prepared['planSha256'])

class RecoveryBoundedReadTests(unittest.TestCase):
    def test_incremental_enumeration_rejects_before_unbounded_collect_or_sort(self):
        from types import SimpleNamespace
        observed = []
        def entries():
            for index in range(100000):
                observed.append(index); yield SimpleNamespace(name=str(index))
        with patch.object(module.os, 'scandir') as scanner:
            scanner.return_value.__enter__.return_value = entries()
            with self.assertRaises(module.Refused): module.bounded_entry_names('mock', 2, lambda: None)
        self.assertEqual(observed, [0, 1, 2])

    def test_proc_collection_and_rescan_share_incremental_limit_and_deadline(self):
        from types import SimpleNamespace
        with patch.object(module.os, 'scandir') as scanner:
            scanner.return_value.__enter__.return_value = iter([SimpleNamespace(name='a'), SimpleNamespace(name='123'), SimpleNamespace(name='124')])
            with self.assertRaisesRegex(module.Refused, 'recovery_process_budget'):
                module.bounded_entry_names('/proc', 1, lambda: None, decimal_only=True)
        with patch.object(module.os, 'scandir') as scanner:
            scanner.return_value.__enter__.return_value = iter([SimpleNamespace(name='unexpected-extra')])
            with self.assertRaises(module.Refused): module.bounded_entry_names('mock-rescan', 0, lambda: None)
        calls = []
        def expired():
            calls.append(1)
            if len(calls) == 2: raise module.Refused('operation_deadline')
        with patch.object(module.os, 'scandir') as scanner:
            scanner.return_value.__enter__.return_value = iter([SimpleNamespace(name='one'), SimpleNamespace(name='two')])
            with self.assertRaisesRegex(module.Refused, 'operation_deadline'): module.bounded_entry_names('mock', 10, expired)
        self.assertEqual(len(calls), 2)

    def test_native_scan_refuses_depth_beyond_fixed_cap(self):
        adapter = NativeRegressionTests().adapter()
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            data = Path(parent) / 'data'; config = Path(parent) / 'config'; data.mkdir(); config.mkdir()
            (data / 'PG_VERSION').write_bytes(b'16\n'); directory = data
            for index in range(module.RECOVERY_MAXIMUM_DIRECTORY_DEPTH + 1):
                directory = directory / ('d' + str(index)); directory.mkdir()
            adapter.p['plan']['target'].update(dataDirectory=str(data), configDirectory=str(config))
            adapter.command = lambda *args, **kwargs: b'Database system identifier: 123\nDatabase cluster state: shut down\n'
            with self.assertRaisesRegex(module.Refused, 'recovery_inventory_depth'):
                adapter.measure_recovery_target({'maximumEntries': 1000, 'maximumBytes': '100000'})

    def test_oversized_artifact_never_reads_hashes_or_opens_contents(self):
        from types import SimpleNamespace
        adapter = NativeRegressionTests().adapter()
        pin = {'path': '/protected/artifact', 'sha256': 'a' * 64, 'uid': 0, 'gid': 0, 'mode': 0o600, 'device': '1', 'inode': '2'}
        def info(path):
            if str(path) == '/protected/artifact':
                return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_dev=1, st_ino=2,
                    st_size=1024 ** 2 + 1, st_nlink=1, st_mtime_ns=1, st_ctime_ns=1)
            return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
        with patch.object(module.Path, 'lstat', autospec=True, side_effect=info), \
                patch.object(module.Path, 'read_bytes', side_effect=AssertionError('unbounded read forbidden')), \
                patch.object(module.os, 'open', side_effect=AssertionError('contents must not open')), \
                patch.object(adapter, 'pinned_file', side_effect=AssertionError('unbounded pin hash forbidden')):
            with self.assertRaises(module.Refused): adapter.read_recovery_artifact(pin)

    def test_artifact_hash_uses_bound_fd_bounded_reads_and_detects_replacement(self):
        from types import SimpleNamespace
        adapter = NativeRegressionTests().adapter()
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            path = Path(parent) / 'artifact'; body = b'actual-bounded-artifact'; path.write_bytes(body); path.chmod(0o600)
            real = path.stat()
            def snapshot(inode=None):
                return SimpleNamespace(st_mode=real.st_mode, st_uid=0, st_gid=0, st_dev=real.st_dev,
                    st_ino=real.st_ino if inode is None else inode, st_nlink=1, st_size=real.st_size,
                    st_mtime_ns=real.st_mtime_ns, st_ctime_ns=real.st_ctime_ns)
            pin = {'path': str(path), 'sha256': module.digest(body), 'uid': 0, 'gid': 0, 'mode': 0o600,
                'device': str(real.st_dev), 'inode': str(real.st_ino)}
            def info(target): return snapshot() if target == path else SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            with patch.object(module.Path, 'lstat', autospec=True, side_effect=info), \
                    patch.object(module.os, 'fstat', return_value=snapshot()), \
                    patch.object(adapter, 'pinned_file', side_effect=AssertionError('no pre-read hash')):
                self.assertEqual(adapter.read_recovery_artifact(pin), body)
            with patch.object(module.Path, 'lstat', autospec=True, side_effect=info), patch.object(module.os, 'fstat', return_value=snapshot(real.st_ino + 1)):
                with self.assertRaises(module.Refused): adapter.read_recovery_artifact(pin)

class RecoveryControlHashTests(unittest.TestCase):
    def test_control_hash_is_unique_regular_inventory_file_not_native_stdout(self):
        adapter = NativeRegressionTests().adapter()
        with tempfile.TemporaryDirectory(dir=TEMP_PARENT) as parent:
            data = Path(parent) / 'data'; config = Path(parent) / 'config'; data.mkdir(); config.mkdir()
            (data / 'PG_VERSION').write_bytes(b'16\n'); (data / 'global').mkdir()
            adapter.p['plan']['target'].update(dataDirectory=str(data), configDirectory=str(config))
            stdout = b'Database system identifier: 7693392208475083526\nDatabase cluster state: shut down\n'
            adapter.command = lambda *args, **kwargs: stdout
            limits = {'maximumEntries': 100, 'maximumBytes': '100000'}
            with self.assertRaisesRegex(module.Refused, 'recovery_control_file'): adapter.measure_recovery_target(limits)
            raw = b'\x00\x10\xff' + b'raw control page' + bytes(8192 - 19)
            (data / 'global' / 'pg_control').write_bytes(raw)
            measured = adapter.measure_recovery_target(limits)
            self.assertEqual(measured['controlSha256'], module.digest(raw))
            self.assertNotEqual(measured['controlSha256'], module.digest(stdout))
            self.assertEqual(measured['systemIdentifier'], '7693392208475083526')
            row = next(row for row in measured['inventory']['data'] if row['path'] == 'global/pg_control')
            self.assertEqual(row['kind'], 'file'); self.assertEqual(row['sha256'], measured['controlSha256'])
            adapter.command = lambda *args, **kwargs: stdout.replace(b'shut down', b'in production')
            with self.assertRaisesRegex(module.Refused, 'recovery_control_identity'): adapter.measure_recovery_target(limits)
            adapter.command = lambda *args, **kwargs: stdout
            (data / 'global' / 'pg_control').unlink(); (data / 'global' / 'pg_control').mkdir()
            with self.assertRaisesRegex(module.Refused, 'recovery_control_file'): adapter.measure_recovery_target(limits)

if __name__ == '__main__':
    unittest.main()
