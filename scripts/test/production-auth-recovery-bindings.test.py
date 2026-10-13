import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('bindings',ROOT/'diagnose-production-migrator-authentication.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class BindingTests(unittest.TestCase):
    def fixture(self):
        source={'path':'/reviewed/prepare.py','sha256':'4'*64}
        plan={'operationId':'actual-auth','targetPins':{'systemIdentifier':'7693392208475083526'},'provisioningModule':source,'provisioningPlanSha256':'b'*64}
        credential={'expiresAtMs':1791289183648}
        pins={k:{'path':'/reviewed/'+k,'sha256':str(i)*64} for i,k in enumerate(('candidate','producer','authenticationSource','credential','journal','pinHelper'),1)}
        proof={'version':1,'kind':'pending-hba-current-native-measurement','approvalRef':'authorized-controller',
            'planSha256':hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest(),
            'candidate':pins['candidate'],'producer':pins['producer'],'authenticationSource':pins['authenticationSource'],
            'provisioningSource':source,'pinHelper':pins['pinHelper'],'provisioningPlanSha256':'b'*64,
            'credentialValidUntilMs':credential['expiresAtMs'],'targetPins':plan['targetPins'],'operationId':'actual-auth',
            'originalJournal':pins['journal'],'credential':pins['credential'],
            'authenticationSourceSha256':'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61',
            'originalPending':'hba','measuredAtMs':1791260000000,'receipts':{},'tcpAddressProof':{},
            'historicalHbaAckProved':False,'independentSoftwareTrustIssued':False,'originalJournalPreserved':True,'credentialRenewed':False}
        return plan,credential,pins,proof
    def test_complete_binding_not_existence_or_ack_conversion(self):
        p,c,pins,proof=self.fixture();before=copy.deepcopy(proof);m.validate_recovery_bindings(proof,p,c,pins);self.assertEqual(proof,before)
    def test_every_code_candidate_journal_secret_target_and_expiry_binding(self):
        for key in ('candidate','producer','authenticationSource','provisioningSource','pinHelper','originalJournal','credential',
                    'provisioningPlanSha256','targetPins','credentialValidUntilMs','planSha256','operationId'):
            p,c,pins,proof=self.fixture();proof=copy.deepcopy(proof);proof[key]='tampered'
            with self.assertRaises(PermissionError):m.validate_recovery_bindings(proof,p,c,pins)
    def test_cannot_claim_historical_ack_or_signer_truth(self):
        for key in ('historicalHbaAckProved','independentSoftwareTrustIssued','credentialRenewed'):
            p,c,pins,proof=self.fixture();proof[key]=True
            with self.assertRaises(PermissionError):m.validate_recovery_bindings(proof,p,c,pins)
    def test_consumer_hardpins_actual_producer_source(self):
        spec=importlib.util.spec_from_file_location('consumer',ROOT/'verify-production-migrator-hba-recovery.py');consumer=importlib.util.module_from_spec(spec);spec.loader.exec_module(consumer)
        self.assertEqual(consumer.PRODUCER_SHA256,hashlib.sha256((ROOT/'diagnose-production-migrator-authentication.py').read_bytes()).hexdigest())

if __name__=='__main__':unittest.main()
