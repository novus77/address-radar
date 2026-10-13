#!/usr/bin/env python3
"""Pinned configured activation with a borrowed native owner lock and release gate.

No DB/RPC ports are constructed here. Call bind_configured_controller with reviewed
pins and a trusted in-process gate, then binding.activate(request, renewal).
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types


def require(value, code):
    if not value:
        raise ValueError(code)


def native_owner_check(pg, owner, expected_lock):
    """Do not delegate owner identity to an overridable owner.owned callback."""
    expected_lock = Path(expected_lock)

    def check():
        require(owner.fd is not None and not getattr(owner, 'observer', False), 'controller_lock_not_owned')
        require(owner.n.lock_path == expected_lock, 'controller_lock_replaced')
        pg.private_path(expected_lock)
        fd_info, path_info = os.fstat(owner.fd), expected_lock.lstat()
        require((fd_info.st_dev, fd_info.st_ino) == (path_info.st_dev, path_info.st_ino),
                'controller_lock_replaced')
        pg.private_path(owner.n.directory, directory=True)
        pg.private_path(owner.n.directory / 'state.json')
        pg.Native.owner_lock(owner.n, owner.fd, owner.state)
        pg.PgSourceFence.owned(owner)
        pg.Native.owner_lock(owner.n, owner.fd, owner.state)
    return check


def retained_pg_guard_entries(module, pg, owner, check):
    """Admit only the fixed live native PG guard, never caller-supplied names.

    Original journal inventories and anchors stay immutable. The guard remains
    installed even after native handoff releases its sentinel.
    """
    reference, request_raw = None, None

    def entries(unit):
        nonlocal reference, request_raw
        services = {"address-radar-" + service + ".service": service for service in pg.SERVICES}
        if unit not in services:
            return ()
        check()
        pg.Native.check(owner.n)
        if reference is None:
            reference = pg.PgSourceFence(owner.n, owner.request)
            request_raw = pg.encode(owner.request)
        require(pg.encode(owner.request) == request_raw
                and owner.state.get('requestSha256') == reference.request_sha
                and owner.state.get('bindingSha256') == reference.binding_sha
                and owner.state.get('replacementSha256') == reference.request['replacementSha256'],
                'pg_guard_binding_changed')
        require(owner.n.directory == pg.TOOLS / ('pg-source-fence-' + reference.request['operationId'])
                and owner.n.sentinel == pg.TOOLS / 'pg-source-acquisition-blocked'
                and owner.n.lock_path == Path(module.CONTROL) / 'controller.lock', 'pg_guard_scope_changed')
        phase = owner.state.get('phase')
        require(phase in ('BLOCKING', 'FENCED', 'HANDOFF_INTENT', 'HANDOFF_VERIFIED', 'HANDED_OFF')
                and owner.state.get('bootId') == pg.Native.boot_id(owner.n), 'pg_guard_phase_changed')
        if phase == 'HANDED_OFF':
            require(not os.path.lexists(owner.n.sentinel), 'pg_guard_handoff_incomplete')
            receipt = {'phase': 'HANDED_OFF', 'replacementSha256': reference.request['replacementSha256'],
                       'requestSha256': reference.request_sha, 'publication': owner.state['publication'],
                       'servicesActivated': False, 'databaseWritten': False}
            pg.pinned({'path': str(owner.n.directory / 'handoff-receipt.json'),
                       'sha256': pg.digest(pg.encode(receipt))})
        else:
            pg.pinned({'path': str(owner.n.sentinel), 'sha256': pg.digest(pg.encode(
                {'replacementSha256': reference.request['replacementSha256']}))})
        # Reuse the real effective-systemd verifier; no receipt-only guard proof.
        pg.Native.verify_guards(owner.n, reference.body)
        records = owner.state.get('guardIdentities')
        require(isinstance(records, dict) and set(records) == set(pg.SERVICES), 'pg_guard_identity_unavailable')
        for service in pg.SERVICES:
            name = 'address-radar-' + service + '.service'
            path = pg.Native.guard_path(owner.n, service)
            require(path == Path(module.MASK_DIRECTORY) / (name + '.d') / pg.GUARD_NAME,
                    'pg_guard_scope_changed')
            pg.private_path(path)
            actual = module.configuration_stamp(str(path))
            require(actual['mode'] == 0o600 and actual['sha256'] == pg.digest(reference.body)
                    and actual['size'] == len(reference.body), 'pg_guard_changed')
            require(actual == records[service], 'pg_guard_changed')
        check()
        pg.Native.check(owner.n)
        return (pg.GUARD_NAME,)
    return entries


def borrowed_fence_type(module, owner, check, *, pg=None):
    """Retain recovery validation, but never flock or unlock a borrowed OFD."""
    guard_entries = retained_pg_guard_entries(module, pg, owner, check) if pg is not None else None

    class BorrowedFence(module.NativeSourceFence):
        def _controller_guard_entries(self, unit):
            return guard_entries(unit) if guard_entries else super()._controller_guard_entries(unit)

        def _lock_control(self, deadline):
            self.deadline, self.lock = deadline, None
            check()
            fd = os.dup(owner.fd)
            try:
                os.set_inheritable(fd, False)
                self.lock = fd
                self._assert_retained_lock()
                self.journal = module.Journal()
            except BaseException:
                self.lock = None
                os.close(fd)
                raise

        def _assert_retained_lock(self):
            require(self.lock is not None, 'controller_lock_not_held')
            check()
            info = os.fstat(self.lock)
            original = os.fstat(owner.fd)
            path = os.lstat(str(Path(module.CONTROL) / 'controller.lock'))
            module.private_file(info)
            require((info.st_dev, info.st_ino) == (original.st_dev, original.st_ino)
                    == (path.st_dev, path.st_ino), 'controller_lock_replaced')

        def close(self):
            fd, self.lock = getattr(self, 'lock', None), None
            if fd is not None:
                os.close(fd)
    return BorrowedFence


def gated_activation_type(base, owner, owned, gate, transition_id):
    """Gate real controller boundaries; never replace its safety/anchor checks."""
    require(callable(gate), 'source_gate_required')

    class GatedActivation(base.NativeActivation):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._source_gate_complete = False
            self._source_gate_running = False

        def _source_context(self, service):
            owned()
            require(service in base.SERVICES and self.state.get('transitionId') == transition_id
                    and self.state.get('phase') == 'PUBLISHED'
                    and all(self.state.get('units', {}).get(s, {}).get('published') is True
                            for s in base.SERVICES), 'source_gate_not_published')

        def _source_failure(self):
            # Without owner identity, journal or service writes would be unsafe.
            owned()
            self._source_gate_complete = False
            self.state['phase'] = 'REBLOCK_REQUIRED'
            self.journal.save()
            self.reblock()
            self.state['phase'] = 'BLOCKED'
            self.journal.save()

        def unguard(self, service):
            try:
                self._source_context(service)
                require(not getattr(self, '_source_gate_running', False), 'source_gate_incomplete')
                if not getattr(self, '_source_gate_complete', False):
                    self.verify_published()
                    self._source_gate_running = True
                    try:
                        gate(owner, self)
                    finally:
                        self._source_gate_running = False
                    self._source_context(service)
                    self.verify_published()
                    self._source_gate_complete = True
                owned()
                return super().unguard(service)
            except BaseException:
                self._source_failure()
                raise

        def start(self, service):
            try:
                self._source_context(service)
                require(getattr(self, '_source_gate_complete', False)
                        and not getattr(self, '_source_gate_running', False)
                        and all(self.state['units'][s].get('unguarded') is True for s in base.SERVICES),
                        'source_gate_incomplete')
                return super().start(service)
            except BaseException:
                self._source_failure()
                raise
    return GatedActivation


def _pinned_module(name, pin):
    require(type(pin) is dict and set(pin) == {'path', 'sha256'}
            and type(pin['path']) is str and type(pin['sha256']) is str
            and re.fullmatch('[a-f0-9]{64}', pin['sha256']), 'invalid_pin')
    path = Path(pin['path'])
    require(path.is_absolute() and str(path) == os.path.normpath(str(path)), 'invalid_pin_path')
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'unsafe_pin_parent')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_nlink == 1
                and not before.st_mode & 0o022 and 0 < before.st_size <= 4194304, 'unsafe_pin_file')
        raw = stream.read(4194305)
        after = os.fstat(stream.fileno())
    def stamp(s):
        return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_nlink,
                s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(stamp(before) == stamp(after) == stamp(path.lstat()) and len(raw) == before.st_size
            and hashlib.sha256(raw).hexdigest() == pin['sha256'], 'pin_changed')
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


_ISSUED_SOURCE_ORIGINS = {}


def verify_issued_source_origin_capability(token, request, origin_state, origin_receipt, origin_adapter):
    """Fixed native issuer entry: never dispatch a caller-supplied verify method."""
    require(type(token) is object,'source_origin_capability_unissued')
    entry=_ISSUED_SOURCE_ORIGINS.get(id(token))
    require(entry is not None and entry[0] is token,'source_origin_capability_unissued')
    return entry[1](request,origin_state,origin_receipt,origin_adapter)


def issue_source_origin_capability(*, pg, owner, base, configured, controller, config, request, check):
    """Mint only from live trusted capture under this exact process's retained OFD."""
    outer_check=check
    source_fence=controller.load_module('configured_fence',config['fence'])
    native_check=native_owner_check(pg,owner,Path(source_fence.CONTROL)/'controller.lock')
    def check():
        native_check()
        outer_check()
        native_check()
    check()
    require(getattr(owner,'_fresh_owner',False) and owner.state.get('phase')=='PREPARED', 'source_origin_capture')
    request_raw=configured.encode(request)
    snapshot=configured.capture_source_origin(base,controller,config,request,check=check)
    check()
    require(isinstance(snapshot,dict) and snapshot.get('transitionSha256')==configured.sha(request_raw), 'source_origin_request')
    captured=json.loads(pg.encode(snapshot))
    descriptor=base.NativeActivation.__new__(base.NativeActivation)

    def artifact(path):
        value=Path(path)
        require(value.is_absolute() and str(value)==os.path.normpath(str(value)), 'source_origin_artifact_path')
        base.protected_parent(value)
        before=value.lstat()
        result=base.NativeActivation.file_descriptor(descriptor,value)
        require(base.stamp(before)==base.stamp(value.lstat()),'source_origin_artifact_changed')
        return dict(result,stamp=list(base.stamp(before)))

    paths=set(captured['artifacts']['artifacts'])
    paths.update(request[key]['path'] for key in ('oldState','originalManifest'))
    if request.get('configuredOrigin') is not None:
        paths.update(request['configuredOrigin'][key]['path'] for key in ('journal','receipt'))
    for service in pg.SERVICES:
        recorded=owner.state['recorded'][service]
        fragment=recorded.get('FragmentPath','')
        require(fragment,'source_origin_artifact_coverage')
        paths.add(fragment)
        paths.update(recorded.get('DropInPaths','').split())
        environments=re.findall(r'(/[^\s;{}]+)',recorded.get('EnvironmentFiles',''))
        require(environments,'source_origin_artifact_coverage')
        paths.update(environments)
    require(0<len(paths)<=512,'source_origin_artifact_budget')
    identities={path:artifact(path) for path in sorted(paths)}
    for path,expected in captured['artifacts']['artifacts'].items():
        require({key:value for key,value in identities[path].items() if key!='stamp'}==expected,
                'source_origin_artifact_changed')
    token=pg.PgSourceFence.record_source_origin(owner,captured,artifact_identities=identities)
    fd=os.dup(owner.fd)
    os.set_inheritable(fd,False)
    owner_pid=os.getpid()

    class Capability:
        def __init__(self): self.closed=False
        def _ofd(self, held):
            original=os.fstat(fd);actual=os.fstat(held)
            require((original.st_dev,original.st_ino)==(actual.st_dev,actual.st_ino),'source_origin_lock_changed')
            if sys.platform=='linux':
                info=Path('/proc/self/fdinfo')/str(held)
                require(any('FLOCK' in line and 'WRITE' in line and str(owner_pid) in line.split()
                            for line in info.read_text().splitlines() if line.startswith('lock:')),
                        'source_origin_lock_changed')
        def _owned(self):
            require(not self.closed and os.getpid()==owner_pid,'source_origin_capability')
            check()
            self._ofd(fd);self._ofd(owner.fd)
            record=pg.PgSourceFence.source_origin_record(owner,token)
            require(record['artifactIdentities']==identities and record['snapshot']==captured,'source_origin_journal_changed')
            return record
        def _artifacts(self):
            for path,expected in identities.items():
                require(artifact(path)==expected,'source_origin_artifact_changed')
        def verify(self, request, origin_state, origin_receipt, origin_adapter):
            record=self._owned()
            require(owner.state.get('phase')=='FENCED','not_fenced')
            self._ofd(origin_adapter.fence.lock)
            require(configured.encode(request)==request_raw,'source_origin_request')
            require(configured.sha(configured.encode(origin_state))==captured['originStateSha256']
                    and configured.sha(configured.encode(origin_receipt))==captured['originReceiptSha256']
                    and configured.sha(configured.encode(origin_state['measurement']))==captured['measurementSha256']
                    and origin_state.get('phase')=='COMPLETE' and origin_state.get('bootId')==record['bootId']
                    and {service:origin_state['units'][service].get('ready') for service in pg.SERVICES}
                        =={service:captured['services'][service]['ready'] for service in pg.SERVICES}
                    and origin_adapter.state==origin_state,'source_origin_identity_changed')
            require(configured.sha(configured.encode(source_fence.Journal().read()))==captured['sourceJournalSha256'],
                    'source_origin_journal_changed')
            self._artifacts()
            current=configured.source_origin_artifact_snapshot(base,origin_adapter,check)
            require(current==captured['artifacts'],'source_origin_artifact_changed')
            for service in pg.SERVICES:
                old=owner.state['recorded'][service];live=owner.n.unit(service)
                require(all(live.get(key)==old.get(key) for key in ('User','FragmentPath','EnvironmentFiles')),
                        'source_origin_unit_changed')
                require(set(live.get('DropInPaths','').split())==set(old.get('DropInPaths','').split())
                        | {str(owner.n.guard_path(service))},'source_origin_unit_changed')
            proof=pg.PgSourceFence.measure(owner)
            self._owned()
            return {'protocol':'address-only-source-drained-origin-v1','snapshotSha256':pg.digest(pg.encode(captured)),
                    'ownerJournalSha256':proof['journalSha256'],'operationId':record['operationId'],
                    'transitionSha256':captured['transitionSha256'],'drain':proof}
        def assert_publication(self, actual=None):
            self._owned()
            if actual is None:
                pg.PgSourceFence.measure(owner)
            else:
                require(actual.state.get('phase') == 'PUBLISHED'
                        and actual.state.get('transitionId') == request['transitionId']
                        and all(actual.state['units'][service].get('published') is True
                                for service in pg.SERVICES), 'source_gate_not_published')
                actual.verify_published()
                expected = {service: actual.account_for(service).pw_name for service in pg.SERVICES}
                require(all(expected[service] == (request['walletServiceUser']['user'] if service == 'wallet-monitor'
                            else owner.state['recorded'][service]['User']) for service in pg.SERVICES),
                        'source_origin_publication_identity')
                pg.PgSourceFence.measure(owner, expected_users=expected)
            self._owned()
        def close(self):
            if not self.closed:
                _ISSUED_SOURCE_ORIGINS.pop(id(public_token),None)
                self.closed=True
                os.close(fd)
    capability=Capability()
    public_token=object()
    try: capability._owned()
    except BaseException:
        capability.close()
        raise
    _ISSUED_SOURCE_ORIGINS[id(public_token)]=(public_token,capability.verify)
    return types.SimpleNamespace(token=public_token,close=capability.close,assert_publication=capability.assert_publication)


def bind_configured_controller(*, owner, config, pins, gate, transition_id, origin_request=None):
    """Return activate(request, renewal=None); pins are path/sha256 pairs.

    Required pin keys: activation, configured, controller, fence, pgFence.
    The caller retains ownership of the original FD for the complete transition.
    """
    require(sys.platform == 'linux' and os.geteuid() == 0, 'native_root_required')
    require(type(pins) is dict and set(pins) == {'activation', 'configured', 'controller', 'fence', 'pgFence'},
            'invalid_controller_pins')
    require(type(transition_id) is str and re.fullmatch('[A-Za-z0-9_-]{1,96}', transition_id),
            'invalid_transition_id')
    modules = {key: _pinned_module('source_binding_' + key, pin) for key, pin in pins.items()}
    controller, base = modules['controller'], modules['activation']
    controller.validate_config(config)
    require(config['fence'] == pins['fence'], 'fence_pin_mismatch')
    fence = modules['fence']
    expected_lock = Path(fence.CONTROL) / 'controller.lock'
    check = native_owner_check(modules['pgFence'], owner, expected_lock)
    check()
    # Module-local proxies leave every default entry point unchanged.
    def proxy(module):
        result = types.ModuleType(module.__name__)
        result.__dict__.update(module.__dict__)
        return result
    base_proxy, controller_proxy, fence_proxy = proxy(base), proxy(controller), proxy(fence)
    capability=None
    def retained_gate(actual_owner, actual):
        if capability is not None: capability.assert_publication(actual)
        return gate(actual_owner,actual)
    base_proxy.NativeActivation = gated_activation_type(base, owner, check, retained_gate, transition_id)
    fence_proxy.NativeSourceFence = borrowed_fence_type(fence, owner, check, pg=modules['pgFence'])

    def load_module(name, pin):
        if name == 'configured_fence':
            require(pin == pins['fence'], 'fence_pin_mismatch')
            check()
            return fence_proxy
        return controller.load_module(name, pin)
    controller_proxy.load_module = load_module
    if origin_request is not None:
        require(origin_request.get('transitionId')==transition_id,'transition_identity_mismatch')
        issuer=modules['configured']._source_origin_issuer()
        capability=issuer.issue_source_origin_capability(pg=modules['pgFence'],owner=owner,base=base,configured=modules['configured'],
            controller=controller_proxy,config=config,request=origin_request,check=check)

    def activate(request, renewal=None):
        check()
        require(type(request) is dict and request.get('transitionId') == transition_id,
                'transition_identity_mismatch')
        if capability is None:
            result = modules['configured'].activate(base_proxy, controller_proxy, config, request, renewal)
            check()
            return result
        require(renewal is None,'source_origin_recovery_requires_explicit_entry')
        try:
            result = modules['configured'].activate(base_proxy, controller_proxy, config, request, renewal,
                source_origin_capability=capability.token)
            check()
            return result
        finally:
            capability.close()
    return types.SimpleNamespace(activate=activate,close=capability.close if capability is not None else lambda: None)
