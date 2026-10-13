"""Disposable native recovery over an actually committed isolated importer result."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import unittest

SCRIPTS = Path(__file__).parents[1]

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

@unittest.skipUnless(os.environ.get('ADDRESS_RADAR_EXECUTE_NATIVE_RECOVERY') == '1'
    and sys.platform == 'linux' and os.geteuid() == 0 and Path('/.dockerenv').exists(),
    'dedicated disposable systemd/PG container required')
class NativeRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.native = load('execute_real_native', 'address-only-native-fence.py')
        cls.reconcile = load('execute_real_reconcile', 'address-only-pg-reconcile.py')
        committed = json.loads(Path('/tmp/committed.json').read_text())
        assert committed['protocol'] == 'address-only-isolated-committed-recovery-v1'
        cls.binding = committed['binding']
        cls.manifest_fields = committed['manifestFields']
        target = cls.binding['target']
        assert target['database'].startswith('radar_rehearsal_')
        assert cls.binding['generationId'].startswith('isolated-recovery-')
        assert target['systemIdentifier'] != '7693392208475083526'
        root = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
        root.mkdir(mode=0o755,parents=True,exist_ok=True)
        source = Path('/var/lib/address-radar');source.mkdir(mode=0o711)
        backup = root/'backup';backup.mkdir(mode=0o700)
        with sqlite3.connect(source/'address-radar.db') as db:
            db.execute('CREATE TABLE fixture(value TEXT)')
            db.execute("INSERT INTO fixture VALUES('isolated-only')")
        db.close()
        n, r = cls.native, cls.reconcile
        n.SOURCE_DIRECTORY, n.SOURCE = str(source), str(source/'address-radar.db')
        n.MASK_DIRECTORY = str(root/'units')
        Path(n.MASK_DIRECTORY).mkdir(mode=0o755,exist_ok=True)
        n.CONTROL, n.BACKUP_DIRECTORY = str(root/'control'), str(backup)
        n.PROTECTED_UNITS = ()
        n.WRITER_UNITS = tuple('address-radar-'+s+'.service' for s in
            ('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'))
        # Only target selection changes; all SQL observations, classification and
        # same-session lock proof remain the real reconciliation implementation.
        r.DATABASE, r.SCHEMA = target['database'], target['schema']
        r.SYSTEM, r.FINGERPRINT = target['systemIdentifier'], target['schemaFingerprint']
        original_sql, original_proof = r.reconciliation_sql, r.lock_proof_sql
        def scoped_sql(binding):
            lock, observation = original_sql(binding)
            return lock, observation.replace('address_radar_business.', r.SCHEMA+'.').replace(
                "usename='address_radar_migrator'", "usename='radar_migrator_0123456789abcdef'")
        def scoped_proof(operation):
            return original_proof(operation).replace("usename='address_radar_migrator'",
                "usename='radar_migrator_0123456789abcdef'")
        r.reconciliation_sql, r.lock_proof_sql = scoped_sql, scoped_proof
        for unit in n.WRITER_UNITS:
            Path(n.MASK_DIRECTORY,unit).write_text('[Service]\nUser=nobody\nEnvironmentFile='+str(root/'initial.env')+'\nExecStart='+str(root/'bin/sleep')+' infinity\n')
        cls.command(['systemctl','daemon-reload'])
        cls.command(['systemctl','start',*n.WRITER_UNITS])
        unbound = json.loads(json.dumps(cls.binding));unbound['planSha256'] = None
        fence = n.NativeSourceFence(cls.binding['operationId'], n.Deadline(90), import_binding=unbound)
        try:
            fence.stop_writers()
            fence.backup_and_seal()
            fence.bind_import_plan(cls.binding['planSha256'])
            fence.mark_import_intent()
            fence.reconcile_committed_import(r.reconcile_import, recovery_seconds=30)
            assert fence.state['phase'] == 'IMPORT_COMMITTED'
            cls.identities = {unit:dict(record['identity']) for unit,record in fence.state['guards'].items()}
            cls.measurement = fence.measure()
        finally:
            fence.close()

    @staticmethod
    def command(args):
        subprocess.run(args,check=True,timeout=15,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)

    def test_real_recover_reconciles_committed_binding_and_original_anchors(self):
        n, r = self.native, self.reconcile
        fence = n.NativeSourceFence.recover(n.Deadline(30))
        try:
            with r.reconcile_import(self.binding, fence.deadline) as outcome:
                fence._validate_outcome(outcome, self.binding)
                self.assertTrue(outcome['importExists'] and outcome['committedMatches'])
                with fence._recovery_guard(outcome):
                    self.assertEqual(fence.measure()['binding'], self.binding)
                    fence._assert_writers_blocked()
                    self.assertEqual({u:dict(v['identity']) for u,v in fence.state['guards'].items()}, self.identities)
        finally:
            fence.close()

    def test_wrong_plan_is_rejected_and_original_fence_stays_blocked(self):
        n, r = self.native, self.reconcile
        wrong = json.loads(json.dumps(self.binding));wrong['planSha256'] = 'f'*64
        fence = n.NativeSourceFence.recover(n.Deadline(30))
        try:
            with self.assertRaisesRegex(ValueError,'committed_import_conflict'):
                with r.reconcile_import(wrong, fence.deadline):
                    self.fail('conflicting real ledger must not reconcile')
            self.assertEqual(fence.journal.read()['phase'], 'IMPORT_COMMITTED')
            fence._assert_writers_blocked()
            for unit in n.WRITER_UNITS:
                subprocess.run(['systemctl','start',unit],timeout=10,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                self.assertEqual(n.unit_state(unit,fence.deadline)['MainPID'],'0')
        finally:
            fence.close()

    def test_z_actual_original_activation_reaches_complete_without_receipt_fabrication(self):
        import hashlib
        base = load('execute_original_activation','activate-address-only-postgres.py')
        controller = load('execute_original_controller','run-address-only-native-controller.py')
        root = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
        controller.ROOT = Path('/var/lib/address-radar-maintenance-tools')
        operation = self.binding['operationId']
        output = root/('address-only-run-'+operation);output.mkdir(mode=0o700)
        def pin(path):
            return {'path':str(path),'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest()}
        native_pin = pin(SCRIPTS/'address-only-native-fence.py')
        reconcile_pin = pin(SCRIPTS/'address-only-pg-reconcile.py')
        node = str(root/'bin/node')
        generator = pin(root/'tools/waiting-generator.mjs')
        config = {'protocol':'address-only-controller-v1','operationId':operation,
            'fence':native_pin,'reconcile':reconcile_pin,'exporter':generator,'validator':generator,
            'launcher':generator,'node':pin(node),'outputDirectory':str(output),
            'jobTemplate':{'operationId':operation,'action':'plan','outputDirectory':str(output),'sourceFence':native_pin}}
        base.durable(root/'original-controller-config.json',base.encode(config))
        original_load = controller.load_module
        def scoped_load(name, value):
            controller.pinned_read(value)
            if value == native_pin:return self.native
            if value == reconcile_pin:return self.reconcile
            return original_load(name,value)
        controller.load_module = scoped_load
        release = str(root/'release')
        inventory = base.release_inventory(release,lambda:None)
        measured = self.measurement
        manifest = {'protocol':'address-only-v1',**self.binding,**self.manifest_fields,
            'releaseSha256':inventory['releaseSha256'],'backupSha256':measured['backupSha256'],
            'fenceSha256':measured['fenceSha256'],'gatewayDeliveryEnabled':False,
            'fomoEnabled':False,'fullHistoricalMiningEnabled':False}
        base.durable(output/'address-only-manifest.json',base.encode(manifest))
        auth = root/'auth';auth.mkdir(mode=0o700)
        (root/'runtime').mkdir(mode=0o755)
        for service in base.SERVICES:
            username = 'radar_0123456789abcdef_'+service.replace('-','_')
            credential = {'service':service,'username':username,'gatewayDeliveryEnabled':False,
                'connectionString':'postgresql://'+username+':isolated-password@127.0.0.1:5432/'+self.binding['target']['database']}
            base.durable(auth/(service+'.json'),base.encode(credential))
        isolated_job = {'protocol':'address-only-isolated-activation-v1','operationId':operation,
            'target':self.binding['target'],'generationId':self.binding['generationId'],
            'roles':{s:'radar_0123456789abcdef_'+s.replace('-','_') for s in base.SERVICES},
            'deadlineAtMs':int(time.time()*1000)+240000}
        job_path = root/'isolated-activation.json'
        base.durable(job_path,base.encode(isolated_job))
        capability = base._verify_isolated_target(controller,config,generator,pin(job_path),release,node)
        for service in base.SERVICES:
            credential = base.private_json(auth/(service+'.json'))
            self.assertEqual(base.credential_url(credential,service,isolated_target=capability),credential['connectionString'])
            with self.assertRaisesRegex(ValueError,'service_credential_target'):
                base.credential_url(dict(credential,connectionString=credential['connectionString'].replace(self.binding['target']['database'],'wrong_database')),service,isolated_target=capability)
            with self.assertRaisesRegex(ValueError,'service_credential_binding'):
                base.credential_url(dict(credential,username='wrong_role'),service,isolated_target=capability)
            with self.assertRaises(ValueError):
                base.credential_url(credential,service)
        try:
            receipt = base.activate_isolated(controller,config,generator,pin(job_path),release=release,node=node)
        except Exception:
            deployment=root/'runtime'/('postgresql-'+operation)/'deployment.json'
            if deployment.exists():
                subprocess.run([node,str(root/'tools/fixture.mjs'),'--runtime-probe',str(deployment),str(auth/'automation.json')],timeout=10,check=False)
            raise
        self.assertEqual(receipt['sourceMonitoring'],'waiting_configuration')
        state = base.private_json(output/'activation-state.json')
        self.assertEqual(state['phase'],'COMPLETE')
        self.assertEqual(state['receipt'],receipt)

    def test_zb_build_complete_replacement_materials_and_install_fixture_authority(self):
        import shutil
        root = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
        shutil.copytree(root/'release', root/'new-release')
        entry = root/'new-release/scripts/postgres-service-entry.mjs'
        entry.chmod(0o600)
        with entry.open('a') as stream:
            stream.write('\n// Isolated fixture release identity.\n')
        entry.chmod(0o444)
        base = load('execute_material_inventory', 'activate-address-only-postgres.py')
        base.durable(root/'new-release-inventory.json',base.encode(base.release_inventory(str(root/'new-release'),lambda:None)))
        subprocess.run([str(root/'bin/node'),str(root/'tools/materials.mjs'),'--fixture'],check=True,timeout=15)
        target=self.binding['target']
        grants=subprocess.check_output([str(root/'bin/node'),str(root/'tools/fixture.mjs'),'--configured-grants',
            target['database'],target['schema'],self.binding['generationId']],timeout=10)
        self.assertLess(len(grants),1048576)
        sql = grants+(root/'fixture-authority-install.sql').read_bytes()
        subprocess.run(['/usr/bin/sudo','-n','-u','postgres','/usr/lib/postgresql/16/bin/psql','-X','-q',
            '-v','ON_ERROR_STOP=1','-d',self.binding['target']['database']],input=sql,
            stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=10,check=True)
        print('ISOLATED_FIXTURE_AUTHORITY_COMMITTED',flush=True)

    def test_zc_prepare_actual_native_execute_environment(self):

        root = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
        output = root/('address-only-run-'+self.binding['operationId'])
        self.assertEqual(json.loads((output/'activation-state.json').read_bytes())['phase'], 'COMPLETE')
        subprocess.run(['/usr/bin/python3', '-I', '-B', str(SCRIPTS/'test/prepare-source-execute-native-environment.py')],
                       timeout=10, check=True)
        prepared = json.loads((root/'native-environment.json').read_bytes())
        self.assertTrue(prepared['migratorExpired'])
        self.assertFalse(prepared['rotationExecuted'])
        self.assertFalse(prepared['productionProof'])

    def test_zz_real_complete_state_at_execute_runtime_boundary(self):

        import hashlib
        root=Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
        output=root/('address-only-run-'+self.binding['operationId'])
        state=json.loads((output/'activation-state.json').read_bytes())
        self.assertEqual(state['phase'],'COMPLETE')
        self.assertEqual(state['receipt']['sourceMonitoring'],'waiting_configuration')
        def pin(path):
            return {'path':str(path),'sha256':hashlib.sha256(Path(path).read_bytes()).hexdigest()}
        completed={'state':pin(output/'activation-state.json'),'receipt':pin(output/'activation-receipt.json'),
            'config':pin(root/'original-controller-config.json'),'isolatedJob':pin(root/'isolated-activation.json'),
            'manifest':pin(output/'address-only-manifest.json'),'activationModule':pin(SCRIPTS/'activate-address-only-postgres.py'),
            'unitFragments':{service:pin(root/'units'/('address-radar-'+service+'.service')) for service in state['units']}}
        execute=load('execute_real_runtime_boundary','execute-pg-source-replacement.py')
        evidence=json.loads((root/'runtime-proof.json').read_bytes())
        base=load('execute_completed_digest_observer','activate-address-only-postgres.py')
        config=json.loads((root/'original-controller-config.json').read_bytes())
        manifest=json.loads((output/'address-only-manifest.json').read_bytes())
        checks={'phaseComplete':state['phase']=='COMPLETE','pendingClear':state.get('pending') is None,
            'receiptEqual':state['receipt']==json.loads((output/'activation-receipt.json').read_bytes()),
            'operationEqual':state['operationId']==config['operationId'],
            'generatorEqual':state['generator']==config['launcher'],
            'configActivationEncoding':state['configSha256']==hashlib.sha256(base.encode(config)).hexdigest(),
            'configExecuteEncoding':state['configSha256']==hashlib.sha256(execute.encode(config)).hexdigest(),
            'manifestActivationEncoding':state['manifestSha256']==hashlib.sha256(base.encode(manifest)).hexdigest(),
            'manifestExecuteEncoding':state['manifestSha256']==hashlib.sha256(execute.encode(manifest)).hexdigest()}
        print(json.dumps({'event':'isolated_completed_admission_predicates','checks':checks},sort_keys=True),flush=True)
        execute.verify_isolated_runtime(root,evidence,completed=completed)
        print('ISOLATED_EXECUTE_COMPLETED_ADMISSION_OK',flush=True)

    def test_zzz_call_real_execute_over_complete_original_activation(self):
        subprocess.run(['/usr/bin/python3','-I','-B',str(SCRIPTS/'test/execute-source-complete-job-fixture.py')],
                       check=True,timeout=245)

if __name__ == '__main__':


    unittest.main(verbosity=2)
