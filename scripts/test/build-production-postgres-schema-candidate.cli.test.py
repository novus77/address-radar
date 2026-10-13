"""Mock native boundaries; never production execution or freeze attestation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / 'build-production-postgres-schema-candidate.py'
spec = importlib.util.spec_from_file_location('candidate_cli', path)
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)


def encoded(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class CandidateCliTests(unittest.TestCase):
    def execute(self, *, pending=None, change_epoch=False, change_pin=False, wrong_database=False, recovery_mode=False, recovery_failure=False):
        root = '/reviewed'
        original = {'database': 'address_radar', 'schema': 'reviewed_business_namespace',
                    'generation': 'reviewed-original-generation', 'migratorRole': 'address_radar_migrator'}
        original_sha = hashlib.sha256(encoded(original)).hexdigest()
        original.update()
        source_pin = {'path': '/reviewed/prepare.py', 'sha256': '4' * 64}
        plan = {'operationId': 'actual-auth-operation', 'provisioningPlan': original,
                'provisioningPlanSha256': original_sha, 'provisioningModule': source_pin,
                'targetPins': {'systemIdentifier': '7693392208475083526', 'databaseOid': '16391',
                              'roleOids': {'address_radar_migrator': '16384'}}}
        plan_sha = hashlib.sha256(encoded(plan)).hexdigest()
        credential = {'password': 'SECRET_DO_NOT_LOG', 'scramVerifier': 'SECRET_SCRAM', 'expiresAtMs': 1791281600123}
        receipts = {'role': {'postmasterStart': 'actual-epoch'}, 'hba': {'hbaSha256': 'h' * 64}}
        journal = {'version': 1, 'operationId': plan['operationId'], 'planSha256': plan_sha,
                   'credentialSha256': hashlib.sha256(encoded(credential)).hexdigest(), 'pending': pending,
                   'acknowledged': {'role': dict(receipts['role']), 'hba': {**receipts['hba'], 'tcp': {'start': 'actual-epoch'}}}}
        schema_plan = {'version': 1, 'fingerprint': builder.SCHEMA_FINGERPRINT, 'migrations': []}
        receipt = {'inventorySha256': builder.RELEASE_INVENTORY_SHA256, 'entries': 306,
                   'bytes': 1016989, 'schemaPlan': schema_plan}
        bodies = {'/reviewed/original.json': encoded(original), '/reviewed/auth-plan.json': encoded(plan),
                  '/reviewed/auth-state/journal.json': encoded(journal), '/reviewed/auth-state/secrets.json': encoded(credential),
                  '/reviewed/receipt.json': encoded(receipt)}
        fixed = {'/reviewed/helper.py': builder.PIN_HELPER_SHA256, '/reviewed/auth.py': builder.AUTH_SOURCE_SHA256,
                 '/reviewed/schema.mjs': builder.SCHEMA_ENTRY_SHA256, '/reviewed/prepare.py': '4' * 64,
                 '/reviewed/receipt.json': '63c0e45783f9c3670cd83f62981ad62d7b935a00547bab317250f16130311ab0',
                 '/usr/bin/python3.12': '359ca926ba4596147d7d558c1e0cbf6a5784f5475d7e8bf0a55d9d7c4fa7106c'}
        fixed.update({'/reviewed/recovery-proof.json':'e'*64,
            '/reviewed/eac.py':'eac155c618a5c7854744917cf2fa1b46949e063cbd842711c28aff4da1fd77ff',
            '/reviewed/revalidator.py':'11fa16d2aa49da8cf55cb8c791421b24745f6cbebd8db18224cc7eca5b849e51',
            '/reviewed/consumer.py':'0b8edb0c600920cd7ec42c1b42d95ae979c429a6fbdd43281708034f82a588f7'})
        calls = []; writes = []; reads = {}; observations = []
        def file_pin(path, maximum, remaining, keep=True, mode=None):
            remaining(); reads[path] = reads.get(path, 0) + 1
            if path == builder.REVIEWED_NODE['path']: return dict(builder.REVIEWED_NODE), None
            body = bodies.get(path, b'fixture-source')
            pin = {'path': path, 'uid': 0, 'gid': 0, 'mode': mode or 320, 'device': '64769',
                   'inode': '2012' if path == '/usr/bin/python3.12' else '100',
                   'sha256': fixed.get(path, hashlib.sha256(body).hexdigest())}
            if change_pin and path.endswith('journal.json') and reads[path] > 1: pin['inode'] = '101'
            return pin, body if keep else None
        class Base:
            deadline = float('inf')
            def sql(self, text, database='postgres'):
                calls.append(('sql', database))
                return encoded({'database': 'postgres' if wrong_database else database,
                                'namespaceCount': 0, 'serverTimeMs': '1791260000123'})
        class Adapter:
            def __init__(self, *args): self.base = Base()
            def guard(self): calls.append('guard')
            def observe(self, value, verify_tcp=True):
                self_test.assertFalse(verify_tcp)
                observations.append(1)
                result = json.loads(json.dumps(receipts))
                if change_epoch and len(observations) > 1: result['role']['postmasterStart'] = 'changed'
                return {'receipts': result}
        self_test = self
        class Child:
            def __init__(self, argv, remaining, **kwargs): self.process = self; self.returncode = 0
            def communicate(self, body, timeout):
                self_test.assertNotIn(b'SECRET_DO_NOT_LOG', body)
                self_test.assertNotIn(b'SECRET_SCRAM', body)
                value, _ = json.JSONDecoder().raw_decode(body.decode().split('const c=', 1)[1])
                return encoded({'inventorySha256': builder.RELEASE_INVENTORY_SHA256, 'entries': 306, 'bytes': 1016989,
                                'schemaPlan': schema_plan, 'candidateSha256': hashlib.sha256(encoded(value)).hexdigest()}), b''
            def close(self): calls.append('child-closed')
        auth = types.SimpleNamespace(PROVISIONING_SHA256='4' * 64, load_provisioning=lambda pin: object(),
            validate_plan=lambda p, m, n: {'plan': p, 'planSha256': plan_sha},
            validate_credential=lambda c, p: None, NativeAdapter=Adapter, OwnedPsqlChild=Child)
        def consume(*args):
            observations.append(1);calls.append('fresh-full-consumer')
            return {'status':'recovery_native_verification_refused' if recovery_failure else 'recovery_current_native_verified',
                'tcpAuthenticationChecked':True,'planSha256':plan_sha,'recoveryRecordFileSha256':'e'*64,
                'boundary':{'systemIdentifier':'7693392208475083526','databaseOid':'16391','roleOid':'16384','postmasterStart':'actual-epoch'}}
        recovery_consumer=types.SimpleNamespace(consume=consume)
        helper = types.SimpleNamespace(file_pin=file_pin, require_original_pin=lambda *a: None,
            PROVISIONING_PLAN_SHA256=original_sha, strict_json=json.loads, encoded=encoded,
            load_module=lambda *a: recovery_consumer if a[2]=='reviewed_schema_recovery_consumer' else auth, parent_fd=lambda *a: (999, []),
            check_bindings=lambda *a: None, close_parent=lambda *a: None,
            write_once=lambda path, body, remaining: writes.append(json.loads(body)))
        argv = ['builder', '--pin-helper', '/reviewed/helper.py', '--activation-source', '/reviewed/auth.py',
                '--activation-plan', '/reviewed/auth-plan.json', '--authentication-state-directory', '/reviewed/auth-state',
                '--original-provisioning-plan', '/reviewed/original.json', '--compiled-release', '/reviewed/release',
                '--build-receipt', '/reviewed/receipt.json', '--schema-entry', '/reviewed/schema.mjs',
                '--node', builder.REVIEWED_NODE['path'], '--python', '/usr/bin/python3.12',
                '--operation-id', 'schema-operation', '--approval-ref', 'authorized-controller', '--output', '/reviewed/candidate.json',
                '--schema-state-directory', '/reviewed/schema-state', '--invocation-timeout-ms', '180000',
                '--statement-timeout-ms', '30000', '--lock-timeout-ms', '5000', '--maximum-entries', '4096', '--maximum-bytes', '134217728']
        if recovery_mode:
            argv += ['--authentication-recovery-mode','known-pending-hba','--recovery-proof','/reviewed/recovery-proof.json',
                     '--recovery-record-file-sha256','e'*64,'--recovery-producer','/reviewed/eac.py',
                     '--recovery-revalidator','/reviewed/revalidator.py','--recovery-consumer','/reviewed/consumer.py']
        with patch.object(builder, 'bounded_communicate', side_effect=lambda process,body,timeout,maximum: process.communicate(body,timeout)), patch.object(sys, 'argv', argv), patch.object(sys, 'platform', 'linux'), \
             patch('os.geteuid', return_value=0), patch('os.fstat', return_value=types.SimpleNamespace(st_uid=0, st_gid=0, st_mode=0o40700)), \
             patch('os.stat', side_effect=FileNotFoundError), patch.object(builder, 'bootstrap_helper', return_value=helper):
            if (pending and not recovery_mode) or change_epoch or change_pin or wrong_database or recovery_failure:
                with self.assertRaises(builder.Refused): builder.cli()
                self.assertEqual(writes, [])
            else:
                result = builder.cli(); self.assertEqual(result['status'], 'schema_candidate_created')
                self.assertEqual(len(writes), 1); candidate = writes[0]
                self.assertEqual(candidate['target']['schema'], original['schema'])
                self.assertEqual(candidate['target']['generation'], original['generation'])
                self.assertEqual(candidate['credential']['path'], '/reviewed/auth-state/secrets.json')
                self.assertEqual(candidate['targetPins']['roleOid'], '16384')
                self.assertEqual(candidate['release']['inventorySha256'], builder.RELEASE_INVENTORY_SHA256)
                self.assertEqual(len(observations), 2)
                self.assertEqual([c for c in calls if isinstance(c, tuple)], [('sql', 'address_radar')] * 2)
                self.assertFalse(result['productionMigrationReady'])
                if recovery_mode:
                    self.assertEqual(candidate['authenticationRecovery']['mode'],'known-pending-hba')
                    self.assertEqual(journal['pending'],'hba')
                    self.assertEqual(calls.count('fresh-full-consumer'),2)

    def test_completed_auth_actual_pins_original_namespace_and_double_live_measurement(self): self.execute()
    def test_explicit_recovery_uses_full_consumer_twice_preserves_original_pending(self): self.execute(pending='hba',recovery_mode=True)
    def test_recovery_exists_but_native_consumer_refuses_no_output(self): self.execute(pending='hba',recovery_mode=True,recovery_failure=True)
    def test_pending_auth_no_output(self): self.execute(pending='hba')
    def test_epoch_change_no_output(self): self.execute(change_epoch=True)
    def test_changed_journal_pin_no_output(self): self.execute(change_pin=True)
    def test_namespace_query_wrong_database_no_output(self): self.execute(wrong_database=True)


if __name__ == '__main__': unittest.main()
