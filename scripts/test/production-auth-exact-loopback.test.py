import importlib.util
from pathlib import Path
import unittest
p=Path(__file__).resolve().parents[1]/'diagnose-production-migrator-authentication.py'
s=importlib.util.spec_from_file_location('exact_loopback',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class ExactLoopbackTests(unittest.TestCase):
    def test_proved_single_value_only_preserves_wire_observation(self):
        raw={'address':'127.0.0.1/32','port':5432};canonical,proof=m.exact_loopback_host_tcp(raw)
        self.assertEqual(raw['address'],'127.0.0.1/32');self.assertEqual(canonical,{'address':'127.0.0.1','port':5432})
        self.assertEqual(proof['wireAddress'],'127.0.0.1/32');self.assertEqual(proof['canonicalAddress'],'127.0.0.1')
    def test_other_masks_addresses_and_shapes_refused(self):
        for value in ('127.0.0.1','127.0.0.1/24','127.0.0.2/32','::1/128','192.0.2.1/32',None):
            with self.assertRaises(PermissionError):m.exact_loopback_host_tcp({'address':value})
        with self.assertRaises(PermissionError):m.exact_loopback_host_tcp(True)

if __name__=='__main__':unittest.main()
