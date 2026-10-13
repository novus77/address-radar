"""Invoke the real execute entry over genuine disposable activation/materials."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import time

ROOT = Path('/var/lib/address-radar-maintenance-tools/isolated-source-replacement-0123456789abcdef')
SCRIPTS = ROOT/'tools/scripts'


def run():
    assert os.geteuid() == 0 and Path('/.dockerenv').is_file()
    assert Path('/proc/1/comm').read_text().strip() == 'systemd'
    def load(name, path):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    def pin(path):
        return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    def read(path):
        return json.loads(path.read_bytes())
    def put(name, body):
        path = ROOT/name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write((json.dumps(body, separators=(',', ':'))+'\n').encode())
            stream.flush(); os.fsync(stream.fileno())
        return pin(path)
    index = read(ROOT/'replacement-material-index.json')
    config = read(ROOT/'original-controller-config.json')
    operation = config['operationId']
    output = ROOT/('address-only-run-'+operation)
    state = read(output/'activation-state.json')
    assert state['phase'] == 'COMPLETE' and state['receipt']['proofScope'] == 'isolated-activation'
    completed = {'state': pin(output/'activation-state.json'), 'receipt': pin(output/'activation-receipt.json'),
        'config': pin(ROOT/'original-controller-config.json'), 'isolatedJob': pin(ROOT/'isolated-activation.json'),
        'manifest': pin(output/'address-only-manifest.json'), 'activationModule': pin(SCRIPTS/'activate-address-only-postgres.py'),
        'unitFragments': {s: pin(ROOT/'units'/('address-radar-'+s+'.service')) for s in state['units']}}
    at = int(time.time()*1000)
    wallet = pwd.getpwnam('address-radar-wallet')
    inventory = read(ROOT/'new-release-inventory.json')
    base = load('complete_job_base', SCRIPTS/'activate-address-only-postgres.py')
    transition = put('configured-transition.json', {'protocol':'address-only-configured-transition-v1',
        'transitionId':'isolated-publicnode-replacement','authorizationRef':'isolated-source-replacement','deadlineAtMs':at+240000,
        'oldState':completed['state'],'originalManifest':completed['manifest'],'releaseRoot':str(ROOT/'new-release'),
        'releaseSha256':inventory['releaseSha256'],'node':pin(ROOT/'bin/node'),'deployment':index['deployment'],
        'environment':index['environment'],'nativeVerifier':pin(ROOT/'tools/preflight.mjs'),
        'resourcePolicy':dict(base.WAITING_POLICY,mode='configured'),
        'walletServiceUser':{'user':wallet.pw_name,'group':wallet.pw_name,'uid':wallet.pw_uid,'gid':wallet.pw_gid}})
    request = put('source-fence-request.json', {'protocol':'address-only-pg-source-fence-v1','operationId':operation,
        'replacementSha256':index['replacementSha256'],'generationId':state['measurement']['binding']['generationId'],
        'oldProviderId':'fixture-old-source','oldOrigin':'https://helius.example','newProviderId':'fixture-publicnode-source',
        'newOrigin':'https://solana-rpc.publicnode.com','authorizationRef':'isolated-source-replacement',
        'deadlineAtMs':at+240000,'publishedFiles':[]})
    (ROOT/'private').mkdir(mode=0o700)
    job = {'protocol':'address-only-source-replacement-isolated-execution-v1','operationId':operation,
        'approvalRef':'isolated-source-replacement','replacementSha256':index['replacementSha256'],'deadlineAtMs':at+240000,
        'outputDirectory':str(ROOT/'private'/('execution-'+operation)),'fenceRequest':request,
        'adapter':pin(SCRIPTS/'source-replacement-controller-adapter.py'),'sequence':pin(SCRIPTS/'run-pg-source-replacement.py'),
        'controllerPins':{k:pin(SCRIPTS/v) for k,v in {'activation':'activate-address-only-postgres.py',
            'configured':'activate-address-only-configured.py','controller':'run-address-only-native-controller.py',
            'fence':'address-only-native-fence.py','pgFence':'pg-source-replacement-fence.py'}.items()},
        'controllerConfig':completed['config'],'transition':transition,'rotationDirectory':str(ROOT/'address-only-auth-1111111111111111'),
        'tools':{'python':pin(ROOT/'bin/python3'),'node':pin(ROOT/'bin/node'),'rotation':pin(SCRIPTS/'rotate-address-only-migrator.py'),
            'rotationSupport':pin(SCRIPTS/'activate-production-postgres-migrator.py'),'import':pin(ROOT/'tools/import.mjs'),
            'probe':pin(ROOT/'tools/probe.mjs')},'importTemplate':index['importTemplate'],'probeTemplate':index['probeTemplate'],
        'selfPin':pin(SCRIPTS/'execute-pg-source-replacement.py'),'isolatedIdentity':pin(ROOT/'rotation-identity.json'),
        'isolatedRuntime':pin(ROOT/'runtime-proof.json'),'isolatedCompletedActivation':completed}
    job_pin = put('complete-execute-job.json', job)
    print(json.dumps({'event':'ISOLATED_REAL_EXECUTE_ENTERING','productionProof':False}), flush=True)
    execute = load('complete_real_execute', SCRIPTS/'execute-pg-source-replacement.py')
    try:
        result = execute.execute(job_pin)
    except Exception as error:
        reason = str(error)
        if not reason.replace('_','').isalnum() or len(reason)>96:
            reason = 'non_closed_exception'
        probe_output = ROOT/'private'/('execution-'+operation)/'probe'
        for filename in ('receipt.json','refused.json'):
            path = probe_output/filename
            if path.exists():
                value = read(path)
                result = value.get('result', {})
                safe = {key:result.get(key) for key in ('status','reasonCode','sourceRequests','replayRequests')}
                audits = value.get('verifierAudits', [])
                print(json.dumps({'event':'ISOLATED_PROBE_RESULT','file':filename,'result':safe,
                    'verifierStatuses':[v.get('status') for v in audits],
                    'verifierReasonCodes':[v.get('reasonCode') for v in audits if v.get('reasonCode')]}),flush=True)
        rotation = Path(job['rotationDirectory'])

        print(json.dumps({'event':'ISOLATED_ROTATION_ARTIFACTS','present':{name:(rotation/name).exists() for name in ('plan.json','intent.json','credential.json','receipt.json')},'supportMode':oct((SCRIPTS/'activate-production-postgres-migrator.py').stat().st_mode & 0o777)}),flush=True)
        pg = load('complete_failure_fence', SCRIPTS/'pg-source-replacement-fence.py')
        native = pg.Native(read(Path(request['path'])))
        if reason == 'source_origin_artifact_changed':
            configured = load('failure_origin_snapshot', SCRIPTS/'activate-address-only-configured.py')
            source = load('failure_origin_source', SCRIPTS/'address-only-native-fence.py')
            journal = read(native.directory/'state.json')
            captured = journal['sourceOrigin']['snapshot']['artifacts']
            # Read-only failure classification, never issuance/readiness evidence.
            from types import SimpleNamespace
            target = base._verify_isolated_target(load('failure_origin_controller', SCRIPTS/'run-address-only-native-controller.py'),
                config, config['launcher'], completed['isolatedJob'], state['releaseRoot'], state['nodePath'])
            view = SimpleNamespace(deadline=source.Deadline(10), _check_recovery_guard=lambda:None)
            old_adapter = base.NativeActivation(None, config, {}, source, view, SimpleNamespace(state=state),
                state['releaseRoot'], state['nodePath'], isolated_target=target)
            current = configured.source_origin_artifact_snapshot(base, old_adapter, lambda:None)
            print(json.dumps({'event':'ISOLATED_ORIGIN_SNAPSHOT_DIFFERENCE',
                'sectionsEqual':{key:current[key]==captured[key] for key in ('release','node','artifacts','units')},
                'unitFieldsChanged':{service:[key for key in ('User','Group','ExecStart','EnvironmentFiles','MemoryMax','TasksMax')
                    if current['units'][service].get(key)!=captured['units'][service].get(key)] for service in pg.SERVICES}}),flush=True)
        stopped = 0
        guards = 0
        for service in pg.SERVICES:
            unit = native.unit(service)
            assert unit.get('MainPID') == '0' and unit.get('ActiveState') in ('inactive','failed')
            stopped += 1
            guard = native.guard_path(service)
            info = guard.stat()
            assert info.st_uid == 0 and info.st_gid == 0 and info.st_mode & 0o777 == 0o600
            guards += 1
        assert read(ROOT/'private'/('execution-'+operation)/'hold.json')['status'] == 'HOLD'
        print(json.dumps({'event':'ISOLATED_FAILURE_FENCE_VERIFIED','stoppedServices':stopped,'persistentGuards':guards}),flush=True)
        stages = {name:
(ROOT/'private'/('execution-'+operation)/name).exists() for name in
                  ('intent.json','isolated-rotation-job.json','import-job.json','source-contract-import-intent.json','source-contract-import-failed.json','source-contract-import-receipt.json','probe-job.json','hold.json','complete.json')}
        print(json.dumps({'event':'ISOLATED_REAL_EXECUTE_FAILED','reasonCode':reason,'stages':stages,'productionProof':False}), flush=True)
        raise
    assert result['status'] == 'COMPLETE'
    print('ISOLATED_REAL_EXECUTE_COMPLETE', flush=True)


if __name__ == '__main__':
    run()
