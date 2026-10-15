import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('code_material', Path(__file__).parents[1]/'prepare-code-only-release-material.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def fixture():
    current = {'authority':{'releaseSha256':'old'},'deployment':{'releaseRoot':'old','cutover':{'addressOnly':{'releaseSha256':'old'}},'wallet':{'limit':32}},
        'settings':{'budget':60},'environment':{'source':'same'}}
    payload = {'current':current,'stage':{'release':{'root':'/new','releaseSha256':'new','entryPin':{'sha256':'entry'}}},'outputDirectory':'/private/candidate'}
    expected = copy.deepcopy(current)
    expected['authority']['releaseSha256']='new'
    expected['deployment']['releaseRoot']='/new'
    expected['deployment']['cutover']['addressOnly']['releaseSha256']='new'
    files,pins={},{}
    for name in ('authority','deployment','settings'):
        raw=json.dumps(expected[name])+'\n'
        files[name+'.json']={'raw':raw,'sha256':hashlib.sha256(raw.encode()).hexdigest()}
        pins[name]={'path':'/private/candidate/'+name+'.json','sha256':files[name+'.json']['sha256']}
    expected['environment'].update(ADDRESS_RADAR_POSTGRES_RELEASE_SHA256='new',ADDRESS_RADAR_POSTGRES_ENTRY_SHA256='entry')
    for name,suffix in [('authority','AUTHORITY'),('deployment','DEPLOYMENT'),('settings','CONFIGURED_PREFLIGHT')]:
        expected['environment']['ADDRESS_RADAR_POSTGRES_'+suffix+'_FILE']=pins[name]['path']
        expected['environment']['ADDRESS_RADAR_POSTGRES_'+suffix+'_SHA256']=pins[name]['sha256']
    raw=json.dumps(expected['environment'])+'\n'
    files['environment.json']={'raw':raw,'sha256':hashlib.sha256(raw.encode()).hexdigest()}
    pins['environment']={'path':'/private/candidate/environment.json','sha256':files['environment.json']['sha256']}
    summary={'status':'CANDIDATE_ONLY','activationReady':False,'releaseSha256':'new','sourceConfigurationUnchanged':True,
        'authorityFreshnessVerified':False,'protectedInputsVerified':False,'actualReleaseVerified':False,
        'originLifecycleVerified':False,'nativePreflightPassed':False,'productionWrites':False}
    return payload,{'files':files,'pins':pins,'summary':summary}


class CrossCheckTests(unittest.TestCase):
    def test_accepts_exact_rebinding(self):
        p,r=fixture()
        self.assertEqual(set(m.validate_generated(p,r)),set(r['files']))

    def test_rejects_budget_drift_with_matching_hash(self):
        p,r=fixture()
        raw=json.dumps({'budget':61})+'\n'
        sha=hashlib.sha256(raw.encode()).hexdigest()
        r['files']['settings.json']={'raw':raw,'sha256':sha}
        r['pins']['settings']['sha256']=sha
        with self.assertRaises(ValueError):m.validate_generated(p,r)

    def test_rejects_boolean_to_number_with_consistent_hashes(self):
        p,r=fixture()
        p['current']['settings']['enabled']=False
        raw=json.dumps({'budget':60,'enabled':0})+'\n'
        sha=hashlib.sha256(raw.encode()).hexdigest()
        r['files']['settings.json']={'raw':raw,'sha256':sha}
        r['pins']['settings']['sha256']=sha
        env=json.loads(r['files']['environment.json']['raw'])
        env['ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256']=sha
        raw=json.dumps(env)+'\n'
        sha=hashlib.sha256(raw.encode()).hexdigest()
        r['files']['environment.json']={'raw':raw,'sha256':sha}
        r['pins']['environment']['sha256']=sha
        with self.assertRaisesRegex(ValueError,'nonrelease_material_drift'):m.validate_generated(p,r)

    def test_rejects_numeric_false_in_summary(self):
        p,r=fixture();r['summary']['activationReady']=0
        with self.assertRaisesRegex(ValueError,'summary_overclaim'):m.validate_generated(p,r)

    def test_json_comparison_preserves_nested_types(self):
        self.assertFalse(m.json_equal({'items':[False]}, {'items':[0]}))
        self.assertFalse(m.json_equal([True], [1]))
        self.assertTrue(m.json_equal(1, 1.0))
        self.assertFalse(m.json_equal(None, False))
        self.assertFalse(m.json_equal([1], [1,2]))
        self.assertTrue(m.json_equal({'b':[False,None],'a':1}, {'a':1,'b':[False,None]}))

    def test_accepts_equivalent_json_number_representation(self):
        p,r=fixture();p['current']['settings']['budget']=60.0
        m.validate_generated(p,r)

    def test_rejects_hash_mismatch(self):
        p,r=fixture();r['files']['settings.json']['sha256']='wrong'
        with self.assertRaisesRegex(ValueError,'result_hash'):m.validate_generated(p,r)

    def test_rejects_foreign_output(self):
        p,r=fixture();r['pins']['settings']['path']='/other'
        with self.assertRaisesRegex(ValueError,'result_pin'):m.validate_generated(p,r)

    def test_rejects_activation_claim(self):
        p,r=fixture();r['summary']['activationReady']=True
        with self.assertRaisesRegex(ValueError,'summary_overclaim'):m.validate_generated(p,r)

    def test_rejects_extra_file(self):
        p,r=fixture();r['files']['extra.json']={}
        with self.assertRaisesRegex(ValueError,'result_files'):m.validate_generated(p,r)


if __name__ == '__main__':unittest.main()
