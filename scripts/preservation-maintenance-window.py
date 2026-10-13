#!/usr/bin/env python3
"""Resource-only maintenance. Never a writer fence or a production migration gate."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import pwd
import grp
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/var/lib/address-radar-maintenance')
RESOURCE_RELEASE = '/opt/address-radar/releases/4b48fc2-forward-token-code'
RESOURCE_ACCOUNT = {'user': 'address-radar', 'group': 'address-radar', 'uid': 997, 'gid': 987}
RESOURCE_LEAF_MODE = 0o755
MAIN = tuple('address-radar-' + name + '.service' for name in (
    'scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console'))
AUX = ('address-radar-backup.service', 'address-radar-fomo-verification-sync.service',
       'fomo-address-radar-backup.service', 'fomo-address-radar-input-sync.service',
       'fomo-radar-protocol-audit.service')
TIMERS = tuple(name[:-8] + '.timer' for name in AUX)
PROTECTED = ('fomo-radar-collector.service', 'fomo-radar-login.service', 'fomo-radar-novnc.service')
UNITS = MAIN + AUX + TIMERS + PROTECTED
ENV_FILES = {unit: ('/etc/address-radar/address-radar.env',) for unit in MAIN + ('address-radar-backup.service',)}
ENV_FILES.update({'fomo-address-radar-backup.service': ('/etc/fomo-radar/address-radar.env',),
                  'fomo-radar-protocol-audit.service': ('/etc/fomo-radar/radar.env',),
                  'fomo-radar-collector.service': ('/etc/fomo-radar/radar.env',)})
DROP_INS = {'address-radar-backup.timer': ('/etc/systemd/system/address-radar-backup.timer.d/daily.conf',)}
NONCE = re.compile(r'^[a-f0-9]{16}$')
SHA = re.compile(r'^[a-f0-9]{64}$')
MAX_BYTES = 131072
WINDOW_US = 3600 * 1000000
WATCHDOG_US = 3300 * 1000000
RESTORE_SECONDS = 240
PAUSE_OPERATION_SECONDS = 450
READ_OPERATION_SECONDS = 120
SERVICE_GRACE_SECONDS = 90
SERVICE_PROOF_MARGIN_SECONDS = 5
SERVICE_WAIT_SECONDS = SERVICE_GRACE_SECONDS + SERVICE_PROOF_MARGIN_SECONDS
CAPTURE_BUSY_SECONDS = 5
CAPTURE_SYNC_TIMERS = ('address-radar-fomo-verification-sync.timer', 'fomo-address-radar-input-sync.timer')
CAPTURE_SYNC_SERVICES = tuple(unit[:-6] + '.service' for unit in CAPTURE_SYNC_TIMERS)


class Refused(RuntimeError):
    pass


def digest(body):
    return hashlib.sha256(body).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def demand(condition, reason):
    if not condition:
        raise Refused(reason)


def checked_nonce(value):
    demand(type(value) is str and NONCE.fullmatch(value), 'invalid_nonce')
    return value


def secure_directory(path, mode=None):
    path = Path(path)
    demand(path.is_absolute(), 'absolute_path_required')
    for part in (Path('/'),) + tuple(reversed(tuple(path.parents)[:-1])) + (path,):
        info = os.lstat(part)
        demand(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
               'unsafe_directory')
    if mode is not None:
        demand(stat.S_IMODE(os.lstat(path).st_mode) == mode, 'private_directory_mode')


def secure_read(path, exact_mode=None, maximum=MAX_BYTES):
    secure_directory(Path(path).parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        demand(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
               and not before.st_mode & 0o022 and before.st_size <= maximum, 'unsafe_file')
        if exact_mode is not None:
            demand(stat.S_IMODE(before.st_mode) == exact_mode, 'private_file_mode')
        body = bytearray()
        while True:
            block = os.read(fd, min(65536, maximum + 1 - len(body)))
            if not block:
                break
            body.extend(block)
            demand(len(body) <= maximum, 'file_byte_limit')
        after = os.fstat(fd)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        demand(identity(before) == identity(after), 'file_changed_during_read')
        return bytes(body)
    finally:
        os.close(fd)


def new_file(path, body):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(body)
        while view:
            count = os.write(fd, view)
            demand(count > 0, 'short_file_write')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_baseline(value, nonce):
    fields = {'version', 'nonce', 'scope', 'formalFence', 'productionMigrationAuthorized',
              'gatewayDeliveryEnabled', 'binding', 'capturedMonotonicUs', 'deadlineMonotonicUs',
              'capturedAtUnixMs', 'helperSha256', 'units'}
    demand(type(value) is dict and set(value) == fields, 'invalid_baseline_fields')
    demand(value['version'] == 1 and type(value['version']) is int and value['nonce'] == nonce,
           'invalid_baseline_identity')
    demand(value['scope'] == 'resource-only' and value['formalFence'] is False
           and value['productionMigrationAuthorized'] is False and value['gatewayDeliveryEnabled'] is False,
           'invalid_baseline_authority')
    for key in ('capturedMonotonicUs', 'deadlineMonotonicUs', 'capturedAtUnixMs'):
        demand(type(value[key]) is int and value[key] >= 0, 'invalid_baseline_time')
    demand(value['deadlineMonotonicUs'] - value['capturedMonotonicUs'] == WINDOW_US,
           'invalid_window_deadline')
    demand(type(value['helperSha256']) is str and SHA.fullmatch(value['helperSha256']), 'invalid_helper_pin')
    binding = value['binding']
    demand(type(binding) is dict and set(binding) == {'bootId', 'releasePath', 'releaseLink', 'releaseIdentity', 'serviceAccount'},
           'invalid_host_binding')
    demand(type(binding['bootId']) is str and re.fullmatch(r'[a-f0-9-]{36}', binding['bootId']), 'invalid_boot')
    demand(binding['releasePath'] == RESOURCE_RELEASE,
           'invalid_release_path')
    demand(type(binding['releaseLink']) is str and 0 < len(binding['releaseLink']) <= 256,
           'invalid_release_link')
    demand(type(binding['releaseIdentity']) is list and len(binding['releaseIdentity']) == 5
           and all(type(v) is int and v >= 0 for v in binding['releaseIdentity'])
           and tuple(binding['releaseIdentity'][2:]) == (997, 987, RESOURCE_LEAF_MODE), 'invalid_release_identity')
    demand(type(binding['serviceAccount']) is dict and binding['serviceAccount'] == RESOURCE_ACCOUNT
           and type(binding['serviceAccount'].get('uid')) is int and type(binding['serviceAccount'].get('gid')) is int,
           'invalid_service_account')
    records = value['units']
    demand(type(records) is dict and set(records) == set(UNITS), 'unknown_or_missing_baseline_units')
    for unit, record in records.items():
        demand(type(record) is dict and set(record) == {'active', 'sub', 'pid', 'group', 'config'}, 'invalid_unit_record')
        demand(type(record['pid']) is int and record['pid'] >= 0 and type(record['group']) is str
               and (record['group'] == '' or record['group'] == '/system.slice/' + unit), 'invalid_unit_process')
        allowed = {('active', 'waiting'), ('inactive', 'dead'), ('failed', 'failed')} if unit in TIMERS else {
            ('active', 'running'), ('inactive', 'dead'), ('failed', 'failed')}
        demand((record['active'], record['sub']) in allowed, 'unknown_unit_state')
        if unit in AUX:
            demand(record['active'] in ('inactive', 'failed') and record['pid'] == 0, 'inflight_auxiliary')
        if unit in PROTECTED:
            demand((record['active'], record['sub']) == ('active', 'running') and record['pid'] > 0,
                   'protected_unit_not_running')
        config = record['config']
        demand(type(config) is dict and set(config) == {'sha256', 'files'} and type(config['sha256']) is str
               and SHA.fullmatch(config['sha256']) and type(config['files']) is list, 'invalid_unit_configuration')
        demand(len(config['files']) <= 16, 'configuration_file_limit')
        paths = set()
        for pin in config['files']:
            demand(type(pin) is dict and set(pin) == {'path', 'sha256'} and approved_config_path(pin['path'], unit)
                   and pin['path'] not in paths and type(pin['sha256']) is str and SHA.fullmatch(pin['sha256']),
                   'invalid_configuration_pin')
            paths.add(pin['path'])
    return value


def approved_config_path(path, unit):
    if type(path) is not str or unit not in UNITS:
        return False
    return path in (('/etc/systemd/system/' + unit,) + ENV_FILES.get(unit, ()) + DROP_INS.get(unit, ()))


class Clock:
    def mono(self):
        return time.monotonic_ns() // 1000

    def unix(self):
        return time.time_ns() // 1000000

    def sleep(self, seconds):
        time.sleep(seconds)


class SystemdHost:
    COMMON_PROPERTIES = ('Id', 'LoadState', 'ActiveState', 'SubState', 'FragmentPath', 'DropInPaths', 'UnitFileState')
    SERVICE_PROPERTIES = COMMON_PROPERTIES + ('MainPID', 'ControlGroup', 'EnvironmentFiles', 'Environment',
                                             'PassEnvironment', 'KillMode', 'Type', 'User', 'Group')
    TIMER_PROPERTIES = COMMON_PROPERTIES + ('Triggers',)

    def __init__(self, clock, budget_seconds):
        self.clock = clock
        self.deadline = clock.mono() + budget_seconds * 1000000

    def command(self, arguments, not_after_us=None):
        deadline_us = self.deadline if not_after_us is None else min(self.deadline, not_after_us)
        remaining = (deadline_us - self.clock.mono()) / 1000000
        demand(remaining > 0, 'operation_deadline')
        # The absolute deadline includes process creation, not just subsequent pipe reads.
        deadline = time.monotonic() + min(5, remaining)
        process = subprocess.Popen(['/usr/bin/systemctl'] + arguments, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
                                   env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'SYSTEMD_PAGER': '', 'SYSTEMD_COLORS': '0'})
        selector = selectors.DefaultSelector()
        body = bytearray()
        total = 0
        try:
            selector.register(process.stdout, selectors.EVENT_READ, True)
            selector.register(process.stderr, selectors.EVENT_READ, False)
            while selector.get_map():
                demand(time.monotonic() < deadline, 'systemctl_deadline')
                for key, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                    block = os.read(key.fileobj.fileno(), 8192)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    total += len(block)
                    demand(total <= MAX_BYTES, 'systemctl_output_limit')
                    if key.data:
                        body.extend(block)
            demand(process.wait(timeout=max(0.01, deadline - time.monotonic())) == 0, 'systemctl_failed')
            return body.decode('utf-8')
        finally:
            selector.close()
            if process.poll() is None:
                process.kill()
                process.wait(timeout=1)
            process.stdout.close()
            process.stderr.close()

    def show(self, unit, properties):
        demand(unit in UNITS or re.fullmatch(r'address-radar-maintenance-[a-f0-9]{16}\.(service|timer)', unit),
               'unknown_unit')
        output = self.command(['show', unit, '--all', '--no-pager', '--property=' + ','.join(properties)])
        result = {}
        for line in output.splitlines():
            key, separator, value = line.partition('=')
            demand(separator and key in properties and key not in result, 'invalid_systemctl_properties')
            result[key] = value
        # systemd 255 omits an empty EnvironmentFiles complex array even with --all.
        # Normalize this one property only for a confirmed loaded service; all other omissions fail closed.
        if (unit in MAIN + AUX + PROTECTED and properties == self.SERVICE_PROPERTIES
                and result.get('Id') == unit and result.get('LoadState') == 'loaded'
                and 'EnvironmentFiles' not in result):
            result['EnvironmentFiles'] = ''
        # systemd 255 omits the empty calendar complex array for this armed transient timer.
        if (re.fullmatch(r'address-radar-maintenance-[a-f0-9]{16}\.timer', unit)
                and properties == self.WATCHDOG_TIMER_PROPERTIES
                and set(result) == set(properties) - {'TimersCalendar'}
                and result.get('LoadState') == 'loaded' and result.get('ActiveState') == 'active'
                and result.get('SubState') == 'waiting' and result.get('Transient') == 'yes'
                and result.get('Triggers') == unit[:-6] + '.service'):
            result['TimersCalendar'] = ''
        demand(set(result) == set(properties), 'missing_systemctl_properties')
        return result

    def binding(self):
        account = pwd.getpwnam('address-radar')
        group = grp.getgrnam('address-radar')
        demand(account.pw_uid == 997 and account.pw_gid == 987 and group.gr_gid == 987, 'resource_account_changed')
        for unit in MAIN:
            value = self.show(unit, ('Id', 'LoadState', 'User', 'Group'))
            demand(value == {'Id': unit, 'LoadState': 'loaded', 'User': 'address-radar', 'Group': 'address-radar'},
                   'main_service_account_changed')
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        current = Path('/opt/address-radar/current')
        secure_directory(current.parent)
        link = os.lstat(current)
        demand(stat.S_ISLNK(link.st_mode) and link.st_uid == 0, 'invalid_current_release_link')
        target = str(current.resolve(strict=True))
        demand(target == RESOURCE_RELEASE, 'unknown_current_release')
        secure_directory(Path(target).parent)
        info = os.lstat(target)
        # This precise service-owned leaf exception is resource-only, not formal release/artifact trust.
        demand(stat.S_ISDIR(info.st_mode) and info.st_uid == 997 and info.st_gid == 987
               and stat.S_IMODE(info.st_mode) == RESOURCE_LEAF_MODE, 'resource_release_leaf_changed')
        return {'bootId': boot, 'releasePath': target, 'releaseLink': os.readlink(current),
                'releaseIdentity': [info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)],
                'serviceAccount': dict(RESOURCE_ACCOUNT)}

    def unit(self, name):
        properties = self.TIMER_PROPERTIES if name in TIMERS else self.SERVICE_PROPERTIES
        value = self.show(name, properties)
        demand(value['Id'] == name and value['LoadState'] == 'loaded', 'unit_not_loaded')
        if name in TIMERS:
            demand(value['Triggers'] == name[:-6] + '.service', 'unknown_timer_target')
        else:
            demand(value['MainPID'].isdigit(), 'invalid_main_pid')
            demand(value['PassEnvironment'] == '', 'manager_environment_not_pinned')
            if name in MAIN:
                demand(value['User'] == 'address-radar' and value['Group'] == 'address-radar', 'main_service_account_changed')
            if name in MAIN + AUX:
                demand(value['KillMode'] == 'control-group', 'unit_children_not_control_group')
        demand(value['UnitFileState'] in ('enabled', 'enabled-runtime', 'disabled', 'static', 'indirect', 'linked', 'linked-runtime'),
               'unsupported_unit_file_state')
        drop_ins = tuple(value['DropInPaths'].split())
        demand(drop_ins == DROP_INS.get(name, ()), 'unknown_unit_drop_ins')
        paths = [value['FragmentPath']] + list(drop_ins)
        env = '' if name in TIMERS else value['EnvironmentFiles']
        entries = []
        if env:
            entries = re.findall(r'(\S+) \(ignore_errors=(?:yes|no)\)', env)
            demand(' '.join(re.findall(r'\S+ \(ignore_errors=(?:yes|no)\)', env)) == env, 'unknown_environment_files')
            paths.extend(entries)
        demand(tuple(entries) == ENV_FILES.get(name, ()), 'unknown_unit_environment_files')
        demand(len(paths) <= 16 and len(set(paths)) == len(paths), 'configuration_file_limit')
        pins = []
        for path in paths:
            demand(approved_config_path(path, name), 'unknown_configuration_path')
            pins.append({'path': path, 'sha256': digest(secure_read(path))})
        # ExecStart show output contains timestamps/PID/exit status. Immutable unit-file bytes bind argv instead.
        static = {key: value[key] for key in properties if key not in (
            'ActiveState', 'SubState', 'MainPID', 'ControlGroup')}
        return {'active': value['ActiveState'], 'sub': value['SubState'], 'pid': 0 if name in TIMERS else int(value['MainPID']),
                'group': '' if name in TIMERS else value['ControlGroup'], 'config': {'sha256': digest(encoded(static)), 'files': pins}}

    def simple_startup(self, unit, current):
        demand(unit in MAIN, 'unknown_main_startup_unit')
        fields = self.show(unit, ('Id', 'LoadState', 'Type', 'MainPID'))
        return (fields['Id'] == unit and fields['LoadState'] == 'loaded' and fields['Type'] == 'simple'
                and fields['MainPID'] == str(current['pid']))

    def stop_instance(self, unit, current):
        demand(unit in MAIN and current['pid'] > 0, 'main_stop_instance_missing')
        properties = ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestampMonotonic')
        before = self.show(unit, properties)
        stamp = before['ExecMainStartTimestampMonotonic']
        demand(before['Id'] == unit and before['LoadState'] == 'loaded'
               and before['ActiveState'] == 'active' and before['SubState'] == 'running'
               and before['MainPID'] == str(current['pid']) and re.fullmatch(r'[0-9]{1,20}', stamp)
               and int(stamp) > 0, 'main_stop_instance_not_running')
        witness = self.gateway_false(current)
        demand(self.show(unit, properties) == before, 'main_stop_instance_changed_during_probe')
        return dict(witness, execStartMonotonicUs=stamp)

    def main_stop_143(self, unit, current, original, receipt):
        demand(unit in MAIN, 'unknown_main_stop_unit')
        fields = self.show(unit, ('Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID',
                                 'ControlGroup', 'Result', 'ExecMainCode', 'ExecMainStatus',
                                 'ExecMainStartTimestampMonotonic'))
        return (fields['Id'] == unit and fields['LoadState'] == 'loaded'
                and fields['ActiveState'] == fields['SubState'] == 'failed'
                and fields['MainPID'] == '0' and current['pid'] == 0
                and fields['ControlGroup'] in ('', original['group'])
                and fields['Result'] == 'exit-code' and fields['ExecMainCode'] == '1'
                and fields['ExecMainStatus'] == '143' and receipt['pid'] == original['pid']
                and fields['ExecMainStartTimestampMonotonic'] == receipt['execStartMonotonicUs']
                and self.group_empty(original)
                and not any(job['unit'] == unit for job in self.jobs()))

    def gateway_false(self, record):
        demand(record['pid'] > 0, 'gateway_process_missing')
        pid = record['pid']
        before = Path('/proc/' + str(pid) + '/stat').read_bytes()
        before_exe = os.readlink('/proc/' + str(pid) + '/exe')
        fd = os.open('/proc/' + str(pid) + '/environ', os.O_RDONLY | os.O_NOFOLLOW)
        try:
            data = os.read(fd, MAX_BYTES + 1)
            demand(len(data) <= MAX_BYTES, 'process_environment_limit')
        finally:
            os.close(fd)
        flags = [v for v in data.split(b'\0') if v.startswith(b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=')]
        # Explicit unsafe/duplicate values are never treated as a startup transition.
        demand(not flags or flags == [b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false'], 'gateway_not_disabled')
        after = Path('/proc/' + str(pid) + '/stat').read_bytes()
        after_exe = os.readlink('/proc/' + str(pid) + '/exe')
        start = lambda body: body.rsplit(b')', 1)[1].split()[19]
        demand(start(before) == start(after), 'gateway_process_reused')
        demand(before_exe == after_exe, 'gateway_process_transition')
        demand(flags, 'gateway_flag_missing')
        return {'pid': pid, 'startTime': start(before).decode('ascii'),
                'exeSha256': digest(before_exe.encode('utf-8'))}

    def group_empty(self, record):
        group = record['group']
        if not group:
            return True
        demand(re.fullmatch(r'/system.slice/[A-Za-z0-9_.-]+\.service', group), 'unknown_control_group')
        path = Path('/sys/fs/cgroup' + group + '/cgroup.events')
        try:
            values = dict(line.split() for line in path.read_text().splitlines())
        except FileNotFoundError:
            return True
        demand(values.get('populated') in ('0', '1'), 'unknown_cgroup_population')
        return values['populated'] == '0'

    def jobs(self):
        jobs = []
        for line in self.command(['list-jobs', '--no-legend', '--no-pager', '--plain']).splitlines():
            fields = line.split()
            demand(len(fields) == 4 and fields[0].isdigit(), 'unknown_systemd_job_format')
            if fields[1] in UNITS:
                demand(fields[2] in ('start', 'stop', 'restart', 'reload', 'verify-active', 'reload-or-start')
                       and fields[3] in ('running', 'waiting'), 'unknown_managed_job')
                jobs.append({'unit': fields[1], 'kind': fields[2], 'state': fields[3]})
        return jobs

    def mutate(self, action, unit, nonce, not_after_us=None):
        checked_nonce(nonce)
        watchdog = ('address-radar-maintenance-' + nonce + '.timer', 'address-radar-maintenance-' + nonce + '.service')
        demand(action in ('start', 'stop') and (unit in MAIN + TIMERS or (action == 'stop' and unit in watchdog)),
               'forbidden_unit_mutation')
        self.command(['--no-block', action, unit], not_after_us=not_after_us)

    WATCHDOG_TIMER_PROPERTIES = ('LoadState', 'ActiveState', 'SubState', 'Transient',
        'AccuracyUSec', 'TimersMonotonic', 'TimersCalendar', 'ActiveEnterTimestampMonotonic', 'Triggers')

    def watchdog(self, nonce):
        name = 'address-radar-maintenance-' + checked_nonce(nonce)
        timer = self.show(name + '.timer', self.WATCHDOG_TIMER_PROPERTIES)
        service = self.show(name + '.service', ('LoadState', 'ActiveState', 'SubState', 'Transient',
            'Type', 'User', 'TimeoutStartUSec', 'ExecStart', 'Restart', 'KillMode'))
        return timer, service

    def watchdog_disarmed(self, nonce, kind):
        demand(kind in ('timer', 'service'), 'invalid_watchdog_kind')
        unit = 'address-radar-maintenance-' + checked_nonce(nonce) + '.' + kind
        state = self.show(unit, ('Id', 'LoadState', 'ActiveState', 'SubState'))
        demand(state['Id'] == unit, 'watchdog_identity_mismatch')
        # Stopping the timer can also collect its never-run transient service.
        demand(state['LoadState'] in ('loaded', 'not-found'), 'unexpected_watchdog_load_state')
        return state['ActiveState'] == 'inactive' and state['SubState'] == 'dead'

    def is_watchdog_process(self, nonce):
        target = '/system.slice/address-radar-maintenance-' + nonce + '.service'
        return any(line.split(':', 2)[-1] == target for line in Path('/proc/self/cgroup').read_text().splitlines())


def arm_argv(nonce, baseline_sha):
    checked_nonce(nonce)
    demand(SHA.fullmatch(baseline_sha), 'invalid_baseline_pin')
    return ['/usr/bin/systemd-run', '--unit=address-radar-maintenance-' + nonce,
            '--on-active=55min', '--timer-property=AccuracySec=1s', '--property=Type=oneshot',
            '--property=User=root', '--property=TimeoutStartSec=240s', '--property=Restart=no',
            '--property=KillMode=control-group', '/usr/bin/python3', str(ROOT / nonce / 'helper.py'),
            'restore', '--nonce', nonce, '--baseline-sha256', baseline_sha, '--watchdog']


def validate_stop_receipts(value, baseline, pin):
    demand(type(value) is dict and set(value) == {'version', 'nonce', 'baselineSha256', 'units'},
           'invalid_stop_receipts')
    demand(type(value['version']) is int and value['version'] == 1 and value['nonce'] == baseline['nonce']
           and value['baselineSha256'] == pin and digest(encoded(baseline)) == pin, 'stop_receipt_binding_mismatch')
    expected = {unit for unit in MAIN if baseline['units'][unit]['active'] == 'active'}
    demand(type(value['units']) is dict and set(value['units']) == expected, 'invalid_stop_receipt_units')
    for unit, record in value['units'].items():
        demand(type(record) is dict and set(record) == {'pid', 'startTime', 'exeSha256', 'execStartMonotonicUs'},
               'invalid_stop_receipt_identity')
        demand(type(record['pid']) is int and record['pid'] > 0
               and record['pid'] == baseline['units'][unit]['pid'], 'stop_receipt_pid_mismatch')
        for key in ('startTime', 'execStartMonotonicUs'):
            demand(type(record[key]) is str and re.fullmatch(r'[0-9]{1,20}', record[key])
                   and int(record[key]) > 0, 'invalid_stop_receipt_time')
        demand(type(record['exeSha256']) is str and SHA.fullmatch(record['exeSha256']), 'invalid_stop_receipt_exe')
    return value


class RootStorage:
    def __init__(self, nonce):
        self.nonce = checked_nonce(nonce)
        self.directory = ROOT / nonce

    def initialize(self):
        secure_directory(ROOT.parent)
        try:
            os.mkdir(ROOT, 0o700)
        except FileExistsError:
            pass
        secure_directory(ROOT, 0o700)
        os.mkdir(self.directory, 0o700)
        secure_directory(self.directory, 0o700)
        new_file(self.directory / 'lock', b'')

    @contextlib.contextmanager
    def lock(self, clock, seconds):
        secure_directory(self.directory, 0o700)
        fd = os.open(self.directory / 'lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            demand(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                   and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe_lock_file')
            deadline = clock.mono() + seconds * 1000000
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    demand(clock.mono() < deadline, 'maintenance_lock_deadline')
                    clock.sleep(0.1)
            yield
        finally:
            os.close(fd)

    def create(self, baseline, helper):
        body = encoded(validate_baseline(baseline, self.nonce))
        new_file(self.directory / 'helper.py', helper)
        new_file(self.directory / 'baseline.json', body)
        pin = digest(body)
        new_file(self.directory / 'baseline.sha256', (pin + '\n').encode())
        self.save_phase('captured')
        return pin

    def load(self, expected):
        demand(type(expected) is str and SHA.fullmatch(expected), 'invalid_baseline_pin')
        secure_directory(self.directory, 0o700)
        body = secure_read(self.directory / 'baseline.json', 0o600)
        demand(digest(body) == expected and secure_read(self.directory / 'baseline.sha256', 0o600).decode().strip() == expected,
               'baseline_digest_mismatch')
        baseline = validate_baseline(json.loads(body), self.nonce)
        demand(digest(secure_read(self.directory / 'helper.py', 0o600)) == baseline['helperSha256'], 'helper_digest_mismatch')
        return baseline

    def save_stop_receipts(self, pin, units):
        value = {'version': 1, 'nonce': self.nonce, 'baselineSha256': pin, 'units': units}
        body = encoded(validate_stop_receipts(value, self.load(pin), pin))
        new_file(self.directory / 'stopped-main.json', body)

    def load_stop_receipts(self, pin):
        baseline = self.load(pin)
        value = json.loads(secure_read(self.directory / 'stopped-main.json', 0o600))
        return validate_stop_receipts(value, baseline, pin)['units']

    def phase(self):
        value = json.loads(secure_read(self.directory / 'state.json', 0o600))
        demand(type(value) is dict and set(value) == {'phase'} and value['phase'] in (
            'captured', 'pausing', 'paused', 'restoring', 'restore-failed', 'restored'), 'invalid_phase')
        return value['phase']

    def save_phase(self, phase):
        temporary = self.directory / 'state.next'
        if temporary.exists() or temporary.is_symlink():
            # A killed writer may leave this private, mutable staging file. Baseline is never replaced.
            secure_read(temporary, 0o600)
            os.unlink(temporary)
        new_file(temporary, encoded({'phase': phase}))
        destination = self.directory / 'state.json'
        if destination.exists() or destination.is_symlink():
            secure_read(destination, 0o600)
        os.replace(temporary, destination)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def save_diagnostic(self, value):
        demand(type(value) is dict and value.get('version') == 1 and value.get('nonce') == self.nonce
               and value.get('scope') == 'resource-only'
               and value.get('kind') in ('capture-busy', 'capture-active-state', 'capture-configuration',
                                         'pause-baseline-state'), 'invalid_diagnostic_identity')
        body = encoded(value)
        demand(len(body) <= MAX_BYTES, 'diagnostic_byte_limit')
        secure_directory(self.directory, 0o700)
        # First refusal is immutable evidence, never a replacement baseline or a retry approval.
        new_file(self.directory / (value['kind'] + '.json'), body)
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class Maintenance:
    def __init__(self, host, store, clock):
        self.host, self.store, self.clock = host, store, clock
        self.nonce = store.nonce

    def diagnostic(self, kind, reference, measured, samples, pin=None, jobs=()):
        units = {}
        for unit, record in measured.items():
            # Only the existing redacted unit record is persisted; no environment or process argv.
            clean = lambda r: {'active': r['active'], 'sub': r['sub'], 'pid': r['pid'], 'group': r['group'],
                'config': {'sha256': r['config']['sha256'], 'files': [
                    {'path': p['path'], 'sha256': p['sha256']} for p in r['config']['files']]}}
            units[unit] = {'captured': clean(reference[unit]), 'measured': clean(record),
                           'measuredMonotonicUs': samples[unit][0], 'measuredAtUnixMs': samples[unit][1]}
        self.store.save_diagnostic({'version': 1, 'nonce': self.nonce, 'scope': 'resource-only',
            'kind': kind, 'baselineSha256': pin,
            'referenceKind': 'committed-baseline' if pin is not None else 'uncommitted-initial-measurement',
            'recordedMonotonicUs': self.clock.mono(), 'recordedAtUnixMs': self.clock.unix(), 'units': units,
            'jobs': [{'unit': j['unit'], 'kind': j['kind'], 'state': j['state']} for j in jobs]})

    def capture_units(self):
        deadline = min(self.clock.mono() + CAPTURE_BUSY_SECONDS * 1000000,
                       getattr(self.host, 'deadline', self.clock.mono() + CAPTURE_BUSY_SECONDS * 1000000))
        reference = None
        latest, samples, jobs = {}, {}, []
        while True:
            if self.clock.mono() >= deadline:
                self.diagnostic('capture-busy', reference, latest, samples, jobs=jobs)
                raise Refused('capture_busy_deadline')
            latest, samples = {}, {}
            for unit in UNITS:
                demand(self.clock.mono() < deadline, 'capture_busy_deadline')
                latest[unit] = self.host.unit(unit)
                samples[unit] = (self.clock.mono(), self.clock.unix())
            jobs = self.host.jobs()
            # Only known sync startup jobs may drain naturally; never cancel jobs or wait on backups.
            demand(all(j['unit'] in CAPTURE_SYNC_SERVICES and j['kind'] == 'start'
                       and j['state'] in ('running', 'waiting') for j in jobs), 'inflight_managed_job')
            if reference is None:
                reference = latest
            for unit in UNITS:
                current, initial = latest[unit], reference[unit]
                if current['config'] != initial['config']:
                    self.diagnostic('capture-configuration', reference, latest, samples, jobs=jobs)
                    raise Refused('capture_configuration_changed:' + unit)
                if ((unit in TIMERS and current['active'] != initial['active'])
                        or (unit in MAIN + PROTECTED and current != initial)):
                    self.diagnostic('capture-active-state', reference, latest, samples, jobs=jobs)
                    raise Refused('capture_active_state_changed:' + unit)
            demand(all(latest[u]['active'] in ('inactive', 'failed') and latest[u]['pid'] == 0
                       for u in AUX if u not in CAPTURE_SYNC_SERVICES), 'inflight_auxiliary')
            busy = bool(jobs) or any((latest[u]['active'], latest[u]['sub']) == ('active', 'running')
                                    for u in CAPTURE_SYNC_TIMERS)
            for unit in CAPTURE_SYNC_SERVICES:
                record = latest[unit]
                if record['active'] in ('active', 'activating'):
                    demand(record['sub'] in ('running', 'start', 'start-pre', 'start-post'), 'unknown_unit_state')
                    busy = True
                else:
                    demand(record['active'] in ('inactive', 'failed') and record['pid'] == 0, 'inflight_auxiliary')
                if reference[unit]['active'] == 'failed':
                    demand(record == reference[unit], 'capture_failed_auxiliary_changed')
            if not busy:
                demand(self.clock.mono() < deadline, 'capture_busy_deadline')
                return latest
            self.clock.sleep(min(0.1, max(0, (deadline - self.clock.mono()) / 1000000)))

    def capture(self, helper):
        units = self.capture_units()
        for unit in MAIN:
            if units[unit]['active'] == 'active':
                self.host.gateway_false(units[unit])
        now = self.clock.mono()
        baseline = {'version': 1, 'nonce': self.nonce, 'scope': 'resource-only', 'formalFence': False,
            'productionMigrationAuthorized': False, 'gatewayDeliveryEnabled': False,
            'binding': self.host.binding(), 'capturedMonotonicUs': now, 'deadlineMonotonicUs': now + WINDOW_US,
            'capturedAtUnixMs': self.clock.unix(), 'helperSha256': digest(helper), 'units': units}
        validate_baseline(baseline, self.nonce)
        return self.store.create(baseline, helper)

    def bound(self, baseline):
        demand(self.host.binding() == baseline['binding'], 'boot_or_release_changed')

    def configuration(self, unit, baseline):
        current = self.host.unit(unit)
        demand(current['config'] == baseline['units'][unit]['config'], 'unit_configuration_changed:' + unit)
        return current

    def protected(self, baseline):
        errors = []
        for unit in PROTECTED:
            try:
                demand(self.host.unit(unit) == baseline['units'][unit], 'protected_unit_changed')
            except Exception:
                errors.append('protected_unit_changed:' + unit)
        return errors

    def armed(self, baseline, pin):
        timer, service = self.host.watchdog(self.nonce)
        demand(timer['LoadState'] == 'loaded' and timer['ActiveState'] == 'active'
               and timer['SubState'] == 'waiting' and timer['Transient'] == 'yes'
               and timer['AccuracyUSec'] == '1s' and timer['TimersCalendar'] == ''
               and timer['Triggers'] == 'address-radar-maintenance-' + self.nonce + '.service', 'watchdog_timer_not_armed')
        expected = ' '.join(arm_argv(self.nonce, pin)[9:])
        match = re.fullmatch(r'\{ path=/usr/bin/python3 ; argv\[\]=(.*?) ; ignore_errors=no ; [^{}\r\n]{1,2048} \}', service['ExecStart'])
        demand(match and match[1] == expected, 'watchdog_restore_command_not_bound')
        demand(service['LoadState'] == 'loaded' and service['ActiveState'] == 'inactive'
               and service['SubState'] == 'dead' and service['Transient'] == 'yes'
               and service['Type'] == 'oneshot' and service['User'] == 'root'
               and service['TimeoutStartUSec'] in ('4min', '240s') and service['Restart'] == 'no'
               and service['KillMode'] == 'control-group', 'watchdog_service_not_bounded')
        interval = re.fullmatch(r'\{ OnActiveUSec=(55min|3300s) ; next_elapse=([^;{}\r\n]{1,128})(?: ;)? \}',
                                timer['TimersMonotonic'])
        demand(interval and interval[2].strip() not in ('[n/a]', 'n/a', 'infinity', '0'), 'watchdog_timer_interval')
        entered = timer['ActiveEnterTimestampMonotonic']
        demand(entered.isdigit(), 'watchdog_monotonic_unknown')
        fire = int(entered) + WATCHDOG_US
        demand(baseline['capturedMonotonicUs'] <= int(entered) <= baseline['capturedMonotonicUs'] + 60 * 1000000
               and self.clock.mono() + 30 * 1000000 < fire
               and fire + RESTORE_SECONDS * 1000000 <= baseline['deadlineMonotonicUs'], 'watchdog_deadline_outside_window')

    def wait(self, predicate, seconds, reason, not_after_us=None):
        deadline = self.clock.mono() + seconds * 1000000
        if not_after_us is not None:
            deadline = min(deadline, not_after_us)
        if hasattr(self, 'window_deadline'):
            deadline = min(deadline, self.window_deadline)
        if hasattr(self, 'restore_deadline'):
            deadline = min(deadline, self.restore_deadline)
        operation_deadline = getattr(self.host, 'deadline', None)
        if operation_deadline is not None:
            deadline = min(deadline, operation_deadline)
            self.host.deadline = deadline
        try:
            while True:
                demand(self.clock.mono() < deadline, reason)
                accepted = predicate()
                # Queries and readiness checks consume the same original budget.
                demand(self.clock.mono() < deadline, reason)
                if accepted:
                    return
                self.clock.sleep(min(0.1, (deadline - self.clock.mono()) / 1000000))
        finally:
            if operation_deadline is not None:
                self.host.deadline = operation_deadline

    def auxiliary_quiet(self):
        return (not any(job['unit'] in AUX for job in self.host.jobs())
                and all(self.host.unit(unit)['active'] in ('inactive', 'failed')
                        and self.host.unit(unit)['pid'] == 0 for unit in AUX))

    def pause(self, pin):
        baseline = self.store.load(pin)
        self.window_deadline = baseline['deadlineMonotonicUs']
        self.pause_operation_deadline = min(self.window_deadline,
            getattr(self.host, 'deadline', self.clock.mono() + PAUSE_OPERATION_SECONDS * 1000000))
        if hasattr(self.host, 'deadline'):
            self.host.deadline = self.pause_operation_deadline
        self.bound(baseline)
        demand(self.clock.mono() < baseline['deadlineMonotonicUs'], 'window_expired')
        demand(self.store.phase() not in ('restored', 'restoring', 'restore-failed'), 'window_cannot_repause')
        self.armed(baseline, pin)
        demand(not self.protected(baseline), 'protected_unit_changed')
        if self.store.phase() == 'paused':
            demand(self.paused(baseline), 'paused_state_changed')
            return {'phase': 'paused', 'idempotent': True}
        demand(self.store.phase() == 'captured', 'partial_pause_requires_restore')
        demand(baseline['capturedMonotonicUs'] <= self.clock.mono() <= baseline['capturedMonotonicUs'] + 60 * 1000000,
               'capture_expired_before_first_pause')
        planned = {}
        for unit in MAIN + TIMERS:
            current = self.configuration(unit, baseline)
            observed = (self.clock.mono(), self.clock.unix())
            if (current['active'], current['sub']) != (baseline['units'][unit]['active'], baseline['units'][unit]['sub']):
                records, samples = {unit: current}, {unit: observed}
                if unit in TIMERS:
                    related = unit[:-6] + '.service'
                    records[related] = self.host.unit(related)
                    samples[related] = (self.clock.mono(), self.clock.unix())
                self.diagnostic('pause-baseline-state', baseline['units'], records, samples, pin,
                                self.host.jobs())
            demand((current['active'], current['sub']) == (baseline['units'][unit]['active'], baseline['units'][unit]['sub']),
                   'baseline_state_changed:' + unit)
            if unit in MAIN and current['active'] == 'active':
                demand(current['pid'] == baseline['units'][unit]['pid'], 'main_instance_changed_since_capture:' + unit)
                planned[unit] = self.host.stop_instance(unit, current)
        self.store.save_phase('pausing')
        first_stop = True
        commanded = {}
        def stop(unit):
            nonlocal first_stop
            if unit in MAIN:
                current = self.configuration(unit, baseline)
                witness = self.host.stop_instance(unit, current)
                demand(witness == planned[unit], 'main_instance_changed_before_stop:' + unit)
            if first_stop:
                fresh_until = baseline['capturedMonotonicUs'] + 60 * 1000000
                demand(baseline['capturedMonotonicUs'] <= self.clock.mono() < fresh_until,
                       'capture_expired_before_first_stop')
                # Bound the first systemctl dispatch by freshness AND the operation deadline.
                self.host.mutate('stop', unit, self.nonce, not_after_us=fresh_until)
                first_stop = False
            else:
                self.host.mutate('stop', unit, self.nonce)
            if unit in MAIN:
                commanded[unit] = witness
        try:
            for unit in TIMERS:
                if baseline['units'][unit]['active'] == 'active':
                    stop(unit)
            self.wait(lambda: all(self.host.unit(unit)['active'] != 'active' for unit in TIMERS), 20, 'timers_not_stopped')
            # Never stop/cancel a running backup or a queued oneshot: let the race drain naturally.
            self.wait(self.auxiliary_quiet, 30, 'auxiliary_race_not_drained')
            self.clock.sleep(0.1)
            demand(self.auxiliary_quiet(), 'auxiliary_race_reappeared')
            for unit in AUX:
                current = self.configuration(unit, baseline)
                demand((current['active'], current['sub']) == (baseline['units'][unit]['active'], baseline['units'][unit]['sub']),
                       'auxiliary_original_state_changed:' + unit)
            for unit in MAIN:
                if baseline['units'][unit]['active'] == 'active':
                    stop(unit)
            self.store.save_stop_receipts(pin, commanded)
            self.wait(lambda: self.paused(baseline, commanded), SERVICE_WAIT_SECONDS, 'services_or_children_not_stopped')
            self.bound(baseline)
            demand(not self.protected(baseline), 'protected_unit_changed')
            self.store.save_phase('paused')
            return {'phase': 'paused', 'idempotent': False}
        except BaseException as error:
            # Nested restore may use at most four minutes of the ORIGINAL pause
            # operation/window budget. Failure or retry never creates extra time.
            if hasattr(self.host, 'deadline'):
                self.host.deadline = min(self.pause_operation_deadline, self.window_deadline,
                    self.clock.mono() + RESTORE_SECONDS * 1000000)
            errors = self.restore(pin, False)
            reason = str(error) if isinstance(error, Refused) else type(error).__name__
            if not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,256}', reason):
                reason = type(error).__name__
            raise Refused('pause_failed:' + reason + ';restore_errors=' + ','.join(errors)) from error

    def paused(self, baseline, commanded=None):
        # The private completed phase records that the complete planned stop sequence succeeded.
        if commanded is None:
            commanded = (self.store.load_stop_receipts(digest(encoded(baseline)))
                         if self.store.phase() == 'paused' else {})
        if (any(job['unit'] in MAIN + TIMERS for job in self.host.jobs())
                or not self.auxiliary_quiet() or self.protected(baseline)):
            return False
        for unit in MAIN + TIMERS:
            current = self.configuration(unit, baseline)
            original = baseline['units'][unit]
            expected = ('inactive', 'dead') if original['active'] == 'active' else (original['active'], original['sub'])
            if current['pid'] != 0:
                return False
            if (current['active'], current['sub']) != expected:
                if (unit not in MAIN or original['active'] != 'active' or unit not in commanded
                        or not self.host.main_stop_143(unit, current, original, commanded[unit])):
                    return False
            if unit in MAIN and not self.host.group_empty(original):
                return False
        return True

    def restore(self, pin, watchdog=False):
        baseline = self.store.load(pin)
        self.bound(baseline)
        if watchdog:
            demand(self.host.is_watchdog_process(self.nonce), 'watchdog_invocation_not_independent')
        self.window_deadline = baseline['deadlineMonotonicUs']
        self.restore_deadline = min(self.window_deadline, self.clock.mono() + RESTORE_SECONDS * 1000000,
                                    getattr(self.host, 'deadline', self.window_deadline))
        if hasattr(self.host, 'deadline'):
            self.host.deadline = self.restore_deadline
        self.store.save_phase('restoring')
        errors = []
        started = set()
        startup_deadlines = {}
        dispatch_failed = set()
        # Dispatch all original MAIN starts before waiting on scanner readiness.
        # Each service retains its own first-dispatch deadline; no retry extends it.
        for unit in MAIN:
            if baseline['units'][unit]['active'] != 'active':
                continue
            try:
                demand(self.clock.mono() < self.restore_deadline, 'operation_deadline')
                current = self.configuration(unit, baseline)
                startup_deadlines[unit] = min(self.restore_deadline,
                    self.clock.mono() + SERVICE_WAIT_SECONDS * 1000000)
                if current['active'] != 'active':
                    self.host.mutate('start', unit, self.nonce)
                    started.add(unit)
            except Exception as error:
                dispatch_failed.add(unit)
                errors.append(unit + ':' + (str(error) if isinstance(error, Refused) else type(error).__name__))
        # Failed/inactive oneshots are never started, and protected services are never mutated.
        for unit in MAIN + AUX + TIMERS:
            if unit in dispatch_failed:
                continue
            try:
                demand(self.clock.mono() < self.restore_deadline, 'operation_deadline')
                current = self.configuration(unit, baseline)
                original = baseline['units'][unit]
                if original['active'] == 'active' and unit not in AUX:
                    if current['active'] != 'active' and unit not in started:
                        self.host.mutate('start', unit, self.nonce)
                    def verified(unit=unit, original=original):
                        value = self.configuration(unit, baseline)
                        if (value['active'], value['sub']) != (original['active'], original['sub']):
                            return False
                        if unit not in MAIN:
                            return True
                        try:
                            self.host.gateway_false(value)
                        except Refused as error:
                            if str(error) in ('gateway_flag_missing', 'gateway_process_missing',
                                              'gateway_process_reused', 'gateway_process_transition'):
                                if self.host.simple_startup(unit, value):
                                    return False
                            raise
                        except (FileNotFoundError, ProcessLookupError):
                            if self.host.simple_startup(unit, value):
                                return False
                            raise
                        after = self.configuration(unit, baseline)
                        return ((after['active'], after['sub']) == (original['active'], original['sub'])
                                and after['pid'] == value['pid'] and value['pid'] > 0)
                    self.wait(verified, SERVICE_WAIT_SECONDS if unit in MAIN else 10,
                              'unit_restore_timeout', startup_deadlines.get(unit, self.restore_deadline))
                else:
                    timer = unit[:-8] + '.timer' if unit in AUX else None
                    # A restored two-second timer may naturally run its oneshot. Never start/reset it ourselves.
                    scheduled = (timer in TIMERS and baseline['units'][timer]['active'] == 'active'
                                 and self.configuration(timer, baseline)['active'] == 'active')
                    if not scheduled:
                        demand((current['active'], current['sub']) == (original['active'], original['sub'])
                               and current['pid'] == 0, 'inactive_or_failed_original_state_changed')
            except Exception as error:
                errors.append(unit + ':' + (str(error) if isinstance(error, Refused) else type(error).__name__))
        errors.extend(self.protected(baseline))
        try:
            self.bound(baseline)
        except Exception:
            errors.append('boot_or_release_changed')
        if not errors:
            try:
                name = 'address-radar-maintenance-' + self.nonce
                if not self.host.watchdog_disarmed(self.nonce, 'timer'):
                    self.host.mutate('stop', name + '.timer', self.nonce)
                    self.wait(lambda: self.host.watchdog_disarmed(self.nonce, 'timer'), 5, 'watchdog_timer_not_disarmed')
                if not watchdog and not self.host.watchdog_disarmed(self.nonce, 'service'):
                    self.host.mutate('stop', name + '.service', self.nonce)
                    self.wait(lambda: self.host.watchdog_disarmed(self.nonce, 'service'), 5, 'watchdog_service_not_disarmed')
            except Exception as error:
                errors.append('watchdog_disarm:' + (str(error) if isinstance(error, Refused) else type(error).__name__))
        self.store.save_phase('restore-failed' if errors else 'restored')
        return errors

    def status(self, pin):
        baseline = self.store.load(pin)
        self.bound(baseline)
        return {'phase': self.store.phase(), 'nonce': self.nonce, 'scope': 'resource-only',
                'formalFence': False, 'productionMigrationAuthorized': False,
                'remainingSeconds': max(0, (baseline['deadlineMonotonicUs'] - self.clock.mono()) // 1000000),
                'units': {unit: {key: self.host.unit(unit)[key] for key in ('active', 'sub', 'pid')} for unit in UNITS}}


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    for action in ('capture', 'pause', 'restore', 'status'):
        command = commands.add_parser(action)
        command.add_argument('--nonce', required=True)
        if action != 'capture':
            command.add_argument('--baseline-sha256', required=True)
        if action == 'restore':
            command.add_argument('--watchdog', action='store_true')
    args = parser.parse_args()
    demand(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux_root_required')
    demand(Path('/proc/1/comm').read_text().strip() == 'systemd', 'independent_systemd_required')
    os.umask(0o077)
    clock = Clock()
    budget = (PAUSE_OPERATION_SECONDS if args.action == 'pause' else
              RESTORE_SECONDS if args.action == 'restore' else READ_OPERATION_SECONDS)
    host = SystemdHost(clock, budget)
    store = RootStorage(args.nonce)
    if args.action == 'capture':
        store.initialize()
    def interrupted(_signum, _frame):
        raise Refused('maintenance_interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    with store.lock(clock, 30):
        maintenance = Maintenance(host, store, clock)
        if args.action == 'capture':
            helper = secure_read(Path(__file__).absolute())
            pin = maintenance.capture(helper)
            output = {'status': 'captured', 'nonce': args.nonce, 'baselineSha256': pin,
                      'armArgv': arm_argv(args.nonce, pin), 'pauseRequiresVerifiedIndependentWatchdog': True,
                      'formalFence': False, 'productionMigrationAuthorized': False}
        elif args.action == 'pause':
            output = maintenance.pause(args.baseline_sha256)
        elif args.action == 'restore':
            errors = maintenance.restore(args.baseline_sha256, args.watchdog)
            demand(not errors, 'restore_failed:' + ','.join(errors))
            output = {'status': 'restored', 'formalFence': False, 'productionMigrationAuthorized': False}
        else:
            output = maintenance.status(args.baseline_sha256)
    print(json.dumps(output, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        cli()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': str(error) if isinstance(error, Refused) else type(error).__name__,
                          'formalFence': False, 'productionMigrationAuthorized': False}, separators=(',', ':')), file=sys.stderr)
        sys.exit(1)
