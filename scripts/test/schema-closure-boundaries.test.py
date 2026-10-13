import importlib.util
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
r=Path(__file__).resolve().parents[1]
def load(name,path):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('bounded_observer',r/'diagnose-production-migrator-authentication.py')
b=load('bounded_builder',r/'build-production-postgres-schema-candidate.py')
class ClosureTests(unittest.TestCase):
    def test_each_stream_incremental_caps_and_cleanup(self):
        for module in (m,b):
            for stream in (1,2):
                child=subprocess.Popen(['python3','-c',f'import os;os.write({stream},b"x"*131072)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    with self.assertRaises(PermissionError):module.bounded_communicate(child,b'',5,65536)
                finally:
                    if child.poll() is None:child.kill()
                    child.wait()
                    for pipe in (child.stdin,child.stdout,child.stderr):
                        if not pipe.closed:pipe.close()
    def test_actual_crossprocess_flock_exclusion_until_owner_exit(self):
        import fcntl
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'operation.lock';p.write_bytes(b'');fd=os.open(p,os.O_RDONLY)
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            script='import os,fcntl,sys;f=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'
            result=subprocess.run(['python3','-c',script,str(p)],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            os.close(fd)
            self.assertEqual(subprocess.run(['python3','-c',script,str(p)],capture_output=True).returncode,0)

class InheritedLockTests(unittest.TestCase):
    def test_exec_shared_description_retains_lock_after_measurement_duplicate_closes(self):
        import fcntl
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'operation.lock';p.write_bytes(b'');fd=os.open(p,os.O_RDONLY)
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            child=subprocess.Popen(['python3','-c','import os,fcntl,sys;f=int(sys.argv[1]);g=os.dup(f);fcntl.flock(g,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(g);print("held",flush=True);sys.stdin.readline()',str(fd)],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE)
            try:
                self.assertEqual(child.stdout.readline(),b'held\n');os.close(fd);fd=None
                probe=subprocess.run(['python3','-c','import os,fcntl,sys;f=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(p)],capture_output=True)
                self.assertNotEqual(probe.returncode,0)
            finally:
                child.stdin.close();child.wait(timeout=5);child.stdout.close()
                if fd is not None:os.close(fd)
            probe=subprocess.run(['python3','-c','import os,fcntl,sys;f=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',str(p)],capture_output=True)
            self.assertEqual(probe.returncode,0)

if __name__=='__main__':unittest.main()
