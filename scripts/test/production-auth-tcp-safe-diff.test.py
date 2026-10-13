import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).resolve().parents[1]/'diagnose-production-migrator-authentication.py'
s=importlib.util.spec_from_file_location('tcpdiff',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class TcpDifferenceTests(unittest.TestCase):
    def expected(self):return {'database':'address_radar','user':'migrator','sessionUser':'migrator','databaseOid':'16391','roleOid':'16384','address':'127.0.0.1','port':5432,'start':'2026-10-06 07:00:00+00'}
    def test_exact_match(self):
        e=self.expected();self.assertEqual(m.safe_tcp_difference(e,e),{'differences':[],'unexpectedFieldCount':0})
    def test_address_mask_and_port_type_reported_not_normalized(self):
        e=self.expected();a={**e,'address':'127.0.0.1/32','port':'5432'};copy=dict(a)
        d=m.safe_tcp_difference(a,e)['differences'];self.assertEqual([r['field'] for r in d],['address','port'])
        self.assertEqual(d[0]['actual'],'127.0.0.1/32');self.assertEqual(d[1]['actualType'],'str');self.assertEqual(a,copy)
    def test_unknown_values_and_keys_not_exported(self):
        e=self.expected();a={**e,'user':'SECRET_PASSWORD!', 'SECRET_KEY':'SECRET'}
        d=m.safe_tcp_difference(a,e)
        self.assertEqual(d['unexpectedFieldCount'],1);self.assertNotIn('SECRET',str(d));self.assertEqual(d['differences'][0]['actual'],'<redacted>')

if __name__=='__main__':unittest.main()
