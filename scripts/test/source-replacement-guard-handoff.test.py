"""Native guard coexistence: isolated systemd only, never a production host."""
import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS/filename)
    module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module

m = load('guard_adapter','source-replacement-controller-adapter.py')
base = load('guard_activation','activate-address-only-postgres.py')
configured = load('guard_configured','activate-address-only-configured.py')
legacy = load('guard_legacy','address-only-native-fence.py')
pg = load('guard_pg','pg-source-replacement-fence.py')

@unittest.skipUnless(os.environ.get('ADDRESS_RADAR_ISOLATED_GUARD_TEST') == '1'
    and sys.platform == 'linux' and os.geteuid() == 0 and Path('/run/systemd/system').is_dir(),
    'dedicated disposable systemd container required')
class GuardHandoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/root')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.control = self.root/'control';self.control.mkdir(mode=0o700)
        lock = self.control/'controller.lock';lock.touch(mode=0o600)
        self.tools = self.root/'tools';self.tools.mkdir(mode=0o700)
        self.source = self.root/'source';self.source.mkdir(mode=0o700)
        db = self.source/'radar.sqlite';db.write_bytes(b'isolated synthetic file');db.chmod(0o400)
        backup = self.root/'backup';backup.write_bytes(b'isolated backup');backup.chmod(0o400)
        for key,value in {'CONTROL':str(self.control),'SOURCE_DIRECTORY':str(self.source),
            'SOURCE':str(db),'PROTECTED_UNITS':(),
            'WRITER_UNITS':tuple('address-radar-'+s+'.service' for s in base.SERVICES)}.items():
            p = patch.object(legacy,key,value);p.start();self.addCleanup(p.stop)
        for key,value in {'TOOLS':self.tools,'CONTROL_LOCK':self.control/'controller.lock'}.items():
            p = patch.object(pg,key,value);p.start();self.addCleanup(p.stop)
        self.command(['systemctl','is-system-running'], allow_failure=True)
        self.mask = Path(legacy.MASK_DIRECTORY)
        self.addCleanup(self.remove_units)
        for service in base.SERVICES:
            unit = 'address-radar-'+service+'.service'
            (self.mask/unit).write_text('[Service]\nUser=nobody\nExecStart=/usr/bin/sleep infinity\n')
            (self.mask/(unit+'.d')).mkdir(mode=0o755)
        self.command(['systemctl','daemon-reload'])
        self.command(['systemctl','start',*legacy.WRITER_UNITS])
        # Use the original native snapshot, body, hardlink anchors and identity checks.
        original = legacy.NativeSourceFence.__new__(legacy.NativeSourceFence)
        original.operation_id = 'guard-fixture'
        original.deadline = legacy.Deadline(180)
        original.state = {'guards':{},'masks':{},'sources':legacy.inventory()}
        original.prepared = {'sourceDirectory':legacy.directory_stamp(str(self.source)),
            'sourceFiles':legacy.inventory(),'protectedProcesses':{}}
        sentinel = self.control/'restart-blocked-guard-fixture'
        legacy.create_private_content(str(sentinel),b'isolated')
        original.state['sentinel'] = legacy.file_stamp(str(sentinel))
        for unit in legacy.WRITER_UNITS:
            record = original._snapshot_guard(unit,legacy.unit_state(unit,original.deadline))
            original.state['guards'][unit] = record
            anchor = original._guard_anchor(unit)
            legacy.create_private_content(anchor,original._guard_body())
            info = os.stat(anchor);record['identity']={'device':info.st_dev,'inode':info.st_ino}
            os.link(anchor,original._guard_path(unit))
        self.original = original
        self.original_snapshot = pg.encode(original.state)
        request = {'protocol':'address-only-pg-source-fence-v1','operationId':'isolated-guards',
            'replacementSha256':'a'*64,'generationId':'isolated','oldProviderId':'old','oldOrigin':'https://old.invalid',
            'newProviderId':'new','newOrigin':'https://solana-rpc.publicnode.com','authorizationRef':'isolated-fixture',
            'deadlineAtMs':int(time.time()*1000)+240000,'publishedFiles':[]}
        native = pg.Native(request)
        self.owner = pg.PgSourceFence(native,request).__enter__()
        self.addCleanup(self.owner.__exit__,None,None,None)
        self.owner.block()  # Real ExecCondition/ExecStartPre, stop and cgroup/process drain.
        self.check = m.native_owner_check(pg,self.owner,self.control/'controller.lock')
        # The unmodified class reproduces the actual controller rejection first.
        self.raw = self.activation(original,backup)
        with self.assertRaisesRegex(ValueError,'activation_untracked_dropin'):
            self.raw.source_safe()
        self.bridge = original
        if 'pg' in __import__('inspect').signature(m.borrowed_fence_type).parameters:
            cls = m.borrowed_fence_type(legacy,self.owner,self.check,pg=pg)
            self.bridge = cls.__new__(cls)
            self.bridge._lock_control(original.deadline)
            self.addCleanup(self.bridge.close)
            self.bridge.state,self.bridge.prepared,self.bridge.operation_id = original.state,original.prepared,original.operation_id
        self.adapter = self.activation(self.bridge,backup)

    def remove_units(self):
        subprocess.run(["systemctl","stop",*legacy.WRITER_UNITS],timeout=15,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        for unit in legacy.WRITER_UNITS:
            shutil.rmtree(self.mask/(unit+".d"),ignore_errors=True)
            (self.mask/unit).unlink(missing_ok=True)
            (self.mask/(".address-only-guard-fixture-"+unit+".guard-anchor")).unlink(missing_ok=True)
        subprocess.run(["systemctl","daemon-reload"],timeout=15,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    def command(self, args, allow_failure=False):
        result = subprocess.run(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
        if not allow_failure:self.assertEqual(result.returncode,0,'isolated systemd command failed')
        return result

    def activation(self,fence,backup):
        cls = configured.adapter_type(base)
        adapter = cls.__new__(cls)
        adapter.fence,adapter.module = fence,legacy
        adapter.check = self.check if hasattr(self,'check') else fence.deadline.check
        adapter.config = {'operationId':'guard-fixture'}
        adapter.output = self.root
        adapter.state = {'phase':'PUBLISHED','transitionId':'isolated-transition','artifacts':{},
            'units':{s:{'published':True} for s in base.SERVICES},'measurement':{
                'sources':[legacy.file_stamp(legacy.SOURCE)],
                'backup':{'path':str(backup),'stamp':legacy.file_stamp(str(backup))},
                'sourceDirectory':legacy.directory_stamp(str(self.source))}}
        adapter.journal = base.ActivationJournal(self.root/('activation-'+str(id(fence))+'.json'),adapter.state)
        return adapter

    def assert_retained(self):
        self.check()
        program = 'import fcntl,os,sys;fd=os.open(sys.argv[1],os.O_RDWR)\ntry:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError:sys.exit(37)'
        result = subprocess.run([sys.executable,'-c',program,str(self.control/'controller.lock')],timeout=3)
        self.assertEqual(result.returncode,37)

    def test_real_configured_source_safe_and_reblock_keep_both_guards_and_original_anchors(self):
        self.adapter.source_safe()
        pg_identities = {s:pg.stamp(self.owner.n.guard_path(s).stat()) for s in base.SERVICES}
        self.adapter.reblock()  # Actual NativeActivation.reblock, no substituted OS ports.
        self.adapter.source_safe()
        self.assertEqual(pg.encode(self.original.state),self.original_snapshot)
        for service in base.SERVICES:
            unit = 'address-radar-'+service+'.service'
            self.adapter.guard_identity(unit,Path(self.bridge._guard_anchor(unit)))
            self.adapter.guard_identity(unit,Path(self.bridge._guard_path(unit)))
            self.assertEqual(pg.stamp(self.owner.n.guard_path(service).stat()),pg_identities[service])
            self.assertEqual(self.owner.n.unit(service)['MainPID'],'0')
            self.command(['systemctl','start',unit],allow_failure=True)
            self.assertEqual(self.owner.n.unit(service)['MainPID'],'0')
        self.assert_retained()

    def test_unknown_dropin_is_still_rejected(self):
        self.adapter.source_safe()
        path = self.owner.n.guard_path('scanner').parent/'unexpected.conf'
        path.write_text('[Service]\n');path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'activation_untracked_dropin'):self.adapter.source_safe()
        self.assert_retained()

    def replace_guard(self):
        path = self.owner.n.guard_path('scanner');body = path.read_bytes()
        path.rename(self.root/'original-pg-guard')
        path.write_bytes(body);path.chmod(0o600)

    def test_same_body_replacement_before_first_adapter_check_is_rejected(self):
        self.replace_guard()
        with self.assertRaisesRegex(ValueError,'pg_guard_changed'):self.adapter.source_safe()
        self.assertEqual(pg.encode(self.original.state),self.original_snapshot)
        self.assert_retained()

    def test_rebuilt_adapter_cannot_adopt_replacement(self):
        self.adapter.source_safe()
        self.replace_guard()
        cls = m.borrowed_fence_type(legacy,self.owner,self.check,pg=pg)
        rebuilt = cls.__new__(cls);rebuilt._lock_control(self.original.deadline)
        self.addCleanup(rebuilt.close)
        rebuilt.state,rebuilt.prepared,rebuilt.operation_id = self.original.state,self.original.prepared,self.original.operation_id
        adapter = self.activation(rebuilt,Path(self.adapter.state['measurement']['backup']['path']))
        with self.assertRaisesRegex(ValueError,'pg_guard_changed'):adapter.source_safe()
        self.assert_retained()

    def test_missing_creation_records_fail_closed(self):
        self.owner.state.pop('guardIdentities',None);self.owner.save()
        with self.assertRaisesRegex(ValueError,'pg_guard_identity_unavailable'):self.adapter.source_safe()
        self.assert_retained()

    def test_identical_content_replacement_is_rejected(self):
        self.adapter.source_safe()
        path = self.owner.n.guard_path('scanner');body=path.read_bytes()
        path.rename(path.with_suffix('.old'));path.write_bytes(body);path.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'pg_guard_changed'):self.adapter.source_safe()
        self.assert_retained()

    def test_changed_body_and_lost_owner_never_pass(self):
        self.adapter.source_safe()
        path = self.owner.n.guard_path('scanner');path.write_bytes(b'[Unit]\n');path.chmod(0o600)
        with self.assertRaises(ValueError):self.adapter.source_safe()
        self.assert_retained()
        fcntl.flock(self.owner.fd,fcntl.LOCK_UN)
        with self.assertRaisesRegex(ValueError,'controller_lock_not_held'):self.adapter.source_safe()
        fcntl.flock(self.owner.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)

    def test_original_anchor_and_fragment_checks_remain_active(self):
        self.adapter.source_safe()
        unit = 'address-radar-scanner.service'
        anchor = Path(self.bridge._guard_anchor(unit))
        anchor.write_bytes(b'changed original anchor')
        with self.assertRaisesRegex(ValueError,'activation_guard_changed'):self.adapter.source_safe()
        self.assert_retained()

if __name__=='__main__':unittest.main()
