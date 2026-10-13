"""Preparation only: no LOGIN, schema install, import, service/backend switch or trust issuance.

The business namespace is deliberately absent until installPostgresBusinessSchema runs
under separately approved migration credentials. Host execution requires separate approval.
"""

import argparse
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time

SERVICES = ('scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console')
LIMITS = ('maximumPendingOperations', 'connectionTimeoutMs', 'idleTimeoutMs', 'statementTimeoutMs',
    'lockTimeoutMs', 'idleTransactionTimeoutMs', 'shutdownTimeoutMs', 'workMemKb')
RESOURCE_FIELDS = (*LIMITS, 'pools', 'serverMaximumConnections', 'postgresReservedConnections',
    'otherHostConnections', 'migrationConnections', 'operatorConnections', 'backupConnections', 'maximumMeasurementAgeMs')
CAPACITY_FIELDS = ('status', 'hostId', 'measurementRef', 'resourcePolicyFingerprint', 'measuredAt', 'validUntil',
    'availableRamBytes', 'measuredPeakRamBytes', 'ramMarginBytes', 'availableDiskBytes', 'measuredPeakDiskBytes',
    'measuredPeakWalBytes', 'measuredPeakTempBytes', 'diskMarginBytes')
TARGET_FIELDS = ('version', 'cluster', 'host', 'port', 'dataDirectory', 'configDirectory', 'socketDirectory')
SETTINGS_FIELDS = ('sharedBuffersKb', 'maxWalSizeMb', 'maintenanceWorkMemKb', 'superuserReservedConnections', 'reservedConnections')
GUARD_FIELDS = ('minimumAvailableMemoryBytes', 'minimumFreeDiskBytes', 'maximumMemoryPsiAvg10')
TOOLS = ('pg_createcluster', 'pg_ctlcluster', 'pg_controldata', 'runuser', 'psql', 'systemctl', 'busctl')
OWNERSHIP_FIELDS = ('data', 'config', 'mainConfig', 'hba', 'generatedConfig')
UNIT_FIELDS = ('fragmentPath', 'fragmentSha256', 'dropIns', 'execStart', 'user', 'group', 'environmentFiles')
PLAN_FIELDS = ('version', 'operationId', 'hostId', 'machineId', 'target', 'database', 'schema', 'generation',
    'migratorRole', 'serviceRoles', 'resources', 'capacity', 'settings', 'emptyTargetGuard', 'tools', 'ownership', 'configAncestors', 'startupUnit', 'stageTimeoutSeconds', 'operationTimeoutSeconds')
STAGES = ('cluster', 'configure', 'start', 'roles', 'database', 'lockdown')

class Refused(Exception):
    """Fixed non-secret failure code; never include command output or candidate values."""

def demand(value, code):
    if not value:
        raise Refused(code)

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()

def digest(body):
    return hashlib.sha256(body).hexdigest()

def fields(value, required):
    demand(type(value) is dict and set(value) == set(required), 'unknown_or_missing_field')
    return value

def integer(value, minimum=1, maximum=2147483647):
    demand(type(value) is int and minimum <= value <= maximum, 'invalid_resource')
    return value

def identifier(value):
    demand(type(value) is str and re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', value)
        and not re.search(r'(?:^|_)(?:acceptance|test)(?:_|$)', value)
        and not value.startswith('pg_') and value not in ('postgres', 'template0', 'template1', 'public', 'information_schema'), 'invalid_identifier')
    return value

def reference(value):
    demand(type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}', value), 'invalid_reference')

def byte_count(value, zero=False):
    demand(type(value) is str and re.fullmatch(r'(0|[1-9][0-9]{0,39})', value), 'invalid_bytes')
    result = int(value)
    demand(zero or result > 0, 'invalid_bytes')
    return result

def timestamp(value):
    demand(type(value) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', value), 'invalid_time')
    try:
        parsed = datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
    except ValueError:
        raise Refused('invalid_time') from None
    return int(parsed.timestamp() * 1000)

def static_exec_start(value):
    demand(type(value) is str and value.startswith('{') and value.endswith('}'), 'startup_exec_format')
    parts = {}
    for part in value[1:-1].split(';'):
        if not part.strip():
            continue
        key, separator, content = part.strip().partition('=')
        demand(separator and key not in parts and key in
            ('path', 'argv[]', 'ignore_errors', 'start_time', 'stop_time', 'pid', 'code', 'status'), 'startup_exec_format')
        parts[key] = content.strip()
    demand({'path', 'argv[]', 'ignore_errors'} <= set(parts)
        and parts['path'].startswith('/') and parts['argv[]']
        and parts['ignore_errors'] in ('yes', 'no'), 'startup_exec_format')
    # Compare systemctl's static argv serialization; never shell-evaluate it.
    return {key: parts[key] for key in ('path', 'argv[]', 'ignore_errors')}

def validate_plan(plan, now_ms):
    # Detach the caller's plan; only inert JSON is persisted or used after validation.
    try:
        plan = json.loads(encoded(plan))
    except (TypeError, ValueError):
        raise Refused('invalid_plan') from None
    fields(plan, PLAN_FIELDS)
    demand(plan['version'] == 1, 'plan_version')
    reference(plan['operationId']); reference(plan['hostId'])
    demand(re.fullmatch(r'[a-f0-9]{32}', plan['machineId'] or '') is not None, 'machine_identity')
    target = fields(plan['target'], TARGET_FIELDS)
    demand(target['version'] == 16 and target['cluster'] == 'radarproduction' and target['host'] == '127.0.0.1'
        and target['port'] == 5432 and target['dataDirectory'] == '/var/lib/postgresql/16/radarproduction'
        and target['configDirectory'] == '/etc/postgresql/16/radarproduction'
        and target['socketDirectory'] == '/var/run/postgresql', 'target_identity')
    for key in ('database', 'schema', 'migratorRole'):
        identifier(plan[key])
    demand(plan['database'] == 'address_radar', 'database_identity')
    demand(type(plan['generation']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', plan['generation']), 'generation')
    roles = fields(plan['serviceRoles'], SERVICES)
    role_names = [plan['migratorRole']] + [identifier(roles[s]) for s in SERVICES]
    demand(len(set(role_names)) == 7, 'role_collision')
    resources = fields(plan['resources'], RESOURCE_FIELDS)
    pools = fields(resources['pools'], SERVICES)
    runtime_connections = 0
    for service in SERVICES:
        pool = fields(pools[service], ('instances', 'maximumConnections'))
        runtime_connections += integer(integer(pool['instances']) * integer(pool['maximumConnections'], maximum=64))
    for key in RESOURCE_FIELDS:
        if key != 'pools':
            integer(resources[key], minimum=0 if key in ('maximumPendingOperations', 'otherHostConnections') else 1)
    integer(resources['maximumPendingOperations'], 0, 10000)
    integer(resources['workMemKb'], 64, 1048576)
    demand(resources['lockTimeoutMs'] <= resources['statementTimeoutMs'], 'timeout_order')
    # Match JSON.stringify(validatedResources(...)) ordering in the existing TypeScript planner.
    normalized = {'pools': {s: {'instances': pools[s]['instances'], 'maximumConnections': pools[s]['maximumConnections']} for s in SERVICES}}
    normalized.update({key: resources[key] for key in RESOURCE_FIELDS if key != 'pools'})
    fingerprint = digest(json.dumps(normalized, separators=(',', ':'), ensure_ascii=False).encode())
    database_limit = runtime_connections + resources['migrationConnections'] + resources['operatorConnections'] + resources['backupConnections']
    demand(database_limit + resources['postgresReservedConnections'] + resources['otherHostConnections'] <= resources['serverMaximumConnections'], 'connection_budget')
    capacity = plan['capacity']
    if capacity is not None:
        fields(capacity, CAPACITY_FIELDS)
        demand(capacity['status'] == 'measured' and capacity['hostId'] == plan['hostId'], 'capacity_identity')
        reference(capacity['measurementRef'])
        demand(capacity['resourcePolicyFingerprint'] == fingerprint, 'capacity_policy')
        measured, expires = timestamp(capacity['measuredAt']), timestamp(capacity['validUntil'])
        demand(measured <= now_ms < expires and now_ms - measured <= resources['maximumMeasurementAgeMs'], 'capacity_age')
        demand(byte_count(capacity['availableRamBytes']) >= byte_count(capacity['measuredPeakRamBytes']) + byte_count(capacity['ramMarginBytes']), 'ram_capacity')
        required_disk = sum(byte_count(capacity[key], zero=key in ('measuredPeakWalBytes', 'measuredPeakTempBytes'))
            for key in ('measuredPeakDiskBytes', 'measuredPeakWalBytes', 'measuredPeakTempBytes', 'diskMarginBytes'))
        demand(byte_count(capacity['availableDiskBytes']) >= required_disk, 'disk_capacity')
    settings = fields(plan['settings'], SETTINGS_FIELDS)
    for key in SETTINGS_FIELDS:
        integer(settings[key], minimum=0 if key in ('superuserReservedConnections', 'reservedConnections') else 1)
    demand(settings['superuserReservedConnections'] + settings['reservedConnections'] == resources['postgresReservedConnections'], 'reserved_budget')
    guard = fields(plan['emptyTargetGuard'], GUARD_FIELDS)
    byte_count(guard['minimumAvailableMemoryBytes']); byte_count(guard['minimumFreeDiskBytes'])
    demand(type(guard['maximumMemoryPsiAvg10']) in (int, float) and math.isfinite(guard['maximumMemoryPsiAvg10'])
        and guard['maximumMemoryPsiAvg10'] >= 0, 'memory_pressure_guard')
    tools = fields(plan['tools'], TOOLS)
    for tool in tools.values():
        fields(tool, ('path', 'sha256'))
        demand(type(tool['path']) is str and tool['path'].startswith('/') and '..' not in Path(tool['path']).parts, 'tool_path')
        demand(type(tool['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', tool['sha256']), 'tool_pin')
    for key, spec in fields(plan['ownership'], OWNERSHIP_FIELDS).items():
        fields(spec, ('uid', 'gid', 'mode'))
        integer(spec['uid'], 0); integer(spec['gid'], 0); integer(spec['mode'], 0, 0o777)
        demand(not spec['mode'] & 0o022 and (key not in ('data', 'config') or spec['mode'] == 0o700), 'ownership_policy')
    demand(plan['ownership']['generatedConfig']['uid'] == 0 and plan['ownership']['generatedConfig']['gid'] == 0, 'generated_owner')
    ancestors = fields(plan['configAncestors'], ('/', '/etc', '/etc/postgresql', '/etc/postgresql/16'))
    for pin in ancestors.values():
        fields(pin, ('uid', 'gid', 'mode', 'device', 'inode'))
        integer(pin['uid'], 0); integer(pin['gid'], 0); integer(pin['mode'], 0, 0o777)
        byte_count(pin['device'], zero=True); byte_count(pin['inode'])
        demand(not pin['mode'] & 0o022, 'config_ancestor_pin')
        demand((pin['uid'], pin['gid']) in ((0, 0), (110, 114)), 'config_ancestor_authority')
    demand(all(ancestors[path]['uid'] == 0 and ancestors[path]['gid'] == 0 for path in ('/', '/etc')), 'config_ancestor_authority')
    unit = fields(plan['startupUnit'], UNIT_FIELDS)
    demand(type(unit['dropIns']) is list, 'startup_unit_pin')
    for spec in [{'path': unit['fragmentPath'], 'sha256': unit['fragmentSha256']}, *unit['dropIns']]:
        fields(spec, ('path', 'sha256'))
        demand(type(spec['path']) is str and spec['path'].startswith('/') and '..' not in Path(spec['path']).parts
            and type(spec['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', spec['sha256']), 'startup_unit_pin')
    demand(len({spec['path'] for spec in unit['dropIns']}) == len(unit['dropIns']), 'startup_unit_pin')
    demand(all(type(unit[k]) is str for k in ('execStart', 'user', 'group', 'environmentFiles')) and unit['execStart'], 'startup_unit_pin')
    static_exec_start(unit['execStart'])
    integer(plan['stageTimeoutSeconds'], maximum=180)
    integer(plan['operationTimeoutSeconds'], maximum=900)
    demand(plan['stageTimeoutSeconds'] <= plan['operationTimeoutSeconds'], 'operation_budget')
    return {'plan': plan, 'planSha256': digest(encoded(plan)), 'resourcePolicyFingerprint': fingerprint,
        'databaseConnectionLimit': database_limit, 'roles': role_names, 'fullCapacityProved': False}

def secure_stat(path, owner_uid, mode, directory=False):
    info = path.lstat()
    demand((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        and info.st_uid == owner_uid and stat.S_IMODE(info.st_mode) == mode
        and (directory or info.st_nlink == 1), 'unsafe_private_path')
    return info

class PrivateStorage:
    def __init__(self, path, owner_uid=0):
        self.path, self.uid = Path(path), owner_uid
        demand(self.path.is_absolute() and '..' not in self.path.parts and len(self.path.parts) > 1, 'private_path')
        self.chain = []; self.fds = []; self.identities = {}
        try:
            parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.fds.append(parent)
            for index, name in enumerate(self.path.parts[1:]):
                self._ancestor(os.fstat(parent))
                final = index == len(self.path.parts) - 2
                created = False
                if final:
                    try:
                        os.stat(name, dir_fd=parent, follow_symlinks=False)
                    except FileNotFoundError:
                        self._binding()
                        os.mkdir(name, 0o700, dir_fd=parent)
                        created = True
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                demand(stat.S_ISDIR(before.st_mode), 'unsafe_private_path')
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                self.fds.append(child)
                info = os.fstat(child)
                demand(self._inode(before) == self._inode(info), 'private_directory_changed')
                self.chain.append((parent, name, child, self._inode(info)))
                if final:
                    demand(info.st_uid == self.uid, 'unsafe_private_path')
                    self._binding()
                    if created:
                        os.fchmod(child, 0o700)
                    demand(stat.S_IMODE(os.fstat(child).st_mode) == 0o700, 'unsafe_private_path')
                else:
                    self._ancestor(info)
                parent = child
            self.fd = parent
            self._binding()
            demand(set(os.listdir(self.fd)) <= {'journal.json', 'secrets.json', 'operation.lock'}, 'unknown_private_objects')
        except BaseException:
            self.close()
            raise

    @staticmethod
    def _inode(info):
        return info.st_dev, info.st_ino

    def _ancestor(self, info):
        demand(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, self.uid) and
            (not info.st_mode & 0o022 or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)), 'unsafe_private_ancestor')

    def _binding(self):
        if self.fds:
            self._ancestor(os.fstat(self.fds[0]))
        for index, (parent, name, child, identity) in enumerate(self.chain):
            demand(self._inode(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity
                == self._inode(os.fstat(child)), 'private_directory_changed')
            if index < len(self.path.parts) - 2:
                self._ancestor(os.fstat(child))
            else:
                info = os.fstat(child)
                demand(info.st_uid == self.uid and not info.st_mode & 0o077, 'unsafe_private_path')

    def close(self):
        for fd in reversed(getattr(self, 'fds', [])):
            os.close(fd)
        self.fds = []

    def __del__(self):
        self.close()

    def _entry(self, name):
        demand(name in ('journal.json', 'secrets.json', 'operation.lock'), 'private_name')
        self._binding()
        try:
            info = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            demand(name not in self.identities, 'private_file_changed')
            return None
        demand(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe_private_path')
        identity = self._inode(info)
        demand(name not in self.identities or self.identities[name] == identity, 'private_file_changed')
        self.identities[name] = identity
        return info

    def has(self, name):
        return self._entry(name) is not None

    def identity(self, name):
        info = self._entry(name)
        demand(info is not None, 'private_file_missing')
        return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'device': str(info.st_dev), 'inode': str(info.st_ino), 'nlink': info.st_nlink,
            'size': str(info.st_size), 'ctimeNs': str(info.st_ctime_ns)}

    def read(self, name):
        expected = self._entry(name)
        demand(expected is not None, 'private_file_missing')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
        try:
            before = os.fstat(fd)
            demand(self._inode(before) == self._inode(expected) and before.st_uid == self.uid
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1 and before.st_size <= 1024 ** 2, 'private_file_identity')
            body = b''
            while len(body) <= 1024 ** 2:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                body += chunk
            after = os.fstat(fd)
            demand((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and len(body) == before.st_size, 'private_file_changed')
            self._binding()
            demand(self._inode(self._entry(name)) == self._inode(before), 'private_file_changed')
            return strict_json(body)
        finally:
            os.close(fd)

    def write(self, name, value, replace=False):
        existing = self._entry(name)
        if existing is not None:
            demand(replace, 'private_file_exists')
        temporary = name + '-' + secrets.token_hex(8) + '.next'
        self._binding()
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        info = os.fstat(fd)
        demand(info.st_uid == self.uid and info.st_nlink == 1, 'private_file_identity')
        os.fchmod(fd, 0o600)
        try:
            body = encoded(value)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(body); stream.flush(); os.fsync(stream.fileno())
            self._binding()
            current = self._entry(name)
            demand((None if current is None else self._inode(current)) ==
                (None if existing is None else self._inode(existing)), 'private_file_changed')
            os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            self.identities[name] = self._inode(info)
            os.fsync(self.fd)
            self._binding()
            self._entry(name)
        except BaseException:
            # Preserve private remnants for explicit reconciliation; never delete production objects.
            raise

    def load(self):
        return self.read('journal.json') if self.has('journal.json') else None

    def save(self, value):
        self.write('journal.json', value, replace=True)

    def ensure_secrets(self, roles):
        if self.has('secrets.json'):
            value = self.read('secrets.json')
            demand(type(value) is dict and set(value) == set(roles)
                and all(type(secret) is str and re.fullmatch(r'[A-Za-z0-9_-]{43}', secret) for secret in value.values()), 'secret_binding')
        else:
            value = {role: secrets.token_urlsafe(32) for role in roles}
            self.write('secrets.json', value)
        info = self._entry('secrets.json')
        # This private receipt stays in the root-only journal, never in public output.
        return {'device': info.st_dev, 'inode': info.st_ino, 'contentSha256': digest(encoded(value))}

    @contextmanager
    def lock(self):
        existing = self._entry('operation.lock')
        self._binding()
        fd = os.open('operation.lock', os.O_RDWR | os.O_NOFOLLOW |
            (0 if existing is not None else os.O_CREAT | os.O_EXCL), 0o600, dir_fd=self.fd)
        try:
            info = os.fstat(fd)
            demand(info.st_nlink == 1 and info.st_uid == self.uid and
                (existing is None or self._inode(existing) == self._inode(info)), 'lock_identity')
            self._binding()
            if existing is None:
                os.fchmod(fd, 0o600)
            self.identities['operation.lock'] = self._inode(info)
            self._entry('operation.lock')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('operation_busy') from None
            self._binding()
            yield
        finally:
            os.close(fd)

def prepare_target(plan, adapter, storage, now_ms):
    prepared = validate_plan(plan, now_ms)
    with storage.lock() if hasattr(storage, 'lock') else nullcontext():
        journal = storage.load()
        observation = adapter.observe(prepared)
        demand(observation['machineId'] == prepared['plan']['machineId'] and not observation['foreignObjects'], 'unknown_host_or_objects')
        if journal is None:
            demand(not observation['stages'] and observation['portAvailable'], 'existing_target')
            if hasattr(storage, 'has'):
                demand(not storage.has('secrets.json'), 'unowned_secrets')
            journal = {'version': 1, 'operationId': plan['operationId'], 'planSha256': prepared['planSha256'],
                'machineId': observation['machineId'], 'acknowledged': {}, 'pending': None, 'secretsPrepared': False, 'secretIdentity': None}
            storage.save(journal)
        demand(journal['planSha256'] == prepared['planSha256'] and journal['machineId'] == observation['machineId']
            and journal['operationId'] == plan['operationId'] and journal['pending'] is None, 'partial_or_changed_operation')
        demand(observation['stages'] == journal['acknowledged'], 'ack_identity_changed')
        for stage in STAGES:
            if stage in journal['acknowledged']:
                continue
            observation = adapter.observe(prepared)
            demand(observation['machineId'] == journal['machineId'] and not observation['foreignObjects']
                and observation['stages'] == journal['acknowledged'], 'prestage_identity_changed')
            journal['pending'] = stage
            storage.save(journal)
            try:
                receipt = adapter.apply(stage, prepared)
                measured = adapter.observe(prepared)
                demand(type(receipt) is dict and receipt.get('planSha256') == prepared['planSha256']
                    and measured['machineId'] == journal['machineId'] and not measured['foreignObjects']
                    and measured['stages'] == {**journal['acknowledged'], stage: receipt}, 'stage_ack_unverified')
                journal['acknowledged'][stage] = receipt
                journal['pending'] = None
                storage.save(journal)
            except Exception:
                raise Refused('stage_failed_preserved') from None
        if not journal['secretsPrepared']:
            journal['pending'] = 'secrets'
            storage.save(journal)
            try:
                journal['secretIdentity'] = storage.ensure_secrets(prepared['roles'])
                journal['secretsPrepared'] = True; journal['pending'] = None
                storage.save(journal)
            except Exception:
                raise Refused('secret_stage_failed_preserved') from None
        else:
            if hasattr(storage, 'has'):
                demand(storage.has('secrets.json'), 'ack_secret_missing')
            demand(storage.ensure_secrets(prepared['roles']) == journal['secretIdentity'], 'ack_secret_changed')
        return {'status': 'prepared', 'planSha256': prepared['planSha256'], 'productionMigrationReady': False,
            'fullCapacityProved': False, 'schemaDeferred': True, 'credentialsInstalled': False, 'rolesLoginEnabled': False,
            'backendChanged': False, 'servicesChanged': False, 'deliveryEnabled': False, 'fomoEnabled': False,
            'dataImported': False, 'trustIssued': False}

ORIGINAL_RECOVERY_SOURCE_SHA256 = 'd70ab3c0ef4d89b12f40296418cb4b7a83bad561c7ec544d5123f1bf2d308f96'
RECOVERY_MAXIMUM_DIRECTORY_DEPTH = 32

def bounded_entry_names(directory, maximum, remaining, decimal_only=False):
    names = []
    remaining()
    with os.scandir(directory) as entries:
        for entry in entries:
            remaining()
            if decimal_only and not entry.name.isdecimal():
                continue
            demand(len(names) < maximum, 'recovery_inventory_budget' if not decimal_only else 'recovery_process_budget')
            names.append(entry.name)
    remaining()
    return sorted(names)

def recovery_evidence_schema():
    """No default provenance authenticator: protected bytes alone do not prove history."""
    return {
        'version': 1, 'originalPlanSha256': None, 'originalSourceSha256': ORIGINAL_RECOVERY_SOURCE_SHA256,
        'currentPlanSha256': None, 'originalJournalSha256': None,
        'originalJournalIdentity': {'uid': None, 'gid': None, 'mode': None, 'device': None,
            'inode': None, 'nlink': None, 'size': None, 'ctimeNs': None},
        'systemIdentifier': None, 'controlSha256': None,
        'inventory': {'data': None, 'config': None},
        'inventoryLimits': {'maximumEntries': None, 'maximumBytes': None},
        'recoveryAuthority': {'kind': None, 'principal': None, 'approvalRef': None},
        'originalArtifacts': {
            'plan': {'path': None, 'sha256': None, 'uid': None, 'gid': None, 'mode': None, 'device': None, 'inode': None},
            'source': {'path': None, 'sha256': ORIGINAL_RECOVERY_SOURCE_SHA256, 'uid': None, 'gid': None, 'mode': None, 'device': None, 'inode': None}},
        'provenance': {
            'preflight': {'bytesSha256': None}, 'attempt': {'bytesSha256': None}},
    }

def recover_pending_cluster(original_plan, current_plan, evidence, provenance_bytes, verify_provenance,
        adapter, storage, now_ms):
    """Explicit operator recovery only; does not replay creation or infer historical absence.

    verify_provenance is a trusted parent port, either authenticating original execution
    evidence or enforcing explicitly reviewed recovery authority over controller transcripts.
    A caller-authored flag, digest allowlist or newly minted approval is not an implementation.
    This API is intentionally not wired to ordinary apply or an untrusted CLI plugin.
    """
    evidence = json.loads(encoded(evidence))
    provenance_bytes = {key: bytes(body) for key, body in provenance_bytes.items()}
    fields(evidence, recovery_evidence_schema())
    demand(evidence['version'] == 1 and callable(verify_provenance), 'recovery_provenance_required')
    # Validate the original plan with the old exact field/tool set; do not weaken current validation.
    original = json.loads(encoded(original_plan))
    original_sha = digest(encoded(original))
    current = validate_plan(current_plan, now_ms)
    expected_current = json.loads(encoded(current['plan']))
    expected_current.pop('configAncestors')
    demand(original == expected_current and original_sha == evidence['originalPlanSha256']
        and current['planSha256'] == evidence['currentPlanSha256']
        and evidence['originalSourceSha256'] == ORIGINAL_RECOVERY_SOURCE_SHA256, 'recovery_plan_binding')
    fields(evidence['originalArtifacts'], ('plan', 'source'))
    for key, artifact in evidence['originalArtifacts'].items():
        body = adapter.read_recovery_artifact(artifact)
        if key == 'plan':
            demand(strict_json(body) == original, 'recovery_original_artifact')
        else:
            demand(artifact['sha256'] == ORIGINAL_RECOVERY_SOURCE_SHA256, 'recovery_original_artifact')
    fields(evidence['provenance'], ('preflight', 'attempt'))
    fields(provenance_bytes, ('preflight', 'attempt'))
    for key, body in provenance_bytes.items():
        fields(evidence['provenance'][key], ('bytesSha256',))
        demand(type(body) is bytes and 0 < len(body) <= 1024 ** 2
            and digest(body) == evidence['provenance'][key]['bytesSha256'], 'recovery_provenance_bytes')
    fields(evidence['inventory'], ('data', 'config'))
    authority = fields(evidence['recoveryAuthority'], ('kind', 'principal', 'approvalRef'))
    demand(authority['kind'] in ('independently-authenticated-original-execution', 'operator-reviewed-controller-transcript'), 'recovery_authority_kind')
    reference(authority['principal']); reference(authority['approvalRef'])
    journal_pin = fields(evidence['originalJournalIdentity'], ('uid', 'gid', 'mode', 'device', 'inode', 'nlink', 'size', 'ctimeNs'))
    demand(journal_pin['uid'] == 0 and journal_pin['mode'] == 0o600 and journal_pin['nlink'] == 1, 'recovery_journal_authority')
    limits = fields(evidence['inventoryLimits'], ('maximumEntries', 'maximumBytes'))
    integer(limits['maximumEntries'], maximum=20000); byte_count(limits['maximumBytes'])
    demand(int(limits['maximumBytes']) <= 4 * 1024 ** 3, 'recovery_inventory_budget')
    demand(type(evidence['systemIdentifier']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', evidence['systemIdentifier']), 'recovery_system_identity')
    context = {'operationId': original['operationId'], 'machineId': original['machineId'],
        'originalPlanSha256': original_sha, 'originalSourceSha256': ORIGINAL_RECOVERY_SOURCE_SHA256,
        'originalJournalSha256': evidence['originalJournalSha256'], 'currentPlanSha256': current['planSha256'],
        'originalJournalIdentity': journal_pin,
        'target': original['target'], 'systemIdentifier': evidence['systemIdentifier'],
        'inventorySha256': digest(encoded(evidence['inventory'])),
        'preflightSha256': digest(provenance_bytes['preflight']), 'attemptSha256': digest(provenance_bytes['attempt'])}
    context['recoveryAuthority'] = authority
    # Controller review is a distinct authority, never relabeled as durable historical proof.
    authenticated = verify_provenance(dict(provenance_bytes), json.loads(encoded(context)))
    review_sha = None
    if authority['kind'] == 'operator-reviewed-controller-transcript':
        fields(authenticated, ('binding', 'reviewSha256'))
        review_sha = authenticated['reviewSha256']
        demand(type(review_sha) is str and re.fullmatch(r'[a-f0-9]{64}', review_sha), 'recovery_review_binding')
        authenticated = authenticated['binding']
    demand(type(authenticated) is dict and authenticated == context, 'recovery_provenance_unverified')
    with storage.lock():
        journal = storage.load()
        demand(storage.identity('journal.json') == journal_pin, 'recovery_journal_identity')
        demand(type(journal) is dict and digest(encoded(journal)) == evidence['originalJournalSha256']
            and journal['pending'] == 'cluster' and journal['acknowledged'] == {}
            and journal['planSha256'] == original_sha and journal['operationId'] == original['operationId']
            and journal['machineId'] == original['machineId'] and journal['secretsPrepared'] is False
            and journal['secretIdentity'] is None, 'recovery_pending_binding')
        demand(not storage.has('secrets.json'), 'recovery_unexpected_secrets')
        adapter.bind_recovery_source(evidence['originalArtifacts']['source']['path'])
        measured = adapter.measure_recovery_target(limits)
        demand(measured == {'inventory': evidence['inventory'], 'systemIdentifier': evidence['systemIdentifier'],
            'controlSha256': evidence['controlSha256']}, 'recovery_target_changed')
        recovery_sha = digest(encoded(evidence))
        # Durable intent before any target mutation. Interrupted recovery is never auto-replayed.
        journal['pending'] = 'cluster-reconciliation'
        journal['recovery'] = {'evidenceSha256': recovery_sha, 'binding': context, 'status': 'pending'}
        if review_sha is not None:
            journal['recovery']['operatorReviewSha256'] = review_sha
            journal['recovery']['controllerTranscriptOrigin'] = 'posthoc-controller-history-copy'
        storage.save(journal)
        try:
            demand(adapter.measure_recovery_target(limits) == measured, 'recovery_target_changed')
            adapter.protect_created_config()
            after = adapter.measure_recovery_target(limits)
            allowed_after = json.loads(encoded(measured))
            # fchmod/fsync may change only the config root mode/ctime, not any content or child identity.
            root = allowed_after['inventory']['config'][0]
            actual_root = after['inventory']['config'][0]
            root['mode'] = current['plan']['ownership']['config']['mode']
            root['ctimeNs'] = actual_root['ctimeNs']
            demand(after == allowed_after, 'recovery_unexpected_mutation')
            observed = adapter.observe(current)
            demand(observed['machineId'] == original['machineId'] and not observed['foreignObjects']
                and observed['portAvailable'] and set(observed['stages']) == {'cluster'}
                and observed['stages']['cluster']['systemIdentifier'] == evidence['systemIdentifier'], 'recovery_ack_unverified')
            journal['planSha256'] = current['planSha256']
            journal['acknowledged'] = observed['stages']
            journal['pending'] = None
            journal['recovery']['status'] = 'acknowledged'
            journal['recovery']['postInventorySha256'] = digest(encoded(after['inventory']))
            storage.save(journal)
        except Exception:
            raise Refused('recovery_failed_preserved') from None
    return {'status': 'cluster_reconciled', 'planSha256': current['planSha256'], 'evidenceSha256': recovery_sha,
        'recoveryAuthorityKind': authority['kind'], 'historicalDurableProofClaimed': authority['kind'] != 'operator-reviewed-controller-transcript',
        'productionMigrationReady': False, 'fullCapacityProved': False, 'dataImported': False, 'trustIssued': False}

def operator_recovery_review_template():
    return {'version': 1, 'kind': 'operator-reviewed-pending-cluster-recovery',
        'decision': 'normalize-config-and-acknowledge-existing-cluster-only',
        'controllerTranscriptOrigin': 'posthoc-controller-history-copy',
        'historicalDurableProofClaimed': False,
        'evidence': recovery_evidence_schema(),
        'controllerTranscripts': {'preflight': None, 'attempt': None},
        'reviewedObservations': {'originalPreflightReportedAbsent': True, 'singleApplyAttemptReported': True,
            'clusterStopped': True, 'noTargetListener': True, 'currentMutationProcessesAbsent': True,
            'originalApplyReportedReturned': True,
            'targetAttributedToOriginalAttempt': True},
        'scope': {'recreate': False, 'drop': False, 'start': False, 'dataImport': False, 'businessActivation': False}}

class OperatorRecoveryReview:
    """Root operator trust boundary, not a signature or an independent production reviewer.

    The controller must obtain human/operator review of the exact immutable bytes and pass
    its digest explicitly. Root protection alone does not prove approval or remote events.
    """
    def __init__(self, adapter, review_pin, approved_sha):
        demand(type(approved_sha) is str and re.fullmatch(r'[a-f0-9]{64}', approved_sha)
            and review_pin['sha256'] == approved_sha and review_pin['uid'] == 0 and review_pin['mode'] == 0o600, 'explicit_recovery_review_required')
        self.adapter = adapter; self.pin = json.loads(encoded(review_pin)); self.sha = approved_sha
        self.body = adapter.read_recovery_artifact(self.pin)
        demand(digest(self.body) == self.sha, 'recovery_review_changed')
        self.review = strict_json(self.body)
        template = operator_recovery_review_template()
        fields(self.review, template)
        for key in ('version', 'kind', 'decision', 'controllerTranscriptOrigin', 'historicalDurableProofClaimed', 'reviewedObservations', 'scope'):
            demand(encoded(self.review[key]) == encoded(template[key]), 'recovery_review_scope')
        demand(self.review['evidence']['recoveryAuthority']['kind'] == 'operator-reviewed-controller-transcript', 'recovery_review_authority')
        fields(self.review['controllerTranscripts'], ('preflight', 'attempt'))
        self.transcripts = {}
        for key, pin in self.review['controllerTranscripts'].items():
            demand(pin['uid'] == 0 and pin['mode'] == 0o600, 'recovery_transcript_protection')
            self.transcripts[key] = adapter.read_recovery_artifact(pin)
            demand(digest(self.transcripts[key]) == pin['sha256'] ==
                self.review['evidence']['provenance'][key]['bytesSha256'], 'recovery_transcript_binding')

    def verify(self, bytes_by_kind, context):
        demand(self.adapter.read_recovery_artifact(self.pin) == self.body, 'recovery_review_changed')
        for key, pin in self.review['controllerTranscripts'].items():
            demand(self.adapter.read_recovery_artifact(pin) == self.transcripts[key] == bytes_by_kind[key], 'recovery_transcript_changed')
        evidence = self.review['evidence']
        original = strict_json(self.adapter.read_recovery_artifact(evidence['originalArtifacts']['plan']))
        expected = {'operationId': original['operationId'], 'machineId': original['machineId'],
            'originalPlanSha256': evidence['originalPlanSha256'], 'originalSourceSha256': evidence['originalSourceSha256'],
            'originalJournalSha256': evidence['originalJournalSha256'], 'originalJournalIdentity': evidence['originalJournalIdentity'],
            'currentPlanSha256': evidence['currentPlanSha256'], 'target': original['target'],
            'systemIdentifier': evidence['systemIdentifier'], 'inventorySha256': digest(encoded(evidence['inventory'])),
            'preflightSha256': evidence['provenance']['preflight']['bytesSha256'],
            'attemptSha256': evidence['provenance']['attempt']['bytesSha256'], 'recoveryAuthority': evidence['recoveryAuthority']}
        demand(context == expected, 'recovery_review_context')
        return {'binding': expected, 'reviewSha256': self.sha}

def execute_operator_recovery(current_plan, review_pin, approved_review_sha, storage, adapter, now_ms):
    review = OperatorRecoveryReview(adapter, review_pin, approved_review_sha)
    evidence = review.review['evidence']
    original = strict_json(adapter.read_recovery_artifact(evidence['originalArtifacts']['plan']))
    return recover_pending_cluster(original, current_plan, evidence, review.transcripts,
        review.verify, adapter, storage, now_ms)

def quote(name):
    return '"' + identifier(name) + '"'

class NativeAdapter:
    """Only explicit apply/preflight instantiate this adapter. It never reads generated secrets."""
    def __init__(self, prepared):
        demand(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux_root_required')
        self.p = prepared
        self.deadline = time.monotonic() + prepared['plan']['operationTimeoutSeconds']

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        demand(remaining > 0, 'operation_deadline')
        return remaining

    def pinned_file(self, spec):
        path = Path(spec['path'])
        for parent in path.parents:
            info = parent.lstat()
            demand(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'tool_ancestor')
        info = path.lstat()
        demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
            and digest(path.read_bytes()) == spec['sha256'], 'tool_identity')
        return str(path)

    def command(self, tool, arguments, body=None, postgres=False):
        self.remaining()
        plan = self.p['plan']
        path = self.pinned_file(plan['tools'][tool])
        argv = [str(path), *arguments]
        if postgres:
            argv = [self.pinned_file(plan['tools']['runuser']), '-u', 'postgres', '--', *argv]
        remaining = self.remaining()
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, start_new_session=True)
        try:
            output, _ = process.communicate(body, timeout=min(plan['stageTimeoutSeconds'], remaining))
        except BaseException as error:
            os.killpg(process.pid, signal.SIGKILL)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                raise Refused('child_closure_unknown') from None
            raise Refused('stage_deadline' if isinstance(error, subprocess.TimeoutExpired) else 'host_command_interrupted') from None
        demand(process.returncode == 0 and len(output) <= 1024 ** 2, 'host_command_failed')
        return output

    def sql(self, text, database='postgres'):
        t = self.p['plan']['target']
        return self.command('psql', ['-X', '--no-password', '-h', t['socketDirectory'], '-p', str(t['port']),
            '-d', database, '-qAt', '-v', 'ON_ERROR_STOP=1'], text.encode(), postgres=True)

    def resource_guard(self):
        demand(time.monotonic() < self.deadline, 'operation_deadline')
        plan = self.p['plan']
        demand(Path('/proc/1/comm').read_text().strip() == 'systemd' and Path('/sys/fs/cgroup/cgroup.controllers').is_file(), 'host_runtime')
        match = re.search(r'^MemAvailable:\s+(\d+) kB$', Path('/proc/meminfo').read_text(), re.M)
        pressure = re.search(r'^some avg10=(\d+(?:\.\d+)?) ', Path('/proc/pressure/memory').read_text(), re.M)
        demand(match and pressure, 'resource_measurement_unknown')
        guard = plan['emptyTargetGuard']
        demand(int(match[1]) * 1024 >= int(guard['minimumAvailableMemoryBytes'])
            and float(pressure[1]) <= guard['maximumMemoryPsiAvg10'], 'empty_target_memory_guard')
        volume = Path(plan['target']['dataDirectory'])
        while not volume.exists():
            volume = volume.parent
        demand(shutil.disk_usage(volume).free >= int(guard['minimumFreeDiskBytes']), 'empty_target_disk_guard')

    def configuration(self):
        plan = self.p['plan']; r = plan['resources']; s = plan['settings']; t = plan['target']
        return ('# Address Radar empty-target preparation; no credentials.\n'
            + "listen_addresses = '127.0.0.1'\nport = 5432\n"
            + f"unix_socket_directories = '{t['socketDirectory']}'\n"
            + f"max_connections = {r['serverMaximumConnections']}\n"
            + f"superuser_reserved_connections = {s['superuserReservedConnections']}\nreserved_connections = {s['reservedConnections']}\n"
            + f"shared_buffers = '{s['sharedBuffersKb']}kB'\nwork_mem = '{r['workMemKb']}kB'\n"
            + f"maintenance_work_mem = '{s['maintenanceWorkMemKb']}kB'\nmax_wal_size = '{s['maxWalSizeMb']}MB'\n").encode()

    @staticmethod
    def hba_configuration():
        # No runtime credentials or TCP authentication are enabled by preparation.
        return b'local all postgres peer\nlocal all all reject\nhost all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n'

    def owned_stamp(self, path, key, directory=False, dir_fd=None):
        info = path.lstat() if dir_fd is None else os.stat(path, dir_fd=dir_fd, follow_symlinks=False)
        expected = self.p['plan']['ownership'][key]
        demand((stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
            and info.st_uid == expected['uid'] and info.st_gid == expected['gid']
            and stat.S_IMODE(info.st_mode) == expected['mode'] and (directory or info.st_nlink == 1), 'target_ownership_changed')
        return {'device': info.st_dev, 'inode': info.st_ino, 'uid': info.st_uid,
            'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}

    def instance_collisions(self):
        name = 'postgresql@16-radarproduction.service'
        return any((root / suffix).exists() or (root / suffix).is_symlink()
            for root in map(Path, ('/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'))
            for suffix in (name, name + '.d', name + '.wants', name + '.requires'))

    def startup_identity(self):
        demand(not self.instance_collisions(), 'unknown_instance_override')
        expected = self.p['plan']['startupUnit']
        specs = [{'path': expected['fragmentPath'], 'sha256': expected['fragmentSha256']}, *expected['dropIns']]
        for spec in specs:
            self.pinned_file(spec)
        names = ('LoadState', 'FragmentPath', 'DropInPaths', 'ExecStart', 'User', 'Group', 'EnvironmentFiles')
        body = self.command('systemctl', ['show', 'postgresql@16-radarproduction.service',
            *['--property=' + name for name in names]]).decode()
        actual = dict(line.split('=', 1) for line in body.splitlines() if '=' in line)
        if 'EnvironmentFiles' not in actual:
            demand(expected['environmentFiles'] == '', 'startup_unit_changed')
            # An omitted show property is not evidence of an empty list. Authenticate
            # its native type/value through the same fully pinned command pipeline.
            # This exact preparation unit has a deterministic systemd-escaped path.
            # Direct typed access avoids GetUnit racing GC of an inactive unit;
            # it neither starts the service nor leaves a RefUnit reference behind.
            unit_path = '/org/freedesktop/systemd1/unit/postgresql_4016_2dradarproduction_2eservice'
            environment_bytes = self.command('busctl', ['--system', '--json=short', 'get-property', 'org.freedesktop.systemd1',
                unit_path, 'org.freedesktop.systemd1.Service', 'EnvironmentFiles'])
            try:
                environment = strict_json(environment_bytes)
            except (ValueError, UnicodeError):
                raise Refused('startup_environment_unverified') from None
            demand(type(environment) is dict and environment == {'type': 'a(sb)', 'data': []}, 'startup_environment_unverified')
            actual['EnvironmentFiles'] = ''
        demand('ExecStart' in actual, 'startup_exec_format')
        actual['ExecStart'] = static_exec_start(actual['ExecStart'])
        demand(actual == {'LoadState': 'loaded', 'FragmentPath': expected['fragmentPath'],
            'DropInPaths': ' '.join(spec['path'] for spec in expected['dropIns']), 'ExecStart': static_exec_start(expected['execStart']),
            'User': expected['user'], 'Group': expected['group'], 'EnvironmentFiles': expected['environmentFiles']}, 'startup_unit_changed')
        return {'effective': actual, 'files': specs}

    def config_ancestor_identity(self):
        measured = {}
        for path, pin in self.p['plan']['configAncestors'].items():
            info = Path(path).lstat()
            actual = {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                'device': str(info.st_dev), 'inode': str(info.st_ino)}
            demand(stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o022 and actual == pin, 'config_ancestor_changed')
            measured[path] = actual
        return measured

    @contextmanager
    def bound_config_directory(self):
        self.config_ancestor_identity()
        fds = []; chain = []
        try:
            fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); fds.append(fd)
            root = self.p['plan']['configAncestors']['/']; info = os.fstat(fd)
            demand((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), str(info.st_dev), str(info.st_ino)) ==
                (root['uid'], root['gid'], root['mode'], root['device'], root['inode']), 'config_ancestor_changed')
            for name, absolute in (('etc', '/etc'), ('postgresql', '/etc/postgresql'),
                    ('16', '/etc/postgresql/16'), ('radarproduction', '/etc/postgresql/16/radarproduction')):
                parent = fd
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent); fds.append(fd)
                info = os.fstat(fd)
                if absolute in self.p['plan']['configAncestors']:
                    pin = self.p['plan']['configAncestors'][absolute]
                    demand((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), str(info.st_dev), str(info.st_ino)) ==
                        (pin['uid'], pin['gid'], pin['mode'], pin['device'], pin['inode']), 'config_ancestor_changed')
                else:
                    expected = self.owned_stamp(Path(absolute), 'config', True)
                    demand((info.st_dev, info.st_ino) == (expected['device'], expected['inode']), 'target_ownership_changed')
                chain.append((parent, name, fd, info.st_dev, info.st_ino))
            def binding():
                self.config_ancestor_identity()
                for parent, name, child, device, inode in chain:
                    linked = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    opened = os.fstat(child)
                    demand(stat.S_ISDIR(linked.st_mode) and (linked.st_dev, linked.st_ino) ==
                        (opened.st_dev, opened.st_ino) == (device, inode), 'config_directory_changed')
            binding()
            yield fd, binding
            binding()
        finally:
            for fd in reversed(fds): os.close(fd)

    def read_recovery_artifact(self, pin):
        fields(pin, ('path', 'sha256', 'uid', 'gid', 'mode', 'device', 'inode'))
        demand(pin['uid'] == 0 and type(pin['mode']) is int and not pin['mode'] & 0o022, 'recovery_artifact_authority')
        demand(type(pin['path']) is str and pin['path'].startswith('/') and '..' not in Path(pin['path']).parts
            and type(pin['sha256']) is str and re.fullmatch(r'[a-f0-9]{64}', pin['sha256']), 'recovery_artifact_identity')
        path = Path(pin['path'])
        self.remaining()
        for parent in path.parents:
            self.remaining()
            info = parent.lstat()
            demand(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'tool_ancestor')
        before = path.lstat()
        demand(stat.S_ISREG(before.st_mode), 'recovery_artifact_identity')
        demand(before.st_nlink == 1 and before.st_size <= 1024 ** 2
            and (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), str(before.st_dev), str(before.st_ino)) ==
            (pin['uid'], pin['gid'], pin['mode'], pin['device'], pin['inode']), 'recovery_artifact_identity')
        self.remaining()
        fd = os.open(pin['path'], os.O_RDONLY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            demand((opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink,
                opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
                (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_nlink,
                before.st_size, before.st_mtime_ns, before.st_ctime_ns), 'recovery_artifact_identity')
            body = b''
            while len(body) <= 1024 ** 2:
                self.remaining()
                piece = os.read(fd, min(65536, 1024 ** 2 + 1 - len(body)))
                if not piece: break
                body += piece
            after = os.fstat(fd)
            linked = path.lstat()
            demand((opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns) and len(body) == opened.st_size
                and (linked.st_dev, linked.st_ino, linked.st_size, linked.st_mtime_ns, linked.st_ctime_ns) ==
                (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                and digest(body) == pin['sha256'], 'recovery_artifact_changed')
            return body
        finally:
            os.close(fd)

    def bind_recovery_source(self, path):
        demand(type(path) is str and path.startswith('/') and '..' not in Path(path).parts, 'recovery_source_path')
        self.recovery_source_path = path

    def assert_recovery_quiescence(self):
        self.remaining()
        plan = self.p['plan']; target = plan['target']
        demand(hasattr(self, 'recovery_source_path'), 'recovery_source_path')
        demand(not (Path(target['dataDirectory']) / 'postmaster.pid').exists()
            and not (Path(target['dataDirectory']) / 'postmaster.pid').is_symlink(), 'recovery_cluster_not_stopped')
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind((target['host'], target['port']))
        except OSError:
            raise Refused('recovery_target_listener_or_bind_unknown') from None
        finally:
            probe.close()
        processes = bounded_entry_names('/proc', 4096, self.remaining, decimal_only=True)
        for name in processes:
            process = Path('/proc') / name
            self.remaining()
            if int(process.name) == os.getpid():
                continue
            try:
                # Never expose argv; use it only to reject active mutation processes.
                before = (process / 'stat').read_bytes()
                fd = os.open(process / 'cmdline', os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    body = os.read(fd, 65537)
                finally:
                    os.close(fd)
                after = (process / 'stat').read_bytes()
            except FileNotFoundError:
                continue
            except OSError:
                raise Refused('recovery_process_visibility_unknown') from None
            demand(len(body) <= 65536, 'recovery_process_visibility_unknown')
            # Detect PID reuse while sampling. A process exit may disappear above;
            # a live but unstable identity requires another separately reviewed observation.
            first = before.rpartition(b') ')[2].split(); last = after.rpartition(b') ')[2].split()
            demand(len(first) > 19 and len(last) > 19 and first[19] == last[19], 'recovery_process_identity_changed')
            tokens = body.split(b'\0')
            markers = {self.recovery_source_path.encode(), target['dataDirectory'].encode(),
                b'16-radarproduction', b'16/radarproduction'}
            demand(not any(token in markers or token.rsplit(b'/', 1)[-1] in (b'pg_createcluster', b'initdb')
                or token.startswith(b'postgres: 16/radarproduction') for token in tokens), 'recovery_mutation_process_present')
        self.remaining()

    def measure_recovery_target(self, limits):
        self.resource_guard(); self.config_ancestor_identity()
        self.assert_recovery_quiescence()
        plan = self.p['plan']; count = 0; total = 0; pending_names = 0
        inventory = {}
        for key, target_key in (('data', 'dataDirectory'), ('config', 'configDirectory')):
            path = Path(plan['target'][target_key])
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            entries = []
            def walk(directory, relative, depth=0):
                nonlocal count, total, pending_names
                self.remaining()
                demand(depth <= RECOVERY_MAXIMUM_DIRECTORY_DEPTH, 'recovery_inventory_depth')
                info = os.fstat(directory)
                def stamp(value, name, kind):
                    return {'path': name, 'kind': kind, 'device': str(value.st_dev), 'inode': str(value.st_ino),
                        'uid': value.st_uid, 'gid': value.st_gid, 'mode': stat.S_IMODE(value.st_mode),
                        'nlink': value.st_nlink, 'size': str(value.st_size), 'mtimeNs': str(value.st_mtime_ns), 'ctimeNs': str(value.st_ctime_ns)}
                count += 1; demand(count <= limits['maximumEntries'], 'recovery_inventory_budget')
                entries.append(stamp(info, relative, 'directory'))
                names = bounded_entry_names(directory, limits['maximumEntries'] - count - pending_names, self.remaining)
                pending_names += len(names)
                for name in names:
                    self.remaining()
                    pending_names -= 1
                    before = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    rel = name if relative == '.' else relative + '/' + name
                    demand(stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode), 'recovery_inventory_type')
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW |
                        (os.O_DIRECTORY if stat.S_ISDIR(before.st_mode) else 0), dir_fd=directory)
                    try:
                        opened = os.fstat(child)
                        demand(stamp(before, rel, 'entry') == stamp(opened, rel, 'entry'), 'recovery_inventory_changed')
                        if stat.S_ISDIR(opened.st_mode):
                            walk(child, rel, depth + 1)
                        else:
                            count += 1; demand(count <= limits['maximumEntries'] and opened.st_nlink == 1, 'recovery_inventory_budget')
                            h = hashlib.sha256(); length = 0
                            while True:
                                self.remaining(); chunk = os.read(child, 65536)
                                if not chunk: break
                                length += len(chunk); total += len(chunk)
                                demand(total <= int(limits['maximumBytes']), 'recovery_inventory_budget'); h.update(chunk)
                            demand(length == opened.st_size, 'recovery_inventory_changed')
                            entries.append({**stamp(opened, rel, 'file'), 'sha256': h.hexdigest()})
                        demand(stamp(opened, rel, 'entry') == stamp(os.fstat(child), rel, 'entry') ==
                            stamp(os.stat(name, dir_fd=directory, follow_symlinks=False), rel, 'entry'), 'recovery_inventory_changed')
                    finally:
                        os.close(child)
                demand(names == bounded_entry_names(directory, len(names), self.remaining) and stamp(info, relative, 'directory') ==
                    stamp(os.fstat(directory), relative, 'directory'), 'recovery_inventory_changed')
            try:
                walk(fd, '.')
                demand((path.lstat().st_dev, path.lstat().st_ino) == (os.fstat(fd).st_dev, os.fstat(fd).st_ino), 'recovery_inventory_changed')
            finally:
                os.close(fd)
            inventory[key] = entries
        demand(not any(row['path'] == 'postmaster.pid' for row in inventory['data']), 'recovery_cluster_not_stopped')
        control = self.command('pg_controldata', [plan['target']['dataDirectory']], postgres=True)
        text = control.decode(); match = re.search(r'^Database system identifier:\s+(\d+)$', text, re.M)
        demand(match and re.search(r'^Database cluster state:\s+shut down$', text, re.M), 'recovery_control_identity')
        demand(any(row['path'] == 'PG_VERSION' and row.get('sha256') == digest(b'16\n') for row in inventory['data']), 'recovery_version')
        control_files = [row for row in inventory['data'] if row['path'] == 'global/pg_control']
        demand(len(control_files) == 1 and control_files[0]['kind'] == 'file'
            and re.fullmatch(r'[a-f0-9]{64}', control_files[0].get('sha256', '')), 'recovery_control_file')
        self.resource_guard(); self.config_ancestor_identity()
        self.assert_recovery_quiescence()
        return {'inventory': inventory, 'systemIdentifier': match[1], 'controlSha256': control_files[0]['sha256']}

    def protect_created_config(self):
        # Only called after this invocation's pg_createcluster ACK, never on pending resume.
        path = Path(self.p['plan']['target']['configDirectory'])
        expected = self.p['plan']['ownership']['config']
        self.config_ancestor_identity()
        before = path.lstat()
        demand(stat.S_ISDIR(before.st_mode) and before.st_uid == expected['uid'] and before.st_gid == expected['gid']
            and stat.S_IMODE(before.st_mode) in (0o700, 0o755), 'created_config_identity')
        self.remaining()
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            opened = os.fstat(fd)
            demand((opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode) ==
                (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode), 'created_config_identity')
            self.resource_guard(); self.remaining()
            self.config_ancestor_identity()
            os.fchmod(fd, expected['mode'])
            os.fsync(fd)
            after = path.lstat()
            demand((after.st_dev, after.st_ino) == (opened.st_dev, opened.st_ino), 'created_config_identity')
            self.owned_stamp(path, 'config', True)
            self.config_ancestor_identity()
        finally:
            os.close(fd)

    def live_expected(self):
        plan = self.p['plan']; t = plan['target']; r = plan['resources']; s = plan['settings']
        return {'data_directory': t['dataDirectory'], 'config_file': t['configDirectory'] + '/postgresql.conf',
            'hba_file': t['configDirectory'] + '/pg_hba.conf', 'listen_addresses': '127.0.0.1',
            'unix_socket_directories': t['socketDirectory'], 'max_connections': str(r['serverMaximumConnections']),
            'superuser_reserved_connections': str(s['superuserReservedConnections']), 'reserved_connections': str(s['reservedConnections']),
            'shared_buffers': str(s['sharedBuffersKb'] * 1024), 'work_mem': str(r['workMemKb'] * 1024),
            'maintenance_work_mem': str(s['maintenanceWorkMemKb'] * 1024), 'max_wal_size': str(s['maxWalSizeMb'] * 1024 ** 2)}

    def validate_hba_rules(self, rules):
        expected = [('local', ['all'], ['postgres'], None, None, 'peer'),
            ('local', ['all'], ['all'], None, None, 'reject'),
            ('host', ['all'], ['all'], '127.0.0.1', '255.255.255.255', 'reject'),
            ('host', ['all'], ['all'], '::1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'reject')]
        demand(type(rules) is list and len(rules) == 4, 'effective_hba_changed')
        for index, (row, wanted) in enumerate(zip(rules, expected), 1):
            demand(row['rule_number'] == index and row['line_number'] == index
                and row['file_name'] == self.p['plan']['target']['configDirectory'] + '/pg_hba.conf'
                and row['error'] is None and not row['options']
                and tuple(row[k] for k in ('type', 'database', 'user_name', 'address', 'netmask', 'auth_method')) == wanted, 'effective_hba_changed')
        return rules

    def observe(self, prepared):
        self.resource_guard()
        plan = prepared['plan']; target = plan['target']; stages = {}; foreign = self.instance_collisions()
        demand(not foreign, 'unknown_instance_override')
        startup = self.startup_identity()
        config_ancestors = self.config_ancestor_identity()
        machine_id = Path('/etc/machine-id').read_text().strip()
        data, config = Path(target['dataDirectory']), Path(target['configDirectory'])
        available = True
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind((target['host'], target['port']))
        except OSError:
            available = False
        finally:
            probe.close()
        if data.exists() or config.exists() or data.is_symlink() or config.is_symlink():
            demand(data.is_dir() and config.is_dir() and not data.is_symlink() and not config.is_symlink(), 'cluster_path_identity')
            control = self.command('pg_controldata', [str(data)], postgres=True).decode()
            match = re.search(r'^Database system identifier:\s+(\d+)$', control, re.M)
            demand(match, 'cluster_system_identity')
            stamps = {'data': self.owned_stamp(data, 'data', True), 'config': self.owned_stamp(config, 'config', True),
                'mainConfig': self.owned_stamp(config / 'postgresql.conf', 'mainConfig'),
                'hba': self.owned_stamp(config / 'pg_hba.conf', 'hba')}
            stages['cluster'] = {'planSha256': prepared['planSha256'], 'systemIdentifier': match[1],
                'ownership': stamps, 'configAncestors': config_ancestors, 'startupUnit': startup}
            generated = config / 'address-radar-preparation.conf'
            main = config / 'postgresql.conf'
            include = "include = 'address-radar-preparation.conf'\n"
            if generated.exists() or generated.is_symlink():
                demand(not generated.is_symlink() and generated.read_bytes() == self.configuration()
                    and main.read_text().endswith(include), 'cluster_config_identity')
                demand((config / 'pg_hba.conf').read_bytes() == self.hba_configuration(), 'hba_file_changed')
                stages['configure'] = {'planSha256': prepared['planSha256'], 'configurationSha256': digest(generated.read_bytes()),
                    'mainConfigSha256': digest(main.read_bytes()), 'hbaSha256': digest(self.hba_configuration()),
                    'generatedOwnership': self.owned_stamp(generated, 'generatedConfig')}
            if (data / 'postmaster.pid').exists():
                identity = json.loads(self.sql("SELECT json_build_object('systemIdentifier',(pg_control_system()).system_identifier::text,'port',current_setting('port'),'database',current_database(),'version',current_setting('server_version_num'));"))
                demand(identity['systemIdentifier'] == match[1] and identity['port'] == '5432' and identity['database'] == 'postgres'
                    and 160000 <= int(identity['version']) < 170000, 'live_cluster_identity')
                demand('configure' in stages, 'unconfigured_live_cluster')
                expected = self.live_expected()
                sizes = ('shared_buffers', 'work_mem', 'maintenance_work_mem', 'max_wal_size')
                expressions = ["'" + k + "'," + ("pg_size_bytes(current_setting('" + k + "'))::text" if k in sizes else "current_setting('" + k + "')") for k in expected]
                live = json.loads(self.sql('SELECT json_build_object(' + ','.join(expressions) + ');'))
                demand(live == expected, 'live_settings_changed')
                rules = self.validate_hba_rules(json.loads(self.sql('SELECT coalesce(json_agg(row_to_json(r) ORDER BY rule_number),\'[]\'::json) FROM pg_hba_file_rules r;')))
                stages['start'] = {'planSha256': prepared['planSha256'], 'systemIdentifier': match[1],
                    'liveSettings': live, 'hbaRules': rules, 'startupUnit': startup}
                names = ','.join("'" + role + "'" for role in prepared['roles'])
                roles = json.loads(self.sql("SELECT coalesce(json_agg(row_to_json(r) ORDER BY r.name),'[]'::json) FROM (SELECT oid::text,name,login,inherit,superuser,createdb,createrole,replication,bypassrls,connection_limit,memberships FROM (SELECT oid,rolname AS name,rolcanlogin AS login,rolinherit AS inherit,rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls,rolconnlimit AS connection_limit,(SELECT count(*) FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname IN (" + names + ")) AS a) AS r;"))
                if roles:
                    demand(len(roles) == 7, 'partial_roles')
                    expected_limits = {plan['migratorRole']: plan['resources']['migrationConnections'], **{plan['serviceRoles'][s]: plan['resources']['pools'][s]['instances'] * plan['resources']['pools'][s]['maximumConnections'] for s in SERVICES}}
                    for role in roles:
                        demand(role['name'] in expected_limits and role['connection_limit'] == expected_limits[role['name']]
                            and role['memberships'] == 0 and not any(role[k] for k in ('login','inherit','superuser','createdb','createrole','replication','bypassrls')), 'role_authority_changed')
                    stages['roles'] = {'planSha256': prepared['planSha256'], 'roles': roles}
                db = json.loads(self.sql("SELECT coalesce(json_agg(row_to_json(d)),'[]'::json) FROM (SELECT oid::text,datname,pg_get_userbyid(datdba) AS owner,datconnlimit AS connection_limit FROM pg_database WHERE datname='" + plan['database'] + "') AS d;"))
                if db:
                    demand(len(db) == 1 and db[0]['owner'] == plan['migratorRole'] and db[0]['connection_limit'] == prepared['databaseConnectionLimit'], 'database_owner_changed')
                    stages['database'] = {'planSha256': prepared['planSha256'], 'database': db[0]}
                    namespace = self.sql("SELECT count(*) FROM pg_namespace WHERE nspname='" + plan['schema'] + "';", plan['database']).strip()
                    demand(namespace == b'0', 'business_schema_must_remain_absent')
                    denied = self.sql("SELECT NOT EXISTS (SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0) AND NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND (a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN (" + names + "))));", plan['database']).strip()
                    if denied == b't':
                        stages['lockdown'] = {'planSha256': prepared['planSha256'], 'databaseOid': db[0]['oid'], 'publicPrivilegesRemoved': True}
        return {'machineId': machine_id, 'portAvailable': available, 'foreignObjects': foreign, 'stages': stages}

    def apply(self, stage, prepared):
        self.resource_guard()
        self.remaining()
        self.config_ancestor_identity()
        plan = prepared['plan']; target = plan['target']; config = Path(target['configDirectory'])
        if stage == 'cluster':
            self.command('pg_createcluster', ['16', target['cluster'], '--port', '5432', '--datadir', target['dataDirectory'], '--start-conf=manual'])
            self.protect_created_config()
        elif stage == 'configure':
            with self.bound_config_directory() as (config_fd, binding):
                for name, key, body, flags in (
                    ('address-radar-preparation.conf', 'generatedConfig', self.configuration(), os.O_CREAT | os.O_EXCL),
                    ('pg_hba.conf', 'hba', self.hba_configuration(), 0),
                    ('postgresql.conf', 'mainConfig', b"include = 'address-radar-preparation.conf'\n", os.O_APPEND)):
                    self.resource_guard(); self.remaining(); binding()
                    before = None if flags & os.O_CREAT else self.owned_stamp(name, key, dir_fd=config_fd)
                    mode = plan['ownership'][key]['mode']
                    fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW | flags, mode, dir_fd=config_fd)
                    with os.fdopen(fd, 'wb') as stream:
                        info = os.fstat(stream.fileno()); expected_owner = plan['ownership'][key]
                        demand(info.st_uid == expected_owner['uid'] and info.st_gid == expected_owner['gid']
                            and info.st_nlink == 1 and (before is None or (info.st_dev, info.st_ino) == (before['device'], before['inode'])), 'target_ownership_changed')
                        self.remaining(); binding()
                        if flags & os.O_CREAT:
                            os.fchmod(stream.fileno(), mode)
                        elif not flags & os.O_APPEND:
                            os.ftruncate(stream.fileno(), 0)
                        self.remaining(); binding()
                        stream.write(body); stream.flush(); os.fsync(stream.fileno())
                    binding(); self.owned_stamp(name, key, dir_fd=config_fd)
                self.remaining(); os.fsync(config_fd)
        elif stage == 'start':
            self.command('pg_ctlcluster', ['16', target['cluster'], 'start'])
        elif stage == 'roles':
            limits = [plan['resources']['migrationConnections']] + [plan['resources']['pools'][s]['instances'] * plan['resources']['pools'][s]['maximumConnections'] for s in SERVICES]
            statements = [f'CREATE ROLE {quote(role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT {limit};' for role, limit in zip(prepared['roles'], limits)]
            self.sql('BEGIN;\n' + '\n'.join(statements) + '\nCOMMIT;')
        elif stage == 'database':
            self.sql(f'CREATE DATABASE {quote(plan["database"])} OWNER {quote(plan["migratorRole"])} TEMPLATE template0 CONNECTION LIMIT {prepared["databaseConnectionLimit"]};')
        elif stage == 'lockdown':
            runtime = ','.join(quote(plan['serviceRoles'][s]) for s in SERVICES)
            self.sql(f'BEGIN; REVOKE ALL PRIVILEGES ON DATABASE {quote(plan["database"])} FROM PUBLIC; REVOKE CREATE,TEMPORARY ON DATABASE {quote(plan["database"])} FROM PUBLIC,{runtime}; REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC,{runtime}; REVOKE {quote(plan["migratorRole"])} FROM {runtime}; COMMIT;', plan['database'])
        else:
            raise Refused('unknown_stage')
        observed = self.observe(prepared)
        demand(stage in observed['stages'], 'stage_ack_missing')
        return observed['stages'][stage]

def schema():
    def obj(properties):
        return {'type': 'object', 'required': list(properties), 'additionalProperties': False, 'properties': properties}
    number = {'type': 'integer', 'minimum': 1}
    text = {'type': 'string', 'minLength': 1}
    resources = {key: number for key in RESOURCE_FIELDS if key != 'pools'}
    for key in ('maximumPendingOperations', 'otherHostConnections'):
        resources[key] = {'type': 'integer', 'minimum': 0}
    resources['pools'] = obj({service: obj({'instances': number, 'maximumConnections': {'type': 'integer', 'minimum': 1, 'maximum': 64}}) for service in SERVICES})
    properties = {key: text for key in PLAN_FIELDS}
    properties.update({'version': {'const': 1}, 'target': obj({key: ({'const': 16} if key == 'version' else {'const': 5432} if key == 'port' else text) for key in TARGET_FIELDS}),
        'serviceRoles': obj({service: text for service in SERVICES}), 'resources': obj(resources),
        'capacity': {'oneOf': [{'type': 'null'}, obj({key: {'const': 'measured'} if key == 'status' else text for key in CAPACITY_FIELDS})]},
        'settings': obj({key: {'type': 'integer', 'minimum': 0 if key in ('superuserReservedConnections', 'reservedConnections') else 1} for key in SETTINGS_FIELDS}),
        'emptyTargetGuard': obj({'minimumAvailableMemoryBytes': text, 'minimumFreeDiskBytes': text, 'maximumMemoryPsiAvg10': {'type': 'number', 'minimum': 0}}),
        'tools': obj({tool: obj({'path': text, 'sha256': {'type': 'string', 'pattern': '^[a-f0-9]{64}$'}}) for tool in TOOLS}),
        'ownership': obj({key: obj({'uid': {'type': 'integer', 'minimum': 0}, 'gid': {'type': 'integer', 'minimum': 0},
            'mode': {'type': 'integer', 'minimum': 0, 'maximum': 511}}) for key in OWNERSHIP_FIELDS}),
        'configAncestors': obj({path: obj({'uid': {'type': 'integer', 'minimum': 0}, 'gid': {'type': 'integer', 'minimum': 0},
            'mode': {'type': 'integer', 'minimum': 0, 'maximum': 511}, 'device': text, 'inode': text})
            for path in ('/', '/etc', '/etc/postgresql', '/etc/postgresql/16')}),
        'startupUnit': obj({'fragmentPath': text, 'fragmentSha256': text, 'dropIns': {'type': 'array', 'items': obj({'path': text, 'sha256': text})},
            'execStart': text, 'user': {'type': 'string'}, 'group': {'type': 'string'}, 'environmentFiles': {'type': 'string'}}),
        'stageTimeoutSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 180},
        'operationTimeoutSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 900}})
    properties['machineId'] = {'type': 'string', 'pattern': '^[a-f0-9]{32}$'}
    properties['database'] = {'const': 'address_radar'}
    properties['target'] = obj({key: {'const': value} for key, value in example()['target'].items()})
    return {'$schema': 'https://json-schema.org/draft/2020-12/schema', **obj(properties)}

def example():
    return {'version': 1, 'operationId': None, 'hostId': None, 'machineId': None,
        'target': {'version': 16, 'cluster': 'radarproduction', 'host': '127.0.0.1', 'port': 5432,
            'dataDirectory': '/var/lib/postgresql/16/radarproduction', 'configDirectory': '/etc/postgresql/16/radarproduction', 'socketDirectory': '/var/run/postgresql'},
        'database': 'address_radar', 'schema': None, 'generation': None, 'migratorRole': None,
        'serviceRoles': {service: None for service in SERVICES},
        'resources': {key: {s: {'instances': None, 'maximumConnections': None} for s in SERVICES} if key == 'pools' else None for key in RESOURCE_FIELDS},
        'capacity': None, 'settings': {key: None for key in SETTINGS_FIELDS}, 'emptyTargetGuard': {key: None for key in GUARD_FIELDS},
        'tools': {tool: {'path': None, 'sha256': None} for tool in TOOLS},
        'ownership': {key: {'uid': None, 'gid': None, 'mode': None} for key in OWNERSHIP_FIELDS},
        'configAncestors': {path: {'uid': None, 'gid': None, 'mode': None, 'device': None, 'inode': None}
            for path in ('/', '/etc', '/etc/postgresql', '/etc/postgresql/16')},
        'startupUnit': {'fragmentPath': None, 'fragmentSha256': None, 'dropIns': None, 'execStart': None,
            'user': None, 'group': None, 'environmentFiles': None}, 'stageTimeoutSeconds': None, 'operationTimeoutSeconds': None}

def strict_json(body):
    def pairs(items):
        result = {}
        for key, value in items:
            demand(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    return json.loads(body, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(Refused('invalid_json_number')))

def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('plan', 'preflight', 'apply', 'recover-cluster'), default='plan')
    parser.add_argument('--plan')
    parser.add_argument('--approved-plan-sha256')
    parser.add_argument('--private-directory')
    parser.add_argument('--example', action='store_true')
    parser.add_argument('--json-schema', action='store_true')
    parser.add_argument('--recovery-review-pin')
    parser.add_argument('--approved-recovery-review-sha256')
    parser.add_argument('--recovery-review-template', action='store_true')
    args = parser.parse_args()
    if args.recovery_review_template:
        demand(args.mode == 'plan' and not args.plan and not args.example and not args.json_schema, 'arguments')
        return operator_recovery_review_template()
    if args.example or args.json_schema:
        demand(not (args.example and args.json_schema) and args.mode == 'plan' and not args.plan, 'arguments')
        return example() if args.example else schema()
    demand(args.plan, 'plan_required')
    path = Path(args.plan)
    demand(path.is_file() and not path.is_symlink() and path.stat().st_size <= 1024 ** 2, 'plan_file')
    candidate = strict_json(path.read_bytes())
    prepared = validate_plan(candidate, int(time.time() * 1000))
    if args.mode != 'recover-cluster':
        demand(not args.recovery_review_pin and not args.approved_recovery_review_sha256, 'arguments')
    if args.mode == 'plan':
        demand(not args.approved_plan_sha256 and not args.private_directory, 'arguments')
        return {'status': 'plan_validated', 'planSha256': prepared['planSha256'], 'resourcePolicyFingerprint': prepared['resourcePolicyFingerprint'],
            'schemaDeferred': True, 'hostObserved': False, 'productionMigrationReady': False, 'fullCapacityProved': False}
    if args.mode == 'preflight':
        demand(not args.approved_plan_sha256 and not args.private_directory, 'arguments')
        observed = NativeAdapter(prepared).observe(prepared)
        demand(observed['machineId'] == candidate['machineId'] and not observed['foreignObjects'] and not observed['stages'] and observed['portAvailable'], 'existing_target')
        return {'status': 'preflight_passed', 'productionMigrationReady': False, 'fullCapacityProved': False}
    if args.mode == 'recover-cluster':
        demand(not args.approved_plan_sha256 and args.private_directory and args.recovery_review_pin
            and args.approved_recovery_review_sha256, 'explicit_recovery_review_required')
        review_pin = strict_json(Path(args.recovery_review_pin).read_bytes())
        adapter = NativeAdapter(prepared)
        adapter.resource_guard(); adapter.remaining()
        # Recovery must not create or adopt a new private state directory.
        secure_stat(Path(args.private_directory), 0, 0o700, True)
        review = OperatorRecoveryReview(adapter, review_pin, args.approved_recovery_review_sha256)
        demand(review.review['evidence']['currentPlanSha256'] == prepared['planSha256'], 'recovery_plan_binding')
        storage = PrivateStorage(args.private_directory)
        original = strict_json(adapter.read_recovery_artifact(review.review['evidence']['originalArtifacts']['plan']))
        return recover_pending_cluster(original, candidate, review.review['evidence'], review.transcripts,
            review.verify, adapter, storage, int(time.time() * 1000))
    demand(args.approved_plan_sha256 == prepared['planSha256'] and args.private_directory, 'explicit_plan_binding_required')
    # This digest binds inputs; it is not a fabricated signature or production migration approval.
    adapter = NativeAdapter(prepared)
    adapter.resource_guard(); adapter.remaining()
    storage = PrivateStorage(args.private_directory)
    return prepare_target(candidate, adapter, storage, int(time.time() * 1000))

if __name__ == '__main__':
    try:
        def interrupted(_signum, _frame):
            raise Refused('operation_interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        result = cli()
        print(json.dumps(result, sort_keys=True, allow_nan=False))
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else 'invalid_input_or_host_failure'
        print(json.dumps({'status': 'refused', 'code': code, 'productionMigrationReady': False}), file=sys.stderr)
        sys.exit(1)
