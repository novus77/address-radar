#!/usr/bin/env python3
"""Run one isolated rehearsal under an exact, automatically restored HBA window."""
import base64
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time

BASE = '/var/lib/address-radar-maintenance-tools'
DIRECTORY = BASE + '/address-only-import-663b3612f818d519b8e25b52390136285b0e8c462a5d1c6d004f151c9a933bf3'
STATE = DIRECTORY + '/hba-window'
HBA = '/etc/postgresql/16/radarproduction/pg_hba.conf'
ORIGINAL_SHA = 'f4871503662bf298c9b730c3017eb19339771328a5928b614197fe10e21d6821'
ORIGINAL = b'local all postgres peer\nlocal all all reject\nhost address_radar address_radar_migrator 127.0.0.1/32 scram-sha-256\nhost all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n'
RULE = b'host radar_rehearsal_663b3612f818d519 address_radar_migrator 127.0.0.1/32 scram-sha-256\n'
TIMER = 'address-radar-address-only-hba-restore-663b3612'
LOCK = BASE + '/private-migrator-dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61/authentication-state/operation.lock'
NODE = BASE + '/native-node-7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c/node'


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def temporary_body(original):
    require(original == ORIGINAL and digest(original) == ORIGINAL_SHA, 'original_hba_changed')
    return original.replace(b'host all all 127.0.0.1/32 reject\n', RULE + b'host all all 127.0.0.1/32 reject\n', 1)


def read_file(path, maximum, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum, 'unsafe_file')
        require(before.st_uid == (0 if private else 110) and not stat.S_IMODE(before.st_mode) & (0o077 if private else 0o027), 'unsafe_owner_or_mode')
        body = os.read(fd, maximum + 1)
        after, current = os.fstat(fd), os.lstat(path)
        require(len(body) == before.st_size and (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns) and current.st_ino == before.st_ino, 'file_changed')
        return body, before
    finally:
        os.close(fd)


def save(name, value):
    body = json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'
    fd = os.open(STATE + '/' + name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
    finally:
        parent = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)


def atomic_hba(body, expected):
    current, info = read_file(HBA, 8192)
    require(digest(current) == expected and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (110, 114, 0o640), 'hba_collision')
    parent = os.lstat(os.path.dirname(HBA))
    require(stat.S_ISDIR(parent.st_mode) and not stat.S_IMODE(parent.st_mode) & 0o022, 'unsafe_hba_parent')
    fd, pending = tempfile.mkstemp(prefix='.address-only-hba-', dir=os.path.dirname(HBA))
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), 0o640)
            os.fchown(output.fileno(), 110, 114)
            output.write(body)
            output.flush()
            os.fsync(output.fileno())
        check, _ = read_file(HBA, 8192)
        now = os.lstat(os.path.dirname(HBA))
        require(digest(check) == expected and (now.st_dev, now.st_ino) == (parent.st_dev, parent.st_ino), 'hba_collision')
        os.replace(pending, HBA)
        directory = os.open(os.path.dirname(HBA), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)


def peer(sql):
    result = subprocess.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-Atc', sql],
                            capture_output=True, timeout=10, check=True)
    require(len(result.stdout) <= 16384, 'peer_output_bound')
    return result.stdout.decode().strip()


def reload_hba():
    require(peer("SHOW hba_file") == HBA, 'active_hba_changed')
    require(peer('SELECT pg_reload_conf()') == 't', 'reload_failed')
    time.sleep(0.25)
    require(peer('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL') == '0', 'hba_parse_error')


def restore():
    intent = json.loads(read_file(STATE + '/intent.json', 16384, True)[0])
    original = base64.b64decode(intent['originalBase64'], validate=True)
    require(original == ORIGINAL and intent['originalSha256'] == ORIGINAL_SHA and intent['temporarySha256'] == digest(temporary_body(original)), 'restore_intent_changed')
    current, _ = read_file(HBA, 8192)
    if digest(current) != ORIGINAL_SHA:
        atomic_hba(original, intent['temporarySha256'])
    reload_hba()
    require(digest(read_file(HBA, 8192)[0]) == ORIGINAL_SHA, 'restore_parity_failed')
    require(peer("SELECT count(*) FROM pg_hba_file_rules WHERE 'radar_rehearsal_663b3612f818d519'=ANY(database)") == '0', 'temporary_rule_retained')
    receipt = {'status': 'original-hba-restored', 'sha256': ORIGINAL_SHA, 'temporaryRuleRemoved': True, 'businessServicesRestarted': False}
    if not os.path.exists(STATE + '/restore-receipt.json'):
        save('restore-receipt.json', receipt)
    return receipt


def run():
    original, _ = read_file(HBA, 8192)
    temporary = temporary_body(original)
    os.mkdir(STATE, 0o700)
    save('intent.json', {'originalBase64': base64.b64encode(original).decode(), 'originalSha256': ORIGINAL_SHA,
                         'temporarySha256': digest(temporary), 'database': 'radar_rehearsal_663b3612f818d519', 'scope': 'loopback-only-isolated-rehearsal'})
    subprocess.run(['/usr/bin/systemd-run', '--quiet', '--on-active=240s', '--timer-property=AccuracySec=1s', '--unit=' + TIMER,
                    '/usr/bin/python3', DIRECTORY + '/hba-window.py', '--restore'], check=True, timeout=10, capture_output=True)
    require(subprocess.check_output(['/usr/bin/systemctl', 'show', TIMER + '.timer', '-p', 'ActiveState', '--value'], timeout=5).strip() == b'active', 'recovery_timer_not_active')
    result = None
    try:
        atomic_hba(temporary, ORIGINAL_SHA)
        reload_hba()
        require(peer("SELECT count(*) FROM pg_hba_file_rules WHERE type='host' AND database=ARRAY['radar_rehearsal_663b3612f818d519']::text[] AND user_name=ARRAY['address_radar_migrator']::text[] AND address='127.0.0.1' AND netmask='255.255.255.255' AND auth_method='scram-sha-256'") == '1', 'temporary_scope_mismatch')
        result = subprocess.run([NODE, DIRECTORY + '/rehearse.mjs'], capture_output=True, timeout=160)
        require(len(result.stdout) <= 32768 and len(result.stderr) <= 32768, 'child_output_bound')
    finally:
        restored = restore()
        subprocess.run(['/usr/bin/systemctl', 'stop', TIMER + '.timer'], check=True, timeout=10, capture_output=True)
        print(json.dumps(restored))
    # The child deliberately emits only non-sensitive fixed receipts.
    for line in result.stdout.decode().splitlines():
        value = json.loads(line)
        require(value.get('status') in ('isolated-native-address-import-passed', 'isolated-rehearsal-refused'), 'unexpected_child_receipt')
        print(json.dumps(value))
    require(result.returncode == 0, 'isolated_rehearsal_failed_original_hba_restored')


def main():
    require(os.geteuid() == 0 and sys.platform == 'linux' and sys.argv[1:] in (['--run'], ['--restore']), 'native_entry_required')
    for path in (DIRECTORY, os.path.dirname(LOCK)):
        info = os.lstat(path)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'private_directory_required')
    lock = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(lock)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not stat.S_IMODE(info.st_mode) & 0o077, 'unsafe_auth_lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if sys.argv[1] == '--restore':
            print(json.dumps(restore()))
        else:
            run()
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not echo child stderr, credentials or SQL parameters.
        print(json.dumps({'status': 'hba-window-refused', 'reason': str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        sys.exit(1)
