import importlib.util
import unittest
from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'build-production-postgres-schema-candidate.py'
spec = importlib.util.spec_from_file_location('schema_candidate_builder', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SchemaCandidateTests(unittest.TestCase):
    def completed(self):
        plan = {'operationId': 'migration-auth-operation'}
        credential = {'expiresAtMs': 1791281600123}
        journal = {'version': 1, 'planSha256': 'a' * 64, 'operationId': plan['operationId'], 'pending': None,
                   'credentialSha256': 'b' * 64, 'acknowledged': {'role': {'postmasterStart': 'epoch'},
                   'hba': {'hash': 'hba', 'tcp': {'measured': 'native-ack'}}}}
        measured = {'receipts': {'role': {'postmasterStart': 'epoch'}, 'hba': {'hash': 'hba'}}}
        return plan, credential, journal, measured

    def test_completed_native_ack_and_same_epoch_required_not_self_asserted_flag(self):
        p, c, j, m = self.completed()
        result = module.validate_completed_auth(p, c, j, 'a' * 64, 'b' * 64, m)
        self.assertEqual(result, 'epoch')
        for change in (lambda j: j.update(pending='hba'), lambda j: j.update(credentialSha256='c' * 64),
                       lambda j: j.update(planSha256='c' * 64), lambda j: j['acknowledged'].pop('role')):
            p, c, j, m = self.completed(); change(j)
            with self.assertRaises(module.Refused): module.validate_completed_auth(p, c, j, 'a' * 64, 'b' * 64, m)
        p, c, j, m = self.completed(); m['receipts']['role']['postmasterStart'] = 'changed'
        with self.assertRaises(module.Refused): module.validate_completed_auth(p, c, j, 'a' * 64, 'b' * 64, m)

    def test_fresh_namespace_and_measured_server_lease_not_local_renewal(self):
        module.validate_live_observation({'serverTimeMs': '1791260000123', 'namespaceCount': 0}, 1791281600123, 180000)
        for observation, expiry in (({'serverTimeMs': '1791260000123', 'namespaceCount': 1}, 1791281600123),
                                    ({'serverTimeMs': '1791260000123', 'namespaceCount': 0}, 1791260000124)):
            with self.assertRaises(module.Refused): module.validate_live_observation(observation, expiry, 180000)

    def test_release_proof_requires_actual_expected_inventory_and_compiled_plan(self):
        plan = {'version': 1, 'fingerprint': module.SCHEMA_FINGERPRINT, 'migrations': []}
        proof = {'inventorySha256': module.RELEASE_INVENTORY_SHA256, 'entries': 306, 'bytes': 1016989,
                 'schemaPlan': plan, 'candidateSha256': 'a' * 64}
        module.validate_release_measurement(proof, plan, 'a' * 64)
        for key, value in (('inventorySha256', 'b' * 64), ('entries', 305), ('bytes', 1), ('candidateSha256', 'b' * 64)):
            wrong = dict(proof); wrong[key] = value
            with self.assertRaises(module.Refused): module.validate_release_measurement(wrong, plan, 'a' * 64)

    def test_builder_source_dependencies_and_original_plan_are_hard_pinned(self):
        self.assertEqual(module.AUTH_SOURCE_SHA256, 'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61')
        self.assertEqual(module.SCHEMA_ENTRY_SHA256, '2750b013c1aab325717ab934e38c490ec41b625ff3757d0fa9b30e471875ca5b')
        self.assertEqual(module.PIN_HELPER_SHA256, 'f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f')


if __name__ == '__main__': unittest.main()
