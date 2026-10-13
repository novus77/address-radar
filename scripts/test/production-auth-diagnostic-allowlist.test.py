import ast
import hashlib
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('fixed_auth_diagnostic',ROOT/'diagnose-production-migrator-authentication.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class AllowlistTests(unittest.TestCase):
    def test_exact_reviewed_auth_static_literals_only(self):
        body=(ROOT/'activate-production-postgres-migrator.py').read_bytes()
        self.assertEqual(hashlib.sha256(body).hexdigest(),'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61')
        codes=set()
        for n in ast.walk(ast.parse(body)):
            if not isinstance(n,ast.Call) or not isinstance(n.func,ast.Name):continue
            value=n.args[1] if n.func.id=='demand' and len(n.args)>=2 else n.args[0] if n.func.id=='Refused' and n.args else None
            if isinstance(value,ast.Constant) and isinstance(value.value,str):codes.add(value.value)
        self.assertEqual(module.SAFE_CODES,codes)
        class Refused(Exception):pass
        for code in codes:self.assertEqual(module.category(Refused(code)),code)
    def test_dynamic_secret_and_sql_never_exported(self):
        class Refused(Exception):pass
        for secret in ('SECRET SQL', 'migration_hba_rules SECRET', 'SELECT password', None):
            self.assertEqual(module.category(Refused(secret)),'unclassified_contract_refusal')
        self.assertEqual(module.category(Refused('known','SECRET')),'unclassified_contract_refusal')

if __name__=='__main__':unittest.main()
