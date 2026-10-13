"""Real activation algorithms and flock; systemd/SQLite are not exercised here."""
import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

m = load('binding', SCRIPTS/'source-replacement-controller-adapter.py')
base = load('activation', SCRIPTS/'activate-address-only-postgres.py')
legacy = load('legacy', SCRIPTS/'address-only-native-fence.py')
pg = load('pg', SCRIPTS/'pg-source-replacement-fence.py')

class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.lock = self.root/'controller.lock'
        self.fd = os.open(self.lock, os.O_RDWR|os.O_CREAT, 0o600)
        fcntl.flock(self.fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.addCleanup(os.close, self.fd)
        self.events = []

    def assert_competitor_blocked(self):
        program = 'import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDWR)\ntry:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(37)'
        result = subprocess.run([sys.executable,'-c',program,str(self.lock)],capture_output=True,timeout=3)
        self.assertEqual(result.returncode,37)

    def test_borrowed_native_lock_checks_and_close_never_unlock_parent(self):
        owner = types.SimpleNamespace(fd=self.fd)
        checks = []
        def check():
            checks.append(1)
            self.assert_competitor_blocked()
        with patch.object(legacy,'CONTROL',str(self.root)), patch.object(legacy,'ROOT_UID',os.geteuid()):
            cls = m.borrowed_fence_type(legacy, owner, check)
            fence = cls.__new__(cls)
            fence._lock_control(legacy.Deadline(3))
            # This flag used to route the original implementation through LOCK_UN.
            fence._external_lock = True
            with patch.object(fcntl,'flock',side_effect=AssertionError('borrowed description must never flock')):
                fence._assert_retained_lock()
                fence.close()
                fence.close()
            self.assert_competitor_blocked()
            self.assertGreaterEqual(len(checks),2)
            self.assertIs(cls.recover.__func__, legacy.NativeSourceFence.recover.__func__)

    def test_borrowed_lock_failure_does_not_release_parent(self):
        owner = types.SimpleNamespace(fd=self.fd)
        checks = 0
        def check():
            nonlocal checks
            checks += 1
            if checks == 2: raise ValueError('owner_lost')
        with patch.object(legacy,'CONTROL',str(self.root)),patch.object(legacy,'ROOT_UID',os.geteuid()):
            fence = m.borrowed_fence_type(legacy,owner,check).__new__(m.borrowed_fence_type(legacy,owner,check))
            with self.assertRaisesRegex(ValueError,'owner_lost'):
                fence._lock_control(legacy.Deadline(3))
            self.assertIsNone(fence.lock)
            self.assert_competitor_blocked()

    def activation(self, gate=None):
        events = self.events
        def owned(): self.assert_competitor_blocked()
        gate = gate or (lambda owner,adapter: events.append('gate'))
        cls = m.gated_activation_type(base, object(), owned, gate, 'transition')
        # Real activate_units and its real write-ahead journal, with OS/publication ports substituted.
        adapter = cls.__new__(cls)
        state = {'phase':'PREPARED','transitionId':'transition','units':{s:{} for s in base.SERVICES}}
        with patch.object(base,'ROOT_UID',os.geteuid()):
            journal = base.ActivationJournal(self.root/'activation.json', state)
        adapter.journal,adapter.state = journal,journal.state
        adapter._source_gate_complete = False
        adapter._source_gate_running = False
        adapter.check = owned
        adapter.publish = lambda service: events.append('publish:'+service)
        adapter.verify_published = lambda: events.append('verify')
        adapter.reload = lambda: events.append('reload')
        adapter.fresh = lambda: events.append('fresh')
        adapter.ready = lambda: {s:{'service':s} for s in base.SERVICES}
        adapter.capacity = lambda: {}
        adapter.complete = lambda: {'status':'fixture-complete'}
        adapter.reblock = lambda: events.append('reblock')
        return adapter,journal

    def test_real_activate_units_gates_after_all_publications_and_before_first_unguard(self):
        adapter,journal = self.activation()
        def unguard(self,service): self.events.append('unguard:'+service)
        def start(self,service): self.events.append('start:'+service)
        adapter.events = self.events
        with patch.object(base.NativeActivation,'unguard',unguard),patch.object(base.NativeActivation,'start',start):
            result = base.activate_units(journal,adapter)
        self.assertEqual(result,{'status':'fixture-complete'})
        index = self.events.index('gate')
        self.assertEqual(sum(e.startswith('publish:') for e in self.events[:index]),6)
        self.assertIn('verify',self.events[:index])
        self.assertEqual(self.events.count('gate'),1)
        self.assertLess(index,self.events.index('unguard:scanner'))
        self.assertEqual(sum(e.startswith('start:') for e in self.events),6)

    def test_premature_start_or_unguard_never_reaches_real_boundary(self):
        for method in ('start','unguard'):
            with self.subTest(method=method):
                sub = self.root/method
                sub.mkdir()
                with patch.object(self,'root',sub): adapter,journal = self.activation()
                with patch.object(base.NativeActivation,method,side_effect=AssertionError('business boundary reached')) as boundary:
                    with self.assertRaisesRegex(ValueError,'source_gate_not_published'):
                        getattr(adapter,method)('scanner')
                    boundary.assert_not_called()
                self.assertEqual(journal.state['phase'],'BLOCKED')
                self.assertIn('reblock',self.events)
                self.assertNotIn('gate',self.events)

    def test_real_activate_units_gate_failure_reblocks_and_persists_without_start(self):
        def gate(owner,adapter): raise ValueError('gate_failed')
        adapter,journal = self.activation(gate)
        with patch.object(base.NativeActivation,'unguard') as unguard,patch.object(base.NativeActivation,'start') as start:
            with self.assertRaisesRegex(ValueError,'gate_failed'): base.activate_units(journal,adapter)
            unguard.assert_not_called(); start.assert_not_called()
        with patch.object(base,'ROOT_UID',os.geteuid()):
            self.assertEqual(base.private_json(journal.path)['phase'],'BLOCKED')
        self.assertNotIn('receipt',journal.state)

    def test_gate_reentry_cannot_start_early(self):
        def gate(owner,adapter): adapter.start('scanner')
        adapter,journal = self.activation(gate)
        with patch.object(base.NativeActivation,'start') as start:
            with self.assertRaisesRegex(ValueError,'source_gate_incomplete'): base.activate_units(journal,adapter)
            start.assert_not_called()
        self.assertEqual(journal.state['phase'],'BLOCKED')

    def test_original_guard_identity_and_source_safe_are_not_overridden(self):
        cls = m.gated_activation_type(base, object(), lambda: None, lambda *_:None, 'transition')
        self.assertIs(cls.source_safe,base.NativeActivation.source_safe)
        self.assertIs(cls.guard_identity,base.NativeActivation.guard_identity)
        self.assertIs(cls.reblock,base.NativeActivation.reblock)

    def test_real_reblock_restores_original_inode_and_reloads_before_stop(self):
        adapter = base.NativeActivation.__new__(base.NativeActivation)
        adapter.state = {'phase':'PREPARED','units':{s:{} for s in base.SERVICES},'artifacts':{}}
        adapter.journal = base.ActivationJournal(self.root/'reblock.json',adapter.state)
        adapter.output = self.root
        body = b'[Unit]\nConditionPathExists=!/isolated-only\n'
        guards = {}
        for service in base.SERVICES:
            unit = 'address-radar-'+service+'.service'
            anchor = self.root/(service+'.anchor')
            anchor.write_bytes(body);anchor.chmod(0o600)
            with patch.object(legacy,'ROOT_UID',os.geteuid()), patch.object(legacy,'protected_parent'):
                guards[unit] = {'identity':legacy.configuration_stamp(str(anchor))}
        adapter.module = legacy
        adapter.check = lambda: self.assert_competitor_blocked()
        adapter.source_safe = lambda: self.events.append('source-safe')
        def command(args): self.events.append('stop:'+args[-1])
        adapter.fence = types.SimpleNamespace(state={'guards':guards},deadline=types.SimpleNamespace(command=command),
            _guard_body=lambda:body,_guard_path=lambda unit:str(self.root/(unit+'.guard')),
            _guard_anchor=lambda unit:str(self.root/(unit.removeprefix('address-radar-').removesuffix('.service')+'.anchor')),
            _assert_writers_blocked=lambda:self.events.append('blocked'))
        def reload():
            for unit in guards:
                self.assertEqual(os.stat(adapter.fence._guard_path(unit)).st_ino, guards[unit]['identity']['inode'])
            self.events.append('reload')
        adapter.reload = reload
        adapter.unit = lambda service:{'ActiveState':'inactive'}
        adapter.dropin = lambda service:self.root/(service+'.absent')
        with patch.object(legacy,'ROOT_UID',os.geteuid()), patch.object(legacy,'protected_parent'):
            adapter.reblock()
        self.assertLess(self.events.index('reload'),next(i for i,e in enumerate(self.events) if e.startswith('stop:')))
        self.assertEqual(sum(e.startswith('stop:') for e in self.events),6)


    def test_pinned_binding_routes_real_classes_without_changing_default_modules(self):
        configured = load('configured', SCRIPTS/'activate-address-only-configured.py')
        controller = load('controller', SCRIPTS/'run-address-only-native-controller.py')
        modules = {'activation':base,'configured':configured,'controller':controller,'fence':legacy,'pgFence':pg}
        pins = {k:{'path':'/isolated/'+k+'.py','sha256':'a'*64} for k in modules}
        config = {'fence':pins['fence']}
        captured = []
        def activate(b,c,cfg,request,renewal):
            captured.append((b,c))
            self.assertTrue(issubclass(b.NativeActivation,base.NativeActivation))
            actual_configured_type = configured.adapter_type(b)
            self.assertIs(actual_configured_type.unguard,b.NativeActivation.unguard)
            self.assertIs(actual_configured_type.start,b.NativeActivation.start)
            self.assertIs(actual_configured_type.reblock,base.NativeActivation.reblock)
            borrowed = c.load_module('configured_fence',pins['fence'])
            self.assertTrue(issubclass(borrowed.NativeSourceFence,legacy.NativeSourceFence))
            self.assertIs(borrowed.NativeSourceFence.recover.__func__,legacy.NativeSourceFence.recover.__func__)
            with self.assertRaisesRegex(ValueError,'fence_pin_mismatch'):
                c.load_module('configured_fence',pins['activation'])
            return {'fixture':'wired'}
        original_load = controller.load_module
        with patch.object(m.sys,'platform','linux'),patch.object(m.os,'geteuid',return_value=0), \
             patch.object(m,'_pinned_module',side_effect=lambda name,pin:modules[name.removeprefix('source_binding_')]), \
             patch.object(controller,'validate_config'), \
             patch.object(m,'native_owner_check',return_value=self.assert_competitor_blocked), \
             patch.object(configured,'activate',side_effect=activate):
            binding = m.bind_configured_controller(owner=object(),config=config,pins=pins,
                gate=lambda *_:None,transition_id='transition')
            self.assertEqual(binding.activate({'transitionId':'transition'}),{'fixture':'wired'})
            with self.assertRaisesRegex(ValueError,'transition_identity_mismatch'):
                binding.activate({'transitionId':'other'})
        self.assertIs(controller.load_module,original_load)
        self.assertIsNot(captured[0][0],base)
        self.assertIsNot(captured[0][1],controller)

@unittest.skipUnless(sys.platform=='linux' and os.geteuid()==0,'real native /proc owner checks require Linux root')
class LinuxOwnerTests(unittest.TestCase):
    def test_pinned_loader_executes_verified_bytes_and_rejects_digest_links_or_writable_file(self):
        import hashlib
        with tempfile.TemporaryDirectory(dir='/root') as root:
            directory = Path(root);directory.chmod(0o700)
            source = directory/'pinned.py'
            raw = b'VALUE = 7\n'
            source.write_bytes(raw);source.chmod(0o600)
            pin = {'path':str(source),'sha256':hashlib.sha256(raw).hexdigest()}
            self.assertEqual(m._pinned_module('fixture',pin).VALUE,7)
            with self.assertRaisesRegex(ValueError,'pin_changed'):
                m._pinned_module('fixture',dict(pin,sha256='0'*64))
            source.chmod(0o622)
            with self.assertRaisesRegex(ValueError,'unsafe_pin_file'):m._pinned_module('fixture',pin)
            source.chmod(0o600)
            os.link(source,directory/'hardlink')
            with self.assertRaisesRegex(ValueError,'unsafe_pin_file'):m._pinned_module('fixture',pin)
            (directory/'hardlink').unlink()
            link = directory/'symlink';link.symlink_to(source)
            with self.assertRaises(OSError):m._pinned_module('fixture',dict(pin,path=str(link)))

    def test_full_native_owner_checks_reject_noop_owner_and_wrong_pid_journal_or_inode(self):
        with tempfile.TemporaryDirectory(dir='/root') as root:
            directory = Path(root);directory.chmod(0o700)
            lock = directory/'controller.lock'
            fd = os.open(lock,os.O_RDWR|os.O_CREAT,0o600)
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:
                native = pg.Native.__new__(pg.Native)
                native.lock_path,native.directory = lock,directory
                state = {'ownerPid':os.getpid(),'ownerStart':pg.pid_start(os.getpid()),'phase':'PREPARED'}
                owner = types.SimpleNamespace(n=native,fd=fd,state=state,owned=lambda:None)
                (directory/'state.json').write_bytes(pg.encode(state))
                (directory/'state.json').chmod(0o600)
                check = m.native_owner_check(pg,owner,lock)
                check()
                for key,value in [('ownerPid',str(os.getpid())),('ownerStart','wrong')]:
                    old = state[key];state[key] = value
                    with self.assertRaises(ValueError): check()
                    state[key] = old
                (directory/'state.json').write_bytes(pg.encode(dict(state,phase='CHANGED')))
                with self.assertRaisesRegex(ValueError,'journal_changed'): check()
                (directory/'state.json').write_bytes(pg.encode(state))
                fcntl.flock(fd,fcntl.LOCK_UN)
                with self.assertRaisesRegex(ValueError,'controller_lock_not_held'): check()
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                lock.rename(directory/'old.lock');lock.write_bytes(b'');lock.chmod(0o600)
                with self.assertRaisesRegex(ValueError,'controller_lock_replaced'): check()
            finally:os.close(fd)


class IssuedOriginTests(unittest.TestCase):
    def setUp(self):
        import copy
        self.copy=copy.deepcopy
        self.tmp=tempfile.TemporaryDirectory(dir='/root' if sys.platform=='linux' and os.geteuid()==0 else None);self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.root.chmod(0o700)
        fixture=load('native_origin_fixture',SCRIPTS/'test/pg-source-replacement-fence.test.py')
        self.native=fixture.FakeNative(self.root)
        for service in pg.SERVICES:
            fragment=self.root/(service+'.service');fragment.write_bytes(b'[Service]\n');fragment.chmod(0o644)
            env=self.root/(service+'.env');env.write_bytes(b'FIXTURE_ONLY=1\n');env.chmod(0o600)
            drop=self.root/(service+'.conf');drop.write_bytes(b'[Service]\n');drop.chmod(0o644)
            self.native.states[service].update(FragmentPath=str(fragment),EnvironmentFiles=str(env)+' (ignore_errors=no)',DropInPaths=str(drop))
        self.request={'transitionId':'transition','walletServiceUser':{'user':'wallet','group':'wallet','uid':1101,'gid':1101},
            'oldState':{'path':str(self.root/'old.json'),'sha256':'a'*64},
            'originalManifest':{'path':str(self.root/'manifest.json'),'sha256':'b'*64}}
        for field in ('oldState','originalManifest'):
            path=Path(self.request[field]['path']);path.write_bytes(b'{}\n');path.chmod(0o600)
        self.original={'phase':'COMPLETE','bootId':self.native.boot,'measurement':{'binding':{}},
            'units':{service:{'ready':{'mainPid':42,'invocationId':'invocation'}} for service in pg.SERVICES}}
        self.receipt={'phase':'COMPLETE'}
        self.source_journal={'binding':{'generationId':'gen'}}
        self.source_module=types.SimpleNamespace(CONTROL=str(self.root),Journal=lambda:types.SimpleNamespace(read=lambda:self.source_journal))
        self.controller=types.SimpleNamespace(load_module=lambda *_:self.source_module)
        self.artifacts={'release':{'releaseSha256':'c'*64},'node':{'sha256':'d'*64},'artifacts':{},'units':{}}
        self.snapshot={'protocol':'address-only-source-origin-observation-v1',
            'transitionSha256':base.sha(base.encode(self.request)),'operationId':'original','generationId':'gen',
            'binding':{},'oldState':self.request['oldState'],'originalManifest':self.request['originalManifest'],'configuredOrigin':None,
            'originStateSha256':base.sha(base.encode(self.original)),'originReceiptSha256':base.sha(base.encode(self.receipt)),
            'sourceJournalSha256':base.sha(base.encode(self.source_journal)),
            'measurementSha256':base.sha(base.encode(self.original['measurement'])), 'artifacts':self.artifacts,
            'services':{service:{'ready':self.original['units'][service]['ready'],
                'unit':{key:self.native.unit(service).get(key) for key in ('MainPID','InvocationID','ControlGroup','User')}} for service in pg.SERVICES}}
        self.configured=types.SimpleNamespace(encode=base.encode,sha=base.sha,
            capture_source_origin=lambda *args,**kwargs:self.copy(self.snapshot),
            source_origin_artifact_snapshot=lambda *args:self.copy(self.artifacts))
        req={'protocol':'address-only-pg-source-fence-v1','operationId':'replacement','replacementSha256':'a'*64,
            'generationId':'gen','oldProviderId':'old-source','oldOrigin':'https://old.example',
            'newProviderId':'publicnode-source','newOrigin':'https://solana-rpc.publicnode.com',
            'authorizationRef':'approved','deadlineAtMs':self.native.now+180000,'publishedFiles':[]}
        self.owner=pg.PgSourceFence(self.native,req).__enter__();self.addCleanup(self.owner.__exit__,None,None,None)
        self.protection=patch.object(base,'protected_parent');self.protection.start();self.addCleanup(self.protection.stop)
        # Native ownership is exercised unmocked by this same suite under Linux root.
        if sys.platform!='linux' or os.geteuid()!=0:
            mock=patch.object(m,'native_owner_check',return_value=self.check_lock);mock.start();self.addCleanup(mock.stop)
        self.handle=m.issue_source_origin_capability(pg=pg,owner=self.owner,base=base,configured=self.configured,
            controller=self.controller,config={'fence':{}},request=self.request,check=self.check_lock)
        self.addCleanup(self.handle.close)
        self.origin_adapter=types.SimpleNamespace(state=self.original,fence=types.SimpleNamespace(lock=self.owner.fd))

    def check_lock(self):
        self.owner.owned()
        fd=os.open(self.native.lock_path,os.O_RDWR)
        try:
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:return
            fcntl.flock(fd,fcntl.LOCK_UN)
            raise ValueError('test_lock_lost')
        finally:os.close(fd)

    def drain(self):
        self.owner.block();self.native.now+=60001
        for service in pg.SERVICES:
            self.native.states[service]['DropInPaths']+=' '+str(self.native.guard_path(service))

    def verify(self,token=None,request=None,state=None,receipt=None,adapter=None):
        return m.verify_issued_source_origin_capability(self.handle.token if token is None else token,
            self.request if request is None else request,self.original if state is None else state,
            self.receipt if receipt is None else receipt,self.origin_adapter if adapter is None else adapter)

    def test_actual_native_issuer_token_requires_fresh_physical_drain(self):
        self.assertFalse(hasattr(self.handle.token,'verify'))
        with self.assertRaisesRegex(ValueError,'not_fenced'):self.verify()
        self.drain()
        self.assertEqual(self.verify()['protocol'],'address-only-source-drained-origin-v1')
        self.handle.assert_publication()
        self.assertTrue(self.native.sentinel.exists())

    def test_fake_and_unissued_capabilities_never_invoke_their_methods(self):
        called=[]
        for token in (object(),types.SimpleNamespace(verify=lambda *args:called.append(True)),{},True):
            with self.subTest(token=type(token)),self.assertRaisesRegex(ValueError,'source_origin_capability_unissued'):
                self.verify(token=token)
        self.assertEqual(called,[])

    def publication(self):
        return types.SimpleNamespace(state={'phase':'PUBLISHED','transitionId':'transition',
            'units':{service:{'published':True} for service in pg.SERVICES}},
            verify_published=lambda:None, account_for=lambda service:types.SimpleNamespace(
                pw_name='wallet' if service=='wallet-monitor' else 'fixture'))

    def test_publication_gate_uses_validated_wallet_identity_user(self):
        self.drain()
        observed=[]
        self.native.physical=lambda recorded,*,expected_users:observed.append((recorded,expected_users))
        self.handle.assert_publication(self.publication())
        self.assertEqual(len(observed),1)
        self.assertEqual(observed[0][0],self.owner.state['recorded'])
        self.assertEqual(observed[0][1],{service:'wallet' if service=='wallet-monitor' else 'fixture'
            for service in pg.SERVICES})
        self.assertEqual(self.owner.state['recorded']['wallet-monitor']['User'],'fixture')

    def test_publication_gate_rejects_unbound_service_users(self):
        self.drain()
        for changed in ('wallet-monitor','scanner'):
            actual=self.publication()
            approved=actual.account_for
            actual.account_for=lambda service:types.SimpleNamespace(pw_name='unapproved') if service==changed else approved(service)
            with self.subTest(service=changed),self.assertRaisesRegex(ValueError,'source_origin_publication_identity'):
                self.handle.assert_publication(actual)

    def test_publication_gate_requires_actual_published_configuration(self):
        self.drain()
        actual=self.publication()
        actual.verify_published=lambda:(_ for _ in ()).throw(ValueError('publication_changed'))
        with self.assertRaisesRegex(ValueError,'publication_changed'):
            self.handle.assert_publication(actual)
        actual=self.publication()
        actual.state['units']['wallet-monitor']['published']=False
        with self.assertRaisesRegex(ValueError,'source_gate_not_published'):
            self.handle.assert_publication(actual)

    def test_request_owner_and_boot_drift_refused(self):
        self.drain()
        with self.assertRaisesRegex(ValueError,'source_origin_request'):
            self.verify(request=dict(self.request,transitionId='other'))
        wrong=os.open(self.root/'other.lock',os.O_RDWR|os.O_CREAT,0o600)
        try:
            with self.assertRaisesRegex(ValueError,'source_origin_lock_changed'):
                self.verify(adapter=types.SimpleNamespace(state=self.original,fence=types.SimpleNamespace(lock=wrong)))
        finally:os.close(wrong)
        self.native.boot='other'
        with self.assertRaisesRegex(ValueError,'source_origin_boot_changed'):self.verify()

    def test_owner_journal_snapshot_and_receipt_drift_refused(self):
        self.drain()
        with self.assertRaisesRegex(ValueError,'source_origin_identity_changed'):
            self.verify(state=dict(self.original,phase='OTHER'))
        with self.assertRaisesRegex(ValueError,'source_origin_identity_changed'):
            self.verify(receipt={'phase':'OTHER'})
        self.owner.state['sourceOrigin']['snapshot']['measurementSha256']='f'*64;self.owner.save()
        with self.assertRaisesRegex(ValueError,'source_origin_journal_changed'):self.verify()

    def test_same_content_inode_replacement_and_unknown_dropin_refused(self):
        self.drain()
        self.native.states['scanner']['DropInPaths']+=' /unreviewed.conf'
        with self.assertRaisesRegex(ValueError,'source_origin_unit_changed'):self.verify()
        self.native.states['scanner']['DropInPaths']=self.native.states['scanner']['DropInPaths'].removesuffix(' /unreviewed.conf')
        path=Path(self.native.states['scanner']['FragmentPath']);raw=path.read_bytes()
        path.rename(self.root/'old-fragment');path.write_bytes(raw);path.chmod(0o644)
        with self.assertRaisesRegex(ValueError,'source_origin_artifact_changed'):self.verify()

    def test_running_request_or_cgroup_population_cannot_use_expired_window(self):
        self.drain();self.native.live_process=True
        with self.assertRaisesRegex(ValueError,'processes_remain'):self.verify()
        self.native.live_process=False;self.native.populated=True
        with self.assertRaisesRegex(ValueError,'cgroup_populated'):self.verify()

    def test_forked_process_and_fresh_registry_cannot_restore_capability(self):
        self.drain()
        fresh=load('fresh_issuer_registry',SCRIPTS/'source-replacement-controller-adapter.py')
        with self.assertRaisesRegex(ValueError,'source_origin_capability_unissued'):
            fresh.verify_issued_source_origin_capability(self.handle.token,self.request,self.original,self.receipt,self.origin_adapter)
        pid=os.fork()
        if pid==0:
            try:
                self.verify()
            except ValueError:
                os._exit(0)
            os._exit(1)
        waited,status=os.waitpid(pid,0)
        self.assertEqual(waited,pid);self.assertEqual(os.waitstatus_to_exitcode(status),0)

    def test_source_journal_and_release_measurement_drift_refused(self):
        self.drain()
        self.source_journal['binding']['generationId']='other'
        with self.assertRaisesRegex(ValueError,'source_origin_journal_changed'):self.verify()
        self.source_journal['binding']['generationId']='gen'
        self.artifacts['release']['releaseSha256']='0'*64
        with self.assertRaisesRegex(ValueError,'source_origin_artifact_changed'):self.verify()

    def test_unlock_via_duplicate_and_closed_token_refused(self):
        self.drain()
        duplicate=os.dup(self.owner.fd)
        try:fcntl.flock(duplicate,fcntl.LOCK_UN)
        finally:os.close(duplicate)
        with self.assertRaises(ValueError):self.verify()
        fcntl.flock(self.owner.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.handle.close()
        with self.assertRaisesRegex(ValueError,'source_origin_capability_unissued'):self.verify()


if __name__=='__main__':unittest.main()
