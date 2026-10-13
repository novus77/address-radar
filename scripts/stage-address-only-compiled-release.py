#!/usr/bin/env python3
"""Exclusive code-only staging. Never executes release code or changes runtime state."""
import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import time

ROOT_UID = 0
ROOT_GID = 0
RELEASE_PARENT = '/opt/address-radar/releases'
RECEIPT_PARENT = '/var/lib/address-radar-maintenance-tools'
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_NODE = 256 * 1024 * 1024
NODE = ('/opt/address-radar/native-address-only-20261008/node',
        '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c')
PERMANENT = {
    'oldState': ('/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/activation-state.json',
                 '08675029e28bd49edc5541a9cca82d3524a0c2767d5c4502050a882c3f56c54f'),
    'originalManifest': ('/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4/address-only-manifest.json',
                         '05c98aeb298a4d2b774c6081ebf75b4b0426ab8adeef5f6612f09d5294ed473e'),
}
FILES = ('pg.mjs', 'scripts/postgres-address-only-dispatch.mjs', 'scripts/postgres-service-entry.mjs')
MEMBERS = {'.': 'directory', 'scripts': 'directory', **{name: 'file' for name in FILES}}
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC


def refuse(code):
    raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(path):
    if not os.path.isabs(path) or os.path.normpath(path) != path or '//' in path:
        refuse('noncanonical_path')


def directory_policy(fd):
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or (st.st_uid, st.st_gid) != (ROOT_UID, ROOT_GID) or st.st_mode & 0o022:
        refuse('unprotected_ancestor')
    try:
        os.stat('node_modules', dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    refuse('ambient_node_modules')


def protected_parent(path):
    """Return an anchored parent fd; every component is opened without following links."""
    canonical(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        directory_policy(fd)
        for part in path.split('/')[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            directory_policy(fd)
        return fd, os.path.basename(path)
    except BaseException:
        os.close(fd)
        raise


def stamp(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_uid, st.st_gid, st.st_mode, st.st_nlink)


def read_fd(fd, maximum, protected=False):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= maximum:
        refuse('invalid_regular_file')
    if protected and ((before.st_uid, before.st_gid) != (ROOT_UID, ROOT_GID) or before.st_mode & 0o022):
        refuse('unprotected_pin')
    data = bytearray()
    while len(data) <= maximum:
        block = os.read(fd, min(65536, maximum + 1 - len(data)))
        if not block:
            break
        data.extend(block)
    if len(data) != before.st_size or stamp(before) != stamp(os.fstat(fd)):
        refuse('file_changed_or_oversized')
    return bytes(data), before


def pin(path, expected, maximum):
    parent, name = protected_parent(path)
    try:
        fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=parent)
        try:
            data, st = read_fd(fd, maximum, protected=True)
            if digest(data) != expected:
                refuse('pin_digest_mismatch')
            if stamp(st) != stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)):
                refuse('pin_path_changed')
            return {'path': path, 'sha256': expected, 'bytes': len(data), 'mode': f'{stat.S_IMODE(st.st_mode):04o}',
                    'uid': st.st_uid, 'gid': st.st_gid}
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def load_archive(path, expected):
    if not re.fullmatch('[0-9a-f]{64}', expected):
        refuse('invalid_archive_digest')
    fd = os.open(path, os.O_RDONLY | NOFOLLOW)
    try:
        data, _ = read_fd(fd, MAX_ARCHIVE)
    finally:
        os.close(fd)
    if digest(data) != expected:
        refuse('archive_digest_mismatch')
    content, seen = {}, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        for member in archive:
            if len(seen) >= 5:
                refuse('archive_member_count')
            # Only the root './' and a directory trailing slash have aliases.
            aliases = {'.': '.', './': '.', 'scripts': 'scripts', 'scripts/': 'scripts',
                       **{name: name for name in FILES}}
            name = aliases.get(member.name)
            if name is None:
                refuse('archive_member_refused')
            if name not in MEMBERS or name in seen or member.pax_headers or member.sparse is not None:
                refuse('archive_member_refused')
            if member.mode & 0o7000 or member.linkname:
                refuse('archive_link_or_special_mode')
            if MEMBERS[name] == 'directory':
                if not member.isdir() or member.size != 0:
                    refuse('archive_directory_required')
            else:
                if not member.isreg() or not 0 < member.size <= MAX_FILE:
                    refuse('archive_regular_file_required')
                source = archive.extractfile(member)
                if source is None:
                    refuse('archive_missing_content')
                with source:
                    value = source.read(MAX_FILE + 1)
                if len(value) != member.size:
                    refuse('archive_size_mismatch')
                content[name] = value
            seen.add(name)
    if seen != set(MEMBERS):
        refuse('archive_member_count')
    return content, {'path': path, 'sha256': expected, 'bytes': len(data),
                     'allowedMembers': [{'path': name, 'kind': MEMBERS[name], 'bytes': len(content.get(name, b''))}
                                        for name in sorted(MEMBERS)],
                     'symlinks': 0, 'hardlinks': 0, 'dotDotMembers': 0, 'appleDoubleMembers': 0}


def wire_inventory(content):
    # Same sorted-child preorder and compact JSON wire encoding as the dispatcher/builder.
    pins = []
    for name in ('.', 'pg.mjs', 'scripts', 'scripts/postgres-address-only-dispatch.mjs', 'scripts/postgres-service-entry.mjs'):
        if name in ('.', 'scripts'):
            item = {'path': name, 'mode': 0o555, 'kind': 'directory'}
        else:
            item = {'path': name, 'mode': 0o444, 'kind': 'file', 'size': len(content[name]), 'sha256': digest(content[name])}
        pins.append(item)
    encoded = ''.join(json.dumps(item, separators=(',', ':')) + '\n' for item in pins).encode()
    return digest(encoded), [{**item, 'uid': ROOT_UID, 'gid': ROOT_GID} for item in pins]


def write_exclusive(parent, name, data, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            sent = os.write(fd, view)
            if sent <= 0:
                refuse('short_write')
            view = view[sent:]
        os.fchown(fd, ROOT_UID, ROOT_GID)
        os.fchmod(fd, mode)
        os.fsync(fd)
    finally:
        os.close(fd)


def stage(archive, archive_sha256, destination, receipt, transition_id, authorization_ref):
    if os.geteuid() != ROOT_UID:
        refuse('root_required')
    canonical(destination)
    canonical(receipt)
    if os.path.dirname(destination) != RELEASE_PARENT or not re.fullmatch('address-only-[a-z0-9-]{1,100}', os.path.basename(destination)):
        refuse('release_destination_refused')
    if not receipt.startswith(RECEIPT_PARENT + '/') or not receipt.endswith('.json'):
        refuse('receipt_destination_refused')
    if not re.fullmatch('[a-zA-Z0-9_-]{1,100}', transition_id) or not re.fullmatch('[a-zA-Z0-9_:-]{1,160}', authorization_ref):
        refuse('invalid_stage_metadata')
    content, archive_receipt = load_archive(archive, archive_sha256)
    node = pin(*NODE, MAX_NODE)
    if int(node['mode'], 8) & 0o111 == 0:
        refuse('node_not_executable')
    permanent = {name: pin(*value, MAX_FILE) for name, value in PERMANENT.items()}
    parent, leaf = protected_parent(destination)
    receipt_parent = root = scripts = receipt_fd = None
    try:
        # Both paths must be new. Never reuse/remove an interrupted release.
        try:
            os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            refuse('release_collision')
        receipt_parent, receipt_leaf = protected_parent(receipt)
        receipt_fd = os.open(receipt_leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=receipt_parent)
        os.fchown(receipt_fd, ROOT_UID, ROOT_GID)
        os.fchmod(receipt_fd, 0o600)
        os.fsync(receipt_fd)
        os.fsync(receipt_parent)
        os.mkdir(leaf, 0o700, dir_fd=parent)
        os.fsync(parent)
        root = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=parent)
        os.fchown(root, ROOT_UID, ROOT_GID)
        os.fchmod(root, 0o700)
        os.mkdir('scripts', 0o700, dir_fd=root)
        scripts = os.open('scripts', os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=root)
        os.fchown(scripts, ROOT_UID, ROOT_GID)
        for name, value in content.items():
            write_exclusive(scripts if name.startswith('scripts/') else root, name.split('/')[-1], value, 0o444)
        os.fchmod(scripts, 0o555)
        os.fsync(scripts)
        os.fchmod(root, 0o555)
        os.fsync(root)
        os.fsync(parent)
        # Re-read actual sealed files before issuing any success receipt.
        if set(os.listdir(root)) != {'scripts', 'pg.mjs'} or set(os.listdir(scripts)) != {name.split('/')[-1] for name in FILES if '/' in name}:
            refuse('sealed_inventory_changed')
        for directory in (root, scripts):
            st = os.fstat(directory)
            if (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)) != (ROOT_UID, ROOT_GID, 0o555):
                refuse('sealed_directory_mismatch')
        for name in FILES:
            directory = scripts if '/' in name else root
            fd = os.open(name.split('/')[-1], os.O_RDONLY | NOFOLLOW, dir_fd=directory)
            try:
                value, st = read_fd(fd, MAX_FILE, protected=True)
                if value != content[name] or stat.S_IMODE(st.st_mode) != 0o444:
                    refuse('sealed_file_mismatch')
            finally:
                os.close(fd)
        release_sha256, pins = wire_inventory(content)
        file_pins = {name: {'path': destination + '/' + name, 'sha256': digest(content[name]),
                           'bytes': len(content[name]), 'mode': '0444', 'uid': ROOT_UID, 'gid': ROOT_GID} for name in FILES}
        result = {'protocol': 'address-only-code-stage-receipt-v1', 'status': 'CODE_STAGED_ONLY', 'stageOnly': True,
                  'stagedAtMs': time.time_ns() // 1000000, 'transitionId': transition_id, 'authorizationRef': authorization_ref,
                  'archive': archive_receipt, 'release': {'root': destination, 'releaseSha256': release_sha256, 'entries': 5,
                  'bytes': sum(map(len, content.values())), 'pins': pins, 'entryPin': file_pins[FILES[2]],
                  'dispatcherPin': file_pins[FILES[1]], 'pgPin': file_pins[FILES[0]]},
                  'nativeNode': {'pin': node, 'reused': True}, 'permanentPins': permanent,
                  'safety': {'controllerInvoked': False, 'activationPerformed': False, 'servicesStopped': False,
                  'servicesRestarted': False, 'postgresConnected': False, 'postgresWrites': False,
                  'sqliteTouched': False, 'runtimeFilesModified': False, 'finalConfigurationCreated': False}}
        data = (json.dumps(result, sort_keys=True, indent=2) + '\n').encode()
        view = memoryview(data)
        while view:
            count = os.write(receipt_fd, view)
            if count <= 0:
                refuse('short_receipt_write')
            view = view[count:]
        os.fsync(receipt_fd)
        os.fsync(receipt_parent)
        return {'stageReceiptPin': {'path': receipt, 'sha256': digest(data)}, 'receipt': result}
    finally:
        for fd in (receipt_fd, scripts, root, receipt_parent, parent):
            if fd is not None:
                os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('archive', 'archive-sha256', 'destination', 'receipt', 'transition-id', 'authorization-ref'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        result = stage(args.archive, args.archive_sha256, args.destination, args.receipt, args.transition_id, args.authorization_ref)
    except FileExistsError:
        print(json.dumps({'status': 'REFUSED', 'reasonCode': 'path_collision'}))
        return 1
    except (ValueError, OSError, tarfile.TarError):
        print(json.dumps({'status': 'REFUSED', 'reasonCode': 'stage_validation_or_io_failed'}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
