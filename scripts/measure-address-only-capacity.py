"""Bounded native module-startup measurement, not a steady-state capacity approval."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import time

BASE = Path('/var/lib/address-radar-maintenance-tools')
NODE = BASE / 'native-node-7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c/node'
SERVICES = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console']
WORKER = """
await import(process.env.ADDRESS_RADAR_CAPACITY_MODULE);
process.stdout.write('ready\\n');
process.stdin.once('data', () => process.exit(0));
setTimeout(() => process.exit(2), 15000).unref();
"""


def require(value, code):
    if not value:
        raise RuntimeError(code)


def check_headroom(memory, disk):
    require(memory >= 1024**3, 'memory_headroom')
    require(disk >= 5 * 1024**3, 'disk_headroom')


def make_receipt(ready, peak, bundle_sha, node_sha, host):
    require(ready == 6 and type(peak) is int and 0 < peak <= 512 * 1024**2, 'incomplete_measurement')
    return dict(version=1, scope='six-process-module-startup-only', readyProcesses=ready,
                measuredPeakRamBytes=str(peak), moduleSha256=bundle_sha, nodeSha256=node_sha,
                observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                host=host, steadyStateCapacityVerified=False, activationAuthorized=False,
                databaseWritten=False, businessServicesChanged=False)


def protected(path, expected_sha):
    require(re.fullmatch('[a-f0-9]{64}', expected_sha), 'invalid_pin')
    for parent in (path.parent, *path.parents[1:]):
        value = parent.lstat()
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022, 'unsafe_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and before.st_size <= 128 * 1024**2, 'unsafe_file')
        digest = hashlib.sha256()
        while True:
            part = os.read(fd, 65536)
            if not part:
                break
            digest.update(part)
        after = os.fstat(fd)
        pin = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(pin(before) == pin(after) == pin(path.lstat()) and digest.hexdigest() == expected_sha, 'changed_file')
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--node-sha256', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'root_required')
    directory = Path(args.directory)
    require(directory == BASE / ('address-only-runtime-' + args.bundle_sha256), 'invalid_directory')
    require(stat.S_IMODE(directory.lstat().st_mode) == 0o700, 'private_directory_required')
    bundle = directory / 'runtime.mjs'
    protected(bundle, args.bundle_sha256)
    protected(NODE, args.node_sha256)
    memory = next(int(line.split()[1]) * 1024 for line in open('/proc/meminfo') if line.startswith('MemAvailable:'))
    disk = shutil.disk_usage('/var/lib/postgresql').free
    check_headroom(memory, disk)
    cgroup = next(line.strip().split('::', 1)[1] for line in open('/proc/self/cgroup') if line.startswith('0::'))
    require(re.fullmatch('/system.slice/address-radar-capacity-[a-f0-9]{16}\.service', cgroup), 'bounded_unit_required')
    peak_path = Path('/sys/fs/cgroup' + cgroup) / 'memory.peak'
    require((peak_path.parent / 'memory.max').read_text().strip() == str(512 * 1024**2), 'memory_limit_required')
    selector = selectors.DefaultSelector()
    children = []
    try:
        for service in SERVICES:
            environment = {'PATH': '/usr/bin:/bin', 'ADDRESS_RADAR_CAPACITY_MODULE': bundle.as_uri(),
                           'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED': 'false', 'ADDRESS_RADAR_SERVICE': service}
            child = subprocess.Popen([str(NODE), '--max-old-space-size=48', '--input-type=module', '-e', WORKER],
                                     env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            children.append(child)
            selector.register(child.stdout, selectors.EVENT_READ, child)
        ready = 0
        deadline = time.monotonic() + 15
        while ready < 6:
            require(time.monotonic() < deadline, 'startup_deadline')
            for key, _ in selector.select(timeout=min(1, deadline - time.monotonic())):
                require(key.fileobj.readline() == b'ready\n', 'worker_load_failed')
                selector.unregister(key.fileobj)
                ready += 1
            require(all(child.poll() is None for child in children), 'worker_exited_early')
        peak = int(peak_path.read_text())
        receipt = make_receipt(ready, peak, args.bundle_sha256, args.node_sha256,
                               dict(availableRamBytes=str(memory), availableDiskBytes=str(disk),
                                    bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip()))
        for child in children:
            child.stdin.write(b'exit\n')
            child.stdin.flush()
        require(all(child.wait(timeout=3) == 0 for child in children), 'worker_shutdown_failed')
        target = directory / 'startup-capacity-receipt.json'
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(receipt, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        print(json.dumps(receipt, sort_keys=True))
    finally:
        selector.close()
        for child in children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)


if __name__ == '__main__':
    main()
