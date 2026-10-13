import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / 'backup-postgres-business-schema.py'


class PostgresBackupTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'Dedicated PostgreSQL backup tool must exist')
        spec = importlib.util.spec_from_file_location('postgres_backup', SCRIPT)
        self.tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.tool)
        self.temp = tempfile.TemporaryDirectory(prefix='postgres-backup-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.output = self.root / 'backups'
        self.output.mkdir(mode=0o700)
        self.passfile = self.root / 'passfile'
        self.passfile.write_text('credential-must-never-be-logged')
        self.passfile.chmod(0o600)
        self.binary = self.root / 'pg_dump'
        self.original_directory_check = self.tool.check_directory
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(self.tool, 'ROOT_UID', os.getuid()).start()

        # Local tests run without root. Only the temporary-directory ancestor
        # exception is simulated; private leaf and artifact checks remain real.
        def directory_check(info, private=False):
            if info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o1777 and not private:
                return
            return self.original_directory_check(info, private)

        mock.patch.object(self.tool, 'check_directory', side_effect=directory_check).start()
        self.configure_binary()

    def configure_binary(self, body="os.write(1, b'PGDMP' + b'x' * 100)", version='16.4'):
        source = ('#!' + sys.executable + '\nimport os,sys,time,json\n'
                  "if '--version' in sys.argv:\n"
                  "    print('pg_dump (PostgreSQL) " + version + "');sys.exit(0)\n" + body + '\n')
        self.binary.write_text(source)
        self.binary.chmod(0o700)
        self.restore = self.root / 'pg_restore'
        self.restore.write_text('#!' + sys.executable + '\nimport os,sys\n'
            "if '--version' in sys.argv: print('pg_restore (PostgreSQL) 16.4')\n"
            "elif '--list' in sys.argv: print('1; 0 100 TABLE DATA address_radar_business forward_strategy_generations radar_backup')\n"
            "else: print('COPY address_radar_business.forward_strategy_generations FROM stdin;\\ngeneration\\t1000\\n\\\\.')\n")
        self.restore.chmod(0o700)
        self.settings = {
            'backupRoot': str(self.output), 'runId': 'run-1',
            'pgDump': str(self.binary), 'pgDumpSha256': hashlib.sha256(self.binary.read_bytes()).hexdigest(),
            'pgRestore': str(self.restore), 'pgRestoreSha256': hashlib.sha256(self.restore.read_bytes()).hexdigest(),
            'passfile': str(self.passfile), 'host': '/run/postgresql', 'port': 5432,
            'database': 'address_radar', 'schema': 'address_radar_business', 'username': 'radar_backup',
            'timeoutSeconds': 5, 'maximumBytes': 4096, 'minimumFreeBytes': 3 * 1024**3,
        }

    def run_backup(self, **overrides):
        return self.tool.backup(dict(self.settings, **overrides))

    def assert_no_success(self, run_id='run-1'):
        self.assertFalse((self.output / ('last-good-' + run_id + '.json')).exists())

    def test_success_hashes_archive_and_publishes_private_receipt(self):
        result = self.run_backup()
        receipt_path = Path(result['receipt']['path'])
        receipt = json.loads(receipt_path.read_bytes())
        archive = Path(receipt['archive']['path'])
        self.assertEqual(receipt['archive']['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(receipt['archive']['bytes'], 105)
        self.assertEqual(result['receipt']['sha256'], hashlib.sha256(receipt_path.read_bytes()).hexdigest())
        self.assertFalse(receipt['restoreVerified'])
        self.assertTrue(receipt['readOnlyRequested'])
        self.assertEqual(receipt['schema'], 'address_radar_business')
        self.assertEqual(receipt['generationHashEncoding'], 'pg-restore-table-data-sql-v1')
        self.assertRegex(receipt['generationHash'], '^[a-f0-9]{64}$')
        for path in [archive, receipt_path, Path(result['lastGood']['path'])]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
        self.assertEqual(stat.S_IMODE(archive.parent.stat().st_mode), 0o700)

    def test_dump_arguments_keep_schema_data_and_scrub_ambient_credentials(self):
        captured = self.root / 'argv.json'
        self.configure_binary("open(" + repr(str(captured)) + ", 'w').write(json.dumps({'argv':sys.argv[1:],'env':dict(os.environ)}))\nos.write(1,b'PGDMPdata')")
        with mock.patch.dict(os.environ, {'PGPASSWORD': 'secret', 'PGSERVICE': 'unsafe-service', 'SECRET_TOKEN': 'secret'}):
            self.run_backup()
        recorded = json.loads(captured.read_bytes())
        args = recorded['argv']
        for value in ['--format=custom', '--no-owner', '--no-acl', '--strict-names', '--no-password', '--schema=address_radar_business']:
            self.assertIn(value, args)
        for value in ['--schema-only', '--clean', '--create', '--enable-row-security']:
            self.assertNotIn(value, args)
        for key in ['PGPASSWORD', 'PGSERVICE', 'SECRET_TOKEN']:
            self.assertNotIn(key, recorded['env'])
        self.assertIn('default_transaction_read_only=on', recorded['env']['PGOPTIONS'])
        self.assertTrue(recorded['env']['PGPASSFILE'].startswith('/dev/fd/'))

    def test_non_root_refused_before_creating_artifacts(self):
        with mock.patch.object(self.tool.os, 'geteuid', return_value=12345):
            with self.assertRaisesRegex(self.tool.BackupError, 'root_required'):
                self.run_backup()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_private_and_ancestor_permissions_are_enforced(self):
        for mode in [0o777, 0o775, 0o755, 0o750]:
            with self.subTest(mode=mode):
                self.output.chmod(mode)
                with self.assertRaises(self.tool.BackupError):
                    self.run_backup()
                self.output.chmod(0o700)
        self.root.chmod(0o777)
        with self.assertRaises(self.tool.BackupError):
            self.run_backup()
        self.root.chmod(0o700)

    def test_directory_symlink_is_refused(self):
        link = self.root / 'linked'
        link.symlink_to(self.output, target_is_directory=True)
        with self.assertRaises((self.tool.BackupError, OSError)):
            self.run_backup(backupRoot=str(link))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_ancestor_symlink_is_refused(self):
        link = self.root / 'ancestor'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises((self.tool.BackupError, OSError)):
            self.run_backup(backupRoot=str(link / 'backups'))

    def test_passfile_symlink_hardlink_and_readable_mode_are_refused(self):
        symlink = self.root / 'linked-passfile'
        symlink.symlink_to(self.passfile)
        with self.assertRaises((self.tool.BackupError, OSError)):
            self.run_backup(passfile=str(symlink))
        self.passfile.chmod(0o644)
        with self.assertRaises(self.tool.BackupError):
            self.run_backup()
        self.passfile.chmod(0o600)
        os.link(self.passfile, self.root / 'hardlinked-passfile')
        with self.assertRaises(self.tool.BackupError):
            self.run_backup()

    def test_binary_sha_and_version_are_pinned(self):
        with self.assertRaisesRegex(self.tool.BackupError, 'binary_pin'):
            self.run_backup(pgDumpSha256='0' * 64)
        self.configure_binary(version='15.9')
        with self.assertRaisesRegex(self.tool.BackupError, 'pg16_required'):
            self.run_backup()
        self.assert_no_success()

    def test_run_collision_preserves_existing_artifact(self):
        run = self.output / 'run-1'
        run.mkdir(mode=0o700)
        sentinel = run / 'business.dump'
        sentinel.write_bytes(b'old-backup')
        with self.assertRaises((self.tool.BackupError, OSError)):
            self.run_backup()
        self.assertEqual(sentinel.read_bytes(), b'old-backup')

    def test_success_marker_collision_is_refused_before_dump(self):
        marker = self.output / 'last-good-run-1.json'
        marker.write_bytes(b'old-marker')
        marker.chmod(0o600)
        with self.assertRaises((self.tool.BackupError, OSError)):
            self.run_backup()
        self.assertEqual(marker.read_bytes(), b'old-marker')
        self.assertFalse((self.output / 'run-1').exists())

    def test_size_cap_retains_bounded_partial(self):
        self.configure_binary("os.write(1,b'PGDMP'+b'x'*10000)")
        with self.assertRaisesRegex(self.tool.BackupError, 'size_cap'):
            self.run_backup(maximumBytes=64)
        self.assertLessEqual((self.output / 'run-1' / 'business.dump.partial').stat().st_size, 64)
        self.assert_no_success()

    def test_disk_floor_refuses_before_launch(self):
        with mock.patch.object(self.tool, 'available_bytes', return_value=0):
            with self.assertRaisesRegex(self.tool.BackupError, 'disk_floor'):
                self.run_backup()
        self.assertFalse((self.output / 'run-1').exists())

    def test_disk_floor_is_rechecked_during_dump(self):
        with mock.patch.object(self.tool, 'available_bytes', side_effect=[10**12, 0]):
            with self.assertRaisesRegex(self.tool.BackupError, 'disk_floor'):
                self.run_backup()
        self.assert_no_success()

    def test_timeout_kills_child_and_preserves_partial(self):
        self.configure_binary("os.write(1,b'PGDMP');time.sleep(30)")
        with self.assertRaisesRegex(self.tool.BackupError, 'deadline'):
            self.run_backup(timeoutSeconds=1)
        self.assertTrue((self.output / 'run-1' / 'business.dump.partial').exists())
        self.assert_no_success()

    def test_failed_dump_preserves_previous_last_good_and_hides_secret(self):
        first = self.run_backup()
        marker = Path(first['lastGood']['path'])
        previous = marker.read_bytes()
        self.configure_binary("os.write(1,b'PGDMPpartial');os.write(2,b'postgres://user:SECRET@host');sys.exit(1)")
        with self.assertRaisesRegex(self.tool.BackupError, '^dump_failed$'):
            self.run_backup(runId='run-2')
        self.assertEqual(marker.read_bytes(), previous)
        self.assertTrue((self.output / 'run-2' / 'business.dump.partial').exists())
        self.assert_no_success('run-2')

    def test_invalid_archive_magic_is_not_last_good(self):
        self.configure_binary("os.write(1,b'not-a-postgres-dump')")
        with self.assertRaisesRegex(self.tool.BackupError, 'archive_magic'):
            self.run_backup()
        self.assert_no_success()

    def test_missing_generation_table_refuses_success(self):
        self.restore.write_text('#!' + sys.executable + '\nimport sys\n'
            "if '--version' in sys.argv: print('pg_restore (PostgreSQL) 16.4')\n"
            "else: print('no generation table')\n")
        self.settings['pgRestoreSha256'] = hashlib.sha256(self.restore.read_bytes()).hexdigest()
        with self.assertRaisesRegex(self.tool.BackupError, 'generation_missing'):
            self.run_backup()
        self.assert_no_success()

    def test_generation_hash_projection_is_offline_and_content_bound(self):
        captured = self.root / 'restore-argv.json'
        projection = 'COPY address_radar_business.forward_strategy_generations FROM stdin;\nexample\t1000\n\\.\n'
        self.restore.write_text('#!' + sys.executable + '\nimport sys,json\n'
            "if '--version' in sys.argv: print('pg_restore (PostgreSQL) 16.4')\n"
            "elif '--list' in sys.argv: print('1; 0 100 TABLE DATA address_radar_business forward_strategy_generations radar_backup')\n"
            'else:\n    open(' + repr(str(captured)) + ",'w').write(json.dumps(sys.argv[1:]))\n    sys.stdout.write(" + repr(projection) + ')\n')
        self.settings['pgRestoreSha256'] = hashlib.sha256(self.restore.read_bytes()).hexdigest()
        result = self.run_backup()
        receipt = json.loads(Path(result['receipt']['path']).read_bytes())
        self.assertEqual(receipt['generationHash'], hashlib.sha256(projection.encode()).hexdigest())
        args = json.loads(captured.read_bytes())
        self.assertIn('--file=-', args)
        self.assertIn('--table=forward_strategy_generations', args)
        self.assertFalse(any(arg.startswith('--dbname') for arg in args))

    def test_stderr_is_bounded_and_never_persisted(self):
        self.configure_binary("os.write(2,b'SECRET'*20000);os.write(1,b'PGDMPdata')")
        with self.assertRaisesRegex(self.tool.BackupError, 'diagnostic_cap'):
            self.run_backup()
        self.assert_no_success()
        for path in (self.output / 'run-1').iterdir():
            self.assertNotIn(b'SECRET', path.read_bytes())

    def test_receipt_publish_failure_does_not_create_last_good(self):
        with mock.patch.object(self.tool, 'publish_json', side_effect=self.tool.BackupError('publication_failed')):
            with self.assertRaisesRegex(self.tool.BackupError, 'publication_failed'):
                self.run_backup()
        self.assert_no_success()
        self.assertTrue((self.output / 'run-1' / 'business.dump').exists())

    def test_fsync_failure_never_advances_last_good(self):
        with mock.patch.object(self.tool.os, 'fsync', side_effect=OSError('secret disk detail')):
            with self.assertRaises(OSError):
                self.run_backup()
        self.assert_no_success()

    def test_success_preserves_all_previous_backups_and_markers(self):
        first = self.run_backup()
        old = {path: path.read_bytes() for path in [Path(first['receipt']['path']), Path(first['lastGood']['path']), self.output / 'run-1' / 'business.dump']}
        self.run_backup(runId='run-2')
        for path, raw in old.items():
            self.assertEqual(path.read_bytes(), raw)

    def test_invalid_settings_are_rejected(self):
        cases = [{'runId': '../escape'}, {'schema': 'public'}, {'schema': 'pg_catalog'}, {'host': 'db.example.com'},
                 {'maximumBytes': 0}, {'minimumFreeBytes': -1}, {'timeoutSeconds': 0}, {'timeoutSeconds': 301},
                 {'database': 'postgres'}, {'port': 0}, {'username': 'root;SQL'}, {'unexpected': 'secret'}]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(self.tool.BackupError):
                self.run_backup(**case)

    def test_cli_errors_are_fixed_codes_without_tracebacks_or_secrets(self):
        config = self.root / 'config.json'
        config.write_text(json.dumps(self.settings))
        config.chmod(0o600)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(self.tool, 'backup', side_effect=OSError('SECRET credential detail')):
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(self.tool.main(['--config', str(config)]), 1)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(json.loads(err.getvalue()), {'status': 'refused', 'code': 'io_refused'})


class BackupTemplateTest(unittest.TestCase):
    def test_templates_are_separate_and_timer_requires_parent_interval(self):
        root = Path(__file__).parents[2] / 'deployment' / 'systemd'
        service = (root / 'address-radar-postgres-backup.service').read_text()
        timer = (root / 'address-radar-postgres-backup.timer.in').read_text()
        self.assertIn('RestrictAddressFamilies=AF_UNIX', service)
        self.assertIn('UMask=0077', service)
        self.assertNotIn('[Install]', service)
        self.assertIn('@PARENT_APPROVED_BACKUP_INTERVAL@', timer)
        self.assertNotIn('Persistent=true', timer)


if __name__ == '__main__':
    unittest.main()
