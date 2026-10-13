"""Unit contracts only; mocked subprocesses are not native PostgreSQL proof."""
import importlib.util
from pathlib import Path
import unittest
import tempfile
import os
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'postgres-raw-retention-dry-run.py'

class Contracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PATH.exists():
            raise AssertionError('readonly retention implementation missing')
        spec = importlib.util.spec_from_file_location('retention', PATH)
        cls.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.m)

    def test_fixed_bounds_and_readonly(self):
        sql = self.m.SQL
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', sql)
        self.assertIn("statement_timeout='3s'", sql)
        self.assertIn('LIMIT 500', sql)
        self.assertIn('candidate_window AS MATERIALIZED', sql)
        self.assertNotIn('), window AS', sql)
        self.assertIn('received_at <', sql)
        self.assertNotIn('scrubbed_payload', sql)
        self.assertNotIn('semantic_payload', sql)
        self.assertNotIn('DELETE ', sql)

    def test_empty_report_binding(self):
        r = self.m.report(self.value(), 'gen', 'a'*64)
        self.assertEqual(r['candidateCount'], 0)
        self.assertFalse(r['automaticDeletionEnabled'])
        self.assertEqual(r['proofPurge'], 'deferred')
        self.assertEqual(r['cutoffExclusiveMs'], 1700000000000-15*86400000)
        self.assertEqual(len(r['selectionSha256']), 64)

    def value(self):
        return dict(database='address_radar', schemaVersion=3, fingerprint='a'*64,
                    generations=['gen'], snapshot='1:2:', asOfMs=1700000000000, rows=[])

    def test_wrong_identity_refused(self):
        for key, value in [('schemaVersion', 2), ('fingerprint', 'b'*64), ('generations', ['other'])]:
            v = self.value(); v[key] = value
            with self.assertRaises(ValueError): self.m.report(v, 'gen', 'a'*64)

    def test_no_payload_or_identifier_in_report(self):
        v = self.value(); v['rows'] = [dict(payload_id='private-id', received_at=1,
            payload_hash='b'*64, reasons=['normalization_unfinished', 'consumer_registry_unproven'])]
        r = self.m.report(v, 'gen', 'a'*64)
        self.assertEqual(r['protectedReasonCounts']['normalization_unfinished'], 1)
        self.assertNotIn('private-id', str(r))
        self.assertEqual(r['wouldDeleteCount'], 0)

    def test_strict_boundary_and_cap(self):
        v = self.value(); v['rows'] = [dict(payload_id='x', received_at=1700000000000-15*86400000,
            payload_hash='b'*64, reasons=['consumer_registry_unproven'])]
        with self.assertRaises(ValueError): self.m.report(v, 'gen', 'a'*64)
        v['rows'] *= 501
        with self.assertRaises(ValueError): self.m.report(v, 'gen', 'a'*64)

    def test_timeout_contract(self):
        self.assertEqual(self.m.TOTAL_SECONDS, 30)
        self.assertEqual(self.m.OUTPUT_CAP, 1024*1024)

    def test_config_exact_operator_contract(self):
        value = dict(generation='gen', schemaFingerprint='a'*64,
            passfile='/etc/address-radar-postgres-backup/pgpass',
            passfileSha256='b'*64, psqlSha256='c'*64)
        self.assertEqual(self.m.validate_config(value)['generation'], 'gen')
        for key, replacement in [('execute', True), ('passfile', '/tmp/pass'),
                                 ('schemaFingerprint', 'bad')]:
            changed = dict(value); changed[key] = replacement
            with self.assertRaises(ValueError): self.m.validate_config(changed)

    def test_private_pin_rejects_permissions_symlink_and_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'pin'; path.write_bytes(b'private')
            os.chmod(path, 0o600)
            # Unit-only: root ownership is substituted, not native proof.
            with patch.object(self.m, 'check_parents'), patch.object(self.m, 'ROOT_UID', os.getuid()):
                raw = self.m.read_pin(str(path), 32, private=True)
                self.assertEqual(raw, b'private')
                os.chmod(path, 0o644)
                with self.assertRaises(ValueError): self.m.read_pin(str(path), 32, private=True)
                link = Path(directory)/'link'; link.symlink_to(path)
                with self.assertRaises(OSError): self.m.read_pin(str(link), 32, private=True)

    def test_psql_environment_uses_only_fixed_passfile(self):
        env = self.m.query_environment('/etc/address-radar-postgres-backup/pgpass')
        self.assertEqual(env['PGPASSFILE'], '/etc/address-radar-postgres-backup/pgpass')
        self.assertNotIn('PGPASSWORD', env)
        self.assertIn('default_transaction_read_only=on', env['PGOPTIONS'])

if __name__ == '__main__': unittest.main()
