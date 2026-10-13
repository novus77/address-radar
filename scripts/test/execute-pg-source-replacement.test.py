"""Local boundary regressions. Native PG/systemd acceptance is a separate gate."""
import importlib.util
from pathlib import Path
import sys
import time
import unittest

spec = importlib.util.spec_from_file_location('source_execution',Path(__file__).parents[1]/'execute-pg-source-replacement.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ExecutionTests(unittest.TestCase):
    def test_publication_includes_pinned_unmanaged_settings(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        desired={'sha256':'a'*64}
        actual=SimpleNamespace(state={'artifacts':{'/env.json':{'desired':desired}}},
            file_descriptor=lambda path:desired)
        settings={'path':'/settings.json','sha256':'b'*64}
        environment={'ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE':settings['path'],
            'ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256':settings['sha256']}
        environment_pin={'path':'/environment.json','sha256':'c'*64}
        with patch.object(m,'read_pin',side_effect=lambda pin:json.dumps(environment).encode()
                if pin==environment_pin else b'{}') as read:
            self.assertEqual(m.publication_materials(actual,environment_pin),
                [{'path':'/env.json','sha256':'a'*64},settings])
            self.assertEqual(read.call_args_list[-1].args,(settings,))

    def test_publication_rejects_missing_or_changed_settings(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        actual=SimpleNamespace(state={'artifacts':{}},file_descriptor=lambda path:None)
        with patch.object(m,'read_pin',return_value=b'{}'),self.assertRaisesRegex(ValueError,'published_settings_pin'):
            m.publication_materials(actual,{'path':'/env','sha256':'a'*64})
        environment={'ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE':'/settings',
            'ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256':'b'*64}
        with patch.object(m,'read_pin',side_effect=[json.dumps(environment).encode(),ValueError('pin_changed')]), \
                self.assertRaisesRegex(ValueError,'pin_changed'):
            m.publication_materials(actual,{'path':'/env','sha256':'a'*64})

    def run_child(self,code):
        end = time.monotonic()+2
        def check():
            m.require(time.monotonic()<end,'deadline')
        m.bounded_child([sys.executable,'-c',code],check,lambda:end-time.monotonic())

    def test_success_drains_both_pipes(self):
        self.run_child("import sys;sys.stdout.write('safe');sys.stderr.write('safe')")

    def test_output_is_bounded(self):
        with self.assertRaisesRegex(ValueError,'child_output_budget'):
            self.run_child("import sys;sys.stderr.write('x'*100000)")

    def test_failure_is_closed(self):
        with self.assertRaisesRegex(ValueError,'child_failed_or_uncertain'):
            self.run_child("raise RuntimeError('secret must not be returned')")

    def test_deadline_kills_ignored_signal_child(self):
        end = time.monotonic()+.1
        def check():
            m.require(time.monotonic()<end,'deadline')
        with self.assertRaisesRegex(ValueError,'deadline'):
            m.bounded_child([sys.executable,'-c','import time;time.sleep(30)'],check,lambda:end-time.monotonic())
        self.assertLess(time.monotonic()-end,2)

    def test_noncanonical_pin_rejected(self):
        with self.assertRaisesRegex(ValueError,'pin_path'):
            m.read_pin({'path':'/private/tmp/../bad','sha256':'a'*64})


class OutputScopeTests(unittest.TestCase):
    def test_isolated_output_has_dedicated_private_parent(self):
        scope=m.ROOT/'isolated-source-replacement-aaaaaaaaaaaaaaaa'
        output=scope/'private'/'execution-test'
        self.assertEqual(m.execution_output({'operationId':'test','outputDirectory':str(output)},scope),output)
        for path in (scope/'execution-test',scope/'other'/'execution-test',scope/'private'/'execution-other'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError,'output_scope'):
                m.execution_output({'operationId':'test','outputDirectory':str(path)},scope)

    def test_production_output_contract_unchanged(self):
        output=m.ROOT/'source-replacement-execution-test'
        self.assertEqual(m.execution_output({'operationId':'test','outputDirectory':str(output)}),output)
        with self.assertRaisesRegex(ValueError,'output_scope'):
            m.execution_output({'operationId':'test','outputDirectory':str(m.ROOT/'private'/output.name)})


class DescendantTests(unittest.TestCase):
    def exercise(self, keep_pipes):
        import os
        import signal
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory(prefix='source-child-fixture-') as directory:
            pid_path = Path(directory)/'pid'
            descendant = "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(30)"
            code = ("import subprocess,sys;from pathlib import Path;"
                "p=subprocess.Popen([sys.executable,'-c',"+repr(descendant)+"],"
                + ("" if keep_pipes else "stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,")
                + "stdin=subprocess.DEVNULL);Path("+repr(str(pid_path))+").write_text(str(p.pid))")
            end = time.monotonic()+.3
            def check():
                m.require(time.monotonic()<end,'deadline')
            try:
                with self.assertRaises(ValueError):
                    m.bounded_child([sys.executable,'-c',code],check,lambda:end-time.monotonic())
                pid = int(pid_path.read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid,0)
            finally:
                if pid_path.exists():
                    try: os.kill(int(pid_path.read_text()),signal.SIGKILL)
                    except ProcessLookupError: pass

    def test_leader_exit_descendant_retaining_pipes_is_drained(self):
        self.exercise(True)

    def test_leader_exit_descendant_closing_pipes_is_not_success(self):
        self.exercise(False)


class IsolatedEntryBoundaryTests(unittest.TestCase):
    def test_mixed_production_inputs_refuse_before_any_native_effect(self):
        import json
        from unittest.mock import patch
        suffix = 'a' * 16
        scope = '/var/lib/address-radar-maintenance-tools/isolated-source-replacement-' + suffix
        pin = lambda name: {'path': scope + '/' + name, 'sha256': 'b' * 64}
        identity = {'protocol': 'address-only-isolated-rotation-v1', 'systemIdentifier': '123',
                    'database': 'radar_rehearsal_' + suffix, 'username': 'radar_migrator_' + suffix}
        fields = ('fenceRequest', 'adapter', 'sequence', 'controllerConfig', 'transition',
                  'importTemplate', 'probeTemplate', 'selfPin')
        for fault in ('controllerConfig', 'controllerPins', 'rotationDirectory', 'nested_config'):
            with self.subTest(fault=fault):
                job = {key: pin(key) for key in fields}
                job.update(protocol='address-only-source-replacement-isolated-execution-v1',
                    operationId='test', approvalRef='test', replacementSha256='c'*64,
                    deadlineAtMs=int(time.time()*1000)+60000, outputDirectory=scope+'/private/execution-test',
                    rotationDirectory=scope+'/address-only-auth-' + suffix, isolatedIdentity=pin('identity'), isolatedRuntime=pin('runtime'),
                    controllerPins={key:pin(key) for key in ('pgFence','configured','activation','controller')},
                    tools={key:pin(key) for key in ('python','node','rotation','rotationSupport','import','probe')})
                if fault == 'controllerConfig': job[fault] = {'path':'/var/lib/address-radar-maintenance-tools/controller-config-v4.json','sha256':'b'*64}
                if fault == 'controllerPins': job[fault]['configured'] = {'path':'/var/lib/address-radar-maintenance-tools/configured-controller-20261009e/activate-configured.py','sha256':'b'*64}
                if fault == 'rotationDirectory': job[fault] = '/var/lib/address-radar-maintenance-tools/production-rotation'
                def read(value, *args):
                    if value == {'path':'/job','sha256':'b'*64}: return json.dumps(job).encode()
                    if value == job['isolatedIdentity']: return json.dumps(identity).encode()
                    return json.dumps({'environment':{'path':'/etc/address-radar/wallet-monitor.env','sha256':'b'*64}}
                                      if fault == 'nested_config' and value == job['controllerConfig'] else {}).encode()
                with patch.object(m.sys,'platform','linux'), patch.object(m.os,'geteuid',return_value=0), \
                     patch.object(m.Path,'is_file',return_value=True), patch.object(m,'read_pin',side_effect=read), patch.object(m,'load') as load, \
                     patch.object(m.Path,'mkdir') as mkdir, patch.object(m.subprocess,'check_output') as command:
                    with self.assertRaisesRegex(ValueError, 'isolated_'):
                        m.execute({'path':'/job','sha256':'b'*64})
                    load.assert_not_called(); mkdir.assert_not_called(); command.assert_not_called()



class IsolatedRuntimeTests(unittest.TestCase):
    def exercise(self, fault=None):
        import types
        from unittest.mock import patch
        scope = m.ROOT/'isolated-source-replacement-aaaaaaaaaaaaaaaa'
        names = ('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')
        def text(path, *args, **kwargs):
            if str(path) == '/proc/1/comm': return 'systemd\n'
            if str(path) == '/proc/self/mountinfo':
                root = '1 0 0:1 / / rw - overlay overlay rw\n'
                if fault == 'host-root': return root.replace('overlay overlay', 'ext4 /dev/root')
                if fault == 'host-mount': root += '2 1 8:1 /var/lib /var/lib rw - ext4 /dev/root rw\n'
                return root + '3 1 0:2 / /run rw - tmpfs tmpfs rw\n'
            raise AssertionError('Unexpected file')
        def ns(path):
            return types.SimpleNamespace(st_dev=1, st_ino=12345)
        def command(argv, **kwargs):
            if 'list-unit-files' in argv:
                units = ['address-radar-'+name+'.service enabled' for name in names]
                if fault == 'extra-unit': units += ['address-radar-production.service enabled']
                return ('\n'.join(units)).encode()
            fragment = str(scope/'fixture.service') if fault != 'production-fragment' else '/etc/systemd/system/address-radar-scanner.service'
            env = str(scope/'fixture.env') if fault != 'production-env' else '/etc/address-radar/scanner.env'
            drop = '/etc/systemd/system/production.conf' if fault == 'production-dropin' else ''
            return ('FragmentPath='+fragment+'\nDropInPaths='+drop+'\nEnvironmentFiles='+env+' (ignore_errors=no)\nExecStart='+str(scope/'fixture')+'\nUser=nobody\n').encode()
        with patch.object(m.Path,'read_text',text), patch.object(m.os,'stat',side_effect=ns), \
             patch.object(m.Path,'resolve',lambda p:p), patch.object(m.subprocess,'check_output',side_effect=command):
            with patch.object(m,'verify_isolated_manager'), patch.object(m.os,'readlink',return_value='ns:[4026531836]' if fault == 'host-namespace' else 'ns:[12345]'):
                m.verify_isolated_runtime(scope, {'protocol':'address-only-disposable-launch-v1',
                    'containerId':'a'*64,'machineId':'a'*32,'namespaces':dict.fromkeys(('pid','mnt','net'),'ns:[12345]'),
                    'hostNamespaces':dict.fromkeys(('pid','mnt','net'),'ns:[4026531836]')})

    def test_synthetic_private_runtime_is_accepted(self):
        self.exercise()

    def test_actual_evidence_mismatch_is_refused(self):
        for fault in ('host-root','host-mount','host-namespace','extra-unit',
                      'production-fragment','production-env','production-dropin'):
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError,'isolated_'):
                self.exercise(fault)


class IsolatedManagerBoundaryTests(unittest.TestCase):
    def test_host_peer_or_wrong_machine_refused(self):
        import socket, struct
        from unittest.mock import patch, MagicMock
        for pid, uid, machine in ((0,0,'a'*32),(22,0,'a'*32),(1,1000,'a'*32),(1,0,'b'*32)):
            with self.subTest(pid=pid,uid=uid,machine=machine):
                channel = MagicMock()
                channel.__enter__.return_value = channel
                channel.getsockopt.return_value = struct.pack('3i',pid,uid,0)
                with patch.object(m.socket,'SO_PEERCRED',17,create=True), patch.object(m.socket,'socket',return_value=channel), \
                     patch.object(m.Path,'read_text',side_effect=['systemd',machine]), \
                     patch.dict(m.os.environ,{},clear=True):
                    with self.assertRaisesRegex(ValueError,'isolated_manager'):
                        m.verify_isolated_manager('a'*32)

    def test_bus_override_refused_before_socket(self):
        from unittest.mock import patch
        with patch.dict(m.os.environ,{'DBUS_SYSTEM_BUS_ADDRESS':'unix:path=/host/bus'},clear=True), \
             patch.object(m.socket,'socket') as channel:
            with self.assertRaisesRegex(ValueError,'isolated_manager_environment'):
                m.verify_isolated_manager('a'*32)
            channel.assert_not_called()


class RotationScopeTests(unittest.TestCase):
    def test_isolated_rotation_uses_execute_scope_only(self):
        spec = importlib.util.spec_from_file_location('isolated_rotation_scope',Path(__file__).parents[1]/'rotate-address-only-migrator.py')
        rotation = importlib.util.module_from_spec(spec); spec.loader.exec_module(rotation)
        suffix = 'a'*16
        target = {'database':'radar_rehearsal_'+suffix}
        scope = m.ROOT/('isolated-source-replacement-'+suffix)
        expected = scope/('address-only-auth-'+'b'*16)
        self.assertEqual(rotation.isolated_rotation_directory(target,str(expected)),expected)
        for path in (m.ROOT/expected.name, m.ROOT/('isolated-source-replacement-'+'c'*16)/expected.name,
                     scope/'rotation',scope/'x'/'..'/expected.name):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError,'isolated_directory'):
                rotation.isolated_rotation_directory(target,str(path))

def native_guest(scope, evidence):
    """Disposable Linux only: real socket, namespaces, mounts and systemd units."""
    import json, os, subprocess
    scope = Path(scope)
    proof = json.loads(Path(evidence).read_bytes())
    m.verify_isolated_runtime(scope, proof)
    # Real filesystem contract: services retain traverse access, audit stays private.
    pg_spec=importlib.util.spec_from_file_location('native_private_output',scope/'pg-source-replacement-fence.py')
    pg=importlib.util.module_from_spec(pg_spec);pg_spec.loader.exec_module(pg)
    assert scope.stat().st_mode & 0o077
    try: pg.private_path(scope,directory=True)
    except ValueError as error: assert str(error)=='unsafe_private_path'
    else: raise AssertionError('traverseable scope admitted as private')
    private=scope/'private';private.mkdir(mode=0o700)
    pg.private_path(private,directory=True)
    audit=m.execution_output({'operationId':'private-audit','outputDirectory':str(private/'execution-private-audit')},scope)
    audit.mkdir(mode=0o700);pg.sync(private)
    pg.durable(audit/'intent.json',b'{"fixtureOnly":true}\n')
    pg.private_path(audit,directory=True);pg.private_path(audit/'intent.json')
    private.chmod(0o750)
    try: pg.private_path(private,directory=True)
    except ValueError as error: assert str(error)=='unsafe_private_path'
    else: raise AssertionError('nonprivate audit parent admitted')
    private.chmod(0o700)
    def pin(path, value):
        raw = m.encode(value)
        path.write_bytes(raw); path.chmod(0o600)
        return {'path':str(path),'sha256':m.hashlib.sha256(raw).hexdigest()}
    suffix = scope.name.removeprefix('isolated-source-replacement-')
    identity = {'protocol':'address-only-isolated-rotation-v1','database':'radar_rehearsal_'+suffix,
                'username':'radar_migrator_'+suffix,'systemIdentifier':'123'}
    stub = scope/'unreachable.py'
    stub.write_text('raise AssertionError("native_module_must_not_load")\n'); stub.chmod(0o600)
    module_pin = {'path':str(stub),'sha256':m.hashlib.sha256(stub.read_bytes()).hexdigest()}
    target = {key:identity[key] for key in ('database','username','systemIdentifier')}
    target['schema'] = target['database']
    job = {key:pin(scope/(key+'.json'),{'target':target} if key=='importTemplate' else {})
           for key in ('fenceRequest','controllerConfig','transition','importTemplate','probeTemplate')}
    job.update(protocol='address-only-source-replacement-isolated-execution-v1',operationId='native-boundary',
        approvalRef='isolated-only',replacementSha256='a'*64,deadlineAtMs=int(time.time()*1000)+60000,
        outputDirectory=str(scope/'private'/'execution-native-boundary'),rotationDirectory=str(scope/('address-only-auth-'+'b'*16)),
        isolatedIdentity=pin(scope/'identity.json',identity),isolatedRuntime=pin(scope/'runtime.json',proof),
        adapter=module_pin,sequence=module_pin,selfPin=module_pin,
        controllerPins=dict.fromkeys(('pgFence','configured','activation','controller'),module_pin),
        tools=dict.fromkeys(('python','node','rotation','rotationSupport','import','probe'),module_pin))
    job_pin = pin(scope/'job.json',job)
    before = subprocess.check_output(['systemctl','show','address-radar-*.service','-p','MainPID','-p','ActiveState'])
    def denied(expected):
        try: m.execute(job_pin)
        except ValueError as error:
            if str(error) != expected: raise
        else: raise AssertionError('execute unexpectedly accepted')
        assert not Path(job['outputDirectory']).exists()
        assert not (m.ROOT/'pg-source-acquisition-blocked').exists()
        assert not list(Path('/etc/systemd/system').glob('address-radar-*.service.d/*'))
    original = dict(proof)
    bad = dict(proof,machineId='0'*32)
    job['isolatedRuntime'] = pin(scope/'runtime.json',bad); job_pin = pin(scope/'job.json',job)
    denied('isolated_manager_machine')
    job['isolatedRuntime'] = pin(scope/'runtime.json',original); job_pin = pin(scope/'job.json',job)
    os.environ['DBUS_SYSTEM_BUS_ADDRESS']='unix:path=/host/bus'
    try: denied('isolated_manager_environment')
    finally: del os.environ['DBUS_SYSTEM_BUS_ADDRESS']
    # A tmpfs manager socket inherited/bind-mounted from the ancestor PID namespace
    # has SO_PEERCRED pid=0 in the child. This is not a mocked peer credential.
    child_code = ('import importlib.util,json;'
        's=importlib.util.spec_from_file_location("e",'+repr(str(scope/'execute-pg-source-replacement.py'))+');'
        'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);'
        '\ntry:m.execute('+repr(job_pin)+')'
        '\nexcept ValueError as e:\n assert str(e)=="isolated_manager_peer",str(e);print("PEER_ZERO_REFUSED")'
        '\nelse:raise AssertionError("unsafe manager accepted")')
    child = scope/'peer-negative.py'; child.write_text(child_code); child.chmod(0o600)
    script = ('mkdir -p /tmp/ancestor-manager; mount --bind /run/systemd /tmp/ancestor-manager; '
              'mount --bind /tmp/ancestor-manager /run/systemd; exec python3 '+str(child))
    result = subprocess.check_output(['unshare','--pid','--mount','--fork','--mount-proc','/bin/sh','-ec',script],
                                    stderr=subprocess.PIPE,timeout=10)
    assert b'PEER_ZERO_REFUSED' in result
    assert not Path(job['outputDirectory']).exists()
    assert not (m.ROOT/'pg-source-acquisition-blocked').exists()
    assert not list(Path('/etc/systemd/system').glob('address-radar-*.service.d/*'))
    assert not Path(job['rotationDirectory']).exists()
    after = subprocess.check_output(['systemctl','show','address-radar-*.service','-p','MainPID','-p','ActiveState'])
    assert before == after
    print('NATIVE_LOCAL_MANAGER_ACCEPTED_ANCESTOR_TMPFS_PEER_ZERO_REFUSED_ZERO_EFFECTS')


@unittest.skipUnless(__import__('os').environ.get('ADDRESS_RADAR_EXECUTE_ISOLATION_NATIVE') == '1',
                     'Explicit disposable Docker native gate required')
class NativeIsolationTests(unittest.TestCase):
    def test_disposable_actual_manager_and_host_tmpfs_bind_boundary(self):
        import json, os, secrets, subprocess, tempfile
        def docker(*args):
            try:
                return subprocess.check_output(['docker',*args],stderr=subprocess.PIPE,timeout=30).decode().strip()
            except subprocess.CalledProcessError as error:
                if args[:1] == ('exec',) and 'is-system-running' in args: raise
                raise AssertionError(error.stderr.decode()[:8192]) from error
        suffix = secrets.token_hex(8)
        name = 'radar-manager-boundary-'+suffix
        scope = '/var/lib/address-radar-maintenance-tools/isolated-source-replacement-'+suffix
        image = docker('image','inspect','address-radar-source-execute-isolated:20261010','--format','{{.Id}}')
        machine_id = secrets.token_hex(16)
        try:
            docker('run','-d','--name',name,'--network','none','--memory','384m','--cpus','1','--pids-limit','256',
                   '--cgroupns','private','--cap-add','SYS_ADMIN','--cap-add','SYS_PTRACE',
                   '--tmpfs','/run','--tmpfs','/tmp','--tmpfs','/var/lib/postgresql/data','--security-opt','no-new-privileges',
                   '--entrypoint','/bin/sh',image,'-ec',
                   'printf "%s\\n" '+machine_id+' > /etc/machine-id; mount -o remount,rw /sys/fs/cgroup; exec /sbin/init --log-level=warning')
            for attempt in range(15):
                try:
                    state = docker('exec',name,'systemctl','is-system-running')
                    if state in ('running','degraded'): break
                except subprocess.CalledProcessError: pass
                time.sleep(.2)
            info = json.loads(docker('inspect',name))[0]
            self.assertEqual(info['HostConfig']['NetworkMode'],'none')
            self.assertEqual(info['HostConfig']['PidMode'],'')
            self.assertEqual(info['HostConfig']['CgroupnsMode'],'private')
            self.assertFalse(info['HostConfig'].get('Binds'))
            self.assertTrue(all(item['Type']=='tmpfs' for item in info['Mounts']))
            pid = info['State']['Pid']
            # Read-only daemon-host observation. No host filesystem mounts, host
            # networking, or host mutations; only six namespace symlink reads.
            code = ('import os,json; print(json.dumps({str(p):{n:os.readlink("/proc/"+str(p)+"/ns/"+n) '
                    'for n in ("pid","mnt","net")} for p in (1,'+str(pid)+')}))')
            actual = json.loads(docker('run','--rm','--read-only','--network','none','--pid','host',
                       '--cap-drop','ALL','--cap-add','SYS_PTRACE','--security-opt','no-new-privileges',
                       '--entrypoint','python3',image,'-c',code))
            self.assertTrue(all(actual['1'][n]!=actual[str(pid)][n] for n in ('pid','mnt','net')))
            evidence = {'protocol':'address-only-disposable-launch-v1','containerId':info['Id'],
                        'machineId':machine_id,'namespaces':actual[str(pid)],'hostNamespaces':actual['1']}
            docker('exec',name,'mkdir','-p',scope+'/test')
            for source, destination in ((Path(__file__).parents[1]/'execute-pg-source-replacement.py',scope+'/execute-pg-source-replacement.py'),
                                        (Path(__file__).parents[1]/'pg-source-replacement-fence.py',scope+'/pg-source-replacement-fence.py'),
                                        (Path(__file__),scope+'/test/execute-pg-source-replacement.test.py')):
                docker('cp',str(source),name+':'+destination)
            with tempfile.TemporaryDirectory(prefix='radar-native-manager-') as directory:
                local = Path(directory)/'evidence.json'; local.write_text(json.dumps(evidence)); local.chmod(0o600)
                docker('cp',str(local),name+':'+scope+'/evidence.json')
            services = ('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')
            setup = ('import os,pathlib,subprocess; s=pathlib.Path('+repr(scope)+');'
                'os.chmod(s,0o755);(s/"fixture").write_text("#!/bin/sh\\nexec /usr/bin/sleep infinity\\n");'
                'os.chmod(s/"fixture",0o755);(s/"fixture.env").write_text("FIXTURE_ONLY=1\\n");'
                '\nfor name in '+repr(services)+':\n'
                ' p=s/("address-radar-"+name+".service");p.write_text("[Service]\\nUser=nobody\\nExecStart="+str(s/"fixture")+"\\nEnvironmentFile="+str(s/"fixture.env")+"\\n");'
                'subprocess.run(["systemctl","link",str(p)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)'
                '\nsubprocess.run(["systemctl","daemon-reload"],check=True)'
                '\nsubprocess.run(["systemctl","start",*[("address-radar-"+n+".service") for n in '+repr(services)+']],check=True)')
            docker('exec',name,'python3','-c',setup)
            output = docker('exec',name,'python3',scope+'/test/execute-pg-source-replacement.test.py',
                            '--native-guest',scope,scope+'/evidence.json')
            self.assertIn('NATIVE_LOCAL_MANAGER_ACCEPTED_ANCESTOR_TMPFS_PEER_ZERO_REFUSED_ZERO_EFFECTS',output)
            audit_directory = Path(tempfile.mkdtemp(prefix='source-isolation-native-',dir='/private/tmp'))
            audit_directory.chmod(0o700)
            receipt = {'status':'PASS','containerId':info['Id'],'image':image,'evidence':evidence,
                       'networkMode':info['HostConfig']['NetworkMode'],'binds':info['HostConfig'].get('Binds'),
                       'mountTypes':[item['Type'] for item in info['Mounts']],
                       'localManagerAccepted':True,'ancestorTmpfsPeerZeroRefused':True,
                       'executeBeforeFenceRefused':True,'guardStopRotationEffects':0,
                       'fullRotationImportHandoffTested':False,'productionAccessed':False}
            raw = m.encode(receipt); receipt_path = audit_directory/'receipt.json'
            receipt_path.write_bytes(raw); receipt_path.chmod(0o600)
            print(output)
            print('NATIVE_RECEIPT='+str(receipt_path)+' SHA256='+m.hashlib.sha256(raw).hexdigest())
        finally:
            subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)


class CompletedActivationTests(unittest.TestCase):
    def fixture(self):
        import copy, types, grp
        spec = importlib.util.spec_from_file_location('complete_test_base',Path(__file__).parents[1]/'activate-address-only-postgres.py')
        base = importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
        scope = m.ROOT/'isolated-source-replacement-aaaaaaaaaaaaaaaa'
        services = base.SERVICES; operation='complete-test'; output=scope/('address-only-run-'+operation)
        raw = {}
        def pin(path,value):
            data=base.encode(value);raw[str(path)]=data
            return {'path':str(path),'sha256':m.hashlib.sha256(data).hexdigest()}
        tool=pin(scope/'tool',{})
        config={'protocol':'address-only-controller-v1','operationId':operation,'outputDirectory':str(output),
                **dict.fromkeys(('fence','reconcile','exporter','validator','launcher','node'),tool)}
        config['jobTemplate']={'operationId':operation,'action':'plan','outputDirectory':str(output),'sourceFence':tool}
        target={'database':'radar_rehearsal_'+'a'*16,'schema':'radar_rehearsal_'+'a'*16,'systemIdentifier':'123'}
        job={'protocol':'address-only-isolated-activation-v1','operationId':operation,'target':target,
             'generationId':'isolated-recovery-'+'a'*16,'roles':{s:'radar_'+'a'*16+'_'+s.replace('-','_') for s in services}}
        jp=pin(scope/'job.json',job)
        binding={'operationId':operation,'generationId':job['generationId'],'importId':'import','planSha256':'b'*64,'target':target}
        manifest={'protocol':'address-only-v1',**binding,'releaseSha256':'c'*64,
                  'gatewayDeliveryEnabled':False,'fomoEnabled':False,'fullHistoricalMiningEnabled':False}
        receipt={'protocol':'address-only-activation-receipt-v1','proofScope':'isolated-activation','isolatedJob':jp,
                 'operationId':operation,'generationId':job['generationId'],'attempt':'attempt',
                 'sourceMonitoring':'waiting_configuration','databaseImported':True,'businessReleaseSwitched':True,
                 'monitoringCompleted':False,'gatewayDeliveryEnabled':False,'releaseRoot':str(scope/'release'),'releaseSha256':'c'*64}
        state={'protocol':'address-only-activation-state-v1','phase':'COMPLETE','pending':None,'operationId':operation,
               'receipt':receipt,'configSha256':m.hashlib.sha256(base.encode(config)).hexdigest(),
               'manifestSha256':m.hashlib.sha256(base.encode(manifest)).hexdigest(),'generator':tool,
               'isolatedActivation':dict(job,scope=str(scope),jobPin=jp),'measurement':{'binding':binding},
               'nodePath':tool['path'],'node':{'sha256':tool['sha256'],'stamp':[1,2,2,0,0,0o100555,1,3,4],'size':2},'releaseRoot':str(scope/'release'),
               'release':{'releaseSha256':'c'*64},'attempt':'attempt','waitingResourcePolicy':base.WAITING_POLICY,
               'units':{s:{'published':True,'unguarded':True,'started':True,'ready':{}} for s in services},'artifacts':{}}
        account=types.SimpleNamespace(pw_name='address-radar',pw_uid=123,pw_gid=0)
        builder=types.SimpleNamespace(state=state,account=account,config=config,node=Path(tool['path']),
                    release=scope/'release',directory=scope/'runtime'/('postgresql-'+operation))
        builder.dropin=lambda s:scope/'units'/('address-radar-'+s+'.service.d')/('99-address-only-postgresql-'+operation+'.conf')
        def managed(path,data,mode):
            state['artifacts'][str(path)]={'desired':{'sha256':m.hashlib.sha256(data).hexdigest(),'uid':0,'gid':0,'mode':mode}}
        builder.managed=managed
        fragments={}
        for service in services:
            base.NativeActivation.publish(builder,service)
            fragments[service]=pin(scope/'units'/('address-radar-'+service+'.service'),{})
            for path in (builder.directory/(service+'.env'),builder.directory/'deployment.json',builder.directory/'evidence.json'):
                state['artifacts'][str(path)]={'desired':{'sha256':'d'*64,'uid':0,'gid':0,'mode':0o600}}
        deployment={'sources':{'mode':'waiting_configuration'},'cutover':{'addressOnly':manifest},'releaseRoot':str(scope/'release')}
        state['artifacts'][str(builder.directory/'deployment.json')]['desired']['sha256']=m.hashlib.sha256(base.encode(deployment)).hexdigest()
        pins={'state':pin(output/'activation-state.json',state),'receipt':pin(output/'activation-receipt.json',receipt),
              'config':pin(scope/'config.json',config),'isolatedJob':jp,'manifest':pin(output/'address-only-manifest.json',manifest),
              'activationModule':tool,'unitFragments':fragments}
        return scope,pins,raw,state,base,account,copy.deepcopy(state['artifacts']),deployment

    def exercise(self, fault=None):
        from unittest.mock import patch
        scope,pins,raw,state,base,account,actual,deployment=self.fixture()
        node_actual=__import__('copy').deepcopy(state['node'])
        if fault=='node-stamp':state['node']['stamp'][1]+=1
        if fault=='node-size':state['node']['size']+=1
        if fault=='node-digest':state['node']['sha256']='0'*64
        if fault in ('execute-config','execute-manifest'):
            key='config' if fault=='execute-config' else 'manifest'
            state[key+'Sha256']=m.hashlib.sha256(m.encode(__import__('json').loads(raw[pins[key]['path']]))).hexdigest()
        if fault=='phase':state['phase']='PUBLISHED'
        if fault=='pending':state['pending']={'action':'file'}
        if fault=='receipt':state['receipt']['gatewayDeliveryEnabled']=True
        if fault=='config':state['configSha256']='0'*64
        if fault=='job':state['isolatedActivation']['target']['database']='production'
        if fault=='dropin':
            key=next(p for p in state['artifacts'] if p.endswith('.conf'));state['artifacts'][key]['desired']['sha256']='0'*64
        if fault=='artifact':
            key=next(p for p in actual if p.endswith('.env'));actual[key]['desired']['sha256']='0'*64
        if fault=='unknown-fragment':pins['unitFragments']['scanner']['path']=str(scope/'units'/'other.service')
        raw[pins['state']['path']]=base.encode(state)
        with patch.object(m,'read_pin',side_effect=lambda p,*args:raw[p['path']]), \
             patch.object(m,'load',return_value=base), patch.object(base,'release_inventory',return_value=state['release']), \
             patch.object(base,'sealed_file',return_value=(node_actual,b'')), \
             patch.object(base.NativeActivation,'file_descriptor',lambda self,p:actual[str(p)]['desired']), \
             patch('pwd.getpwnam',return_value=account), patch.object(m.Path,'read_bytes',return_value=base.encode(deployment)):
            return m.isolated_completed_activation(scope,pins)

    def test_exact_complete_body_and_artifacts_accepted_readonly(self):
        self.assertIsNotNone(self.exercise())

    def test_original_encoder_differs_and_original_digest_is_accepted(self):
        import json
        scope,pins,raw,state,base,*rest=self.fixture()
        for key in ('config','manifest'):
            value=json.loads(raw[pins[key]['path']])
            self.assertNotEqual(base.encode(value),m.encode(value))
            self.assertEqual(state[key+'Sha256'],m.hashlib.sha256(base.encode(value)).hexdigest())
        self.assertIsNotNone(self.exercise())

    def test_execute_encoded_old_digest_is_not_accepted(self):
        for fault in ('execute-config','execute-manifest'):
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError,'isolated_complete_state'):
                self.exercise(fault)

    def test_native_node_measurement_is_not_a_config_pin(self):
        scope,pins,raw,state,base,*rest=self.fixture()
        config=__import__('json').loads(raw[pins['config']['path']])
        self.assertEqual(set(state['node']),{'sha256','stamp','size'})
        self.assertEqual(set(config['node']),{'path','sha256'})
        self.assertIsNotNone(self.exercise())

    def test_native_node_stamp_size_and_digest_drift_refused(self):
        for fault in ('node-stamp','node-size','node-digest'):
            with self.subTest(fault=fault), self.assertRaisesRegex(ValueError,'isolated_complete_executables'):
                self.exercise(fault)

    def test_incomplete_or_drifted_publication_refused(self):
        for fault in ('phase','pending','receipt','config','job','dropin','artifact','unknown-fragment'):
            with self.subTest(fault=fault), self.assertRaises((ValueError,KeyError)):
                self.exercise(fault)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--native-guest']:
        native_guest(*sys.argv[2:])
    else:
        unittest.main()

