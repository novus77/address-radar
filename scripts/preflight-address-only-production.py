"""Read-only production diagnostics; never grants cutover or startup authority."""
import json
import os
import shutil
import subprocess

SERVICES = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis',
            'historical-backfill', 'console']


def evaluate(evidence):
    blockers = []
    counts = [evidence.get(key) for key in ('cohort', 'transitions', 'markers')]
    valid = all(type(value) is int and value >= 0 for value in counts)
    if not valid:
        phase = 'unknown'
        blockers.append('cutover_state_unknown')
    elif counts == [0, 0, 0]:
        phase = 'not-migrated'
    elif counts[0] > 0 and counts[1] > 0 and counts[2] > 0:
        phase = 'postgres-write-recorded'
    elif counts[0] == 0 and counts[1] > 0 and counts[2] == 0:
        phase = 'transition-recorded-no-first-write'
    else:
        phase = 'inconsistent-requires-inspection'
        blockers.append('partial_cutover_state')
    for key, code in [('rolesReady', 'runtime_roles_not_ready'),
                      ('servicesReady', 'services_not_ready'),
                      ('deliveryDisabled', 'delivery_not_proven_disabled')]:
        if evidence.get(key) is not True:
            blockers.append(code)
    disk = evidence.get('diskBytes')
    if type(disk) is not int or disk < 3 * 1024**3:
        blockers.append('disk_below_safety_line_or_unknown')
    return dict(phase=phase, blockers=blockers, activationAuthorized=False,
                authenticatedCutoverVerified=False, evidence=evidence)


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=8).stdout.strip()


def query(sql):
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v',
                'ON_ERROR_STOP=1', '-d', 'address_radar', '-Atc',
                "BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; " + sql + '; COMMIT'])


def collect():
    if os.geteuid() != 0:
        raise RuntimeError('root_required_for_read_only_process_inspection')
    evidence = {}
    errors = []
    tables = dict(cohort='wallet_service_profile_cohort',
                  transitions='migration_cutover_transitions_v2',
                  markers='migration_cutover_first_write_markers')
    for key, table in tables.items():
        try:
            lines = query('SELECT count(*) FROM address_radar_business.' + table).splitlines()
            evidence[key] = int(next(line for line in lines if line.isdigit()))
        except Exception:
            evidence[key] = None
            errors.append(key + '_query_failed')
    try:
        names = ["'address_radar_" + name.replace('-', '_') + "'" for name in SERVICES]
        lines = query('SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname IN (' + ','.join(names) + ')').splitlines()
        evidence['rolesReady'] = next(line for line in lines if line.isdigit()) == '6'
    except Exception:
        evidence['rolesReady'] = None
        errors.append('roles_query_failed')
    states = []
    delivery = []
    for name in SERVICES:
        unit = 'address-radar-' + name + '.service'
        try:
            fields = dict(line.split('=', 1) for line in run(['systemctl', 'show', unit,
                '-p', 'ActiveState', '-p', 'NRestarts', '-p', 'MainPID']).splitlines())
            states.append(dict(service=unit, active=fields['ActiveState'], restarts=int(fields['NRestarts'])))
            with open('/proc/' + str(int(fields['MainPID'])) + '/environ', 'rb') as handle:
                values = [item for item in handle.read(1048576).split(b'\0')
                          if item.startswith(b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=')]
            delivery.append(values == [b'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED=false'])
        except Exception:
            errors.append(name + '_inspection_failed')
            delivery.append(False)
    evidence['services'] = states
    evidence['servicesReady'] = len(states) == 6 and all(row['active'] == 'active' for row in states)
    evidence['deliveryDisabled'] = len(delivery) == 6 and all(delivery)
    evidence['diskBytes'] = shutil.disk_usage('/var/lib/postgresql').free
    evidence['errors'] = errors
    return evidence


if __name__ == '__main__':
    print(json.dumps(evaluate(collect()), sort_keys=True))
