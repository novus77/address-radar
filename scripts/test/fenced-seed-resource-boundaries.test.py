import importlib.util
from pathlib import Path
import sqlite3
import os
import tempfile
import types
import json
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fenced_resources', Path(__file__).resolve().parents[1] / 'export-address-only-fenced-seed.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Resources(unittest.TestCase):
    def test_oversized_field_refused_by_sqlite_before_materialization(self):
        db = sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE wallet_identities(account_id TEXT,chain_family TEXT,address TEXT,confidence TEXT,source TEXT,notes TEXT)')
        db.execute("INSERT INTO wallet_identities VALUES('a','evm','x','confirmed','manual',?)", ('x' * 8192,))
        with patch.object(m, 'MAXIMUM_BYTES', 4096):
            with self.assertRaisesRegex((ValueError, sqlite3.DataError), 'budget|too big'):
                m.select_seed(db, '2026-10-08T00:00:00Z')
        self.assertGreater(db.getlimit(sqlite3.SQLITE_LIMIT_LENGTH), 8192)

    def test_elapsed_deadline_refuses_before_reading_or_loading_code(self):
        deadline = m.OperationDeadline(0)
        with patch.object(m, 'pinned_module', side_effect=AssertionError('must not load')):
            with self.assertRaisesRegex(ValueError, 'deadline'):
                m.capture({'version': 1, 'kernelEntry': {}, 'kernelJob': {}, 'seedValidator': {}, 'seedOutput': ''}, deadline)

    def test_directory_ancestors_reject_symlink(self):
        fake = type('Stat', (), {'st_mode': 0o120700, 'st_uid': 0, 'st_dev': 1, 'st_ino': 1})()
        with patch.object(m.os, 'lstat', return_value=fake):
            with self.assertRaisesRegex(ValueError, 'parent'):
                m.private_output_directory('/var/lib/address-radar-maintenance-tools/final', lambda: None)

class CaptureComposition(unittest.TestCase):
    def test_capture_composition_publishes_seed_and_matching_receipt_without_native_claim(self):
        # Isolated composition fixture: mocked kernel admission is not production fence evidence.
        spec = importlib.util.spec_from_file_location('registry_fixture', Path(__file__).with_name('export-address-only-fenced-seed.test.py'))
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        fixture = fixtures.FencedSeedTests()
        connection = fixture.fixture()
        kernel = types.SimpleNamespace(validate_job=lambda job: None,
            collect=lambda job, check: (check(), {'fixtureOnly': True})[1], canonical=m.canonical)
        validator = types.SimpleNamespace(prepare=lambda seed, digest: {
            'wallets': seed['tables']['wallet_identities'], 'settings': seed['tables']['trader_profiles']})
        job = {'version': 1, 'kernelEntry': {}, 'seedValidator': {}, 'kernelJob': {},
               'seedOutput': '/var/lib/address-radar-maintenance-tools/fixture/seed.json'}
        kernel_job = {'sourceDirectory': '/var/lib/address-radar', 'durationSeconds': 30,
                      'sources': [{'path': m.SOURCE + suffix} for suffix in ['', '-wal', '-shm']]}
        try:
            with tempfile.TemporaryDirectory() as directory:
                fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                with patch.object(m, 'pinned_module', side_effect=[kernel, validator]), \
                     patch.object(m, 'pinned_record', return_value=kernel_job), \
                     patch.object(m, 'private_output_directory', return_value=(fd, [])), \
                     patch.object(m.sqlite3, 'connect', return_value=connection):
                    result = m.capture(job)
                seed_bytes = Path(directory, 'seed.json').read_bytes()
                receipt = json.loads(Path(directory, 'seed.json.receipt.json').read_bytes())
                self.assertEqual(receipt, result)
                self.assertEqual(m.sha(seed_bytes), receipt['seedSha256'])
                self.assertEqual(receipt['wallets'], 2)
                self.assertFalse(receipt['databaseImported'])
                self.assertFalse(receipt['activationAuthorized'])
        finally:
            fixture.doCleanups()

class OriginalDeadline(unittest.TestCase):
    def test_short_job_budget_starts_before_pinned_loading(self):
        with patch.object(m.time, 'monotonic', return_value=0):
            deadline = m.OperationDeadline(30)
        with patch.object(m.time, 'monotonic', return_value=5):
            deadline.shorten(1)
            with self.assertRaisesRegex(ValueError, 'deadline'):
                deadline.check()

if __name__ == '__main__': unittest.main()
