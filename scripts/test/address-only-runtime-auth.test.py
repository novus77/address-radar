import base64
import hashlib
import hmac
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('auth', Path(__file__).parents[1] / 'provision-address-only-runtime-auth.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AuthTest(unittest.TestCase):
    def test_scram_verifier_matches_postgres_protocol(self):
        verifier = module.scram('secret-password', b'0123456789abcdef')
        algorithm, rounds_salt, keys = verifier.split('$')
        rounds, salt = rounds_salt.split(':')
        stored, server = keys.split(':')
        salted = hashlib.pbkdf2_hmac('sha256', b'secret-password', base64.b64decode(salt), int(rounds))
        self.assertEqual(algorithm, 'SCRAM-SHA-256')
        self.assertEqual(base64.b64decode(stored), hashlib.sha256(hmac.new(salted, b'Client Key', hashlib.sha256).digest()).digest())
        self.assertEqual(base64.b64decode(server), hmac.new(salted, b'Server Key', hashlib.sha256).digest())

    def test_hba_only_adds_exact_six_loopback_roles(self):
        result = module.runtime_hba(module.BASELINE)
        self.assertEqual(result.count(b'host address_radar address_radar_'), 7)
        self.assertEqual(result.count(b'127.0.0.1/32 scram-sha-256'), 7)
        self.assertNotIn(b'0.0.0.0', result)
        self.assertTrue(result.endswith(b'host all all ::1/128 reject\n'))

    def test_hba_drift_is_not_overwritten(self):
        with self.assertRaisesRegex(RuntimeError, 'hba_baseline_changed'):
            module.runtime_hba(module.BASELINE + b'# changed\n')

    def test_role_allowlist_is_exact_and_excludes_migrator(self):
        self.assertEqual(len(set(module.ROLES)), 6)
        self.assertNotIn('address_radar_migrator', module.ROLES)

if __name__ == '__main__':
    unittest.main()
