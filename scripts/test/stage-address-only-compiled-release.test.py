import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('code_stage', Path(__file__).resolve().parents[1] / 'stage-address-only-compiled-release.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class CodeStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.archive = self.root / 'code.tar'
        self.releases = self.root / 'releases'
        self.releases.mkdir()
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        self.destination = self.releases / 'address-only-test-c'
        self.receipt = self.tools / 'code-stage.json'
        self.node = self.root / 'node'
        self.node.write_bytes(b'not executed node fixture')
        self.node.chmod(0o555)
        self.original = self.root / 'manifest.json'
        self.original.write_bytes(b'original immutable manifest')
        self.original.chmod(0o444)
        self.content = {name: ('fixture:' + name).encode() for name in m.FILES}

    def make_tar(self, extra=None, omit=None, root='./'):
        with tarfile.open(self.archive, 'w', format=tarfile.USTAR_FORMAT) as tar:
            for name in (root, 'scripts/', *m.FILES):
                if name == omit:
                    continue
                item = tarfile.TarInfo(name)
                if name in (root, 'scripts/'):
                    item.type = tarfile.DIRTYPE
                    item.mode = 0o700
                    tar.addfile(item)
                else:
                    data = self.content[name]
                    item.mode = 0o600
                    item.size = len(data)
                    tar.addfile(item, io.BytesIO(data))
            if extra:
                extra(tar)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def run_stage(self, expected=None):
        def test_directory_policy(fd):
            self.assertTrue(stat.S_ISDIR(os.fstat(fd).st_mode))
        with patch.multiple(m, ROOT_UID=os.geteuid(), ROOT_GID=os.getegid(), RELEASE_PARENT=str(self.releases),
                            RECEIPT_PARENT=str(self.tools), NODE=(str(self.node), m.digest(self.node.read_bytes())),
                            PERMANENT={'originalManifest': (str(self.original), m.digest(self.original.read_bytes()))}), \
                patch.object(m, 'directory_policy', side_effect=test_directory_policy):
            return m.stage(str(self.archive), expected or m.digest(self.archive.read_bytes()), str(self.destination),
                           str(self.receipt), 'stability-c', 'user-authorized-code-only')

    def tearDown(self):
        # Production never removes interrupted outputs. Only test-owned files are cleaned here.
        for path in (self.destination, self.destination / 'scripts'):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o700)

    def test_seals_exact_inventory_and_records_code_only_receipt_without_executing_node(self):
        expected = self.make_tar()
        old_umask = os.umask(0o077)
        try:
            result = self.run_stage(expected)
        finally:
            os.umask(old_umask)
        receipt = result['receipt']
        self.assertEqual(receipt['status'], 'CODE_STAGED_ONLY')
        self.assertEqual(receipt['release']['releaseSha256'], m.wire_inventory(self.content)[0])
        self.assertEqual(receipt['release']['entries'], 5)
        self.assertTrue(all(value is False for value in receipt['safety'].values()))
        self.assertEqual(m.digest(self.receipt.read_bytes()), result['stageReceiptPin']['sha256'])
        self.assertEqual(json.loads(self.receipt.read_bytes()), receipt)
        for path in (self.destination, self.destination / 'scripts'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o555)
        for name, content in self.content.items():
            self.assertEqual((self.destination / name).read_bytes(), content)
            self.assertEqual(stat.S_IMODE((self.destination / name).stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)

    def test_archive_hash_and_missing_pg_fail_before_changes(self):
        self.make_tar()
        with self.assertRaises(ValueError):
            self.run_stage('0' * 64)
        self.make_tar(omit='pg.mjs')
        with self.assertRaises(ValueError):
            self.run_stage()
        self.assertFalse(self.destination.exists())
        self.assertFalse(self.receipt.exists())

    def test_links_duplicates_special_types_and_path_aliases_are_refused(self):
        cases = [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('scripts/../pg.mjs', tarfile.REGTYPE),
                 ('./pg.mjs', tarfile.REGTYPE), ('scripts//postgres-service-entry.mjs', tarfile.REGTYPE),
                 ('scripts//', tarfile.DIRTYPE), ('scripts///', tarfile.DIRTYPE), ('.//', tarfile.DIRTYPE),
                 ('._pg.mjs', tarfile.REGTYPE), ('pg.mjs', tarfile.REGTYPE), ('pg.mjs', tarfile.SYMTYPE),
                 ('pg.mjs', tarfile.LNKTYPE), ('pg.mjs', tarfile.FIFOTYPE), ('extra', tarfile.REGTYPE)]
        for name, kind in cases:
            with self.subTest(name=name, kind=kind):
                def extra(tar):
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        member.linkname = '/etc/passwd'
                    tar.addfile(member)
                self.make_tar(extra)
                with self.assertRaises(ValueError):
                    self.run_stage()
                self.assertFalse(self.destination.exists())
                self.assertFalse(self.receipt.exists())

    def test_existing_release_and_receipt_never_overwritten(self):
        self.make_tar()
        self.destination.mkdir()
        marker = self.destination / 'keep'
        marker.write_bytes(b'keep b and existing c')
        with self.assertRaisesRegex(ValueError, 'release_collision'):
            self.run_stage()
        self.assertEqual(marker.read_bytes(), b'keep b and existing c')
        self.destination.rename(self.root / 'retained')
        self.receipt.write_bytes(b'preexisting receipt')
        with self.assertRaises(FileExistsError):
            self.run_stage()
        self.assertFalse(self.destination.exists())
        self.assertEqual(self.receipt.read_bytes(), b'preexisting receipt')

    def test_symlinked_parent_or_destination_and_archive_are_not_followed(self):
        self.make_tar()
        self.destination.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'release_collision'):
            self.run_stage()
        self.assertFalse(self.receipt.exists())
        alias = self.root / 'archive-link'
        alias.symlink_to(self.archive)
        with self.assertRaises(OSError):
            m.load_archive(str(alias), m.digest(self.archive.read_bytes()))
        parent_alias = self.root / 'parent-alias'
        parent_alias.symlink_to(self.tools, target_is_directory=True)
        with patch.object(m, 'directory_policy'):
            with self.assertRaises(OSError):
                m.protected_parent(str(parent_alias / 'receipt.json'))

    def test_protected_ancestor_rejects_writable_directory(self):
        self.tools.chmod(0o777)
        fd = os.open(self.tools, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with patch.multiple(m, ROOT_UID=os.geteuid(), ROOT_GID=os.getegid()):
                with self.assertRaisesRegex(ValueError, 'unprotected_ancestor'):
                    m.directory_policy(fd)
        finally:
            os.close(fd)

    def test_pin_hash_mismatch_refuses_before_destination(self):
        self.make_tar()
        with patch.object(m, 'pin', side_effect=ValueError('pin_digest_mismatch')):
            with self.assertRaises(ValueError):
                self.run_stage()
        self.assertFalse(self.destination.exists())

    def test_noncanonical_destination_refused(self):
        self.make_tar()
        self.destination = Path(str(self.releases) + '/child/../address-only-test-c')
        with self.assertRaisesRegex(ValueError, 'noncanonical_path'):
            self.run_stage()
        self.assertFalse(self.receipt.exists())


if __name__ == '__main__':
    unittest.main()
