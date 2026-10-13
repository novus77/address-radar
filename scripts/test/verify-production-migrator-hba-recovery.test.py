"""Consumer orchestration mocks, not native authentication or production proofs."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('consumer_orchestration',ROOT/'verify-production-migrator-hba-recovery.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def encoded(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()

class ConsumerTests(unittest.TestCase):
    def run_case(self,mode='full',raw_tamper=False,code_tamper=False,native_failure=False,changed_record=False):
        producer={'path':'/protected/eac.py','sha256':m.RECORD_PRODUCER_SHA256,'uid':0,'gid':0,'mode':320,'device':'64769','inode':'1'}
        verifier={**producer,'path':'/protected/revalidator.py','sha256':m.PRODUCER_SHA256,'inode':'2'}
        proof={'producer':producer,'candidate':{'path':'/protected/plan.json'},'originalJournal':{'path':'/protected/state/journal.json'},
               'credential':{'path':'/protected/state/secrets.json'},'authenticationSource':{'path':'/protected/auth.py'},
               'receipts':{'role':{'postmasterStart':'epoch'},'hba':{'hbaSha256':'hash','tcp':{'start':'epoch'}}},'planSha256':'a'*64}
        raw=encoded(proof)+b'\n';raw_sha=hashlib.sha256(raw).hexdigest()
        record_pin={**producer,'path':'/protected/proof.json','sha256':raw_sha,'mode':384,'inode':'3'}
        reads={};calls=[]
        def file_pin(path,maximum,remaining,keep=True,mode=None):
            remaining();reads[path]=reads.get(path,0)+1
            if path==producer['path']:return dict(producer),b'protected-eac-code'
            if path==verifier['path']:
                pin=dict(verifier)
                if code_tamper:pin['sha256']='f'*64
                return pin,b'protected-revalidator-code'
            if path==record_pin['path']:
                pin=dict(record_pin)
                if changed_record and reads[path]>1:pin['inode']='4'
                return pin, raw[:-1] if raw_tamper else raw
            raise AssertionError('unexpected artifact')
        def native_main(expected_recovery_proof,verify_tcp,expected_record_producer_pin):
            calls.append((expected_recovery_proof,verify_tcp,expected_record_producer_pin))
            self.assertEqual(sys.argv,['/protected/revalidator.py','/protected/helper.py','/protected/plan.json','/protected/state'])
            self.assertEqual(os.environ['REVIEWED_AUTH_SOURCE'],'/protected/auth.py')
            receipts=json.loads(json.dumps(proof['receipts']))
            if not verify_tcp:receipts['hba'].pop('tcp')
            if native_failure:return {'status':'readonly_native_observation_refused','category':'direct_migration_identity'}
            return {'status':'readonly_state_measured' if verify_tcp else 'readonly_root_boundary_measured',
                    'tcpMeasured':verify_tcp,'measuredReceiptsSha256':hashlib.sha256(encoded(receipts)).hexdigest(),
                    'boundary':{'systemIdentifier':'7693392208475083526','databaseOid':'16391','roleOid':'16384','postmasterStart':'epoch'},
                    'serverTimeMs':'1791268828475'}
        helper=types.SimpleNamespace(file_pin=file_pin,strict_json=json.loads,encoded=encoded,
            load_module=lambda body,path,name:types.SimpleNamespace(main=native_main))
        old_argv=sys.argv;old_env=os.environ.get('REVIEWED_AUTH_SOURCE')
        with patch.object(sys,'platform','linux'),patch('os.geteuid',return_value=0),patch.object(m,'load_frozen',return_value=helper):
            if raw_tamper or code_tamper or changed_record:
                with self.assertRaises(PermissionError):m.consume('/protected/helper.py','/protected/eac.py','/protected/proof.json',raw_sha,'/protected/plan.json','/protected/state',mode,'/protected/revalidator.py')
            else:
                result=m.consume('/protected/helper.py','/protected/eac.py','/protected/proof.json',raw_sha,'/protected/plan.json','/protected/state',mode,'/protected/revalidator.py')
                if native_failure:self.assertEqual(result['status'],'recovery_native_verification_refused')
                else:
                    self.assertEqual(result['status'],'recovery_current_native_verified' if mode=='full' else 'recovery_root_boundary_verified')
                    self.assertEqual(result['tcpAuthenticationChecked'],mode=='full')
                    self.assertTrue(result['originalJournalPreserved']);self.assertFalse(result['historicalHbaAckProved'])
                self.assertEqual(len(calls),1)
        self.assertIs(sys.argv,old_argv);self.assertEqual(os.environ.get('REVIEWED_AUTH_SOURCE'),old_env)
        if raw_tamper or code_tamper:self.assertEqual(calls,[])
    def test_old_eac_producer_new_code_full_actual_measurement(self):self.run_case()
    def test_root_mode_cannot_claim_tcp_authentication(self):self.run_case(mode='root-boundary')
    def test_raw_lf_changed_refused_before_execution(self):self.run_case(raw_tamper=True)
    def test_unreviewed_revalidator_refused_before_execution(self):self.run_case(code_tamper=True)
    def test_fresh_native_failure_not_converted_to_ack(self):self.run_case(native_failure=True)
    def test_record_changed_after_native_measurement_refused(self):self.run_case(changed_record=True)

if __name__=='__main__':unittest.main()
