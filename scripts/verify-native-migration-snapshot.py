#!/usr/bin/env python3
"""Actual independent SQLite artifact checks; no authority, signing or fence claims.

The native caller must validate its protected job, managed lease and approved
request-scoped output before invoking this library. No host admission is implied
by importing it or by passing a callback.
"""
import datetime
import hashlib
import json
import os
import pathlib
import stat
import time


class Refused(Exception):
    pass


def require(value, reason):
    if not value:
        raise Refused(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def instant():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def file_sha256(path, deadline, check):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and before.st_size <= 32 * 1024 ** 3, 'snapshot-file')
        digest = hashlib.sha256()
        while True:
            require(time.monotonic() < deadline, 'original-deadline')
            check()
            part = os.read(fd, 65536)
            if not part:
                break
            digest.update(part)
        after = os.fstat(fd)
        live = os.lstat(path)
        pin = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(pin(before) == pin(after) == pin(live), 'snapshot-mutated')
        return digest.hexdigest()
    finally:
        os.close(fd)


def verify_snapshot_artifacts(measurement, producer_directory, output_directory, helper,
                              collector, deadline, reserve_bytes, operation_id, check=lambda: None):
    require(time.monotonic() < deadline, 'original-deadline')
    check()
    require(measurement['version'] == 1 and measurement['kind'] == 'native-snapshot-measurement'
            and measurement['sourceWrites'] is False and measurement['signedProofsCreated'] is False,
            'producer-measurement')
    snapshot = pathlib.Path(producer_directory) / 'snapshot.sqlite'
    original_sha = file_sha256(snapshot, deadline, check)
    require(original_sha == measurement['snapshotSha256'], 'snapshot-pin')
    started = instant()
    verified = collector.collect_snapshot(snapshot, pathlib.Path(output_directory), helper,
                                          deadline, reserve_bytes, operation_id, check)
    require(time.monotonic() < deadline, 'original-deadline')
    check()
    for field in ('tables', 'tableCensusSha256', 'catalogFingerprint'):
        require(canonical(verified[field]) == canonical(measurement[field]), 'independent-parity')
    require(file_sha256(snapshot, deadline, check) == original_sha, 'snapshot-mutated')
    check()
    return dict(version=1, kind='independent-snapshot-artifact-check',
                source=measurement['source'], snapshotSha256=original_sha,
                producerMeasurementSha256=hashlib.sha256(canonical(measurement)).hexdigest(),
                catalogFingerprint=verified['catalogFingerprint'], tables=verified['tables'],
                tableCensusSha256=verified['tableCensusSha256'],
                parityReceiptSha256=verified['parityReceiptSha256'],
                restoreReceiptSha256=verified['restoreReceiptSha256'],
                startedAt=started, completedAt=instant(), sourceWrites=False,
                signedProofsCreated=False, fenceEstablished=False)


def verify_current_source_snapshot(measurement, source_pin, output_directory, helper,
                                   collector, deadline, reserve_bytes, operation_id, check):
    """Reject a stale sealed artifact by independently measuring the fenced source.

    Permission/drain/managed-unit enforcement belongs to the protected native
    caller. This function does not manufacture that enforcement from callbacks.
    """
    require(time.monotonic() < deadline, 'original-deadline')
    expected = dict(path=source_pin['path'], device=str(source_pin['identity'][0]),
                    inode=str(source_pin['identity'][1]))
    require(measurement['source'] == expected, 'producer-source-binding')
    check()
    current = collector.collect_snapshot(pathlib.Path(source_pin['path']),
                pathlib.Path(output_directory), helper, deadline, reserve_bytes, operation_id, check)
    require(time.monotonic() < deadline, 'original-deadline')
    require(current['source'] == expected, 'current-source-binding')
    for field in ('tables', 'tableCensusSha256', 'catalogFingerprint'):
        require(canonical(current[field]) == canonical(measurement[field]), 'stale-snapshot-artifact')
    check()
    return dict(currentSourceMeasurementSha256=hashlib.sha256(canonical(current)).hexdigest(),
                currentSourceRestoreReceiptSha256=current['restoreReceiptSha256'],
                currentSourceParityReceiptSha256=current['parityReceiptSha256'])
