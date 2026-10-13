"""Assemble an isolated execute job from actual pinned native fixture outputs.

This does not create approvals, receipts, credentials, or successful outcomes.
The caller supplies the already prepared rotation/import/probe/controller inputs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time


def require(value, reason):
    if not value:
        raise ValueError(reason)


def pin(scope, path):
    path = Path(path)
    require(path.is_absolute() and path.is_relative_to(scope), 'fixture_pin_scope')
    cursor = path
    while cursor != scope.parent:
        require(not cursor.is_symlink(), 'fixture_pin_symlink')
        cursor = cursor.parent
    raw = path.read_bytes()
    require(0 < len(raw) <= 128 * 1024**2, 'fixture_pin_size')
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}


def assemble(scope, materials, now_ms):
    scope = Path(scope)
    require(re.fullmatch(r'/var/lib/address-radar-maintenance-tools/isolated-source-replacement-[a-f0-9]{16}', str(scope)), 'fixture_scope')
    required = {'operationId', 'approvalRef', 'replacementSha256', 'fenceRequest', 'adapter', 'sequence',
                'controllerPins', 'controllerConfig', 'transition', 'tools', 'importTemplate', 'probeTemplate',
                'selfPin', 'isolatedIdentity', 'isolatedRuntime', 'isolatedCompletedActivation', 'rotationNonce'}
    require(set(materials) == required, 'fixture_materials_shape')
    operation = materials['operationId']
    require(isinstance(operation, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', operation), 'fixture_operation')
    require(isinstance(materials['approvalRef'], str) and materials['approvalRef'], 'fixture_approval')
    require(re.fullmatch(r'[a-f0-9]{64}', materials['replacementSha256']), 'fixture_replacement')
    require(re.fullmatch(r'[a-f0-9]{16}', materials['rotationNonce']), 'fixture_rotation_nonce')
    job = {k: materials[k] for k in ('operationId', 'approvalRef', 'replacementSha256')}
    for key in ('fenceRequest', 'adapter', 'sequence', 'controllerConfig', 'transition', 'importTemplate',
                'probeTemplate', 'selfPin', 'isolatedIdentity', 'isolatedRuntime'):
        job[key] = pin(scope, materials[key])
    for key, names in (
        ('controllerPins', {'activation', 'configured', 'controller', 'fence', 'pgFence'}),
        ('tools', {'python', 'node', 'rotation', 'rotationSupport', 'import', 'probe'}),
        ('isolatedCompletedActivation', {'state', 'receipt', 'config', 'isolatedJob', 'manifest', 'activationModule', 'unitFragments'}),
    ):
        require(set(materials[key]) == names, 'fixture_' + key)
        job[key] = {name: pin(scope, path) for name, path in materials[key].items() if name != 'unitFragments'}
    completed = job['isolatedCompletedActivation']
    state = json.loads(Path(completed['state']['path']).read_bytes())
    receipt = json.loads(Path(completed['receipt']['path']).read_bytes())
    require(state['phase'] == 'COMPLETE' and state.get('pending') is None and state['receipt'] == receipt,
            'fixture_actual_complete_required')
    require(receipt.get('proofScope') == 'isolated-activation', 'fixture_actual_isolated_receipt')
    fragments = materials['isolatedCompletedActivation']['unitFragments']
    require(set(fragments) == set(state['units']) and len(fragments) == 6, 'fixture_six_fragments')
    completed['unitFragments'] = {name: pin(scope, path) for name, path in fragments.items()}
    require(completed['config'] == job['controllerConfig'] and completed['activationModule'] == job['controllerPins']['activation'],
            'fixture_original_pins')
    read = lambda key: json.loads(Path(job[key]['path']).read_bytes())
    request, transition = read('fenceRequest'), read('transition')
    deadline = request['deadlineAtMs']
    require(type(deadline) is int and 60000 < deadline - now_ms <= 240000, 'fixture_drain_deadline')
    require(request['operationId'] == operation and request['authorizationRef'] == job['approvalRef']
            and request['replacementSha256'] == job['replacementSha256'] and request['publishedFiles'] == [], 'fixture_fence_binding')
    require(transition['oldState'] == completed['state'] and transition['originalManifest'] == completed['manifest']
            and transition['deadlineAtMs'] <= deadline, 'fixture_transition_binding')
    probe = read('probeTemplate')
    require(probe['deployment'] == transition['deployment'] and probe['environment'] == transition['environment'], 'fixture_probe_binding')
    identity, template = read('isolatedIdentity'), read('importTemplate')
    require(set(template) == {'input', 'target'}, 'fixture_import_template')
    target = template['target']
    require(identity['systemIdentifier'] != '7693392208475083526'
            and identity['database'] == scope.name.replace('isolated-source-replacement-', 'radar_rehearsal_')
            and target['database'] == target['schema'] == identity['database']
            and target['systemIdentifier'] == identity['systemIdentifier'] and target['username'] == identity['username'], 'fixture_import_identity')
    job.update(protocol='address-only-source-replacement-isolated-execution-v1', deadlineAtMs=deadline,
               outputDirectory=str(scope / ('execution-' + operation)),
               rotationDirectory=str(scope / ('address-only-auth-' + materials['rotationNonce'])))
    return job


def main():
    require(len(sys.argv) == 4, 'fixture_arguments')
    scope, material_path, output = sys.argv[1:]
    job = assemble(scope, json.loads(Path(material_path).read_bytes()), int(time.time() * 1000))
    output = Path(output)
    require(output.parent == Path(scope) and not output.exists(), 'fixture_output_scope')
    raw = (json.dumps(job, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        parent = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    except BaseException:
        # Keep partial evidence for diagnosis; never retry or overwrite it.
        raise
    print(json.dumps({'event': 'isolated_execute_job_prepared', 'sha256': hashlib.sha256(raw).hexdigest()}))


if __name__ == '__main__':
    main()
