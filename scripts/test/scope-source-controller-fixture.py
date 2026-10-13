"""Bind disposable copies to actual isolated targets before any activation pins exist.

Only paths and target constants change. Validation/control flow remain native code.
These copies are fixture artifacts, never deployable production modules.
"""
import json
import os
from pathlib import Path
import re

scope = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
assert os.geteuid() == 0 and Path('/.dockerenv').is_file()
assert Path('/proc/1/comm').read_text().strip() == 'systemd'
assert not (scope/'original-controller-config.json').exists()
target = json.loads(Path('/tmp/committed.json').read_bytes())['binding']['target']
assert target['database'] == target['schema'] == 'radar_rehearsal_0123456789abcdef'
assert target['systemIdentifier'] != '7693392208475083526'
scripts = scope/'tools/scripts'
changes = {
    'address-only-native-fence.py': {
        "CONTROL = '/var/lib/address-radar-address-only-cutover'": 'CONTROL = '+repr(str(scope/'control')),
        "MASK_DIRECTORY = '/etc/systemd/system'": 'MASK_DIRECTORY = '+repr(str(scope/'units')),
        "BACKUP_DIRECTORY = '/var/backups/address-radar'": 'BACKUP_DIRECTORY = '+repr(str(scope/'backup')),
        "PROTECTED_UNITS = ('fomo-radar-collector.service', 'fomo-radar-login.service', 'fomo-radar-novnc.service')": 'PROTECTED_UNITS = ()',
    },
    'address-only-pg-reconcile.py': {
        "DATABASE = 'address_radar'": 'DATABASE = '+repr(target['database']),
        "SYSTEM = '7693392208475083526'": 'SYSTEM = '+repr(target['systemIdentifier']),
        "FINGERPRINT = 'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383'": 'FINGERPRINT = '+repr(target['schemaFingerprint']),
        'address_radar_business': target['schema'],
        "usename='address_radar_migrator'": "usename='radar_migrator_0123456789abcdef'",
    },
    'run-address-only-native-controller.py': {
        "ROOT = Path('/var/lib/address-radar-maintenance-tools')": 'ROOT = Path('+repr(str(scope))+')',
    },
    'pg-source-replacement-fence.py': {
        "CONTROL_LOCK = Path('/var/lib/address-radar-address-only-cutover/controller.lock')": 'CONTROL_LOCK = Path('+repr(str(scope/'control/controller.lock'))+')',
        "TOOLS = Path('/var/lib/address-radar-maintenance-tools')": 'TOOLS = Path('+repr(str(scope))+')',
        "Path('/etc/systemd/system')": 'Path('+repr(str(scope/'units'))+')',
    },
}
for filename, replacements in changes.items():
    path = scripts/filename
    assert path.parent == scripts and not path.is_symlink()
    raw = path.read_text()
    for old, new in replacements.items():
        assert old in raw, 'fixture_constant_not_found:'+filename
        raw = raw.replace(old, new)
    if filename == 'address-only-native-fence.py':
        # Keep only the six actual fixture services; no gateway/FOMO units exist here.
        raw, count = re.subn(r"WRITER_UNITS = tuple\('address-radar-' \+ name \+ '\.service' for name in\s*\([^)]*\)\) \+ \([^)]*\)",
            "WRITER_UNITS = tuple('address-radar-' + name + '.service' for name in "
            "('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console'))", raw)
        assert count == 1
    compile(raw, str(path), 'exec')
    with path.open('w') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    path.chmod(0o444)
print('ISOLATED_PINNED_CONTROLLER_TARGETS_PREPARED', flush=True)
