#!/usr/bin/env python3
"""Build one root-private activation candidate from measured native identity; never activate."""
import argparse
import hashlib
import json
import os
import re
import stat
import sys
import time
import types
from pathlib import Path

PROVISIONING_SHA256 = '43978c786e262cf4abb037b9be7d2ea556b31c0532ad10df8bfbdfecadbc9c7f'
ACTIVATION_SHA256 = 'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61'
PROVISIONING_PLAN_SHA256 = 'b8e9bd6ec46723e0eeb45915c12c86d61168d24569c934bce70039bafe2e0b46'
SYSTEM_IDENTIFIER = '7693392208475083526'
DATABASE_OID = '16391'
CREDENTIAL_TTL_MS = 6 * 60 * 60 * 1000
ROLE_OIDS = {'migration': '16384', 'scanner': '16385', 'automation': '16386',
             'wallet-monitor': '16387', 'wallet-analysis': '16388', 'historical-backfill': '16389', 'console': '16390'}
ARTIFACT_EXPECTATIONS = {
    'source': {'sha256': PROVISIONING_SHA256, 'uid': 0, 'gid': 0, 'mode': 320, 'device': '64769', 'inode': '6029439'},
    'plan': {'sha256': '17583fd01fa845a612c5facfb93f7bfcaf1dd5824266b9db5909e88607339025',
             'uid': 0, 'gid': 0, 'mode': 384, 'device': '64769', 'inode': '6029424'},
    'secret': {'sha256': '99544ca4aacf284d75e4f17287c19a9ab20e8cd47c576a20e4d7d8053fc7bedb',
               'uid': 0, 'gid': 0, 'mode': 384, 'device': '64769', 'inode': '6029422'},
    'hba': {'sha256': 'a3cef5d1d591c3a34dd1aebedd1e3a2b877a20bfcf039c7059d1a5df7631d9b1',
            'uid': 110, 'gid': 114, 'mode': 416, 'device': '64769', 'inode': '5767205'},
}


class Refused(Exception): pass


def demand(value, reason):
    if not value: raise Refused(reason)


def encoded(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def strict_json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            demand(key not in result, 'duplicate_json_field'); result[key] = value
        return result
    return json.loads(body, object_pairs_hook=pairs, parse_constant=lambda _value: (_ for _ in ()).throw(Refused('nonfinite_json')))


def credential_expiry(server_time_ms):
    demand(type(server_time_ms) is int and 0 < server_time_ms < 2 ** 53 - CREDENTIAL_TTL_MS, 'server_clock')
    return server_time_ms + CREDENTIAL_TTL_MS


def pin_from_stat(path, info, digest):
    return {'path': str(path), 'sha256': digest, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'device': str(info.st_dev), 'inode': str(info.st_ino)}


def require_original_pin(slot, pin):
    demand(slot in ARTIFACT_EXPECTATIONS and all(pin.get(key) == value for key, value in ARTIFACT_EXPECTATIONS[slot].items()), 'original_artifact_pin_changed')


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_ctime_ns, info.st_mtime_ns)


def parent_fd(path):
    path = Path(path)
    demand(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'absolute_path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    bindings = []
    try:
        for name in path.parent.parts[1:]:
            info = os.fstat(fd)
            demand(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe_root_ancestor')
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            expected = os.stat(name, dir_fd=fd, follow_symlinks=False)
            actual = os.fstat(child)
            demand(actual.st_dev == expected.st_dev and actual.st_ino == expected.st_ino, 'ancestor_race')
            bindings.append((fd, name, actual.st_dev, actual.st_ino, actual.st_uid, actual.st_gid, actual.st_mode))
            fd = child
        info = os.fstat(fd); demand(info.st_uid == 0 and not info.st_mode & 0o022, 'unsafe_root_parent')
        return fd, bindings
    except:
        os.close(fd)
        for item in bindings:
            try: os.close(item[0])
            except OSError: pass
        raise


def check_bindings(fd, bindings):
    for parent, name, device, inode, uid, gid, mode in bindings:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        demand((current.st_dev, current.st_ino, current.st_uid, current.st_gid, current.st_mode)
               == (device, inode, uid, gid, mode), 'ancestor_changed')
    current = os.fstat(fd); demand(current.st_uid == 0 and not current.st_mode & 0o022, 'root_parent_changed')


def close_parent(fd, bindings):
    os.close(fd)
    for binding in bindings: os.close(binding[0])


def file_pin(path, maximum, remaining, keep_body=False, mode=None, fd_parent=None, bind=None, owner=0, group=0):
    owned_parent = fd_parent is None
    if owned_parent: fd_parent, bindings = parent_fd(path)
    fd = None
    try:
        remaining()
        if bind: bind()
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd_parent)
        before = os.fstat(fd)
        demand(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum
               and before.st_uid == owner and before.st_gid == group and not before.st_mode & 0o022
               and (mode is None or stat.S_IMODE(before.st_mode) == mode), 'unsafe_or_oversize_pin')
        digest = hashlib.sha256(); body = [] if keep_body else None; total = 0
        while True:
            remaining(); chunk = os.read(fd, min(65536, maximum - total + 1))
            if not chunk: break
            total += len(chunk); demand(total <= maximum, 'pin_grew'); digest.update(chunk)
            if body is not None: body.append(chunk)
        demand(total == before.st_size and identity(before) == identity(os.fstat(fd))
               and identity(before) == identity(os.stat(Path(path).name, dir_fd=fd_parent, follow_symlinks=False)), 'pin_race')
        if owned_parent: check_bindings(fd_parent, bindings)
        if bind: bind()
        return pin_from_stat(path, before, digest.hexdigest()), b''.join(body) if body is not None else None
    finally:
        if fd is not None: os.close(fd)
        if owned_parent: close_parent(fd_parent, bindings)


def validated_roles(prepared):
    roles = prepared['roles']
    demand(isinstance(roles, list) and len(roles) == 7 and all(isinstance(r, str) for r in roles), 'reviewed_role_contract')
    services = prepared['plan']['serviceRoles']
    demand(isinstance(services, dict) and set(services) == set(ROLE_OIDS) - {'migration'}, 'reviewed_role_contract')
    by_service = {'migration': prepared['plan']['migratorRole'], **services}
    demand(set(by_service) == set(ROLE_OIDS) and len(set(by_service.values())) == 7
           and set(by_service.values()) == set(roles), 'reviewed_role_contract')
    return by_service


def validate_observation(prepared, observed):
    names = validated_roles(prepared)
    demand(prepared['plan']['database'] == 'address_radar' and observed['systemIdentifier'] == SYSTEM_IDENTIFIER
           and observed['database'] == 'address_radar' and observed['databaseOid'] == DATABASE_OID and observed['namespaceCount'] == 0, 'native_target_changed')
    clock = observed['serverTimeMs']; demand(isinstance(clock, str) and re.fullmatch(r'[1-9][0-9]*', clock), 'server_clock')
    rows = observed['roles']; demand(isinstance(rows, list) and len(rows) == 7, 'native_roles_changed')
    actual = {row['name']: row for row in rows}
    demand(len(actual) == 7 and set(actual) == set(names.values()), 'native_roles_changed')
    for service, name in names.items():
        row = actual[name]
        demand(row['oid'] == ROLE_OIDS[service] and row['login'] is False and row['connectionLimit'] == 1
               and row['passwordNull'] is True, 'native_roles_changed')
    value = int(clock); credential_expiry(value)
    return value, {'systemIdentifier': SYSTEM_IDENTIFIER, 'databaseOid': DATABASE_OID,
                   'roleOids': {name: actual[name]['oid'] for name in sorted(actual)}}


def observe_prepared(native, prepared):
    native.resource_guard()
    return native.observe(prepared)


def query_target(native, prepared, sql):
    return native.sql(sql, database=prepared['plan']['database'])


def load_module(body, path, name):
    module = types.ModuleType(name); module.__file__ = str(path)
    exec(compile(body, str(path), 'exec'), module.__dict__)
    return module


def write_once(path, body, remaining):
    parent, bindings = parent_fd(path); fd = None
    try:
        demand(stat.S_IMODE(os.fstat(parent).st_mode) == 0o700, 'output_parent_must_be_root0700')
        remaining(); check_bindings(parent, bindings)
        fd = os.open(Path(path).name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        offset = 0
        while offset < len(body): remaining(); offset += os.write(fd, body[offset:])
        os.fsync(fd); os.fsync(parent); check_bindings(parent, bindings)
        demand(os.fstat(fd).st_uid == 0 and stat.S_IMODE(os.fstat(fd).st_mode) == 0o600, 'candidate_owner')
    finally:
        if fd is not None: os.close(fd)
        close_parent(parent, bindings)


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('provisioning-source', 'provisioning-plan', 'provisioning-secret', 'activation-source', 'operation-id', 'approval-ref', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--invocation-timeout-seconds', required=True, type=int)
    args = parser.parse_args()
    demand(sys.platform == 'linux' and os.geteuid() == 0, 'native_root_required')
    demand(1 <= args.invocation_timeout_seconds <= 180, 'invocation_budget')
    deadline = time.monotonic() + args.invocation_timeout_seconds
    def remaining(): demand(time.monotonic() < deadline, 'builder_budget_exhausted')
    source_pin, source = file_pin(args.provisioning_source, 1048576, remaining, True)
    require_original_pin('source', source_pin)
    demand(source_pin['sha256'] == PROVISIONING_SHA256, 'frozen_provisioning_source_changed')
    activation_pin, activation_body = file_pin(args.activation_source, 1048576, remaining, True)
    demand(activation_pin['sha256'] == ACTIVATION_SHA256, 'frozen_activation_source_changed')
    plan_pin, plan_body = file_pin(args.provisioning_plan, 65536, remaining, True)
    require_original_pin('plan', plan_pin)
    plan = strict_json(plan_body); demand(hashlib.sha256(encoded(plan)).hexdigest() == PROVISIONING_PLAN_SHA256, 'original_plan_changed')
    module = load_module(source, args.provisioning_source, 'frozen439')
    activation = load_module(activation_body, args.activation_source, 'frozen_activation')
    prepared = module.validate_plan(plan, int(time.time() * 1000)); names = validated_roles(prepared)
    native = module.NativeAdapter(prepared); native.deadline = min(native.deadline, deadline)
    observe_prepared(native, prepared)
    literal = lambda text: "'" + text.replace("'", "''") + "'"
    sql = "SELECT json_build_object('serverTimeMs',floor(extract(epoch from clock_timestamp())*1000)::bigint::text," \
        "'database',current_database(),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system())," \
        "'databaseOid',(SELECT oid::text FROM pg_database WHERE datname='address_radar')," \
        "'namespaceCount',(SELECT count(*) FROM pg_namespace WHERE nspname=" + literal(plan['schema']) + ")," \
        "'roles',(SELECT json_agg(json_build_object('name',rolname,'oid',oid::text,'login',rolcanlogin," \
        "'connectionLimit',rolconnlimit,'passwordNull',rolpassword IS NULL) ORDER BY rolname) FROM pg_authid WHERE rolname IN (" \
        + ','.join(literal(name) for name in sorted(names.values())) + ')));'
    remaining(); server_time_ms, target_pins = validate_observation(prepared, strict_json(query_target(native, prepared, sql).strip()))
    secret_pin, _ = file_pin(args.provisioning_secret, 65536, remaining, mode=0o600)
    require_original_pin('secret', secret_pin)
    with native.bound_config_directory() as (fd, binding):
        hba_path = str(Path(plan['target']['configDirectory']) / 'pg_hba.conf')
        hba_owner = os.stat('pg_hba.conf', dir_fd=fd, follow_symlinks=False)
        demand(hba_owner.st_uid == 110 and hba_owner.st_gid == 114 and stat.S_IMODE(hba_owner.st_mode) == 0o640, 'hba_owner_changed')
        hba_pin, _ = file_pin(hba_path, 65536, remaining, mode=0o640, fd_parent=fd, bind=binding, owner=110, group=114)
    require_original_pin('hba', hba_pin)
    demand(hba_pin['sha256'] == hashlib.sha256(module.NativeAdapter.hba_configuration()).hexdigest(), 'initial_hba_changed')
    candidate = {'version': 1, 'operationId': args.operation_id, 'approvalRef': args.approval_ref,
        'provisioningModule': source_pin, 'provisioningPlan': plan, 'provisioningPlanSha256': PROVISIONING_PLAN_SHA256,
        'targetPins': target_pins, 'secretPin': secret_pin, 'initialHbaPin': hba_pin,
        'credentialValidUntilMs': credential_expiry(server_time_ms), 'invocationTimeoutSeconds': args.invocation_timeout_seconds}
    activation.validate_plan(candidate, module, server_time_ms)
    observe_prepared(native, prepared); remaining()
    for path, maximum, expected in ((args.provisioning_source, 1048576, source_pin), (args.activation_source, 1048576, activation_pin),
                                   (args.provisioning_plan, 65536, plan_pin), (args.provisioning_secret, 65536, secret_pin)):
        current, _ = file_pin(path, maximum, remaining); demand(current == expected, 'artifact_changed_before_candidate')
    write_once(args.output, encoded(candidate) + b'\n', remaining)
    return {'status': 'activation_candidate_created', 'candidatePath': args.output,
            'planSha256': hashlib.sha256(encoded(candidate)).hexdigest(), 'serverTimeMs': server_time_ms,
            'credentialValidUntilMs': candidate['credentialValidUntilMs'], 'credentialTtlMs': CREDENTIAL_TTL_MS,
            'autoRenew': False, 'rolesChanged': False, 'productionMigrationReady': False}


if __name__ == '__main__':
    try: print(json.dumps(cli(), sort_keys=True))
    except Exception:
        print(json.dumps({'status': 'refused', 'code': 'candidate_builder_failed_preserved', 'productionMigrationReady': False}), file=sys.stderr)
        sys.exit(1)
