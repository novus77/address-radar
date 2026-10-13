import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / 'preflight-address-only-production.py'
spec = importlib.util.spec_from_file_location('preflight', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PreflightTest(unittest.TestCase):
    def evidence(self):
        return dict(cohort=0, transitions=0, markers=0, rolesReady=False,
                    servicesReady=True, deliveryDisabled=True, diskBytes=24 * 1024**3)

    def test_empty_target_is_not_authorized(self):
        result = module.evaluate(self.evidence())
        self.assertEqual(result['phase'], 'not-migrated')
        self.assertFalse(result['activationAuthorized'])
        self.assertIn('runtime_roles_not_ready', result['blockers'])

    def test_partial_write_requires_recovery(self):
        evidence = self.evidence()
        evidence['cohort'] = 216
        self.assertEqual(module.evaluate(evidence)['phase'], 'inconsistent-requires-inspection')

    def test_missing_query_is_not_zero(self):
        evidence = self.evidence()
        evidence['markers'] = None
        self.assertIn('cutover_state_unknown', module.evaluate(evidence)['blockers'])

    def test_committed_records_do_not_grant_authority(self):
        evidence = self.evidence()
        evidence.update(cohort=216, transitions=1, markers=1, rolesReady=True)
        result = module.evaluate(evidence)
        self.assertEqual(result['phase'], 'postgres-write-recorded')
        self.assertFalse(result['activationAuthorized'])

    def test_unknown_delivery_blocks(self):
        evidence = self.evidence()
        evidence['deliveryDisabled'] = None
        self.assertIn('delivery_not_proven_disabled', module.evaluate(evidence)['blockers'])

if __name__ == '__main__':
    unittest.main()
