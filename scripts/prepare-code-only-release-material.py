#!/usr/bin/env python3
"""Protected candidate preparation only. Never connects to databases or activates services."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import types

ROOT = Path('/var/lib/address-radar-maintenance-tools')
LIMIT = 2 * 1024**2


def require(value, code):
    if not value:
        raise ValueError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def encode_payload(value):
    """Preserve manifest field order required by the sealed native preflight."""
    return (json.dumps(value, separators=(',', ':'), allow_nan=False)+'\n').encode()


def load_helper(expected):
    """Authenticate existing bootstrap code before executing it; do not trust imports from cwd."""
    require(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected), 'helper_hash')
    path = Path(__file__).with_name('prepare-final-source-material.py')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'helper_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    stamp = lambda s: (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= 4194304, 'helper_file')
        end = time.monotonic()+5
        raw = bytearray()
        while len(raw) <= 4194304:
            require(time.monotonic() < end, 'helper_timeout')
            part = stream.read(min(65536,4194305-len(raw)))
            if not part:
                break
            raw.extend(part)
        require(len(raw) == before.st_size and stamp(before) == stamp(os.fstat(stream.fileno()))
                == stamp(path.lstat()) and digest(raw) == expected, 'helper_pin')
    module = types.ModuleType('code_only_preparation_helper')
    module.__file__ = str(path)
    exec(compile(bytes(raw), str(path), 'exec'), module.__dict__)
    return module, {'path':str(path),'sha256':expected}


def json_equal(left, right):
    """Compare JSON values without Python's bool/int equivalence."""
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(json_equal(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return left == right


def validate_generated(payload, result):
    """Cross-check exact output values independently of the JavaScript generator."""
    require(type(result) is dict and set(result) == {'files','pins','summary'}, 'result_shape')
    expected = copy.deepcopy(payload['current'])
    release = payload['stage']['release']
    expected['authority']['releaseSha256'] = release['releaseSha256']
    expected['deployment']['releaseRoot'] = release['root']
    expected['deployment']['cutover']['addressOnly']['releaseSha256'] = release['releaseSha256']
    names = {'authority.json':'authority','deployment.json':'deployment','settings.json':'settings','environment.json':'environment'}
    if 'reportedPriceAuthority' in expected:
        expected['reportedPriceAuthority']['releaseSha256'] = release['releaseSha256']
        names['reported-price-authority.json'] = 'reportedPriceAuthority'
    require(type(result['files']) is dict and set(result['files']) == set(names)
            and type(result['pins']) is dict and set(result['pins']) == set(names.values()), 'result_files')
    for name, key in names.items():
        file = result['files'][name]
        require(type(file) is dict and set(file) == {'raw','sha256'} and type(file['raw']) is str, 'result_file')
        raw = file['raw'].encode()
        require(0 < len(raw) <= 524288 and digest(raw) == file['sha256'], 'result_hash')
        require(result['pins'][key] == {'path':payload['outputDirectory']+'/'+name,'sha256':file['sha256']}, 'result_pin')
    env = expected['environment']
    env['ADDRESS_RADAR_POSTGRES_RELEASE_SHA256'] = release['releaseSha256']
    env['ADDRESS_RADAR_POSTGRES_ENTRY_SHA256'] = release['entryPin']['sha256']
    bindings = [('authority','AUTHORITY'),('deployment','DEPLOYMENT'),('settings','CONFIGURED_PREFLIGHT')]
    if 'reportedPriceAuthority' in expected:
        bindings.append(('reportedPriceAuthority','REPORTED_PRICE_AUTHORITY'))
    for key, suffix in bindings:
        env['ADDRESS_RADAR_POSTGRES_'+suffix+'_FILE'] = result['pins'][key]['path']
        env['ADDRESS_RADAR_POSTGRES_'+suffix+'_SHA256'] = result['pins'][key]['sha256']
    for name, key in names.items():
        require(json_equal(json.loads(result['files'][name]['raw']), expected[key]), 'nonrelease_material_drift')
    require(json_equal(result['summary'], {'status':'CANDIDATE_ONLY','activationReady':False,
        'releaseSha256':release['releaseSha256'],'sourceConfigurationUnchanged':True,
        'authorityFreshnessVerified':False,'protectedInputsVerified':False,'actualReleaseVerified':False,
        'originLifecycleVerified':False,'nativePreflightPassed':False,'productionWrites':False}), 'summary_overclaim')
    return {name:result['files'][name]['raw'].encode() for name in names}


def prepare(inputs_pin, output_directory, helper_hash, reader_hash):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'native_root')
    helper, helper_pin = load_helper(helper_hash)
    base, reader_pin = helper.bootstrap(reader_hash)
    reader = base.ProtectedReader()
    for pin in (helper_pin, reader_pin):
        reader(pin, maximum=4194304, collect=False)
    envelope = json.loads(reader(base.validate_pin(inputs_pin)))
    require(type(envelope) is dict and set(envelope) == {'protocol','currentPins','originPins','stageReceipt','node','generator','generatorModule'}
            and envelope['protocol'] == 'address-only-code-material-inputs-v1', 'inputs_shape')
    output = Path(output_directory)
    require(str(output) == output_directory and output.parent == ROOT
            and re.fullmatch('code-only-materials-[a-z0-9-]{1,100}', output.name), 'output_scope')
    document = lambda pin: json.loads(reader(base.validate_pin(pin)))
    current_pins, origin_pins = envelope['currentPins'], envelope['originPins']
    require(type(current_pins) is dict and {'authority','deployment','settings','environment'} <= set(current_pins)
            and set(current_pins) <= {'authority','deployment','settings','environment','reportedPriceAuthority'}
            and type(origin_pins) is dict and set(origin_pins) == {'state','receipt'}, 'material_pins')
    payload = {'current':{k:document(v) for k,v in current_pins.items()},
        'origin':{k:document(v) for k,v in origin_pins.items()},'stage':document(envelope['stageReceipt']),
        'outputDirectory':output_directory}
    reader.verify_release(payload['stage']['release'])
    node, generator, module = [base.validate_pin(envelope[k]) for k in ('node','generator','generatorModule')]
    require(Path(generator['path']).name == 'code-only-release-material-cli.mjs'
            and Path(module['path']) == Path(generator['path']).with_name('produce-code-only-release-material.mjs'), 'generator_module_binding')
    reader(node, maximum=base.BINARY_LIMIT, collect=False)
    require(os.stat(node['path']).st_mode & 0o111, 'node_executable')
    for pin in (generator,module):
        reader(pin, maximum=base.CODE_LIMIT, collect=False)
    result = helper.child([node['path'],'--no-global-search-paths',generator['path']],encode_payload(payload),reader)
    files = validate_generated(payload,result)
    reader.revalidate()
    for parent in (ROOT,*ROOT.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'output_parent')
    os.mkdir(output,0o700)
    base.sync(ROOT)
    for name,raw in sorted(files.items()):
        reader.check()
        base.write(output/name,raw)
    reader.revalidate()
    for name,raw in files.items():
        require(reader(result['pins'][{'authority.json':'authority','deployment.json':'deployment','settings.json':'settings',
            'environment.json':'environment','reported-price-authority.json':'reportedPriceAuthority'}[name]]) == raw, 'output_changed')
    receipt = {'protocol':'address-only-code-material-preparation-receipt-v1','status':'PREPARED_NOT_ACTIVATED',
        'inputs':inputs_pin,'helper':helper_pin,'reader':reader_pin,'files':result['pins'],
        'protectedInputsVerified':True,'actualReleaseVerified':True,'ledgerVerified':False,
        'nativePreflightPassed':False,'activationReady':False,'activationPerformed':False}
    reader.revalidate()
    base.write(output/'preparation-receipt.json',encode(receipt))
    base.sync(output)
    base.sync(ROOT)
    return {'status':receipt['status'],'receipt':{'path':str(output/'preparation-receipt.json'),'sha256':digest(encode(receipt))},
        'activationReady':False,'activationPerformed':False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('inputs','inputs-sha256','output-directory','helper-sha256','reader-sha256'):
        parser.add_argument('--'+key,required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(prepare({'path':args.inputs,'sha256':args.inputs_sha256},args.output_directory,args.helper_sha256,args.reader_sha256)))
    except BaseException:
        print('{"status":"REFUSED_NOT_ACTIVATED","activationReady":false,"activationPerformed":false}')
        sys.exit(1)
