import copy
import importlib.util
from pathlib import Path
import unittest

p=Path(__file__).resolve().parents[1]/'diagnose-production-migrator-authentication.py'
s=importlib.util.spec_from_file_location('auth_recovery_measurement',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class RecoveryTests(unittest.TestCase):
    def fixture(self):
        plan={'targetPins':{'systemIdentifier':'7693392208475083526','databaseOid':'16391','roleOids':{'migrator':'16384'}}}
        c={'database':'address_radar','user':'migrator'}
        role={'systemIdentifier':'7693392208475083526','databaseOid':'16391','postmasterStart':'epoch'}
        j={'pending':'hba','acknowledged':{'role':role}}
        tcp={'database':'address_radar','user':'migrator','sessionUser':'migrator','databaseOid':'16391','roleOid':'16384','address':'127.0.0.1','port':5432,'start':'epoch'}
        o={'phase':'active','receipts':{'role':copy.deepcopy(role),'hba':{'hbaSha256':'hash','tcp':tcp}}}
        return plan,j,c,o
    def test_new_current_ack_not_historical_journal_edit(self):
        p,j,c,o=self.fixture(); before=copy.deepcopy(j)
        self.assertEqual(m.validate_pending_hba(p,j,c,o,'hash'),o['receipts']);self.assertEqual(j,before)
    def test_pending_must_be_known_hba_and_only_original_role_ack(self):
        for stage in (None,'role','credential'):
            p,j,c,o=self.fixture();j['pending']=stage
            with self.assertRaises(PermissionError):m.validate_pending_hba(p,j,c,o,'hash')
        p,j,c,o=self.fixture();j['acknowledged']['hba']={}
        with self.assertRaises(PermissionError):m.validate_pending_hba(p,j,c,o,'hash')
    def test_hash_epoch_role_ack_and_actual_tcp_exactness(self):
        for mutate in (lambda o:o['receipts']['hba'].update(hbaSha256='other'),
                       lambda o:o['receipts']['role'].update(postmasterStart='changed'),
                       lambda o:o['receipts']['hba']['tcp'].update(start='changed'),
                       lambda o:o['receipts']['hba']['tcp'].update(roleOid='1'),
                       lambda o:o['receipts']['hba'].pop('tcp')):
            p,j,c,o=self.fixture();mutate(o)
            with self.assertRaises(PermissionError):m.validate_pending_hba(p,j,c,o,'hash')
    def test_failure_category_no_exception_text(self):
        class Refused(Exception):pass
        self.assertEqual(m.category(Refused('SECRET')),'unclassified_contract_refusal')
        self.assertEqual(m.category(Refused('migration_hba_rules')),'migration_hba_rules')

if __name__=='__main__':unittest.main()
