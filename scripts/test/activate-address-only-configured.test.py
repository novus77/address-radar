"""Contract regressions. Mock adapters are not native deployment proof."""
import copy
import json
import importlib.util
from pathlib import Path
import tempfile
import unittest

PATH = Path(__file__).parents[1] / 'activate-address-only-configured.py'

class Tests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PATH.exists(), 'configured controller must exist')
        spec = importlib.util.spec_from_file_location('configured', PATH)
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)

    def manifest(self):
        return dict(protocol='address-only-v1', operationId='op', importId='import', generationId='gen',
            activatedAt=1, planSha256='a'*64, seedSha256='b'*64, cohortSha256='c'*64,
            walletCount=216, entityCount=122, releaseSha256='d'*64, backupSha256='e'*64,
            fenceSha256='f'*64, target={'database':'db'}, gatewayDeliveryEnabled=False,
            fomoEnabled=False, fullHistoricalMiningEnabled=False)

    def test_derivation_preserves_original_and_all_nonrelease_fields(self):
        old = self.manifest(); before = copy.deepcopy(old)
        new = self.m.derive_manifest(old, '1'*64)
        self.assertEqual(old, before)
        self.assertEqual({k:v for k,v in new.items() if k!='releaseSha256'},
                         {k:v for k,v in old.items() if k!='releaseSha256'})
        self.assertEqual(new['releaseSha256'], '1'*64)

    def test_derivation_rejects_same_release_and_unsafe_flags(self):
        old = self.manifest()
        with self.assertRaises(ValueError): self.m.derive_manifest(old, old['releaseSha256'])
        for key in self.m.SAFETY:
            changed = dict(old, **{key: True})
            with self.assertRaises(ValueError): self.m.derive_manifest(changed, '1'*64)

    def proof(self):
        return dict(protocol='address-only-configured-native-preflight-v1', inputSha256='a'*64,
            measuredAtMs=1000, expiresAtMs=61000, **{key:True for key in self.m.PROOF_CHECKS},
            gatewayDeliveryEnabled=False, fomoEnabled=False, fullHistoricalMiningEnabled=False)

    def test_metadata_or_missing_authority_is_refused(self):
        for key in self.m.PROOF_CHECKS:
            proof = self.proof(); proof[key] = False
            with self.assertRaises(ValueError): self.m.validate_proof(proof, 'a'*64, 1001)
        with self.assertRaises(ValueError): self.m.validate_proof({'metadataAccepted':True}, 'a'*64, 1001)

    def test_expired_future_crossinput_and_enabled_flags_refused(self):
        for change in [dict(measuredAtMs=1002), dict(expiresAtMs=1001), dict(inputSha256='b'*64),
                       dict(gatewayDeliveryEnabled=True), dict(protocol='other')]:
            with self.assertRaises(ValueError): self.m.validate_proof(dict(self.proof(), **change), 'a'*64, 1001)
        self.m.validate_proof(self.proof(), 'a'*64, 1001)

    def test_no_stopping_when_preflight_fails(self):
        events=[]
        with self.assertRaises(ValueError):
            self.m.perform_transition(lambda: (_ for _ in ()).throw(ValueError()),
                lambda:events.append('block'), lambda:events.append('deploy'), lambda:events.append('fail'))
        self.assertEqual(events, [])

    def test_deployment_failure_reblocks_before_propagating(self):
        events=[]
        def deploy(): events.append('deploy'); raise RuntimeError('refused')
        with self.assertRaises(RuntimeError):
            self.m.perform_transition(lambda:events.append('preflight'), lambda:events.append('stop'),
                                      deploy, lambda:events.append('reblock'))
        self.assertEqual(events, ['preflight','stop','deploy','reblock'])

    def test_interrupted_stop_also_reblocks(self):
        events=[]
        def stop(): events.append('stop'); raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.m.perform_transition(lambda:None, stop, lambda:None, lambda:events.append('reblock'))
        self.assertEqual(events, ['stop','reblock'])

    def test_lock_checks_wrap_actual_probe(self):
        events=[]
        def check(): events.append('lock')
        self.assertEqual(self.m.guarded(check, lambda:events.append('probe') or 7), 7)
        self.assertEqual(events, ['lock','probe','lock'])
        with self.assertRaises(ValueError):
            self.m.guarded(lambda:(_ for _ in ()).throw(ValueError()), lambda:self.fail('lost lock'))

    def test_immutable_pin_checks_real_permissions_and_digest(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'input'; path.write_bytes(b'proof'); path.chmod(0o400)
            self.assertEqual(self.m.read_pin(dict(path=str(path),sha256=self.m.sha(b'proof')), owner=path.stat().st_uid), b'proof')
            path.chmod(0o600)
            with self.assertRaises(ValueError): self.m.read_pin(dict(path=str(path),sha256=self.m.sha(b'proof')), owner=path.stat().st_uid)

class InputPublicationRegressions(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('configured_inputs', PATH)
        self.m = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.m)

    def test_root_private_0600_data_is_accepted_but_not_as_code(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'state.json'; path.write_bytes(b'{"phase":"COMPLETE"}'); path.chmod(0o600)
            pin = dict(path=str(path), sha256=self.m.sha(path.read_bytes()))
            self.assertEqual(self.m.read_pin(pin, owner=path.stat().st_uid, sealed=False), path.read_bytes())
            with self.assertRaises(ValueError): self.m.read_pin(pin, owner=path.stat().st_uid)
            path.chmod(0o640)
            with self.assertRaises(ValueError): self.m.read_pin(pin, owner=path.stat().st_uid, sealed=False)

    def test_private_data_rejects_changed_digest_and_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'data'; path.write_bytes(b'proof'); path.chmod(0o600)
            with self.assertRaises(ValueError): self.m.read_pin(dict(path=str(path),sha256='0'*64), owner=path.stat().st_uid,sealed=False)
            link=Path(root)/'link'; link.symlink_to(path)
            with self.assertRaises(OSError): self.m.read_pin(dict(path=str(link),sha256=self.m.sha(b'proof')),owner=path.stat().st_uid,sealed=False)

    def test_deployment_digest_is_over_published_bytes_not_input_whitespace(self):
        import json
        first=b'{ "format": 1, "sources": { "leaseMs": 60000 } }\n'
        second=b'{"format":1,"sources":{"leaseMs":60000}}'
        raw_a, digest_a=self.m.deployment_publication(json.loads(first))
        raw_b, digest_b=self.m.deployment_publication(json.loads(second))
        self.assertEqual(raw_a,raw_b); self.assertEqual(digest_a,digest_b)
        self.assertEqual(digest_a,self.m.sha(raw_a)); self.assertNotEqual(digest_a,self.m.sha(first))

    def test_preflight_requires_existing_sealed_program_and_runs_independent_process(self):
        import json
        import subprocess
        import sys
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'verifier.py'
            script="import json,sys\nr=json.load(open(sys.argv[1])); print(json.dumps({'protocol':'address-only-configured-native-preflight-v1','inputSha256':r['sha'],'measuredAtMs':1000,'expiresAtMs':2000,**{k:True for k in r['checks']},**{k:False for k in r['safety']}}))\n"
            path.write_text(script); path.chmod(0o400)
            data=Path(root)/'request.json'; data.write_text(json.dumps(dict(sha='a'*64,checks=self.m.PROOF_CHECKS,safety=self.m.SAFETY)))
            calls=[]
            def execute(arguments,seconds):
                calls.append(arguments)
                # Python is a local process-boundary fixture, NOT a native PG verifier.
                return subprocess.check_output([sys.executable,'-B',arguments[2],arguments[3]],timeout=seconds)
            base=SimpleNamespace(sealed_file=lambda p,limit,check:({'sha256':self.m.sha(p.read_bytes())},b''))
            proof=self.m.execute_native_preflight(base,SimpleNamespace(bounded_child=execute),
                dict(path=str(path),sha256=self.m.sha(path.read_bytes())),sys.executable,data,'a'*64,
                lambda:None,1000,now=lambda:1001)
            self.assertTrue(proof['authorityPortsVerified']); self.assertEqual(len(calls),1)
            path.unlink()
            with self.assertRaises(FileNotFoundError):
                self.m.execute_native_preflight(base,SimpleNamespace(bounded_child=execute),
                    dict(path=str(path),sha256='a'*64),sys.executable,data,'a'*64,lambda:None,1000,now=lambda:1001)
            self.assertEqual(len(calls),1)

class WalletIdentityRegressions(unittest.TestCase):
    """Mock NSS/systemd boundaries are explicitly not native deployment proof."""
    def setUp(self):
        import types
        spec=importlib.util.spec_from_file_location('configured_wallet',PATH)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.origin=types.SimpleNamespace(pw_uid=1001,pw_gid=1001,pw_name='address-radar')
        self.identity={'user':'address-radar-wallet','group':'address-radar-wallet','uid':1101,'gid':1101}

    def test_getent_must_match_distinct_nonroot_exact_uid_gid(self):
        calls=[]
        def run(argv,seconds):
            calls.append(argv)
            if argv[1]=='initgroups':return 'address-radar-wallet 1101\n'
            return 'address-radar-wallet:x:1101:1101::/nonexistent:/usr/sbin/nologin\n' if argv[1]=='passwd' else 'address-radar-wallet:x:1101:\n'
        account=self.m.resolve_wallet_identity(self.identity,self.origin,run)
        self.assertEqual((account.pw_uid,account.pw_gid),(1101,1101));self.assertEqual(len(calls),3)
        for change in [{'uid':0},{'uid':1001},{'gid':1001},{'uid':1102},{'user':'bad\nuser'}]:
            with self.assertRaises(ValueError):self.m.resolve_wallet_identity(dict(self.identity,**change),self.origin,run)
        with self.assertRaises(ValueError):self.m.resolve_wallet_identity(self.identity,self.origin,lambda *args:'')

    def adapter(self):
        from types import SimpleNamespace
        events=[]
        class Parent:
            def __init__(inner,*args):
                inner.account=self.origin;inner.directory=Path('/etc/address-radar/configured-test')
                inner.state={};inner.check=lambda:None
            def publish(inner,service):events.append(('publish',service,inner.account.pw_uid))
            def validate_ready(inner,value,peer):
                if peer[1:]!=(inner.account.pw_uid,inner.account.pw_gid):raise ValueError('peer_identity')
                return {'service':value['service']}
            def process(inner,pid,service,child=False,parent=None):return {'startTime':'7'}
        base=SimpleNamespace(NativeActivation=Parent,validate_waiting_limits=lambda memory,tasks:None,SERVICES=('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'))
        adapter=self.m.adapter_type(base)()
        adapter.wallet_account=SimpleNamespace(pw_uid=1101,pw_gid=1101,pw_name='address-radar-wallet')
        adapter.wallet_group='address-radar-wallet'
        return adapter,events

    def test_only_wallet_unit_is_published_under_new_identity(self):
        adapter,events=self.adapter()
        adapter.publish('scanner');adapter.publish('wallet-monitor');adapter.publish('console')
        self.assertEqual(events,[('publish','scanner',1001),('publish','wallet-monitor',1101),('publish','console',1001)])
        self.assertEqual(adapter.account.pw_uid,1001)

    def test_wallet_readiness_rejects_origin_uid_or_wrong_gid(self):
        adapter,_=self.adapter()
        self.assertEqual(adapter.validate_ready({'service':'wallet-monitor'},(10,1101,1101)),{'service':'wallet-monitor'})
        for peer in [(10,1001,1001),(10,1101,1001)]:
            with self.assertRaises(ValueError):adapter.validate_ready({'service':'wallet-monitor'},peer)
        with self.assertRaises(ValueError):adapter.validate_ready({'service':'scanner'},(10,1101,1101))

    def test_readiness_recheck_uses_service_identity_not_origin_for_wallet(self):
        # Exercise the real inherited recheck contract, not a native SO_PEERCRED proof.
        spec=importlib.util.spec_from_file_location('readiness_base',PATH.with_name('activate-address-only-postgres.py'))
        original=importlib.util.module_from_spec(spec);spec.loader.exec_module(original)
        adapter,_=self.adapter()
        type(adapter).__bases__[0].verify_ready=original.NativeActivation.verify_ready
        services=('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')
        adapter.state={'units':{}}
        for i,service in enumerate(services):
            value=dict(relayProtocol='address-only-ready-relay-v1',type='postgres-service-ready',service=service,
                operationId='op',generationId='gen',releaseSha256='a'*64,nonce='b'*32,attempt='attempt',childPid=200+i,
                mainPid=100+i,invocationId='invocation',mainStartTime='1',childStartTime='2')
            adapter.state['units'][service]={'ready':value}
        peers=[]
        def validate(value,peer):
            account=adapter.account_for(value['service'])
            self.assertEqual(peer[1:],(account.pw_uid,account.pw_gid))
            peers.append((value['service'],peer))
            return dict(adapter.state['units'][value['service']]['ready'])
        adapter.validate_ready=validate
        adapter.verify_ready()
        self.assertEqual(dict(peers)['wallet-monitor'],(102,1101,1101))
        self.assertTrue(all(peer[1:]==(1001,1001) for service,peer in peers if service!='wallet-monitor'))
        self.assertEqual(adapter.account.pw_uid,1001)
        adapter.validate_ready=lambda value,peer:dict(validate(value,peer),mainStartTime='reused')
        with self.assertRaisesRegex(ValueError,'service_restarted_after_readiness'):adapter.verify_ready()

    def test_deployment_copies_have_identical_bytes_but_private_distinct_owners(self):
        adapter,_=self.adapter();published=[]
        adapter.managed=lambda path,raw,mode,owner:published.append((str(path),raw,mode,owner.pw_uid))
        adapter.journal=type('Journal',(),{'save':lambda self:None})()
        adapter.publish_deployment_copies({'format':1})
        self.assertEqual(len(published),2);self.assertEqual(published[0][1],published[1][1])
        self.assertEqual([row[2] for row in published],[0o400,0o400])
        self.assertEqual([row[3] for row in published],[1001,1101])
        self.assertEqual(adapter.deployment_path('scanner').name,'deployment.json')
        self.assertEqual(adapter.deployment_path('wallet-monitor').name,'wallet-deployment.json')

    def test_socket_acl_never_grants_world_or_group_read(self):
        valid='user::rw-\nuser:1101:-w-\ngroup::-w-\nmask::-w-\nother::---\n'
        self.m.validate_wallet_socket_acl(valid,1101)
        for bad in [valid.replace('other::---','other::-w-'),valid.replace('user:1101:-w-','user:1102:-w-'),
                    valid+'user:999:-w-\n',valid.replace('group::-w-','group::rw-')]:
            with self.assertRaises(ValueError):self.m.validate_wallet_socket_acl(bad,1101)

class WalletNativeBoundaryRefusals(WalletIdentityRegressions):
    def test_proc_gid_mismatch_and_pid_reuse_refuse_after_uid_probe(self):
        from unittest.mock import patch
        class Proc:
            def __init__(self,path):self.path=str(path)
            def __truediv__(self,name):return Proc(self.path+'/'+name)
            def read_text(self):
                if self.path.endswith('/status'):return 'Gid:\t1001\t1001\t1001\t1001\n'
                return '1 (node) '+' '.join(['S']+['0']*18+['7'])
        adapter,_=self.adapter()
        with patch.object(self.m,'Path',Proc):
            with self.assertRaisesRegex(ValueError,'gid_mismatch'):adapter.process(99,'wallet-monitor')
        class Reused(Proc):
            def __truediv__(self,name):return Reused(self.path+'/'+name)
            def read_text(self):
                if self.path.endswith('/status'):return 'Gid:\t1101\t1101\t1101\t1101\n'
                return '1 (node) '+' '.join(['S']+['0']*18+['8'])
        with patch.object(self.m,'Path',Reused):
            with self.assertRaisesRegex(ValueError,'pid_reused'):adapter.process(99,'wallet-monitor')

    def test_actual_permission_probe_uses_numeric_identity_and_no_extra_groups(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        events=[]
        account=SimpleNamespace(pw_uid=1101,pw_gid=1101)
        with patch.object(self.m.subprocess,'run',return_value=SimpleNamespace(returncode=1)) as run:
            with self.assertRaisesRegex(ValueError,'actual_service_uid_permissions_failed'):
                self.m.private_access_preflight(account,[('/deployment','a'*64)],['/other-deployment'],lambda:events.append('lock'))
            self.assertEqual(run.call_args.kwargs['user'],1101)
            self.assertEqual(run.call_args.kwargs['group'],1101)
            self.assertEqual(run.call_args.kwargs['extra_groups'],[])
            self.assertIs(run.call_args.kwargs['stdout'],self.m.subprocess.DEVNULL)
        self.assertEqual(events,['lock'])

    def test_lost_lock_prevents_permission_probe_process(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        with patch.object(self.m.subprocess,'run') as run:
            with self.assertRaisesRegex(ValueError,'lost_lock'):
                self.m.private_access_preflight(SimpleNamespace(pw_uid=1101,pw_gid=1101),[],[],
                    lambda:(_ for _ in ()).throw(ValueError('lost_lock')))
            run.assert_not_called()

    def test_ubuntu_initgroups_without_primary_group_is_accepted(self):
        identity=dict(self.identity,uid=995,gid=986)
        def run(argv,seconds):
            if argv[1]=='passwd':return 'address-radar-wallet:x:995:986::/nonexistent:/usr/sbin/nologin\n'
            if argv[1]=='group':return 'address-radar-wallet:x:986:\n'
            return 'address-radar-wallet \n'
        account=self.m.resolve_wallet_identity(identity,self.origin,run)
        self.assertEqual((account.pw_uid,account.pw_gid),(995,986))
        for output in ['address-radar-wallet 1001\n','address-radar-wallet 986 1001\n',
                       'other-user \n','']:
            def unsafe(argv,seconds):
                return output if argv[1]=='initgroups' else run(argv,seconds)
            with self.assertRaisesRegex(ValueError,'supplementary_groups'):
                self.m.resolve_wallet_identity(identity,self.origin,unsafe)

    def test_supplementary_origin_group_is_refused_by_getent(self):
        def run(argv,seconds):
            if argv[1]=='passwd':return 'address-radar-wallet:x:1101:1101::/nonexistent:/usr/sbin/nologin\n'
            if argv[1]=='group':return 'address-radar-wallet:x:1101:\n'
            return 'address-radar-wallet 1101 1001\n'
        with self.assertRaisesRegex(ValueError,'supplementary_groups'):
            self.m.resolve_wallet_identity(self.identity,self.origin,run)

    def test_wallet_authority_is_copied_not_chmodded_or_reused(self):
        from unittest.mock import patch
        adapter,_=self.adapter();published=[]
        source_config={'credential':{'path':'/root/credential','sha256':'b'*64},
            'privateKey':{'path':'/root/key','sha256':'c'*64},'releaseSha256':'d'*64}
        adapter.wallet_authority_sources=[{'path':'/root/config','sha256':'a'*64},source_config['credential'],source_config['privateKey']]
        raw={'/root/config':self.m.encode(source_config),'/root/credential':b'private-credential','/root/key':b'private-key'}
        adapter.managed=lambda path,content,mode,owner:published.append((str(path),content,mode,owner.pw_uid))
        adapter.journal=type('Journal',(),{'save':lambda self:None})()
        with patch.object(self.m,'read_pin',side_effect=lambda pin,**kwargs:raw[pin['path']]):
            env=adapter.publish_wallet_authority({'ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE':'/root/config'})
        self.assertEqual(len(published),3)
        self.assertTrue(all(mode==0o400 and owner==1101 for _,_,mode,owner in published))
        self.assertTrue(all(path.startswith('/etc/address-radar/configured-test/') for path,_,_,_ in published))
        copied=json.loads(published[-1][1]);self.assertEqual(copied['releaseSha256'],'d'*64)
        self.assertEqual(copied['privateKey']['sha256'],self.m.sha(b'private-key'))
        self.assertNotEqual(env['ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE'],'/root/config')
        self.assertEqual(source_config['privateKey']['path'],'/root/key')

class WalletEffectiveUnitRefusals(WalletIdentityRegressions):
    def test_loaded_unit_must_use_exact_user_and_group(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        adapter,_=self.adapter()
        adapter.node=Path('/sealed/node');adapter.release=Path('/sealed/release')
        adapter.source_safe=lambda:None
        adapter.dropin=lambda service:Path('/units/'+service+'.conf')
        adapter.file_descriptor=lambda path:{'sha256':'a'*64}
        services=('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')
        adapter.state['artifacts']={str(adapter.dropin(s)):{'desired':{'sha256':'a'*64}} for s in services}
        def state(service):
            account=adapter.account_for(service)
            return {'User':account.pw_name,'Group':'address-radar-wallet' if service=='wallet-monitor' else 'address-radar',
                'MemoryMax':'268435456','TasksMax':'64','DropInPaths':str(adapter.dropin(service)),
                'ExecStart':'path=/sealed/node ; argv[]=/sealed/node --no-global-search-paths /sealed/release/scripts/postgres-address-only-dispatch.mjs '+service+' ;',
                'EnvironmentFiles':str(adapter.directory/(service+'.env'))+' (ignore_errors=no)'}
        with patch.object(self.m.grp,'getgrgid',return_value=SimpleNamespace(gr_name='address-radar')):
            adapter.unit=state;adapter.verify_published()
            for field,value in [('User','address-radar'),('Group','address-radar')]:
                adapter.unit=lambda service,field=field,value=value:dict(state(service),**({field:value} if service=='wallet-monitor' else {}))
                with self.assertRaisesRegex(ValueError,'unit_identity_mismatch'):adapter.verify_published()

class BoundedRenewalRegressions(Tests):
    def recovery(self, phase='BLOCKED'):
        request={'transitionId':'transition','deadlineAtMs':1000,'unchanged':{'pin':'original'}}
        state={'phase':phase,'transitionId':'transition','transitionSha256':self.m.sha(self.m.encode(request)),
               'pending':{'kind':'reload-reblocked','subject':'six-services'} if phase=='REBLOCK_REQUIRED' else None}
        raw=self.m.encode(state)
        renewal={'protocol':'address-only-configured-renewal-v1','transitionId':'transition',
                 'originalRequestSha256':state['transitionSha256'],'journalSha256':self.m.sha(raw),
                 'authorizationRef':'operator-recovery','deadlineAtMs':200000}
        return request,state,raw,renewal

    def test_renewal_preserves_original_binding_and_changes_only_execution_deadline(self):
        request,state,raw,renewal=self.recovery()
        before=copy.deepcopy(request)
        effective=self.m.renewal_request(request,renewal,2000)
        self.m.validate_renewal_checkpoint(request,renewal,raw)
        self.assertEqual(request,before)
        self.assertEqual(effective,dict(request,deadlineAtMs=200000))
        self.assertEqual(state['transitionSha256'],self.m.sha(self.m.encode(request)))

    def test_renewal_rejects_wrong_pins_phase_deadline_and_extra_fields(self):
        request,state,raw,renewal=self.recovery()
        for change in [{'transitionId':'other'},{'originalRequestSha256':'0'*64},
                       {'deadlineAtMs':2000},{'deadlineAtMs':242001},{'deadlineAtMs':True},
                       {'authorizationRef':''},{'unexpected':True}]:
            with self.assertRaises(ValueError):self.m.renewal_request(request,dict(renewal,**change),2000)
        with self.assertRaises(ValueError):self.m.validate_renewal_checkpoint(request,dict(renewal,journalSha256='0'*64),raw)
        for phase in ['ORIGIN','COMPLETE','UNKNOWN']:
            changed=dict(state,phase=phase);data=self.m.encode(changed)
            with self.assertRaises(ValueError):
                self.m.validate_renewal_checkpoint(request,dict(renewal,journalSha256=self.m.sha(data)),data)
        changed=dict(state,transitionSha256='0'*64);data=self.m.encode(changed)
        with self.assertRaises(ValueError):
            self.m.validate_renewal_checkpoint(request,dict(renewal,journalSha256=self.m.sha(data)),data)

    def test_pending_reblock_is_completed_before_checkpoint_is_blocked(self):
        from types import SimpleNamespace
        _,state,_,_=self.recovery('REBLOCK_REQUIRED');events=[]
        journal=SimpleNamespace(state=state,save=lambda:events.append(('save',state['phase'])))
        def reblock():
            self.assertEqual(state['pending']['kind'],'reload-reblocked');events.append('reblock');state['pending']=None
        adapter=SimpleNamespace(check=lambda:events.append('lock'),reblock=reblock)
        self.m.finish_pending_reblock(journal,adapter)
        self.assertEqual(state['phase'],'BLOCKED');self.assertIsNone(state['pending'])
        self.assertLess(events.index('reblock'),events.index(('save','BLOCKED')))

    def test_all_legitimate_interrupted_phases_are_reblocked_before_recovery(self):
        from types import SimpleNamespace
        for phase in ['PREPARED','PUBLISHED','WAITING_READY','READY','REBLOCK_REQUIRED','BLOCKED']:
            request,state,raw,renewal=self.recovery(phase)
            self.m.validate_renewal_checkpoint(request,renewal,raw)
            events=[]
            journal=SimpleNamespace(state=state,save=lambda:events.append(('save',state['phase'])))
            def reblock():
                self.assertEqual(state['phase'],'REBLOCK_REQUIRED')
                events.append('reblock');state['pending']=None
            adapter=SimpleNamespace(check=lambda:events.append('lock'),reblock=reblock)
            self.m.finish_pending_reblock(journal,adapter)
            self.assertEqual(state['phase'],'BLOCKED')
            self.assertEqual(events.count('reblock'),0 if phase=='BLOCKED' else 1)

    def test_completion_requires_fresh_input_bound_proof(self):
        state={'nativePreflight':self.proof(),'nativePreflightInputSha256':'a'*64}
        self.m.validate_completion_proof(state,1001)
        for now in [61000,62000]:
            with self.assertRaises(ValueError):self.m.validate_completion_proof(state,now)
        with self.assertRaises(ValueError):
            self.m.validate_completion_proof(dict(state,nativePreflightInputSha256='b'*64),1001)
        with self.assertRaises(ValueError):self.m.validate_completion_proof({'nativePreflight':self.proof()},1001)

    def test_failed_pending_reblock_never_advances_or_erases_pending(self):
        from types import SimpleNamespace
        _,state,_,_=self.recovery('REBLOCK_REQUIRED');saved=[]
        journal=SimpleNamespace(state=state,save=lambda:saved.append(state['phase']))
        def fail():raise ValueError('reload_failed')
        with self.assertRaisesRegex(ValueError,'reload_failed'):
            self.m.finish_pending_reblock(journal,SimpleNamespace(check=lambda:None,reblock=fail))
        self.assertEqual(state['phase'],'REBLOCK_REQUIRED');self.assertIsNotNone(state['pending'])
        self.assertNotIn('BLOCKED',saved)

class ConfiguredOriginRegressions(Tests):
    def origin(self):
        original=self.manifest();current=self.m.derive_manifest(original,'1'*64)
        receipt={'protocol':'address-only-configured-transition-receipt-v1','transitionId':'previous',
            'operationId':'op','generationId':'gen','importId':'import','releaseSha256':'1'*64,
            'newManifestSha256':self.m.sha(self.m.encode(current)),'databaseImported':True,
            'newImportPerformed':False,'businessReleaseSwitched':True,'sourceMonitoring':'configured_pending_observation',
            'monitoringCompleted':False,'businessEligibilityGranted':False,**{k:False for k in self.m.SAFETY}}
        identity={'user':'wallet','group':'wallet','uid':995,'gid':986}
        state={'phase':'COMPLETE','pending':None,'transitionId':'previous','operationId':'op','receipt':receipt,
            'release':{'releaseSha256':'1'*64},'node':{'sha256':'2'*64},'walletServiceUser':identity,
            'newManifestSha256':receipt['newManifestSha256'],'measurement':{'binding':{'generationId':'gen'}}}
        origin={'journal':{'path':'/output/configured-previous-state.json','sha256':'a'*64},
            'receipt':{'path':'/output/configured-transition-receipt.json','sha256':'b'*64},
            'releaseRoot':'/opt/releases/current','node':{'path':'/opt/node','sha256':'2'*64}}
        request={'transitionId':'next','releaseSha256':'3'*64,'walletServiceUser':identity}
        return original,state,receipt,origin,request

    def test_current_configured_origin_is_distinct_from_permanent_import_anchor(self):
        original,state,receipt,origin,request=self.origin();before=copy.deepcopy(state)
        self.m.validate_configured_origin(origin,state,receipt,original,request)
        self.assertEqual(state,before)
        for change in [{'phase':'BLOCKED'},{'pending':{'kind':'start'}},{'transitionId':'next'}]:
            with self.assertRaises(ValueError):
                self.m.validate_configured_origin(origin,dict(state,**change),receipt,original,request)
        for change in [{'releaseSha256':'4'*64},{'sourceMonitoring':'waiting_configuration'},
                       {'gatewayDeliveryEnabled':True},{'newManifestSha256':'5'*64},{'generationId':'other'}]:
            bad=dict(receipt,**change)
            with self.assertRaises(ValueError):
                self.m.validate_configured_origin(origin,dict(state,receipt=bad),bad,original,request)
        with self.assertRaises(ValueError):
            self.m.validate_configured_origin(origin,state,receipt,original,dict(request,releaseSha256='1'*64))
        with self.assertRaises(ValueError):
            self.m.validate_configured_origin(origin,state,receipt,original,dict(request,walletServiceUser={'uid':1000}))

    def test_live_origin_checks_inventory_materials_manifest_and_six_service_readiness(self):
        from types import SimpleNamespace
        original,state,receipt,origin,request=self.origin();events=[]
        root=Path('/etc/address-radar/configured-previous')
        descriptors={str(root/'startup-manifest.json'):{'sha256':receipt['newManifestSha256']},
            str(root/'wallet-monitor.env'):{'sha256':'7'*64}}
        state['artifacts']={path:{'desired':copy.deepcopy(value)} for path,value in descriptors.items()}
        measured=copy.deepcopy(state['release'])
        base=SimpleNamespace(release_inventory=lambda path,check:measured,
            sealed_file=lambda path,limit,check:({'sha256':'2'*64},None))
        adapter=SimpleNamespace(state=state,directory=root,file_descriptor=lambda path:descriptors[str(path)],
            verify_published=lambda:events.append('effective-units'),verify_ready=lambda:events.append('six-ready'))
        self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:events.append('lock'))
        self.assertLess(events.index('effective-units'),events.index('six-ready'))
        measured['releaseSha256']='8'*64
        with self.assertRaisesRegex(ValueError,'inventory_changed'):
            self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)
        measured.update(state['release'])
        descriptors[str(root/'wallet-monitor.env')]={'sha256':'9'*64}
        with self.assertRaisesRegex(ValueError,'artifact_changed'):
            self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)
        descriptors[str(root/'wallet-monitor.env')]={'sha256':'7'*64}
        base.sealed_file=lambda path,limit,check:({'sha256':'0'*64},None)
        with self.assertRaisesRegex(ValueError,'node_changed'):
            self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)

    def test_configured_transition_stops_before_independent_publisher_preflight(self):
        events=[]
        result=self.m.perform_configured_transition(lambda:events.append('preflight'),lambda:events.append('reblock'),
            lambda:events.append('activate') or 'complete',lambda:events.append('failure-reblock'))
        self.assertEqual(result,'complete');self.assertEqual(events,['reblock','preflight','activate'])
        events=[]
        def fail():events.append('preflight');raise ValueError('authority_refused')
        with self.assertRaises(ValueError):
            self.m.perform_configured_transition(fail,lambda:events.append('reblock'),lambda:events.append('activate'),
                lambda:events.append('failure-reblock'))
        self.assertEqual(events,['reblock','preflight','failure-reblock'])

    def test_receipt_publication_is_transition_scoped(self):
        self.assertEqual(self.m.transition_receipt_path(Path('/output'),'next'),
            Path('/output/configured-next-receipt.json'))

class DegradedConfiguredOriginRegressions(ConfiguredOriginRegressions):
    def policy(self):
        return {'protocol':'address-only-configured-degraded-origin-v1','authorizationRef':'repair-wallet',
                'services':['wallet-monitor']}

    def test_degraded_recovery_is_explicit_and_wallet_only(self):
        self.m.validate_degraded_recovery(self.policy())
        for change in [{'services':['scanner']},{'services':['wallet-monitor','scanner']},
                       {'authorizationRef':''},{'protocol':'other'},{'extra':True}]:
            with self.assertRaises(ValueError):self.m.validate_degraded_recovery(dict(self.policy(),**change))
        original,state,receipt,origin,request=self.origin()
        self.m.validate_configured_origin(dict(origin,degradedRecovery=self.policy()),state,receipt,original,request)

    def test_degraded_origin_keeps_other_five_strict_and_checks_source_and_dac_first(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        original,state,receipt,origin,request=self.origin()
        origin=dict(origin,degradedRecovery=self.policy());events=[]
        root=Path('/etc/address-radar/configured-previous')
        descriptor={'sha256':receipt['newManifestSha256']}
        state['artifacts']={str(root/'startup-manifest.json'):{'desired':descriptor}}
        services=('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')
        base=SimpleNamespace(SERVICES=services,release_inventory=lambda path,check:state['release'],
            sealed_file=lambda path,limit,check:({'sha256':'2'*64},None))
        adapter=SimpleNamespace(state=state,directory=root,file_descriptor=lambda path:descriptor,
            verify_published=lambda:events.append('units'),source_safe=lambda:events.append('source'),
            readable_preflight=lambda:events.append('dac'),verify_ready=lambda:(_ for _ in ()).throw(ValueError('old-ready-stale')),
            verify_ready_service=lambda service:events.append(service))
        def inspect(value):events.append('wallet-process');return {'oldReadinessVerified':False,'nRestarts':206}
        with patch.object(self.m,'inspect_degraded_wallet',inspect):
            proof=self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)
        self.assertFalse(proof['oldSixServiceReadinessVerified'])
        self.assertEqual(proof['healthyServicesReadinessVerified'],5)
        self.assertNotIn('wallet-monitor',events)
        self.assertLess(events.index('source'),events.index('wallet-process'))
        self.assertLess(events.index('dac'),events.index('wallet-process'))
        for service in services:
            if service!='wallet-monitor':self.assertIn(service,events)
        healthy={k:v for k,v in origin.items() if k!='degradedRecovery'}
        with self.assertRaisesRegex(ValueError,'old-ready-stale'):
            self.m.verify_configured_origin_live(base,adapter,healthy,original,receipt,lambda:None)
        adapter.verify_ready_service=lambda service:(_ for _ in ()).throw(ValueError('healthy-service-restarted'))
        with self.assertRaisesRegex(ValueError,'healthy-service-restarted'):
            self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)

    def test_worker_nonce_binds_current_lifecycle_not_old_receipt_nonce(self):
        from types import SimpleNamespace
        root=Path('/etc/address-radar/configured-previous')
        state={'measurement':{'binding':{'operationId':'op','generationId':'gen'}},'release':{'releaseSha256':'a'*64},
            'attempt':'b'*32,'artifacts':{str(root/'wallet-deployment.json'):{'desired':{'sha256':'c'*64}}}}
        adapter=SimpleNamespace(state=state,directory=root,check=lambda:None,
            process=lambda pid,service,**kwargs:{'startTime':str(pid),'cgroup':'0::/unit'})
        shared={b'ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION':b'op',b'ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION':b'gen',
            b'ADDRESS_RADAR_POSTGRES_RELEASE_SHA256':b'a'*64,b'ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT':b'b'*32,
            b'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE':str(root/'wallet-deployment.json').encode(),
            b'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256':b'c'*64}
        encode=lambda values:b'\0'.join(k+b'='+v for k,v in values.items())+b'\0'
        parent=encode(shared);child=encode(dict(shared,**{}))+b'ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE='+b'd'*32+b'\0'
        read=lambda pid:parent if pid==100 else child
        proof=self.m.verify_degraded_worker_environment(adapter,101,100,read)
        self.assertTrue(proof['currentNonceVerified'])
        for bad in [child.replace(b'd'*32,b'old'),child.replace(b'gen',b'other'),
                    child+b'ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE='+b'e'*32+b'\0',
                    child.replace(b'ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE',b'OTHER_NONCE')]:
            with self.assertRaises(ValueError):
                self.m.verify_degraded_worker_environment(adapter,101,100,lambda pid:parent if pid==100 else bad)
        calls=[]
        def changing(pid):
            calls.append(pid)
            return parent if pid==100 else child if calls.count(101)==1 else child.replace(b'd'*32,b'e'*32)
        with self.assertRaises(ValueError):self.m.verify_degraded_worker_environment(adapter,101,100,changing)

    def test_degraded_process_snapshot_rejects_unknown_program_restart_and_wrong_cgroup(self):
        from types import SimpleNamespace
        unit={'MainPID':'100','InvocationID':'current','ControlGroup':'/system.slice/address-radar-wallet-monitor.service','ActiveState':'active'}
        events=[]
        class Deadline:
            def command(self,args):return 'NRestarts=206\n'
        adapter=SimpleNamespace(unit=lambda service:dict(unit),check=lambda:events.append('lock'),
            fence=SimpleNamespace(deadline=Deadline()),state={'units':{'wallet-monitor':{'ready':{'mainPid':90,'invocationId':'old'}}}})
        def process(pid,service,child=False,parent=None):
            if pid not in (100,101):raise ValueError('readiness_argv_mismatch')
            if child:self.assertEqual(parent,100)
            return {'startTime':str(pid),'cgroup':'0::'+unit['ControlGroup']}
        adapter.process=process
        from unittest.mock import patch
        nonce_patch=patch.object(self.m,'verify_degraded_worker_environment',return_value={'currentNonceVerified':True})
        nonce_patch.start();self.addCleanup(nonce_patch.stop)
        proof=self.m.inspect_degraded_wallet(adapter,lambda group:[100,101])
        self.assertEqual(proof['nRestarts'],206);self.assertFalse(proof['oldReadinessVerified'])
        self.assertTrue(proof['restartedSinceReceipt']);self.assertEqual(proof['mainPid'],100)
        with self.assertRaisesRegex(ValueError,'argv_mismatch'):
            self.m.inspect_degraded_wallet(adapter,lambda group:[100,101,999])
        adapter.process=lambda *args,**kwargs:{'startTime':'100','cgroup':'0::/other'}
        with self.assertRaisesRegex(ValueError,'cgroup'):
            self.m.inspect_degraded_wallet(adapter,lambda group:[100])
        adapter.process=process
        calls=[]
        def changed(service):
            calls.append(service);return dict(unit,InvocationID='changed' if len(calls)>1 else 'current')
        adapter.unit=changed
        with self.assertRaisesRegex(ValueError,'changed'):
            self.m.inspect_degraded_wallet(adapter,lambda group:[100,101])

class RestoredConfiguredOriginRegressions(ConfiguredOriginRegressions):
    def policy(self):
        return {'protocol':'address-only-configured-restored-origin-v1','authorizationRef':'operator-six-service-recovery',
            'services':list(self.m.RESTORED_SERVICES),'restoreReceipt':{
                'path':'/var/lib/address-radar-maintenance-tools/restore-c/receipt.json','sha256':'c'*64}}

    def audit(self,origin,state):
        return {'protocol':'address-only-restore-prior-service-config-v1','allActive':True,
            'databaseRollback':False,'gatewayDeliveryEnabled':False,'startedAtMs':1000,'completedAtMs':2000,
            'priorJournalSha256':origin['journal']['sha256'],'priorTransition':state['transitionId'],
            'failedTransition':'failed-next','services':list(self.m.RESTORED_SERVICES),
            'status':{s:{'ActiveState':'active','SubState':'running','NRestarts':'0'} for s in self.m.RESTORED_SERVICES}}

    def test_explicit_six_service_policy_and_mutual_exclusion(self):
        original,state,receipt,origin,request=self.origin()
        policy=self.policy();before=copy.deepcopy(state)
        self.m.validate_configured_origin(dict(origin,restoredRecovery=policy),state,receipt,original,request)
        self.assertEqual(state,before)
        for changes in [{'protocol':'other'},{'authorizationRef':''},{'authorizationRef':'bad\nref'},
                        {'services':['wallet-monitor']},{'services':list(self.m.RESTORED_SERVICES)+['scanner']},
                        {'extra':True},{'restoreReceipt':{'path':'/tmp/receipt.json','sha256':'c'*64}}]:
            with self.assertRaises(ValueError):self.m.validate_restored_recovery(dict(policy,**changes))
        with self.assertRaisesRegex(ValueError,'configured_origin_fields'):
            self.m.validate_configured_origin(dict(origin,restoredRecovery=policy,degradedRecovery={}),state,receipt,original,request)

    def test_audit_binds_original_journal_and_no_database_or_gateway_change(self):
        _,state,_,origin,_=self.origin();audit=self.audit(origin,state)
        self.m.validate_restore_receipt(audit,origin,state)
        for change in [{'priorJournalSha256':'0'*64},{'priorTransition':'other'},
                       {'failedTransition':state['transitionId']},{'databaseRollback':True},
                       {'gatewayDeliveryEnabled':True},{'allActive':False},{'startedAtMs':True},
                       {'completedAtMs':999},{'completedAtMs':10**18},{'extra':True},
                       {'services':['wallet-monitor']},{'status':{}}]:
            with self.assertRaises(ValueError):self.m.validate_restore_receipt(dict(audit,**change),origin,state)
        for service in self.m.RESTORED_SERVICES:
            bad=copy.deepcopy(audit);bad['status'][service]['NRestarts']='1'
            with self.assertRaises(ValueError):self.m.validate_restore_receipt(bad,origin,state)

    def test_live_restore_reuses_artifact_dac_source_gates_but_never_old_readiness(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        original,state,receipt,origin,_=self.origin();origin=dict(origin,restoredRecovery=self.policy())
        root=Path('/etc/address-radar/configured-previous');events=[];before=copy.deepcopy(state)
        descriptor={'sha256':receipt['newManifestSha256']}
        state['artifacts']={str(root/'startup-manifest.json'):{'desired':descriptor}}
        before=copy.deepcopy(state);raw=self.m.encode(self.audit(origin,state))
        base=SimpleNamespace(release_inventory=lambda p,c:state['release'],protected_parent=lambda p:events.append('parents'),
            sealed_file=lambda p,n,c:({'sha256':'2'*64},None))
        adapter=SimpleNamespace(state=state,directory=root,file_descriptor=lambda p:descriptor,
            verify_published=lambda:events.append('units'),source_safe=lambda:events.append('source'),
            readable_preflight=lambda:events.append('dac'),verify_ready=lambda:self.fail('old readiness must not be reused'))
        def inspect(value):
            self.assertIn('source',events);self.assertIn('dac',events);events.append('current-six')
            return {s:{'oldReadinessVerified':False} for s in self.m.RESTORED_SERVICES}
        with patch.object(self.m,'read_pin',return_value=raw) as read,patch.object(self.m,'inspect_restored_services',inspect):
            result=self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:events.append('lock'))
            self.assertEqual(read.call_count,2)
            self.assertTrue(all(call.kwargs=={'sealed':False} for call in read.call_args_list))
        self.assertFalse(result['oldSixServiceReadinessVerified']);self.assertEqual(result['currentServiceIdentitiesVerified'],6)
        self.assertEqual(state,before);self.assertEqual(result['restoreReceipt'],self.policy()['restoreReceipt'])
        with patch.object(self.m,'read_pin',side_effect=[raw,raw+b' ']),patch.object(self.m,'inspect_restored_services',inspect):
            with self.assertRaises(ValueError):self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)
        with patch.object(self.m,'read_pin',return_value=raw),patch.object(self.m,'inspect_restored_services',side_effect=ValueError('wrong_uid')):
            with self.assertRaisesRegex(ValueError,'wrong_uid'):
                self.m.verify_configured_origin_live(base,adapter,origin,original,receipt,lambda:None)

    def test_worker_lifecycle_uses_service_specific_deployment_and_preserves_nonce(self):
        from types import SimpleNamespace
        root=Path('/etc/address-radar/configured-previous')
        state={'measurement':{'binding':{'operationId':'op','generationId':'gen'}},'release':{'releaseSha256':'a'*64},
            'attempt':'b'*32,'artifacts':{str(root/n):{'desired':{'sha256':'c'*64}} for n in ['deployment.json','wallet-deployment.json']}}
        calls=[]
        adapter=SimpleNamespace(state=state,directory=root,check=lambda:None,
            process=lambda pid,service,**kw:calls.append(service) or {'startTime':str(pid),'cgroup':'0::/unit'})
        for service in self.m.RESTORED_SERVICES:
            deployment=root/('wallet-deployment.json' if service=='wallet-monitor' else 'deployment.json')
            shared={b'ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION':b'op',b'ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION':b'gen',
                b'ADDRESS_RADAR_POSTGRES_RELEASE_SHA256':b'a'*64,b'ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT':b'b'*32,
                b'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE':str(deployment).encode(),b'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256':b'c'*64}
            raw=b'\0'.join(k+b'='+v for k,v in shared.items())+b'\0'
            child=raw+b'ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE='+b'd'*32+b'\0'
            proof=self.m.verify_degraded_worker_environment(adapter,101,100,lambda p:raw if p==100 else child,service=service)
            self.assertEqual(proof['nonceSha256'],self.m.sha(b'd'*32));self.assertEqual(calls[-4:],[service]*4)
            for bad in [child.replace(b'd'*32,b'old'),child.replace(b'gen',b'other'),
                        child.replace(str(deployment).encode(),b'/wrong/deployment.json')]:
                with self.assertRaises(ValueError):
                    self.m.verify_degraded_worker_environment(adapter,101,100,lambda p:raw if p==100 else bad,service=service)

    def snapshots(self):
        from types import SimpleNamespace
        services=self.m.RESTORED_SERVICES
        units={s:{'ActiveState':'active','MainPID':str(100+i*10),'InvocationID':'current-'+s,
            'ControlGroup':'/system.slice/address-radar-'+s+'.service'} for i,s in enumerate(services)}
        def process(pid,service,child=False,parent=None):
            main=int(units[service]['MainPID'])
            if child:self.assertEqual(parent,main);self.assertEqual(pid,main+1)
            return {'startTime':str(pid),'cgroup':'0::'+units[service]['ControlGroup']}
        def command(args):
            return 'SubState=running\n' if 'NRestarts' not in args else 'NRestarts=0\nSubState=running\n'
        adapter=SimpleNamespace(unit=lambda s:units[s],process=process,check=lambda:None,
            fence=SimpleNamespace(deadline=SimpleNamespace(command=command)))
        def inspection(value,service):
            main=int(units[service]['MainPID'])
            return {'mainPid':main,'invocationId':units[service]['InvocationID'],'nRestarts':0,
                'main':process(main,service),'workers':[{'pid':main+1,**process(main+1,service)}],
                'workerLifecycle':{'nonceSha256':'d'*64},'oldReadinessVerified':False}
        def pids(group):
            service=next(s for s,u in units.items() if u['ControlGroup']==group);main=int(units[service]['MainPID'])
            return [main,main+1]
        return adapter,units,inspection,pids

    def test_six_current_snapshots_rechecked_without_modifying_old_receipt(self):
        from unittest.mock import patch
        adapter,units,inspection,pids=self.snapshots()
        with patch.object(self.m,'inspect_degraded_wallet',side_effect=inspection) as inspect,\
             patch.object(self.m,'wallet_cgroup_processes',side_effect=pids),\
             patch.object(self.m,'verify_degraded_worker_environment',return_value={'nonceSha256':'d'*64}):
            proof=self.m.inspect_restored_services(adapter)
        self.assertEqual(inspect.call_count,6)
        self.assertEqual(set(proof),set(self.m.RESTORED_SERVICES))
        self.assertTrue(all(p['restored'] and not p['oldReadinessVerified'] for p in proof.values()))

    def test_restore_refuses_restart_process_membership_nonce_or_identity_races(self):
        from unittest.mock import patch
        for kind in ['restart','membership','nonce','main_start','child_start','uid','gid','substate']:
            with self.subTest(kind=kind):
                adapter,units,inspection,pids=self.snapshots()
                original=adapter.process
                if kind=='restart':
                    prior=inspection
                    inspection=lambda value,service:dict(prior(value,service),nRestarts=1)
                if kind=='membership':pids=lambda group:[999]
                if kind in ['main_start','child_start']:
                    def changed(pid,service,child=False,parent=None):
                        result=original(pid,service,child=child,parent=parent)
                        return dict(result,startTime='changed') if child==(kind=='child_start') else result
                    adapter.process=changed
                if kind in ['uid','gid']:
                    def refuse(*a,**kw):raise ValueError('wrong_identity')
                    adapter.process=refuse
                if kind=='substate':adapter.fence.deadline.command=lambda args:'SubState=failed\n'
                nonce={'nonceSha256':'e'*64 if kind=='nonce' else 'd'*64}
                with patch.object(self.m,'inspect_degraded_wallet',side_effect=inspection),\
                     patch.object(self.m,'wallet_cgroup_processes',side_effect=pids),\
                     patch.object(self.m,'verify_degraded_worker_environment',return_value=nonce):
                    with self.assertRaises(ValueError):self.m.inspect_restored_services(adapter)

if __name__ == '__main__': unittest.main()
