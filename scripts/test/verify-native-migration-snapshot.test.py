import importlib.util
import pathlib
import sqlite3
import tempfile
import time
import unittest


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = pathlib.Path(__file__).resolve().parents[1]
VERIFIER = load('snapshot_verifier', ROOT / 'verify-native-migration-snapshot.py')
COLLECTOR = load('snapshot_collector', ROOT / 'native-migration-snapshot.py')
HELPER = load('consistent_helper', ROOT / 'consistent-sqlite-migration.py')


class IndependentSnapshotTests(unittest.TestCase):
    def setup_snapshot(self, directory):
        source = pathlib.Path(directory) / 'source.sqlite'
        with sqlite3.connect(source) as connection:
            connection.execute('CREATE TABLE records(id INTEGER PRIMARY KEY, payload BLOB)')
            connection.executemany('INSERT INTO records VALUES (?,?)', [(1, b'one'), (2, b'two')])
        output = pathlib.Path(directory) / 'producer'
        measurement = COLLECTOR.collect_snapshot(source, output, HELPER,
                                                  time.monotonic() + 10, 0, 'fixture')
        return output, measurement

    def test_actual_independent_backup_export_restore_matches_producer(self):
        with tempfile.TemporaryDirectory() as directory:
            producer, measurement = self.setup_snapshot(directory)
            result = VERIFIER.verify_snapshot_artifacts(measurement, producer,
                        pathlib.Path(directory) / 'independent', HELPER, COLLECTOR,
                        time.monotonic() + 10, 0, 'fixture')
            self.assertEqual(result['tables'], measurement['tables'])
            self.assertEqual(result['snapshotSha256'], measurement['snapshotSha256'])
            self.assertFalse(result['signedProofsCreated'])
            self.assertFalse(result['fenceEstablished'])

    def test_wrong_snapshot_pin_refuses_before_new_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            producer, measurement = self.setup_snapshot(directory)
            measurement['snapshotSha256'] = '0' * 64
            output = pathlib.Path(directory) / 'independent'
            with self.assertRaises(VERIFIER.Refused):
                VERIFIER.verify_snapshot_artifacts(measurement, producer, output, HELPER,
                                COLLECTOR, time.monotonic() + 10, 0, 'fixture')
            self.assertFalse(output.exists())

    def test_forged_table_measurement_fails_actual_independent_check(self):
        with tempfile.TemporaryDirectory() as directory:
            producer, measurement = self.setup_snapshot(directory)
            measurement['tables'][0]['rowCount'] = '3'
            with self.assertRaises(VERIFIER.Refused):
                VERIFIER.verify_snapshot_artifacts(measurement, producer,
                            pathlib.Path(directory) / 'independent', HELPER, COLLECTOR,
                            time.monotonic() + 10, 0, 'fixture')

    def test_expired_deadline_cannot_start_independent_work(self):
        with tempfile.TemporaryDirectory() as directory:
            producer, measurement = self.setup_snapshot(directory)
            output = pathlib.Path(directory) / 'independent'
            with self.assertRaises(VERIFIER.Refused):
                VERIFIER.verify_snapshot_artifacts(measurement, producer, output, HELPER,
                                COLLECTOR, time.monotonic() - 1, 0, 'fixture')
            self.assertFalse(output.exists())


class CurrentSourceTests(IndependentSnapshotTests):
    def verify_current(self, directory, measurement):
        source = pathlib.Path(directory) / 'source.sqlite'
        info = source.stat()
        return VERIFIER.verify_current_source_snapshot(measurement,
                dict(path=str(source), identity=[info.st_dev, info.st_ino]),
                pathlib.Path(directory) / 'current', HELPER, COLLECTOR,
                time.monotonic() + 10, 0, 'fixture', lambda: None)

    def test_actual_current_source_matches_sealed_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            _, measurement = self.setup_snapshot(directory)
            result = self.verify_current(directory, measurement)
            self.assertEqual(len(result['currentSourceMeasurementSha256']), 64)

    def test_stale_sealed_snapshot_refused_after_actual_source_write(self):
        with tempfile.TemporaryDirectory() as directory:
            _, measurement = self.setup_snapshot(directory)
            with sqlite3.connect(pathlib.Path(directory) / 'source.sqlite') as connection:
                connection.execute("INSERT INTO records VALUES (3, X'03')")
            with self.assertRaisesRegex(VERIFIER.Refused, 'stale-snapshot-artifact'):
                self.verify_current(directory, measurement)

    def test_wrong_source_identity_refused_before_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            _, measurement = self.setup_snapshot(directory)
            measurement['source']['inode'] = 'wrong'
            with self.assertRaisesRegex(VERIFIER.Refused, 'producer-source-binding'):
                self.verify_current(directory, measurement)
            self.assertFalse((pathlib.Path(directory) / 'current').exists())


if __name__ == '__main__':
    unittest.main()
