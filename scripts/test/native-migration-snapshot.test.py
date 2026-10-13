import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

collector = module('snapshot_collector', ROOT / 'native-migration-snapshot.py')
helper = module('snapshot_helper', ROOT / 'consistent-sqlite-migration.py')

class NativeSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.sqlite'
        connection = sqlite3.connect(self.source)
        connection.execute('CREATE TABLE records(id INTEGER PRIMARY KEY, value BLOB)')
        connection.execute('INSERT INTO records VALUES(?,?)', (1, b'actual-data'))
        connection.commit()
        connection.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_real_backup_export_restore_parity_without_fence_claim(self):
        result = collector.collect_snapshot(self.source, self.root / 'result', helper,
                                             time.monotonic() + 10, 0, 'fixture-operation')
        self.assertEqual(result['tables'][0]['rowCount'], '1')
        self.assertFalse(result['fenceEstablished'])
        self.assertFalse(result['signedProofsCreated'])
        restored = sqlite3.connect(self.root / 'result' / 'restored.sqlite')
        self.assertEqual(restored.execute('SELECT value FROM records').fetchone()[0], b'actual-data')
        restored.close()

    def test_admission_change_aborts_before_output(self):
        def changed():
            raise RuntimeError('changed')
        with self.assertRaises(RuntimeError):
            collector.collect_snapshot(self.source, self.root / 'result', helper,
                                       time.monotonic() + 10, 0, 'fixture-operation', changed)
        self.assertFalse((self.root / 'result').exists())

    def test_existing_output_is_not_overwritten(self):
        (self.root / 'result').mkdir()
        with self.assertRaises(FileExistsError):
            collector.collect_snapshot(self.source, self.root / 'result', helper,
                                       time.monotonic() + 10, 0, 'fixture-operation')

    def test_expired_original_deadline_refuses(self):
        with self.assertRaises(RuntimeError):
            collector.collect_snapshot(self.source, self.root / 'result', helper,
                                       time.monotonic() - 1, 0, 'fixture-operation')
        self.assertFalse((self.root / 'result').exists())

if __name__ == '__main__':
    unittest.main()
