#!/usr/bin/env python3
import contextlib
import copy
import importlib.util
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).resolve().parents[1] / 'preservation-maintenance-window.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeClock:
    def __init__(self):
        self.now = 1000000000

    def mono(self):
        return self.now

    def unix(self):
        return 1800000000000

    def sleep(self, seconds):
        self.now += int(seconds * 1000000)


class MemoryStorage:
    def __init__(self):
        self.nonce = '0123456789abcdef'
        self.baseline = None
        self.current = None

    def create(self, baseline, helper):
        m.demand(self.baseline is None, 'immutable_baseline_exists')
        self.baseline = copy.deepcopy(m.validate_baseline(baseline, self.nonce))
        self.pin = m.digest(m.encoded(self.baseline))
        self.helper = helper
        self.current = 'captured'
        return self.pin

    def load(self, expected):
        m.demand(expected == self.pin and m.digest(m.encoded(self.baseline)) == expected, 'baseline_digest_mismatch')
        m.demand(m.digest(self.helper) == self.baseline['helperSha256'], 'helper_digest_mismatch')
        return copy.deepcopy(m.validate_baseline(self.baseline, self.nonce))

    def phase(self):
        return self.current

    def save_phase(self, value):
        self.current = value

    def save_diagnostic(self, value):
        if not hasattr(self, 'diagnostics'):
            self.diagnostics = []
        self.diagnostics.append(copy.deepcopy(value))


    def save_stop_receipts(self, pin, units):
        m.demand(not hasattr(self, 'stop_receipts'), 'stop_receipts_already_exist')
        value = {'version': 1, 'nonce': self.nonce, 'baselineSha256': pin, 'units': copy.deepcopy(units)}
        self.stop_receipts = m.validate_stop_receipts(value, self.load(pin), pin)

    def load_stop_receipts(self, pin):
        return copy.deepcopy(m.validate_stop_receipts(self.stop_receipts, self.load(pin), pin)['units'])


class FakeSystemd:
    def __init__(self, clock, store):
        self.clock, self.store = clock, store
        self.identity = {'bootId': '01234567-89ab-cdef-0123-456789abcdef',
                         'releasePath': m.RESOURCE_RELEASE,
                         'releaseLink': 'releases/4b48fc2-forward-token-code', 'releaseIdentity': [1, 2, 997, 987, 0o755],
                         'serviceAccount': dict(m.RESOURCE_ACCOUNT)}
        self.records = {}
        for index, unit in enumerate(m.UNITS):
            active, sub, pid = ('active', 'waiting', 0) if unit in m.TIMERS else (
                ('inactive', 'dead', 0) if unit in m.AUX else ('active', 'running', 100 + index))
            if unit == 'fomo-radar-protocol-audit.service':
                active, sub = 'failed', 'failed'
            self.records[unit] = {'active': active, 'sub': sub, 'pid': pid,
                'group': '/system.slice/' + unit if unit.endswith('.service') else '',
                'config': {'sha256': 'e' * 64, 'files': [{'path': '/etc/systemd/system/' + unit, 'sha256': 'f' * 64}]}}
        self.calls = []
        self.failures = set()
        self.gateway_enabled = False
        self.children = set()
        self.job_records = []
        self.race = None
        self.race_until = None
        self.scheduled_aux = False
        self.watchdog_identity = False
        self.timer = {'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'waiting', 'Transient': 'yes',
            'AccuracyUSec': '1s', 'TimersMonotonic': '{ OnActiveUSec=55min ; next_elapse=55min ; }',
            'TimersCalendar': '', 'ActiveEnterTimestampMonotonic': str(clock.mono()),
            'Triggers': 'address-radar-maintenance-' + store.nonce + '.service'}
        self.service = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead', 'Transient': 'yes',
            'Type': 'oneshot', 'User': 'root', 'TimeoutStartUSec': '4min', 'Restart': 'no', 'KillMode': 'control-group'}

    def bind_watchdog(self, pin):
        argv = ' '.join(m.arm_argv(self.store.nonce, pin)[9:])
        self.service['ExecStart'] = '{ path=/usr/bin/python3 ; argv[]=' + argv + ' ; ignore_errors=no ; start_time=[n/a] ; }'

    def settle(self):
        if self.race is not None and self.race_until is not None and self.clock.mono() >= self.race_until:
            self.records[self.race].update(active='inactive', sub='dead', pid=0)
            self.job_records = []
            self.race = None

    def unit(self, unit):
        m.demand(unit in m.UNITS, 'unknown_unit')
        self.settle()
        return copy.deepcopy(self.records[unit])

    def binding(self):
        return copy.deepcopy(self.identity)

    def gateway_false(self, record):
        m.demand(not self.gateway_enabled and record['pid'] > 0, 'gateway_not_disabled')
        return {'pid': record['pid'], 'startTime': '1234', 'exeSha256': 'a' * 64}

    def stop_instance(self, unit, current):
        raw = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': current['active'],
               'SubState': current['sub'], 'MainPID': str(current['pid']),
               'ExecMainStartTimestampMonotonic': str(self.store.baseline['units'][unit]['pid'] * 1000000)}
        adapter = SimpleNamespace(show=lambda name, properties: raw, gateway_false=self.gateway_false)
        return m.SystemdHost.stop_instance(adapter, unit, current)

    def simple_startup(self, unit, current):
        raw = {'Id': unit, 'LoadState': 'loaded', 'Type': getattr(self, 'service_types', {}).get(unit, 'simple'),
               'MainPID': str(current['pid'])}
        return m.SystemdHost.simple_startup(SimpleNamespace(show=lambda name, properties: raw), unit, current)

    def main_stop_143(self, unit, current, original, receipt):
        facts = dict(getattr(self, 'exit_facts', {}).get(unit, {'Result': 'exit-code',
                     'ExecMainCode': '1', 'ExecMainStatus': '143'}))
        facts['ExecMainStartTimestampMonotonic'] = str(self.store.baseline['units'][unit]['pid'] * 1000000)
        facts.update(Id=unit, LoadState='loaded', ActiveState=current['active'],
                     SubState=current['sub'], MainPID=str(current['pid']), ControlGroup=current['group'])
        adapter = SimpleNamespace(show=lambda name, properties: facts,
                                  group_empty=self.group_empty, jobs=self.jobs)
        return m.SystemdHost.main_stop_143(adapter, unit, current, original, receipt)

    def group_empty(self, record):
        return record['group'] not in self.children

    def jobs(self):
        self.settle()
        return copy.deepcopy(self.job_records)

    def watchdog(self, nonce):
        m.checked_nonce(nonce)
        return copy.deepcopy(self.timer), copy.deepcopy(self.service)

    def watchdog_disarmed(self, nonce, kind):
        values = dict(self.timer if kind == 'timer' else self.service)
        values['Id'] = 'address-radar-maintenance-' + nonce + '.' + kind
        adapter = SimpleNamespace(show=lambda unit, properties: values)
        return m.SystemdHost.watchdog_disarmed(adapter, nonce, kind)

    def is_watchdog_process(self, nonce):
        return self.watchdog_identity

    def mutate(self, action, unit, nonce, not_after_us=None):
        if not_after_us is not None:
            m.demand(self.clock.mono() < not_after_us, "first_command_freshness_deadline")
        watchdog = 'address-radar-maintenance-' + nonce
        m.demand(unit in m.MAIN + m.TIMERS or (action == 'stop' and unit in (watchdog + '.timer', watchdog + '.service')),
                 'forbidden_unit_mutation')
        self.calls.append((action, unit))
        if (action, unit) in self.failures:
            raise m.Refused('injected_stop_or_start_failure')
        if unit == watchdog + '.timer':
            self.timer.update(ActiveState='inactive', SubState='dead')
        elif unit == watchdog + '.service':
            self.service.update(ActiveState='inactive', SubState='dead')
        elif action == 'stop':
            self.records[unit].update(active='inactive', sub='dead', pid=0)
            if unit in m.TIMERS and self.race:
                self.records[self.race].update(active='active', sub='running', pid=999)
                self.job_records = [{'unit': self.race, 'kind': 'start', 'state': 'running'}]
        else:
            self.records[unit].update(active='active', sub='waiting' if unit in m.TIMERS else 'running',
                                      pid=0 if unit in m.TIMERS else 777)
            if unit in m.TIMERS and self.scheduled_aux:
                self.records[unit[:-6] + '.service'].update(active='active', sub='running', pid=888)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = MemoryStorage()
        self.host = FakeSystemd(self.clock, self.store)
        self.controller = m.Maintenance(self.host, self.store, self.clock)
        self.pin = self.controller.capture(b'explicit-test-only-helper')
        self.host.bind_watchdog(self.pin)

    def test_exact_scope_and_resource_only_baseline(self):
        self.assertEqual((len(m.MAIN), len(m.TIMERS), len(m.AUX), len(m.PROTECTED)), (6, 5, 5, 3))
        baseline = self.store.load(self.pin)
        self.assertFalse(baseline['formalFence'])
        self.assertFalse(baseline['productionMigrationAuthorized'])
        self.assertFalse(baseline['gatewayDeliveryEnabled'])
        self.assertEqual(baseline['deadlineMonotonicUs'] - baseline['capturedMonotonicUs'], m.WINDOW_US)

    def test_watchdog_is_verified_before_any_stop(self):
        for field, value in [('ActiveState', 'inactive'), ('AccuracyUSec', '1min'), ('Transient', 'no'),
                             ('TimersMonotonic', '{ OnBootUSec=55min ; }'), ('TimersCalendar', '*-*-* *:*:00')]:
            with self.subTest(field=field):
                old = self.host.timer[field]
                self.host.timer[field] = value
                with self.assertRaises(m.Refused):
                    self.controller.pause(self.pin)
                self.host.timer[field] = old
                self.assertEqual(self.host.calls, [])

    def test_watchdog_service_pins_timeout_and_command(self):
        for field, value in [('User', 'ubuntu'), ('TimeoutStartUSec', '10min'), ('Type', 'simple'),
                             ('ExecStart', '{ path=/bin/sh ; argv[]=/bin/sh -c true ; ignore_errors=no ; x ; }'),
                             ('Restart', 'on-failure'), ('ActiveState', 'active')]:
            with self.subTest(field=field):
                old = self.host.service[field]
                self.host.service[field] = value
                with self.assertRaises(m.Refused):
                    self.controller.pause(self.pin)
                self.host.service[field] = old
                self.assertEqual(self.host.calls, [])

    def test_late_watchdog_cannot_extend_sixty_minutes(self):
        self.host.timer['ActiveEnterTimestampMonotonic'] = str(self.clock.mono() + 61000000)
        with self.assertRaises(m.Refused):
            self.controller.pause(self.pin)
        self.assertEqual(self.host.calls, [])

    def test_pause_timer_first_and_restore_service_first(self):
        self.controller.pause(self.pin)
        self.assertEqual(self.host.calls[:5], [('stop', unit) for unit in m.TIMERS])
        self.assertEqual(self.host.calls[5:11], [('stop', unit) for unit in m.MAIN])
        self.assertEqual(self.controller.restore(self.pin), [])
        starts = [unit for action, unit in self.host.calls if action == 'start']
        self.assertEqual(starts, list(m.MAIN + m.TIMERS))
        self.assertEqual(self.store.phase(), 'restored')
        self.assertEqual(self.host.records[m.AUX[-1]]['active'], 'failed')
        self.assertFalse(any(unit in m.PROTECTED + m.AUX for _, unit in self.host.calls))

    def test_pause_idempotence_and_no_replay_after_restore(self):
        self.controller.pause(self.pin)
        calls = len(self.host.calls)
        self.assertTrue(self.controller.pause(self.pin)['idempotent'])
        self.assertEqual(len(self.host.calls), calls)
        self.controller.restore(self.pin)
        with self.assertRaises(m.Refused):
            self.controller.pause(self.pin)

    def test_restore_before_pause_and_repeat_are_idempotent(self):
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertFalse(any(action == 'start' for action, _ in self.host.calls))

    def test_inactive_and_failed_main_units_are_never_started(self):
        for unit, active, sub in [(m.MAIN[0], 'inactive', 'dead'), (m.MAIN[1], 'failed', 'failed')]:
            self.host.records[unit].update(active=active, sub=sub, pid=0)
        self.store = MemoryStorage()
        self.host.store = self.store
        self.controller = m.Maintenance(self.host, self.store, self.clock)
        self.pin = self.controller.capture(b'test-helper')
        self.host.bind_watchdog(self.pin)
        self.controller.pause(self.pin)
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertFalse(any(unit in m.MAIN[:2] for _, unit in self.host.calls))

    def test_partial_stop_failure_restores_and_propagates(self):
        self.host.failures.add(('stop', m.MAIN[2]))
        with self.assertRaisesRegex(m.Refused, 'pause_failed'):
            self.controller.pause(self.pin)
        self.assertEqual(self.store.phase(), 'restored')
        self.assertTrue(all(self.host.records[unit]['active'] == 'active' for unit in m.MAIN + m.TIMERS))

    def test_restore_aggregates_failures_and_keeps_watchdog(self):
        self.controller.pause(self.pin)
        self.host.failures.update({('start', m.MAIN[0]), ('start', m.MAIN[2])})
        errors = self.controller.restore(self.pin)
        self.assertEqual(len(errors), 2)
        self.assertTrue(any(m.MAIN[0] in error for error in errors))
        self.assertTrue(any(m.MAIN[2] in error for error in errors))
        self.assertEqual(self.host.timer['ActiveState'], 'active')
        self.assertEqual(self.store.phase(), 'restore-failed')
        self.host.failures.clear()
        self.assertEqual(self.controller.restore(self.pin), [])

    def test_partial_timer_stop_failure_also_restores(self):
        self.host.failures.add(('stop', m.TIMERS[2]))
        with self.assertRaises(m.Refused):
            self.controller.pause(self.pin)
        self.assertEqual(self.store.phase(), 'restored')
        self.assertFalse(any(action == 'stop' and unit in m.MAIN for action, unit in self.host.calls))

    def test_running_backup_at_capture_is_refused_without_stop(self):
        self.host.records[m.AUX[0]].update(active='active', sub='running', pid=999)
        store = MemoryStorage()
        controller = m.Maintenance(self.host, store, self.clock)
        with self.assertRaisesRegex(m.Refused, 'inflight_auxiliary'):
            controller.capture(b'test-helper')
        self.assertEqual(self.host.calls, [])

    def test_timer_triggered_backup_race_drains_without_killing(self):
        self.host.race = m.AUX[0]
        self.host.race_until = self.clock.mono() + 1000000
        self.controller.pause(self.pin)
        self.assertFalse(any(unit in m.AUX for _, unit in self.host.calls))

    def test_non_draining_backup_race_refuses_and_restores_timers_without_killing(self):
        self.host.race = m.AUX[0]
        with self.assertRaisesRegex(m.Refused, 'pause_failed'):
            self.controller.pause(self.pin)
        self.assertGreaterEqual(self.clock.mono(), 1030000000)
        self.assertTrue(all(self.host.records[unit]['active'] == 'active' for unit in m.TIMERS))
        self.assertFalse(any(unit in m.AUX for _, unit in self.host.calls))

    def test_restored_two_second_timers_can_naturally_activate_oneshots(self):
        self.controller.pause(self.pin)
        self.host.scheduled_aux = True
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertTrue(all(self.host.records[unit]['active'] == 'active' for unit in m.AUX))
        self.assertFalse(any(unit in m.AUX for _, unit in self.host.calls))

    def test_boot_release_and_gateway_changes_fail_closed(self):
        for field, changed in [('bootId', '12345678-89ab-cdef-0123-456789abcdef'),
                               ('releasePath', '/opt/address-radar/releases/new-release')]:
            old = self.host.identity[field]
            self.host.identity[field] = changed
            with self.assertRaises(m.Refused):
                self.controller.pause(self.pin)
            with self.assertRaises(m.Refused):
                self.controller.restore(self.pin)
            self.host.identity[field] = old
        self.host.gateway_enabled = True
        with self.assertRaisesRegex(m.Refused, 'gateway_not_disabled'):
            self.controller.pause(self.pin)
        self.assertEqual(self.host.calls, [])

    def test_protected_state_change_is_not_silently_repaired(self):
        self.host.records[m.PROTECTED[0]]['pid'] += 1
        with self.assertRaises(m.Refused):
            self.controller.pause(self.pin)
        errors = self.controller.restore(self.pin)
        self.assertTrue(any(m.PROTECTED[0] in error for error in errors))
        self.assertFalse(any(unit in m.PROTECTED for _, unit in self.host.calls))
        self.assertEqual(self.host.timer['ActiveState'], 'active')

    def test_baseline_digest_helper_and_unknown_fields_are_refused(self):
        with self.assertRaises(m.Refused):
            self.controller.pause('0' * 64)
        self.store.helper += b'changed'
        with self.assertRaises(m.Refused):
            self.controller.restore(self.pin)
        baseline = copy.deepcopy(self.store.baseline)
        for changed in [dict(baseline, version=True), dict(baseline, formalFence=True), dict(baseline, unexpected=True)]:
            with self.assertRaises(m.Refused):
                m.validate_baseline(changed, self.store.nonce)

    def test_unknown_units_paths_counts_and_states_are_refused(self):
        for mutate in [lambda b: b['units'].update({'unknown.service': b['units'][m.MAIN[0]]}),
                       lambda b: b['units'][m.MAIN[0]].update(active='activating', sub='start'),
                       lambda b: b['units'][m.MAIN[0]]['config']['files'][0].update(path='/tmp/unsafe.env'),
                       lambda b: b.update(deadlineMonotonicUs=b['deadlineMonotonicUs'] + 1)]:
            baseline = copy.deepcopy(self.store.baseline)
            mutate(baseline)
            with self.assertRaises(m.Refused):
                m.validate_baseline(baseline, self.store.nonce)
        for value in ['../escape', 'F' * 16, '0123456789abcdef/suffix', '', []]:
            with self.assertRaises(m.Refused):
                m.checked_nonce(value)

    def test_children_must_drain_before_pause_success(self):
        self.host.children.add('/system.slice/' + m.MAIN[0])
        with self.assertRaises(m.Refused):
            self.controller.pause(self.pin)
        self.assertEqual(self.store.phase(), 'restored')

    def test_watchdog_restore_requires_actual_independent_process_identity(self):
        self.controller.pause(self.pin)
        with self.assertRaises(m.Refused):
            self.controller.restore(self.pin, True)
        self.host.watchdog_identity = True
        self.host.service.update(ActiveState='active', SubState='start')
        self.assertEqual(self.controller.restore(self.pin, True), [])
        self.assertNotIn(('stop', 'address-radar-maintenance-' + self.store.nonce + '.service'), self.host.calls)

    def test_configuration_changes_do_not_start_substituted_release_commands(self):
        self.controller.pause(self.pin)
        self.host.records[m.MAIN[0]]['config']['sha256'] = '0' * 64
        errors = self.controller.restore(self.pin)
        self.assertTrue(any(m.MAIN[0] in error for error in errors))
        self.assertNotIn(('start', m.MAIN[0]), self.host.calls)
        self.assertEqual(self.host.timer['ActiveState'], 'active')

    def test_failed_watchdog_disarm_is_not_reported_as_restore_success(self):
        self.controller.pause(self.pin)
        self.host.failures.add(('stop', 'address-radar-maintenance-' + self.store.nonce + '.timer'))
        self.assertTrue(any('watchdog_disarm' in error for error in self.controller.restore(self.pin)))
        self.assertEqual(self.store.phase(), 'restore-failed')

    def test_capture_expires_at_sixty_seconds_before_first_pause_without_stopping(self):
        self.clock.sleep(60.001)
        with self.assertRaisesRegex(m.Refused, 'capture_expired'):
            self.controller.pause(self.pin)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.store.phase(), 'captured')

    def test_systemd_255_watchdog_show_fields_and_volatile_metadata_are_parsed(self):
        self.host.timer['TimersMonotonic'] = '{ OnActiveUSec=55min ; next_elapse=4h 31min 12.987654s }'
        argv = ' '.join(m.arm_argv(self.store.nonce, self.pin)[9:])
        self.host.service['ExecStart'] = ('{ path=/usr/bin/python3 ; argv[]=' + argv +
            ' ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }')
        self.controller.armed(self.store.load(self.pin), self.pin)
        self.host.service['ExecStart'] = ('{ path=/usr/bin/python3 ; argv[]=' + argv +
            ' ; ignore_errors=no ; start_time=[Sun 2026-10-04 12:00:00 UTC] ; stop_time=[Sun 2026-10-04 12:00:01 UTC] ; pid=123 ; code=exited ; status=0 }')
        self.controller.armed(self.store.load(self.pin), self.pin)

    def test_watchdog_rejects_extra_intervals_commands_or_substituted_argv(self):
        original = self.host.timer['TimersMonotonic']
        for value in ['{ OnActiveUSec=55min 5h ; next_elapse=6h }',
                      '{ OnActiveUSec=55min ; next_elapse=55min } { OnBootUSec=55min ; next_elapse=55min }',
                      '{ OnActiveUSec=55min ; next_elapse=infinity }']:
            self.host.timer['TimersMonotonic'] = value
            with self.assertRaisesRegex(m.Refused, 'watchdog_timer_interval'):
                self.controller.armed(self.store.load(self.pin), self.pin)
        self.host.timer['TimersMonotonic'] = original
        original = self.host.service['ExecStart']
        for value in [original + ' { path=/bin/sh ; argv[]=/bin/sh -c true ; ignore_errors=no ; x ; }',
                      original.replace(self.pin, '0' * 64), original.replace('--watchdog', '--unsafe')]:
            self.host.service['ExecStart'] = value
            with self.assertRaisesRegex(m.Refused, 'watchdog_restore_command'):
                self.controller.armed(self.store.load(self.pin), self.pin)

    def stable_unit_adapter(self):
        unit = m.MAIN[0]
        raw = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running',
               'MainPID': '123', 'ControlGroup': '/system.slice/' + unit,
               'FragmentPath': '/etc/systemd/system/' + unit,
               'DropInPaths': '',
               'EnvironmentFiles': '/etc/address-radar/address-radar.env (ignore_errors=no)', 'Environment': 'PRIVATE_TOKEN=never-log-this ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false',
               'ExecStart': '{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/app.mjs ; ignore_errors=no ; start_time=[old] ; stop_time=[n/a] ; pid=123 ; code=(null) ; status=0/0 }',
               'PassEnvironment': '', 'KillMode': 'control-group', 'Type': 'simple', 'UnitFileState': 'enabled',
               'User': 'address-radar', 'Group': 'address-radar'}
        bodies = {raw['FragmentPath']: b'[Service]\nExecStart=/usr/bin/node /opt/app.mjs\n',
                  '/etc/address-radar/address-radar.env': b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false\n'}
        adapter = m.SystemdHost(self.clock, 120)
        def show(name, properties):
            self.assertEqual(name, unit)
            self.assertNotIn('ExecStart', properties)
            return {key: raw[key] for key in properties}
        return unit, raw, bodies, adapter, show

    def test_normal_stop_start_exec_metadata_changes_still_restore_with_static_file_binding(self):
        unit, raw, bodies, adapter, show = self.stable_unit_adapter()
        with patch.object(adapter, 'show', side_effect=show), patch.object(m, 'secure_read', side_effect=lambda path: bodies[path]):
            before = adapter.unit(unit)
            self.host.records[unit]['config'] = before['config']
            self.store = MemoryStorage()
            self.host.store = self.store
            self.controller = m.Maintenance(self.host, self.store, self.clock)
            self.pin = self.controller.capture(b'test-helper')
            self.host.bind_watchdog(self.pin)
            mutate = self.host.mutate
            def stop_start(action, target, nonce, not_after_us=None):
                mutate(action, target, nonce, not_after_us=not_after_us)
                if target == unit:
                    value = self.host.records[unit]
                    raw.update(ActiveState=value['active'], SubState=value['sub'], MainPID=str(value['pid']))
                    raw['ExecStart'] = '{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/app.mjs ; ignore_errors=no ; start_time=[new] ; stop_time=[new] ; pid=' + str(value['pid']) + ' ; code=exited ; status=0 }'
                    self.host.records[unit]['config'] = adapter.unit(unit)['config']
            with patch.object(self.host, 'mutate', side_effect=stop_start):
                self.controller.pause(self.pin)
                self.assertEqual(self.controller.restore(self.pin), [])
            self.assertEqual(before['config'], adapter.unit(unit)['config'])
            self.assertNotIn('never-log-this', m.encoded(before['config']).decode())
            self.assertNotIn('start_time', m.encoded(before['config']).decode())

    def test_real_fragment_dropin_or_static_environment_change_is_rejected(self):
        unit, raw, bodies, adapter, show = self.stable_unit_adapter()
        with patch.object(adapter, 'show', side_effect=show), patch.object(m, 'secure_read', side_effect=lambda path: bodies[path]):
            before = adapter.unit(unit)['config']
            self.host.records[unit]['config'] = before
            self.store = MemoryStorage()
            self.host.store = self.store
            self.controller = m.Maintenance(self.host, self.store, self.clock)
            self.pin = self.controller.capture(b'test-helper')
            self.host.bind_watchdog(self.pin)
            self.controller.pause(self.pin)
            bodies['/etc/address-radar/address-radar.env'] = b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false\nCHANGED=true\n'
            changed = adapter.unit(unit)['config']
            self.assertNotEqual(before, changed)
            self.host.records[unit]['config'] = changed
            errors = self.controller.restore(self.pin)
            self.assertTrue(any(unit in error for error in errors))
            self.assertNotIn(('start', unit), self.host.calls)
            self.assertEqual(self.host.timer['ActiveState'], 'active')
            bodies[raw['FragmentPath']] += b'Environment=CHANGED=true\n'
            self.assertNotEqual(before, adapter.unit(unit)['config'])
            raw['Environment'] = 'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=true'
            self.assertNotEqual(changed, adapter.unit(unit)['config'])

    def test_watchdog_arm_pin_and_restore_arguments_are_fixed_and_resource_only(self):
        argv = m.arm_argv(self.store.nonce, self.pin)
        self.assertEqual(argv[:4], ['/usr/bin/systemd-run', '--unit=address-radar-maintenance-' + self.store.nonce,
                                  '--on-active=55min', '--timer-property=AccuracySec=1s'])
        self.assertIn('--property=TimeoutStartSec=240s', argv)
        self.assertIn('--property=Restart=no', argv)
        self.assertEqual(argv[9:], ['/usr/bin/python3', str(m.ROOT / self.store.nonce / 'helper.py'),
                                   'restore', '--nonce', self.store.nonce, '--baseline-sha256', self.pin, '--watchdog'])

    def test_unknown_actual_systemctl_properties_and_missing_fields_are_rejected(self):
        adapter = m.SystemdHost(self.clock, 10)
        for value in ['Id=x\nUnexpected=true\n', 'Id=x\nId=x\n', 'NoEquals\n', '']:
            with patch.object(adapter, 'command', return_value=value):
                with self.assertRaises(m.Refused):
                    adapter.show(m.MAIN[0], ('Id', 'LoadState'))

    def test_first_stop_rechecks_freshness_after_all_configuration_scans(self):
        original = self.host.unit
        count = 0
        def slow_scan(unit):
            nonlocal count
            if unit in m.MAIN + m.TIMERS and count < 11:
                self.clock.sleep(6)
                count += 1
            return original(unit)
        with patch.object(self.host, 'unit', side_effect=slow_scan):
            with self.assertRaisesRegex(m.Refused, 'pause_failed') as caught:
                self.controller.pause(self.pin)
        self.assertIsInstance(caught.exception.__cause__, m.Refused)
        self.assertIn('capture_expired_before_first_stop', str(caught.exception.__cause__))
        self.assertFalse(any(unit in m.MAIN + m.TIMERS + m.AUX + m.PROTECTED for _, unit in self.host.calls))

    def test_first_stop_passes_freshness_to_systemctl_command_budget(self):
        mutate = self.host.mutate
        deadlines = []
        def bounded(action, unit, nonce, not_after_us=None):
            deadlines.append((action, unit, not_after_us))
            return mutate(action, unit, nonce, not_after_us=not_after_us)
        with patch.object(self.host, 'mutate', side_effect=bounded):
            self.controller.pause(self.pin)
        self.assertEqual(deadlines[0], ('stop', m.TIMERS[0], self.store.baseline['capturedMonotonicUs'] + 60000000))
        self.assertTrue(all(deadline is None for _, _, deadline in deadlines[1:]))
        adapter = m.SystemdHost(self.clock, 120)
        with patch.object(m.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(m.Refused, 'operation_deadline'):
                adapter.command(['--no-block', 'stop', m.TIMERS[0]], not_after_us=self.clock.mono())
            popen.assert_not_called()

    def test_precise_environment_mapping_does_not_allow_whole_fomo_directory(self):
        expected = {unit: ('/etc/address-radar/address-radar.env',) for unit in m.MAIN + ('address-radar-backup.service',)}
        expected.update({'fomo-address-radar-backup.service': ('/etc/fomo-radar/address-radar.env',),
                         'fomo-radar-protocol-audit.service': ('/etc/fomo-radar/radar.env',),
                         'fomo-radar-collector.service': ('/etc/fomo-radar/radar.env',)})
        self.assertEqual(m.ENV_FILES, expected)
        all_paths = set(path for paths in expected.values() for path in paths)
        for unit in m.UNITS:
            for path in all_paths:
                self.assertEqual(m.approved_config_path(path, unit), path in expected.get(unit, ()))
            self.assertFalse(m.approved_config_path('/etc/fomo-radar/other.env', unit))
            self.assertFalse(m.approved_config_path('/opt/address-radar/shared/.env', unit))
        drop_in = '/etc/systemd/system/address-radar-backup.timer.d/daily.conf'
        for unit in m.UNITS:
            self.assertEqual(m.approved_config_path(drop_in, unit), unit == 'address-radar-backup.timer')

    def test_real_timer_show_shape_never_requests_service_properties(self):
        adapter = m.SystemdHost(self.clock, 120)
        for unit in m.TIMERS:
            raw = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'waiting',
                   'FragmentPath': '/etc/systemd/system/' + unit,
                   'DropInPaths': ' '.join(m.DROP_INS.get(unit, ())), 'UnitFileState': 'enabled',
                   'Triggers': unit[:-6] + '.service'}
            requests = []
            def command(arguments):
                requests.append(arguments)
                self.assertIn('--all', arguments)
                properties = arguments[-1].split('=', 1)[1].split(',')
                self.assertEqual(set(properties), set(raw))
                self.assertTrue(set(properties).isdisjoint({'MainPID', 'ControlGroup', 'Environment', 'EnvironmentFiles',
                                                          'Type', 'PassEnvironment', 'KillMode'}))
                return ''.join(key + '=' + raw[key] + '\n' for key in properties)
            with patch.object(adapter, 'command', side_effect=command), patch.object(m, 'secure_read', return_value=b'approved static bytes'):
                result = adapter.unit(unit)
            self.assertEqual((result['pid'], result['group']), (0, ''))
            self.assertEqual(set(result['config']['files'][index]['path'] for index in range(len(result['config']['files']))),
                             {raw['FragmentPath']} | set(m.DROP_INS.get(unit, ())))
            self.assertEqual(len(requests), 1)

    def test_real_service_show_empty_arrays_require_all_and_missing_pid_still_fails_closed(self):
        unit, raw, _, adapter, _ = self.stable_unit_adapter()
        raw['PassEnvironment'] = ''
        raw['Environment'] = ''
        def command(arguments):
            self.assertIn('--all', arguments)
            properties = arguments[-1].split('=', 1)[1].split(',')
            return ''.join(key + '=' + raw[key] + '\n' for key in properties)
        with patch.object(adapter, 'command', side_effect=command), patch.object(m, 'secure_read', return_value=b'static'):
            result = adapter.unit(unit)
        self.assertEqual(result['pid'], 123)
        incomplete = ''.join(key + '=' + raw[key] + '\n' for key in adapter.SERVICE_PROPERTIES if key != 'MainPID')
        with patch.object(adapter, 'command', return_value=incomplete):
            with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
                adapter.unit(unit)

    def test_wrong_timer_target_and_wrong_unit_environment_files_fail_closed(self):
        unit, raw, _, adapter, show = self.stable_unit_adapter()
        raw['EnvironmentFiles'] = '/etc/fomo-radar/radar.env (ignore_errors=no)'
        with patch.object(adapter, 'show', side_effect=show):
            with self.assertRaisesRegex(m.Refused, 'unknown_unit_environment_files'):
                adapter.unit(unit)
        timer = m.TIMERS[0]
        raw_timer = {'Id': timer, 'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'waiting',
                     'FragmentPath': '/etc/systemd/system/' + timer, 'DropInPaths': ' '.join(m.DROP_INS.get(timer, ())),
                     'UnitFileState': 'enabled', 'Triggers': 'unknown.service'}
        with patch.object(adapter, 'show', return_value=raw_timer):
            with self.assertRaisesRegex(m.Refused, 'unknown_timer_target'):
                adapter.unit(timer)

    def test_systemd255_loaded_oneshot_omits_empty_environmentfiles_even_with_all(self):
        unit = 'fomo-address-radar-input-sync.service'
        raw = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead',
               'FragmentPath': '/etc/systemd/system/' + unit, 'DropInPaths': '', 'UnitFileState': 'static',
               'Type': 'oneshot', 'MainPID': '0', 'ControlGroup': '', 'PassEnvironment': '',
               'KillMode': 'control-group', 'Environment': '', 'User': '', 'Group': ''}
        adapter = m.SystemdHost(self.clock, 120)
        def command(arguments):
            self.assertIn('--all', arguments)
            properties = arguments[-1].split('=', 1)[1].split(',')
            self.assertIn('EnvironmentFiles', properties)
            return ''.join(key + '=' + raw[key] + '\n' for key in properties if key in raw)
        with patch.object(adapter, 'command', side_effect=command), patch.object(m, 'secure_read', return_value=b'unchanged unitfile bytes'):
            fields = adapter.show(unit, adapter.SERVICE_PROPERTIES)
            self.assertEqual(fields['EnvironmentFiles'], '')
            record = adapter.unit(unit)
            self.assertEqual((record['active'], record['sub'], record['pid'], record['group']), ('inactive', 'dead', 0, ''))
            self.assertEqual(record['config']['files'], [{'path': raw['FragmentPath'], 'sha256': m.digest(b'unchanged unitfile bytes')}])
            for required in ('MainPID', 'ControlGroup', 'Type', 'Environment', 'PassEnvironment', 'KillMode', 'FragmentPath', 'User', 'Group'):
                saved = raw.pop(required)
                with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
                    adapter.unit(unit)
                raw[required] = saved

    def test_empty_complex_field_normalization_cannot_hide_missing_expected_envfile_or_unloaded_service(self):
        unit, raw, _, adapter, _ = self.stable_unit_adapter()
        def rendered():
            return ''.join(key + '=' + raw[key] + '\n' for key in adapter.SERVICE_PROPERTIES if key != 'EnvironmentFiles')
        with patch.object(adapter, 'command', side_effect=lambda arguments: rendered()):
            with self.assertRaisesRegex(m.Refused, 'unknown_unit_environment_files'):
                adapter.unit(unit)
            raw['LoadState'] = 'not-found'
            with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
                adapter.unit(unit)
            raw['LoadState'] = 'loaded'
            raw['Id'] = 'substituted.service'
            with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
                adapter.unit(unit)

    def resource_binding_adapter(self):
        adapter = m.SystemdHost(self.clock, 120)
        info = lambda uid=0, gid=0, mode=stat.S_IFDIR | 0o755, dev=64769, ino=10: SimpleNamespace(
            st_uid=uid, st_gid=gid, st_mode=mode, st_dev=dev, st_ino=ino)
        nodes = {path: info() for path in ('/', '/opt', '/opt/address-radar', '/opt/address-radar/releases')}
        nodes['/opt/address-radar/current'] = info(mode=stat.S_IFLNK | 0o777)
        nodes[m.RESOURCE_RELEASE] = info(uid=997, gid=987, ino=1137388)
        def show(unit, properties):
            self.assertIn(unit, m.MAIN)
            self.assertEqual(properties, ('Id', 'LoadState', 'User', 'Group'))
            return {'Id': unit, 'LoadState': 'loaded', 'User': 'address-radar', 'Group': 'address-radar'}
        return adapter, nodes, info, show

    @contextlib.contextmanager
    def resource_binding_mocks(self, adapter, nodes, show):
        with patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=997, pw_gid=987)), \
             patch.object(m.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=987)), \
             patch.object(adapter, 'show', side_effect=show), \
             patch.object(m.Path, 'read_text', return_value='01234567-89ab-cdef-0123-456789abcdef\n'), \
             patch.object(m.Path, 'resolve', return_value=Path(m.RESOURCE_RELEASE)), \
             patch.object(m.os, 'readlink', return_value='releases/4b48fc2-forward-token-code'), \
             patch.object(m.os, 'lstat', side_effect=lambda path: nodes[str(path)]):
            yield

    def test_resource_binding_accepts_only_confirmed_service_owned_leaf_with_root_ancestors(self):
        adapter, nodes, _, show = self.resource_binding_adapter()
        with self.resource_binding_mocks(adapter, nodes, show):
            binding = adapter.binding()
        self.assertEqual(binding['releasePath'], m.RESOURCE_RELEASE)
        self.assertEqual(binding['releaseIdentity'], [64769, 1137388, 997, 987, 0o755])
        self.assertEqual(binding['serviceAccount'], m.RESOURCE_ACCOUNT)
        self.assertEqual(len([unit for unit in m.MAIN]), 6)

    def test_unknown_leaf_owner_group_mode_or_symlink_is_refused(self):
        adapter, nodes, info, show = self.resource_binding_adapter()
        for value in [info(uid=1001, gid=987), info(uid=997, gid=1001), info(uid=997, gid=987, mode=stat.S_IFDIR | 0o775),
                      info(uid=997, gid=987, mode=stat.S_IFLNK | 0o755), info(uid=0, gid=0)]:
            nodes[m.RESOURCE_RELEASE] = value
            with self.resource_binding_mocks(adapter, nodes, show):
                with self.assertRaisesRegex(m.Refused, 'resource_release_leaf_changed'):
                    adapter.binding()

    def test_root_ancestor_and_current_link_trust_are_not_weakened_for_release_leaf(self):
        adapter, nodes, info, show = self.resource_binding_adapter()
        for path in ('/opt/address-radar/releases', '/opt/address-radar', '/opt/address-radar/current'):
            original = nodes[path]
            nodes[path] = info(uid=997, gid=987, mode=original.st_mode)
            with self.resource_binding_mocks(adapter, nodes, show):
                with self.assertRaises(m.Refused):
                    adapter.binding()
            nodes[path] = original

    def test_release_leaf_dev_inode_owner_group_and_mode_drift_prevents_pause_or_restore(self):
        for index, replacement in enumerate((64770, 1137389, 1001, 1001, 0o775)):
            original = self.host.identity['releaseIdentity'][index]
            self.host.identity['releaseIdentity'][index] = replacement
            with self.assertRaisesRegex(m.Refused, 'boot_or_release_changed'):
                self.controller.pause(self.pin)
            with self.assertRaisesRegex(m.Refused, 'boot_or_release_changed'):
                self.controller.restore(self.pin)
            self.host.identity['releaseIdentity'][index] = original
        self.assertEqual(self.host.calls, [])

    def test_main_configured_user_group_and_nss_identity_are_pinned(self):
        adapter, nodes, _, show = self.resource_binding_adapter()
        def changed(unit, properties):
            result = show(unit, properties)
            if unit == m.MAIN[-1]:
                result['User'] = 'ubuntu'
            return result
        with self.resource_binding_mocks(adapter, nodes, changed):
            with self.assertRaisesRegex(m.Refused, 'main_service_account_changed'):
                adapter.binding()
        with self.resource_binding_mocks(adapter, nodes, show):
            with patch.object(m.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1001, pw_gid=987)):
                with self.assertRaisesRegex(m.Refused, 'resource_account_changed'):
                    adapter.binding()
        unit, raw, _, adapter, show_unit = self.stable_unit_adapter()
        raw['Group'] = 'ubuntu'
        with patch.object(adapter, 'show', side_effect=show_unit):
            with self.assertRaisesRegex(m.Refused, 'main_service_account_changed'):
                adapter.unit(unit)

    def test_tool_unsafe_parent_still_refused_before_open_and_rootstore_guards_unchanged(self):
        info = lambda uid=0: SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=uid)
        nodes = {path: info() for path in ('/', '/usr', '/usr/local', '/usr/local/lib', '/usr/local/lib/address-radar')}
        nodes['/usr/local/lib'] = info(1001)
        with patch.object(m.os, 'lstat', side_effect=lambda path: nodes[str(path)]), patch.object(m.os, 'open') as opened:
            with self.assertRaisesRegex(m.Refused, 'unsafe_directory'):
                m.secure_read('/usr/local/lib/address-radar/helper.py')
            opened.assert_not_called()
        adapter, nodes, _, show = self.resource_binding_adapter()
        with self.resource_binding_mocks(adapter, nodes, show):
            with self.assertRaisesRegex(m.Refused, 'unsafe_directory'):
                m.secure_directory(m.RESOURCE_RELEASE)

    def test_command_absolute_deadline_includes_slow_popen_construction(self):
        adapter = m.SystemdHost(m.Clock(), 0.02)
        real_popen = m.subprocess.Popen
        def slow_spawn(arguments, **options):
            time.sleep(0.04)
            return real_popen([sys.executable, '-c', 'print("bounded local fixture")'], **options)
        with patch.object(m.subprocess, 'Popen', side_effect=slow_spawn):
            with self.assertRaisesRegex(m.Refused, 'systemctl_deadline'):
                adapter.command(['list-jobs', '--no-legend', '--no-pager', '--plain'])

    def test_restore_accepts_exact_unloaded_timer_after_stop(self):
        adapter = m.SystemdHost(self.clock, 240)
        timer_name = 'address-radar-maintenance-' + self.store.nonce + '.timer'

        def command(arguments, not_after_us=None):
            unit = arguments[1]
            properties = arguments[-1].split('=', 1)[1].split(',')
            if unit == timer_name and self.host.timer['ActiveState'] == 'inactive':
                values = {'Id': timer_name, 'LoadState': 'not-found',
                          'ActiveState': 'inactive', 'SubState': 'dead',
                          'FragmentPath': '', 'DropInPaths': '', 'UnitFileState': ''}
            else:
                values = dict(self.host.timer if unit == timer_name else self.host.service)
                values['Id'] = unit
            return '\n'.join(key + '=' + values[key] for key in properties if key in values)

        adapter.command = command
        self.host.watchdog = adapter.watchdog
        self.host.watchdog_disarmed = lambda nonce, kind: adapter.watchdog_disarmed(nonce, kind)
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertEqual(self.store.phase(), 'restored')
        self.assertIn(('stop', timer_name), self.host.calls)
        self.assertNotIn(('stop', timer_name[:-6] + '.service'), self.host.calls)

    def test_post_disarm_probe_requires_exact_positive_timer_state(self):
        adapter = m.SystemdHost(self.clock, 240)
        name = 'address-radar-maintenance-' + self.store.nonce + '.timer'
        valid = {'Id': name, 'LoadState': 'not-found',
                 'ActiveState': 'inactive', 'SubState': 'dead'}

        def probe(values):
            adapter.command = lambda arguments: '\n'.join(key + '=' + value for key, value in values.items())
            return adapter.watchdog_disarmed(self.store.nonce, 'timer')

        self.assertTrue(probe(valid))
        self.assertTrue(probe(dict(valid, LoadState='loaded')))
        for key in valid:
            with self.subTest(missing=key):
                with self.assertRaises(m.Refused):
                    probe({field: value for field, value in valid.items() if field != key})
        for changes in ({'Id': name.replace(self.store.nonce, 'f' * 16)},
                        {'LoadState': 'error'}, {'LoadState': 'masked'}):
            with self.subTest(changes=changes):
                with self.assertRaises(m.Refused):
                    probe(dict(valid, **changes))
        self.assertFalse(probe(dict(valid, ActiveState='active', SubState='waiting')))
        self.assertFalse(probe(dict(valid, ActiveState='failed', SubState='failed')))
        self.assertFalse(probe(dict(valid, SubState='running')))
        def failed_command(arguments):
            raise m.Refused('systemctl_failed')
        adapter.command = failed_command
        with self.assertRaisesRegex(m.Refused, 'systemctl_failed'):
            adapter.watchdog_disarmed(self.store.nonce, 'timer')

    def test_unloaded_post_disarm_requires_exact_nonce_and_terminal_state(self):
        adapter = m.SystemdHost(self.clock, 240)
        name = 'address-radar-maintenance-' + self.store.nonce + '.service'
        adapter.command = lambda arguments: 'Id=' + name + '\nLoadState=not-found\nActiveState=inactive\nSubState=dead'
        self.assertTrue(adapter.watchdog_disarmed(self.store.nonce, 'service'))
        with self.assertRaises(m.Refused):
            adapter.watchdog_disarmed(self.store.nonce, 'socket')
        with self.assertRaises(m.Refused):
            adapter.watchdog_disarmed('../bad', 'timer')

    def test_pre_arm_unloaded_watchdog_still_refuses_before_mutation(self):
        self.host.timer['LoadState'] = 'not-found'
        with self.assertRaises(m.Refused):
            self.controller.pause(self.pin)
        self.assertEqual(self.host.calls, [])

    def armed_systemd255_adapter(self):
        adapter = m.SystemdHost(self.clock, 240)
        raw = dict(self.host.timer)
        raw.pop('TimersCalendar')
        raw['TimersMonotonic'] = '{ OnActiveUSec=55min ; next_elapse=6d 3h 32min 5.317662s }'
        def command(arguments):
            unit = arguments[1]
            values = raw if unit.endswith('.timer') else self.host.service
            properties = arguments[-1].split('=', 1)[1].split(',')
            return '\n'.join(key + '=' + values[key] for key in properties if key in values)
        adapter.command = command
        return adapter, raw

    def test_real_systemd255_empty_calendar_shape_passes_strict_pre_arm(self):
        adapter, raw = self.armed_systemd255_adapter()
        self.host.watchdog = adapter.watchdog
        self.controller.armed(self.store.load(self.pin), self.pin)
        self.assertEqual(self.host.calls, [])

    def test_calendar_normalization_is_exact_and_other_omissions_fail_closed(self):
        adapter, raw = self.armed_systemd255_adapter()
        for key in tuple(raw):
            with self.subTest(missing=key):
                value = raw.pop(key)
                with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
                    adapter.watchdog(self.store.nonce)
                raw[key] = value
        for key, value in [('LoadState', 'not-found'), ('Transient', 'no'),
                           ('Triggers', 'unrelated.service'), ('ActiveState', 'inactive'),
                           ('SubState', 'dead')]:
            with self.subTest(changed=key):
                old = raw[key]
                raw[key] = value
                with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
                    adapter.watchdog(self.store.nonce)
                raw[key] = old
        adapter.command = lambda arguments: 'LoadState=loaded'
        with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
            adapter.show('address-radar-backup.timer', ('LoadState', 'TimersCalendar'))
        adapter, raw = self.armed_systemd255_adapter()
        raw['TimersCalendar'] = '{ OnCalendar=daily ; next_elapse=daily }'
        self.host.watchdog = adapter.watchdog
        with self.assertRaisesRegex(m.Refused, 'watchdog_timer_not_armed'):
            self.controller.armed(self.store.load(self.pin), self.pin)
        self.assertEqual(self.host.calls, [])

    def test_restore_skips_exact_collected_timer_and_never_run_service(self):
        adapter = m.SystemdHost(self.clock, 240)
        def command(arguments):
            name = arguments[1]
            return 'Id=' + name + '\nLoadState=not-found\nActiveState=inactive\nSubState=dead'
        adapter.command = command
        self.host.watchdog_disarmed = adapter.watchdog_disarmed
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertEqual(self.store.phase(), 'restored')
        self.assertEqual(self.host.calls, [])

    def test_disarm_precheck_never_masks_failed_stop(self):
        self.host.service.update(ActiveState='failed', SubState='failed')
        name = 'address-radar-maintenance-' + self.store.nonce + '.service'
        self.host.failures.add(('stop', name))
        errors = self.controller.restore(self.pin)
        self.assertTrue(errors)
        self.assertTrue(any(error.startswith('watchdog_disarm:') for error in errors))
        self.assertEqual(self.store.phase(), 'restore-failed')
        self.assertIn(('stop', name), self.host.calls)

    def install_143_stop(self, unit):
        mutate = self.host.mutate
        def with_exit(action, target, nonce, not_after_us=None):
            mutate(action, target, nonce, not_after_us)
            if action == 'stop' and target == unit:
                self.host.records[target].update(active='failed', sub='failed', pid=0)
        self.host.mutate = with_exit

    def test_commanded_main_143_is_quiescent_and_restores_without_aux_mutation(self):
        self.install_143_stop(m.MAIN[2])
        self.controller.pause(self.pin)
        self.assertEqual(self.store.phase(), 'paused')
        self.assertEqual(self.host.records[m.MAIN[2]]['active'], 'failed')
        reloaded = m.Maintenance(self.host, self.store, self.clock)
        self.assertTrue(reloaded.pause(self.pin)['idempotent'])
        self.assertEqual(reloaded.restore(self.pin), [])
        self.assertFalse(any(unit in m.AUX + m.PROTECTED for action, unit in self.host.calls))
        self.assertEqual(self.host.records[m.AUX[-1]]['active'], 'failed')

    def test_unexpected_main_exit_still_refuses_with_exact_safe_pause_cause(self):
        self.install_143_stop(m.MAIN[2])
        self.host.exit_facts = {m.MAIN[2]: {'Result': 'exit-code', 'ExecMainCode': '1', 'ExecMainStatus': '1'}}
        with self.assertRaisesRegex(m.Refused, 'pause_failed:services_or_children_not_stopped;'):
            self.controller.pause(self.pin)
        self.assertEqual(self.store.phase(), 'restored')

    def test_143_terminal_proof_rejects_wrong_facts_pid_children_and_jobs(self):
        adapter = m.SystemdHost(self.clock, 120)
        unit = m.MAIN[2]
        original = self.store.load(self.pin)['units'][unit]
        current = dict(original, active='failed', sub='failed', pid=0)
        valid = {'Id': unit, 'LoadState': 'loaded', 'ActiveState': 'failed', 'SubState': 'failed',
                 'MainPID': '0', 'ControlGroup': original['group'], 'Result': 'exit-code',
                 'ExecMainCode': '1', 'ExecMainStatus': '143', 'ExecMainStartTimestampMonotonic': '123456'}
        receipt = {'pid': original['pid'], 'startTime': '1234', 'exeSha256': 'a' * 64, 'execStartMonotonicUs': '123456'}
        def command(arguments):
            properties = arguments[-1].split('=', 1)[1].split(',')
            return '\n'.join(key + '=' + valid[key] for key in properties if key in valid)
        adapter.command = command
        adapter.group_empty = self.host.group_empty
        adapter.jobs = self.host.jobs
        self.assertTrue(adapter.main_stop_143(unit, current, original, receipt))
        for key, bad in [('Id', m.MAIN[0]), ('LoadState', 'not-found'), ('ActiveState', 'active'),
                         ('SubState', 'dead'), ('MainPID', '42'), ('ControlGroup', '/other'),
                         ('Result', 'signal'), ('ExecMainCode', '2'), ('ExecMainStatus', '1')]:
            old = valid[key]
            valid[key] = bad
            with self.subTest(field=key):
                self.assertFalse(adapter.main_stop_143(unit, current, original, receipt))
            valid[key] = old
        self.host.children.add(original['group'])
        self.assertFalse(adapter.main_stop_143(unit, current, original, receipt))
        self.host.children.clear()
        self.host.job_records = [{'unit': unit, 'kind': 'stop', 'state': 'running'}]
        self.assertFalse(adapter.main_stop_143(unit, current, original, receipt))
        self.host.job_records = []
        valid.pop('ExecMainStatus')
        with self.assertRaisesRegex(m.Refused, 'missing_systemctl_properties'):
            adapter.main_stop_143(unit, current, original, receipt)

    def test_uncommanded_143_cannot_establish_paused_phase(self):
        for unit in m.MAIN + m.TIMERS:
            self.host.records[unit].update(active='inactive', sub='dead', pid=0)
        self.host.records[m.MAIN[2]].update(active='failed', sub='failed')
        self.assertFalse(self.controller.paused(self.store.load(self.pin)))

    def test_restore_retries_absent_gateway_inside_same_readiness_deadline(self):
        self.controller.pause(self.pin)
        seen = []
        gateway = self.host.gateway_false
        def delayed(record):
            seen.append(self.clock.mono())
            if len(seen) <= 2:
                raise m.Refused('gateway_flag_missing')
            gateway(record)
        self.host.gateway_false = delayed
        before = self.clock.mono()
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertGreaterEqual(self.clock.mono() - before, 200000)
        self.assertGreaterEqual(len(seen), len(m.MAIN) + 2)

    def test_missing_gateway_never_becomes_readiness_success(self):
        self.controller.pause(self.pin)
        def missing(record):
            raise m.Refused('gateway_flag_missing')
        self.host.gateway_false = missing
        before = self.clock.mono()
        errors = self.controller.restore(self.pin)
        self.assertEqual(len(errors), len(m.MAIN))
        self.assertTrue(all('unit_restore_timeout' in error for error in errors))
        self.assertLessEqual(self.clock.mono() - before, m.SERVICE_WAIT_SECONDS * 1000000)
        self.assertEqual(self.host.timer['ActiveState'], 'active')

    def test_gateway_explicit_bad_value_is_not_retried(self):
        self.controller.pause(self.pin)
        self.host.gateway_enabled = True
        before = self.clock.mono()
        errors = self.controller.restore(self.pin)
        self.assertEqual(self.clock.mono(), before)
        self.assertEqual(len(errors), len(m.MAIN))
        self.assertTrue(all('gateway_not_disabled' in error for error in errors))

    def test_restore_rechecks_current_main_pid_after_gateway_snapshot(self):
        self.controller.pause(self.pin)
        gateway = self.host.gateway_false
        changed = []
        def transitioning(record):
            gateway(record)
            if not changed:
                changed.append(record['pid'])
                self.host.records[m.MAIN[0]]['pid'] += 1
        self.host.gateway_false = transitioning
        before = self.clock.mono()
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertGreaterEqual(self.clock.mono() - before, 100000)

    def test_gateway_snapshot_distinguishes_absence_and_checks_exec_identity(self):
        adapter = m.SystemdHost(self.clock, 120)
        record = self.host.unit(m.MAIN[0])
        proc_stat = b'100 (node) S ' + b'0 ' * 18 + b'1234 0'
        with patch.object(m.Path, 'read_bytes', return_value=proc_stat), \
             patch.object(m.os, 'open', return_value=42), patch.object(m.os, 'close'), \
             patch.object(m.os, 'readlink', return_value='/usr/bin/node'), patch.object(m.os, 'read') as read:
            read.return_value = b'OTHER=safe\0'
            with self.assertRaisesRegex(m.Refused, '^gateway_flag_missing$'):
                adapter.gateway_false(record)
            for body in (b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=true\0',
                         b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false\0ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false\0'):
                read.return_value = body
                with self.assertRaisesRegex(m.Refused, '^gateway_not_disabled$'):
                    adapter.gateway_false(record)
            read.return_value = b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false\0'
            adapter.gateway_false(record)
            with patch.object(m.os, 'readlink', side_effect=['/launcher', '/usr/bin/node']):
                with self.assertRaisesRegex(m.Refused, '^gateway_process_transition$'):
                    adapter.gateway_false(record)

    def test_stop_instance_receipt_is_bound_persisted_and_rechecked_on_idempotent_pause(self):
        self.install_143_stop(m.MAIN[2])
        self.controller.pause(self.pin)
        units = self.store.load_stop_receipts(self.pin)
        self.assertEqual(set(units), set(m.MAIN))
        self.assertEqual(units[m.MAIN[2]]['pid'], self.store.baseline['units'][m.MAIN[2]]['pid'])
        self.assertTrue(self.controller.paused(self.store.load(self.pin)))
        self.store.stop_receipts['units'][m.MAIN[2]]['execStartMonotonicUs'] = '9'
        self.assertFalse(self.controller.paused(self.store.load(self.pin)))
        self.store.stop_receipts['nonce'] = 'f' * 16
        with self.assertRaises(m.Refused):
            self.controller.paused(self.store.load(self.pin))

    def test_running_instance_changed_between_preflight_and_stop_is_not_stopped(self):
        gateway = self.host.gateway_false
        counts = {}
        def changing(record):
            value = gateway(record)
            counts[record['pid']] = counts.get(record['pid'], 0) + 1
            if record['pid'] == self.store.baseline['units'][m.MAIN[0]]['pid'] and counts[record['pid']] > 1:
                value['startTime'] = '9999'
            return value
        self.host.gateway_false = changing
        with self.assertRaisesRegex(m.Refused, 'pause_failed:main_instance_changed_before_stop:'):
            self.controller.pause(self.pin)
        self.assertNotIn(('stop', m.MAIN[0]), self.host.calls)
        self.assertEqual(self.store.phase(), 'restored')

    def test_absent_flag_retry_is_simple_only(self):
        self.controller.pause(self.pin)
        self.host.service_types = {m.MAIN[0]: 'exec'}
        gateway = self.host.gateway_false
        once = []
        def missing_once(record):
            if not once:
                once.append(record['pid'])
                raise m.Refused('gateway_flag_missing')
            return gateway(record)
        self.host.gateway_false = missing_once
        before = self.clock.mono()
        errors = self.controller.restore(self.pin)
        self.assertEqual(errors, [m.MAIN[0] + ':gateway_flag_missing'])
        self.assertEqual(self.clock.mono(), before)

    def test_stop_receipt_shape_identity_and_baseline_pin_are_strict(self):
        self.controller.pause(self.pin)
        good = copy.deepcopy(self.store.stop_receipts)
        for kind in ('pin', 'pid', 'extra', 'missing', 'stamp', 'bool', 'exe'):
            bad = copy.deepcopy(good)
            record = bad['units'][m.MAIN[0]]
            if kind == 'pin': bad['baselineSha256'] = '0' * 64
            if kind == 'pid': record['pid'] += 1
            if kind == 'extra': bad['units'][m.AUX[0]] = record
            if kind == 'missing': bad['units'].pop(m.MAIN[0])
            if kind == 'stamp': record['execStartMonotonicUs'] = '0'
            if kind == 'bool': record['pid'] = True
            if kind == 'exe': record['exeSha256'] = 'not-a-hash'
            with self.subTest(kind=kind):
                with self.assertRaises(m.Refused):
                    m.validate_stop_receipts(bad, self.store.load(self.pin), self.pin)

    def test_private_stop_receipts_are_exclusive_and_securely_loaded(self):
        self.controller.pause(self.pin)
        with tempfile.TemporaryDirectory() as directory:
            store = m.RootStorage(self.store.nonce)
            store.directory = Path(directory)
            baseline = self.store.load(self.pin)
            with patch.object(store, 'load', return_value=baseline):
                store.save_stop_receipts(self.pin, self.store.stop_receipts['units'])
                with self.assertRaises(FileExistsError):
                    store.save_stop_receipts(self.pin, self.store.stop_receipts['units'])
                path = Path(directory) / 'stopped-main.json'
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                with patch.object(m, 'secure_read', side_effect=lambda filename, mode: Path(filename).read_bytes()) as read:
                    self.assertEqual(store.load_stop_receipts(self.pin), self.store.stop_receipts['units'])
                    read.assert_called_once_with(path, 0o600)

    def test_status_never_mutates_units(self):
        result = self.controller.status(self.pin)
        self.assertEqual(result['scope'], 'resource-only')
        self.assertEqual(set(result['units']), set(m.UNITS))
        self.assertEqual(self.host.calls, [])

    def test_scanner_stop_grace_90_seconds_preserves_strict_closure(self):
        scanner = m.MAIN[0]
        mutate, unit = self.host.mutate, self.host.unit
        release_at = [None]
        original = copy.deepcopy(self.host.records[scanner])
        def delayed_stop(action, name, nonce, not_after_us=None):
            mutate(action, name, nonce, not_after_us)
            if action == 'stop' and name == scanner:
                release_at[0] = self.clock.mono() + 90 * 1000000
                self.host.records[name] = dict(original, active='deactivating', sub='stop-sigterm')
                self.host.children.add(original['group'])
        def settled(name):
            if (release_at[0] is not None and self.clock.mono() >= release_at[0] and
                    self.host.records[scanner]['active'] == 'deactivating'):
                self.host.records[scanner].update(active='inactive', sub='dead', pid=0)
                self.host.children.discard(original['group'])
            return unit(name)
        self.host.mutate, self.host.unit = delayed_stop, settled
        before = self.clock.mono()
        self.assertEqual(self.controller.pause(self.pin)['phase'], 'paused')
        self.assertGreaterEqual(self.clock.mono() - before, 90 * 1000000)
        self.assertLessEqual(self.clock.mono() - release_at[0], 5 * 1000000)
        self.assertFalse(self.host.children)
        self.assertEqual(self.controller.restore(self.pin), [])

    def test_scanner_start_90_seconds_dispatches_siblings_first(self):
        self.controller.pause(self.pin)
        scanner = m.MAIN[0]
        mutate, unit = self.host.mutate, self.host.unit
        ready_at = [None]
        def delayed_start(action, name, nonce, not_after_us=None):
            mutate(action, name, nonce, not_after_us)
            if action == 'start' and name == scanner:
                ready_at[0] = self.clock.mono() + 90 * 1000000
                self.host.records[name].update(active='activating', sub='start')
        def settled(name):
            if ready_at[0] is not None and self.clock.mono() >= ready_at[0]:
                self.host.records[scanner].update(active='active', sub='running')
            if ready_at[0] is not None and self.clock.mono() > ready_at[0] - 90 * 1000000:
                self.assertTrue(all(('start', sibling) in self.host.calls for sibling in m.MAIN))
            return unit(name)
        self.host.mutate, self.host.unit = delayed_start, settled
        before = self.clock.mono()
        self.assertEqual(self.controller.restore(self.pin), [])
        self.assertGreaterEqual(self.clock.mono() - before, 90 * 1000000)
        self.assertLessEqual(self.clock.mono() - before, m.SERVICE_WAIT_SECONDS * 1000000)
        self.assertEqual(self.store.phase(), 'restored')

    def test_wait_clips_service_grace_to_operation_and_window_deadlines(self):
        for kind in ('operation', 'window', 'restore'):
            before = self.clock.mono()
            until = before + 2 * 1000000
            if kind == 'operation':
                self.host.deadline = until
            elif kind == 'window':
                self.controller.window_deadline = until
            else:
                self.controller.restore_deadline = until
            with self.assertRaisesRegex(m.Refused, 'bounded'):
                self.controller.wait(lambda: False, m.SERVICE_WAIT_SECONDS, 'bounded')
            self.assertEqual(self.clock.mono(), until)
            if kind == 'operation':
                del self.host.deadline
            elif kind == 'window':
                del self.controller.window_deadline
            else:
                del self.controller.restore_deadline

    def test_late_positive_predicate_cannot_pass_deadline(self):
        def late():
            self.clock.sleep(2)
            return True
        with self.assertRaisesRegex(m.Refused, 'late'):
            self.controller.wait(late, 1, 'late')

    def test_restore_95_second_grace_does_not_reset_on_gateway_retries(self):
        self.controller.pause(self.pin)
        self.host.gateway_false = lambda _: (_ for _ in ()).throw(m.Refused('gateway_flag_missing'))
        before = self.clock.mono()
        errors = self.controller.restore(self.pin)
        self.assertEqual(len(errors), len(m.MAIN))
        self.assertLessEqual(self.clock.mono() - before, m.SERVICE_WAIT_SECONDS * 1000000)
        self.assertEqual(self.store.phase(), 'restore-failed')
        self.assertEqual(self.host.timer['ActiveState'], 'active')

    def test_restore_clips_to_existing_240_second_operation_budget(self):
        self.controller.pause(self.pin)
        before = self.clock.mono()
        self.host.deadline = before + 3 * 1000000
        self.host.gateway_false = lambda _: (_ for _ in ()).throw(m.Refused('gateway_flag_missing'))
        errors = self.controller.restore(self.pin)
        self.assertTrue(errors)
        self.assertLessEqual(self.clock.mono() - before, 3 * 1000000)
        self.assertEqual(self.store.phase(), 'restore-failed')
        self.assertEqual(self.host.timer['ActiveState'], 'active')


    def test_real_cli_initial_budget_is_action_specific(self):
        for action, expected in [('capture', 120), ('status', 120), ('pause', 450), ('restore', 240)]:
            seen = []
            def host_factory(clock, budget):
                seen.append(budget)
                return self.host
            fake_store = SimpleNamespace(initialize=lambda: None,
                                         lock=lambda clock, seconds: contextlib.nullcontext())
            fake_maintenance = SimpleNamespace(capture=lambda helper: self.pin,
                pause=lambda pin: {'phase': 'paused'}, restore=lambda pin, watchdog: [],
                status=lambda pin: {'phase': 'restored'})
            argv = ['helper.py', action, '--nonce', self.store.nonce]
            if action != 'capture':
                argv += ['--baseline-sha256', self.pin]
            with patch.object(m.sys, 'argv', argv), patch.object(m.sys, 'platform', 'linux'), \
                 patch.object(m.os, 'geteuid', return_value=0), patch.object(m.os, 'umask'), \
                 patch.object(m.Path, 'read_text', return_value='systemd'), \
                 patch.object(m, 'Clock', return_value=self.clock), \
                 patch.object(m, 'SystemdHost', new=host_factory), \
                 patch.object(m, 'RootStorage', return_value=fake_store), \
                 patch.object(m, 'Maintenance', return_value=fake_maintenance), \
                 patch.object(m, 'secure_read', return_value=b'test-only'), \
                 patch.object(m.signal, 'signal'), contextlib.redirect_stdout(io.StringIO()):
                m.cli()
            self.assertEqual(seen, [expected])

    def test_real_cli_pause_failure_nested_restore_fits_original_450_budget(self):
        scanner = m.MAIN[0]
        self.host.exit_facts = {scanner: {'Result': 'signal', 'ExecMainCode': '2', 'ExecMainStatus': '15'}}
        mutate, gateway = self.host.mutate, self.host.gateway_false
        ready = [None]
        def delayed(action, unit, nonce, not_after_us=None):
            mutate(action, unit, nonce, not_after_us)
            if action == 'stop' and unit == scanner:
                self.host.records[unit].update(active='failed', sub='failed', pid=0)
            if action == 'start' and unit == scanner:
                ready[0] = self.clock.mono() + 90 * 1000000
        def startup(record):
            if ready[0] is not None and self.clock.mono() < ready[0]:
                raise m.Refused('gateway_flag_missing')
            return gateway(record)
        self.host.mutate, self.host.gateway_false = delayed, startup
        self.store.lock = lambda clock, seconds: contextlib.nullcontext()
        before = self.clock.mono()
        seen = []
        def host_factory(clock, budget):
            seen.append(budget)
            self.host.deadline = clock.mono() + budget * 1000000
            return self.host
        for method in ('stop_instance', 'main_stop_143', 'simple_startup', 'watchdog_disarmed'):
            setattr(host_factory, method, getattr(m.SystemdHost, method))
        argv = ['helper.py', 'pause', '--nonce', self.store.nonce, '--baseline-sha256', self.pin]
        with patch.object(m.sys, 'argv', argv), patch.object(m.sys, 'platform', 'linux'), \
             patch.object(m.os, 'geteuid', return_value=0), patch.object(m.os, 'umask'), \
             patch.object(m.Path, 'read_text', return_value='systemd'), \
             patch.object(m, 'Clock', return_value=self.clock), \
             patch.object(m, 'SystemdHost', new=host_factory), \
             patch.object(m, 'RootStorage', return_value=self.store), \
             patch.object(m.signal, 'signal'):
            with self.assertRaisesRegex(m.Refused, 'pause_failed:services_or_children_not_stopped;restore_errors=$'):
                m.cli()
        self.assertEqual(seen, [450])
        self.assertEqual(self.store.phase(), 'restored')
        self.assertGreater(self.clock.mono() - before, 120 * 1000000)
        self.assertLess(self.clock.mono() - before, 450 * 1000000)
        self.assertLessEqual(self.host.deadline, before + 450 * 1000000)
        self.assertLessEqual(self.host.deadline, self.store.baseline['deadlineMonotonicUs'])

    def test_nested_restore_cannot_extend_short_original_operation(self):
        original = self.clock.mono() + 3 * 1000000
        self.host.deadline = original
        self.host.children.add(self.host.records[m.MAIN[0]]['group'])
        with self.assertRaisesRegex(m.Refused, 'pause_failed:services_or_children_not_stopped'):
            self.controller.pause(self.pin)
        self.assertLessEqual(self.host.deadline, original)
        self.assertLessEqual(self.clock.mono(), original)
        self.assertEqual(self.store.phase(), 'restore-failed')
        self.assertEqual(self.host.timer['ActiveState'], 'active')



class SecurityTests(unittest.TestCase):
    def test_production_adapter_rejects_unknown_and_protected_mutations_before_command(self):
        host = m.SystemdHost(FakeClock(), 10)
        with patch.object(host, 'command') as command:
            for unit in m.PROTECTED + m.AUX + ('unknown.service',):
                with self.assertRaises(m.Refused):
                    host.mutate('stop', unit, '0123456789abcdef')
            command.assert_not_called()

    def test_symlink_and_nonroot_artifacts_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'baseline.json'
            file.write_bytes(b'{}')
            os.chmod(file, 0o600)
            link = Path(directory) / 'link'
            link.symlink_to(file)
            with patch.object(m, 'secure_directory'):
                with self.assertRaises(OSError):
                    m.secure_read(link, 0o600)
                if os.geteuid() != 0:
                    with self.assertRaises(m.Refused):
                        m.secure_read(file, 0o600)

    def test_actual_flock_serializes_manual_and_watchdog_without_systemd(self):
        original_fstat = os.fstat
        def root_stat(fd):
            info = original_fstat(fd)
            return SimpleNamespace(st_mode=info.st_mode, st_uid=0, st_nlink=info.st_nlink)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / '0123456789abcdef'
            private.mkdir(mode=0o700)
            m.new_file(private / 'lock', b'')
            with patch.object(m, 'ROOT', root), patch.object(m, 'secure_directory'), patch.object(m.os, 'fstat', side_effect=root_stat):
                store = m.RootStorage('0123456789abcdef')
                with store.lock(FakeClock(), 1):
                    with self.assertRaisesRegex(m.Refused, 'maintenance_lock_deadline'):
                        with store.lock(FakeClock(), 0):
                            self.fail('Concurrent restoration obtained the lock')
                with store.lock(FakeClock(), 0):
                    pass

    def test_systemctl_calls_use_fixed_argv_environment_and_bounded_output(self):
        host = m.SystemdHost(m.Clock(), 2)
        real_popen = m.subprocess.Popen
        calls = []
        def local_child(arguments, **options):
            calls.append((arguments, options))
            return real_popen([sys.executable, '-c', 'print("x" * 150000)'], **options)
        with patch.object(m.subprocess, 'Popen', side_effect=local_child):
            with self.assertRaisesRegex(m.Refused, 'systemctl_output_limit'):
                host.command(['list-jobs', '--no-legend', '--no-pager', '--plain'])
        self.assertEqual(calls[0][0][0], '/usr/bin/systemctl')
        self.assertNotIn('shell', calls[0][1])
        self.assertEqual(set(calls[0][1]['env']), {'PATH', 'LC_ALL', 'SYSTEMD_PAGER', 'SYSTEMD_COLORS'})

    def test_immutable_capture_cannot_overwrite_baseline(self):
        clock, store = FakeClock(), MemoryStorage()
        host = FakeSystemd(clock, store)
        maintenance = m.Maintenance(host, store, clock)
        maintenance.capture(b'test')
        with self.assertRaises(m.Refused):
            maintenance.capture(b'test')


class CaptureBusyRegressionTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.store = MemoryStorage()
        self.host = FakeSystemd(self.clock, self.store)
        self.controller = m.Maintenance(self.host, self.store, self.clock)
        self.timer = 'address-radar-fomo-verification-sync.timer'
        self.service = self.timer[:-6] + '.service'

    def busy(self, settle=None):
        self.host.records[self.timer].update(active='active', sub='running')
        self.host.records[self.service].update(active='active', sub='running', pid=900)
        original = self.host.unit
        def observed(unit):
            if settle is not None and self.clock.mono() >= settle:
                self.host.records[self.timer].update(active='active', sub='waiting')
                self.host.records[self.service].update(active='inactive', sub='dead', pid=0)
            return original(unit)
        self.host.unit = observed

    def test_busy_lifecycle_drains_before_baseline_without_mutation(self):
        start = self.clock.mono()
        self.busy(start + 200000)
        pin = self.controller.capture(b'test-helper')
        self.assertEqual(self.store.load(pin)['units'][self.timer]['sub'], 'waiting')
        self.assertEqual(self.store.baseline['units'][self.service]['active'], 'inactive')
        self.assertGreaterEqual(self.clock.mono() - start, 200000)
        self.assertLessEqual(self.clock.mono() - start, 5000000)
        self.assertEqual(self.host.calls, [])

    def test_busy_timeout_preserves_measured_evidence_without_baseline(self):
        start = self.clock.mono()
        self.busy()
        with self.assertRaisesRegex(m.Refused, 'capture_busy_deadline'):
            self.controller.capture(b'test-helper')
        self.assertIsNone(self.store.baseline)
        self.assertLessEqual(self.clock.mono() - start, 5000000)
        self.assertEqual(self.host.calls, [])
        d = self.store.diagnostics[-1]
        self.assertEqual(d['kind'], 'capture-busy')
        self.assertIsNone(d['baselineSha256'])
        self.assertEqual(d['units'][self.timer]['measured']['sub'], 'running')
        self.assertEqual(d['units'][self.service]['measured']['pid'], 900)

    def test_capture_wait_never_accepts_timer_active_change(self):
        self.busy()
        original = self.host.unit
        def changed(unit):
            if self.clock.mono() > 1000000000:
                self.host.records[self.timer].update(active='inactive', sub='dead')
                self.host.records[self.service].update(active='inactive', sub='dead', pid=0)
            return original(unit)
        self.host.unit = changed
        with self.assertRaisesRegex(m.Refused, 'capture_active_state_changed'):
            self.controller.capture(b'test-helper')
        self.assertIsNone(self.store.baseline)
        self.assertEqual(self.host.calls, [])

    def test_capture_wait_never_accepts_configuration_change(self):
        self.busy()
        original = self.host.unit
        def changed(unit):
            if self.clock.mono() > 1000000000:
                self.host.records[self.timer]['config']['sha256'] = 'a' * 64
            return original(unit)
        self.host.unit = changed
        with self.assertRaisesRegex(m.Refused, 'capture_configuration_changed'):
            self.controller.capture(b'test-helper')
        self.assertIsNone(self.store.baseline)
        self.assertEqual(self.host.calls, [])

    def test_pause_refusal_records_exact_timer_and_paired_oneshot_samples(self):
        pin = self.controller.capture(b'test-helper')
        self.host.bind_watchdog(pin)
        self.busy()
        with self.assertRaisesRegex(m.Refused, 'baseline_state_changed:' + self.timer):
            self.controller.pause(pin)
        self.assertEqual(self.host.calls, [])
        self.assertEqual(self.store.phase(), 'captured')
        d = self.store.diagnostics[-1]
        self.assertEqual(d['baselineSha256'], pin)
        self.assertEqual(d['kind'], 'pause-baseline-state')
        self.assertEqual(d['units'][self.timer]['captured']['sub'], 'waiting')
        self.assertEqual(d['units'][self.timer]['measured']['sub'], 'running')
        self.assertEqual(d['units'][self.service]['measured']['pid'], 900)

    def test_quiet_owner_inactive_timers_are_never_started_or_stopped(self):
        quiet = ('address-radar-fomo-verification-sync.timer', 'fomo-address-radar-input-sync.timer')
        for unit in quiet:
            self.host.records[unit].update(active='inactive', sub='dead', pid=0)
        pin = self.controller.capture(b'test-helper')
        self.host.bind_watchdog(pin)
        self.controller.pause(pin)
        self.assertEqual(self.controller.restore(pin), [])
        self.assertFalse(any(unit in quiet for _, unit in self.host.calls))
        for unit in quiet:
            self.assertEqual((self.host.records[unit]['active'], self.host.records[unit]['sub']), ('inactive', 'dead'))
        self.assertTrue(all(self.host.records[unit]['active'] == 'active' for unit in m.MAIN))

    def test_all_inactive_timers_leave_only_original_active_main_service_mutations(self):
        for unit in m.TIMERS:
            self.host.records[unit].update(active='inactive', sub='dead', pid=0)
        pin = self.controller.capture(b'test-helper')
        self.host.bind_watchdog(pin)
        self.controller.pause(pin)
        self.assertEqual(self.controller.restore(pin), [])
        self.assertFalse(any(unit in m.TIMERS + m.AUX + m.PROTECTED for _, unit in self.host.calls))
        self.assertEqual({unit for action, unit in self.host.calls if action == 'start'}, set(m.MAIN))


if __name__ == '__main__':
    unittest.main()
