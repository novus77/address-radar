import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('grants', Path(__file__).parents[1] / 'apply-address-only-role-grants.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class GrantTest(unittest.TestCase):
    def test_generated_sql_is_single_transaction_and_does_not_enable_login(self):
        sql = module.transaction_sql(['GRANT USAGE ON SCHEMA address_radar_business TO address_radar_console;'])
        self.assertTrue(sql.startswith('BEGIN;'))
        self.assertTrue(sql.rstrip().endswith('COMMIT;'))
        self.assertIn('7693392208475083526', sql)
        self.assertIn('runtime_privilege_boundary_changed', sql)
        self.assertNotIn(' LOGIN', sql)
        self.assertNotIn(' PASSWORD', sql)

    def test_missing_or_unsafe_grant_program_is_refused(self):
        for statements in ([], ['CREATE ROLE unsafe LOGIN;'], ['GRANT ALL ON DATABASE address_radar TO PUBLIC;'], ['SELECT 1;']):
            with self.assertRaises(RuntimeError):
                module.transaction_sql(statements)

    def test_protected_marker_and_provider_columns_are_audited(self):
        sql = module.transaction_sql(['GRANT USAGE ON SCHEMA address_radar_business TO address_radar_console;'])
        self.assertIn('migration_cutover_first_write_markers', sql)
        self.assertIn('maximum_requests', sql)
        self.assertIn('has_any_column_privilege', sql)

if __name__ == '__main__':
    unittest.main()
