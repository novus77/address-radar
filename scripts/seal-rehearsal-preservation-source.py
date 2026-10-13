"""Fixed rehearsal source metadata sealing; no source writes, removals or unseal."""
import argparse
import array
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path
SOURCE = '/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle'
MANIFEST = 'd73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c'
SNAPSHOT = 'd73d27350f0785ac3938024f7d56c77b5c4b404a236b75dc6ff1cb726a0e91b7'
CATALOG = '6f8776bbba041c4cd91cb0d622f0d169286857371099198ea0123d3bc439edf5'
OPERATION = 'preparation-20261004-largechunk-9c8ae4bf'
CONTROL = '/var/lib/address-radar-rehearsal-source-control/' + MANIFEST
TOOLS = '/var/lib/address-radar-rehearsal-source-tools'
VALIDATOR_SHA256 = "f288e5ac7b9d4de4725de7ae92469bc68d9c6f7ce3ccea14b01a3baa948b7525"
NODE_SHA256 = '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c'
NODE_PATH = '/var/lib/address-radar-maintenance-tools/native-node-' + NODE_SHA256 + '/node'
NODE_SIZE = 126595440

IMMUTABLE = 0x10
MAX_RECORD = 1024 * 1024
MAINT_SHA256 = 'e049c1b56217344ccb8baa4954029666348cb8594d5016ab213ad0b292eccc0d'

class Refused(RuntimeError):
    pass

def need(ok, code):
    if not ok:
        raise Refused(code)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, 'duplicate_json_key')
        result[key] = value
    return result

def identity(info):
    return {k: getattr(info, 'st_' + k) for k in ('dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns')}

def stable(a, b, flags_changed=False):
    keys = set(a) - ({'ctime_ns'} if flags_changed else set())
    return set(a) == set(b) and all(a[k] == b[k] for k in keys)

class Native:
    def flags(self, fd):
        value = array.array('I', [0]); fcntl.ioctl(fd, 0x80086601, value, True)
        return value[0]
    def set_flags(self, fd, value):
        flags = array.array('I', [value]); fcntl.ioctl(fd, 0x40086602, flags, True)
    def lease(self, fd):
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
    def release(self, fd):
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
    def publish(self, fd, temporary, final):
        libc = ctypes.CDLL(None, use_errno=True)
        function = libc.renameat2
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        function.restype = ctypes.c_int
        if function(fd, temporary.encode(), fd, final.encode(), 1) != 0:
            raise OSError(ctypes.get_errno(), 'exclusive_publish_failed')

class Sealer:
    # Dependency injection is for local filesystem tests, never accepted by CLI.
    def __init__(self, source, control, validator, code_pin, validator_pin, native=None, uid=0, policy=None):
        self.source, self.control, self.validator = source, control, validator
        self.code_pin, self.validator_pin, self.native, self.uid = code_pin, validator_pin, native or Native(), uid
        self.policy = policy or {'manifest': MANIFEST, 'snapshot': SNAPSHOT, 'catalog': CATALOG, 'operation': OPERATION, 'tables': 141, 'chunks': 1548, 'rows': 6023033, 'manifestBytes': 545010}
        self.began, self.wall, self.lost = time.monotonic(), time.time(), False
        self.root_fd = self.control_fd = self.lock_fd = None
        self.watchdog_monotonic = None
        self.last_binding = float("-inf")
        self.handles = {}; self.resource_check = lambda: None; self.last_resource = float("-inf"); self.plans = {}
    def check(self, force_bindings=False):
        need(self.watchdog_monotonic is None or time.monotonic() + 320 < self.watchdog_monotonic, 'maintenance_reserve')
        need(not self.lost and time.monotonic() - self.began < 1800 and time.time() - self.wall < 1800, 'deadline_or_lease_lost')
        if time.monotonic() - self.last_resource >= 0.1:
            self.resource_check(); self.last_resource = time.monotonic()
        now = time.monotonic()
        if not force_bindings and now - self.last_binding < 0.1: return
        self.last_binding = now
        for path, fd in ((self.source, self.root_fd), (self.control, self.control_fd)):
            if fd is not None:
                info = os.lstat(path); held = os.fstat(fd)
                need(stat.S_ISDIR(info.st_mode) and info.st_uid == self.uid and stat.S_IMODE(info.st_mode) == 0o700 and [info.st_dev, info.st_ino] == [held.st_dev, held.st_ino], 'directory_identity_changed')
        if self.lock_fd is not None:
            info = os.lstat(self.control + '/lock'); held = os.fstat(self.lock_fd)
            need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == self.uid and stat.S_IMODE(info.st_mode) == 0o600 and [info.st_dev, info.st_ino] == [held.st_dev, held.st_ino], 'lock_identity_changed')
    def protected(self, path):
        need(os.path.isabs(path) and os.path.normpath(path) == path, 'canonical_path')
        current = '/'
        for part in path.split('/')[1:]:
            current = os.path.join(current, part); info = os.lstat(current)
            need(not stat.S_ISLNK(info.st_mode) and info.st_uid == self.uid and not info.st_mode & 0o022, 'protected_path')
    def read_fd(self, fd, maximum):
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1 and not info.st_mode & 0o077 and 0 <= info.st_size <= maximum, 'regular_file')
        os.lseek(fd, 0, os.SEEK_SET); parts = []; total = 0
        while True:
            self.check(); chunk = os.read(fd, min(65536, maximum + 1 - total))
            if not chunk: break
            total += len(chunk); need(total <= maximum, 'read_bound'); parts.append(chunk)
        need(stable(identity(info), identity(os.fstat(fd))), 'read_race')
        return b''.join(parts)
    def source_fd(self, name):
        self.check(); need(name == 'manifest.json' or re.fullmatch(r'table-[0-9]{4}-chunk-[0-9]{6}\.json', name), 'source_name')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.root_fd)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid and info.st_nlink == 1 and not info.st_mode & 0o077, 'source_file')
            self.native.lease(fd)
            self.handles[name] = fd
            return fd
        except BaseException:
            os.close(fd); raise
    def source_matches(self, name, expected, flags_changed=False):
        fd = self.root_fd if name == '.' else self.handles[name]
        actual = identity(os.fstat(fd))
        path = self.source if name == '.' else self.source + '/' + name
        observed = identity(os.lstat(path))
        need(stable(actual, observed) and stable(expected, actual, flags_changed), 'source_identity_changed')
        return actual
    def event(self, name, value):
        self.check(force_bindings=True); raw = canonical(value); need(len(raw) <= MAX_RECORD, 'journal_bound')
        temporary = name + '.tmp'
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.control_fd)
        try:
            offset = 0
            while offset < len(raw):
                self.check(); offset += os.write(fd, raw[offset:])
            os.fsync(fd)
        finally: os.close(fd)
        self.native.publish(self.control_fd, temporary, name); os.fsync(self.control_fd)
        return digest(raw)
    def load_event(self, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.control_fd)
        try:
            raw = self.read_fd(fd, MAX_RECORD); value = json.loads(raw, object_pairs_hook=pairs)
            need(canonical(value) == raw, 'journal_encoding')
            return value, digest(raw)
        finally: os.close(fd)
    def enroll(self):
        self.protected(self.source); self.protected(self.control)
        self.root_fd = os.open(self.source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.control_fd = os.open(self.control, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for fd in (self.root_fd, self.control_fd):
            info = os.fstat(fd); need(stat.S_ISDIR(info.st_mode) and info.st_uid == self.uid and stat.S_IMODE(info.st_mode) == 0o700, 'directory_owner')
        self.lock_fd = os.open('lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.control_fd)
        lock = os.fstat(self.lock_fd); need(stat.S_ISREG(lock.st_mode) and lock.st_uid == self.uid and lock.st_nlink == 1 and stat.S_IMODE(lock.st_mode) == 0o600, 'lock_owner')
        fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.check(force_bindings=True)
        manifest_fd = self.source_fd('manifest.json'); body = self.read_fd(manifest_fd, self.policy['manifestBytes'])
        need(len(body) == self.policy['manifestBytes'] and digest(body) == self.policy['manifest'], 'manifest_pin')
        manifest = json.loads(body, object_pairs_hook=pairs)
        need(manifest['operationId'] == self.policy['operation'] and manifest['snapshotSha256'] == self.policy['snapshot'] and manifest['catalogFingerprint'] == self.policy['catalog'] and len(manifest['tables']) == self.policy['tables'], 'manifest_context')
        plans = {'manifest.json': self.policy['manifest']}; rows = 0
        for table_index, table in enumerate(manifest['tables']):
            start = 0
            for ordinal, chunk in enumerate(table['chunks']):
                name = 'table-%04d-chunk-%06d.json' % (table_index, ordinal)
                need(chunk['file'] == name and name not in plans and chunk['table'] == table['name'] and chunk['ordinal'] == ordinal and chunk['startRow'] == start and type(chunk['rowCount']) is int and chunk['rowCount'] > 0 and re.fullmatch(r'[a-f0-9]{64}', chunk['sha256']), 'chunk_plan')
                start += chunk['rowCount']; plans[name] = chunk['sha256']; self.source_fd(name)
            need(start == table['rowCount'], 'table_rows'); rows += start
        need(len(plans) == self.policy['chunks'] + 1 and rows == self.policy['rows'], 'source_counts')
        self.plans = plans
        inventory = {'.': {'identity': identity(os.fstat(self.root_fd)), 'flags': self.native.flags(self.root_fd)}}
        for name, pin in plans.items():
            inventory[name] = {'identity': identity(os.fstat(self.handles[name])), 'flags': self.native.flags(self.handles[name]), 'sha256': pin}
        total = 0
        for name, pin in plans.items():
            fd = self.handles[name]; info = os.fstat(fd); maximum = self.policy['manifestBytes'] if name == 'manifest.json' else min(manifest['limits']['maximumChunkBytes'], 16777216)
            need(0 < info.st_size <= maximum, 'source_size'); os.lseek(fd, 0, os.SEEK_SET); hashed = hashlib.sha256(); read_bytes = 0
            while True:
                self.check(); chunk = os.read(fd, 65536)
                if not chunk: break
                hashed.update(chunk); read_bytes += len(chunk); total += len(chunk); need(read_bytes <= maximum and total <= 8 * 1024**3, 'source_size')
                pacing = total / (32 * 1024**2) - (time.monotonic() - self.began)
                if pacing > 0: time.sleep(min(pacing, 0.02))
            need(read_bytes == info.st_size and hashed.hexdigest() == pin, 'source_digest')
            self.source_matches(name, inventory[name]['identity'])
            self.drop_pages(name)
        self.check(force_bindings=True)
        self.source_matches('.', inventory['.']['identity'])
        proof = self.validator(self)
        need(proof['status'] == 'source-validated' and proof['manifestSha256'] == self.policy['manifest'] and proof['operationId'] == self.policy['operation'] and proof['snapshotSha256'] == self.policy['snapshot'] and proof['tables'] == self.policy['tables'] and proof['chunks'] == self.policy['chunks'] and proof['rows'] == self.policy['rows'] and proof['files'] == plans and proof['totalBytes'] == total and proof['rootIdentity'] == [inventory['.']['identity']['dev'], inventory['.']['identity']['ino']], 'native_validation_proof')
        self.check(force_bindings=True)
        for name, entry in inventory.items(): self.source_matches(name, entry['identity'])
        return inventory, proof
    def drop_pages(self, name):
        if hasattr(os, 'posix_fadvise') and name in self.handles:
            fd = self.handles[name]; size = os.fstat(fd).st_size
            try: os.posix_fadvise(fd, 0, size - size % os.sysconf('SC_PAGESIZE'), os.POSIX_FADV_DONTNEED)
            except OSError as error:
                if error.errno not in (errno.EINVAL, errno.ENOSYS, errno.EOPNOTSUPP): raise
    def run(self, action, expected_prepared=None):
        need(action in ('seal', 'recover'), 'action')
        try:
            inventory, proof = self.enroll(); names = sorted(n for n in inventory if n not in ('.', 'manifest.json')) + ['manifest.json', '.']
            entries = []
            with os.scandir(self.control_fd) as scan:
                for entry in scan:
                    self.check(); need(len(entries) < 2 * len(names) + 3, 'journal_file_count')
                    entries.append(entry.name)
            record_name = 'prepared.json'
            if action == 'seal':
                need(set(entries) == {'lock'}, 'unknown_journal_state')
                record = {'version': 1, 'source': self.source, 'policy': self.policy, 'controlIdentity': [os.fstat(self.control_fd).st_dev, os.fstat(self.control_fd).st_ino], 'lockIdentity': [os.fstat(self.lock_fd).st_dev, os.fstat(self.lock_fd).st_ino], 'codeSha256': self.code_pin, 'validatorSha256': self.validator_pin, 'inventory': inventory, 'proof': proof}
                prepared_pin = self.event(record_name, record)
            else:
                record, prepared_pin = self.load_event(record_name)
                need(prepared_pin == expected_prepared and record['source'] == self.source and record['policy'] == self.policy and record['codeSha256'] == self.code_pin and record['validatorSha256'] == self.validator_pin and record['proof'] == proof and record['controlIdentity'] == [os.fstat(self.control_fd).st_dev, os.fstat(self.control_fd).st_ino] and record['lockIdentity'] == [os.fstat(self.lock_fd).st_dev, os.fstat(self.lock_fd).st_ino], 'recovery_binding')
                need(set(record['inventory']) == set(inventory), 'recovery_inventory')
                allowed = {'lock', 'prepared.json', 'complete.json'} | {('%04d-%s.json' % (i, phase)) for i in range(len(names)) for phase in ('intent', 'done')}
                need(set(entries) <= allowed, 'unknown_journal_state')
                gap = False
                for i in range(len(names)):
                    for phase in ('intent', 'done'):
                        present = '%04d-%s.json' % (i, phase) in entries
                        need(not (gap and present), 'noncontiguous_journal')
                        if not present: gap = True
                need('complete.json' not in entries or not gap, 'noncontiguous_journal')
            expected_inventory = record['inventory']
            for index, name in enumerate(names):
                self.check(force_bindings=True); old = expected_inventory[name]; fd = self.root_fd if name == '.' else self.handles[name]
                intent_name, done_name = '%04d-intent.json' % index, '%04d-done.json' % index
                intent = {'preparedSha256': prepared_pin, 'index': index, 'name': name, 'identity': old['identity'], 'beforeFlags': old['flags'], 'afterFlags': old['flags'] | IMMUTABLE}
                if intent_name in entries:
                    stored, _ = self.load_event(intent_name); need(stored == intent, 'intent_binding')
                else:
                    need(done_name not in entries and 'complete.json' not in entries, 'unknown_journal_state')
                    self.source_matches(name, old['identity']); need(self.native.flags(fd) == old['flags'], 'unrecorded_flags')
                    self.event(intent_name, intent)
                current_flags = self.native.flags(fd)
                need(current_flags in (intent['beforeFlags'], intent['afterFlags']), 'unknown_flags')
                self.source_matches(name, old['identity'], flags_changed=current_flags == intent['afterFlags'])
                if done_name in entries:
                    stored, _ = self.load_event(done_name); need(stored['preparedSha256'] == prepared_pin and stored['index'] == index and stored['name'] == name and stored['flags'] == intent['afterFlags'] and stable(stored['identity'], identity(os.fstat(fd))), 'done_binding')
                    need(current_flags == intent['afterFlags'], 'sealed_flag_lost')
                else:
                    if current_flags != intent['afterFlags']: self.native.set_flags(fd, intent['afterFlags'])
                    self.check(); need(self.native.flags(fd) == intent['afterFlags'], 'flag_verify')
                    observed = self.source_matches(name, old['identity'], flags_changed=True)
                    self.event(done_name, {'preparedSha256': prepared_pin, 'index': index, 'name': name, 'flags': intent['afterFlags'], 'identity': observed})
            receipt = {'version': 1, 'scope': 'fixed-rehearsal-bundle-only', 'status': 'sealed', 'preparedSha256': prepared_pin, 'manifestSha256': self.policy['manifest'], 'fileCount': self.policy['chunks'] + 1, 'directoryCount': 1, 'source': self.source, 'codeSha256': self.code_pin, 'validatorSha256': self.validator_pin}
            if 'complete.json' in entries:
                stored, _ = self.load_event('complete.json'); need(stored == receipt, 'completion_binding')
            else: self.event('complete.json', receipt)
            return receipt
        finally:
            for fd in self.handles.values():
                try: self.native.release(fd)
                finally: os.close(fd)
            for fd in (self.lock_fd, self.control_fd, self.root_fd):
                if fd is not None: os.close(fd)

def admit_source_window(state, nonce, baseline_pin, probe=None):
    need(re.fullmatch(r'[a-f0-9]{16}', nonce or '') and re.fullmatch(r'[a-f0-9]{64}', baseline_pin or ''), 'maintenance_arguments')
    directory = '/var/lib/address-radar-maintenance/' + nonce
    def protected_read(path, maximum):
        state.protected(path)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try: return state.read_fd(fd, maximum)
        finally: os.close(fd)
    raw = protected_read(directory + '/baseline.json', 131072)
    need(digest(raw) == baseline_pin, 'maintenance_baseline_pin')
    baseline = json.loads(raw, object_pairs_hook=pairs)
    need(baseline['nonce'] == nonce and baseline['helperSha256'] == MAINT_SHA256, 'maintenance_baseline_scope')
    need(digest(protected_read(directory + '/helper.py', 2 * 1024**2)) == MAINT_SHA256, 'maintenance_helper_pin')
    def measured(argv):
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True, env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
        need(len(result.stdout) <= 16384, 'maintenance_probe_bound')
        return result.stdout.decode('ascii').strip()
    run = probe or measured
    timer = 'address-radar-maintenance-' + nonce + '.timer'
    unit = 'address-radar-maintenance-' + nonce + '.service'
    properties = run(['/usr/bin/systemctl','show',timer,'--property=Id,LoadState,ActiveState,SubState,Unit'])
    fields = dict(line.split('=',1) for line in properties.splitlines())
    need(fields == {'Id':timer,'LoadState':'loaded','ActiveState':'active','SubState':'waiting','Unit':unit}, 'maintenance_timer_state')
    path = run(['/usr/bin/busctl','call','org.freedesktop.systemd1','/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','GetUnit','s',timer])
    match = re.fullmatch(r'o "(/org/freedesktop/systemd1/unit/[A-Za-z0-9_]+)"',path)
    need(match, 'maintenance_timer_object')
    value = run(['/usr/bin/busctl','get-property','org.freedesktop.systemd1',match[1],'org.freedesktop.systemd1.Timer','NextElapseUSecMonotonic'])
    need(re.fullmatch(r't [0-9]+', value), 'maintenance_timer_monotonic')
    fire = int(value.split()[1]) / 1000000
    captured = baseline['capturedMonotonicUs'] / 1000000
    need(captured + 3300 <= fire <= captured + 3360 and fire + 240 <= baseline['deadlineMonotonicUs'] / 1000000, 'maintenance_original_deadline')
    command = run(['/usr/bin/systemctl','show',unit,'--property=ExecStart','--value'])
    argv = '/usr/bin/python3 ' + directory + '/helper.py restore --nonce ' + nonce + ' --baseline-sha256 ' + baseline_pin + ' --watchdog'
    need(re.search(r'argv\[\]=' + re.escape(argv) + r'\s*;',command), 'maintenance_restore_command')
    need(fire - time.monotonic() >= 2180, 'maintenance_admission_budget')
    state.watchdog_monotonic = fire
    return {'maintenanceNonce':nonce,'baselineSha256':baseline_pin,'watchdogMonotonicUs':int(fire*1000000),'scope':'source-only-no-window-mutation'}

# CLI permits only a fixed source and fixed registered code; no policy/env/argv bypass.
def cli():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('action', choices=('seal', 'recover')); parser.add_argument('--control-nonce', required=True); parser.add_argument('--code-sha256', required=True); parser.add_argument('--validator-sha256', required=True); parser.add_argument('--prepared-sha256'); parser.add_argument('--maintenance-nonce', required=True); parser.add_argument('--maintenance-baseline-sha256', required=True)
    args = parser.parse_args(); need(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux_root_required')
    need(re.fullmatch(r'[a-f0-9]{16}', args.control_nonce) and re.fullmatch(r'[a-f0-9]{64}', args.code_sha256) and re.fullmatch(r'[a-f0-9]{64}', args.validator_sha256), 'arguments')
    need(args.validator_sha256 == VALIDATOR_SHA256, 'registered_validator')
    need((args.action == 'seal' and args.prepared_sha256 is None) or (args.action == 'recover' and re.fullmatch(r'[a-f0-9]{64}', args.prepared_sha256 or '')), 'recovery_pin_required')
    control = CONTROL + '/' + args.control_nonce
    helper = TOOLS + '/' + args.code_sha256 + '/sealer.py'; validator = TOOLS + '/' + args.validator_sha256 + '/validator.mjs'
    need(str(Path(__file__).absolute()) == helper, 'registered_sealer')
    sealer = Sealer(SOURCE, control, lambda _: None, args.code_sha256, args.validator_sha256)
    for path, pin in ((helper, args.code_sha256), (validator, args.validator_sha256)):
        sealer.protected(path); fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try: need(digest(sealer.read_fd(fd, 2 * 1024**2)) == pin and sealer.native.flags(fd) & IMMUTABLE, 'code_pin')
        finally: os.close(fd)
    need(Path('/proc/1/comm').read_text().strip() == 'systemd' and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'), 'native_runtime')
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE); need(hard >= 4096, 'fd_limit'); resource.setrlimit(resource.RLIMIT_NOFILE, (max(soft, 4096), hard))
    # Control is explicit preinstalled root0700 with a permanent exclusive0600 lock.
    # No source or control inventory bootstrap occurs during recovery.
    def interrupted(*_): sealer.lost = True
    signal.signal(signal.SIGIO, interrupted); signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    sealer.resource_check = lambda: native_resources(None)
    admit_source_window(sealer, args.maintenance_nonce, args.maintenance_baseline_sha256)
    sealer.validator = lambda state: run_validator(state, validator)
    print(json.dumps(sealer.run(args.action, args.prepared_sha256), sort_keys=True, separators=(',', ':')))

def verify_node(state):
    state.protected(NODE_PATH)
    directory = os.open(os.path.dirname(NODE_PATH), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        need(state.native.flags(directory) & IMMUTABLE, 'runtime_directory_immutable')
        fd = os.open(NODE_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0 and before.st_nlink == 1 and not before.st_mode & 0o077 and before.st_mode & 0o100 and before.st_size == NODE_SIZE, 'runtime_owner_size')
        need(state.native.flags(fd) & IMMUTABLE, 'runtime_immutable')
        value = hashlib.sha256(); total = 0
        while True:
            state.check(); raw = os.read(fd, 65536)
            if not raw: break
            total += len(raw); need(total <= NODE_SIZE, 'runtime_size'); value.update(raw)
        need(total == NODE_SIZE and value.hexdigest() == NODE_SHA256, 'runtime_digest')
        need(stable(identity(before), identity(os.fstat(fd))) and stable(identity(before), identity(os.lstat(NODE_PATH))), 'runtime_race')
        return NODE_PATH
    finally:
        if fd is not None: os.close(fd)
        os.close(directory)

def run_validator(state, path):
    child = pidfd = selector = None
    try:
        child = subprocess.Popen(['/usr/bin/ionice', '-c', '3', '/usr/bin/nice', '-n', '19', verify_node(state), '--max-old-space-size=96', '--expose-gc', path], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
        pidfd = os.pidfd_open(child.pid)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        data = bytearray(); total = 0; proof = None; progress = set()
        while selector.get_map():
            state.check(); native_resources(child.pid if child.poll() is None else None)
            for key, _ in selector.select(0.1):
                raw = os.read(key.fileobj.fileno(), 65536)
                if raw:
                    data.extend(raw); total += len(raw); need(total <= MAX_RECORD, 'validator_output_bound')
                    while b'\n' in data:
                        line, _, tail = data.partition(b'\n'); data = bytearray(tail)
                        value = json.loads(line, object_pairs_hook=pairs)
                        if value.get('event') == 'chunk-validated':
                            name = value.get('file'); need(proof is None and name != 'manifest.json' and name in state.plans and name not in progress and value.get('sha256') == state.plans[name], 'validator_progress')
                            progress.add(name); state.drop_pages(name)
                        else:
                            need(proof is None and value.get('status') == 'source-validated', 'validator_result'); proof = value
                else: selector.unregister(key.fileobj)
        remaining = 1800 - (time.monotonic() - state.began); need(remaining > 10 and child.wait(timeout=min(remaining - 10, 5)) == 0, 'validator_exit')
        need(not data and proof is not None and len(progress) == state.policy['chunks'], 'validator_protocol')
        return proof
    finally:
        try:
            if child is not None:
                if pidfd is None:
                    # No safe signal authority: retain outer leases/lock until actual
                    # child exit or the managed unit kills the entire cgroup. Never
                    # treat transport exit or a numeric PID as retirement proof.
                    while child.poll() is None:
                        try: child.wait(timeout=0.1)
                        except subprocess.TimeoutExpired: pass
                elif child.poll() is None:
                    signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                    try: child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                        # If termination is delayed, retain leases for unit handoff.
                        while child.poll() is None:
                            try: child.wait(timeout=0.1)
                            except subprocess.TimeoutExpired: pass
        finally:
            if selector is not None: selector.close()
            if child is not None and child.stdout is not None: child.stdout.close()
            if pidfd is not None: os.close(pidfd)

def native_resources(pid=None):
    available = int(next(line for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')).split()[1]) * 1024
    pressure = float(re.search(r'^some avg10=([0-9.]+)', Path('/proc/pressure/memory').read_text(), re.M)[1])
    disk = os.statvfs(SOURCE)
    texts = [Path('/proc/self/status').read_text()]
    if pid is not None: texts.append(Path('/proc/' + str(pid) + '/status').read_text())
    rss = 0
    for text in texts:
        match = re.search(r'^VmRSS:\s+(\d+)', text, re.M)
        need(match is not None or re.search(r'^State:\s+Z', text, re.M), 'rss_unknown')
        if match: rss += int(match[1]) * 1024
    need(available >= 1024**3 and disk.f_bavail * disk.f_frsize >= 5 * 1024**3 and pressure <= 1 and rss <= 256 * 1024**2, 'resource_gate')

if __name__ == '__main__':
    try: cli()
    except BaseException as error:
        code = str(error) if isinstance(error, Refused) and re.fullmatch(r'[a-z0-9_]{1,80}', str(error)) else 'source_sealing_refused'
        print(json.dumps({'status': 'refused', 'code': code}, separators=(',', ':'))); sys.exit(1)
