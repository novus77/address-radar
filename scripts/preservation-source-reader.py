"""Private fixture-only immutable source reader. No database or cache-wide operations."""
import errno
import hashlib
import json
import os
import re
import stat
import sys
import time

ROOT = '/var/backups/address-radar/migration-rehearsals/preparation-20261004-largechunk-9c8ae4bf/bundle'
MANIFEST_SHA = 'd73b0c6f794c649058072cd07ea2af6989193f5e8c705456e9d82d0e25e7350c'
BLOCK = 64 * 1024
RATE = 32 * 1024 * 1024
DONTNEED = getattr(os, 'POSIX_FADV_DONTNEED', 4)

def identity(s):
    return {key: getattr(s, 'st_' + key) for key in ('dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns')}

def same_identity(a, b):
    return a == b and set(a) == {'dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtime_ns', 'ctime_ns'}

def recent_witness_matches(witness, current, known_sha, now_ms, external_scope):
    # This predicate does not grant authority or skip any reads. The executable below
    # always hashes freshly: the previous receipt has no complete identity inventory.
    return (external_scope == 'recent-isolated-cached-witness' and witness.get('complete') is True
            and witness.get('sha256') == known_sha and same_identity(witness.get('identity', {}), current)
            and type(witness.get('validatedAtMs')) is int and 0 <= now_ms - witness['validatedAtMs'] <= 900_000)

def release_read_pages(fd, start, end, advice, page_size):
    aligned_start = (start + page_size - 1) // page_size * page_size
    aligned_end = end // page_size * page_size
    if advice is None: return 'unsupported'
    if aligned_end <= aligned_start: return 'no_complete_page'
    try:
        advice(fd, aligned_start, aligned_end - aligned_start, DONTNEED)
        return 'released'
    except OSError as error:
        if error.errno in (errno.ENOSYS, errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP): return 'unsupported'
        raise RuntimeError('source_reader_advice_failed') from error

def stream_fd(fd, size, expected_sha, emit, guard, advice=getattr(os, 'posix_fadvise', None), sleep=time.sleep, clock=time.monotonic):
    before = identity(os.fstat(fd))
    if before['size'] != size: raise RuntimeError('source_reader_size')
    digest = hashlib.sha256(); offset = 0
    advice_counts = {'released': 0, 'unsupported': 0, 'no_complete_page': 0}
    page_size = os.sysconf('SC_PAGE_SIZE')
    while offset < size:
        guard()
        block_started = clock()
        body = os.read(fd, min(BLOCK, size - offset))
        if not body: raise RuntimeError('source_reader_short_read')
        digest.update(body)
        advice_counts[release_read_pages(fd, offset, offset + len(body), advice, page_size)] += 1
        offset += len(body)
        emit(body)
        delay = len(body) / RATE - (clock() - block_started)
        if delay > 0: sleep(delay)
    guard()
    after = identity(os.fstat(fd))
    if not same_identity(before, after): raise RuntimeError('source_reader_metadata_changed')
    if digest.hexdigest() != expected_sha: raise RuntimeError('source_reader_digest')
    return {'sha256': digest.hexdigest(), 'identity': {k: str(v) for k, v in after.items()},
            'bytes': offset, 'advice': advice_counts, 'freshHash': True, 'cachedWitnessUsed': False}

def write_all(sink, body):
    view = memoryview(body)
    while view:
        written = sink.write(view)
        if type(written) is not int or written <= 0 or written > len(view):
            raise RuntimeError('source_reader_short_write')
        view = view[written:]

def manifest_plans(parts):
    manifest = json.loads(b''.join(parts))
    plans = {'manifest.json': MANIFEST_SHA}
    for table in manifest['tables']:
        for chunk in table['chunks']:
            name = chunk['file']; digest = chunk['sha256']
            if (type(name) is not str or name in plans or not re.fullmatch(r'table-[0-9]{4}-chunk-[0-9]{6}\.json', name)
                    or type(digest) is not str or not re.fullmatch(r'[a-f0-9]{64}', digest)):
                raise RuntimeError('source_reader_plan')
            plans[name] = digest
    return plans

def serve_requests(source, sink, opened, guard):
    # Do not scan the manifest behind admission/install: the first explicit request
    # supplies its fresh, pinned hash and the only source of allowed chunk names.
    plans = {'manifest.json': MANIFEST_SHA}; initialized = False
    def line(value):
        write_all(sink, json.dumps(value, separators=(',', ':')).encode() + b'\n'); sink.flush()
    while True:
        request = source.readline(257)
        if not request: return
        if len(request) > 256 or not request.endswith(b'\n'): raise RuntimeError('source_reader_request')
        value = json.loads(request)
        if (type(value) is not dict or set(value) != {'file', 'maximum'} or type(value['file']) is not str
                or value['file'] not in plans or type(value['maximum']) is not int
                or not 1 <= value['maximum'] <= 16 * 1024 ** 2):
            raise RuntimeError('source_reader_request')
        guard(); fd, info = opened(value['file'])
        try:
            if info.st_size > value['maximum']: raise RuntimeError('source_reader_size')
            if value['file'] == 'manifest.json' and info.st_size != 545010: raise RuntimeError('source_reader_manifest_size')
            line({'size': info.st_size})
            parts = [] if not initialized else None
            def emit(body):
                write_all(sink, body)
                if parts is not None: parts.append(body)
            result = stream_fd(fd, info.st_size, plans[value['file']], emit, guard)
            if parts is not None:
                plans = manifest_plans(parts); parts.clear(); initialized = True
            line(result)
        finally: os.close(fd)

def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[0-9]{13}', sys.argv[1]) or os.geteuid() != 0:
        raise RuntimeError('source_reader_scope')
    deadline_ms = int(sys.argv[1]); last_check = 0
    def guard():
        nonlocal last_check
        now = time.monotonic()
        if time.time() * 1000 >= deadline_ms: raise RuntimeError('source_reader_deadline')
        if now - last_check < .25: return
        last_check = now
        with open('/proc/meminfo') as f: available = int(re.search(r'^MemAvailable:\s+(\d+)', f.read(), re.M)[1]) * 1024
        with open('/proc/pressure/memory') as f: psi = float(re.search(r'^some avg10=([0-9.]+)', f.read(), re.M)[1])
        disk = os.statvfs('/tmp')
        if available < 1024 ** 3: raise RuntimeError('source_reader_memory_reserve')
        if psi > 1: raise RuntimeError('source_reader_pressure')
        if disk.f_bavail * disk.f_frsize < 5 * 1024 ** 3: raise RuntimeError('source_reader_disk_reserve')
    if os.path.realpath(ROOT) != ROOT: raise RuntimeError('source_reader_path')
    def opened(name):
        if name != 'manifest.json' and not re.fullmatch(r'table-[0-9]{4}-chunk-[0-9]{6}\.json', name):
            raise RuntimeError('source_reader_filename')
        fd = os.open(ROOT + '/' + name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o077:
            os.close(fd); raise RuntimeError('source_reader_owner')
        return fd, s
    serve_requests(sys.stdin.buffer, sys.stdout.buffer, opened, guard)

if __name__ == '__main__':
    try: main()
    except Exception as error:
        reason = str(error)
        if not reason.startswith('source_reader_'): reason = 'source_reader_failed'
        sys.stderr.write(reason + '\n'); sys.exit(1)
