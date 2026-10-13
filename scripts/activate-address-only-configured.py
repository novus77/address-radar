#!/usr/bin/env python3
"""Operator-authorized release transition; no import, source restore or authority minting."""
import argparse
import copy
import contextlib
import grp
import pwd
import subprocess
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import stat
import time
import types

SAFETY = ('gatewayDeliveryEnabled', 'fomoEnabled', 'fullHistoricalMiningEnabled')
RECOVERABLE_PHASES = ('BLOCKED','REBLOCK_REQUIRED','PREPARED','PUBLISHED','WAITING_READY','READY')
PROOF_CHECKS = ('configurationValidated', 'committedStartupVerified', 'sourceEpochVerified',
                'databaseContractsVerified', 'authorityPortsVerified', 'producerWiringVerified')
RESTORED_SERVICES = ('scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console')


def require(value, code):
    if not value:
        raise ValueError(code)


def encode(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_pin(pin, owner=0, sealed=True):
    require(isinstance(pin, dict) and set(pin) == {'path', 'sha256'}
            and re.fullmatch('[a-f0-9]{64}', pin['sha256'])
            and os.path.isabs(pin['path']) and os.path.normpath(pin['path']) == pin['path'], 'invalid_pin')
    fd = os.open(pin['path'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == owner and before.st_nlink == 1
                and (not before.st_mode & 0o222 if sealed else not before.st_mode & 0o077)
                and 0 < before.st_size <= 524288, 'unsealed_input')
        raw = stream.read(524289)
        after = os.fstat(stream.fileno())
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mode, s.st_uid, s.st_gid, s.st_nlink, s.st_mtime_ns, s.st_ctime_ns)
    require(stamp(before) == stamp(after) == stamp(os.lstat(pin['path']))
            and len(raw) == before.st_size and sha(raw) == pin['sha256'], 'input_changed')
    return raw


def deployment_publication(deployment):
    """The input pin authorizes input bytes; evidence pins the bytes actually published."""
    raw = encode(deployment)
    return raw, sha(raw)


def execute_native_preflight(base, controller, verifier, node, request_path, input_sha, check,
                             remaining_ms, now=lambda: int(time.time()*1000)):
    """Execute approved native proof code, not a metadata file or caller-supplied result."""
    require(remaining_ms > 0, 'transition_expired')
    def assert_program():
        measured, _ = base.sealed_file(Path(verifier['path']), 128*1024**2, check)
        require(measured['sha256'] == verifier['sha256'], 'native_verifier_pin_changed')
    guarded(check, assert_program)
    raw = guarded(check, lambda: controller.bounded_child(
        [node, '--no-global-search-paths', verifier['path'], str(request_path)],
        seconds=min(60, remaining_ms/1000)))
    guarded(check, assert_program)
    proof = json.loads(raw)
    validate_proof(proof, input_sha, now())
    return proof


def guarded(check, operation):
    check()
    result = operation()
    check()
    return result


def derive_manifest(original, release_sha):
    require(original.get('protocol') == 'address-only-v1' and all(original.get(k) is False for k in SAFETY), 'manifest_safety')
    require(isinstance(release_sha, str) and re.fullmatch('[a-f0-9]{64}', release_sha)
            and release_sha != original.get('releaseSha256'), 'new_release_required')
    result = copy.deepcopy(original)
    result['releaseSha256'] = release_sha
    return result


def validate_proof(proof, input_sha, now_ms):
    require(isinstance(proof, dict) and proof.get('protocol') == 'address-only-configured-native-preflight-v1'
            and proof.get('inputSha256') == input_sha
            and type(proof.get('measuredAtMs')) is int and 0 <= now_ms - proof['measuredAtMs'] <= 60000
            and type(proof.get('expiresAtMs')) is int and proof['expiresAtMs'] > now_ms
            and all(proof.get(key) is True for key in PROOF_CHECKS)
            and all(proof.get(key) is False for key in SAFETY), 'native_configured_prerequisites_required')


def validate_completion_proof(state, now_ms):
    digest=state.get('nativePreflightInputSha256')
    require(isinstance(digest,str) and re.fullmatch('[a-f0-9]{64}',digest), 'completion_proof_input_required')
    validate_proof(state.get('nativePreflight'),digest,now_ms)


def perform_transition(preflight, stop, deploy, reblock):
    preflight()
    try:
        stop()
        return deploy()
    except BaseException:
        reblock()
        raise


def load_sealed(base, name, pin):
    base.protected_parent(Path(pin['path']))
    measured, _ = base.sealed_file(Path(pin['path']), 128 * 1024**2, lambda: None)
    require(measured['sha256'] == pin['sha256'], 'module_pin_changed')
    spec = importlib.util.spec_from_file_location(name, pin['path'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def getent(arguments, seconds):
    child = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, timeout=seconds, check=False, close_fds=True)
    require(child.returncode == 0 and len(child.stdout) <= 65536, 'getent_identity_refused')
    return child.stdout.decode('utf-8')


def resolve_wallet_identity(value, origin, run=getent):
    require(isinstance(value, dict) and set(value) == {'user', 'group', 'uid', 'gid'}, 'wallet_identity_fields')
    require(all(isinstance(value[k], str) and re.fullmatch('[a-z_][a-z0-9_-]{0,31}', value[k]) for k in ('user','group'))
        and type(value['uid']) is int and type(value['gid']) is int
        and 0 < value['uid'] < 2**31 and 0 < value['gid'] < 2**31
        and value['uid'] != origin.pw_uid and value['gid'] != origin.pw_gid, 'independent_wallet_identity_required')
    passwd = run(['/usr/bin/getent', 'passwd', value['user']], 3).strip().splitlines()
    groups = run(['/usr/bin/getent', 'group', value['group']], 3).strip().splitlines()
    require(len(passwd) == len(groups) == 1, 'wallet_getent_missing_or_ambiguous')
    p, g = passwd[0].split(':'), groups[0].split(':')
    require(len(p) == 7 and len(g) == 4 and p[0] == value['user'] and g[0] == value['group']
        and p[2] == str(value['uid']) and p[3] == str(value['gid']) and g[2] == str(value['gid']), 'wallet_getent_changed')
    memberships = run(['/usr/bin/getent','initgroups',value['user']],3).split()
    require(memberships and memberships[0] == value['user']
        and set(memberships[1:]).issubset({str(value['gid'])}), 'wallet_supplementary_groups_refused')
    return pwd.struct_passwd((p[0],p[1],int(p[2]),int(p[3]),p[4],p[5],p[6]))


def validate_wallet_socket_acl(raw, wallet_uid):
    lines = [line.strip() for line in raw.splitlines() if line.strip() and not line.startswith('#')]
    require(len(lines) == 5 and set(lines) == {'user::rw-', 'user:'+str(wallet_uid)+':-w-',
        'group::-w-', 'mask::-w-', 'other::---'}, 'wallet_socket_acl_mismatch')


def private_access_preflight(account, readable, denied, check):
    """Real kernel DAC checks after dropping all supplementary groups; never print bytes."""
    program = """import os,sys,json,hashlib
material=json.loads(sys.argv[1])
for path,digest in material['readable']:
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  raw=os.read(fd,524289)
  if len(raw)>524288 or hashlib.sha256(raw).hexdigest()!=digest:raise SystemExit(1)
 finally:os.close(fd)
for path in material['denied']:
 try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except PermissionError:continue
 else:os.close(fd);raise SystemExit(2)
"""
    check()
    child = subprocess.run(['/usr/bin/python3','-I','-B','-c',program,
        encode({'readable':readable,'denied':[str(p) for p in denied]}).decode()],
        user=account.pw_uid, group=account.pw_gid, extra_groups=[],
        env={'PATH':'/usr/bin:/bin','LC_ALL':'C'}, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, close_fds=True)
    require(child.returncode == 0, 'actual_service_uid_permissions_failed'); check()


def configured_isolated_target(base, controller, config, old):
    recorded = old.get('isolatedActivation')
    if recorded is None:
        return None
    require(isinstance(recorded, dict) and isinstance(recorded.get('jobPin'), dict),
            'configured_isolated_origin_required')
    capability = base._verify_isolated_target(controller, config, config['launcher'],
        recorded['jobPin'], old['releaseRoot'], old['nodePath'])
    require(base._isolated_target(capability) == recorded, 'configured_isolated_origin_changed')
    return capability


def isolated_transition_scope(base, scope, *values):
    def inspect(value):
        if isinstance(value, dict):
            for child in value.values():
                inspect(child)
        elif isinstance(value, list):
            for child in value:
                inspect(child)
        elif isinstance(value, str) and value.startswith('/'):
            path = Path(value)
            require(value == os.path.normpath(value) and path.is_relative_to(scope) and path != scope,
                    'configured_isolated_material_scope')
            base.protected_parent(path)
    for value in values:
        inspect(value)


def isolated_transition_binding(isolated, original, binding):
    require(binding.get('target') == isolated['target'] == original.get('target')
            and binding.get('generationId') == isolated['generationId'] == original.get('generationId')
            and binding.get('operationId') == isolated['operationId'] == original.get('operationId')
            and binding.get('importId') == original.get('importId')
            and binding.get('planSha256') == original.get('planSha256'),
            'configured_isolated_binding_changed')


def adapter_type(base):


    class ConfiguredActivation(base.NativeActivation):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.origin_account = self.account

        def account_for(self, service):
            return self.wallet_account if service == 'wallet-monitor' else self.origin_account

        @contextlib.contextmanager
        def as_service(self, service):
            previous = self.account
            self.account = self.account_for(service)
            try:
                yield
            finally:
                self.account = previous

        def deployment_path(self, service):
            return self.directory / ('wallet-deployment.json' if service == 'wallet-monitor' else 'deployment.json')

        def publish_deployment_copies(self, deployment):
            raw, published_sha = deployment_publication(deployment)
            self.state['deploymentSha256'] = published_sha
            self.journal.save()
            self.managed(self.deployment_path('scanner'), raw, 0o400, self.origin_account)
            self.managed(self.deployment_path('wallet-monitor'), raw, 0o400, self.wallet_account)
            return raw

        def publish(self, service):
            with self.as_service(service):
                super().publish(service)

        def unit(self, service):
            state = super().unit(service)
            self.check()
            raw = self.fence.deadline.command(['/usr/bin/systemctl','show',
                'address-radar-'+service+'.service','-p','Group'])
            require(raw.startswith('Group=') and len(raw.splitlines()) == 1, 'unit_group_unavailable')
            state['Group'] = raw.strip().split('=',1)[1]
            self.check()
            return state

        def verify_published(self):
            self.source_safe()
            for service in base.SERVICES:
                self.check()
                path, account = self.dropin(service), self.account_for(service)
                require(self.file_descriptor(path) == self.state['artifacts'][str(path)]['desired'], 'activation_dropin_changed')
                state = self.unit(service)
                base.validate_waiting_limits(state.get('MemoryMax'),state.get('TasksMax'))
                argv = 'argv[]='+str(self.node)+' --no-global-search-paths '+str(self.release/'scripts/postgres-address-only-dispatch.mjs')+' '+service+' ;'
                expected_group = self.wallet_group if service == 'wallet-monitor' else grp.getgrgid(account.pw_gid).gr_name
                require(state.get('User') == account.pw_name and state.get('Group') == expected_group
                    and state.get('ExecStart','').count('path=') == 1 and argv in state['ExecStart']
                    and str(path) in state.get('DropInPaths','').split()
                    and state.get('EnvironmentFiles') == str(self.directory/(service+'.env'))+' (ignore_errors=no)',
                    'effective_postgresql_unit_identity_mismatch')

        def validate_ready(self, value, peer):
            require(isinstance(value,dict) and value.get('service') in base.SERVICES, 'readiness_service')
            with self.as_service(value['service']):
                return super().validate_ready(value,peer)

        def verify_ready_service(self, service):
            require(service in base.SERVICES, 'readiness_service')
            self.check()
            expected=self.state['units'][service].get('ready')
            require(isinstance(expected,dict), 'six_bound_readiness_required')
            value={key:expected[key] for key in ('relayProtocol','type','service','operationId','generationId',
                'releaseSha256','nonce','attempt','childPid')}
            require(value['service'] == service, 'readiness_service_binding_mismatch')
            account=self.account_for(service)
            actual=self.validate_ready(value,(expected['mainPid'],account.pw_uid,account.pw_gid))
            require(actual == expected, 'service_restarted_after_readiness')
            self.check()

        def verify_ready(self):
            for service in base.SERVICES:
                self.verify_ready_service(service)

        def process(self, pid, service, child=False, parent=None):
            with self.as_service(service):
                result = super().process(pid,service,child=child,parent=parent)
                root = Path('/proc')/str(pid)
                status = dict(line.split(':',1) for line in (root/'status').read_text().splitlines() if ':' in line)
                require(all(int(gid) == self.account.pw_gid for gid in status['Gid'].split()), 'readiness_gid_mismatch')
                require((root/'stat').read_text().rsplit(')',1)[1].split()[19] == result['startTime'], 'readiness_pid_reused')
                return result

        def readable_preflight(self):
            evidence = self.directory/'evidence.json'
            environments = [self.directory/(s+'.env') for s in base.SERVICES]
            for service in ('scanner','wallet-monitor'):
                deployment = self.deployment_path(service)
                readable = [(str(p),self.state['artifacts'][str(p)]['desired']['sha256']) for p in (deployment,evidence)]
                other = self.deployment_path('scanner' if service == 'wallet-monitor' else 'wallet-monitor')
                denied = environments+[other]
                if service == 'wallet-monitor':
                    readable += [(p['path'],p['sha256']) for p in self.wallet_authority_pins]
                else:
                    denied += [p['path'] for p in self.wallet_authority_pins]
                private_access_preflight(self.account_for(service),readable,denied,self.check)

        def grant_wallet_socket(self, socket_path):
            self.check()
            self.fence.deadline.command(['/usr/bin/setfacl','-m','u:'+str(self.wallet_account.pw_uid)+':w',str(socket_path)])
            raw = self.fence.deadline.command(['/usr/bin/getfacl','-ncp',str(socket_path)])
            validate_wallet_socket_acl(raw,self.wallet_account.pw_uid)
            self.check()
        def publish_wallet_authority(self, environment):
            sources = self.wallet_authority_sources
            original = json.loads(read_pin(sources[0],sealed=False))
            pins = []
            for filename, source in zip(('wallet-publisher-credential.json','wallet-validator-key.pem'),sources[1:]):
                raw = read_pin(source,sealed=False)
                path = self.directory/filename
                self.managed(path,raw,0o400,self.wallet_account)
                pins.append({'path':str(path),'sha256':sha(raw)})
            configured = dict(original,credential=pins[0],privateKey=pins[1])
            raw = encode(configured); path = self.directory/'wallet-authority.json'
            self.managed(path,raw,0o400,self.wallet_account)
            config_pin = {'path':str(path),'sha256':sha(raw)}
            self.wallet_authority_pins = [config_pin]+pins
            self.state['walletAuthorityPins'] = self.wallet_authority_pins
            self.journal.save()
            result = dict(environment)
            result.update(ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE=config_pin['path'],
                ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256=config_pin['sha256'])
            return result

        def prepare_configured(self, request, manifest, deployment, environment):
            self.source_safe()
            self.state['attempt'] = secrets.token_hex(16); self.journal.save()
            self.ensure_directory(self.directory, 0o755)
            self.managed(self.directory / 'startup-manifest.json', encode(manifest), 0o444)
            wallet_environment = self.publish_wallet_authority(environment)
            raw = self.publish_deployment_copies(deployment)
            measured = self.state['measurement']
            evidence = {'protocol': 'address-only-native-startup-evidence-v1',
                **{key: manifest[key] for key in ('operationId', 'importId', 'generationId', 'releaseSha256', 'backupSha256', 'fenceSha256')},
                'deploymentSha256': sha(raw), 'safetyEnvironmentSha256': sha(encode([[name, 'false'] for name in base.FLAGS])),
                'measuredAt': int(time.time()*1000), 'sourceEpoch': [
                    {'path': row['path'], **{key: str(row[key]) for key in ('device','inode','size','uid','gid','mode','mtimeNs','ctimeNs')}}
                    for row in measured['sources']], 'sourceSealed': True, 'importCommitted': True,
                **{key: False for key in SAFETY}}
            evidence_raw = encode(evidence)
            self.managed(self.directory / 'evidence.json', evidence_raw, 0o444)
            run = Path('/run/address-radar-activation'); self.ensure_directory(run, 0o711)
            socket_path = run / (sha(self.config['operationId'].encode())[:16] + '-' + self.state['attempt'][:16] + '.sock')
            self.listener = base.ReadinessSocket(socket_path, self.origin_account.pw_gid, self.check)
            self.grant_wallet_socket(socket_path)
            entry, _ = base.sealed_file(self.release / 'scripts/postgres-service-entry.mjs', 128*1024**2, self.check)
            env = dict(environment)
            env.update(ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE=str(self.directory/'deployment.json'),
                ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256=sha(raw), ADDRESS_RADAR_POSTGRES_ENTRY_SHA256=entry['sha256'],
                ADDRESS_RADAR_POSTGRES_RELEASE_SHA256=manifest['releaseSha256'],
                ADDRESS_RADAR_POSTGRES_ADDRESS_ONLY_EVIDENCE_FILE=str(self.directory/'evidence.json'),
                ADDRESS_RADAR_POSTGRES_ADDRESS_ONLY_EVIDENCE_SHA256=sha(evidence_raw),
                ADDRESS_RADAR_POSTGRES_ACTIVATION_SOCKET=str(socket_path), ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT=self.state['attempt'],
                ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION=manifest['operationId'], ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION=manifest['generationId'])
            for service in base.SERVICES:
                credential = base.private_json(self.auth/(service+'.json'), 65536)
                url = (base.credential_url(credential, service, isolated_target=self.isolated_target)
                       if self.isolated_target is not None else base.credential_url(credential, service))
                service_env = dict(env, ADDRESS_RADAR_POSTGRES_URL=url,
                    ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE=str(self.deployment_path(service)))
                if service == 'wallet-monitor':
                    for key in ('ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE','ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256'):
                        service_env[key] = wallet_environment[key]
                else:
                    for key in ('ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE','ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256'):
                        service_env.pop(key,None)
                self.managed(self.directory/(service+'.env'), base.environment_file(service_env))
            self.state['waitingResourcePolicy'] = dict(base.WAITING_POLICY)
            self.readable_preflight(); self.fresh()
            base.validate_waiting_host(self.state['resources'], prestart=True)
            self.state['phase'] = 'PREPARED'; self.journal.save()

        def complete(self):
            validate_completion_proof(self.state,int(time.time()*1000))
            self.verify_ready(); self.source_safe()
            base.validate_capacity(self.state['capacity'], self.expected_resources(), int(time.time()*1000))
            receipt = {'protocol': 'address-only-configured-transition-receipt-v1',
                'transitionId': self.state['transitionId'], 'authorizationRef': self.state['authorizationRef'],
                'walletServiceUser': self.state['walletServiceUser'],
                'operationId': self.config['operationId'], 'generationId': self.state['measurement']['binding']['generationId'],
                'importId': self.state['measurement']['binding']['importId'], 'databaseImported': True,
                'newImportPerformed': False, 'businessReleaseSwitched': True, 'sourceMonitoring': 'configured_pending_observation',
                'monitoringCompleted': False, 'businessEligibilityGranted': False, **{key:False for key in SAFETY},
                'oldManifestSha256': self.state['oldManifestSha256'], 'newManifestSha256': self.state['newManifestSha256'],
                'oldReleaseSha256': self.state['oldReleaseSha256'], 'releaseSha256': self.state['release']['releaseSha256'],
                'deploymentSha256': self.state['deploymentSha256'], 'evidenceSha256': self.state['artifacts'][str(self.directory/'evidence.json')]['desired']['sha256'],
                'nativePreflight': self.state['nativePreflight'], 'capacity': self.state['capacity'],
                'recoveryRenewal': self.state.get('recoveryRenewal'),
                'configuredOrigin': self.state.get('configuredOrigin'),
                'originObservation': self.state.get('originObservation')}
            validate_completion_proof(self.state,int(time.time()*1000))
            self.check()
            self.managed(transition_receipt_path(self.output,self.state['transitionId']), encode(receipt))
            return receipt
    return ConfiguredActivation


def transition_receipt_path(output, transition_id):
    require(isinstance(transition_id,str) and re.fullmatch('[A-Za-z0-9_-]{1,64}',transition_id), 'transition_id')
    return Path(output)/('configured-'+transition_id+'-receipt.json')


def validate_degraded_recovery(value):
    require(isinstance(value,dict) and set(value) == {'protocol','authorizationRef','services'}
        and value['protocol'] == 'address-only-configured-degraded-origin-v1'
        and value['services'] == ['wallet-monitor']
        and isinstance(value['authorizationRef'],str) and 0 < len(value['authorizationRef']) <= 512
        and not any(ord(c)<32 or ord(c)==127 for c in value['authorizationRef']), 'degraded_wallet_authorization_required')


def wallet_cgroup_processes(group):
    require(group.startswith('/system.slice/') and '..' not in group.split('/') and not '\x00' in group,
        'degraded_cgroup_scope')
    path=Path('/sys/fs/cgroup')/group.lstrip('/')/'cgroup.procs'
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        raw=stream.read(4097)
    require(len(raw)<=4096, 'degraded_process_budget')
    values=raw.split()
    require(0<len(values)<=16 and all(v.isdigit() for v in values), 'degraded_process_budget')
    return [int(v) for v in values]


def read_process_environment(pid):
    require(type(pid) is int and pid>1, 'degraded_environment_pid')
    fd=os.open('/proc/'+str(pid)+'/environ',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        raw=stream.read(65537)
    require(0<len(raw)<=65536, 'degraded_environment_budget')
    return raw


def verify_degraded_worker_environment(adapter, pid, parent, read_environment=read_process_environment,
                                       service='wallet-monitor'):
    adapter.check()
    main_before=adapter.process(parent,service)
    worker_before=adapter.process(pid,service,child=True,parent=parent)
    deployment=adapter.directory/('wallet-deployment.json' if service=='wallet-monitor' else 'deployment.json')
    expected={
        'ADDRESS_RADAR_POSTGRES_ACTIVATION_OPERATION':adapter.state['measurement']['binding']['operationId'],
        'ADDRESS_RADAR_POSTGRES_ACTIVATION_GENERATION':adapter.state['measurement']['binding']['generationId'],
        'ADDRESS_RADAR_POSTGRES_RELEASE_SHA256':adapter.state['release']['releaseSha256'],
        'ADDRESS_RADAR_POSTGRES_ACTIVATION_ATTEMPT':adapter.state['attempt'],
        'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE':str(deployment),
        'ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256':adapter.state['artifacts'][str(deployment)]['desired']['sha256']}
    nonce_key=b'ADDRESS_RADAR_POSTGRES_LAUNCH_NONCE'
    def values(raw):
        require(isinstance(raw,bytes) and 0<len(raw)<=65536, 'degraded_environment_budget')
        result={}
        for item in raw.split(b'\0'):
            key,separator,value=item.partition(b'=')
            if key in [k.encode() for k in expected] or key==nonce_key:
                require(separator and key not in result, 'degraded_environment_duplicate')
                result[key]=value
        return result
    main_raw=read_environment(parent);worker_raw=read_environment(pid)
    main_env,worker_env=values(main_raw),values(worker_raw)
    for key,value in expected.items():
        require(main_env.get(key.encode()) == worker_env.get(key.encode()) == value.encode(),
            'degraded_current_lifecycle_binding_mismatch')
    nonce=worker_env.get(nonce_key,b'')
    require(re.fullmatch(b'[a-f0-9]{32}',nonce) is not None, 'degraded_worker_nonce_required')
    require(read_environment(parent)==main_raw and read_environment(pid)==worker_raw
        and adapter.process(parent,service)==main_before
        and adapter.process(pid,service,child=True,parent=parent)==worker_before,
        'degraded_worker_lifecycle_changed')
    adapter.check()
    return {'currentNonceVerified':True,'currentLifecycleBindingVerified':True,'nonceSha256':sha(nonce)}


def inspect_degraded_wallet(adapter, read_pids=wallet_cgroup_processes, service='wallet-monitor'):
    adapter.check()
    unit=adapter.unit(service)
    require(unit.get('ActiveState') == 'active' and unit.get('InvocationID')
        and unit.get('ControlGroup','').startswith('/system.slice/')
        and '..' not in unit['ControlGroup'].split('/'), 'degraded_wallet_not_inspectable')
    pid=int(unit.get('MainPID','0'))
    require(pid>1, 'degraded_wallet_not_inspectable')
    def restarts():
        raw=adapter.fence.deadline.command(['/usr/bin/systemctl','show',
            'address-radar-'+service+'.service','-p','NRestarts'])
        require(re.fullmatch(r'NRestarts=[0-9]+\n?',raw) is not None,'degraded_restart_count_unavailable')
        return int(raw.strip().split('=',1)[1])
    count=restarts()
    pids=read_pids(unit['ControlGroup'])
    require(isinstance(pids,list) and 0<len(pids)<=16 and len(set(pids))==len(pids)
        and all(type(p) is int and p>1 for p in pids) and pid in pids, 'degraded_process_budget')
    main=adapter.process(pid,service)
    require(main['cgroup'] == '0::'+unit['ControlGroup'], 'degraded_process_cgroup_mismatch')
    workers=[]
    for child_pid in pids:
        if child_pid == pid:continue
        child=adapter.process(child_pid,service,child=True,parent=pid)
        require(child['cgroup'] == main['cgroup'], 'degraded_process_cgroup_mismatch')
        workers.append({'pid':child_pid,**child})
    require(len(workers)==1, 'degraded_current_worker_required')
    nonce_proof=verify_degraded_worker_environment(adapter,workers[0]['pid'],pid,service=service)
    after=adapter.unit(service)
    require(all(after.get(k)==unit.get(k) for k in ('MainPID','InvocationID','ControlGroup','ActiveState'))
        and restarts()==count and sorted(read_pids(unit['ControlGroup']))==sorted(pids)
        and adapter.process(pid,service)==main, 'degraded_wallet_changed_during_inspection')
    for child in workers:
        require(adapter.process(child['pid'],service,child=True,parent=pid)==
            {k:v for k,v in child.items() if k!='pid'}, 'degraded_wallet_changed_during_inspection')
    adapter.check()
    old=adapter.state['units'][service].get('ready',{})
    return {'service':service,'degraded':True,'oldReadinessVerified':False,'mainPid':pid,
        'invocationId':unit['InvocationID'],'nRestarts':count,'main':main,'workers':workers,
        'restartedSinceReceipt':old.get('mainPid')!=pid or old.get('invocationId')!=unit['InvocationID'],
        'measuredAtMs':int(time.time()*1000),'workerLifecycle':nonce_proof}


def validate_restored_recovery(value):
    require(isinstance(value,dict) and set(value)=={'protocol','authorizationRef','services','restoreReceipt'}
        and value['protocol']=='address-only-configured-restored-origin-v1'
        and value['services']==list(RESTORED_SERVICES)
        and isinstance(value['authorizationRef'],str) and 0<len(value['authorizationRef'])<=512
        and not any(ord(c)<32 or ord(c)==127 for c in value['authorizationRef']), 'restored_origin_authorization_required')
    pin=value['restoreReceipt']
    require(isinstance(pin,dict) and set(pin)=={'path','sha256'}
        and isinstance(pin['path'],str) and os.path.isabs(pin['path'])
        and os.path.normpath(pin['path'])==pin['path']
        and Path('/var/lib/address-radar-maintenance-tools') in Path(pin['path']).parents
        and isinstance(pin['sha256'],str) and re.fullmatch('[a-f0-9]{64}',pin['sha256']), 'restored_origin_receipt_pin')


def validate_restore_receipt(audit, origin, state):
    fields={'allActive','completedAtMs','databaseRollback','failedTransition','gatewayDeliveryEnabled',
        'priorJournalSha256','priorTransition','protocol','services','startedAtMs','status'}
    require(isinstance(audit,dict) and set(audit)==fields
        and audit['protocol']=='address-only-restore-prior-service-config-v1'
        and audit['allActive'] is True and audit['databaseRollback'] is False
        and audit['gatewayDeliveryEnabled'] is False
        and audit['priorJournalSha256']==origin['journal']['sha256']
        and audit['priorTransition']==state['transitionId']
        and isinstance(audit['failedTransition'],str)
        and re.fullmatch('[A-Za-z0-9_-]{1,64}',audit['failedTransition'])
        and audit['failedTransition']!=audit['priorTransition']
        and type(audit['startedAtMs']) is int and type(audit['completedAtMs']) is int
        and 0<audit['startedAtMs']<=audit['completedAtMs']<=int(time.time()*1000)
        and isinstance(audit['services'],list) and len(audit['services'])==6
        and set(audit['services'])==set(RESTORED_SERVICES)
        and isinstance(audit['status'],dict) and set(audit['status'])==set(RESTORED_SERVICES), 'restored_origin_receipt_binding')
    for service in RESTORED_SERVICES:
        require(audit['status'][service]=={'ActiveState':'active','SubState':'running','NRestarts':'0'},
            'restored_origin_receipt_service')


def inspect_restored_services(adapter):
    observations={}
    for service in RESTORED_SERVICES:
        adapter.check()
        raw=adapter.fence.deadline.command(['/usr/bin/systemctl','show','address-radar-'+service+'.service','-p','SubState'])
        require(raw=='SubState=running\n', 'restored_origin_not_running')
        proof=inspect_degraded_wallet(adapter,service=service)
        require(proof['nRestarts']==0, 'restored_origin_restarted')
        observations[service]=dict(proof,degraded=False,restored=True)
    # A six-service observation must not combine snapshots across a restart.
    for service,proof in observations.items():
        adapter.check()
        unit=adapter.unit(service)
        require(unit.get('ActiveState')=='active' and int(unit.get('MainPID','0'))==proof['mainPid']
            and unit.get('InvocationID')==proof['invocationId']
            and '0::'+unit.get('ControlGroup','')==proof['main']['cgroup']
            and adapter.process(proof['mainPid'],service)==proof['main']
            and sorted(wallet_cgroup_processes(unit['ControlGroup']))==sorted([proof['mainPid']]+[w['pid'] for w in proof['workers']]),
            'restored_origin_lifecycle_changed')
        worker=proof['workers'][0]
        require(adapter.process(worker['pid'],service,child=True,parent=proof['mainPid'])=={k:v for k,v in worker.items() if k!='pid'}
            and verify_degraded_worker_environment(adapter,worker['pid'],proof['mainPid'],service=service)==proof['workerLifecycle'],
            'restored_origin_lifecycle_changed')
        raw=adapter.fence.deadline.command(['/usr/bin/systemctl','show','address-radar-'+service+'.service','-p','NRestarts','-p','SubState'])
        require(set(raw.splitlines())=={'NRestarts=0','SubState=running'} and len(raw.splitlines())==2,
            'restored_origin_restarted')
    return observations


def validate_configured_origin(origin, state, receipt, original, request):
    require(isinstance(origin,dict) and set(origin)-{'degradedRecovery','restoredRecovery'} == {'journal','receipt','releaseRoot','node'}
        and not ('degradedRecovery' in origin and 'restoredRecovery' in origin), 'configured_origin_fields')
    if 'degradedRecovery' in origin:
        validate_degraded_recovery(origin['degradedRecovery'])
    if 'restoredRecovery' in origin:
        validate_restored_recovery(origin['restoredRecovery'])
    for name in ('journal','receipt','node'):
        value=origin[name]
        require(isinstance(value,dict) and set(value) == {'path','sha256'}
            and isinstance(value['path'],str) and os.path.isabs(value['path'])
            and os.path.normpath(value['path']) == value['path']
            and isinstance(value['sha256'],str) and re.fullmatch('[a-f0-9]{64}',value['sha256']), 'configured_origin_pin')
    require(isinstance(origin['releaseRoot'],str) and os.path.isabs(origin['releaseRoot'])
        and os.path.normpath(origin['releaseRoot']) == origin['releaseRoot'], 'configured_origin_root')
    require(state.get('phase') == 'COMPLETE' and state.get('pending') is None and state.get('receipt') == receipt
        and state.get('transitionId') == receipt.get('transitionId')
        and state.get('transitionId') != request['transitionId']
        and state.get('operationId') == original['operationId'], 'configured_origin_checkpoint')
    require(receipt.get('protocol') == 'address-only-configured-transition-receipt-v1'
        and receipt.get('sourceMonitoring') == 'configured_pending_observation'
        and receipt.get('databaseImported') is True and receipt.get('newImportPerformed') is False
        and receipt.get('businessReleaseSwitched') is True and receipt.get('monitoringCompleted') is False
        and receipt.get('businessEligibilityGranted') is False
        and all(receipt.get(key) is False for key in SAFETY)
        and all(receipt.get(key) == original[key] for key in ('operationId','generationId','importId')),
        'configured_origin_receipt')
    current=derive_manifest(original,receipt.get('releaseSha256'))
    require(state.get('release',{}).get('releaseSha256') == current['releaseSha256']
        and request['releaseSha256'] != current['releaseSha256']
        and state.get('newManifestSha256') == receipt.get('newManifestSha256') == sha(encode(current))
        and state.get('node',{}).get('sha256') == origin['node']['sha256']
        and state.get('walletServiceUser') == request['walletServiceUser'], 'configured_origin_binding')
    return current


def verify_configured_origin_live(base, adapter, origin, original, receipt, check):
    inventory=base.release_inventory(origin['releaseRoot'],check)
    require(inventory == adapter.state['release'], 'configured_origin_inventory_changed')
    node,_=base.sealed_file(Path(origin['node']['path']),128*1024**2,check)
    require(node['sha256'] == origin['node']['sha256'], 'configured_origin_node_changed')
    for path,record in adapter.state['artifacts'].items():
        check()
        require(adapter.file_descriptor(Path(path)) == record['desired'], 'configured_origin_artifact_changed')
    current=derive_manifest(original,receipt['releaseSha256'])
    manifest_path=adapter.directory/'startup-manifest.json'
    require(adapter.file_descriptor(manifest_path)['sha256'] == sha(encode(current)), 'configured_origin_manifest_changed')
    adapter.verify_published()
    if 'restoredRecovery' in origin:
        policy=origin['restoredRecovery']
        validate_restored_recovery(policy)
        pin=policy['restoreReceipt']
        base.protected_parent(Path(pin['path']))
        audit_raw=read_pin(pin,sealed=False)
        validate_restore_receipt(json.loads(audit_raw),origin,adapter.state)
        # The old receipt remains historical. Current process identity is not old readiness.
        adapter.source_safe()
        adapter.readable_preflight()
        observations=inspect_restored_services(adapter)
        for path,record in adapter.state['artifacts'].items():
            check()
            require(adapter.file_descriptor(Path(path))==record['desired'], 'configured_origin_artifact_changed')
        adapter.verify_published()
        adapter.source_safe()
        require(read_pin(pin,sealed=False)==audit_raw, 'restored_origin_receipt_changed')
        check()
        return {'mode':'authorized-six-service-restored','authorizationRef':policy['authorizationRef'],
            'restoreReceipt':copy.deepcopy(pin),'services':observations,'currentServiceIdentitiesVerified':6,
            'oldSixServiceReadinessVerified':False}
    if 'degradedRecovery' in origin:
        validate_degraded_recovery(origin['degradedRecovery'])
        # Retained advisory transaction already verified the actual commit before this call.
        adapter.source_safe()
        adapter.readable_preflight()
        for service in base.SERVICES:
            if service != 'wallet-monitor':adapter.verify_ready_service(service)
        proof=inspect_degraded_wallet(adapter)
        adapter.source_safe()
        check()
        return {'mode':'authorized-wallet-degraded','authorizationRef':origin['degradedRecovery']['authorizationRef'],
            'healthyServicesReadinessVerified':5,'wallet':proof,'oldSixServiceReadinessVerified':False}
    adapter.verify_ready()
    check()
    return {'mode':'healthy','oldSixServiceReadinessVerified':True}


def source_origin_exec_configuration(value):
    """Separate systemd's immutable command from its stop-time process results."""
    require(type(value) is str and 0 < len(value) <= 16384, 'source_origin_exec_shape')
    match = re.fullmatch(r'\{ (path=[^\n{}]+? ; argv\[\]=[^\n{}]+? ; ignore_errors=(?:yes|no))'
        r' ; start_time=\[[^\]\n]*\] ; stop_time=\[[^\]\n]*\] ; pid=[0-9]+'
        r' ; code=[^;{}\n]+ ; status=[^;{}\n]+ \}', value)
    require(match is not None and value.count('path=') == 1 and value.count('argv[]=') == 1,
            'source_origin_exec_shape')
    return match.group(1)


def source_origin_artifact_snapshot(base, adapter, check):
    """Read immutable origin evidence; never infer readiness from artifact presence."""
    check()
    inventory = base.release_inventory(str(adapter.release), check)
    require(inventory == adapter.state['release'], 'source_origin_release_changed')
    node, _ = base.sealed_file(adapter.node, 128*1024**2, check)
    artifacts = {}
    require(0 < len(adapter.state['artifacts']) <= 256, 'source_origin_artifact_budget')
    for path, record in sorted(adapter.state['artifacts'].items()):
        check()
        actual = adapter.file_descriptor(Path(path))
        require(actual == record['desired'], 'source_origin_artifact_changed')
        artifacts[path] = actual
    units = {}
    for service in base.SERVICES:
        check()
        value = adapter.unit(service)
        # Runtime/PID observations are separate: these fields must survive stop.
        units[service] = {key: value.get(key) for key in
            ('User', 'Group', 'EnvironmentFiles', 'MemoryMax', 'TasksMax')}
        units[service]['ExecStart'] = source_origin_exec_configuration(value.get('ExecStart'))
        require(str(adapter.dropin(service)) in value.get('DropInPaths', '').split(),
                'source_origin_dropin_missing')
    check()
    return {'release': inventory, 'node': node, 'artifacts': artifacts, 'units': units}


def capture_source_origin(base, controller, config, request, *, check):
    """Read live identity before fencing under the caller's retained native lock.

    This observation is NOT a capability. Only the native adapter may bind it to
    its owner journal/OFD, boot and subsequent physical drain. Never restore a
    capability from this dictionary or from a previous process's journal.
    """
    check()
    require(request.get('protocol') == 'address-only-configured-transition-v1'
            and type(request.get('deadlineAtMs')) is int
            and 0 < request['deadlineAtMs']-int(time.time()*1000) <= 240000,
            'source_origin_request')
    def pinned(pin):
        base.protected_parent(Path(pin['path']))
        return guarded(check, lambda: read_pin(pin, sealed=False))
    old = json.loads(pinned(request['oldState']))
    original = json.loads(pinned(request['originalManifest']))
    require(old.get('phase') == 'COMPLETE' and old.get('pending') is None
            and old.get('receipt', {}).get('sourceMonitoring') == 'waiting_configuration'
            and old.get('operationId') == original.get('operationId') == config['operationId']
            and old.get('manifestSha256') == sha(encode(original)), 'completed_waiting_origin_required')
    binding = old['measurement']['binding']
    require(all(binding.get(key) == original.get(key) for key in
                ('target', 'operationId', 'generationId', 'importId', 'planSha256')),
            'source_origin_binding_changed')
    isolated = configured_isolated_target(base, controller, config, old)
    if isolated is None:
        controller.validate_config(config)
    else:
        scope = Path(base._isolated_target(isolated)['scope'])
        base._isolated_config(controller, config, scope)
        isolated_transition_binding(base._isolated_target(isolated), original, binding)
    module = controller.load_module('configured_fence', config['fence'])
    if isolated is not None:
        base._isolated_fence_scope(module, scope)
    # Only a read-only deadline/check view is needed for systemd/proc identity.
    # Recovering the migration fence here would try to acquire the same lock.
    view = types.SimpleNamespace(deadline=module.Deadline(
        (request['deadlineAtMs']-int(time.time()*1000))/1000), _check_recovery_guard=check)
    state, receipt = old, old['receipt']
    origin = request.get('configuredOrigin')
    kwargs = {'isolated_target': isolated} if isolated is not None else {}
    if origin is not None:
        state = json.loads(pinned(origin['journal']))
        receipt = json.loads(pinned(origin['receipt']))
        validate_configured_origin(origin, state, receipt, original, request)
        # Degraded/restored identities need their existing explicit verifier,
        # not a healthy-readiness substitution in this initial handoff ABI.
        require(not {'degradedRecovery', 'restoredRecovery'}.intersection(origin),
                'source_origin_recovery_requires_explicit_entry')
        adapter = adapter_type(base)(controller, config, {}, module, view,
            types.SimpleNamespace(state=state), origin['releaseRoot'], origin['node']['path'], **kwargs)
        adapter.directory = (scope/'runtime' if isolated is not None else Path('/etc/address-radar'))/('configured-'+state['transitionId'])
        adapter.wallet_account = resolve_wallet_identity(request['walletServiceUser'], pwd.getpwnam('address-radar'))
        adapter.wallet_group = request['walletServiceUser']['group']
    else:
        adapter = base.NativeActivation(controller, config, {}, module, view,
            types.SimpleNamespace(state=state), old['releaseRoot'], old['nodePath'], **kwargs)
    # Real SO_PEERCRED-derived receipt identity is rechecked against current
    # systemd invocation, /proc UID/node/argv/starttime/cgroup and launch nonce.
    adapter.verify_ready()
    artifacts = source_origin_artifact_snapshot(base, adapter, check)
    services = {}
    for service in base.SERVICES:
        unit = adapter.unit(service)
        ready = state['units'][service]['ready']
        require(unit.get('ActiveState') == 'active' and unit.get('MainPID') == str(ready['mainPid']),
                'source_origin_not_live')
        services[service] = {'ready': copy.deepcopy(ready),
            'unit': {key: unit.get(key) for key in ('MainPID', 'InvocationID', 'ControlGroup', 'User')}}
    adapter.verify_ready()
    require(source_origin_artifact_snapshot(base, adapter, check) == artifacts, 'source_origin_changed')
    source_journal = module.Journal().read()
    require(source_journal is not None and source_journal['binding'] == binding,
            'source_origin_journal_changed')
    check()
    return {'protocol': 'address-only-source-origin-observation-v1',
        'transitionSha256': sha(encode(request)), 'operationId': original['operationId'],
        'generationId': original['generationId'], 'binding': copy.deepcopy(binding),
        'oldState': copy.deepcopy(request['oldState']), 'originalManifest': copy.deepcopy(request['originalManifest']),
        'configuredOrigin': copy.deepcopy(origin), 'originStateSha256': sha(encode(state)),
        'originReceiptSha256': sha(encode(receipt)), 'sourceJournalSha256': sha(encode(source_journal)),
        'measurementSha256': sha(encode(state['measurement'])),
        'artifacts': artifacts, 'services': services}


# Bound only after the native issuer implementation is independently frozen.
# No job field, capability attribute or caller-supplied pin may select an issuer.
SOURCE_ORIGIN_ISSUER_SHA256 = 'ba396e60940bbef7babdd57098439e682cf0ef77336230d27614e73af6030086'
_source_origin_issuer_module = None
_source_origin_issuer_stamp = None


def _source_origin_issuer():
    """Load one fixed, reviewed issuer instance; its registry is process-local."""
    global _source_origin_issuer_module, _source_origin_issuer_stamp
    expected = SOURCE_ORIGIN_ISSUER_SHA256
    require(type(expected) is str and re.fullmatch('[a-f0-9]{64}', expected),
            'source_origin_issuer_unbound')
    path = Path(__file__).with_name('source-replacement-controller-adapter.py')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'unsafe_source_origin_issuer')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= 4194304,
                'unsafe_source_origin_issuer')
        raw = stream.read(4194305)
        after = os.fstat(stream.fileno())
    stamp = lambda value: (value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
    identity = stamp(before)
    require(identity == stamp(after) == stamp(path.lstat()) and len(raw) == before.st_size
            and sha(raw) == expected, 'source_origin_issuer_changed')
    if _source_origin_issuer_module is None:
        module = types.ModuleType('native_source_origin_issuer')
        module.__file__ = str(path)
        exec(compile(raw, str(path), 'exec'), module.__dict__)
        require(callable(getattr(module, 'issue_source_origin_capability', None))
                and callable(getattr(module, 'verify_issued_source_origin_capability', None)),
                'source_origin_issuer_incomplete')
        _source_origin_issuer_module, _source_origin_issuer_stamp = module, identity
    require(identity == _source_origin_issuer_stamp, 'source_origin_issuer_changed')
    return _source_origin_issuer_module


def verify_source_origin_boundary(capability, request, state, receipt, adapter, live):
    """Never invoke capability methods. Only the pinned issuer may authenticate it."""
    if capability is None:
        return live()
    adapter.check()
    issuer = _source_origin_issuer()
    observation = issuer.verify_issued_source_origin_capability(capability, request, state, receipt, adapter)
    adapter.check()
    adapter.source_safe()
    require(type(observation) is dict, 'source_origin_observation_required')
    return observation


def perform_configured_transition(preflight, stop, deploy, reblock):
    # A live configured wallet may hold the publisher's sole connection.
    try:
        stop()
        preflight()
        return deploy()
    except BaseException:
        reblock()
        raise


def renewal_request(request, renewal, now_ms):
    require(isinstance(renewal,dict) and set(renewal) == {'protocol','transitionId',
        'originalRequestSha256','journalSha256','authorizationRef','deadlineAtMs'}, 'exact_renewal_fields')
    require(renewal['protocol'] == 'address-only-configured-renewal-v1'
        and renewal['transitionId'] == request['transitionId']
        and renewal['originalRequestSha256'] == sha(encode(request))
        and isinstance(renewal['journalSha256'],str) and re.fullmatch('[a-f0-9]{64}',renewal['journalSha256'])
        and isinstance(renewal['authorizationRef'],str) and 0 < len(renewal['authorizationRef']) <= 512
        and not any(ord(c)<32 or ord(c)==127 for c in renewal['authorizationRef']), 'renewal_authorization_changed')
    require(type(renewal['deadlineAtMs']) is int and 0 < renewal['deadlineAtMs']-now_ms <= 240000
        and renewal['deadlineAtMs'] > request['deadlineAtMs'], 'bounded_renewal_deadline')
    return dict(request,deadlineAtMs=renewal['deadlineAtMs'])


def validate_renewal_checkpoint(original_request, renewal, raw):
    require(sha(raw) == renewal['journalSha256'], 'renewal_journal_changed')
    state=json.loads(raw)
    require(state.get('phase') in RECOVERABLE_PHASES
        and state.get('transitionSha256') == sha(encode(original_request))
        and state.get('transitionId') == original_request['transitionId'], 'renewal_checkpoint_refused')
    return state


def finish_pending_reblock(journal, adapter):
    if journal.state['phase'] in RECOVERABLE_PHASES and journal.state['phase'] != 'BLOCKED':
        adapter.check()
        journal.state['phase']='REBLOCK_REQUIRED'
        journal.save()
        # Replay the complete idempotent write-ahead sequence, including reload and stop.
        adapter.reblock()
        adapter.check()
        journal.state['phase']='BLOCKED'
        journal.save()


def activate(base, controller, config, request, renewal=None, *, source_origin_capability=None):
    require(os.geteuid() == 0 and os.uname().sysname == 'Linux', 'native_root_linux_required')
    require(set(request)-{'configuredOrigin'} == {'protocol','transitionId','authorizationRef','deadlineAtMs','oldState','originalManifest',
        'releaseRoot','releaseSha256','node','deployment','environment','nativeVerifier','resourcePolicy','walletServiceUser'}, 'exact_transition_fields')
    require(request['protocol'] == 'address-only-configured-transition-v1'
            and re.fullmatch('[A-Za-z0-9_-]{1,64}', request['transitionId'])
            and isinstance(request['authorizationRef'],str) and 0 < len(request['authorizationRef']) <= 512, 'explicit_operator_authorization_required')
    original_request=copy.deepcopy(request)
    original_request_sha=sha(encode(original_request))
    now = int(time.time()*1000)
    if renewal is not None:
        request=renewal_request(original_request,renewal,now)
    require(type(request['deadlineAtMs']) is int and 0 < request['deadlineAtMs']-now <= 240000, 'bounded_transition_deadline')
    policy = dict(base.WAITING_POLICY, mode='configured')
    require(request['resourcePolicy'] == policy, 'explicit_configured_resource_policy_required')
    origin_account = pwd.getpwnam('address-radar')
    wallet_account = resolve_wallet_identity(request['walletServiceUser'],origin_account)
    # ACL tooling is required before any service is stopped, not discovered after guard release.
    for tool in ('/usr/bin/setfacl','/usr/bin/getfacl'):
        base.protected_parent(Path(tool))
        info=os.stat(tool)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
            and os.access(tool,os.X_OK), 'wallet_socket_acl_tool_unavailable')
    def pinned(pin):
        base.protected_parent(Path(pin['path']))
        return read_pin(pin, sealed=False)
    old = json.loads(pinned(request['oldState']))
    isolated_target = configured_isolated_target(base, controller, config, old)
    if isolated_target is None:
        config = controller.validate_config(config)
    else:
        base._isolated_config(controller, config, Path(base._isolated_target(isolated_target)['scope']))
    isolated_kwargs = {'isolated_target': isolated_target} if isolated_target is not None else {}
    original_raw = pinned(request['originalManifest']); original = json.loads(original_raw)
    require(old.get('phase') == 'COMPLETE' and old.get('receipt',{}).get('sourceMonitoring') == 'waiting_configuration'
            and old.get('operationId') == original['operationId'] == config['operationId']
            and old.get('manifestSha256') == sha(encode(original)), 'completed_waiting_origin_required')
    configured_origin=request.get('configuredOrigin')
    origin_state,origin_receipt=old,None
    if 'configuredOrigin' in request:
        require(isinstance(configured_origin,dict) and set(configured_origin)-{'degradedRecovery','restoredRecovery'} == {'journal','receipt','releaseRoot','node'}, 'configured_origin_fields')
        origin_state=json.loads(pinned(configured_origin['journal']))
        origin_receipt=json.loads(pinned(configured_origin['receipt']))
        validate_configured_origin(configured_origin,origin_state,origin_receipt,original,request)
    manifest = derive_manifest(original, request['releaseSha256'])
    deployment = json.loads(pinned(request['deployment']))
    environment = json.loads(pinned(request['environment']))
    require(deployment.get('cutover') == {'addressOnly':manifest} and deployment.get('releaseRoot') == request['releaseRoot']
            and deployment.get('operationId') == original['operationId'] and deployment.get('generationId') == original['generationId']
            and deployment.get('cohortId') == original['importId'] and isinstance(deployment.get('sources'),dict)
            and 'mode' not in deployment['sources'] and deployment.get('wallet') and deployment.get('composition')
            and all(deployment.get(key) is False for key in SAFETY)
            and isinstance(environment,dict) and all(environment.get(name)=='false' for name in base.FLAGS), 'configured_deployment_required')
    isolated = base._isolated_target(isolated_target) if isolated_target is not None else None
    if isolated is not None:
        scope = Path(isolated['scope'])
        isolated_transition_scope(base, scope, request, deployment, environment)
        isolated_transition_binding(isolated, original, old['measurement']['binding'])
        authority_pin = {'path': environment.get('ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE'),
                         'sha256': environment.get('ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256')}
        require(isinstance(authority_pin['path'], str), 'configured_isolated_authority_pin')
        authority = json.loads(pinned(authority_pin))
        isolated_transition_scope(base, scope, authority)
    module = controller.load_module('configured_fence', config['fence'])
    if isolated is not None:
        base._isolated_fence_scope(module, scope)

    reconcile = controller.load_module('configured_reconcile', config['reconcile'])
    deadline = module.Deadline((request['deadlineAtMs']-int(time.time()*1000))/1000)
    fence = module.NativeSourceFence.recover(deadline)
    adapter = None
    try:
        require(fence.operation_id == config['operationId'], 'operation_changed')
        if isolated is not None:
            isolated_transition_binding(base._isolated_target(isolated_target), original, fence.state['binding'])
            require(old['measurement']['binding'] == fence.state['binding'], 'original_binding_changed')
        with reconcile.reconcile_import(fence.state['binding'], deadline) as outcome:
            fence._validate_outcome(outcome, fence.state['binding'])
            require(outcome.get('committedMatches') is True and outcome.get('importExists') is True, 'original_commit_required')
            with fence._recovery_guard(outcome):
                check = fence._check_recovery_guard
                require(old['measurement']['binding'] == fence.state['binding'], 'original_binding_changed')
                output = Path(config['outputDirectory'])
                path = output/('configured-'+request['transitionId']+'-state.json')
                if configured_origin is not None:
                    # Recheck immutable origin inputs under the retained recovery lock.
                    require(json.loads(pinned(configured_origin['journal'])) == origin_state
                        and json.loads(pinned(configured_origin['receipt'])) == origin_receipt, 'configured_origin_changed')
                    require(origin_state['measurement']['binding'] == old['measurement']['binding'], 'configured_origin_commit_changed')
                initial = copy.deepcopy(origin_state)
                initial.update(phase='ORIGIN', pending=None, transitionId=request['transitionId'],
                    authorizationRef=request['authorizationRef'], transitionSha256=original_request_sha,
                    walletServiceUser=copy.deepcopy(request['walletServiceUser']),
                    oldManifestSha256=sha(original_raw), newManifestSha256=sha(encode(manifest)),
                    oldReleaseSha256=origin_receipt['releaseSha256'] if configured_origin is not None else original['releaseSha256'],
                    configuredOrigin=copy.deepcopy(configured_origin), deploymentSha256=deployment_publication(deployment)[1])
                initial.pop('receipt',None)
                initial.pop('recoveryRenewal',None)
                # The old manifest, state and receipt are never publication targets.
                initial['artifacts'] = {p:v for p,v in initial['artifacts'].items() if p.endswith('.conf')}
                if renewal is not None:
                    base.protected_parent(path)
                    checkpoint=read_pin({'path':str(path),'sha256':renewal['journalSha256']},sealed=False)
                    validate_renewal_checkpoint(original_request,renewal,checkpoint)
                journal = base.ActivationJournal(path, initial, check)
                require(journal.state.get('transitionSha256') == original_request_sha, 'resume_authorization_changed')
                if renewal is not None:
                    require(journal.state == json.loads(checkpoint),'renewal_journal_changed')
                    journal.state['recoveryRenewal']=copy.deepcopy(renewal)
                    journal.save()
                adapter = adapter_type(base)(controller, config, {}, module, fence, journal, request['releaseRoot'], request['node']['path'], **isolated_kwargs)
                adapter.directory = (Path(base._isolated_target(isolated_target)['scope'])/'runtime'
                                     if isolated_target is not None else Path('/etc/address-radar'))/('configured-'+request['transitionId'])
                adapter.wallet_account, adapter.wallet_group = wallet_account, request['walletServiceUser']['group']
                finish_pending_reblock(journal,adapter)
                authority_pin = {'path':environment.get('ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE'),
                                 'sha256':environment.get('ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256')}
                base.protected_parent(Path(authority_pin['path']))
                authority_config=json.loads(read_pin(authority_pin,sealed=False))
                adapter.wallet_authority_sources=[authority_pin,authority_config['credential'],authority_config['privateKey']]
                adapter.wallet_authority_pins=journal.state.get('walletAuthorityPins',[])
                for material in adapter.wallet_authority_sources:
                    base.protected_parent(Path(material['path']))
                    read_pin(material,sealed=False)
                if journal.state['phase'] == 'ORIGIN':
                    origin_journal=type('OriginJournal',(),{'state':origin_state})()
                    if configured_origin is not None:
                        origin_adapter=adapter_type(base)(controller,config,{},module,fence,origin_journal,
                            configured_origin['releaseRoot'],configured_origin['node']['path'], **isolated_kwargs)
                        origin_adapter.directory=(Path(base._isolated_target(isolated_target)['scope'])/'runtime'
                            if isolated_target is not None else Path('/etc/address-radar'))/('configured-'+origin_state['transitionId'])
                        origin_adapter.wallet_account,origin_adapter.wallet_group=wallet_account,request['walletServiceUser']['group']
                        origin_adapter.wallet_authority_pins=origin_state.get('walletAuthorityPins',[])
                        observation=verify_source_origin_boundary(source_origin_capability, original_request, origin_state, origin_receipt, origin_adapter,
                            lambda: verify_configured_origin_live(base,origin_adapter,configured_origin,original,origin_receipt,check))
                        adapter.state['originObservation']=observation
                        journal.save()
                    else:
                        origin_adapter=base.NativeActivation(controller,config,{},module,fence,origin_journal,old['releaseRoot'],old['nodePath'], **isolated_kwargs)
                        observation=verify_source_origin_boundary(source_origin_capability, original_request, origin_state, old['receipt'], origin_adapter, origin_adapter.verify_ready)
                        if source_origin_capability is not None:
                            adapter.state['originObservation']=observation
                            journal.save()
                        for service in base.SERVICES:
                            require(origin_adapter.unit(service).get('User') == origin_account.pw_name, 'origin_unit_identity_changed')
                    adapter.check()
                # Inherited reblock must not replace the old activation receipt.
                require(str(output/'activation-receipt.json') not in adapter.state['artifacts'], 'immutable_receipt_target')
                adapter.source_safe()
                node_pin,_ = base.sealed_file(Path(request['node']['path']),128*1024**2,check)
                require(node_pin['sha256']==request['node']['sha256'], 'node_pin_changed')
                inventory = base.release_inventory(request['releaseRoot'],check)
                require(inventory['releaseSha256']==request['releaseSha256'] and deployment.get('execution')==
                    {'maximumEntries':inventory['entries'],'maximumBytes':inventory['bytes']}, 'new_inventory_binding')
                verifier,_ = base.sealed_file(Path(request['nativeVerifier']['path']),128*1024**2,check)
                require(verifier['sha256']==request['nativeVerifier']['sha256'], 'native_verifier_pin_changed')
                adapter.managed(output/('configured-'+request['transitionId']+'-probe.json'), encode(request))
                probe_path = output/('configured-'+request['transitionId']+'-probe.json')
                def preflight():
                    remaining = request['deadlineAtMs']-int(time.time()*1000)
                    require(remaining>0, 'transition_expired')
                    proof = execute_native_preflight(base, controller, request['nativeVerifier'], request['node']['path'],
                        probe_path, sha(encode(request)), check, remaining)
                    adapter.state['nativePreflight']=proof
                    adapter.state['nativePreflightInputSha256']=sha(encode(request))
                    journal.save()
                def block():
                    journal.state['phase']='REBLOCK_REQUIRED'; journal.save()
                    adapter.reblock(); journal.state['phase']='BLOCKED'; journal.save()
                def deploy():
                    require(int(time.time()*1000)<adapter.state['nativePreflight']['expiresAtMs'], 'preflight_expired_before_deploy')
                    adapter.state.update(node=node_pin,release=inventory,configuredReleaseRoot=request['releaseRoot'],
                        configuredNodePath=request['node']['path'],bootId=adapter.host()['bootId'])
                    journal.save()
                    adapter.prepare_configured(request,manifest,deployment,environment)
                    return base.activate_units(journal,adapter)
                transition=perform_configured_transition if configured_origin is not None else perform_transition
                return transition(preflight,block,deploy,block)
    finally:
        try:
            if adapter and adapter.listener:
                adapter.listener.close()
        finally:
            fence.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('activation','activation-sha256','controller','controller-sha256','config','config-sha256','request','request-sha256'):
        parser.add_argument('--'+key,required=True)
    parser.add_argument('--renewal')
    parser.add_argument('--renewal-sha256')
    args=parser.parse_args()
    require(bool(args.renewal)==bool(args.renewal_sha256),'renewal_pin_pair_required')
    require(os.geteuid()==0,'root_required')
    # Bootstrap trust is rooted in the explicitly pinned, immutable activation module.
    pin={'path':args.activation,'sha256':args.activation_sha256}
    for parent in Path(args.activation).parents:
        info=parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not info.st_mode&0o022,'unsafe_bootstrap_parent')
    raw=read_pin(pin)
    spec=importlib.util.spec_from_file_location('configured_activation_base',args.activation)
    base=importlib.util.module_from_spec(spec); spec.loader.exec_module(base)
    controller=load_sealed(base,'configured_controller',{'path':args.controller,'sha256':args.controller_sha256})
    config=json.loads(controller.pinned_read({'path':args.config,'sha256':args.config_sha256},65536))
    base.protected_parent(Path(args.request))
    request=json.loads(read_pin({'path':args.request,'sha256':args.request_sha256}, sealed=False))
    renewal=None
    if args.renewal:
        base.protected_parent(Path(args.renewal))
        renewal=json.loads(read_pin({'path':args.renewal,'sha256':args.renewal_sha256},sealed=False))
    print(json.dumps(activate(base,controller,config,request,renewal)))


if __name__=='__main__':
    try:
        main()
    except Exception:
        print('{"status":"configured-transition-refused-or-recovery-required","databaseRollbackAuthorized":false,"gatewayDeliveryEnabled":false}')
        raise SystemExit(1)
