#!/usr/bin/env python3
"""Prepare private c metadata only. Never activates services, opens PG, or calls RPC."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

B_ROOT = '/var/lib/address-radar-maintenance-tools/configured-stability-20261009b'
C_ROOT = '/var/lib/address-radar-maintenance-tools/configured-stability-20261009c'
B_RELEASE = '/opt/address-radar/releases/address-only-stability-20261009b'
C_RELEASE = '/opt/address-radar/releases/address-only-stability-20261009c'
ORIGIN_ROOT = '/var/lib/address-radar-maintenance-tools/address-only-run-20261008-final4'
NODE = {'path': '/opt/address-radar/native-address-only-20261008/node',
        'sha256': '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c'}
RELEASE_SHA = '51383e1553a28d0044958a53e6c59379597066dcc43ccb34aab9cd45c72f7ca1'
ENTRY_SHA = '02e0c280650b7f8ea240a916bd0739efedaa04f4e25394565b6d7f8129027479'
GENERATION = 'production-20261006-v1'
ACTIVATED_AT = 1791442257867
B_PINS = {
    'authority.json': 'af2ad1ea5b8a8455d82cab54761b27809c82a4e49ddd6bbad525e7544112b440',
    'deployment.json': '972873152f85539374088a497fd42ccd11e0356c9e169cfa40be8d505603e70e',
    'environment.json': '455e252f9c1b36d1cf22c78df5d44657063807b8067929e8602712440b57a5e4',
    'request-template.json': 'b47ab7f1521a9c4218695da5b42a6ac031b3bd02c3153955c6cf09facd3f8795',
}
SAFETY = ('gatewayDeliveryEnabled', 'fomoEnabled', 'fullHistoricalMiningEnabled')
CHANGED = ('release-binding', 'authority-file-pin', 'deployment-file-pin', 'configured-origin-b',
           'deadline-template-zero', 'wallet-quota-1', 'wallet-run-24000', 'wallet-lease-60000',
           'poll-30000', 'wallet-interval-5000', 'execution-receiver-5000', 'solana-batch-1',
           'solana-signatures-10', 'receipt-bound-evm-floors')


class Refused(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def integer(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def file_stamp(value):
    # Reading may legitimately update atime; mutation-sensitive metadata must not.
    return (value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_uid,
            value.st_gid, value.st_nlink, value.st_mtime_ns, value.st_ctime_ns)


def pin(value):
    require(type(value) is dict and set(value) == {'path', 'sha256'}, 'pin_fields')
    require(type(value['path']) is str and value['path'].startswith('/')
            and os.path.normpath(value['path']) == value['path']
            and re.fullmatch('[a-f0-9]{64}', value['sha256'] or ''), 'pin_binding')
    return value


def validate_job(job):
    require(type(job) is dict and set(job) == {'protocol', 'floorReceipt', 'journal', 'receipt', 'authorizationRef'}, 'job_fields')
    require(job['protocol'] == 'address-only-stability-c-metadata-job-v1', 'job_protocol')
    require(type(job['authorizationRef']) is str and 0 < len(job['authorizationRef']) <= 512
            and not any(ord(c) < 32 for c in job['authorizationRef']), 'authorization_reference')
    for key in ('floorReceipt', 'journal', 'receipt'):
        pin(job[key])
    for key, suffix in (('journal', 'state'), ('receipt', 'receipt')):
        require(job[key]['path'] == ORIGIN_ROOT + '/configured-stability-20261009b-' + suffix + '.json', 'origin_path')
    return job


def build_metadata(source, job, floor, journal, receipt, original):
    """Pure transformation; only private pinned inputs from the native runner are trusted."""
    validate_job(job)
    a, d, e, r = (copy.deepcopy(source[n]) for n in B_PINS)
    require(r['protocol'] == 'address-only-configured-transition-v1' and r['releaseRoot'] == B_RELEASE
            and r['node'] == NODE and d['releaseRoot'] == B_RELEASE, 'b_release_binding')
    require(r['deployment'] == {'path': B_ROOT + '/deployment.json', 'sha256': B_PINS['deployment.json']}
            and r['environment'] == {'path': B_ROOT + '/environment.json', 'sha256': B_PINS['environment.json']}, 'b_request_pins')
    pin(r['oldState']); pin(r['originalManifest'])
    require(d['generationId'] == GENERATION and d['activatedAt'] == ACTIVATED_AT
            and original['generationId'] == GENERATION and original['activatedAt'] == ACTIVATED_AT, 'activation_binding')
    manifest = d['cutover']['addressOnly']
    require(manifest == dict(original, releaseSha256=r['releaseSha256'])
            and a['generationId'] == GENERATION and a['operationId'] == d['operationId'] == original['operationId']
            and a['releaseSha256'] == r['releaseSha256'], 'authority_manifest_binding')
    require(e['ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE'] == B_ROOT + '/authority.json'
            and e['ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256'] == B_PINS['authority.json'], 'authority_environment_pin')
    require(journal.get('phase') == 'COMPLETE' and journal.get('pending') is None
            and journal.get('receipt') == receipt and journal['transitionId'] == receipt['transitionId']
            and journal['operationId'] == original['operationId']
            and journal['release']['releaseSha256'] == r['releaseSha256']
            and journal['configuredReleaseRoot'] == B_RELEASE and journal['node']['sha256'] == NODE['sha256']
            and journal['walletServiceUser'] == r['walletServiceUser'], 'complete_origin_binding')
    require(receipt['protocol'] == 'address-only-configured-transition-receipt-v1'
            and receipt['sourceMonitoring'] == 'configured_pending_observation'
            and receipt['releaseSha256'] == r['releaseSha256']
            and all(receipt[k] == original[k] for k in ('operationId', 'generationId', 'importId'))
            and receipt['databaseImported'] is True and receipt['newImportPerformed'] is False
            and receipt['businessReleaseSwitched'] is True and receipt['monitoringCompleted'] is False
            and receipt['businessEligibilityGranted'] is False, 'origin_receipt_binding')
    require(all(receipt[k] is False and d[k] is False for k in SAFETY), 'safety_flags')
    require(floor['protocol'] == 'address-only-evm-floor-receipt-v1' and floor['generationId'] == GENERATION
            and floor['activatedAt'] == ACTIVATED_AT and floor['releaseSha256'] == r['releaseSha256']
            and floor['authoritySha256'] == B_PINS['authority.json']
            and floor['deploymentSha256'] == B_PINS['deployment.json']
            and floor['environmentSha256'] == B_PINS['environment.json']
            and floor['currentJournalSha256'] == job['journal']['sha256']
            and floor['currentReceiptSha256'] == job['receipt']['sha256'], 'real_floor_receipt_binding')
    require(all(floor[k] is False for k in ('businessFactsWritten', 'checkpointWritten', 'activationGranted', 'signalPermissionGranted')), 'floor_scope')
    chains = sorted(d['walletExecution']['evm'])
    require(chains and set(chains) <= {'eth', 'bsc', 'base'} and sorted(floor['floors']) == chains
            and json.loads(floor['floorEnvironment']) == floor['floors'], 'complete_floor_map')
    require(sorted(c['chain'] for c in floor['chains']) == chains, 'floor_chain_proofs')
    for chain in chains:
        value = floor['floors'][chain]
        require(integer(value) and value > 0, 'positive_floor')
        proof = next(c for c in floor['chains'] if c['chain'] == chain)
        provider = d['walletExecution']['evm'][chain]
        require(proof['activatedAt'] == ACTIVATED_AT and proof['fromBlock'] == value
                and proof['providerId'] == provider['providerId'] and proof['chainId'] == provider['expectedChainId']
                and proof['genesisHash'].lower() == provider['expectedGenesisBlockHash'].lower(), 'floor_provider_binding')
        before, header = proof['before'], proof['header']
        require(before['number'] == value - 1 and header['number'] == value
                and integer(before['timestamp']) and integer(header['timestamp'])
                and before['timestamp'] * 1000 < ACTIVATED_AT <= header['timestamp'] * 1000
                and header['parentHash'] == before['hash']
                and all(re.fullmatch('0x[a-fA-F0-9]{64}', v) for v in (before['hash'], header['hash'])), 'floor_boundary')
    require(RELEASE_SHA != r['releaseSha256'], 'new_release_required')
    a['releaseSha256'] = RELEASE_SHA
    d['releaseRoot'] = C_RELEASE
    d['cutover']['addressOnly']['releaseSha256'] = RELEASE_SHA
    d['execution'] = {'maximumEntries': 5, 'maximumBytes': 1192952}
    d['wallet'].update(collectorQuota=1, maximumRunMs=24000, leaseMs=60000)
    d['lifecycle']['pollMs'] = 30000
    d['services']['wallet-monitor']['intervalMs'] = 5000
    d['walletExecution']['receiver']['maximumRunMs'] = 5000
    e.update(ADDRESS_RADAR_POSTGRES_POLL_MS='30000', ADDRESS_RADAR_SOLANA_WALLET_BATCH_SIZE='1',
             ADDRESS_RADAR_SOLANA_SIGNATURE_LIMIT='10', ADDRESS_RADAR_WALLET_MONITOR_INTERVAL_MS='5000',
             ADDRESS_RADAR_EVM_BOOTSTRAP_FLOORS=json.dumps(floor['floors'], separators=(',', ':'), sort_keys=True),
             ADDRESS_RADAR_POSTGRES_RELEASE_SHA256=RELEASE_SHA, ADDRESS_RADAR_POSTGRES_ENTRY_SHA256=ENTRY_SHA,
             ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE=C_ROOT + '/authority.json',
             ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256=sha(encode(a)))
    for key in ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
                'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED'):
        require(e[key] == 'false', 'environment_safety_flags')
    e.update(ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE=C_ROOT + '/deployment.json',
             ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256=sha(encode(d)))
    r.update(transitionId='stability-20261009c', authorizationRef=job['authorizationRef'], deadlineAtMs=0,
             releaseRoot=C_RELEASE, releaseSha256=RELEASE_SHA,
             deployment={'path': C_ROOT + '/deployment.json', 'sha256': sha(encode(d))},
             environment={'path': C_ROOT + '/environment.json', 'sha256': sha(encode(e))},
             configuredOrigin={'journal': job['journal'], 'receipt': job['receipt'], 'releaseRoot': B_RELEASE, 'node': NODE})
    r.pop('degradedRecovery', None)
    return dict(zip(B_PINS, (a, d, e, r)))


def open_directory(path):
    require(os.path.isabs(path) and os.path.normpath(path) == path, 'canonical_directory')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in Path(path).parts[1:]:
            new = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = new
            s = os.fstat(fd)
            require(s.st_uid == 0 and not s.st_mode & 0o022, 'protected_directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_pin(value):
    pin(value)
    parent = open_directory(str(Path(value['path']).parent))
    try:
        fd = os.open(Path(value['path']).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                    and not before.st_mode & 0o077 and 0 < before.st_size <= 2 * 1024**2, 'private_input')
            chunks = bytearray()
            while len(chunks) <= before.st_size:
                chunk = os.read(fd, min(65536, before.st_size + 1 - len(chunks)))
                if not chunk:
                    break
                chunks.extend(chunk)
            require(file_stamp(before) == file_stamp(os.fstat(fd))
                    == file_stamp(os.stat(Path(value['path']).name, dir_fd=parent, follow_symlinks=False))
                    and len(chunks) == before.st_size and sha(chunks) == value['sha256'], 'input_changed_or_pin_mismatch')
            return json.loads(chunks)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def write_exclusive(directory_fd, name, raw):
    require('/' not in name and name not in ('.', '..'), 'output_name')
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(raw)
        while view:
            count = os.write(fd, view)
            require(count > 0, 'short_write')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(directory_fd)
    return {'path': C_ROOT + '/' + name, 'sha256': sha(raw)}


def verify_release():
    root = open_directory(C_RELEASE)
    try:
        require(sorted(os.listdir(root)) == ['pg.mjs', 'scripts'], 'release_root_entries')
        scripts = os.open('scripts', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            require(sorted(os.listdir(scripts)) == ['postgres-address-only-dispatch.mjs', 'postgres-service-entry.mjs'], 'release_script_entries')
            digest, total = hashlib.sha256(), 0
            for name in ('.', 'pg.mjs', 'scripts', 'scripts/postgres-address-only-dispatch.mjs', 'scripts/postgres-service-entry.mjs'):
                parent = scripts if name.startswith('scripts/') else root
                leaf = name.split('/')[-1]
                fd = os.dup(root) if name == '.' else os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = os.fstat(fd)
                    directory = name in ('.', 'scripts')
                    require(before.st_uid == 0 and not before.st_mode & 0o222
                            and before.st_dev == os.fstat(root).st_dev
                            and (stat.S_ISDIR(before.st_mode) if directory else stat.S_ISREG(before.st_mode)), 'release_not_sealed')
                    record = {'path': name, 'mode': stat.S_IMODE(before.st_mode), 'kind': 'directory' if directory else 'file'}
                    if not directory:
                        require(before.st_nlink == 1 and before.st_size <= 1192952 - total, 'release_size')
                        raw = bytearray()
                        while len(raw) <= before.st_size:
                            chunk = os.read(fd, min(65536, before.st_size + 1 - len(raw)))
                            if not chunk:
                                break
                            raw.extend(chunk)
                        require(len(raw) == before.st_size and file_stamp(before) == file_stamp(os.fstat(fd)), 'release_changed')
                        record.update(size=len(raw), sha256=sha(raw)); total += len(raw)
                        if name.endswith('/postgres-service-entry.mjs'):
                            require(record['sha256'] == ENTRY_SHA, 'entry_pin')
                    digest.update(encode(record))
                finally:
                    os.close(fd)
            require(total == 1192952 and digest.hexdigest() == RELEASE_SHA, 'release_inventory_pin')
        finally:
            os.close(scripts)
    finally:
        os.close(root)


def execute(job):
    require(os.geteuid() == 0 and sys.platform == 'linux', 'native_root_linux_required')
    validate_job(job)
    parent = open_directory(str(Path(C_ROOT).parent))
    root = None
    try:
        os.mkdir(Path(C_ROOT).name, 0o700, dir_fd=parent)
        os.fsync(parent)
        root = os.open(Path(C_ROOT).name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        os.fchmod(root, 0o700); os.fsync(root)
        write_exclusive(root, 'preparation-started.json', encode({'protocol': 'address-only-stability-c-metadata-audit-v1',
                        'status': 'PREPARING', 'jobSha256': sha(encode(job))}))
        try:
            inputs = {n: {'path': B_ROOT + '/' + n, 'sha256': h} for n, h in B_PINS.items()}
            source = {n: read_pin(p) for n, p in inputs.items()}
            original_pin = source['request-template.json']['originalManifest']
            outputs = build_metadata(source, job, read_pin(job['floorReceipt']), read_pin(job['journal']),
                                     read_pin(job['receipt']), read_pin(original_pin))
            verify_release()
            for p in [*inputs.values(), job['floorReceipt'], job['journal'], job['receipt'], original_pin]:
                read_pin(p)
            results = [write_exclusive(root, n, encode(value)) for n, value in outputs.items()]
            verify_release()
            for p in [*inputs.values(), job['floorReceipt'], job['journal'], job['receipt'], original_pin]:
                read_pin(p)
            write_exclusive(root, 'preparation-complete.json', encode({'status': 'METADATA_PREPARED_NOT_ACTIVATED',
                            'files': results, 'changedFields': CHANGED, 'floorReceipt': job['floorReceipt']}))
            return {'files': results, 'changedFields': CHANGED}
        except BaseException:
            write_exclusive(root, 'preparation-failed.json', encode({'status': 'FAILED_NOT_ACTIVATED'}))
            raise
    finally:
        if root is not None:
            os.close(root)
        os.close(parent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute-after-floor-ready', action='store_true', required=True)
    parser.add_argument('--request', required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0 and sys.platform == 'linux', 'native_root_linux_required')
        result = execute(read_pin({'path': args.request, 'sha256': args.sha256}))
        print(json.dumps(result, separators=(',', ':')))
    except Exception:
        print('{"error":"C_METADATA_REFUSED_NOT_ACTIVATED"}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
