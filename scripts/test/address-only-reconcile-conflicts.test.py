import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('reconcile', Path(__file__).parents[1] / 'address-only-pg-reconcile.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ConflictingAbsentTests(unittest.TestCase):
    def binding(self):
        return {'operationId': 'op', 'importId': 'import', 'generationId': 'generation',
            'planSha256': 'a' * 64, 'target': {'database': m.DATABASE, 'schema': m.SCHEMA,
                'systemIdentifier': m.SYSTEM, 'schemaFingerprint': m.FINGERPRINT,
                'serverAddress': '127.0.0.1', 'serverPort': 5432}}

    def observed(self):
        return {'system': m.SYSTEM, 'database': m.DATABASE, 'port': 5432, 'importerSessions': 0,
            'schemaIdentity': [{'singleton': True, 'ledger_format': 1, 'database_name': m.DATABASE,
                'schema_name': m.SCHEMA, 'generation_id': 'generation'}],
            'schemaLedger': [{'version': 3, 'fingerprint': m.FINGERPRINT}],
            'ledger': [], 'cohortCount': 0, 'generationCount': 0}

    def test_absent_allows_known_empty_generation(self):
        for count in (0, 1):
            value = dict(self.observed(), generationCount=count)
            self.assertFalse(m.classify(self.binding(), value)['importExists'])

    def test_nonempty_cohort_without_ledger_never_authorizes_restore(self):
        with self.assertRaisesRegex(ValueError, 'conflicting_data'):
            m.classify(self.binding(), dict(self.observed(), cohortCount=216))

    def test_ambiguous_generation_never_authorizes_restore(self):
        with self.assertRaisesRegex(ValueError, 'conflicting_data'):
            m.classify(self.binding(), dict(self.observed(), generationCount=2))


if __name__ == '__main__':
    unittest.main()
