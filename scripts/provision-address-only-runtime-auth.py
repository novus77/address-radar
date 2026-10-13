"""Scoped service credentials and loopback HBA with a separate recovery timer."""
import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import tempfile

BASE = Path('/var/lib/address-radar-maintenance-tools')
HBA = Path('/etc/postgresql/16/radarproduction/pg_hba.conf')
NODE = BASE / 'native-node-7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c/node'
RELEASE = BASE / 'schema-v3-7c770833b894072ddca3e7c30bed776da83de36370c39b9c8876644399e88887/release'
LOCK = BASE / 'private-migrator-dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61/authentication-state/operation.lock'
SOURCE_PLAN = BASE / 'provision-d70ab3c0ef4d89b12f40296418cb4b7a83bad561c7ec544d5123f1bf2d308f96/plan.json'
SERVICES = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console']
ROLES = ['address_radar_' + service.replace('-', '_') for service in SERVICES]
BASELINE = (b'local all postgres peer\nlocal all all reject\n'
            b'host address_radar address_radar_migrator 127.0.0.1/32 scram-sha-256\n'
            b'host all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n')
ROLE_LIST = ','.join("'" + role + "'" for role in ROLES)


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def scram(password, salt):
    salted = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 4096)
    client = hmac.new(salted, b'Client Key', hashlib.sha256).digest()
    server = hmac.new(salted, b'Server Key', hashlib.sha256).digest()
    encode = lambda value: base64.b64encode(value).decode()
    return 'SCRAM-SHA-256$4096:' + encode(salt) + '$' + encode(hashlib.sha256(client).digest()) + ':' + encode(server)


def runtime_hba(original):
    require(original == BASELINE, 'hba_baseline_changed')
    lines = ''.join('host address_radar ' + role + ' 127.0.0.1/32 scram-sha-256\n' for role in ROLES).encode()
    return original.replace(b'host all all 127.0.0.1/32 reject\n', lines + b'host all all 127.0.0.1/32 reject\n')


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())


def psql(sql):
    result = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-qAt', '-v',
                             'ON_ERROR_STOP=1', '-d', 'address_radar'], input=sql,
                            text=True, capture_output=True, timeout=15)
    require(result.returncode == 0, 'native_auth_sql_refused_or_commit_unknown')
    return result.stdout.strip()


def replace_hba(body, expected):
    require(HBA.read_bytes() == expected, 'hba_concurrent_change')
    original = HBA.lstat()
    require(stat.S_ISREG(original.st_mode) and original.st_nlink == 1
            and (original.st_uid, original.st_gid, stat.S_IMODE(original.st_mode)) == (110, 114, 0o640), 'hba_metadata_changed')
    fd, pending = tempfile.mkstemp(prefix='.address-radar-runtime-', dir=HBA.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(body)
            handle.flush()
            os.fchown(handle.fileno(), original.st_uid, original.st_gid)
            os.fchmod(handle.fileno(), 0o640)
            os.fsync(handle.fileno())
        require(HBA.read_bytes() == expected, 'hba_changed_before_replace')
        os.replace(pending, HBA)
        parent = os.open(HBA.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)
    require(psql('SELECT pg_reload_conf();') == 't', 'reload_refused')
    require(psql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL;') == '0', 'hba_rule_error')


def restore(directory):
    intent = json.loads((directory / 'intent.json').read_text())
    original = base64.b64decode(intent['originalHba'])
    expected = runtime_hba(original)
    live = HBA.read_bytes()
    require(live in (original, expected), 'restore_hba_collision')
    statements = []
    for role in intent['roles']:
        require(role['role'] in ROLES and role['login'] is False, 'restore_role_scope')
        password = role['password']
        require(password is None or re.fullmatch(r'SCRAM-SHA-256\$[A-Za-z0-9$:+/=]+', password), 'restore_password_format')
        statements.append('ALTER ROLE "' + role['role'] + '" NOLOGIN PASSWORD ' + ('NULL' if password is None else "'" + password + "'") + ';')
    psql("BEGIN; SET LOCAL log_min_error_statement='panic'; " + ''.join(statements) + ' COMMIT;')
    if live == expected:
        replace_hba(original, expected)
    require(HBA.read_bytes() == original, 'restore_byte_mismatch')
    if not (directory / 'restore-receipt.json').exists():
        save(directory / 'restore-receipt.json', dict(status='service-auth-restored', rolesLoginDisabled=True,
                                                     originalHbaSha256=hashlib.sha256(original).hexdigest()))


PROBE = r"""
import { readFileSync } from 'node:fs';
const directory=process.env.ADDRESS_RADAR_AUTH_DIRECTORY;
const source=JSON.parse(readFileSync(process.env.ADDRESS_RADAR_AUTH_SOURCE,'utf8'));
const driver=await import(process.env.ADDRESS_RADAR_AUTH_DRIVER);
const resources=source.resources;
const budgets=Object.fromEntries(Object.entries(resources.pools).map(([service,value])=>[service,value.maximumConnections]));
const runtimes=[];
try {
 for(const [service,username] of Object.entries(source.serviceRoles)) {
  const credential=JSON.parse(readFileSync(directory+'/'+service+'.json','utf8'));
  if(credential.username!==username)throw Error('credential-role-mismatch');
  runtimes.push(driver.createPostgresBusinessRuntime({connectionString:credential.connectionString,
   target:{database:'address_radar',username,schema:'address_radar_business',generation:source.generation,service},
   access:service==='console'?'read':'runtime',schemaVersion:3,
   schemaFingerprint:'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383',ssl:false,
   maximumConnections:1,serviceConnectionBudgets:budgets,serverMaximumConnections:16,reservedConnections:7,
   ...Object.fromEntries(['maximumPendingOperations','connectionTimeoutMs','idleTimeoutMs','statementTimeoutMs','lockTimeoutMs','idleTransactionTimeoutMs','shutdownTimeoutMs','workMemKb'].map(key=>[key,resources[key]]))}));
 }
 const identities=await Promise.all(runtimes.map(runtime=>runtime.probe()));
 process.stdout.write(JSON.stringify({roles:identities.length,schemaVersion:3,tcpLoopback:true,actualBusinessDriver:true}));
} catch {
 process.exitCode=2;
} finally {
 const closed=await Promise.allSettled(runtimes.map(runtime=>runtime.close()));
 if(closed.some(item=>item.status!=='fulfilled'))process.exitCode=2;
}
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--restore', action='store_true')
    args = parser.parse_args()
    directory = Path(args.directory)
    require(os.geteuid() == 0 and directory.parent == BASE
            and re.fullmatch('address-only-runtime-auth-[a-f0-9]{16}', directory.name), 'root_private_scope_required')
    require(directory.lstat().st_uid == 0 and stat.S_IMODE(directory.lstat().st_mode) == 0o700, 'private_directory_required')
    lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.restore:
            restore(directory)
            return
        require(not (directory / 'intent.json').exists(), 'operation_already_started')
        original = HBA.read_bytes()
        updated = runtime_hba(original)
        identity = json.loads(psql("SELECT json_build_object('cluster',(SELECT system_identifier::text FROM pg_control_system()),'port',current_setting('port'),'database',current_database());"))
        require(identity == dict(cluster='7693392208475083526', port='5432', database='address_radar'), 'target_changed')
        roles = json.loads(psql("SELECT json_agg(json_build_object('role',rolname,'oid',oid::text,'login',rolcanlogin,'password',rolpassword)) FROM pg_authid WHERE rolname IN (" + ROLE_LIST + ');'))
        require(len(roles) == 6 and all(not role['login'] for role in roles), 'roles_already_enabled')
        save(directory / 'intent.json', dict(version=1, originalHba=base64.b64encode(original).decode(), roles=roles,
             approvalRef='user-approved-complete-address-only-migration-20261008', target=identity))
        nonce = directory.name.rsplit('-', 1)[1]
        timer = 'address-radar-runtime-auth-restore-' + nonce
        subprocess.run(['systemd-run', '--quiet', '--unit=' + timer, '--on-active=120s', '--timer-property=AccuracySec=1s',
                        '--property=RuntimeMaxSec=30', '/usr/bin/python3', str(directory / 'auth.py'),
                        '--directory', str(directory), '--restore'], check=True, capture_output=True, timeout=8)
        try:
            statements = []
            for service, role in zip(SERVICES, ROLES):
                password = secrets.token_hex(32)
                save(directory / (service + '.json'), dict(username=role,
                     connectionString='postgresql://' + role + ':' + password + '@127.0.0.1:5432/address_radar',
                     gatewayDeliveryEnabled=False, service=service))
                statements.append('ALTER ROLE "' + role + '" LOGIN PASSWORD ' + "'" + scram(password, secrets.token_bytes(16)) + "';")
            replace_hba(updated, original)
            psql("BEGIN; SET LOCAL log_statement='none'; SET LOCAL log_min_error_statement='panic'; " + ''.join(statements) + ' COMMIT;')
            result = subprocess.run([str(NODE), '--max-old-space-size=96', '--input-type=module', '-e', PROBE],
                                    text=True, capture_output=True, timeout=35,
                                    env={'PATH': '/usr/bin:/bin', 'ADDRESS_RADAR_AUTH_DIRECTORY': str(directory),
                                         'ADDRESS_RADAR_AUTH_SOURCE': str(SOURCE_PLAN),
                                         'ADDRESS_RADAR_AUTH_DRIVER': (RELEASE / 'packages/database/src/postgres-business-driver.js').as_uri()})
            require(result.returncode == 0, 'actual_business_driver_probe_refused')
            measured = json.loads(result.stdout)
            require(measured == dict(roles=6, schemaVersion=3, tcpLoopback=True, actualBusinessDriver=True), 'incomplete_role_probe')
            save(directory / 'receipt.json', dict(status='six-runtime-roles-authenticated-and-probed', probe=measured,
                 hbaSha256=hashlib.sha256(updated).hexdigest(), activationAuthorized=False, businessRowsWritten=False))
            subprocess.run(['systemctl', 'stop', timer + '.timer'], check=True, capture_output=True, timeout=8)
            print(json.dumps(dict(status='six-runtime-roles-authenticated-and-probed', roles=6,
                                  activationAuthorized=False, businessRowsWritten=False)))
        except BaseException:
            restore(directory)
            raise
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
