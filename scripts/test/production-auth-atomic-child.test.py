import importlib.util
from pathlib import Path
import signal
import types
import unittest
from unittest.mock import patch
p=Path(__file__).resolve().parents[1]/'diagnose-production-migrator-authentication.py'
s=importlib.util.spec_from_file_location('atomic_child',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class AtomicChildTests(unittest.TestCase):
    def test_no_budget_no_spawn(self):
        calls=[]
        def budget():raise TimeoutError()
        with self.assertRaises(TimeoutError):m.guarded_owned_child(lambda *a,**k:calls.append(1),[],budget)
        self.assertEqual(calls,[])
    def test_deferred_cancel_after_pidfd_acquisition_closes_owned_child(self):
        calls=[];owned=types.SimpleNamespace(process=types.SimpleNamespace(stdin=types.SimpleNamespace(close=lambda:calls.append('eof'))),close=lambda:calls.append('pidfd-close'))
        def mask(how,values):
            if how==signal.SIG_BLOCK:calls.append('blocked');return set()
            calls.append('unblock');raise InterruptedError()
        def factory(*a,**k):calls.append('pidfd-acquired');return owned
        with patch.object(signal,'pthread_sigmask',side_effect=mask):
            with self.assertRaises(InterruptedError):m.guarded_owned_child(factory,[],lambda:1)
        self.assertEqual(calls,['blocked','pidfd-acquired','unblock','eof','pidfd-close'])
    def test_constructor_failure_restores_mask_without_numeric_signalling(self):
        calls=[]
        def factory(*a,**k):raise PermissionError()
        with patch.object(signal,'pthread_sigmask',side_effect=lambda how,v:calls.append(how) or set()):
            with self.assertRaises(PermissionError):m.guarded_owned_child(factory,[],lambda:1)
        self.assertEqual(calls,[signal.SIG_BLOCK,signal.SIG_SETMASK])

if __name__=='__main__':unittest.main()
