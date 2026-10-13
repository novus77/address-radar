#!/usr/bin/env python3
"""Persistent PG acquisition fence. No SQLite, DB, RPC, credential or activation writes."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import time

SERVICES = ('scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console')
CONTROL_LOCK = Path('/var/lib/address-radar-address-only-cutover/controller.lock')
TOOLS = Path('/var/lib/address-radar-maintenance-tools')
GUARD_NAME = 'zzzzzz-address-radar-pg-source-fence.conf'
MAX_BYTES = 1048576


def require(value, code):
    if not value:
        raise ValueError(code)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp(info):
    # Reading may update atime; identity/content/permissions must not change.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid,
            info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def guard_file_identity(path, info, sha256):
    return {'path': str(path), 'device': info.st_dev, 'inode': info.st_ino,
            'size': info.st_size, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'mtimeNs': info.st_mtime_ns,
            'ctimeNs': info.st_ctime_ns, 'sha256': sha256}


def read_guard_identity(path, body):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size == len(body), 'pg_guard_changed')
        raw = stream.read(len(body) + 1)
        after = os.fstat(stream.fileno())
    require(stamp(before) == stamp(after) == stamp(path.lstat()) and raw == body, 'pg_guard_changed')
    return guard_file_identity(path, before, digest(raw))


def durable(path, raw):
    require(len(raw) <= MAX_BYTES, 'file_budget')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
        created = os.fstat(stream.fileno())
        sync(path.parent)
        require(stamp(created) == stamp(os.fstat(stream.fileno())) == stamp(path.lstat()),
                'created_file_changed')
        return guard_file_identity(path, created, digest(raw))


def private_path(path, directory=False, owners=(0,), publication=False):
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'path_not_canonical')
    for parent in path.parents:
        s = parent.lstat()
        require(stat.S_ISDIR(s.st_mode) and s.st_uid in owners and not s.st_mode & 0o022, 'unsafe_parent')
    s = path.lstat()
    require(s.st_uid in owners and not s.st_mode & (0o022 if publication else 0o077) and
            (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1), 'unsafe_private_path')


def pinned(pin, owners=(0,), publication=False):
    require(isinstance(pin, dict) and set(pin) == {'path', 'sha256'} and
            re.fullmatch('[a-f0-9]{64}', pin['sha256']), 'invalid_pin')
    path = Path(pin['path'])
    private_path(path, owners=owners, publication=publication)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
    require(stamp(before) == stamp(after) == stamp(path.lstat()) and len(raw) == before.st_size <= MAX_BYTES
            and digest(raw) == pin['sha256'], 'pin_changed')
    return raw


def pid_start(pid):
    return (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]


class Native:
    def __init__(self, request):
        require(sys.platform == 'linux' and os.geteuid() == 0, 'native_root_required')
        self.lock_path = CONTROL_LOCK
        self.directory = TOOLS / ('pg-source-fence-' + request['operationId'])
        self.sentinel = TOOLS / 'pg-source-acquisition-blocked'
        self.ends = time.monotonic() + min(240, (request['deadlineAtMs'] - self.clock()) / 1000)

    def clock(self): return int(time.time() * 1000)
    def monotonic_ms(self): return int(time.monotonic() * 1000)
    def boot_id(self): return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

    def check(self):
        require(time.monotonic() < self.ends, 'deadline')

    def command(self, args):
        self.check()
        return subprocess.check_output(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=min(5, self.ends - time.monotonic()), env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True).decode()

    def validate(self, request):
        private_path(self.lock_path)
        require(0 < request['deadlineAtMs'] - self.clock() <= 240000, 'deadline')
        for unit in SERVICES:
            directory = self.guard_path(unit).parent
            # Existing unit drop-in directories are required, never create/replace unit files.
            s = directory.lstat()
            require(stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022, 'unsafe_guard_parent')
            for parent in directory.parents:
                p = parent.lstat()
                require(stat.S_ISDIR(p.st_mode) and p.st_uid == 0 and not p.st_mode & 0o022, 'unsafe_guard_parent')

    def guard_path(self, service):
        return Path('/etc/systemd/system') / ('address-radar-' + service + '.service.d') / GUARD_NAME

    def unit(self, service):
        raw = self.command(['/usr/bin/systemctl', 'show', 'address-radar-' + service + '.service',
            '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState', '-p', 'ControlGroup', '-p', 'User',
            '-p', 'InvocationID', '-p', 'FragmentPath', '-p', 'Job', '-p', 'DropInPaths', '-p', 'ExecStartPre', '-p', 'EnvironmentFiles', '-p', 'ExecStart'])
        return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)

    def reload(self): self.command(['/usr/bin/systemctl', 'daemon-reload'])
    def stop(self, service): self.command(['/usr/bin/systemctl', 'stop', '--no-block', 'address-radar-' + service + '.service'])
    def remove_guard(self, service):
        self.guard_path(service).unlink()
        sync(self.guard_path(service).parent)

    def release(self):
        self.sentinel.unlink()
        sync(self.sentinel.parent)

    def verify_guards(self, body):
        for service in SERVICES:
            path = self.guard_path(service)
            private_path(path)
            require(path.read_bytes() == body, 'guard_changed')
            unit = self.unit(service)
            paths = unit.get('DropInPaths', '').split()
            require(str(path) in paths and not any(Path(p).name > GUARD_NAME for p in paths), 'guard_not_last')
            require('/usr/bin/test' in unit.get('ExecStartPre', '') and str(self.sentinel) in unit['ExecStartPre'], 'guard_not_effective')

    def physical(self, recorded, *, expected_users=None):
        if expected_users is not None:
            require(type(expected_users) is dict and set(expected_users) == set(SERVICES)
                    and all(type(value) is str and value for value in expected_users.values()),
                    'published_service_identity_shape')
        users = set()
        for service in SERVICES:
            unit = self.unit(service)
            require(unit.get('MainPID') == '0' and unit.get('ActiveState') in ('inactive', 'failed')
                    and unit.get('SubState') in ('dead', 'failed') and not unit.get('Job', '').strip(), 'unit_not_exited')
            old = recorded[service]
            account = pwd.getpwnam(old['User'])
            expected = old['User'] if expected_users is None else expected_users[service]
            current = pwd.getpwnam(expected)
            require(account.pw_uid > 0 and current.pw_uid > 0 and unit.get('User') == expected,
                    'service_identity_changed')
            users.add(account.pw_uid)
            # Changing a published identity must never hide an old acquisition process.
            users.add(current.pw_uid)
            group = old.get('ControlGroup', '')
            require(group.startswith('/system.slice/address-radar-') and '..' not in group and '\n' not in group, 'cgroup_identity')
            path = Path('/sys/fs/cgroup') / group.lstrip('/')
            if path.exists():
                fields = dict(line.split() for line in (path / 'cgroup.events').read_text().splitlines())
                require(fields.get('populated') == '0', 'cgroup_populated')
        pids = [p for p in Path('/proc').iterdir() if p.name.isdecimal()]
        require(len(pids) <= 8192, 'process_budget')
        for path in pids:
            self.check()
            try:
                fields = dict(line.split(':', 1) for line in (path / 'status').read_text().splitlines() if ':' in line)
                require(not users.intersection(int(x) for x in fields['Uid'].split()), 'processes_remain')
            except FileNotFoundError:
                continue

    def verify_publication(self, request):
        # Require actual live EnvironmentFile identities, not a candidate-only JSON claim.
        files = request['publishedFiles']
        require(isinstance(files, list) and 6 <= len(files) <= 32, 'published_binding')
        # Configured runtime JSON can be service-owned read-only, unlike root-private
        # job inputs. Accept only the actual six bound service accounts, never arbitrary UIDs.
        owners = {0}
        for service in SERVICES:
            account = pwd.getpwnam(self.unit(service)['User'])
            require(account.pw_uid > 0, 'service_identity_changed')
            owners.add(account.pw_uid)
        bodies = {p['path']: pinned(p, owners=owners, publication=True) for p in files}
        require(len(bodies) == len(files), 'published_binding')
        combined = b'\n'.join(bodies.values())
        from urllib.parse import urlsplit
        require(request['oldProviderId'].encode() not in combined and
                request['oldOrigin'].encode() not in combined and
                urlsplit(request['oldOrigin']).hostname.encode() not in combined and
                request['newProviderId'].encode() in combined and request['newOrigin'].encode() in combined, 'old_reference_or_new_binding')
        for service in SERVICES:
            unit = self.unit(service)
            environment = unit.get('EnvironmentFiles', '')
            matched = [p for p in bodies if environment == p + ' (ignore_errors=no)']
            require(len(matched) == 1, 'published_binding')
            text = bodies[matched[0]].decode('ascii')
            require(request['oldProviderId'] not in unit.get('ExecStart', '') and
                    request['oldOrigin'] not in unit.get('ExecStart', ''), 'old_exec_reference')
            # Parse only generator-produced KEY=JSON-string records, never shell evaluation.
            values = {}
            for line in text.splitlines():
                key, sep, value = line.partition('=')
                require(sep and key not in values and re.fullmatch('[A-Z][A-Z0-9_]*', key), 'environment_format')
                values[key] = json.loads(value)
            material_keys = ['ADDRESS_RADAR_POSTGRES_DEPLOYMENT', 'ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT']
            authority_key = 'ADDRESS_RADAR_POSTGRES_AUTHORITY'
            if service == 'wallet-monitor':
                material_keys.append(authority_key)
            else:
                require(authority_key + '_FILE' not in values and authority_key + '_SHA256' not in values,
                        'unexpected_service_authority')
            for key in material_keys:
                name = values.get(key + '_FILE')
                require(name in bodies and values.get(key + '_SHA256') == digest(bodies[name]), 'published_material_pin')
            require(values.get('RADAR_RPC_SOLANA_HTTP_URL') == request['newOrigin'], 'published_source_binding')
            deployment = json.loads(bodies[values['ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE']])
            settings = json.loads(bodies[values['ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE']])
            require(deployment.get('generationId') == request['generationId'], 'generation_changed')
            if service == 'wallet-monitor':
                authority = json.loads(bodies[values[authority_key + '_FILE']])
                require(authority.get('generationId') == request['generationId'], 'generation_changed')
                bindings = [b for b in authority['validator']['reviewedProviderBindings'] if b.get('chain') == 'solana']
                require(len(bindings) == 1 and bindings[0]['sourceProviderId'] == request['newProviderId']
                    and bindings[0]['sourceEndpoint'] == request['newOrigin']
                    and bindings[0]['replayProviderId'] != request['newProviderId']
                    and bindings[0]['replayEndpoint'] == 'https://api.mainnet-beta.solana.com', 'published_provider_pair')
            source = deployment['walletExecution']['solana']
            require(source.get('providerId') == request['newProviderId'] and source.get('endpoint') == request['newOrigin'], 'published_producer_binding')
            contracts = [c for c in settings['providerContracts'] if c.get('providerId') == request['newProviderId']]
            require(len(contracts) == 1 and contracts[0].get('origin') == request['newOrigin']
                and contracts[0].get('windowMs') == 60000 and contracts[0].get('maximumRequests') == 60
                and contracts[0].get('maximumConcurrency') == 1, 'published_provider_budget')
            require(all(deployment.get(k) is False for k in
                ('gatewayDeliveryEnabled', 'fomoEnabled', 'fullHistoricalMiningEnabled'))
                and 'priceAcquisition' not in deployment, 'safety_changed')
            for flag in ('ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED', 'ADDRESS_RADAR_FOMO_BROWSER_ENABLED',
                         'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED'):
                require(values.get(flag) == 'false', 'safety_changed')
        return {'sha256': digest(encode(files))}

    def owner_lock(self, fd, state, observer=False):
        private_path(self.lock_path)
        require(os.fstat(fd).st_ino == self.lock_path.stat().st_ino, 'controller_lock_replaced')
        pid = state['ownerPid']
        require(pid_start(pid) == state['ownerStart'], 'owner_changed')
        info = os.fstat(fd)
        identity = '%02x:%02x:%d' % (os.major(info.st_dev), os.minor(info.st_dev), info.st_ino)
        locks = Path('/proc/locks').read_text().splitlines()
        require(any(len(parts) >= 6 and parts[1:4] == ['FLOCK', 'ADVISORY', 'WRITE']
                    and parts[4] == str(pid) and parts[5] == identity for parts in (line.split() for line in locks)), 'controller_lock_not_held')
        if not observer:
            require(pid == os.getpid(), 'owner_changed')


class PgSourceFence:
    def __init__(self, native, request):
        self.n, self.request, self.fd = native, request, None
        require(isinstance(request, dict) and set(request) == {'protocol', 'operationId', 'replacementSha256',
            'generationId', 'oldProviderId', 'oldOrigin', 'newProviderId', 'newOrigin', 'authorizationRef',
            'deadlineAtMs', 'publishedFiles'} and request.get('protocol') == 'address-only-pg-source-fence-v1'
            and re.fullmatch('[A-Za-z0-9_-]{1,64}', request.get('operationId', ''))
            and re.fullmatch('[a-f0-9]{64}', request.get('replacementSha256', ''))
            and isinstance(request.get('authorizationRef'), str) and 0 < len(request['authorizationRef']) <= 512
            and request.get('oldProviderId') != request.get('newProviderId')
            and request.get('newOrigin') == 'https://solana-rpc.publicnode.com', 'invalid_request')
        require(type(request['deadlineAtMs']) is int and all(isinstance(request[k], str) and
            re.fullmatch('[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', request[k])
            for k in ('generationId', 'oldProviderId', 'newProviderId'))
            and isinstance(request['oldOrigin'], str) and
            re.fullmatch(r'https://[^/@?#\s]+', request['oldOrigin']), 'invalid_request')
        self.request_sha = digest(encode(request))
        # Only a fresh bounded deadline and reviewed publication pins may change on
        # recovery. Generation/source/replacement identity must remain identical.
        self.binding_sha = digest(encode({k: v for k, v in request.items() if k not in ('deadlineAtMs', 'publishedFiles')}))
        # PID1 evaluates the condition as root. An unprivileged `test ! -e`
        # alone would incorrectly pass when a root-private ancestor denies access.
        self.body = ('[Unit]\nConditionPathExists=!' + str(native.sentinel)
            + '\n[Service]\nExecStartPre=+/usr/bin/test ! -e ' + str(native.sentinel) + '\n').encode()

    def __enter__(self):
        self.n.validate(self.request)
        self.fd = os.open(self.n.lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try: fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: raise ValueError('controller_busy') from None
            os.set_inheritable(self.fd, False)
            self._fresh_owner = not self.n.directory.exists()
            if self.n.directory.exists():
                if isinstance(self.n, Native):
                    private_path(self.n.directory, directory=True)
                    private_path(self.n.directory / 'state.json')
                self.state = json.loads((self.n.directory / 'state.json').read_bytes())
                require(self.state['bindingSha256'] == self.binding_sha and self.state['phase'] != 'HANDED_OFF', 'operation_conflict')
            else:
                self.n.directory.mkdir(mode=0o700)
                sync(self.n.directory.parent)
                self.state = {'protocol': self.request['protocol'], 'requestSha256': self.request_sha,
                    'initialRequestSha256': self.request_sha, 'bindingSha256': self.binding_sha,
                    'replacementSha256': self.request['replacementSha256'], 'phase': 'PREPARED',
                    'bootId': self.n.boot_id(), 'guardIdentities': {}, 'recorded': {s: self.n.unit(s) for s in SERVICES}}
            self.state.update(ownerPid=os.getpid(), ownerStart=pid_start(os.getpid()) if sys.platform == 'linux' else 'fixture', requestSha256=self.request_sha)
            self.save()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        # Never unguard, start services or remove the sentinel on failure/close.

    def save(self):
        path = self.n.directory / 'state.next'
        if path.exists():
            require(path.is_file() and not path.is_symlink(), 'unsafe_journal_scratch')
            path.unlink()
        durable(path, encode(self.state))
        os.replace(path, self.n.directory / 'state.json')
        sync(self.n.directory)

    def owned(self):
        require(self.fd is not None, 'controller_lock_not_held')
        if hasattr(self.n, 'owner_lock'):
            self.n.owner_lock(self.fd, self.state, getattr(self, 'observer', False))
        require(json.loads((self.n.directory / 'state.json').read_bytes()) == self.state, 'journal_changed')

    def verify_guard_identities(self):
        self.owned()
        records = self.state.get('guardIdentities')
        require(isinstance(records, dict) and set(records) == set(SERVICES), 'pg_guard_identity_unavailable')
        for service in SERVICES:
            require(read_guard_identity(self.n.guard_path(service), self.body) == records[service], 'pg_guard_changed')
        self.owned()

    def record_source_origin(self, snapshot, *, artifact_identities):
        """Persist trusted live capture, never mint a capability from recovery JSON."""
        self.owned()
        require(getattr(self, '_fresh_owner', False) and self.state['phase']=='PREPARED'
                and 'sourceOrigin' not in self.state and self.state['bootId']==self.n.boot_id(), 'source_origin_capture')
        fields={'protocol','transitionSha256','operationId','generationId','binding','oldState','originalManifest',
                'configuredOrigin','originStateSha256','originReceiptSha256','sourceJournalSha256',
                'measurementSha256','artifacts','services'}
        require(isinstance(snapshot,dict) and set(snapshot)==fields
                and snapshot['protocol']=='address-only-source-origin-observation-v1'
                and snapshot['generationId']==self.request['generationId']
                and all(isinstance(snapshot[key],str) and re.fullmatch('[a-f0-9]{64}',snapshot[key])
                    for key in ('transitionSha256','originStateSha256','originReceiptSha256','sourceJournalSha256','measurementSha256'))
                and isinstance(snapshot['services'],dict) and set(snapshot['services'])==set(SERVICES)
                and isinstance(snapshot['artifacts'],dict) and isinstance(artifact_identities,dict)
                and 0<len(artifact_identities)<=512, 'source_origin_capture')
        for service in SERVICES:
            old=self.state['recorded'][service];live=self.n.unit(service)
            item=snapshot['services'][service];ready=item['ready']
            require(isinstance(ready,dict) and type(ready.get('mainPid')) is int and ready['mainPid']>1
                    and str(ready['mainPid'])==old.get('MainPID')==live.get('MainPID')
                    and ready.get('invocationId')==old.get('InvocationID')==live.get('InvocationID')
                    and bool(ready.get('invocationId')) and live.get('ActiveState')=='active'
                    and item['unit']=={key:live.get(key) for key in ('MainPID','InvocationID','ControlGroup','User')}
                    and all(live.get(key)==old.get(key) for key in ('User','ControlGroup','FragmentPath','EnvironmentFiles','DropInPaths')),
                    'source_origin_capture_identity')
        record={'snapshot':json.loads(encode(snapshot)), 'artifactIdentities':json.loads(encode(artifact_identities)),
            'operationId':self.request['operationId'],'generationId':self.request['generationId'],
            'requestSha256':self.request_sha,'bindingSha256':self.binding_sha,
            'ownerPid':self.state['ownerPid'],'ownerStart':self.state['ownerStart'],'bootId':self.state['bootId']}
        self.state['sourceOrigin']=record
        self.save()
        self._source_origin_raw=encode(record)
        self._source_origin_token=object()
        self.owned()
        return self._source_origin_token

    def source_origin_record(self, token):
        self.owned()
        require(token is getattr(self,'_source_origin_token',None) and token is not None
                and getattr(self,'_fresh_owner',False), 'source_origin_capability')
        record=self.state.get('sourceOrigin')
        require(isinstance(record,dict) and encode(record)==self._source_origin_raw
                and record['ownerPid']==self.state['ownerPid'] and record['ownerStart']==self.state['ownerStart']
                and record['operationId']==self.request['operationId'] and record['generationId']==self.request['generationId']
                and record['requestSha256']==self.request_sha and record['bindingSha256']==self.binding_sha,
                'source_origin_journal_changed')
        require(record['bootId']==self.state['bootId']==self.n.boot_id(),'source_origin_boot_changed')
        return json.loads(self._source_origin_raw)

    def block(self):
        self.owned()
        records = self.state.get('guardIdentities')
        require(isinstance(records, dict) and set(records).issubset(SERVICES), 'pg_guard_identity_unavailable')
        self.state['phase'] = 'BLOCKING'
        self.save()
        if not self.n.sentinel.exists(): durable(self.n.sentinel, encode({'replacementSha256': self.request['replacementSha256']}))
        require(self.n.sentinel.read_bytes() == encode({'replacementSha256': self.request['replacementSha256']}), 'sentinel_changed')
        for service in SERVICES:
            path = self.n.guard_path(service)
            if service not in records:
                require(not os.path.lexists(path), 'pg_guard_identity_unavailable')
                # Mint from the exclusive creation FD, never adopt a path observed later.
                records[service] = durable(path, self.body)
                self.save()
            require(read_guard_identity(path, self.body) == records[service], 'pg_guard_changed')
        self.n.reload()
        self.n.verify_guards(self.body)
        for service in SERVICES: self.n.stop(service)
        end = self.n.monotonic_ms() + 20000
        while True:
            try:
                self.n.physical(self.state['recorded'])
                break
            except ValueError:
                require(self.n.monotonic_ms() < end, 'physical_drain_timeout')
                time.sleep(0.1)
        self.n.verify_guards(self.body)
        self.verify_guard_identities()
        self.state.update(phase='FENCED', stoppedAtMs=self.n.clock(), stoppedMonotonicMs=self.n.monotonic_ms(), bootId=self.n.boot_id())
        self.save()

    def measure(self, *, expected_users=None):
        self.owned()
        require(self.state['phase'] == 'FENCED', 'not_fenced')
        self.verify_guard_identities()
        require(self.state['bootId'] == self.n.boot_id(), 'boot_changed')
        require(self.n.sentinel.read_bytes() == encode({'replacementSha256': self.request['replacementSha256']}), 'sentinel_changed')
        self.n.verify_guards(self.body)
        if expected_users is None:
            self.n.physical(self.state['recorded'])
        else:
            self.n.physical(self.state['recorded'], expected_users=expected_users)
        now = self.n.clock()
        require(now >= self.state['stoppedAtMs'] + 60000 and
                self.n.monotonic_ms() >= self.state['stoppedMonotonicMs'] + 60000, 'full_window')
        self.owned()
        return {'protocol': 'address-only-pg-source-fence-proof-v1', 'replacementSha256': self.request['replacementSha256'],
            'journalSha256': digest(encode(self.state)), 'bootId': self.state['bootId'], 'measuredAtMs': now,
            'stoppedAtMs': self.state['stoppedAtMs'], 'controllerLockHeld': True, 'acquisitionsBlocked': True,
            'processesExited': True, 'cgroupsEmpty': True, 'pendingRequestCount': 0, 'servicesActivated': False}

    def handoff(self):
        self.measure()
        publication = self.n.verify_publication(self.request)
        self.state.update(phase='HANDOFF_INTENT', publication=publication)
        self.save()
        try:
            # Keep the permanent guards installed. Removing guards first would open
            # a timer/dependency start race before publication verification completes.
            self.n.verify_guards(self.body)
            self.n.physical(self.state['recorded'])
            require(self.n.verify_publication(self.request) == publication, 'publication_changed')
            self.verify_guard_identities()
            self.owned()
            self.state['phase'] = 'HANDOFF_VERIFIED'
            self.save()
            self.n.release()
            self.state['phase'] = 'HANDED_OFF'
            self.save()
            receipt = {'phase': 'HANDED_OFF', 'replacementSha256': self.request['replacementSha256'],
                'requestSha256': self.request_sha, 'publication': publication, 'servicesActivated': False, 'databaseWritten': False}
            durable(self.n.directory / 'handoff-receipt.json', encode(receipt))
            return receipt
        except BaseException:
            # Idempotent repair. A partial repair still has a persisted pending journal, never a success receipt.
            if not self.n.sentinel.exists(): durable(self.n.sentinel, encode({'replacementSha256': self.request['replacementSha256']}))
            for service in SERVICES:
                if not self.n.guard_path(service).exists(): durable(self.n.guard_path(service), self.body)
            self.n.reload()
            for service in SERVICES: self.n.stop(service)
            self.state['phase'] = 'BLOCKING'
            self.save()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--request-sha256', required=True)
    parser.add_argument('--mode', choices=('block', 'observe', 'handoff', 'hold-job'), required=True)
    parser.add_argument('--job')
    parser.add_argument('--job-sha256')
    args = parser.parse_args()
    request = json.loads(pinned({'path': args.request, 'sha256': args.request_sha256}))
    native = Native(request)
    if args.mode == 'observe':
        native.validate(request)
        fence = PgSourceFence(native, request)
        private_path(native.directory, directory=True)
        private_path(native.directory / 'state.json')
        fence.state = json.loads((native.directory / 'state.json').read_bytes())
        require(fence.state['requestSha256'] == fence.request_sha, 'operation_conflict')
        fence.fd = os.open(native.lock_path, os.O_RDONLY | os.O_NOFOLLOW)
        fence.observer = True
        try: print(json.dumps(fence.measure()))
        finally: fence.__exit__(None, None, None)
        return
    with PgSourceFence(native, request) as fence:
        fence.block()
        if args.mode == 'block':
            print(json.dumps({'phase': 'FENCED_WINDOW_PENDING', 'servicesActivated': False}))
            return
        while native.monotonic_ms() < fence.state['stoppedMonotonicMs'] + 60000:
            native.check()
            native.verify_guards(fence.body)
            native.physical(fence.state['recorded'])
            time.sleep(0.2)
        proof = fence.measure()
        if args.mode == 'hold-job':
            # The reviewed root-private Python job owns DB/probe permissions; this supervisor never mints them.
            require(args.job and args.job_sha256, 'job_pin_required')
            pinned({'path': args.job, 'sha256': args.job_sha256})
            child = subprocess.Popen(['/usr/bin/python3', '-I', '-B', args.job, args.request, args.request_sha256],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, close_fds=True, start_new_session=True)
            try:
                while child.poll() is None:
                    native.check()
                    fence.measure()
                    time.sleep(0.2)
                require(child.returncode == 0, 'job_failed_or_uncertain')
                proof = fence.measure()
            finally:
                if child.poll() is None:
                    import signal
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
            print(json.dumps(proof))
        else:
            print(json.dumps(fence.handoff()))


if __name__ == '__main__':
    try: main()
    except BaseException:
        print(json.dumps({'status': 'REFUSED_OR_UNCERTAIN_PRESERVE_FENCE', 'retryAuthorized': False,
            'servicesActivated': False, 'databaseWrittenByFence': False}))
        sys.exit(1)
