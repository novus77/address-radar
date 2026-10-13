import hashlib
import importlib.util
from pathlib import Path
import unittest

p=Path(__file__).resolve().parents[1]/'diagnose-production-migrator-authentication.py'
s=importlib.util.spec_from_file_location('recovery_hash',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class HashTests(unittest.TestCase):
    def test_raw_written_bytes_include_lf_distinct_from_canonical(self):
        canonical=b'{"version":1}';raw=canonical+b'\n'
        value=m.recovery_record_hashes(raw,canonical)
        self.assertEqual(value['recoveryRecordFileSha256'],hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['recoveryRecordCanonicalSha256'],hashlib.sha256(canonical).hexdigest())
        self.assertNotEqual(value['recoveryRecordFileSha256'],value['recoveryRecordCanonicalSha256'])
        self.assertNotIn('recoveryRecordSha256',value)

if __name__=='__main__':unittest.main()
