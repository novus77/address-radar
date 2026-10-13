"""Explicit private migrator authentication only; no schema, import or business activation.

Depends on the frozen, separately protected 439 provisioning implementation. Passwords
are read only by the root adapter, SCRAM is sent on stdin, and client passwords travel
through an inherited anonymous 0600 pgpass FD, never argv or PGPASSWORD.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import types

PROVISIONING_SHA256 = '43978c786e262cf4abb037b9be7d2ea556b31c0532ad10df8bfbdfecadbc9c7f'
PIN_FIELDS = ('path', 'sha256', 'uid', 'gid', 'mode', 'device', 'inode')
PLAN_FIELDS = ('version', 'operationId', 'approvalRef', 'provisioningModule', 'provisioningPlan',
    'provisioningPlanSha256', 'targetPins', 'secretPin', 'initialHbaPin',
    'credentialValidUntilMs', 'invocationTimeoutSeconds')

class Refused(Exception):
    pass

def demand(value, code):
    if not value: raise Refused(code)

def fields(value, names):
    demand(type(value) is dict and set(value) == set(names), 'unknown_or_missing_field')
    return value

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def sha(body):
    return hashlib.sha256(body).hexdigest()

def strict_json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            demand(key not in result, 'duplicate_json_key'); result[key] = value
        return result
    return json.loads(body, object_pairs_hook=pairs,
        parse_constant=lambda _: (_ for _ in ()).throw(Refused('invalid_json_number')))

def validate_pin(pin, owner=0, mode=None):
    fields(pin, PIN_FIELDS)
    demand(type(pin['path']) is str and pin['path'].startswith('/') and '..' not in Path(pin['path']).parts
        and type(pin['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', pin['sha256'])
        and pin['uid'] == owner and type(pin['gid']) is int and pin['gid'] >= 0
        and type(pin['mode']) is int and not pin['mode'] & 0o022
        and (mode is None or pin['mode'] == mode)
        and all(type(pin[k]) is str and re.fullmatch(r'(0|[1-9][0-9]*)', pin[k]) for k in ('device', 'inode')), 'private_pin')

def read_root_pin(pin, maximum, remaining=lambda: None):
    validate_pin(pin)
    path = Path(pin['path']); fds = []; chain = []
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); fds.append(fd)
        for name in path.parts[1:-1]:
            remaining(); before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            demand(stat.S_ISDIR(before.st_mode) and before.st_uid == 0 and not before.st_mode & 0o022, 'private_ancestor')
            parent = fd; fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd); fds.append(fd)
            actual = os.fstat(fd)
            demand((actual.st_dev, actual.st_ino) == (before.st_dev, before.st_ino), 'private_changed')
            chain.append((parent, name, actual.st_dev, actual.st_ino))
        def binding():
            for parent, name, device, inode in chain:
                value = os.stat(name, dir_fd=parent, follow_symlinks=False)
                demand(stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022
                    and (value.st_dev, value.st_ino) == (device, inode), 'private_changed')
        remaining(); binding()
        name = path.name; before = os.stat(name, dir_fd=fd, follow_symlinks=False)
        demand(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum
            and (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), str(before.st_dev), str(before.st_ino)) ==
            (pin['uid'], pin['gid'], pin['mode'], pin['device'], pin['inode']), 'private_metadata')
        file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd); fds.append(file_fd)
        def stamp(v): return (v.st_dev, v.st_ino, v.st_mode, v.st_uid, v.st_gid, v.st_nlink, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        demand(stamp(before) == stamp(os.fstat(file_fd)), 'private_changed')
        body = b''
        while len(body) <= maximum:
            remaining(); piece = os.read(file_fd, min(65536, maximum + 1 - len(body)))
            if not piece: break
            body += piece
        binding()
        demand(len(body) == before.st_size and sha(body) == pin['sha256'] and stamp(before) ==
            stamp(os.fstat(file_fd)) == stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)), 'private_changed')
        return body
    finally:
        for fd in reversed(fds): os.close(fd)

def load_provisioning(pin):
    validate_pin(pin)
    demand(pin['sha256'] == PROVISIONING_SHA256, 'frozen_dependency_pin')
    body = read_root_pin(pin, 1024 ** 2)
    module = types.ModuleType('frozen_provisioning'); module.__file__ = pin['path']
    exec(compile(body, pin['path'], 'exec'), module.__dict__)
    return module

def validate_plan(plan, module, now_ms):
    plan = strict_json(encoded(plan)); fields(plan, PLAN_FIELDS)
    demand(plan['version'] == 1, 'plan_version')
    module.reference(plan['operationId']); module.reference(plan['approvalRef'])
    validate_pin(plan['provisioningModule']); demand(plan['provisioningModule']['sha256'] == PROVISIONING_SHA256, 'frozen_dependency_pin')
    prepared = module.validate_plan(plan['provisioningPlan'], now_ms)
    demand(prepared['planSha256'] == plan['provisioningPlanSha256'] and
        prepared['plan']['resources']['migrationConnections'] == 1, 'provisioning_binding')
    demand(type(plan['invocationTimeoutSeconds']) is int and 1 <= plan['invocationTimeoutSeconds'] <= 180
        and type(plan['credentialValidUntilMs']) is int and now_ms + plan['invocationTimeoutSeconds'] * 1000 < plan['credentialValidUntilMs'], 'credential_lifetime')
    pins = fields(plan['targetPins'], ('systemIdentifier', 'databaseOid', 'roleOids'))
    for key in ('systemIdentifier', 'databaseOid'):
        demand(type(pins[key]) is str and re.fullmatch(r'[1-9][0-9]{0,19}', pins[key]), 'target_pin')
    fields(pins['roleOids'], prepared['roles'])
    demand(all(type(v) is str and re.fullmatch(r'[1-9][0-9]{0,9}', v) for v in pins['roleOids'].values())
        and len(set(pins['roleOids'].values())) == 7, 'role_oid_pins')
    validate_pin(plan['secretPin'], mode=0o600)
    hba = plan['initialHbaPin']; expected = prepared['plan']['ownership']['hba']
    validate_pin(hba, owner=expected['uid'], mode=expected['mode'])
    demand(hba['gid'] == expected['gid'] and hba['path'] == prepared['plan']['target']['configDirectory'] + '/pg_hba.conf'
        and hba['sha256'] == sha(module.NativeAdapter.hba_configuration()), 'initial_hba_binding')
    return {'plan': plan, 'planSha256': sha(encoded(plan)), 'provisioning': prepared}

def scram_verifier(password, salt):
    demand(type(password) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', password)
        and type(salt) is bytes and len(salt) == 16, 'credential_format')
    salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
    stored = hashlib.sha256(hmac.new(salted, b'Client Key', hashlib.sha256).digest()).digest()
    server = hmac.new(salted, b'Server Key', hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()
    return 'SCRAM-SHA-256$4096:' + b64(salt) + '$' + b64(stored) + ':' + b64(server)

def validate_credential(value, prepared):
    fields(value, ('version', 'purpose', 'operationId', 'planSha256', 'host', 'port', 'database', 'user',
        'password', 'scramVerifier', 'expiresAtMs', 'schema', 'generation', 'targetPins'))
    plan = prepared['plan']; p = prepared['provisioning']['plan']
    demand(value['version'] == 1 and value['purpose'] == 'production-migrator-private-connection'
        and value['operationId'] == plan['operationId'] and value['planSha256'] == prepared['planSha256']
        and value['host'] == '127.0.0.1' and value['port'] == 5432 and value['database'] == p['database']
        and value['user'] == p['migratorRole'] and value['schema'] == p['schema'] and value['generation'] == p['generation']
        and value['expiresAtMs'] == plan['credentialValidUntilMs'] and value['targetPins'] == plan['targetPins'], 'credential_binding')
    demand(type(value['scramVerifier']) is str and re.fullmatch(r'SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=', value['scramVerifier']), 'scram_format')
    salt = base64.b64decode(value['scramVerifier'].split('$')[1].split(':')[1], validate=True)
    demand(value['scramVerifier'] == scram_verifier(value['password'], salt), 'credential_verifier')

def public_result(status, **extra):
    return {'status': status, 'productionMigrationReady': False, 'fullCapacityProved': False,
        'backendChanged': False, 'businessActivation': False, 'deliveryEnabled': False, 'dataImported': False,
        'trustIssued': False, **extra}

def activate(prepared, adapter, storage, mode='apply'):
    adapter.guard()
    with storage.lock():
        journal = storage.load()
        if journal is None:
            demand(mode == 'apply' and not storage.has('secrets.json'), 'unowned_or_missing_state')
            observed = adapter.observe(None); demand(observed['phase'] == 'initial', 'existing_authentication')
            journal = {'version': 1, 'planSha256': prepared['planSha256'], 'operationId': prepared['plan']['operationId'],
                'pending': None, 'acknowledged': {}, 'credentialSha256': None}
            adapter.guard(); storage.save(journal)
        demand(journal['planSha256'] == prepared['planSha256'] and journal['operationId'] == prepared['plan']['operationId'], 'journal_binding')
        if journal['credentialSha256'] is None:
            demand(mode == 'apply' and journal['pending'] is None, 'credential_pending_preserved')
            journal['pending'] = 'credential'; adapter.guard(); storage.save(journal)
            credential = adapter.make_credential(); validate_credential(credential, prepared)
            adapter.guard(); storage.write('secrets.json', credential)
            journal['credentialSha256'] = sha(encoded(credential)); journal['pending'] = None
            adapter.guard(); storage.save(journal)
        credential = storage.read('secrets.json'); validate_credential(credential, prepared)
        demand(sha(encoded(credential)) == journal['credentialSha256'], 'credential_changed')
        if journal['pending'] is not None:
            demand(mode == 'reconcile' and journal['pending'] in ('role', 'hba'), 'pending_requires_explicit_reconcile')
            stage = journal['pending']; measured = adapter.observe(credential)
            demand(stage in measured['receipts'] and all(measured['receipts'].get(k) == v for k, v in journal['acknowledged'].items()), 'unknown_commit_unreconciled')
            journal['acknowledged'][stage] = measured['receipts'][stage]; journal['pending'] = None
            adapter.guard(); storage.save(journal)
            return public_result('stage_reconciled', stage=stage)
        demand(mode == 'apply', 'nothing_to_reconcile')
        for stage in ('role', 'hba'):
            measured = adapter.observe(credential)
            demand(measured['receipts'] == journal['acknowledged'], 'stage_identity_changed')
            if stage in journal['acknowledged']: continue
            journal['pending'] = stage; adapter.guard(); storage.save(journal)
            outcome = 'acknowledged'
            try:
                adapter.apply(stage, credential)
            except Exception:
                # Fresh catalog/authentication measurement can reconcile actual effects;
                # never reissue ALTER ROLE or reload a possibly committed transition.
                outcome = 'reconciled'
            try:
                post = adapter.observe(credential)
                demand(set(post['receipts']) == set(journal['acknowledged']) | {stage}
                    and all(post['receipts'].get(k) == v for k, v in journal['acknowledged'].items()), 'native_ack_missing')
                journal['acknowledged'][stage] = post['receipts'][stage]; journal['pending'] = None
                journal['lastOutcome'] = outcome; adapter.guard(); storage.save(journal)
            except Exception:
                raise Refused('authentication_failed_preserved') from None
        adapter.guard()
        return public_result('migrator_authentication_prepared', migratorLogin=True, migrationConnectionLimit=1,
            otherRolesLogin=False, schemaInstalled=False, credentialValidUntilMs=credential['expiresAtMs'])

LOGGING_EXPECTATIONS = {
    'log_statement': 'none', 'log_min_error_statement': 'panic', 'log_min_duration_statement': '-1',
    'log_min_duration_sample': '-1', 'log_statement_sample_rate': '0', 'log_transaction_sample_rate': '0',
    'log_duration': 'off', 'log_parameter_max_length': '0', 'log_parameter_max_length_on_error': '0',
    'debug_print_parse': 'off', 'debug_print_rewritten': 'off', 'debug_print_plan': 'off',
    'shared_preload_libraries': '', 'session_preload_libraries': '', 'local_preload_libraries': '',
    'pgaudit.log': None,
}


def validate_logging_observation(value):
    fields(value, ('settings', 'extensions'))
    demand(value['settings'] == LOGGING_EXPECTATIONS and value['extensions'] == ['plpgsql'], 'unproved_logging_or_audit_boundary')


def suppression_sql():
    settings = ''.join("SET " + key + "='" + value + "';\n" for key, value in LOGGING_EXPECTATIONS.items()
                       if key not in ('shared_preload_libraries', 'session_preload_libraries', 'local_preload_libraries', 'pgaudit.log'))
    pairs = ','.join("'" + key + "',current_setting('" + key + "',true)" for key in LOGGING_EXPECTATIONS)
    return settings + "SELECT json_build_object('settings',json_build_object(" + pairs + "),'extensions'," \
        "(SELECT json_agg(extname ORDER BY extname) FROM pg_extension));\n"


def suppressed_sql(session, text, guard):
    guard()
    # The first request contains no SCRAM bytes. Its measured ACK precedes writing the second request.
    observed = session.exchange(suppression_sql())
    validate_logging_observation(strict_json(observed))
    guard()
    return session.exchange(text)


def close_owned_child(process, pidfd, remaining, send_signal=None):
    # A pidfd remains bound to the original child even after PID reuse.
    if process.poll() is not None: return
    try:
        process.wait(timeout=max(0.01, remaining()))
        return
    except Exception:
        pass
    try:
        (send_signal or signal.pidfd_send_signal)(pidfd, signal.SIGKILL, None, 0)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except Exception:
        raise Refused('authentication_child_closure_unknown') from None


class OwnedPsqlChild:
    def __init__(self, argv, remaining, **kwargs):
        demand(hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
               and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL, 'owned_child_transport_unavailable')
        remaining()
        reserve = os.pidfd_open(os.getpid())
        self.process = None; self.pidfd = None; self.remaining = remaining
        try:
            remaining()
            self.process = subprocess.Popen(argv, **kwargs)
        finally:
            os.close(reserve)
        try:
            # No poll/wait/reaping occurs before acquiring the stable child identity.
            self.pidfd = os.pidfd_open(self.process.pid)
        except Exception:
            self.process.stdin.close()
            try: self.process.wait(timeout=5)
            except Exception: raise Refused('authentication_child_closure_unknown') from None
            raise Refused('owned_child_transport_unavailable') from None

    def close(self):
        try:
            close_owned_child(self.process, self.pidfd, self.remaining)
        finally:
            os.close(self.pidfd)
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()


class PrivateSqlSession:
    def __init__(self, adapter):
        import selectors
        self.adapter = adapter; self.base = adapter.base; self.process = None; self.child = None; self.buffer = b''; self.total = 0
        self.selector = selectors.DefaultSelector()
        try:
            adapter.guard()
            self.base.pinned_file(adapter.p['tools']['psql'])
            import pwd
            account = pwd.getpwnam('postgres')
            owner = adapter.p['ownership']['data']
            demand(account.pw_uid == owner['uid'] and account.pw_gid == owner['gid'], 'postgres_account_changed')
            argv = [adapter.p['tools']['psql']['path'], '-U', 'postgres',
                    '-X', '--no-password', '-h', adapter.p['target']['socketDirectory'], '-p', str(adapter.p['target']['port']),
                    '-d', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1']
            adapter.guard(); self.base.remaining()
            self.child = OwnedPsqlChild(argv, self.base.remaining, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                user=account.pw_uid, group=account.pw_gid, extra_groups=[], start_new_session=True)
            self.process = self.child.process
            self.selector.register(self.process.stdout, selectors.EVENT_READ, 'stdout')
            self.selector.register(self.process.stderr, selectors.EVENT_READ, 'stderr')
        except:
            self.close(); raise

    def exchange(self, text):
        demand(type(text) is str and '\\' not in text and '\x00' not in text, 'internal_sql_only')
        self.adapter.guard(); self.base.remaining()
        marker = ('__RADAR_AUTH_ACK_' + os.urandom(16).hex()).encode()
        self.process.stdin.write(text.encode() + b'\n\\echo ' + marker + b'\n'); self.process.stdin.flush()
        lines = []
        while True:
            for key, _ in self.selector.select(self.base.remaining()):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    self.selector.unregister(key.fileobj)
                    demand(key.data != 'stdout', 'native_sql_unacknowledged')
                    continue
                self.total += len(chunk); demand(self.total <= 131072, 'native_sql_output_budget')
                if key.data == 'stderr': continue
                self.buffer += chunk
                while b'\n' in self.buffer:
                    line, self.buffer = self.buffer.split(b'\n', 1)
                    if line == marker:
                        demand(not self.buffer, 'unexpected_native_sql_output')
                        return b'\n'.join(lines) + (b'\n' if lines else b'')
                    lines.append(line)

    def close(self):
        try:
            if self.child is not None:
                self.process.stdin.close()
                self.child.close()
        finally: self.selector.close()


class NativeAdapter:
    def __init__(self, prepared, module):
        demand(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux_root_required')
        self.prepared = prepared; self.module = module
        self.base = module.NativeAdapter(prepared['provisioning'])
        self.base.deadline = min(self.base.deadline, time.monotonic() + prepared['plan']['invocationTimeoutSeconds'])
        self.p = prepared['provisioning']['plan']; self.plan = prepared['plan']

    def guard(self):
        demand(int(time.time() * 1000) < self.plan['credentialValidUntilMs'], 'credential_expired')
        self.base.resource_guard(); self.base.config_ancestor_identity(); self.base.remaining()

    def sql(self, text):
        session = PrivateSqlSession(self)
        try: return suppressed_sql(session, text, self.guard)
        finally: session.close()

    def make_credential(self):
        self.guard(); body = read_root_pin(self.plan['secretPin'], 65536, self.base.remaining)
        secrets = strict_json(body); fields(secrets, self.prepared['provisioning']['roles'])
        demand(all(type(v) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', v) for v in secrets.values()), 'source_secret_format')
        password = secrets[self.p['migratorRole']]
        return {'version': 1, 'purpose': 'production-migrator-private-connection', 'operationId': self.plan['operationId'],
            'planSha256': self.prepared['planSha256'], 'host': '127.0.0.1', 'port': 5432,
            'database': self.p['database'], 'user': self.p['migratorRole'], 'password': password,
            'scramVerifier': scram_verifier(password, os.urandom(16)), 'expiresAtMs': self.plan['credentialValidUntilMs'],
            'schema': self.p['schema'], 'generation': self.p['generation'], 'targetPins': self.plan['targetPins']}

    def hba(self):
        return ("local all postgres peer\nlocal all all reject\n"
            + f"host {self.p['database']} {self.p['migratorRole']} 127.0.0.1/32 scram-sha-256\n"
            + "host all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n").encode()

    def read_hba(self):
        self.guard()
        with self.base.bound_config_directory() as (directory, binding):
            before = self.base.owned_stamp('pg_hba.conf', 'hba', dir_fd=directory)
            pin = self.plan['initialHbaPin']
            demand((str(before['device']), str(before['inode'])) == (pin['device'], pin['inode']), 'hba_inode_changed')
            fd = os.open('pg_hba.conf', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                info = os.fstat(fd); demand(info.st_size <= 65536 and (info.st_dev, info.st_ino) == (before['device'], before['inode']), 'hba_identity')
                body = os.read(fd, 65537); after = os.fstat(fd); binding()
                demand(len(body) == info.st_size and (info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
                    (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                    self.base.owned_stamp('pg_hba.conf', 'hba', dir_fd=directory) == before, 'hba_changed')
                return body, before
            finally: os.close(fd)

    def root_identity(self, credential):
        names = ','.join("'" + name + "'" for name in self.prepared['provisioning']['roles'])
        password = 'false' if credential is None else "rolpassword='" + credential['scramVerifier'] + "'"
        text = "SELECT json_build_object('machineSystem', (pg_control_system()).system_identifier::text," \
            "'dataDirectory',current_setting('data_directory'),'configFile',current_setting('config_file')," \
            "'hbaFile',current_setting('hba_file'),'listen',current_setting('listen_addresses'),'port',current_setting('port')," \
            "'version',current_setting('server_version_num'),'start',pg_postmaster_start_time()::text," \
            "'database',(SELECT json_build_object('oid',oid::text,'owner',datdba::text,'limit',datconnlimit) FROM pg_database WHERE datname='" + self.p['database'] + "')," \
            "'roles',(SELECT json_agg(json_build_object('name',rolname,'oid',oid::text,'login',rolcanlogin,'inherit',rolinherit," \
            "'super',rolsuper,'createdb',rolcreatedb,'createrole',rolcreaterole,'replication',rolreplication,'bypass',rolbypassrls," \
            "'limit',rolconnlimit,'memberships',(SELECT count(*) FROM pg_auth_members WHERE member=pg_authid.oid)," \
            "'passwordNull',rolpassword IS NULL,'passwordMatches'," + password + "," \
            "'validUntilMs',(extract(epoch FROM rolvaliduntil)*1000)::bigint::text) ORDER BY rolname) FROM pg_authid WHERE rolname IN (" + names + ")));"
        value = strict_json(self.sql(text)); t = self.p['target']; pins = self.plan['targetPins']
        demand(value['machineSystem'] == pins['systemIdentifier'] and value['dataDirectory'] == t['dataDirectory']
            and value['configFile'] == t['configDirectory'] + '/postgresql.conf' and value['hbaFile'] == t['configDirectory'] + '/pg_hba.conf'
            and value['listen'] == '127.0.0.1' and value['port'] == '5432' and 160000 <= int(value['version']) < 170000, 'live_target_identity')
        demand(Path('/etc/machine-id').read_text().strip() == self.p['machineId'], 'machine_identity')
        demand(value['database'] == {'oid': pins['databaseOid'], 'owner': pins['roleOids'][self.p['migratorRole']],
            'limit': self.prepared['provisioning']['databaseConnectionLimit']}, 'database_identity')
        roles = value['roles']; demand(type(roles) is list and len(roles) == 7 and {r['name'] for r in roles} == set(pins['roleOids']), 'role_inventory')
        for role in roles:
            name = role['name']; migration = name == self.p['migratorRole']
            expected_limit = 1 if migration else next(self.p['resources']['pools'][s]['instances'] * self.p['resources']['pools'][s]['maximumConnections']
                for s in self.module.SERVICES if self.p['serviceRoles'][s] == name)
            demand(role['oid'] == pins['roleOids'][name] and role['memberships'] == 0 and role['limit'] == expected_limit
                and not any(role[k] for k in ('inherit', 'super', 'createdb', 'createrole', 'replication', 'bypass'))
                and (migration or role['login'] is False), 'role_authority_changed')
        return value

    def tcp_identity(self, credential):
        self.guard(); executable = self.base.pinned_file(self.p['tools']['psql'])
        demand(hasattr(os, 'memfd_create'), 'private_password_transport_unavailable')
        self.base.remaining(); fd = os.memfd_create('private-migrator-pgpass', flags=0)
        child = None
        try:
            os.fchmod(fd, 0o600)
            body = f"127.0.0.1:5432:{self.p['database']}:{self.p['migratorRole']}:{credential['password']}\n".encode()
            demand(os.write(fd, body) == len(body), 'private_password_transport_failed')
            argv = [executable, '-X', '--no-password', '-h', '127.0.0.1', '-p', '5432', '-U', self.p['migratorRole'],
                '-d', self.p['database'], '-qAt', '-v', 'ON_ERROR_STOP=1']
            query = "SELECT json_build_object('database',current_database(),'user',current_user,'sessionUser',session_user," \
                "'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'roleOid',(SELECT oid::text FROM pg_roles WHERE rolname=current_user)," \
                "'address',inet_server_addr()::text,'port',inet_server_port(),'start',pg_postmaster_start_time()::text);"
            self.guard(); remaining = self.base.remaining()
            child = OwnedPsqlChild(argv, self.base.remaining, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'PGPASSFILE': '/proc/self/fd/' + str(fd)},
                pass_fds=(fd,), start_new_session=True)
            process = child.process
            output, _ = process.communicate(query.encode(), timeout=min(remaining, self.p['stageTimeoutSeconds']))
            demand(process.returncode == 0 and len(output) <= 65536, 'migration_authentication_unverified')
            return strict_json(output)
        finally:
            try:
                if child is not None: child.close()
            finally: os.close(fd)


    def observe(self, credential, verify_tcp=True):
        self.guard(); before = self.root_identity(credential); body, stamp = self.read_hba()
        initial = self.module.NativeAdapter.hba_configuration()
        demand(body in (initial, self.hba()), 'unexpected_hba_content')
        role = next(r for r in before['roles'] if r['name'] == self.p['migratorRole']); receipts = {}
        if role['login']:
            demand(credential is not None and role['passwordMatches'] is True
                and role['validUntilMs'] == str(self.plan['credentialValidUntilMs']), 'migration_credential_mismatch')
            receipts['role'] = {'systemIdentifier': before['machineSystem'], 'databaseOid': before['database']['oid'],
                'roles': before['roles'], 'postmasterStart': before['start']}
        else:
            demand(role['passwordNull'] is True and body == initial, 'unexpected_initial_credential')
        if body == self.hba():
            demand('role' in receipts, 'hba_without_role_ack')
            rules = strict_json(self.sql("SELECT coalesce(json_agg(row_to_json(r) ORDER BY rule_number),'[]'::json) FROM pg_hba_file_rules r;"))
            expected = [('local', ['all'], ['postgres'], None, None, 'peer'), ('local', ['all'], ['all'], None, None, 'reject'),
                ('host', [self.p['database']], [self.p['migratorRole']], '127.0.0.1', '255.255.255.255', 'scram-sha-256'),
                ('host', ['all'], ['all'], '127.0.0.1', '255.255.255.255', 'reject'),
                ('host', ['all'], ['all'], '::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'reject')]
            demand(type(rules) is list and len(rules) == 5, 'migration_hba_rules')
            for i, (row, want) in enumerate(zip(rules, expected), 1):
                demand(row['rule_number'] == i and row['line_number'] == i and row['file_name'] == self.plan['initialHbaPin']['path']
                    and row['error'] is None and not row['options'] and tuple(row[k] for k in
                        ('type', 'database', 'user_name', 'address', 'netmask', 'auth_method')) == want, 'migration_hba_rules')
            receipts['hba'] = {'hbaSha256': sha(body), 'hbaOwnership': stamp, 'rulesSha256': sha(encoded(rules))}
            if verify_tcp:
                tcp = self.tcp_identity(credential)
                demand(tcp == {'database': self.p['database'], 'user': self.p['migratorRole'], 'sessionUser': self.p['migratorRole'],
                    'databaseOid': self.plan['targetPins']['databaseOid'], 'roleOid': self.plan['targetPins']['roleOids'][self.p['migratorRole']],
                    'address': '127.0.0.1', 'port': 5432, 'start': before['start']}, 'direct_migration_identity')
                receipts['hba']['tcp'] = tcp
        after = self.root_identity(credential); final_body, final_stamp = self.read_hba()
        demand(before == after and body == final_body and stamp == final_stamp, 'authentication_boundary_changed')
        self.guard()
        return {'phase': 'initial' if not receipts else 'active' if 'hba' in receipts else 'role', 'receipts': receipts}

    def apply(self, stage, credential):
        self.guard(); validate_credential(credential, self.prepared)
        if stage == 'role':
            deadline = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(credential['expiresAtMs'] // 1000)) + f".{credential['expiresAtMs'] % 1000:03d}+00"
            self.sql('BEGIN; ALTER ROLE ' + self.module.quote(self.p['migratorRole']) + " LOGIN CONNECTION LIMIT 1 PASSWORD '"
                + credential['scramVerifier'] + "' VALID UNTIL '" + deadline + "'; COMMIT;")
        elif stage == 'hba':
            old, stamp = self.read_hba(); demand(old == self.module.NativeAdapter.hba_configuration(), 'hba_already_changed')
            with self.base.bound_config_directory() as (directory, binding):
                self.guard(); binding(); fd = os.open('pg_hba.conf', os.O_WRONLY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    info = os.fstat(fd); demand((info.st_dev, info.st_ino) == (stamp['device'], stamp['inode']), 'hba_inode_changed')
                    self.guard(); binding(); os.ftruncate(fd, 0); self.guard(); body = self.hba()
                    demand(os.write(fd, body) == len(body), 'hba_write_unknown'); os.fsync(fd); binding()
                finally: os.close(fd)
                self.guard(); os.fsync(directory)
            demand(self.sql('SELECT pg_reload_conf();').strip() == b't', 'hba_reload_unknown')
        else: raise Refused('unknown_stage')

def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('plan', 'apply', 'reconcile', 'measure', 'measure-root'), default='plan')
    parser.add_argument('--plan', required=True); parser.add_argument('--approved-plan-sha256'); parser.add_argument('--private-directory')
    parser.add_argument('--offline-provisioning-source')
    args = parser.parse_args(); path = Path(args.plan)
    demand(path.is_file() and not path.is_symlink() and path.stat().st_size <= 65536, 'plan_file')
    plan = strict_json(path.read_bytes())
    if args.offline_provisioning_source:
        demand(args.mode == 'plan', 'offline_only')
        source = Path(args.offline_provisioning_source)
        demand(source.is_file() and not source.is_symlink() and source.stat().st_size <= 1024 ** 2, 'offline_dependency')
        body = source.read_bytes(); demand(sha(body) == PROVISIONING_SHA256, 'frozen_dependency_pin')
        module = types.ModuleType('offline_provisioning'); module.__file__ = str(source)
        exec(compile(body, str(source), 'exec'), module.__dict__)
    else: module = load_provisioning(plan['provisioningModule'])
    prepared = validate_plan(plan, module, int(time.time() * 1000))
    if args.mode == 'plan':
        demand(not args.approved_plan_sha256 and not args.private_directory, 'arguments')
        return public_result('plan_validated', planSha256=prepared['planSha256'], hostObserved=False)
    demand(args.private_directory, 'private_directory_required')
    if args.mode not in ('measure', 'measure-root'): demand(args.approved_plan_sha256 == prepared['planSha256'], 'explicit_plan_binding_required')
    else: demand(not args.approved_plan_sha256, 'arguments')
    adapter = NativeAdapter(prepared, module); adapter.guard()
    if args.mode in ('measure', 'measure-root', 'reconcile'): module.secure_stat(Path(args.private_directory), 0, 0o700, True)
    storage = module.PrivateStorage(args.private_directory)
    if args.mode in ('measure', 'measure-root'):
        journal = storage.load(); credential = storage.read('secrets.json'); validate_credential(credential, prepared)
        demand(journal['planSha256'] == prepared['planSha256'] and journal['pending'] is None and
            sha(encoded(credential)) == journal['credentialSha256'], 'authentication_journal')
        measured = adapter.observe(credential, verify_tcp=args.mode == 'measure')
        expected = strict_json(encoded(journal['acknowledged']))
        if args.mode == 'measure-root': expected['hba'].pop('tcp')
        demand(set(measured['receipts']) == {'role', 'hba'} and measured['receipts'] == expected, 'authentication_ack')
        return public_result('measured_migrator_authentication' if args.mode == 'measure' else 'measured_root_migrator_boundary',
            tcpAuthenticationChecked=args.mode == 'measure', planSha256=prepared['planSha256'],
            systemIdentifier=plan['targetPins']['systemIdentifier'], databaseOid=plan['targetPins']['databaseOid'],
            roleOid=plan['targetPins']['roleOids'][prepared['provisioning']['plan']['migratorRole']],
            postmasterStart=measured['receipts']['role']['postmasterStart'], credentialValidUntilMs=credential['expiresAtMs'])
    return activate(prepared, adapter, storage, args.mode)

if __name__ == '__main__':
    try:
        def interrupted(_signum, _frame): raise Refused('authentication_interrupted')
        signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
        print(json.dumps(cli(), sort_keys=True))
    except Exception as error:
        # Never print arbitrary exception strings, SQL, stderr, passwords or verifiers.
        reason = str(error) if type(error) is Refused else 'authentication_failed_reconcile_before_retry'
        print(json.dumps(public_result('refused', code=reason)), file=sys.stderr); sys.exit(1)
