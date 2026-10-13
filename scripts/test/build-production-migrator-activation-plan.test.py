import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'build-production-migrator-activation-plan.py'
spec = importlib.util.spec_from_file_location('plan_builder', PATH)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class PlanBuilderTests(unittest.TestCase):
    def fixture(self):
        names = ['migration', 'scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console']
        roles = [{'name': 'radar_' + name.replace('-', '_'), 'service': name, 'connectionLimit': 1} for name in names]
        prepared = {'roles': [role['name'] for role in roles], 'plan': {'database': 'address_radar', 'migratorRole': roles[0]['name'],
                     'serviceRoles': {role['service']: role['name'] for role in roles[1:]}}}
        observation = {'serverTimeMs': '1791260000123', 'systemIdentifier': '7693392208475083526', 'databaseOid': '16391',
                       'database': 'address_radar',
                       'namespaceCount': 0, 'roles': [{'name': role['name'], 'oid': str(16384 + index),
                       'login': False, 'connectionLimit': 1, 'passwordNull': True} for index, role in enumerate(roles)]}
        return prepared, observation

    def test_measured_server_clock_explicit_six_hour_ttl_and_exact_oids(self):
        prepared, observation = self.fixture()
        clock, pins = builder.validate_observation(prepared, observation)
        self.assertEqual(clock, 1791260000123)
        self.assertEqual(builder.credential_expiry(clock), 1791281600123)
        self.assertEqual(pins['databaseOid'], '16391')
        self.assertEqual(pins['roleOids']['radar_migration'], '16384')
        self.assertEqual(len(pins['roleOids']), 7)

    def test_unknown_or_changed_catalog_refused(self):
        for mutate in (lambda o: o['roles'].append(dict(o['roles'][0])),
                       lambda o: o['roles'][0].update(login=True),
                       lambda o: o['roles'][0].update(connectionLimit=2),
                       lambda o: o['roles'][0].update(passwordNull=False),
                       lambda o: o.update(systemIdentifier='1'),
                       lambda o: o.update(databaseOid='16392'),
                       lambda o: o.update(database='postgres'),
                       lambda o: o.update(namespaceCount=1),
                       lambda o: o['roles'][1].update(oid='16386')):
            prepared, observation = self.fixture()
            mutate(observation)
            with self.assertRaises(builder.Refused): builder.validate_observation(prepared, observation)

    def test_pin_native_types_and_no_secret_bytes_in_output(self):
        class Stat:
            st_dev = 64769
            st_ino = 6029400
            st_uid = 0
            st_gid = 0
            st_mode = 0o100600
        pin = builder.pin_from_stat('/protected/secrets.json', Stat(), 'a' * 64)
        self.assertEqual(pin['device'], '64769')
        self.assertEqual(pin['inode'], '6029400')
        self.assertEqual(pin['mode'], 384)
        self.assertEqual(set(pin), {'path', 'sha256', 'uid', 'gid', 'mode', 'device', 'inode'})

    def test_full_plan_identity_and_no_auto_renew(self):
        self.assertEqual(builder.PROVISIONING_SHA256, '43978c786e262cf4abb037b9be7d2ea556b31c0532ad10df8bfbdfecadbc9c7f')
        self.assertEqual(builder.PROVISIONING_PLAN_SHA256, 'b8e9bd6ec46723e0eeb45915c12c86d61168d24569c934bce70039bafe2e0b46')
        self.assertEqual(builder.CREDENTIAL_TTL_MS, 21600000)
        with self.assertRaises(builder.Refused): builder.credential_expiry(0)

    def test_given_native_artifacts_are_exact_and_unknown_replacement_is_not_adopted(self):
        for slot, expected in builder.ARTIFACT_EXPECTATIONS.items():
            pin = {'path': '/protected/original', **expected}
            builder.require_original_pin(slot, pin)
            for key in expected:
                changed = dict(pin); changed[key] = 'changed'
                with self.assertRaises(builder.Refused): builder.require_original_pin(slot, changed)

    def test_original_b8e_frozen_role_contract_offline(self):
        path = Path('/private/tmp/address-radar-production-target-20261006-recovery-plan.json')
        if not path.is_file(): self.skipTest('actual local b8e plan not present')
        plan = builder.strict_json(path.read_bytes())
        import hashlib
        import time
        self.assertEqual(hashlib.sha256(builder.encoded(plan)).hexdigest(), builder.PROVISIONING_PLAN_SHA256)
        source = PATH.parent / 'prepare-production-postgres-target.py'
        body = source.read_bytes()
        self.assertEqual(hashlib.sha256(body).hexdigest(), builder.PROVISIONING_SHA256)
        module = builder.load_module(body, source, 'offline_frozen439')
        prepared = module.validate_plan(plan, int(time.time() * 1000))
        names = builder.validated_roles(prepared)
        self.assertEqual(names['migration'], 'address_radar_migrator')
        self.assertEqual(plan['target']['configDirectory'], '/etc/postgresql/16/radarproduction')
        self.assertEqual(len(names), 7)

    def test_native_measurement_uses_real439_signature_and_target_database(self):
        calls = []
        class Native:
            def resource_guard(self): calls.append('guard')
            def observe(self, prepared): calls.append(('observe', prepared)); return {'measured': True}
            def sql(self, text, database='postgres'): calls.append(('sql', database)); return b'{}'
        prepared = {'plan': {'database': 'address_radar'}}
        builder.observe_prepared(Native(), prepared)
        builder.query_target(Native(), prepared, 'SELECT current_database();')
        self.assertEqual(calls, ['guard', ('observe', prepared), ('sql', 'address_radar')])


if __name__ == '__main__': unittest.main()
