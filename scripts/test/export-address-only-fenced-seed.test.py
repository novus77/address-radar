#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'fenced_seed', Path(__file__).resolve().parents[1] / 'export-address-only-fenced-seed.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FencedSeedTests(unittest.TestCase):
    def fixture(self):
        connection = sqlite3.connect(':memory:')
        connection.executescript('''
            CREATE TABLE wallet_identities(account_id TEXT,chain_family TEXT,address TEXT,confidence TEXT,source TEXT);
            CREATE TABLE fomo_accounts(account_id TEXT,handle TEXT);
            CREATE TABLE entity_accounts(account_id TEXT,entity_id TEXT,confidence TEXT);
            CREATE TABLE trader_entities(entity_id TEXT,lifecycle TEXT);
            CREATE TABLE trader_profiles(entity_id TEXT,monitoring_enabled INTEGER);
            CREATE TABLE trader_monitoring_policy(trader_id TEXT,policy TEXT);
            INSERT INTO wallet_identities VALUES ('a','evm','0x01','confirmed','manual');
            INSERT INTO wallet_identities VALUES ('a','solana','CaseSensitive','high','fomolens_manual');
            INSERT INTO wallet_identities VALUES ('other','evm','0x02','low','inferred');
            INSERT INTO fomo_accounts VALUES ('a','alice'),('other','unknown');
            INSERT INTO entity_accounts VALUES ('a','e','confirmed'),('other','other-e','low');
            INSERT INTO trader_entities VALUES ('e','candidate'),('other-e','active');
            INSERT INTO trader_profiles VALUES ('e',1),('other-e',1);
            INSERT INTO trader_monitoring_policy VALUES ('e','realtime'),('other-e','realtime');
        ''')
        self.addCleanup(connection.close)
        return connection

    def test_only_confirmed_registry_and_its_links_are_selected(self):
        seed = m.select_seed(self.fixture(), '2026-10-08T00:00:00.000Z')
        self.assertEqual(len(seed['tables']['wallet_identities']), 2)
        for table, key in [('fomo_accounts', 'account_id'), ('entity_accounts', 'account_id'),
                           ('trader_entities', 'entity_id'), ('trader_profiles', 'entity_id'),
                           ('trader_monitoring_policy', 'trader_id')]:
            self.assertEqual(len(seed['tables'][table]), 1)
            self.assertEqual(seed['tables'][table][0][key], 'a' if key == 'account_id' else 'e')
        self.assertFalse(seed['rules']['historicalJobsImported'])
        self.assertFalse(seed['rules']['activationAuthorizedByExport'])

    def test_no_historical_table_or_write_is_queried(self):
        connection = self.fixture()
        statements = []
        connection.set_trace_callback(statements.append)
        connection.execute('PRAGMA query_only=ON')
        m.select_seed(connection, '2026-10-08T00:00:00.000Z')
        for sql in statements[1:]:
            self.assertTrue(sql.startswith('SELECT * FROM '))
            self.assertNotIn('automation_jobs', sql)
            self.assertNotIn('market_observations', sql)

    def test_empty_confirmed_registry_refuses(self):
        connection = self.fixture()
        connection.execute('DELETE FROM wallet_identities')
        with self.assertRaisesRegex(ValueError, 'empty_confirmed_address_registry'):
            m.select_seed(connection, '2026-10-08T00:00:00.000Z')

    def test_orphan_link_is_preserved_for_validator_to_reject_not_guessed(self):
        connection = self.fixture()
        connection.execute("DELETE FROM entity_accounts WHERE account_id='a'")
        seed = m.select_seed(connection, '2026-10-08T00:00:00.000Z')
        self.assertEqual(seed['tables']['entity_accounts'], [])
        self.assertEqual(len(seed['tables']['wallet_identities']), 2)

    def test_invalid_job_refuses_before_code_or_source_reads(self):
        with patch.object(m, 'pinned_module', side_effect=AssertionError('must not read')):
            with self.assertRaisesRegex(ValueError, 'unsupported_capture_job'):
                m.capture({'version': 1})


if __name__ == '__main__':
    unittest.main()
