#!/usr/bin/env python3
"""Explicit two-hour migrator rotation; no schema/import/cutover authority."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time

ROLE = 'address_radar_migrator'
SERVICE_ROLES = {
    'address_radar_scanner': '16385', 'address_radar_automation': '16386',
    'address_radar_wallet_monitor': '16387', 'address_radar_wallet_analysis': '16388',
    'address_radar_historical_backfill': '16389', 'address_radar_console': '16390',
}

def require(value, reason):
    if not value: raise ValueError(reason)

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def validate_boundary(value, now_ms):
    require(value['system'] == '7693392208475083526' and value['databaseOid'] == '16391'
        and value['roleOid'] == '16384', 'target_changed')
    require(value['login'] is True and value['limit'] == 1 and value['memberships'] == 0
        and value['sessions'] == 0 and value['unsafe'] is False,
        'role_or_sessions_changed')
    if value['otherLogins'] != 0:
        services = value.get('serviceLogins')
        require(type(value['otherLogins']) is int and value['otherLogins'] == len(SERVICE_ROLES)
            and isinstance(services, list) and len(services) == len(SERVICE_ROLES)
            and value.get('serviceAclSafe') is True, 'unexpected_service_roles')
        observed = {}
        for service in services:
            require(isinstance(service, dict) and service.get('name') not in observed
                and service.get('name') in SERVICE_ROLES and service.get('oid') == SERVICE_ROLES[service['name']]
                and type(service.get('limit')) is int and service['limit'] == 1
                and service.get('unsafe') is False and service.get('memberships') == 0,
                'unexpected_service_roles')
            observed[service['name']] = service['oid']
        require(observed == SERVICE_ROLES, 'unexpected_service_roles')
    require(type(value['expiryMs']) is int and value['expiryMs'] < now_ms, 'old_credential_not_expired')

def _rotate(adapter, storage, operation_id, now_ms, password, verifier, *, approval_ref, replacement_sha256, boundary_check, target, isolated=False):
    require(isinstance(operation_id, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', operation_id)
        and isinstance(approval_ref, str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,256}', approval_ref)
        and isinstance(replacement_sha256, str) and re.fullmatch(r'[a-f0-9]{64}', replacement_sha256),
        'operation_authorization_invalid')
    require(type(now_ms) is int and 0 <= now_ms <= 9007199247540991, 'rotation_clock_invalid')
    authorization = {'operationId': operation_id, 'approvalRef': approval_ref, 'replacementSha256': replacement_sha256}
    before = adapter.boundary()
    boundary_check(before, now_ms)
    plan = {'version': 1, **authorization,
        'before': before, 'expiresAtMs': now_ms + 7200000, 'role': target['username'],
        'schemaWritesAuthorized': False, 'businessActivationAuthorized': False}
    storage('plan.json', encoded(plan))
    storage('credential.json', encoded({'host': target['host'], 'port': target['port'], 'database': target['database'],
        'user': target['username'], 'password': password, 'expiresAtMs': plan['expiresAtMs'], 'operationId': operation_id}))
    require(adapter.boundary() == before, 'boundary_changed_before_intent')
    storage('intent.json', encoded({**authorization, 'planSha256': hashlib.sha256(encoded(plan)).hexdigest()}))
    adapter.apply(verifier, plan['expiresAtMs'])
    after = adapter.boundary()
    expected = dict(before, expiryMs=plan['expiresAtMs'])
    require(after == expected, 'postcommit_boundary_changed')
    adapter.authenticate(password)
    receipt = {'status': 'rotated-authenticated', **authorization, 'expiresAtMs': plan['expiresAtMs'],
        'system': after['system'], 'databaseOid': after['databaseOid'], 'roleOid': after['roleOid'],
        'oldRecordsPreserved': True, 'hbaChanged': False, 'schemaChanged': False, 'businessActivated': False}
    if isolated:
        receipt['proofScope'] = 'isolated-test-rotation'
    storage('receipt.json', encoded(receipt))
    return receipt

def rotate(adapter, storage, operation_id, now_ms, password, verifier, *, approval_ref, replacement_sha256):
    return _rotate(adapter, storage, operation_id, now_ms, password, verifier,
        approval_ref=approval_ref, replacement_sha256=replacement_sha256, boundary_check=validate_boundary,
        target={'host':'127.0.0.1','port':5432,'database':'address_radar','username':ROLE})


def rotate_isolated(adapter, storage, operation_id, now_ms, password, verifier, *,
                    expected_identity, approval_ref, replacement_sha256):
    """Explicit test-only API. The production CLI cannot select this route.

    Callers must bind a measured cluster/role identity and supply a real adapter;
    a successful receipt still requires apply, postcommit verification and LOGIN.
    """
    target = expected_identity
    require(type(target) is dict and set(target) == {'protocol','systemIdentifier','database','databaseOid',
        'username','roleOid','host','port'} and target['protocol'] == 'address-only-isolated-rotation-v1',
        'isolated_identity_shape')
    require(all(type(target[k]) is str and re.fullmatch('[1-9][0-9]{0,19}',target[k])
        for k in ('systemIdentifier','databaseOid','roleOid'))
        and target['systemIdentifier'] != '7693392208475083526'
        and re.fullmatch('radar_rehearsal_[a-f0-9]{16}',target['database'])
        and re.fullmatch('radar_migrator_[a-f0-9]{16}',target['username'])
        and target['host'] == '127.0.0.1' and type(target['port']) is int and target['port'] == 5432,
        'isolated_identity_scope')
    def boundary_check(value, now):
        require(value['system'] == target['systemIdentifier'] and value['databaseOid'] == target['databaseOid']
                and value['roleOid'] == target['roleOid'] and value['otherLogins'] == 0, 'isolated_target_changed')
        # Retain all existing least-privilege, expiry and zero-session predicates.
        validate_boundary(dict(value,system='7693392208475083526',databaseOid='16391',roleOid='16384'),now)
    return _rotate(adapter, storage, operation_id, now_ms, password, verifier,
        approval_ref=approval_ref,replacement_sha256=replacement_sha256,
        boundary_check=boundary_check,target=target,isolated=True)


SQL = """WITH services AS MATERIALIZED (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolcanlogin AND rolname=ANY(ARRAY[
    'address_radar_scanner','address_radar_automation','address_radar_wallet_monitor',
    'address_radar_wallet_analysis','address_radar_historical_backfill','address_radar_console'])
), relations AS MATERIALIZED (
  SELECT c.oid,c.relname,c.relowner,c.relkind FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='address_radar_business'
), unsafe_acl AS (
  SELECT s.oid FROM services s WHERE
    pg_catalog.has_database_privilege(s.oid,current_database(),'CREATE,TEMP')
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=current_database()
      AND pg_catalog.pg_has_role(s.oid,d.datdba,'USAGE'))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='address_radar_business'
      AND (pg_catalog.has_schema_privilege(s.oid,n.oid,'CREATE')
        OR pg_catalog.pg_has_role(s.oid,n.nspowner,'USAGE')))
    OR EXISTS(SELECT 1 FROM relations c WHERE pg_catalog.pg_has_role(s.oid,c.relowner,'USAGE'))
    OR EXISTS(SELECT 1 FROM relations c WHERE c.relkind IN ('r','p','v','m','f') AND (
      pg_catalog.has_table_privilege(s.oid,c.oid,'TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(s.oid,c.oid,'REFERENCES')
      OR (c.relname=ANY(ARRAY['business_schema_identity','business_schema_ledger',
        'migration_cutover_transitions','wallet_service_import_ledger','wallet_service_profile_cohort',
        'wallet_service_profile_versions','wallet_service_fact_inputs','wallet_service_fact_validators',
        'wallet_service_fact_attestations','migration_cutover_transitions_v2','migration_cutover_first_write_markers'])
        AND (pg_catalog.has_table_privilege(s.oid,c.oid,'INSERT,UPDATE,DELETE')
          OR pg_catalog.has_any_column_privilege(s.oid,c.oid,'INSERT,UPDATE')))))
) SELECT json_build_object('system',(pg_control_system()).system_identifier::text,
'serviceAclSafe',NOT EXISTS(SELECT 1 FROM unsafe_acl),
'databaseOid',(SELECT oid::text FROM pg_database WHERE datname='address_radar'),
'roleOid',oid::text,'login',rolcanlogin,'limit',rolconnlimit,
'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=pg_authid.oid),
'otherLogins',(SELECT count(*) FROM pg_roles WHERE rolname LIKE 'address_radar_%' AND rolname<>'address_radar_migrator' AND rolcanlogin),
'serviceLogins',(SELECT coalesce(json_agg(x ORDER BY name),'[]'::json) FROM (
  SELECT rolname AS name,oid::text AS oid,rolconnlimit AS "limit",
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS unsafe,
    (SELECT count(*) FROM pg_auth_members WHERE member=r.oid) AS memberships
  FROM pg_roles r WHERE rolname LIKE 'address_radar_%' AND rolname<>'address_radar_migrator' AND rolcanlogin) x),
'sessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='address_radar_migrator'),
'unsafe',(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit),
'expiryMs',(extract(epoch FROM rolvaliduntil)*1000)::bigint,
'epoch',pg_postmaster_start_time()::text) FROM pg_authid WHERE rolname='address_radar_migrator';"""

# Role rotation uses the maintenance database; object ACLs belong to address_radar.
_BOUNDARY_START = SQL.index("SELECT json_build_object('system'")
ACL_SQL = SQL[:_BOUNDARY_START] + 'SELECT NOT EXISTS(SELECT 1 FROM unsafe_acl);'
BOUNDARY_SQL = SQL[_BOUNDARY_START:].replace("'serviceAclSafe',NOT EXISTS(SELECT 1 FROM unsafe_acl),\n", '')

def isolated_rotation_directory(target, value):
    suffix = target['database'].removeprefix('radar_rehearsal_')
    scope = Path('/var/lib/address-radar-maintenance-tools') / ('isolated-source-replacement-' + suffix)
    directory = Path(value)
    require(directory.is_absolute() and str(directory) == os.path.normpath(value)
            and directory.parent == scope and re.fullmatch('address-only-auth-[a-f0-9]{16}', directory.name),
            'isolated_directory')
    return directory


def isolated_main(argv):
    """Disposable-container CLI only; never selected by the production parser."""
    import subprocess
    import pwd
    import secrets
    require(os.geteuid() == 0 and Path('/.dockerenv').is_file(), 'isolated_container_required')
    parser = argparse.ArgumentParser(description='Explicit isolated rotation, never a production authorization')
    parser.add_argument('--isolated-test-job',required=True)
    parser.add_argument('--isolated-test-job-sha256',required=True)
    args = parser.parse_args(argv)
    def read(pin):
        require(type(pin) is dict and set(pin) == {'path','sha256'} and
                re.fullmatch('[a-f0-9]{64}',pin['sha256']), 'isolated_pin')
        path = Path(pin['path'])
        require(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'isolated_path')
        for parent in path.parents:
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,'isolated_parent')
        fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as stream:
            before = os.fstat(stream.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o077 and 0 < before.st_size <= 1048576,'isolated_file')
            raw = stream.read(1048577)
            after = os.fstat(stream.fileno())
        def stamp(s):
            return (s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_mtime_ns,s.st_ctime_ns)
        require(stamp(before) == stamp(after) == stamp(path.lstat())
                and hashlib.sha256(raw).hexdigest() == pin['sha256'],'isolated_pin_changed')
        return raw
    job = json.loads(read({'path':args.isolated_test_job,'sha256':args.isolated_test_job_sha256}))
    require(set(job) == {'protocol','expectedIdentity','support','operationId','approvalRef','replacementSha256','directory'}
        and job['protocol'] == 'address-only-isolated-rotation-job-v1','isolated_job')
    target = job['expectedIdentity']
    require(type(target) is dict and type(target.get('database')) is str
        and re.fullmatch('radar_rehearsal_[a-f0-9]{16}',target['database'])
        and type(target.get('username')) is str and re.fullmatch('radar_migrator_[a-f0-9]{16}',target['username'])
        and target.get('systemIdentifier') != '7693392208475083526'
        and target.get('host') == '127.0.0.1' and target.get('port') == 5432,'isolated_target')
    directory = isolated_rotation_directory(target, job['directory'])
    support_raw = read(job['support'])
    import types
    auth = types.ModuleType('isolated_rotation_auth')
    auth.__file__ = job['support']['path']
    exec(compile(support_raw,auth.__file__,'exec'),auth.__dict__)
    os.umask(0o077)
    directory.mkdir(mode=0o700)
    started = time.monotonic()
    class Base:
        def remaining(self):
            seconds = 30-(time.monotonic()-started)
            require(seconds > 0,'isolated_deadline')
            return seconds
        def pinned_file(self,pin):
            require(pin == {'path':'/usr/lib/postgresql/16/bin/psql'},'isolated_psql')
            return pin['path']
    class Adapter:
        def __init__(self):
            account = pwd.getpwnam('postgres')
            self.base = Base()
            self.p = {'tools':{'psql':{'path':'/usr/lib/postgresql/16/bin/psql'}},
                'ownership':{'data':{'uid':account.pw_uid,'gid':account.pw_gid}},
                'target':{'socketDirectory':'/var/run/postgresql','port':5432}}
            self.session = auth.PrivateSqlSession(self)
            auth.validate_logging_observation(auth.strict_json(self.session.exchange(auth.suppression_sql())))
        def guard(self): self.base.remaining()
        def boundary(self):
            sql = BOUNDARY_SQL.replace("'address_radar_migrator'", "'"+target['username']+"'").replace(
                "datname='address_radar'", "datname='"+target['database']+"'")
            value = auth.strict_json(self.session.exchange(sql))
            require(value['system'] == target['systemIdentifier'],'isolated_cluster_changed')
            return value
        def apply(self,verifier,expiry):
            require(re.fullmatch(r'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+',verifier),'invalid_verifier')
            until = time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime(expiry//1000))+f'.{expiry % 1000:03d}+00'
            auth.suppressed_sql(self.session,"BEGIN; SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='3s'; ALTER ROLE "
                +target['username']+" PASSWORD '"+verifier+"' VALID UNTIL '"+until+"'; COMMIT;",self.guard)
        def authenticate(self,password):
            fd = os.memfd_create('isolated-rotation-pgpass',flags=0)
            os.fchmod(fd,0o600)
            try:
                os.write(fd,('127.0.0.1:5432:'+target['database']+':'+target['username']+':'+password+'\n').encode())
                child = auth.OwnedPsqlChild(['/usr/lib/postgresql/16/bin/psql','-X','-qAt','--no-password',
                    '-h','127.0.0.1','-p','5432','-U',target['username'],'-d',target['database'],'-v','ON_ERROR_STOP=1'],
                    self.base.remaining,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                    pass_fds=(fd,),start_new_session=True,env={'PATH':'/usr/bin:/bin','LC_ALL':'C',
                    'PGPASSFILE':'/proc/self/fd/'+str(fd)})
                try:
                    raw,_ = child.process.communicate(b'SELECT session_user,current_user,current_database();',timeout=self.base.remaining())
                    require(child.process.returncode == 0 and raw.strip() ==
                        (target['username']+'|'+target['username']+'|'+target['database']).encode(),'isolated_login_failed')
                finally: child.close()
            finally: os.close(fd)
    def store(name,raw):
        fd = os.open(directory/name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        fd = os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try: os.fsync(fd)
        finally: os.close(fd)
    adapter = Adapter()
    try:
        password = secrets.token_urlsafe(32)
        return rotate_isolated(adapter,store,job['operationId'],int(time.time()*1000),password,
            auth.scram_verifier(password,os.urandom(16)),expected_identity=target,
            approval_ref=job['approvalRef'],replacement_sha256=job['replacementSha256'])
    finally:
        adapter.session.close()


def main():
    import sys
    if sys.argv[1:2] == ["--isolated-test-job"]:
        print(json.dumps(isolated_main(sys.argv[1:])))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--support', required=True)
    parser.add_argument('--support-sha256', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--operation-id', required=True)
    parser.add_argument('--approval-ref', required=True)
    parser.add_argument('--replacement-sha256', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'root_required')
    support = Path(args.support)
    for path in [support, *support.parents]:
        info = path.lstat()
        require(info.st_uid == 0 and not info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode), 'unsafe_support')
    body = support.read_bytes()
    require(hashlib.sha256(body).hexdigest() == args.support_sha256, 'support_digest_changed')
    spec = importlib.util.spec_from_file_location('auth_support', support)
    auth = importlib.util.module_from_spec(spec); spec.loader.exec_module(auth)
    directory = Path(args.directory)
    require(directory.parent == Path('/var/lib/address-radar-maintenance-tools') and re.fullmatch(r'address-only-auth-[a-f0-9]{16}', directory.name), 'private_scope')
    os.umask(0o077)
    directory.mkdir(mode=0o700)
    started = time.monotonic()
    class Base:
        def remaining(self):
            value = 120 - (time.monotonic() - started)
            require(value > 0, 'deadline')
            return value
        def pinned_file(self, pin):
            path = Path(pin['path']); info = path.lstat()
            require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o022, 'unsafe_psql')
            return str(path)
    class Adapter:
        def __init__(self):
            import pwd
            owner = pwd.getpwnam('postgres')
            self.base = Base()
            self.p = {'tools': {'psql': {'path': '/usr/lib/postgresql/16/bin/psql'}},
                'ownership': {'data': {'uid': owner.pw_uid, 'gid': owner.pw_gid}},
                'target': {'socketDirectory': '/var/run/postgresql', 'port': 5432}}
            self.session = auth.PrivateSqlSession(self)
            auth.validate_logging_observation(auth.strict_json(self.session.exchange(auth.suppression_sql())))
        def guard(self): self.base.remaining()
        def boundary(self):
            import subprocess
            value = auth.strict_json(self.session.exchange(BOUNDARY_SQL))
            child = auth.OwnedPsqlChild(['/usr/bin/sudo', '-n', '-u', 'postgres',
                '/usr/lib/postgresql/16/bin/psql', '-X', '-qAt', '--no-password',
                '-h', '/var/run/postgresql', '-p', '5432', '-d', 'address_radar',
                '-v', 'ON_ERROR_STOP=1'], self.base.remaining,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                start_new_session=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
            try:
                output, _ = child.process.communicate(ACL_SQL.encode(), timeout=self.base.remaining())
                require(child.process.returncode == 0 and output.strip() in (b't', b'f'), 'acl_probe_failed')
                value['serviceAclSafe'] = output.strip() == b't'
            finally:
                child.close()
            return value
        def apply(self, verifier, expiry):
            require(re.fullmatch(r'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+', verifier), 'invalid_verifier')
            until = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(expiry // 1000)) + f'.{expiry % 1000:03d}+00'
            self.session.exchange("BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'; ALTER ROLE address_radar_migrator PASSWORD '" + verifier + "' VALID UNTIL '" + until + "'; COMMIT;")
        def authenticate(self, password):
            import subprocess
            fd = os.memfd_create('address-only-pgpass', flags=0)
            os.fchmod(fd, 0o600)
            try:
                os.write(fd, ('127.0.0.1:5432:address_radar:' + ROLE + ':' + password + '\n').encode())
                child = auth.OwnedPsqlChild(['/usr/lib/postgresql/16/bin/psql', '-X', '-qAt', '--no-password', '-h', '127.0.0.1', '-p', '5432', '-U', ROLE, '-d', 'address_radar', '-v', 'ON_ERROR_STOP=1'], self.base.remaining,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=(fd,), start_new_session=True,
                    env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'PGPASSFILE': '/proc/self/fd/' + str(fd)})
                try:
                    out, _ = child.process.communicate(b'SELECT current_user, current_database();', timeout=self.base.remaining())
                    require(child.process.returncode == 0 and out.strip() == b'address_radar_migrator|address_radar', 'authentication_failed')
                finally: child.close()
            finally: os.close(fd)
    def store(name, raw):
        fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        d = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(d)
        finally: os.close(d)
    import secrets
    adapter = Adapter()
    try:
        password = secrets.token_urlsafe(32)
        result = rotate(adapter, store, args.operation_id, int(time.time() * 1000), password, auth.scram_verifier(password, os.urandom(16)),
            approval_ref=args.approval_ref, replacement_sha256=args.replacement_sha256)
        print(json.dumps(result))
    finally: adapter.session.close()

if __name__ == '__main__':
    try: main()
    except Exception:
        print('{"status":"refused-preserved","retryAuthorized":false,"businessActivated":false}')
        raise SystemExit(1)
