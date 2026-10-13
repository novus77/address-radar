import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('rotation', Path(__file__).parents[1] / 'rotate-address-only-migrator.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Tests(unittest.TestCase):
    def test_expired_boundary(self):
        m.validate_boundary(self.boundary(), 1000)
    def boundary(self):
        return {'system':'7693392208475083526','databaseOid':'16391','roleOid':'16384','login':True,'limit':1,
            'memberships':0,'otherLogins':0,'sessions':0,'unsafe':False,'expiryMs':1,'epoch':'fixed'}
    def test_rejects_live_sessions(self):
        b=self.boundary();b['sessions']=1
        with self.assertRaises(ValueError):m.validate_boundary(b,1000)
    def service_boundary(self):
        return dict(self.boundary(),otherLogins=6,serviceAclSafe=True,serviceLogins=[
            {'name':name,'oid':oid,'limit':1,'unsafe':False,'memberships':0}
            for name,oid in sorted(m.SERVICE_ROLES.items())])
    def test_accepts_exact_least_privilege_service_roles(self):
        m.validate_boundary(self.service_boundary(),1000)
    def test_rejects_dangerous_acl_or_missing_measurement(self):
        for measured in (False, None):
            with self.assertRaises(ValueError):
                m.validate_boundary(dict(self.service_boundary(),serviceAclSafe=measured),1000)
    def test_rejects_service_role_identity_or_privilege_drift(self):
        for field,value in [('oid','99999'),('limit',2),('unsafe',True),('memberships',1),('name','unexpected')]:
            with self.subTest(field=field):
                b=self.service_boundary();b['serviceLogins'][0][field]=value
                with self.assertRaises(ValueError):m.validate_boundary(b,1000)
    def test_rejects_duplicate_or_missing_service_roles(self):
        for rows in [self.service_boundary()['serviceLogins'][:-1],
                     [self.service_boundary()['serviceLogins'][0]]*6]:
            b=dict(self.service_boundary(),serviceLogins=rows)
            with self.assertRaises(ValueError):m.validate_boundary(b,1000)
    def test_rejects_unexpired(self):
        with self.assertRaises(ValueError):m.validate_boundary(self.boundary(),0)
    def test_unknown_commit_never_receipted(self):
        saved={}
        class Adapter:
            def boundary(s):return self.boundary()
            def apply(s,*args):raise RuntimeError('lost_ack')
        with self.assertRaises(RuntimeError):m.rotate(Adapter(),lambda k,v:saved.__setitem__(k,v),'op',1000,'secret','verifier', approval_ref='current-approval', replacement_sha256='a'*64)
        self.assertIn('intent.json',saved);self.assertNotIn('receipt.json',saved)

class OperationBindingTests(unittest.TestCase):
    def run_rotation(self, **overrides):
        saved = {}
        before = Tests().boundary()
        class Adapter:
            applied = False
            authenticated = False
            def boundary(s): return dict(before, expiryMs=7201000) if s.applied else dict(before)
            def apply(s, verifier, expiry):
                self.assertEqual((verifier, expiry), ('verifier', 7201000))
                s.applied = True
            def authenticate(s, password):
                self.assertEqual(password, 'secret')
                s.authenticated = True
        adapter = Adapter()
        args = dict(approval_ref='user-approved-publicnode-replacement', replacement_sha256='a'*64)
        args.update(overrides)
        receipt = m.rotate(adapter, lambda k,v:saved.__setitem__(k,v), 'replacement-operation', 1000,
            'secret', 'verifier', **args)
        return receipt, saved, adapter

    def test_current_operation_and_replacement_are_bound_to_audit(self):
        import json
        receipt, saved, adapter = self.run_rotation()
        for name in ('plan.json', 'intent.json', 'receipt.json'):
            value = json.loads(saved[name])
            self.assertEqual(value['operationId'], 'replacement-operation')
            self.assertEqual(value['approvalRef'], 'user-approved-publicnode-replacement')
            self.assertEqual(value['replacementSha256'], 'a'*64)
            self.assertNotIn('20261007', saved[name].decode())
            self.assertNotIn('secret', saved[name].decode())
        self.assertTrue(adapter.authenticated)
        self.assertEqual(receipt['expiresAtMs'], 7201000)

    def test_invalid_authorization_is_rejected_before_boundary_or_storage(self):
        from unittest.mock import Mock
        for ref, digest in [('', 'a'*64), ('line\nbreak', 'a'*64), ('approved', 'x'*64), ('approved', 'a'*63)]:
            adapter, storage = Mock(), Mock()
            with self.subTest(ref=ref, digest=digest), self.assertRaises(ValueError):
                m.rotate(adapter, storage, 'replacement-operation', 1000, 'secret', 'verifier',
                    approval_ref=ref, replacement_sha256=digest)
            adapter.boundary.assert_not_called()
            storage.assert_not_called()

    def test_tcp_login_failure_preserves_intent_without_success_receipt(self):
        saved = {}
        before = Tests().boundary()
        class Adapter:
            applied = False
            def boundary(s): return dict(before, expiryMs=7201000) if s.applied else dict(before)
            def apply(s, verifier, expiry): s.applied = True
            def authenticate(s, password): raise RuntimeError('authentication_failed')
        adapter = Adapter()
        with self.assertRaisesRegex(RuntimeError, 'authentication_failed'):
            m.rotate(adapter, lambda k,v:saved.__setitem__(k,v), 'replacement-operation', 1000,
                'secret', 'verifier', approval_ref='current-approval', replacement_sha256='a'*64)
        self.assertTrue(adapter.applied)
        self.assertIn('intent.json', saved)
        self.assertIn('credential.json', saved)
        self.assertNotIn('receipt.json', saved)


class IsolatedRotationTests(unittest.TestCase):
    def target(self):
        return {'protocol':'address-only-isolated-rotation-v1','systemIdentifier':'123456789',
            'database':'radar_rehearsal_0123456789abcdef','databaseOid':'42',
            'username':'radar_migrator_0123456789abcdef','roleOid':'43',
            'host':'127.0.0.1','port':5432}

    def test_explicit_isolated_rotation_uses_bound_identity_and_real_authentication(self):
        import json
        target = self.target()
        before = dict(Tests().boundary(),system=target['systemIdentifier'],databaseOid=target['databaseOid'],roleOid=target['roleOid'])
        saved = {}
        class Adapter:
            applied = False
            authenticated = False
            def boundary(s): return dict(before,expiryMs=7201000) if s.applied else dict(before)
            def apply(s,verifier,expiry): s.applied = True
            def authenticate(s,password): s.authenticated = True
        adapter = Adapter()
        result = m.rotate_isolated(adapter,lambda k,v:saved.__setitem__(k,v),'isolated',1000,'secret','verifier',
            expected_identity=target,approval_ref='isolated-approved',replacement_sha256='a'*64)
        self.assertTrue(adapter.authenticated)
        self.assertEqual(result['system'],target['systemIdentifier'])
        self.assertEqual(json.loads(saved['credential.json'])['database'],target['database'])
        self.assertEqual(json.loads(saved['credential.json'])['user'],target['username'])

    def test_production_identity_is_refused_before_any_adapter_call(self):
        from unittest.mock import Mock
        for changed in ({'systemIdentifier':'7693392208475083526'}, {'database':'address_radar'},
                        {'username':'address_radar_migrator'}, {'host':'remote.invalid'}, {'port':5433}):
            with self.subTest(changed=changed):
                adapter,storage = Mock(),Mock()
                with self.assertRaises(ValueError):
                    m.rotate_isolated(adapter,storage,'isolated',1000,'secret','verifier',
                        expected_identity=dict(self.target(),**changed),approval_ref='isolated-approved',replacement_sha256='a'*64)
                adapter.boundary.assert_not_called()
                storage.assert_not_called()

    def test_default_production_path_still_refuses_isolated_identity(self):
        from unittest.mock import Mock
        adapter = Mock()
        adapter.boundary.return_value = dict(Tests().boundary(),system='123456789')
        with self.assertRaisesRegex(ValueError,'target_changed'):
            m.rotate(adapter,Mock(),'isolated',1000,'secret','verifier',
                approval_ref='isolated-approved',replacement_sha256='a'*64)
        adapter.apply.assert_not_called()

@unittest.skipUnless(__import__('os').environ.get('ADDRESS_RADAR_ISOLATED_ROTATION_PG') == '1',
    'explicit disposable local PG container opt-in required')
class NativeIsolatedRotationTests(unittest.TestCase):
    @classmethod
    def command(cls,args,input=None):
        import subprocess
        result = subprocess.run(['docker',*args],input=input,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
        if result.returncode:
            raise AssertionError('isolated container command failed')
        return result.stdout.decode().strip()

    @classmethod
    def sql(cls,text,database='postgres'):
        return cls.command(['exec','-i','-u','postgres',cls.container,'psql','-X','-qAt','-h','/var/run/postgresql',
            '-d',database,'-v','ON_ERROR_STOP=1'],text.encode())

    @classmethod
    def setUpClass(cls):
        import secrets
        import json
        import time
        cls.container = 'source-rotation-isolated-'+secrets.token_hex(6)
        cls.database = 'radar_rehearsal_'+secrets.token_hex(8)
        cls.username = 'radar_migrator_'+secrets.token_hex(8)
        cls.command(['run','--pull=never','-d','--name',cls.container,'--network','none',
            '--memory','384m','--cpus','1','--pids-limit','128',
            '--tmpfs','/var/lib/postgresql/data:rw,size=128m','--entrypoint','/bin/sh',
            'address-radar-source-execute-isolated:20261010','-c','exec sleep infinity'])
        cls.addClassCleanup(lambda:cls.command(['rm','-f',cls.container]))
        cls.command(['exec',cls.container,'sh','-ec',
            'chown postgres:postgres /var/lib/postgresql/data; chmod 700 /var/lib/postgresql/data; '
            'install -d -m 775 -o postgres -g postgres /var/run/postgresql; '
            'mkdir -m 700 -p /root/scripts /var/lib/address-radar-maintenance-tools'])
        cls.command(['exec','-u','postgres',cls.container,'/usr/lib/postgresql/16/bin/initdb',
            '-D','/var/lib/postgresql/data','--auth-local=peer','--auth-host=scram-sha-256'])
        cls.command(['exec','-u','postgres',cls.container,'/usr/lib/postgresql/16/bin/pg_ctl',
            '-D','/var/lib/postgresql/data','-l','/var/lib/postgresql/data/fixture.log','-w','start'])
        source = Path(__file__).parents[1]
        for name in ('rotate-address-only-migrator.py','activate-production-postgres-migrator.py'):
            cls.command(['cp',str(source/name),cls.container+':/root/scripts/'+name])
        cls.command(['exec',cls.container,'sh','-ec','chown -R root:root /root/scripts; chmod 600 /root/scripts/*'])
        cls.sql('CREATE DATABASE '+cls.database)
        cls.sql('CREATE ROLE '+cls.username+" LOGIN NOINHERIT CONNECTION LIMIT 1 PASSWORD 'initial-isolated-password' VALID UNTIL '1970-01-01';"
            +'REVOKE ALL ON DATABASE '+cls.database+' FROM PUBLIC; GRANT CONNECT ON DATABASE '+cls.database+' TO '+cls.username)
        cls.system = cls.sql('SELECT system_identifier::text FROM pg_control_system()')
        if cls.system == '7693392208475083526':
            raise AssertionError('production identity refused')
        cls.target = {'protocol':'address-only-isolated-rotation-v1','systemIdentifier':cls.system,
            'database':cls.database,'databaseOid':cls.sql("SELECT oid::text FROM pg_database WHERE datname='"+cls.database+"'"),
            'username':cls.username,'roleOid':cls.sql("SELECT oid::text FROM pg_roles WHERE rolname='"+cls.username+"'"),
            'host':'127.0.0.1','port':5432}

    def launch(self, fault=None):
        import secrets
        import json
        import hashlib
        self.sql('ALTER ROLE '+self.username+" VALID UNTIL '1970-01-01'; GRANT CONNECT ON DATABASE "+self.database+' TO '+self.username)
        if fault == 'login':
            self.sql('REVOKE CONNECT ON DATABASE '+self.database+' FROM '+self.username)
        directory = '/var/lib/address-radar-maintenance-tools/address-only-auth-'+secrets.token_hex(8)
        support = '/root/scripts/activate-production-postgres-migrator.py'
        digest = self.command(['exec',self.container,'sha256sum',support]).split()[0]
        target = dict(self.target)
        if fault == 'identity': target['systemIdentifier'] = '123'
        job = {'protocol':'address-only-isolated-rotation-job-v1','expectedIdentity':target,
            'operationId':'isolated-operation','approvalRef':'isolated-approved','replacementSha256':'a'*64,
            'directory':directory,'support':{'path':support,'sha256':digest}}
        raw = json.dumps(job).encode()
        path = '/root/job-'+secrets.token_hex(8)+'.json'
        self.command(['exec','-i',self.container,'python3','-c',
            'import os,sys;p=sys.argv[1];fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(fd,sys.stdin.buffer.read());os.fsync(fd);os.close(fd)',path],raw)
        import subprocess
        result = subprocess.run(['docker','exec',self.container,'python3','-I','-B',
            '/root/scripts/rotate-address-only-migrator.py','--isolated-test-job',path,
            '--isolated-test-job-sha256',hashlib.sha256(raw).hexdigest()],capture_output=True,timeout=35)
        return result,directory

    def test_real_scram_rotation_tcp_login_and_immutable_receipt(self):
        import json
        result,directory = self.launch()
        self.assertEqual(result.returncode,0,'real isolated rotation refused')
        receipt = json.loads(self.command(['exec',self.container,'cat',directory+'/receipt.json']))
        self.assertEqual(receipt['status'],'rotated-authenticated')
        self.assertEqual(receipt['proofScope'],'isolated-test-rotation')
        self.assertEqual(receipt['system'],self.system)
        self.assertEqual(receipt['roleOid'],self.target['roleOid'])
        self.assertEqual(self.sql("SELECT rolpassword LIKE 'SCRAM-SHA-256$4096:%' FROM pg_authid WHERE rolname='"+self.username+"'"),'t')
        self.assertNotIn(b'password',result.stdout+result.stderr)
        self.assertEqual(self.command(['exec',self.container,'stat','-c','%a',directory+'/credential.json']),'600')

    def test_actual_tcp_login_failure_has_intent_without_success_receipt(self):
        result,directory = self.launch('login')
        self.assertEqual(result.returncode,1)
        self.command(['exec',self.container,'test','-f',directory+'/intent.json'])
        self.command(['exec',self.container,'test','!','-e',directory+'/receipt.json'])
        self.assertEqual(result.stdout.strip(),b'{"status":"refused-preserved","retryAuthorized":false,"businessActivated":false}')

    def test_actual_cluster_mismatch_has_zero_rotation_intent(self):
        result,directory = self.launch('identity')
        self.assertEqual(result.returncode,1)
        self.command(['exec',self.container,'test','!','-e',directory+'/intent.json'])
        self.command(['exec',self.container,'test','!','-e',directory+'/receipt.json'])

if __name__ == '__main__':
    unittest.main()
