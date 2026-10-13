import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('seed', Path(__file__).parents[1] / 'prepare-address-only-seed.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SeedTests(unittest.TestCase):
    def setUp(self):
        self.seed = {'format': 'address-only-seed-v1', 'rules': {'historicalEvidenceImported': False,
            'historicalJobsImported': False, 'legacyLifecycleIsNotNewCapabilityProof': True,
            'gatewayDeliveryEnabled': False, 'activationAuthorizedByExport': False}, 'tables': {
            'fomo_accounts': [{'account_id': 'a', 'handle': 'alice'}],
            'wallet_identities': [{'account_id': 'a', 'chain_family': 'evm', 'address': '0x' + 'a' * 40,
                'confidence': 'high', 'source': 'fomolens_manual'}],
            'entity_accounts': [{'account_id': 'a', 'entity_id': 'e', 'confidence': 'high'}],
            'trader_entities': [{'entity_id': 'e', 'lifecycle': 'suspended'}],
            'trader_profiles': [{'entity_id': 'e', 'display_name': 'Alice', 'priority': 'normal', 'notes': None,
                'monitoring_enabled': 1, 'fomo_monitoring_enabled': 0, 'onchain_monitoring_enabled': 1}],
            'trader_monitoring_policy': [{'trader_id': 'e', 'policy': 'off'}]}}
    def test_preserves_suspension_without_granting_eligibility(self):
        result = module.prepare(self.seed, 'a' * 64)
        self.assertTrue(result['settings'][0]['suspended'])
        self.assertFalse(result['grantsBusinessEligibility'])
        self.assertEqual(result['settings'][0]['policy'], 'off')
    def test_rejects_historical_tables(self):
        self.seed['tables']['automation_jobs'] = []
        with self.assertRaisesRegex(ValueError, 'unexpected_tables'): module.prepare(self.seed, 'a' * 64)
    def test_rejects_multiple_owners(self):
        self.seed['tables']['entity_accounts'].append(copy.deepcopy(self.seed['tables']['entity_accounts'][0]))
        with self.assertRaisesRegex(ValueError, 'ambiguous_account_owner'): module.prepare(self.seed, 'a' * 64)
    def test_rejects_duplicate_wallet(self):
        self.seed['tables']['wallet_identities'] *= 2
        with self.assertRaisesRegex(ValueError, 'duplicate_or_conflicting_wallet'): module.prepare(self.seed, 'a' * 64)
    def test_rejects_unverified_wallet(self):
        self.seed['tables']['wallet_identities'][0]['confidence'] = 'low'
        with self.assertRaisesRegex(ValueError, 'unverified_wallet'): module.prepare(self.seed, 'a' * 64)

if __name__ == '__main__': unittest.main()
