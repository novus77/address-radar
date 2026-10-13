import importlib.util
from pathlib import Path
import unittest
import json
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('reconcile',Path(__file__).resolve().parents[1]/'address-only-pg-reconcile.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def binding():
    return {'operationId':'op','importId':'import','generationId':'generation','planSha256':'a'*64,
      'target':{'database':m.DATABASE,'schema':m.SCHEMA,'schemaFingerprint':m.FINGERPRINT,
        'systemIdentifier':m.SYSTEM,'serverAddress':'127.0.0.1','serverPort':5432}}
def observation():
    return {'system':m.SYSTEM,'database':m.DATABASE,'port':5432,
      'schemaIdentity':[{'singleton':True,'ledger_format':1,'database_name':m.DATABASE,
                         'schema_name':m.SCHEMA,'generation_id':'generation'}],
      'schemaLedger':[{'version':3,'fingerprint':m.FINGERPRINT}],
      'importerSessions':0,'ledger':[],'cohortCount':0,'generationCount':0}

def lock_proof():
    return {'backendPid':123,'transactionStartedAt':'2026-10-08 12:00:00+00',
            'lockHeld':True,'idleTimeout':'0','isolation':'read committed','readOnly':'on',
            'importerSessions':0}

class FakeDeadline:
    def check(self):
        pass

class FakeSession:
    def __init__(self, observed=None):
        self.deadline=FakeDeadline()
        self.child=SimpleNamespace(poll=lambda:None)
        self.lock_identity=None
        self.operation_id=None
        self.proof=lock_proof()
        self.observed=observed or observation()
        self.commands=[]
        self.closed=False
        self.idle_setting=b'0'
    def exchange(self,sql):
        self.commands.append(sql)
        if 'lockHeld' in sql:
            return json.dumps(self.proof).encode()
        if 'schemaIdentity' in sql:
            return json.dumps(self.observed).encode()
        if sql.strip().startswith("SELECT current_setting('idle_in_transaction_session_timeout')"):
            return self.idle_setting
        return b''
    def assert_alive_and_locked(self):
        return m.Session.assert_alive_and_locked(self)
    def close(self):
        self.closed=True
        self.child=None
class Reconciliation(unittest.TestCase):
    def test_absence_requires_no_importers_and_exact_target(self):
        self.assertFalse(m.classify(binding(),observation())['importExists'])
        for key,value in [('importerSessions',1),('system','other'),('port',5433),('schemaIdentity',[])]:
            with self.assertRaises(ValueError):m.classify(binding(),dict(observation(),**{key:value}))
    def test_matching_committed_import_and_conflict(self):
        b=binding();row={'import_id':b['importId'],'generation_id':b['generationId'],'source_fingerprint':b['planSha256'],
          'proof_scope':'address_only_registry','revoked_at':None}
        o=dict(observation(),ledger=[row],cohortCount=216,generationCount=1)
        self.assertTrue(m.classify(b,o)['committedMatches'])
        for key,value in [('source_fingerprint','b'*64),('revoked_at',1),('generation_id','other')]:
            with self.assertRaises(ValueError):m.classify(b,dict(o,ledger=[dict(row,**{key:value})]))
    def test_lock_precedes_fresh_observation_and_values_are_escaped(self):
        b=binding();b['importId']="owner's import"
        lock,query=m.reconciliation_sql(b)
        self.assertIn('pg_advisory_xact_lock',lock);self.assertIn("owner''s import",query)
        with self.assertRaises(ValueError):m.literal('unsafe\nvalue')
    def test_ambiguous_or_incomplete_commit_never_allows_restore(self):
        with self.assertRaises(ValueError):m.classify(binding(),dict(observation(),ledger=[{},{}]))
        with self.assertRaises(ValueError):m.classify(binding(),dict(observation(),ledger=[{}]))
    def test_actual_schema_identity_and_latest_version_fingerprint_are_required(self):
        original=observation()
        header=original['schemaIdentity'][0]
        for key,value in [('singleton',False),('ledger_format',2),('database_name','other'),
                          ('schema_name','other'),('generation_id','other')]:
            with self.subTest(field=key),self.assertRaisesRegex(ValueError,'schema_identity'):
                m.classify(binding(),dict(original,schemaIdentity=[dict(header,**{key:value})]))
        for rows in ([],[{'version':2,'fingerprint':m.FINGERPRINT}],
                     [{'version':4,'fingerprint':m.FINGERPRINT}], [{'version':3,'fingerprint':'a'*64}],
                     [{'version':3,'fingerprint':m.FINGERPRINT}]*2):
            with self.assertRaisesRegex(ValueError,'schema_ledger'):
                m.classify(binding(),dict(original,schemaLedger=rows))
        with self.assertRaisesRegex(ValueError,'schema_identity'):
            m.classify(binding(),dict(original,schemaIdentity=[header,header]))
        with self.assertRaises(ValueError):
            m.classify(binding(),dict(original,schemaIdentity=[],schemaExists=True))
    def test_query_reads_actual_schema_header_and_latest_ledger(self):
        _,query=m.reconciliation_sql(binding())
        self.assertIn('business_schema_identity',query)
        self.assertIn('business_schema_ledger',query)
        self.assertIn('ORDER BY version DESC',query)
        self.assertNotIn('schemaExists',query)
    def test_context_disables_and_confirms_idle_timeout_before_lock_and_exposes_guard(self):
        session=FakeSession()
        with patch.object(m,'Session',return_value=session):
            # Keep the real method available while the constructor is replaced.
            session.assert_alive_and_locked=lambda:real_assert(session)
            with m.reconcile_import(binding(),FakeDeadline()) as outcome:
                guard=outcome['assert_alive_and_locked']
                self.assertTrue(callable(guard))
                proof=guard()
                self.assertEqual(proof['backendPid'],123)
                self.assertFalse(session.closed)
        self.assertTrue(session.closed)
        begin=session.commands[0]
        self.assertIn('ISOLATION LEVEL READ COMMITTED',begin)
        self.assertIn('idle_in_transaction_session_timeout=0',begin)
        confirmation=next(i for i,q in enumerate(session.commands) if q.startswith("SELECT current_setting('idle_in_transaction_session_timeout')"))
        lock=next(i for i,q in enumerate(session.commands) if 'pg_advisory_xact_lock' in q)
        observation_index=next(i for i,q in enumerate(session.commands) if 'schemaIdentity' in q)
        self.assertLess(confirmation,lock)
        self.assertLess(lock,observation_index)
        with self.assertRaisesRegex(ValueError,'session_closed'):
            guard()
    def test_nonzero_idle_timeout_confirmation_refuses_before_lock(self):
        session=FakeSession();session.idle_setting=b'120s'
        with patch.object(m,'Session',return_value=session):
            with self.assertRaisesRegex(ValueError,'idle_timeout'):
                with m.reconcile_import(binding(),FakeDeadline()):
                    self.fail('unconfirmed session yielded')
        self.assertFalse(any('pg_advisory_xact_lock' in q for q in session.commands))
        self.assertTrue(session.closed)
    def test_guard_detects_lost_lock_session_replacement_and_transaction_drift(self):
        for key,value in [('lockHeld',False),('backendPid',456),('transactionStartedAt','different'),
                          ('idleTimeout','1min'),('isolation','repeatable read'),('readOnly','off'),
                          ('importerSessions',1)]:
            session=FakeSession();session.operation_id='op'
            real_assert(session)
            session.proof[key]=value
            with self.subTest(field=key),self.assertRaises(ValueError):
                real_assert(session)
    def test_each_mutation_can_recheck_actual_lock_and_abort_on_disconnect(self):
        session=FakeSession();mutations=[]
        with patch.object(m,'Session',return_value=session):
            session.assert_alive_and_locked=lambda:real_assert(session)
            with self.assertRaisesRegex(ValueError,'session_exited'):
                with m.reconcile_import(binding(),FakeDeadline()) as outcome:
                    outcome['assert_alive_and_locked']();mutations.append('first')
                    session.child.poll=lambda:1
                    outcome['assert_alive_and_locked']();mutations.append('second')
        self.assertEqual(mutations,['first'])
        self.assertTrue(session.closed)
    def test_lock_query_checks_exact_64bit_operation_key_on_current_backend(self):
        session=FakeSession();session.operation_id="owner's operation"
        real_assert(session)
        query=next(q for q in session.commands if 'lockHeld' in q)
        for fragment in ('pg_locks','pg_backend_pid()','classid','objid','objsubid=1','granted',
                         "owner''s operation",'ExclusiveLock'):
            self.assertIn(fragment,query)
        self.assertTrue(any('pg_stat_clear_snapshot' in q for q in session.commands))

real_assert=getattr(m.Session,'assert_alive_and_locked',lambda _: (_ for _ in ()).throw(AssertionError('missing lock guard')))
if __name__=='__main__':unittest.main()
