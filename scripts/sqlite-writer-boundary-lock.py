#!/usr/bin/env python3
"""Inherited-OFD shared locks and root-only atomic admission revocation."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import stat
import sys
import uuid

CONTROL = '/etc/address-radar/sqlite-writer-admission'


class Refused(Exception):
    pass


def require(condition):
    if not condition:
        raise Refused('BOUNDARY_UNRESOLVED')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def protected(path, limit=1024 * 1024):
    require(os.path.isabs(path) and os.path.normpath(path) == path)
    parents = []
    parent = os.path.dirname(path)
    while True:
        value = os.lstat(parent)
        require(stat.S_ISDIR(value.st_mode) and value.st_uid == 0 and not value.st_mode & 0o022)
        parents.append((parent, value.st_dev, value.st_ino))
        if parent == '/':
            break
        parent = os.path.dirname(parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and before.st_nlink == 1 and not before.st_mode & 0o022 and before.st_size <= limit)
        chunks = []
        count = 0
        while True:
            chunk = os.read(fd, min(65536, limit + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
            require(count <= limit)
        raw = b''.join(chunks)
        after = os.fstat(fd)
        live = os.lstat(path)
        require(len(raw) == before.st_size
                and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and (live.st_dev, live.st_ino) == (before.st_dev, before.st_ino))
        for name, dev, ino in parents:
            require((os.lstat(name).st_dev, os.lstat(name).st_ino) == (dev, ino))
        return raw
    finally:
        os.close(fd)


def record(expected_sha):
    raw = protected(CONTROL + '/boundary.json')
    require(hashlib.sha256(raw).hexdigest() == expected_sha)
    value = json.loads(raw)
    require(raw == canonical(value) and value['version'] == 1
            and value['lock']['path'] == CONTROL + '/boundary.lock')
    require(hashlib.sha256(protected(os.path.realpath(__file__))).hexdigest() == value['helper']['sha256'])
    require(hashlib.sha256(protected(os.path.realpath(sys.executable), 256 * 1024 * 1024)).hexdigest() == value['python']['sha256'])
    return value


def acquire_fd(fd, device, inode, owner_uid=0, exclusive=False):
    value = os.fstat(fd)
    require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_uid == owner_uid
            and stat.S_IMODE(value.st_mode) == 0o644
            and (value.st_dev, value.st_ino) == (int(device), int(inode)))
    fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)


@contextlib.contextmanager
def revocation_lease(expected_record_sha):
    require(sys.platform == 'linux' and os.geteuid() == 0)
    value = record(expected_record_sha)
    fd = os.open(value['lock']['path'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        acquire_fd(fd, value['lock']['device'], value['lock']['inode'], exclusive=True)
        require(record(expected_record_sha) == value)
        live = os.lstat(value['lock']['path'])
        require((live.st_dev, live.st_ino) == (os.fstat(fd).st_dev, os.fstat(fd).st_ino))
        yield value
    finally:
        os.close(fd)


def revoke(expected_record_sha, expected_state_sha):
    with revocation_lease(expected_record_sha) as boundary:
        state_path = CONTROL + '/state.json'
        raw = protected(state_path)
        require(hashlib.sha256(raw).hexdigest() == expected_state_sha)
        state = json.loads(raw)
        policy_raw = protected(CONTROL + '/policy.json')
        policy = json.loads(policy_raw)
        require(raw == canonical(state) and policy_raw == canonical(policy)
                and hashlib.sha256(policy_raw).hexdigest() == boundary['policySha256']
                and state['policySha256'] == boundary['policySha256']
                and state['deploymentId'] == policy['deploymentId']
                and state['challengeId'] == policy['challengeId']
                and state['notBefore'] == policy['notBefore'] and state['notAfter'] == policy['notAfter']
                and type(state['revision']) is str and state['revision'].isdigit()
                and 1 <= len(state['revision']) <= 20)
        state['admission'] = 'closed'
        state['revision'] = str(int(state['revision']) + 1)
        output = canonical(state)
        directory = os.open(CONTROL, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temporary = '.state-' + uuid.uuid4().hex
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            try:
                view = memoryview(output)
                while view:
                    written = os.write(fd, view)
                    require(written > 0)
                    view = view[written:]
                os.fchmod(fd, 0o644)
                os.fsync(fd)
            finally:
                os.close(fd)
            require(hashlib.sha256(protected(state_path)).hexdigest() == expected_state_sha)
            require(record(expected_record_sha) == boundary)
            os.replace(temporary, 'state.json', src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)
            require(protected(state_path) == output)
        finally:
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            os.close(directory)
        return hashlib.sha256(output).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--shared', action='store_true')
    modes.add_argument('--revoke', action='store_true')
    parser.add_argument('--record-sha256', required=True)
    parser.add_argument('--expected-state-sha256')
    args = parser.parse_args()
    require(sys.platform == 'linux' and sys.flags.isolated and sys.dont_write_bytecode)
    if args.shared:
        require(args.expected_state_sha256 is None)
        value = record(args.record_sha256)
        acquire_fd(3, value['lock']['device'], value['lock']['inode'])
        live = os.lstat(value['lock']['path'])
        require((live.st_dev, live.st_ino) == (os.fstat(3).st_dev, os.fstat(3).st_ino))
        # Do not unlock. The parent owns the same OFD after this helper exits.
    else:
        require(args.expected_state_sha256 is not None)
        sha = revoke(args.record_sha256, args.expected_state_sha256)
        print(json.dumps(dict(status='revoked', stateSha256=sha), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"refused","code":"BOUNDARY_UNRESOLVED"}', file=sys.stderr)
        sys.exit(2)
