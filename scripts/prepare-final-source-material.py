#!/usr/bin/env python3
"""Exclusive final metadata preparation; no execution, approval issuance or renewal."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time
import types

ROOT = Path('/var/lib/address-radar-maintenance-tools')
LIMIT = 2 * 1024**2
NAMES = {'authority.json', 'deployment.json', 'settings.json', 'environment.json'}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def bootstrap(expected):
    path = Path(__file__).with_name('assemble-production-source-execution.py')
    end = time.monotonic()+5
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'reader_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stamp = lambda s: (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    chunks = []
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= 4194304, 'reader_file')
        count = 0
        while True:
            require(time.monotonic() < end, 'reader_timeout')
            raw = stream.read(min(65536, 4194305-count))
            if not raw: break
            count += len(raw); require(count <= 4194304, 'reader_budget'); chunks.append(raw)
        after = os.fstat(stream.fileno())
    raw = b''.join(chunks)
    require(stamp(before) == stamp(after) == stamp(path.lstat()) and len(raw) == before.st_size
            and digest(raw) == expected, 'reader_pin_changed')
    module = types.ModuleType('final_source_protected_reader')
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module, {'path':str(path), 'sha256':expected}


def child(argv, raw, reader):
    require(0 < len(raw) <= LIMIT, 'generator_input_budget')
    end = min(reader.end, time.monotonic()+5)
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True,
        env={'PATH':'/usr/bin:/bin', 'LC_ALL':'C'})
    output, offset = bytearray(), 0
    completed = False
    try:
        with selectors.DefaultSelector() as selector:
            for stream in (process.stdin, process.stdout): os.set_blocking(stream.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE)
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map() or process.poll() is None:
                reader.check(); require(time.monotonic() < end, 'generator_timeout')
                for key, _ in selector.select(min(.05, max(0, end-time.monotonic()))):
                    if key.fileobj is process.stdin:
                        count = os.write(process.stdin.fileno(), raw[offset:offset+65536])
                        require(count > 0, 'generator_stdin'); offset += count
                        if offset == len(raw): selector.unregister(process.stdin); process.stdin.close()
                    else:
                        chunk = os.read(process.stdout.fileno(), min(65536, LIMIT+1-len(output)))
                        if not chunk: selector.unregister(process.stdout)
                        else:
                            output.extend(chunk); require(len(output) <= LIMIT, 'generator_output_budget')
            require(process.returncode == 0 and output, 'generator_refused')
            try: os.killpg(process.pid, 0)
            except ProcessLookupError: pass
            else: raise ValueError('generator_group_residual')
        completed = True
        return json.loads(output)
    finally:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try:
            cleanup_end = time.monotonic()+1
            process.wait(timeout=1)
            while True:
                try: os.killpg(process.pid, 0)
                except ProcessLookupError: break
                require(time.monotonic() < cleanup_end, 'generator_cleanup_uncertain'); time.sleep(.01)
        except BaseException:
            if completed: raise
        finally:
            if not process.stdin.closed: process.stdin.close()
            process.stdout.close()


def fresh(source, evidence, runtime_authority):
    now = int(time.time()*1000)
    review = source['review']
    require(type(review['importedAt']) is int and 0 <= now-review['importedAt'] <= 86400000, 'review_expired')
    require(type(evidence['validFrom']) is int and type(evidence['validUntil']) is int
            and evidence['validFrom'] <= now < evidence['validUntil'] and evidence['revoked'] is False, 'approval_expired')
    validator = source['material']['authority']['validator']
    selected = [value for value in runtime_authority['validators']
                if value['kind'] == 'execution' and value['validatorId'] == validator['validatorId']]
    require(len(selected) == 1, 'validator_import_binding')
    approved = selected[0]
    require(all(type(approved[key]) is int for key in ('importedAt','validFrom','validUntil'))
            and approved['importedAt'] <= approved['validFrom'] <= now
            and approved['validUntil'] > now+validator['validationTtlMs']+5000, 'validator_expired')
    if 'approvedAt' in runtime_authority or 'expiresAt' in runtime_authority:
        require(type(runtime_authority['approvedAt']) is int and type(runtime_authority['expiresAt']) is int
                and runtime_authority['approvedAt'] <= now < runtime_authority['expiresAt'], 'runtime_authority_expired')


def prepare(inputs_pin, destination, reader_sha256):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'native_root')
    base, reader_pin = bootstrap(reader_sha256)
    reader = base.ProtectedReader()
    reader(reader_pin, maximum=4194304, collect=False)
    output = Path(destination)
    require(output.parent == ROOT and base.re.fullmatch('final-source-materials-[A-Za-z0-9_-]{1,64}', output.name), 'output_scope')
    envelope = json.loads(reader(base.validate_pin(inputs_pin)))
    require(type(envelope) is dict and set(envelope) == {'protocol','transitionId','sourceInput','review','approvalEvidence',
        'currentPins','stageReceipt','origin','node','generator','walletServiceUser','runtimeAuthority'}
        and envelope['protocol'] == 'address-only-final-source-material-inputs-v1', 'inputs_shape')
    def document(reference): return json.loads(reader(base.validate_pin(reference)))
    source, review = document(envelope['sourceInput']), document(envelope['review'])
    evidence, stage = document(envelope['approvalEvidence']), document(envelope['stageReceipt'])
    runtime_authority = document(envelope['runtimeAuthority'])
    current_pins, origin_pins = envelope['currentPins'], envelope['origin']
    require(type(current_pins) is dict and set(current_pins) == {'authority','deployment','settings','environment'}
            and type(origin_pins) is dict and set(origin_pins) == {'oldState','originalManifest','configuredOrigin'}, 'material_pins')
    current = {name:document(reference) for name,reference in current_pins.items()}
    configured_origin = origin_pins['configuredOrigin']
    require(type(configured_origin) is dict and set(configured_origin) == {'journal','receipt','releaseRoot','node'}, 'configured_origin_fields')
    origin = {'waitingState':document(origin_pins['oldState']), 'manifest':document(origin_pins['originalManifest']),
              'configuredState':document(configured_origin['journal']), 'configuredReceipt':document(configured_origin['receipt'])}
    reader(base.validate_pin(configured_origin['node']), maximum=base.BINARY_LIMIT, collect=False)
    reader.verify_wallet(envelope['walletServiceUser'])
    configured_manifest = dict(origin['manifest'], releaseSha256=origin['configuredReceipt']['releaseSha256'])
    node, generator = base.validate_pin(envelope['node']), base.validate_pin(envelope['generator'])
    reader(node, maximum=base.BINARY_LIMIT, collect=False)
    require(os.stat(node['path']).st_mode & 0o111, 'node_not_executable')
    reader(generator, maximum=128*1024**2, collect=False)
    reader.verify_release(stage['release'])
    # Validate opaque private references without parsing or publishing their values.
    for reference in (current['authority']['credential'],current['authority']['privateKey'],current['settings']['credential']):
        reader(base.validate_pin(reference), maximum=base.JSON_LIMIT, collect=False)
    payload = {'input':source,'review':review,'evidence':evidence,'currentMaterial':current,
        'stage':stage,'origin':origin,'originPins':origin_pins,'node':node,'outputDirectory':str(output),
        'walletServiceUser':envelope['walletServiceUser'],'runtimeAuthority':runtime_authority,
        'configuredManifestSha256':digest(json.dumps(configured_manifest,separators=(',', ':'),ensure_ascii=True,allow_nan=False).encode()),
        'transitionId':envelope['transitionId'],'nowMs':int(time.time()*1000),
        'manifestSha256':digest(json.dumps(origin['manifest'], separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode())}
    result = child([node['path'],'--no-global-search-paths',generator['path'],'--generate'], encode(payload), reader)
    reader(node, maximum=base.BINARY_LIMIT, collect=False)
    reader(generator, maximum=128*1024**2, collect=False)
    require(type(result) is dict and set(result) == {'files','summary'} and type(result['files']) is dict
            and set(result['files']) == NAMES, 'generated_shape')
    files = {}
    for name, record in result['files'].items():
        require(type(record) is dict and set(record) == {'raw','sha256'} and type(record['raw']) is str, 'generated_file')
        raw = record['raw'].encode('utf-8')
        require(0 < len(raw) <= base.JSON_LIMIT and digest(raw) == record['sha256'], 'generated_hash')
        files[name] = raw
    for parent in (ROOT, *ROOT.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'output_parent')
    reader.revalidate(); fresh(source, evidence, runtime_authority)
    os.mkdir(output, 0o700); base.sync(ROOT)
    final_pins = {}
    for name in sorted(files):
        path = output/name; base.write(path, files[name])
        final_pins[name] = {'path':str(path),'sha256':digest(files[name])}
    # The completion receipt is published only after final dependency and time checks.
    reader.revalidate(); fresh(source, evidence, runtime_authority)
    for name, reference in final_pins.items():
        require(reader(reference) == files[name], 'final_file_changed')
    receipt = {'protocol':'address-only-final-source-material-receipt-v1','status':'PREPARED_NOT_EXECUTED',
        'inputs':inputs_pin,'reader':reader_pin,'sourceSummary':result['summary'],'files':final_pins,
        'sourcePins':envelope,'activationPerformed':False,'productionProof':False,'ledgerVerified':False,
        'retryAuthorized':False,'executionDeadlineGenerated':False}
    path = output/'review-receipt.json'; raw = encode(receipt)
    require(len(raw) <= base.JSON_LIMIT, 'receipt_budget')
    base.write(path, raw); base.sync(output); base.sync(ROOT)
    return {'status':'PREPARED_NOT_EXECUTED','receipt':{'path':str(path),'sha256':digest(raw)},
            'activationPerformed':False,'productionProof':False,'retryAuthorized':False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('inputs','inputs-sha256','output-directory','reader-sha256'): parser.add_argument('--'+key, required=True)
    args = parser.parse_args()
    return prepare({'path':args.inputs,'sha256':args.inputs_sha256},args.output_directory,args.reader_sha256)


if __name__ == '__main__':
    try: print(json.dumps(main()))
    except BaseException:
        print('{"status":"REFUSED_NOT_EXECUTED","productionProof":false,"retryAuthorized":false}')
        raise SystemExit(1)
