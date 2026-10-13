import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from contextlib import nullcontext
from unittest.mock import patch

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location('activation', Path(__file__).parents[1] / 'activate-production-postgres-migrator.py')
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)
SERVICES = ('scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console')
NOW = 1791250000000
INITIAL = b'local all postgres peer\nlocal all all reject\nhost all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n'

def pin(path, digest='a' * 64, uid=0, gid=0, mode=0o600):
    return {'path': path, 'sha256': digest, 'uid': uid, 'gid': gid, 'mode': mode, 'device': '1', 'inode': '2'}

def fixture():
    p = {'database': 'address_radar', 'schema': 'radar_business', 'generation': 'g1', 'migratorRole': 'radar_migrator',
        'serviceRoles': {s: 'radar_' + s.replace('-', '_') for s in SERVICES},
        'resources': {'migrationConnections': 1, 'pools': {s: {'instances': 1, 'maximumConnections': 1} for s in SERVICES}},
        'ownership': {'hba': {'uid': 110, 'gid': 114, 'mode': 0o640}},
        'target': {'host': '127.0.0.1', 'port': 5432, 'dataDirectory': '/var/lib/postgresql/16/radarproduction',
            'configDirectory': '/etc/postgresql/16/radarproduction'}, 'machineId': 'a' * 32, 'stageTimeoutSeconds': 180,
        'tools': {'psql': {'path': '/usr/bin/psql', 'sha256': 'b' * 64}}}
    roles = [p['migratorRole'], *p['serviceRoles'].values()]
    module = types.SimpleNamespace(SERVICES=SERVICES, reference=lambda v: m.demand(type(v) is str and bool(v), 'reference'),
        NativeAdapter=types.SimpleNamespace(hba_configuration=lambda: INITIAL), quote=lambda n: '"' + n + '"')
    module.validate_plan = lambda plan, now: {'plan': copy.deepcopy(plan), 'planSha256': m.sha(m.encoded(plan)), 'roles': roles,
        'databaseConnectionLimit': 9}
    plan = {'version': 1, 'operationId': 'activate-1', 'approvalRef': 'approved-migration-only',
        'provisioningModule': pin('/protected/prepare.py', m.PROVISIONING_SHA256, mode=0o500),
        'provisioningPlan': p, 'provisioningPlanSha256': m.sha(m.encoded(p)),
        'targetPins': {'systemIdentifier': '123', 'databaseOid': '200', 'roleOids': {role: str(100 + i) for i, role in enumerate(roles)}},
        'secretPin': pin('/protected/secrets.json'),
        'initialHbaPin': pin('/etc/postgresql/16/radarproduction/pg_hba.conf', m.sha(INITIAL), 110, 114, 0o640),
        'credentialValidUntilMs': NOW + 3600000, 'invocationTimeoutSeconds': 180}
    prepared = m.validate_plan(plan, module, NOW)
    credential = {'version': 1, 'purpose': 'production-migrator-private-connection', 'operationId': plan['operationId'],
        'planSha256': prepared['planSha256'], 'host': '127.0.0.1', 'port': 5432, 'database': p['database'],
        'user': p['migratorRole'], 'password': 'x' * 43, 'scramVerifier': m.scram_verifier('x' * 43, bytes(range(16))),
        'expiresAtMs': plan['credentialValidUntilMs'], 'schema': p['schema'], 'generation': p['generation'], 'targetPins': plan['targetPins']}
    return prepared, module, credential

class Store:
    def __init__(self): self.journal = None; self.files = {}; self.saves = []
    def lock(self): return nullcontext()
    def load(self): return copy.deepcopy(self.journal)
    def save(self, value): self.journal = copy.deepcopy(value); self.saves.append(copy.deepcopy(value))
    def has(self, name): return name in self.files
    def write(self, name, value): m.demand(name not in self.files, 'exists'); self.files[name] = copy.deepcopy(value)
    def read(self, name): return copy.deepcopy(self.files[name])

class Adapter:
    def __init__(self, credential, store): self.credential = credential; self.store = store; self.receipts = {}; self.calls = []; self.fail = None; self.commit = True
    def guard(self): pass
    def make_credential(self): return copy.deepcopy(self.credential)
    def observe(self, credential): return {'phase': 'initial' if not self.receipts else 'active', 'receipts': copy.deepcopy(self.receipts)}
    def apply(self, stage, credential):
        self.calls.append(stage); assert self.store.journal['pending'] == stage
        if self.fail == stage and not self.commit: raise RuntimeError('sensitive-password-or-verifier')
        self.receipts[stage] = {'native': stage}
        if self.fail == stage: raise RuntimeError('unknown COMMIT')

class ActivationTests(unittest.TestCase):
    def test_success_is_not_business_activation_and_noop_rerun_preserves_secret(self):
        prepared, _, credential = fixture(); store = Store(); adapter = Adapter(credential, store)
        result = m.activate(prepared, adapter, store)
        self.assertEqual(adapter.calls, ['role', 'hba']); self.assertFalse(result['businessActivation']); self.assertFalse(result['fullCapacityProved'])
        self.assertNotIn(credential['password'], json.dumps(result)); self.assertNotIn(credential['scramVerifier'], json.dumps(store.journal))
        m.activate(prepared, adapter, store); self.assertEqual(adapter.calls, ['role', 'hba'])

    def test_lost_commit_ack_reconciles_native_effect_not_blind_write(self):
        prepared, _, credential = fixture(); store = Store(); adapter = Adapter(credential, store); adapter.fail = 'role'
        m.activate(prepared, adapter, store)
        self.assertEqual(adapter.calls.count('role'), 1)
        self.assertTrue(any(s.get('lastOutcome') == 'reconciled' for s in store.saves))

    def test_uncommitted_unknown_preserves_pending_and_explicit_reconcile_does_not_mutate(self):
        prepared, _, credential = fixture(); store = Store(); adapter = Adapter(credential, store); adapter.fail = 'role'; adapter.commit = False
        with self.assertRaisesRegex(m.Refused, 'authentication_failed_preserved'): m.activate(prepared, adapter, store)
        self.assertEqual(store.journal['pending'], 'role')
        with self.assertRaises(m.Refused): m.activate(prepared, adapter, store)
        with self.assertRaises(m.Refused): m.activate(prepared, adapter, store, 'reconcile')
        self.assertEqual(adapter.calls, ['role'])
        adapter.receipts['role'] = {'native': 'role'}
        self.assertEqual(m.activate(prepared, adapter, store, 'reconcile')['status'], 'stage_reconciled')
        self.assertEqual(adapter.calls, ['role'])

    def test_hba_failure_preserves_role_ack_and_no_automatic_reload(self):
        prepared, _, credential = fixture(); store = Store(); adapter = Adapter(credential, store); adapter.fail = 'hba'; adapter.commit = False
        with self.assertRaises(m.Refused): m.activate(prepared, adapter, store)
        self.assertEqual(store.journal['pending'], 'hba'); self.assertEqual(set(store.journal['acknowledged']), {'role'})
        with self.assertRaises(m.Refused): m.activate(prepared, adapter, store, 'reconcile')
        self.assertEqual(adapter.calls, ['role', 'hba'])

    def test_changed_credentials_and_journal_refused(self):
        for change in ('password', 'verifier', 'journal'):
            prepared, _, credential = fixture(); store = Store(); adapter = Adapter(credential, store); m.activate(prepared, adapter, store)
            if change == 'password': store.files['secrets.json']['password'] = 'y' * 43
            if change == 'verifier': store.files['secrets.json']['scramVerifier'] = 'SCRAM-foreign'
            if change == 'journal': store.journal['planSha256'] = 'f' * 64
            with self.subTest(change=change), self.assertRaises(m.Refused): m.activate(prepared, adapter, store)

    def test_resource_refusal_precedes_any_private_or_database_mutation(self):
        prepared, _, credential = fixture(); store = Store(); adapter = Adapter(credential, store)
        adapter.guard = lambda: (_ for _ in ()).throw(m.Refused('empty_target_memory_guard'))
        with self.assertRaises(m.Refused): m.activate(prepared, adapter, store)
        self.assertIsNone(store.journal); self.assertEqual(adapter.calls, [])

    def test_explicit_resources_expiry_source_and_hba_scope(self):
        prepared, module, _ = fixture()
        for change in ('source', 'hba', 'pool', 'expiry', 'budget', 'oid'):
            plan = copy.deepcopy(prepared['plan'])
            if change == 'source': plan['provisioningModule']['sha256'] = 'f' * 64
            if change == 'hba': plan['initialHbaPin']['sha256'] = 'f' * 64
            if change == 'pool': plan['provisioningPlan']['resources']['migrationConnections'] = 2
            if change == 'expiry': plan['credentialValidUntilMs'] = NOW
            if change == 'budget': plan['invocationTimeoutSeconds'] = 900
            if change == 'oid': plan['targetPins']['roleOids']['radar_migrator'] = '99999999999'
            with self.subTest(change=change), self.assertRaises(m.Refused): m.validate_plan(plan, module, NOW)

    def test_scram_matches_independent_stored_and_server_key_derivation(self):
        password = 'x' * 43; salt = bytes(range(16)); verifier = m.scram_verifier(password, salt)
        salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
        import hmac
        b64 = lambda b: base64.b64encode(b).decode()
        self.assertEqual(verifier, 'SCRAM-SHA-256$4096:' + b64(salt) + '$' +
            b64(hashlib.sha256(hmac.new(salted, b'Client Key', hashlib.sha256).digest()).digest()) + ':' +
            b64(hmac.new(salted, b'Server Key', hashlib.sha256).digest()))

    def test_native_role_sql_is_only_migrator_login_limit1_scram_stdin_and_expiry(self):
        prepared, module, credential = fixture(); native = object.__new__(m.NativeAdapter)
        native.prepared = prepared; native.plan = prepared['plan']; native.p = prepared['provisioning']['plan']; native.module = module
        native.guard = lambda: None; calls = []; native.sql = lambda text: calls.append(text)
        native.apply('role', credential)
        self.assertEqual(len(calls), 1); self.assertIn('ALTER ROLE "radar_migrator" LOGIN CONNECTION LIMIT 1', calls[0])
        self.assertIn('VALID UNTIL', calls[0]); self.assertNotIn(credential['password'], calls[0]); self.assertIn(credential['scramVerifier'], calls[0])
        for name in native.p['serviceRoles'].values(): self.assertNotIn('ALTER ROLE "' + name + '"', calls[0])

    def test_native_hba_exact_scope_and_no_wildcard_authentication(self):
        prepared, _, _ = fixture(); native = object.__new__(m.NativeAdapter); native.p = prepared['provisioning']['plan']
        self.assertEqual(native.hba().decode().splitlines(), ['local all postgres peer', 'local all all reject',
            'host address_radar radar_migrator 127.0.0.1/32 scram-sha-256', 'host all all 127.0.0.1/32 reject', 'host all all ::1/128 reject'])

    def test_oversized_private_pin_refuses_before_content_open(self):
        value = pin('/protected/file')
        directory = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_dev=1, st_ino=1)
        file = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_dev=1, st_ino=2, st_nlink=1, st_size=65537)
        calls = []
        def opening(name, flags, **kwargs): calls.append(name); return len(calls)
        with patch.object(m.os, 'open', side_effect=opening), patch.object(m.os, 'close'), \
                patch.object(m.os, 'fstat', return_value=directory), \
                patch.object(m.os, 'stat', side_effect=lambda name, **kwargs: file if name == 'file' else directory), \
                patch.object(m.os, 'read', side_effect=AssertionError('no read')):
            with self.assertRaises(m.Refused): m.read_root_pin(value, 65536)
        self.assertNotIn('file', calls)

if __name__ == '__main__': unittest.main()
