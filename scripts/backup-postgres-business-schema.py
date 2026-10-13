"""Bounded PostgreSQL business-schema backup; never installs or enables a timer."""

import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid


ROOT_UID = 0
DEFAULT_TIMEOUT = 45
MAXIMUM_BYTES = 64 * 1024**2
DISK_FLOOR = 3 * 1024**3
METADATA_RESERVE = 65536
IDENTIFIER = re.compile(r'^[a-z_][a-z0-9_]{0,62}$')


class BackupError(RuntimeError):
    pass


def require(value, code):
    if not value:
        raise BackupError(code)


class Budget:
    def __init__(self, seconds=DEFAULT_TIMEOUT, started=None):
        self.started = time.monotonic() if started is None else started
        self.deadline = self.started + seconds

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'deadline')
        return remaining

    def check(self):
        self.remaining()


def canonical_path(value):
    require(isinstance(value, str) and value.startswith('/') and '\x00' not in value
            and os.path.normpath(value) == value and '//' not in value, 'path_refused')
    return Path(value)


def check_directory(info, private=False):
    require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, ROOT_UID)
            and not info.st_mode & 0o022, 'directory_refused')
    if private:
        require(info.st_uid == ROOT_UID and stat.S_IMODE(info.st_mode) == 0o700, 'private_directory_required')


def open_directory(path, private=False):
    path = canonical_path(str(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        check_directory(os.fstat(fd))
        for index, part in enumerate(path.parts[1:]):
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
            check_directory(os.fstat(fd), private and index == len(path.parts) - 2)
        if path == Path('/'):
            check_directory(os.fstat(fd), private)
        return fd
    except BaseException:
        os.close(fd)
        raise


def check_file(info, private=False, executable=False):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid in (0, ROOT_UID)
            and not info.st_mode & 0o022, 'file_refused')
    if private:
        require(info.st_uid == ROOT_UID and stat.S_IMODE(info.st_mode) == 0o600, 'private_file_required')
    if executable:
        require(info.st_mode & 0o111, 'executable_required')


def open_file(path, private=False, executable=False):
    path = canonical_path(path)
    parent = open_directory(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        check_file(os.fstat(fd), private, executable)
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def hash_descriptor(fd, budget, maximum=128 * 1024**2):
    before = identity(os.fstat(fd))
    digest = hashlib.sha256()
    size = 0
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        budget.check()
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        size += len(chunk)
        require(size <= maximum, 'input_cap')
        digest.update(chunk)
    require(identity(os.fstat(fd)) == before, 'input_changed')
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def available_bytes(fd):
    info = os.fstatvfs(fd)
    return info.f_bavail * info.f_frsize


def absent(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise BackupError('collision')


def write_all(fd, raw, budget):
    remaining = memoryview(raw)
    while remaining:
        budget.check()
        written = os.write(fd, remaining)
        require(written > 0, 'write_failed')
        remaining = remaining[written:]


def publish_json(fd, name, value, budget):
    """Publish without replacing any existing receipt or last-good record."""
    raw = json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()
    require(len(raw) <= METADATA_RESERVE, 'receipt_cap')
    temporary = '.' + name + '.pending-' + uuid.uuid4().hex
    pending = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        write_all(pending, raw, budget)
        os.fchmod(pending, 0o600)
        os.fsync(pending)
    finally:
        os.close(pending)
    budget.check()
    # link is an atomic no-replace publication. Only our successful temporary
    # metadata alias is removed; no archive, receipt or old success is deleted.
    os.link(temporary, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
    try:
        os.unlink(temporary, dir_fd=fd)
        os.fsync(fd)
        budget.check()
    except BaseException as error:
        raise BackupError('publication_uncertain') from error
    return hashlib.sha256(raw).hexdigest()


def settings_for(value):
    required = {'backupRoot', 'pgDump', 'pgDumpSha256', 'pgRestore', 'pgRestoreSha256',
                'passfile', 'host', 'port', 'database', 'schema', 'username'}
    optional = {'runId', 'timeoutSeconds', 'maximumBytes', 'minimumFreeBytes'}
    require(isinstance(value, dict) and required <= value.keys() and value.keys() <= required | optional, 'settings_refused')
    result = dict(value)
    result.setdefault('runId', time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:16])
    result.setdefault('timeoutSeconds', DEFAULT_TIMEOUT)
    result.setdefault('maximumBytes', MAXIMUM_BYTES)
    result.setdefault('minimumFreeBytes', DISK_FLOOR)
    for key in ('backupRoot', 'pgDump', 'pgRestore', 'passfile', 'host'):
        canonical_path(result[key])
    require(isinstance(result['runId'], str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', result['runId']), 'run_id_refused')
    require(all(isinstance(result[k], str) and IDENTIFIER.fullmatch(result[k]) for k in ('database', 'schema', 'username'))
            and result['schema'] == 'address_radar_business'
            and result['database'] not in ('postgres', 'template0', 'template1'), 'target_refused')
    for key in ('pgDumpSha256', 'pgRestoreSha256'):
        require(isinstance(result[key], str) and re.fullmatch('[a-f0-9]{64}', result[key]), 'binary_pin')
    for key, minimum, maximum in [('port', 1, 65535), ('timeoutSeconds', 1, DEFAULT_TIMEOUT),
                                   ('maximumBytes', 5, MAXIMUM_BYTES), ('minimumFreeBytes', DISK_FLOOR, 2**63 - 1)]:
        require(type(result[key]) is int and minimum <= result[key] <= maximum, 'budget_refused')
    return result


def run_process(argv, binary_fd, passfile_fd, environment, budget, sink, cap, space_check=None):
    budget.check()
    # Linux can execute the pinned descriptor. Darwin cannot execute /dev/fd;
    # local tests use the already-validated canonical path instead.
    executable = '/proc/self/fd/' + str(binary_fd) if sys.platform == 'linux' else argv[0]
    process = subprocess.Popen(argv, executable=executable,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=environment, pass_fds=(binary_fd, passfile_fd), start_new_session=True, close_fds=True)
    total = diagnostic_bytes = 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
            selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
            while selector.get_map():
                budget.check()
                if space_check:
                    space_check(0)
                for key, _events in selector.select(min(0.1, budget.remaining())):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == 'stderr':
                        diagnostic_bytes += len(chunk)
                        require(diagnostic_bytes <= 65536, 'diagnostic_cap')
                        continue
                    retained = chunk[:max(0, cap - total)]
                    if retained:
                        if space_check:
                            space_check(len(retained))
                        sink(retained)
                        total += len(retained)
                    require(len(retained) == len(chunk), 'size_cap')
        try:
            code = process.wait(timeout=budget.remaining())
        except subprocess.TimeoutExpired as error:
            raise BackupError('deadline') from error
        require(code == 0, 'dump_failed')
        budget.check()
        return total
    finally:
        # Always retire the entire newly-created group, including descendants
        # that outlive their leader. A failed dump is never retried automatically.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        process.stderr.close()


def backup(value, budget=None):
    budget = budget or Budget()
    require(os.geteuid() == ROOT_UID, 'root_required')
    settings = settings_for(value)
    budget.deadline = min(budget.deadline, budget.started + settings['timeoutSeconds'])
    root_path = Path(settings['backupRoot'])
    run_id = settings['runId']
    marker_name = 'last-good-' + run_id + '.json'
    with contextlib.ExitStack() as stack:
        def own(fd):
            stack.callback(os.close, fd)
            return fd

        root = own(open_directory(root_path, private=True))
        try:
            lock = own(os.open('.backup.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root))
        except FileExistsError:
            lock = own(os.open('.backup.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root))
        check_file(os.fstat(lock), private=True)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise BackupError('backup_busy') from error
        absent(root, run_id)
        absent(root, marker_name)

        def disk_gate(incoming=0):
            budget.check()
            require(available_bytes(root) >= settings['minimumFreeBytes'] + incoming + METADATA_RESERVE, 'disk_floor')

        disk_gate(settings['maximumBytes'])
        passfile = own(open_file(settings['passfile'], private=True))
        binaries = {}
        identities = {passfile: identity(os.fstat(passfile))}
        for name in ('pgDump', 'pgRestore'):
            fd = own(open_file(settings[name], executable=True))
            require(hash_descriptor(fd, budget) == settings[name + 'Sha256'], 'binary_pin')
            binaries[name] = fd
            identities[fd] = identity(os.fstat(fd))
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
            'PGPASSFILE': '/dev/fd/' + str(passfile), 'PGCONNECT_TIMEOUT': str(settings['timeoutSeconds']),
            'PGAPPNAME': 'address-radar-postgres-backup',
            'PGOPTIONS': '-c default_transaction_read_only=on -c statement_timeout=45000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=45000'}
        versions = {}
        for name, executable in [('pgDump', 'pg_dump'), ('pgRestore', 'pg_restore')]:
            captured = io.BytesIO()
            run_process([settings[name], '--version'], binaries[name], passfile, environment, budget, captured.write, 256)
            version = captured.getvalue().decode('ascii', errors='replace').strip()
            require(re.fullmatch(re.escape(executable) + r' \(PostgreSQL\) 16\.[0-9]+(?: .*)?', version), 'pg16_required')
            versions[name] = version

        budget.check()
        os.mkdir(run_id, 0o700, dir_fd=root)
        run = own(os.open(run_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root))
        check_directory(os.fstat(run), private=True)
        os.fsync(root)
        partial = own(os.open('business.dump.partial', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=run))
        digest = hashlib.sha256()
        magic = bytearray()

        def archive_sink(raw):
            if len(magic) < 5:
                magic.extend(raw[:5 - len(magic)])
            write_all(partial, raw, budget)
            digest.update(raw)

        argv = [settings['pgDump'], '--format=custom', '--schema=' + settings['schema'], '--strict-names',
                '--no-owner', '--no-acl', '--no-password', '--lock-wait-timeout=5s',
                '--host=' + settings['host'], '--port=' + str(settings['port']),
                '--username=' + settings['username'], '--dbname=' + settings['database']]
        size = run_process(argv, binaries['pgDump'], passfile, environment, budget, archive_sink, settings['maximumBytes'], disk_gate)
        require(bytes(magic) == b'PGDMP' and size == os.fstat(partial).st_size, 'archive_magic')
        os.fsync(partial)
        budget.check()
        archive = own(os.open('business.dump.partial', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=run))
        check_file(os.fstat(archive), private=True)
        # This only renders the already captured archive to stdout. No restore
        # connection or SQL execution occurs; generationHash binds its data SQL.
        restore_env = dict(environment)
        listing = io.BytesIO()
        restore_fds = binaries['pgRestore']
        restore_env.pop('PGPASSFILE')
        run_process([settings['pgRestore'], '--list', '/dev/fd/' + str(archive)], restore_fds, archive,
                    restore_env, budget, listing.write, 65536, disk_gate)
        require(re.search(rb'^\d+; \d+ \d+ TABLE DATA address_radar_business forward_strategy_generations \S+',
                          listing.getvalue(), re.MULTILINE), 'generation_missing')
        os.lseek(archive, 0, os.SEEK_SET)
        generation = hashlib.sha256()
        generation_bytes = run_process([settings['pgRestore'], '--data-only', '--schema=' + settings['schema'],
            '--table=forward_strategy_generations', '--no-owner', '--no-acl', '--file=-', '/dev/fd/' + str(archive)],
            restore_fds, archive, restore_env, budget, generation.update, 1024**2, disk_gate)
        require(generation_bytes > 0, 'generation_missing')
        for fd, before in identities.items():
            require(identity(os.fstat(fd)) == before, 'input_changed')
        for path, fd in [(root_path, root), (root_path / run_id, run)]:
            rebound = own(open_directory(path, private=True))
            require((os.fstat(rebound).st_dev, os.fstat(rebound).st_ino)
                    == (os.fstat(fd).st_dev, os.fstat(fd).st_ino), 'output_changed')
        disk_gate()
        absent(run, 'business.dump')
        os.rename('business.dump.partial', 'business.dump', src_dir_fd=run, dst_dir_fd=run)
        os.fsync(run)
        budget.check()
        receipt = {'protocol': 'postgres-business-schema-backup-v1', 'runId': run_id,
            'completedAtMs': int(time.time() * 1000), 'database': settings['database'], 'schema': settings['schema'],
            'archive': {'path': str(root_path / run_id / 'business.dump'), 'sha256': digest.hexdigest(), 'bytes': size},
            'generationHash': generation.hexdigest(), 'generationHashEncoding': 'pg-restore-table-data-sql-v1',
            'generationProjectionBytes': generation_bytes, 'tools': versions,
            'toolPins': {name: {'path': settings[name], 'sha256': settings[name + 'Sha256']} for name in binaries},
            'budgets': {key: settings[key] for key in ('timeoutSeconds', 'maximumBytes', 'minimumFreeBytes')},
            'readOnlyRequested': True, 'includesSchemaData': True, 'restoreVerified': False,
            'rolesAndAclRestored': False, 'completeClusterBackup': False}
        receipt_sha = publish_json(run, 'receipt.json', receipt, budget)
        receipt_pin = {'path': str(root_path / run_id / 'receipt.json'), 'sha256': receipt_sha}
        disk_gate()
        marker = {'protocol': 'postgres-business-schema-last-good-v1', 'runId': run_id,
                  'completedAtMs': receipt['completedAtMs'], 'receipt': receipt_pin, 'archiveSha256': digest.hexdigest()}
        marker_sha = publish_json(root, marker_name, marker, budget)
        return {'status': 'ok', 'runId': run_id, 'receipt': receipt_pin,
                'lastGood': {'path': str(root_path / marker_name), 'sha256': marker_sha}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args(argv)
    budget = Budget()
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    def expired(_signum, _frame):
        raise BackupError('deadline')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, DEFAULT_TIMEOUT)
    try:
        require(os.geteuid() == ROOT_UID, 'root_required')
        fd = open_file(args.config, private=True)
        try:
            require(os.fstat(fd).st_size <= 65536, 'config_cap')
            raw = os.read(fd, 65537)
            require(len(raw) <= 65536, 'config_cap')
        finally:
            os.close(fd)
        value = settings_for(json.loads(raw))
        budget.deadline = budget.started + value['timeoutSeconds']
        signal.setitimer(signal.ITIMER_REAL, budget.remaining())
        result = backup(value, budget)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, BackupError) else 'io_refused'
        print(json.dumps({'status': 'refused', 'code': code}, separators=(',', ':')), file=sys.stderr)
        return 1
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0:
            signal.setitimer(signal.ITIMER_REAL, previous_timer[0], previous_timer[1])


if __name__ == '__main__':
    raise SystemExit(main())
