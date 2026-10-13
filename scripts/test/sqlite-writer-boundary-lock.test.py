import fcntl
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'sqlite-writer-boundary-lock.py'
SPEC = importlib.util.spec_from_file_location('boundary_lock', PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InheritedDescriptionTests(unittest.TestCase):
    def test_shared_lock_survives_helper_exit_until_parent_fd_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'lock'
            path.write_bytes(b'')
            path.chmod(0o644)
            parent = os.open(path, os.O_RDONLY)
            other = os.open(path, os.O_RDONLY)
            value = os.fstat(parent)
            code = ('import importlib.util,os,sys;'
                    's=importlib.util.spec_from_file_location("helper",sys.argv[1]);'
                    'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
                    'm.acquire_fd(int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),os.getuid())')
            try:
                subprocess.run([sys.executable, '-I', '-B', '-c', code, str(PATH), str(parent),
                                str(value.st_dev), str(value.st_ino)], pass_fds=(parent,),
                               check=True, timeout=3, capture_output=True)
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.close(parent)
                parent = None
                fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if parent is not None:
                    os.close(parent)
                os.close(other)

    def test_replaced_inode_is_refused(self):
        with tempfile.TemporaryFile() as handle:
            os.fchmod(handle.fileno(), 0o644)
            value = os.fstat(handle.fileno())
            with self.assertRaises(MODULE.Refused):
                MODULE.acquire_fd(handle.fileno(), value.st_dev, value.st_ino + 1, os.getuid())

    def test_abnormal_permissions_refused(self):
        with tempfile.NamedTemporaryFile() as handle:
            os.fchmod(handle.fileno(), 0o666)
            value = os.fstat(handle.fileno())
            with self.assertRaises(MODULE.Refused):
                MODULE.acquire_fd(handle.fileno(), value.st_dev, value.st_ino, os.getuid())

    def test_wrong_owner_refused(self):
        with tempfile.NamedTemporaryFile() as handle:
            os.fchmod(handle.fileno(), 0o644)
            value = os.fstat(handle.fileno())
            with self.assertRaises(MODULE.Refused):
                MODULE.acquire_fd(handle.fileno(), value.st_dev, value.st_ino, os.getuid() + 1)


if __name__ == '__main__':
    unittest.main()
