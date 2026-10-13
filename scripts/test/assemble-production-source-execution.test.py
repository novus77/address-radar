"""Production assembly contracts; no database, service or provider access."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('assembly', Path(__file__).parents[1] / 'assemble-production-source-execution.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.documents = {}
        def pin(name, body=None):
            value = {'path': '/var/lib/address-radar-maintenance-tools/' + name, 'sha256': 'a' * 64}
            self.documents[value['path']] = json.dumps(body or {}).encode()
            return value
        self.pin = pin
        release = '/opt/address-radar/releases/address-only-test'
        sha = 'b' * 64
        deployment = pin('deployment', {'releaseRoot': release, 'operationId': 'test',
            'generationId': 'production-20261006-v1', 'cutover': {'addressOnly': {'releaseSha256': sha}},
            'driver': {'schemaVersion': 3, 'schemaFingerprint': 'e' * 64},
            'gatewayDeliveryEnabled': False, 'fomoEnabled': False, 'fullHistoricalMiningEnabled': False})
        environment = pin('environment', {key: 'false' for key in (
            'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
            'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED')})
        self.put(environment, {**self.read(environment), 'ADDRESS_RADAR_POSTGRES_RELEASE_SHA256': sha})
        transition = pin('transition', {'protocol': 'address-only-configured-transition-v1', 'deadlineAtMs': 121000,
            'authorizationRef': 'approved', 'releaseRoot': release, 'releaseSha256': sha,
            'deployment': deployment, 'environment': environment,
            **{key: pin(key) for key in ('oldState', 'originalManifest', 'node', 'nativeVerifier')}})
        request = pin('request', {'protocol': 'address-only-pg-source-fence-v1', 'operationId': 'test',
            'authorizationRef': 'approved', 'replacementSha256': 'c' * 64, 'generationId': 'production-20261006-v1',
            'deadlineAtMs': 121000, 'publishedFiles': []})
        target = {'systemIdentifier': '7693392208475083526', 'database': 'address_radar',
                  'schema': 'address_radar_business', 'username': 'address_radar_migrator',
                  'generation': 'production-20261006-v1', 'service': 'migrator', 'serverAddress': '127.0.0.1', 'serverPort': 5432}
        self.materials = {'protocol': 'address-only-production-execution-materials-v1', 'operationId': 'test',
            'approvalRef': 'approved', 'replacementSha256': 'c' * 64, 'rotationNonce': 'd' * 16,
            'fenceRequest': request, 'transition': transition, 'controllerConfig': pin('config', {'operationId': 'test'}),
            'importTemplate': pin('import', {'input': pin('input'), 'target': target}),
            'probeTemplate': pin('probe', {'protocol': 'address-only-configured-source-probe-job-v1',
                'deployment': deployment, 'environment': environment}),
            'stageReceipt': pin('stage', {'protocol': 'address-only-code-stage-receipt-v1', 'status': 'CODE_STAGED_ONLY',
                'stageOnly': True, 'release': {'root': release, 'releaseSha256': sha}}),
            'controllerPins': {key: pin(key) for key in m.CONTROLLERS},
            'tools': {key: pin('tool-' + key) for key in m.TOOLS},
            **{key: pin(key) for key in ('adapter', 'sequence', 'selfPin')}}

        self.materials['materialValidator'] = pin('material-validator')
        request_doc = self.read(request)
        request_doc.update(oldProviderId='old-source', oldOrigin='https://old.example',
                           newProviderId='publicnode', newOrigin='https://solana-rpc.publicnode.com')
        self.put(request, request_doc)
        transition_doc = self.read(transition)
        transition_doc.update(transitionId='transition-test', resourcePolicy=dict(m.CONFIGURED_POLICY),
            walletServiceUser={'user':'wallet','group':'wallet','uid':1002,'gid':1002},
            node=self.materials['tools']['node'])
        self.put(transition, transition_doc)
        config = {'protocol':'address-only-controller-v1','operationId':'test',
            'fence':self.materials['controllerPins']['fence'],'node':self.materials['tools']['node'],
            'jobTemplate':{'operationId':'test','action':'plan','outputDirectory':str(m.ROOT/'address-only-run-test'),
                'sourceFence':self.materials['controllerPins']['fence']},'outputDirectory':str(m.ROOT/'address-only-run-test'),
            **{key:pin('config-'+key) for key in ('reconcile','exporter','validator','launcher')}}
        self.put(self.materials['controllerConfig'], config)
        target.update(schemaVersion=3,schemaFingerprint='e'*64)
        self.put(self.materials['importTemplate'], {'input':pin('input'), 'target':target})
        authority, settings = pin('authority'), pin('settings')
        env = self.read(environment)
        for key,value in (('AUTHORITY',authority),('CONFIGURED_PREFLIGHT',settings),('DEPLOYMENT',deployment)):
            env['ADDRESS_RADAR_POSTGRES_'+key+'_FILE']=value['path']
            env['ADDRESS_RADAR_POSTGRES_'+key+'_SHA256']=value['sha256']
        self.put(environment,env)
        self.put(self.materials['probeTemplate'], {'protocol':'address-only-configured-source-probe-job-v1',
            'deadlineAtMs':121000,'deployment':deployment,'environment':environment,'authority':authority,
            'settings':settings,'runtimeAuthority':pin('runtime'),'credential':pin('credential'),
            'payload':pin('payload'),'maximumRunMs':5000,'maximumBodyBytes':2097152})
        stage=self.read(self.materials['stageReceipt'])
        stage.update(authorizationRef='approved',transitionId='transition-test',
            nativeNode={'pin':{**self.materials['tools']['node'],'mode':'0555'}},
            permanentPins={key:{**transition_doc[key],'mode':'0444'} for key in ('oldState','originalManifest')})
        stage['release']['entryPin']=pin('entry')
        self.put(self.materials['stageReceipt'],stage)
        self.put(transition_doc['oldState'], {'phase':'COMPLETE','operationId':'test',
            'receipt':{'sourceMonitoring':'waiting_configuration'}})
        self.put(transition_doc['originalManifest'], {'operationId':'test','generationId':'production-20261006-v1'})
        self.materials['selfPin']=pin('execute-pg-source-replacement.py')
        outer=self
        class Reader:
            def __call__(self,pin,**kwargs):
                return outer.documents[pin['path']]
            def verify_wallet(self,identity):
                m.require(identity=={'user':'wallet','group':'wallet','uid':1002,'gid':1002},'wallet_identity')
            def verify_release(self,release):
                m.require(release['root']==release_root,'release_scope')
            def validate_material(self,node,validator,payload):
                return {**outer.read(request), 'approvalRef':'approved'}
        release_root=release
        self.reader=Reader()

    def read(self, pin):

        return json.loads(self.documents[pin['path']])

    def put(self, pin, document):
        self.documents[pin['path']] = json.dumps(document).encode()

    def mutate(self, key, field, value):
        pin = self.materials[key]
        self.put(pin, {**self.read(pin), field: value})

    def assemble(self):
        return m.assemble(self.materials, self.reader, 1000)

    def test_production_job_matches_executor_shape_without_execution(self):
        job = self.assemble()
        self.assertEqual(job['protocol'], 'address-only-source-replacement-execution-v1')
        self.assertEqual(job['deadlineAtMs'], 121000)
        self.assertFalse(any(key.startswith('isolated') for key in job))
        self.assertNotIn('stageReceipt', job)
        self.assertEqual(job['outputDirectory'], str(m.ROOT / 'source-replacement-execution-test'))

    def test_isolated_extra_fields_are_refused(self):
        self.materials['isolatedIdentity'] = self.pin('identity')
        with self.assertRaisesRegex(ValueError, 'materials_shape'):
            self.assemble()

    def test_deadlines_are_not_renewed(self):
        for deadline in (1000, 61000, 241001, True):
            self.mutate('fenceRequest', 'deadlineAtMs', deadline)
            with self.subTest(deadline=deadline), self.assertRaisesRegex(ValueError, 'deadline'):
                self.assemble()

    def test_authorization_and_generation_must_match(self):
        for key, field, value in (('fenceRequest', 'authorizationRef', 'other'),
                                  ('fenceRequest', 'generationId', 'other'),
                                  ('transition', 'authorizationRef', 'other')):
            previous = copy.deepcopy(self.documents)
            self.mutate(key, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.assemble()
            self.documents = previous

    def test_release_receipt_must_match_transition(self):
        self.mutate('stageReceipt', 'release', {'root': '/wrong', 'releaseSha256': 'b' * 64})
        with self.assertRaisesRegex(ValueError, 'staged_release'):
            self.assemble()

    def test_nonproduction_target_refused(self):
        pin = self.materials['importTemplate']
        document = self.read(pin)
        document['target']['database'] = 'radar_rehearsal_0123456789abcdef'
        self.put(pin, document)
        with self.assertRaisesRegex(ValueError, 'production_target'):
            self.assemble()

    def test_probe_must_use_exact_final_materials(self):
        self.mutate('probeTemplate', 'environment', self.pin('other'))
        with self.assertRaisesRegex(ValueError, 'probe_binding'):
            self.assemble()

    def test_enabled_gateway_refused(self):
        transition = self.read(self.materials['transition'])
        deployment = self.read(transition['deployment'])
        deployment['gatewayDeliveryEnabled'] = True
        self.put(transition['deployment'], deployment)
        with self.assertRaisesRegex(ValueError, 'safety_flags'):
            self.assemble()

    def test_noncanonical_pin_refused(self):
        self.materials['selfPin']['path'] = '/private/tmp/../unsafe'
        with self.assertRaisesRegex(ValueError, 'pin_binding'):
            self.assemble()


class ExtendedAssemblyTests(AssemblyTests):
    def test_node_identity_mismatch_refused(self):
        self.mutate('transition','node',self.pin('unapproved-node'))
        with self.assertRaisesRegex(ValueError,'controller_binding'):
            self.assemble()

    def test_source_plan_result_must_bind_fence(self):
        self.reader.validate_material=lambda *args: {'replacementSha256':'f'*64}
        with self.assertRaisesRegex(ValueError,'source_plan_binding'):
            self.assemble()

    def test_missing_schema_fingerprint_refused(self):
        pin=self.materials['importTemplate']; document=self.read(pin)
        del document['target']['schemaFingerprint']; self.put(pin,document)
        with self.assertRaisesRegex(ValueError,'production_target'):
            self.assemble()

    def test_missing_probe_payload_refused(self):
        pin=self.materials['probeTemplate']; document=self.read(pin)
        del document['payload']; self.put(pin,document)
        with self.assertRaisesRegex(ValueError,'probe_binding'):
            self.assemble()

    def test_actual_release_verification_failure_propagates(self):
        def fail(release): raise ValueError('release_seal')
        self.reader.verify_release=fail
        with self.assertRaisesRegex(ValueError,'release_seal'):
            self.assemble()

    def test_wallet_identity_failure_propagates(self):
        self.mutate('transition','walletServiceUser',{'user':'root'})
        with self.assertRaisesRegex(ValueError,'wallet_identity'):
            self.assemble()

    def test_private_reference_mismatch_refused(self):
        self.mutate('probeTemplate','authority',self.pin('other-authority'))
        with self.assertRaisesRegex(ValueError,'environment_pin_binding'):
            self.assemble()


class ContractRegressionTests(AssemblyTests):
    def test_probe_cli_maximum_run_boundary(self):
        self.mutate('probeTemplate', 'maximumRunMs', 5000)
        self.assertEqual(self.assemble()['protocol'], 'address-only-source-replacement-execution-v1')
        self.mutate('probeTemplate', 'maximumRunMs', 5001)
        with self.assertRaisesRegex(ValueError, 'probe_binding'):
            self.assemble()

    def test_import_schema_version_mismatch_refused(self):
        template = self.read(self.materials['importTemplate'])
        template['target']['schemaVersion'] = 4
        self.put(self.materials['importTemplate'], template)
        with self.assertRaisesRegex(ValueError, 'import_schema_binding'):
            self.assemble()

    def test_import_schema_fingerprint_mismatch_refused(self):
        template = self.read(self.materials['importTemplate'])
        template['target']['schemaFingerprint'] = 'f' * 64
        self.put(self.materials['importTemplate'], template)
        with self.assertRaisesRegex(ValueError, 'import_schema_binding'):
            self.assemble()

    def test_matching_import_and_deployment_schema_pass(self):
        transition = self.read(self.materials['transition'])
        deployment = self.read(transition['deployment'])
        template = self.read(self.materials['importTemplate'])
        deployment['driver']['schemaFingerprint'] = 'f' * 64
        template['target']['schemaFingerprint'] = 'f' * 64
        self.put(transition['deployment'], deployment)
        self.put(self.materials['importTemplate'], template)
        self.assertEqual(self.assemble()['protocol'], 'address-only-source-replacement-execution-v1')

    def test_deployment_schema_contract_required(self):
        transition = self.read(self.materials['transition'])
        original = self.read(transition['deployment'])
        for driver in (None, {}, {'schemaVersion': True, 'schemaFingerprint': 'e' * 64},
                       {'schemaVersion': 3, 'schemaFingerprint': 'invalid'}):
            self.put(transition['deployment'], {**original, 'driver': driver})
            with self.subTest(driver=driver), self.assertRaisesRegex(ValueError, 'import_schema_binding'):
                self.assemble()

    def test_controller_job_relations(self):
        for field,value in (('outputDirectory','/wrong'),('jobTemplate',{})):
            original=copy.deepcopy(self.documents)
            self.mutate('controllerConfig',field,value)
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'controller_job_binding'):
                self.assemble()
            self.documents=original
        for field,value in (('operationId','other'),('action','execute'),('outputDirectory','/wrong'),('sourceFence',{})):
            original=copy.deepcopy(self.documents)
            config=self.read(self.materials['controllerConfig']);config['jobTemplate'][field]=value
            self.put(self.materials['controllerConfig'],config)
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,'controller_job_binding'):
                self.assemble()
            self.documents=original

    def test_exact_policy(self):
        for value in ({'mode':'configured'},dict(m.CONFIGURED_POLICY,serviceTasksMax=True),
                      dict(m.CONFIGURED_POLICY,minimumDiskBytes=0),dict(m.CONFIGURED_POLICY,extra=1)):
            self.mutate('transition','resourcePolicy',value)
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'resource_policy'):
                self.assemble()

    def test_stage_relations(self):
        for key,value in (('authorizationRef','other'),('transitionId','other'),
                          ('nativeNode',{'pin':self.pin('other-node')}),
                          ('permanentPins',{'oldState':self.pin('other-state'),'originalManifest':self.pin('originalManifest')})):
            original=copy.deepcopy(self.documents)
            self.mutate('stageReceipt',key,value)
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'stage_binding'):
                self.assemble()
            self.documents=original


class ProcessRegressionTests(unittest.TestCase):
    def run_process(self,code,raw=b'',seconds=1):
        import sys
        return m.bounded_process([sys.executable,'-c',code],raw,seconds,lambda:None)

    def test_output_and_input_are_streamed(self):
        self.assertEqual(self.run_process("import sys;data=sys.stdin.buffer.read();sys.stdout.buffer.write(str(len(data)).encode())",b'x'*200000),b'200000')

    def test_output_cap(self):
        with self.assertRaisesRegex(ValueError,'validator_output_budget'):
            self.run_process("import sys;sys.stdout.buffer.write(b'x'*8193);sys.stdout.flush()")

    def test_deadline_and_blocked_stdin(self):
        with self.assertRaisesRegex(ValueError,'validator_timeout'):
            self.run_process('import time;time.sleep(10)',b'x'*200000,seconds=.1)

    def test_descendant_retaining_pipe(self):
        with self.assertRaisesRegex(ValueError,'validator_timeout|validator_group_residual'):
            self.run_process("import subprocess,sys;subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)'])",seconds=.1)

    def test_wallet_supplementary_group_refused(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        reader=m.ProtectedReader()
        identity={'user':'wallet','group':'wallet','uid':1002,'gid':1002}
        replies=[b'wallet:x:1002:1002::/:/bin/false\n',b'wallet:x:1002:\n',b'wallet 1002 0\n']
        with patch.object(m.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=1001,pw_gid=1001)), \
                patch.object(m,'bounded_process',side_effect=replies), \
                self.assertRaisesRegex(ValueError,'wallet_supplementary_groups'):
            reader.verify_wallet(identity)

    def test_dependency_and_release_revalidation(self):
        from unittest.mock import patch
        reader=m.ProtectedReader()
        pin={'path':'/reference','sha256':'a'*64}
        reader.dependencies={'/reference':(pin,20,())}
        release={'root':'/release'}
        reader.release_snapshots={'/release':(release,[])}
        with patch.object(m.ProtectedReader,'__call__') as read,patch.object(reader,'verify_release') as verify:
            reader.revalidate()
            read.assert_called_once_with(pin,maximum=20,collect=False)
            verify.assert_called_once_with(release)

    def test_revalidation_failure_propagates(self):
        from unittest.mock import patch
        reader=m.ProtectedReader();reader.dependencies={'/x':({'path':'/x','sha256':'a'*64},20,())}
        with patch.object(m.ProtectedReader,'__call__',side_effect=ValueError('dependency_changed')), \
                self.assertRaisesRegex(ValueError,'dependency_changed'):
            reader.revalidate()


class ReaderTests(unittest.TestCase):
    def test_timeout_refused_before_read(self):
        reader=m.ProtectedReader(); reader.end=0
        with self.assertRaisesRegex(ValueError,'preparation_timeout'):
            reader({'path':'/missing','sha256':'a'*64})

    def test_production_write_requires_linux_root(self):
        from unittest.mock import patch
        with patch.object(m.sys,'platform','darwin'),self.assertRaisesRegex(ValueError,'native_root'):
            m.prepare({'path':'/missing','sha256':'a'*64},str(m.ROOT/'source-execution-preparation-test'))


if __name__ == '__main__':

    unittest.main()
