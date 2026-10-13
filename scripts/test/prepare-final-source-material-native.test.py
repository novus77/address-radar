"""Real producer CLI composition in the disposable offline native assembler fixture.

No reader or semantic boundary is mocked. All authority, origin and release
metadata are synthetic; this proves file preparation, not DB or production proof.
"""
import importlib.util
import copy
import json
import os
from pathlib import Path
import secrets
import subprocess
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('producer_native_inputs', SCRIPTS/'test/assemble-production-source-native.test.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ProducerNativeTests(fixture.NativeAssemblyTests):
    def setUp(self):
        super().setUp()
        bundle = Path(os.environ['FINAL_SOURCE_PRODUCER_BUNDLE']).read_bytes()
        generator = self.write('producer.mjs', bundle)
        cli = self.copy_script('prepare-final-source-material.py', 'prepare-final-source-material.py')
        reader = self.copy_script('assemble-production-source-execution.py', 'assemble-production-source-execution.py')
        self.cli, self.reader = cli, reader
        self.final_directory = fixture.m.ROOT/('final-source-materials-' + self.token)
        source = self.source
        at = int(fixture.m.time.time()*1000)
        old_manifest = copy.deepcopy(source['material']['deployment']['cutover']['addressOnly'])
        old_manifest.update(protocol='address-only-v1', importId='fixture-cohort', planSha256=fixture.digest(b'original-plan'),
            gatewayDeliveryEnabled=False, fomoEnabled=False, fullHistoricalMiningEnabled=False,
            target={'database':'address_radar','schema':'address_radar_business','systemIdentifier':'7693392208475083526'})
        current_manifest = dict(old_manifest, releaseSha256=fixture.digest(b'configured-current-release'))
        source['material']['authority']['releaseSha256'] = current_manifest['releaseSha256']
        source['material']['deployment']['cutover']['addressOnly'] = current_manifest
        trusted_key = {'validatorId':'fixture-validator','keyId':'fixture-key','publicKey':'fixture-only-public-key',
            'actorId':'fixture-validator-actor','authorizationRef':'existing-validator-approval',
            'reviewedSourceProviders':['solana-official-replay']}
        source['material']['authority']['validator'].update({key:trusted_key[key] for key in ('validatorId','keyId','publicKey')})
        source['material']['authority']['publisher']['validators'] = [trusted_key]
        configuration = dict(trusted_key,kind='execution',importId='fixture-validator-import',
            evidenceSha256=fixture.digest(b'fixture-existing-authority-evidence'),importedAt=at-1000,
            validFrom=at-1000,validUntil=at+180000)
        runtime_authority = {'approvalRef':'existing-validator-import-approval','target':dict(old_manifest['target'],generationId=self.generation),
            'validators':[configuration]}
        # Export existing pure functions only from a separate fixture copy, never the CLI bundle.
        fixture_module = self.write('producer-fixture.mjs',bundle +
            b'\nexport {runtimeAuthorityFingerprint,createSourceReplacementPlan,migrationCutoverCanonicalJson};\n')
        fixture_runner = self.write('producer-fixture-runner.mjs',b"""import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {runtimeAuthorityFingerprint,createSourceReplacementPlan,migrationCutoverCanonicalJson} from './producer-fixture.mjs';
const {source,runtime}=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const configuration=runtime.validators[0];
const fingerprint=runtimeAuthorityFingerprint({approvalRef:runtime.approvalRef,proofScope:'validator_authority',configuration});
source.material.settings.validators=[{kind:'execution',validatorId:configuration.validatorId,importId:configuration.importId,sourceFingerprint:fingerprint}];
source.trustedReviewSha256=createHash('sha256').update(migrationCutoverCanonicalJson(source.review)).digest('hex');
const plan=createSourceReplacementPlan(source);
fs.writeFileSync(process.argv[3],JSON.stringify({input:source,replacementSha256:plan.replacementSha256}),{flag:'wx',mode:384});
""")
        draft = self.write('producer-source-draft',{'source':source,'runtime':runtime_authority})
        plan_result = self.directory/'producer-plan.json'
        subprocess.run([self.node['path'],'--no-global-search-paths',fixture_runner['path'],draft['path'],str(plan_result)],
            check=True,timeout=5,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        result = json.loads(plan_result.read_bytes()); source = result['input']; self.producer_source = source
        current = {name:self.write('producer-current-'+name,body) for name,body in source['material'].items()}
        original_pin = self.write('producer-manifest',old_manifest)
        pinned_original = json.loads(Path(original_pin['path']).read_bytes())
        binding = {key:pinned_original[key] for key in ('target','operationId','generationId','importId','planSha256')}
        current_hash = fixture.digest(json.dumps(dict(pinned_original,releaseSha256=current_manifest['releaseSha256']),
            separators=(',',':'),ensure_ascii=True).encode())
        receipt_body = {'protocol':'address-only-configured-transition-receipt-v1','operationId':self.operation,
            'generationId':self.generation,'importId':old_manifest['importId'],'transitionId':'configured-current-'+self.token,
            'releaseSha256':current_manifest['releaseSha256'],'newManifestSha256':current_hash,
            'sourceMonitoring':'configured_pending_observation','databaseImported':True,'newImportPerformed':False,
            'businessReleaseSwitched':True,'monitoringCompleted':False,'businessEligibilityGranted':False,
            'gatewayDeliveryEnabled':False,'fomoEnabled':False,'fullHistoricalMiningEnabled':False}
        waiting = {'phase':'COMPLETE','pending':None,'operationId':self.operation,
            'receipt':{'sourceMonitoring':'waiting_configuration'},'measurement':{'binding':binding},
            'manifestSha256':fixture.digest(json.dumps(pinned_original,separators=(',',':'),ensure_ascii=True).encode())}
        state_body = {'phase':'COMPLETE','pending':None,'operationId':self.operation,'receipt':receipt_body,
            'transitionId':receipt_body['transitionId'],'release':{'releaseSha256':current_manifest['releaseSha256']},
            'newManifestSha256':current_hash,'node':self.node,'walletServiceUser':self.wallet,'measurement':{'binding':binding}}
        origin = {'oldState':self.write('producer-waiting-state',waiting),'originalManifest':original_pin,
            'configuredOrigin':{'journal':self.write('producer-current-state',state_body),
                'receipt':self.write('producer-current-receipt',receipt_body),
                'releaseRoot':source['material']['deployment']['releaseRoot'],'node':self.node}}
        transition_id = 'next-transition-'+self.token
        stage = {'protocol':'address-only-code-stage-receipt-v1','status':'CODE_STAGED_ONLY','stageOnly':True,
            'authorizationRef':self.approval,'transitionId':transition_id,'release':self.release,
            'nativeNode':{'pin':self.node},'permanentPins':{key:origin[key] for key in ('oldState','originalManifest')},'fixtureOnly':True}
        evidence = {'protocol':'address-only-final-source-material-approval-v1','purpose':'source_material_preparation',
            'approvalRef':self.approval,'generationId':self.generation,'trustedReviewSha256':source['trustedReviewSha256'],
            'replacementSha256':result['replacementSha256'],'validFrom':at-1000,'validUntil':at+120000,'revoked':False}
        self.envelope = {'protocol':'address-only-final-source-material-inputs-v1','transitionId':transition_id,
            'walletServiceUser':self.wallet,'runtimeAuthority':self.write('producer-runtime-authority',runtime_authority),
            'sourceInput':self.write('producer-source',source),'review':self.write('producer-review',source['review']),
            'approvalEvidence':self.write('producer-evidence',evidence),'currentPins':current,
            'stageReceipt':self.write('producer-stage',stage),'origin':origin,'node':self.node,'generator':generator}

    def invoke(self):
        inputs = self.write('producer-inputs-'+secrets.token_hex(4),self.envelope)
        return subprocess.run([self.python['path'],'-I','-B',self.cli['path'],'--inputs',inputs['path'],
            '--inputs-sha256',inputs['sha256'],'--output-directory',str(self.final_directory),
            '--reader-sha256',self.reader['sha256']],timeout=30,stdout=subprocess.PIPE,stderr=subprocess.PIPE)

    def test_real_producer_validator_files_receipt_and_exclusive_output(self):
        result = self.invoke()
        self.assertEqual(result.returncode,0,result.stdout.decode())
        self.assertEqual(result.stderr,b'')
        public = json.loads(result.stdout)
        receipt_path = Path(public['receipt']['path'])
        raw = receipt_path.read_bytes()
        self.assertEqual(fixture.digest(raw),public['receipt']['sha256'])
        receipt = json.loads(raw)
        self.assertEqual(receipt['status'],'PREPARED_NOT_EXECUTED')
        for key in ('activationPerformed','productionProof','ledgerVerified','retryAuthorized','executionDeadlineGenerated'):
            self.assertFalse(receipt[key])
        final = {}
        pins = {}
        for filename,reference in receipt['files'].items():
            raw = Path(reference['path']).read_bytes()
            self.assertEqual(fixture.digest(raw),reference['sha256'])
            final[filename.removesuffix('.json')] = json.loads(raw)
            pins[filename.removesuffix('.json')] = reference
        payload = {'input':self.producer_source,'replacementSha256':receipt['sourceSummary']['replacementSha256'],
            'approvalRef':self.approval,'generationId':self.generation,'releaseRoot':self.release['root'],
            'releaseSha256':self.release['releaseSha256'],'entrySha256':self.release['entryPin']['sha256'],
            'finalMaterial':final,'finalPins':{key:pins[key] for key in ('authority','deployment','settings')}}
        checked = fixture.m.ProtectedReader().validate_material(self.node,self.validator,payload)
        self.assertEqual(checked,receipt['sourceSummary'])
        self.assertEqual(final['authority']['privateKey'],self.producer_source['material']['authority']['privateKey'])
        self.assertEqual(final['authority']['publisher'],self.producer_source['material']['authority']['publisher'])
        self.assertFalse({'importedAt','validFrom','validUntil'}.intersection(final['authority']['publisher']['validators'][0]))
        self.assertEqual(final['deployment']['cutover']['addressOnly']['operationId'],self.operation)
        self.assertEqual(len({self.approval,self.operation,self.envelope['transitionId']}),3)
        before = {path.name:path.read_bytes() for path in self.final_directory.iterdir()}
        self.assertNotEqual(self.invoke().returncode,0)
        self.assertEqual({path.name:path.read_bytes() for path in self.final_directory.iterdir()},before)

    def test_missing_invalid_evidence_sha_with_synchronized_fingerprint_has_no_output(self):
        original_envelope = copy.deepcopy(self.envelope)
        for evidence_sha in (None, 'invalid'):
            with self.subTest(evidence_sha=evidence_sha):
                self.envelope = copy.deepcopy(original_envelope)
                runtime = json.loads(Path(self.envelope['runtimeAuthority']['path']).read_bytes())
                if evidence_sha is None:
                    del runtime['validators'][0]['evidenceSha256']
                else:
                    runtime['validators'][0]['evidenceSha256'] = evidence_sha
                token = secrets.token_hex(4)
                draft = self.write('invalid-evidence-draft-'+token, {'source':self.producer_source,'runtime':runtime})
                result_path = self.directory/('invalid-evidence-plan-'+token+'.json')
                # The real existing fingerprint and source-plan functions synchronize
                # all dependent hashes: rejection must not rely on stale fingerprints.
                subprocess.run([self.node['path'],'--no-global-search-paths',
                    str(self.directory/'producer-fixture-runner.mjs'),draft['path'],str(result_path)],
                    check=True,timeout=5,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                result = json.loads(result_path.read_bytes())
                self.envelope['sourceInput'] = self.write('invalid-evidence-source-'+token,result['input'])
                self.envelope['currentPins']['settings'] = self.write('invalid-evidence-settings-'+token,
                    result['input']['material']['settings'])
                self.envelope['runtimeAuthority'] = self.write('invalid-evidence-runtime-'+token,runtime)
                evidence = json.loads(Path(self.envelope['approvalEvidence']['path']).read_bytes())
                evidence['replacementSha256'] = result['replacementSha256']
                self.envelope['approvalEvidence'] = self.write('invalid-evidence-approval-'+token,evidence)
                response = self.invoke()
                self.assertNotEqual(response.returncode,0)
                self.assertEqual(json.loads(response.stdout)['status'],'REFUSED_NOT_EXECUTED')
                self.assertFalse(self.final_directory.exists())

    def test_expired_independent_validator_import_has_no_output(self):
        runtime = json.loads(Path(self.envelope['runtimeAuthority']['path']).read_bytes())
        runtime['validators'][0]['validUntil'] = 0
        self.envelope['runtimeAuthority'] = self.write('producer-expired-runtime',runtime)
        self.assertNotEqual(self.invoke().returncode,0)
        self.assertFalse(self.final_directory.exists())

    def test_expired_evidence_has_no_output(self):
        evidence = json.loads(Path(self.envelope['approvalEvidence']['path']).read_bytes())
        evidence['validUntil'] = 0
        self.envelope['approvalEvidence'] = self.write('producer-expired-evidence',evidence)
        self.assertNotEqual(self.invoke().returncode,0)
        self.assertFalse(self.final_directory.exists())

    def test_changed_current_material_has_no_output(self):
        current = json.loads(Path(self.envelope['currentPins']['authority']['path']).read_bytes())
        current['validator']['validationTtlMs'] += 1
        self.envelope['currentPins']['authority'] = self.write('producer-changed-authority',current)
        self.assertNotEqual(self.invoke().returncode,0)
        self.assertFalse(self.final_directory.exists())

    def test_tampered_dependency_has_no_output(self):
        path = Path(self.envelope['review']['path'])
        path.chmod(0o644); path.write_bytes(path.read_bytes()+b' '); path.chmod(0o444)
        self.assertNotEqual(self.invoke().returncode,0)
        self.assertFalse(self.final_directory.exists())


def load_tests(loader, tests, pattern):
    # Reuse fixture setup without rerunning inherited assembler-only cases.
    return unittest.TestSuite(ProducerNativeTests(name) for name in ProducerNativeTests.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main()
