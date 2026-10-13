"""Prepare real, disposable PG identities and native pins, never a success receipt."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

SCOPE = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
DATABASE = 'radar_rehearsal_0123456789abcdef'
ROLE = 'radar_migrator_0123456789abcdef'


def prepare():
    assert os.geteuid() == 0 and Path('/.dockerenv').is_file()
    assert Path('/proc/1/comm').read_text().strip() == 'systemd'
    assert not any(k.startswith(('DBUS_', 'SYSTEMD_')) for k in os.environ)
    def sql(statement):
        result = subprocess.run(['/usr/bin/sudo', '-n', '-u', 'postgres', '/usr/lib/postgresql/16/bin/psql',
            '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', DATABASE, '-c',
            "SET statement_timeout='2000ms'; SET lock_timeout='1000ms'; " + statement],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=3, check=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        assert 0 < len(result.stdout) <= 8192
        return json.loads(result.stdout)
    identity = sql("SELECT json_build_object('protocol','address-only-isolated-rotation-v1',"
        "'systemIdentifier',(pg_catalog.pg_control_system()).system_identifier::text,"
        "'database',current_database(),'databaseOid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()),"
        "'username',rolname,'roleOid',oid::text,'host','127.0.0.1','port',5432) "
        "FROM pg_catalog.pg_roles WHERE rolname='" + ROLE + "'")
    assert identity['systemIdentifier'] != '7693392208475083526'
    assert identity['database'] == DATABASE and identity['username'] == ROLE
    def put(name, body):
        raw = (json.dumps(body, sort_keys=True, separators=(',', ':'))+'\n').encode()
        path = SCOPE/name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}
    def pin(path):
        assert path.is_relative_to(SCOPE) and not path.is_symlink()
        info = path.stat()
        assert info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o022
        raw = path.read_bytes()
        return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}
    scripts = SCOPE/'tools/scripts'
    tools = {name: pin(scripts/filename) for name, filename in {
        'rotation': 'rotate-address-only-migrator.py', 'rotationSupport': 'activate-production-postgres-migrator.py',
        'adapter': 'source-replacement-controller-adapter.py', 'sequence': 'run-pg-source-replacement.py',
        'pgFence': 'pg-source-replacement-fence.py', 'configured': 'activate-address-only-configured.py',
        'activation': 'activate-address-only-postgres.py', 'controller': 'run-address-only-native-controller.py',
        'fence': 'address-only-native-fence.py', 'reconcile': 'address-only-pg-reconcile.py',
        'execute': 'execute-pg-source-replacement.py'}.items()}
    tools['node'] = pin(SCOPE/'bin/node')
    tools['python'] = pin(SCOPE/'bin/python3')
    tools['import'] = pin(SCOPE/'tools/import.mjs')
    # Expire only the disposable migrator after the genuine original import and COMPLETE.
    expiry = sql("ALTER ROLE " + ROLE + " VALID UNTIL '2000-01-01T00:00:00Z'; "
        "SELECT json_build_object('expired',rolvaliduntil<clock_timestamp(),'sessions',"
        "(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE usename='"+ROLE+"')) "
        "FROM pg_catalog.pg_roles WHERE rolname='"+ROLE+"'")
    assert expiry == {'expired': True, 'sessions': 0}
    result = {'protocol': 'address-only-isolated-native-environment-v1', 'identity': put('rotation-identity.json', identity),
              'tools': tools, 'migratorExpired': True, 'rotationExecuted': False, 'productionProof': False}
    put('native-environment.json', result)
    fd = os.open(SCOPE, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)
    print(json.dumps({'event': 'ISOLATED_NATIVE_EXECUTE_ENVIRONMENT_PREPARED', 'toolCount': len(tools),
                      'migratorExpired': True, 'rotationExecuted': False, 'productionProof': False}), flush=True)


if __name__ == '__main__':
    prepare()
