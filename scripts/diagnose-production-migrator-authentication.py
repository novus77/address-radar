"""Read-only pending authentication observation; never replay, reconcile or write state."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import types

BUILDER_SHA256 = 'f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f'

def load_frozen(path):
    p = Path(path)
    if not p.is_absolute() or '..' in p.parts: raise ValueError()
    fds = []; bindings = []; deadline = time.monotonic() + 10
    def remaining():
        if time.monotonic() >= deadline: raise TimeoutError()
    def stamp(v):
        return (v.st_dev, v.st_ino, v.st_mode, v.st_uid, v.st_gid, v.st_nlink, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); fds.append(fd)
        for name in p.parts[1:-1]:
            remaining(); before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or before.st_uid != 0 or before.st_mode & 0o022: raise PermissionError()
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd); fds.append(child)
            if stamp(before) != stamp(os.fstat(child)): raise PermissionError()
            bindings.append((fd, name, before)); fd = child
        before = os.stat(p.name, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > 1048576: raise PermissionError()
        file_fd = os.open(p.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd); fds.append(file_fd)
        if stamp(before) != stamp(os.fstat(file_fd)): raise PermissionError()
        parts = []; size = 0
        while size <= 1048576:
            remaining(); part = os.read(file_fd, min(65536, 1048577 - size))
            if not part: break
            parts.append(part); size += len(part)
        body = b''.join(parts)
        if size != before.st_size or hashlib.sha256(body).hexdigest() != BUILDER_SHA256 or stamp(before) != stamp(os.fstat(file_fd)) or stamp(before) != stamp(os.stat(p.name, dir_fd=fd, follow_symlinks=False)): raise PermissionError()
        for parent, name, expected in bindings:
            if stamp(expected) != stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)): raise PermissionError()
        module = types.ModuleType('diagnosed_frozen_builder'); module.__file__ = path
        exec(compile(body, path, 'exec'), module.__dict__)
        return module
    finally:
        for fd in reversed(fds): os.close(fd)

# Generated only from the reviewed dfc4 static refusal literals; never exception text.
SAFE_CODES = frozenset(('arguments', 'authentication_ack', 'authentication_boundary_changed', 'authentication_child_closure_unknown', 'authentication_failed_preserved', 'authentication_interrupted', 'authentication_journal', 'credential_binding', 'credential_changed', 'credential_expired', 'credential_format', 'credential_lifetime', 'credential_pending_preserved', 'credential_verifier', 'database_identity', 'direct_migration_identity', 'duplicate_json_key', 'existing_authentication', 'explicit_plan_binding_required', 'frozen_dependency_pin', 'hba_already_changed', 'hba_changed', 'hba_identity', 'hba_inode_changed', 'hba_reload_unknown', 'hba_without_role_ack', 'hba_write_unknown', 'initial_hba_binding', 'internal_sql_only', 'invalid_json_number', 'journal_binding', 'linux_root_required', 'live_target_identity', 'machine_identity', 'migration_authentication_unverified', 'migration_credential_mismatch', 'migration_hba_rules', 'native_ack_missing', 'native_sql_output_budget', 'native_sql_unacknowledged', 'nothing_to_reconcile', 'offline_dependency', 'offline_only', 'owned_child_transport_unavailable', 'pending_requires_explicit_reconcile', 'plan_file', 'plan_version', 'postgres_account_changed', 'private_ancestor', 'private_changed', 'private_directory_required', 'private_metadata', 'private_password_transport_failed', 'private_password_transport_unavailable', 'private_pin', 'provisioning_binding', 'role_authority_changed', 'role_inventory', 'role_oid_pins', 'scram_format', 'source_secret_format', 'stage_identity_changed', 'target_pin', 'unexpected_hba_content', 'unexpected_initial_credential', 'unexpected_native_sql_output', 'unknown_commit_unreconciled', 'unknown_or_missing_field', 'unknown_stage', 'unowned_or_missing_state', 'unproved_logging_or_audit_boundary'))

PHASE = 'protected_state_read'
SQLSTATE = None
NATIVE_EXIT_CODE = None
STDERR_BYTES = 0


def category(error):
    if type(error).__name__ == 'Refused':
        code = error.args[0] if len(error.args) == 1 else None
        return code if isinstance(code, str) and code in SAFE_CODES else 'unclassified_contract_refusal'
    if isinstance(error, TypeError): return 'interface_type_mismatch'
    if isinstance(error, KeyError): return 'interface_missing_field'
    if isinstance(error, OSError): return 'filesystem_or_process_failure'
    return 'unclassified_failure'


def recovery_record_hashes(body, canonical_body):
    return {'recoveryRecordFileSha256': hashlib.sha256(body).hexdigest(),
            'recoveryRecordCanonicalSha256': hashlib.sha256(canonical_body).hexdigest()}


def validate_pending_hba(plan, journal, credential, measured, expected_hba_sha):
    if journal.get('pending') != 'hba' or set(journal.get('acknowledged', {})) != {'role'}:
        raise PermissionError()
    receipts = measured.get('receipts', {})
    if (measured.get('phase') != 'active' or set(receipts) != {'role', 'hba'}
        or receipts['role'] != journal['acknowledged']['role']
        or receipts['hba'].get('hbaSha256') != expected_hba_sha): raise PermissionError()
    role = receipts['role']; tcp = receipts['hba'].get('tcp'); target = plan['targetPins']
    expected = {'database': credential['database'], 'user': credential['user'], 'sessionUser': credential['user'],
                'databaseOid': target['databaseOid'], 'roleOid': target['roleOids'][credential['user']],
                'address': '127.0.0.1', 'port': 5432, 'start': role['postmasterStart']}
    if tcp != expected or role['systemIdentifier'] != target['systemIdentifier'] or role['databaseOid'] != target['databaseOid']:
        raise PermissionError()
    return receipts


def safe_tcp_difference(actual, expected):
    import re
    fields = ('database', 'user', 'sessionUser', 'databaseOid', 'roleOid', 'address', 'port', 'start')
    def safe(key, value):
        if value is None: return None
        if key == 'port': return value if type(value) is int and 1 <= value <= 65535 else '<redacted>'
        patterns = {'database': r'[a-z_][a-z0-9_]{0,62}', 'user': r'[a-z_][a-z0-9_]{0,62}',
                    'sessionUser': r'[a-z_][a-z0-9_]{0,62}', 'databaseOid': r'[1-9][0-9]{0,19}',
                    'roleOid': r'[1-9][0-9]{0,19}', 'address': r'[0-9a-fA-F.:/]{1,64}',
                    'start': r'[0-9 .:+TZ-]{1,96}'}
        return value if isinstance(value, str) and re.fullmatch(patterns[key], value) else '<redacted>'
    if not isinstance(actual, dict): return {'shape': 'not_object'}
    differences = []
    for key in fields:
        a = actual.get(key); e = expected[key]
        if key not in actual or a != e or type(a) is not type(e):
            differences.append({'field': key, 'actual': safe(key, a), 'expected': safe(key, e),
                                'actualType': type(a).__name__, 'expectedType': type(e).__name__, 'missing': key not in actual})
    return {'differences': differences, 'unexpectedFieldCount': len(set(actual) - set(fields))}


def exact_loopback_host_tcp(raw):
    import ipaddress
    if not isinstance(raw, dict) or raw.get('address') != '127.0.0.1/32': raise PermissionError()
    address = ipaddress.ip_interface(raw['address'])
    if address.version != 4 or address.network.prefixlen != 32 or str(address.ip) != '127.0.0.1': raise PermissionError()
    canonical = dict(raw); canonical['address'] = str(address.ip)
    return canonical, {'kind': 'exact-ipv4-loopback32-host-canonicalization',
                       'wireAddress': raw['address'], 'canonicalAddress': canonical['address']}


def validate_recovery_bindings(proof, plan, credential, pins):
    required = {'version','kind','approvalRef','planSha256','candidate','producer','authenticationSource',
                'provisioningSource','pinHelper','provisioningPlanSha256','credentialValidUntilMs','targetPins',
                'operationId','originalJournal','credential','authenticationSourceSha256','originalPending',
                'measuredAtMs','receipts','tcpAddressProof','historicalHbaAckProved',
                'independentSoftwareTrustIssued','originalJournalPreserved','credentialRenewed'}
    if not isinstance(proof, dict) or set(proof) != required: raise PermissionError()
    expected = {'version':1, 'kind':'pending-hba-current-native-measurement',
                'candidate':pins['candidate'], 'producer':pins['producer'],
                'authenticationSource':pins['authenticationSource'], 'provisioningSource':plan['provisioningModule'],
                'pinHelper':pins['pinHelper'],
                'provisioningPlanSha256':plan['provisioningPlanSha256'], 'credential':pins['credential'],
                'originalJournal':pins['journal'], 'targetPins':plan['targetPins'],
                'operationId':plan['operationId'], 'credentialValidUntilMs':credential['expiresAtMs'],
                'authenticationSourceSha256':'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61',
                'originalPending':'hba','historicalHbaAckProved':False,
                'independentSoftwareTrustIssued':False,'originalJournalPreserved':True,'credentialRenewed':False}
    for key,value in expected.items():
        if proof.get(key) != value or type(proof.get(key)) is not type(value): raise PermissionError()
    if proof['planSha256'] != hashlib.sha256(json.dumps(plan,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest(): raise PermissionError()
    if type(proof['measuredAtMs']) is not int or not 0 < proof['measuredAtMs'] < credential['expiresAtMs']: raise PermissionError()
    import re
    if not isinstance(proof['approvalRef'],str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}',proof['approvalRef']): raise PermissionError()


def validate_pending_hba_root(plan, journal, credential, measured, expected_hba_sha):
    if journal.get('pending') != 'hba' or set(journal.get('acknowledged',{})) != {'role'}: raise PermissionError()
    receipts=measured.get('receipts',{})
    if (measured.get('phase') != 'active' or set(receipts) != {'role','hba'}
        or receipts['role'] != journal['acknowledged']['role']
        or receipts['hba'].get('hbaSha256') != expected_hba_sha or 'tcp' in receipts['hba']): raise PermissionError()
    return receipts


def bounded_communicate(process, body, timeout, maximum=1048576):
    """Drain both pipes incrementally; never buffer beyond either stream cap."""
    import selectors
    deadline = time.monotonic() + timeout
    output = bytearray(); error = bytearray(); offset = 0
    with selectors.DefaultSelector() as selector:
        for stream, event, name in ((process.stdin,selectors.EVENT_WRITE,'input'),
                                   (process.stdout,selectors.EVENT_READ,'output'),
                                   (process.stderr,selectors.EVENT_READ,'error')):
            os.set_blocking(stream.fileno(),False); selector.register(stream,event,name)
        while selector.get_map():
            left = deadline-time.monotonic()
            if left <= 0: raise TimeoutError('bounded_child_timeout')
            for key,event in selector.select(min(left,0.1)):
                if key.data == 'input':
                    if offset < len(body):
                        try: offset += os.write(key.fd,body[offset:offset+65536])
                        except BlockingIOError: continue
                        except BrokenPipeError: offset = len(body)
                    if offset == len(body): selector.unregister(key.fileobj); key.fileobj.close()
                else:
                    try: part = os.read(key.fd,min(65536,maximum+1))
                    except BlockingIOError: continue
                    if not part: selector.unregister(key.fileobj); continue
                    target = output if key.data == 'output' else error
                    if len(target)+len(part)>maximum: raise PermissionError('bounded_child_output')
                    target.extend(part)
        left = deadline-time.monotonic()
        if left <= 0: raise TimeoutError('bounded_child_timeout')
        process.wait(timeout=left)
    return bytes(output),bytes(error)


def guarded_owned_child(factory, argv, remaining, **kwargs):
    """Defer asynchronous cancellation until the child's stable pidfd is acquired."""
    import signal
    if not hasattr(signal,'pthread_sigmask'): raise PermissionError()
    remaining()
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM,signal.SIGINT})
    owned = None
    try:
        owned = factory(argv,remaining,**kwargs)
        # Cleanup has its own bounded wait; SQL invocation limits remain unchanged.
        owned.remaining = lambda: 0.25
    finally:
        try: signal.pthread_sigmask(signal.SIG_SETMASK,old_mask)
        except BaseException:
            if owned is not None:
                try: owned.process.stdin.close()
                finally: owned.close()
            raise
    return owned


def main(expected_recovery_proof=None, verify_tcp=True, expected_record_producer_pin=None):
    global PHASE
    import re
    if sys.platform != 'linux' or os.geteuid() != 0 or len(sys.argv) not in (4, 6): raise PermissionError()
    record_path = sys.argv[4] if len(sys.argv) == 6 else None
    approval_ref = sys.argv[5] if len(sys.argv) == 6 else None
    if not verify_tcp and (expected_recovery_proof is None or record_path is not None): raise PermissionError()
    if approval_ref is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}', approval_ref): raise PermissionError()
    helper = load_frozen(sys.argv[1]); plan_path = sys.argv[2]; state = Path(sys.argv[3])
    deadline = time.monotonic() + 60
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0: raise TimeoutError()
        return value
    pins = []
    def read(path, maximum, mode=None, expected=None):
        pin, body = helper.file_pin(str(path), maximum, remaining, True, mode=mode)
        if pin['gid'] != 0 or (expected is not None and pin['sha256'] != expected): raise PermissionError()
        pins.append((str(path), maximum, mode, pin)); return pin, body
    helper_pin, _ = read(sys.argv[1], 1048576, expected=BUILDER_SHA256)
    plan_pin, plan_body = read(plan_path, 1048576, 0o600)
    plan = helper.strict_json(plan_body)
    canonical_sha = hashlib.sha256(helper.encoded(plan)).hexdigest()
    if canonical_sha != '2ebcf7cf58b3f83153125ce40d4eef27cdc96037ca51a40e6314345cc796dae2': raise PermissionError()
    parent, bindings = helper.parent_fd(str(state / 'journal.json'))
    lock_fd = None
    try:
        import fcntl
        lock_pin, _ = read(state / 'operation.lock', 4096, 0o600)
        inherited = os.environ.get('SCHEMA_AUTH_LOCK_FD')
        lock_fd = os.dup(int(inherited)) if inherited is not None else os.open('operation.lock', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        lock_info = os.fstat(lock_fd)
        if (str(lock_info.st_dev), str(lock_info.st_ino), lock_info.st_uid, lock_info.st_gid, stat.S_IMODE(lock_info.st_mode), lock_info.st_nlink, lock_info.st_size) != (lock_pin['device'], lock_pin['inode'], 0, 0, 0o600, 1, 0): raise PermissionError()
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        helper.check_bindings(parent, bindings)
        info = os.fstat(parent)
        if info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o700: raise PermissionError()
        journal_pin, journal_body = read(state / 'journal.json', 65536, 0o600)
        credential_pin, credential_body = read(state / 'secrets.json', 65536, 0o600)
        journal = helper.strict_json(journal_body); credential = helper.strict_json(credential_body)
        if (journal.get('planSha256') != canonical_sha or journal.get('operationId') != plan['operationId']
            or hashlib.sha256(helper.encoded(credential)).hexdigest() != journal.get('credentialSha256')):
            raise PermissionError()
        pending = journal.get('pending'); acknowledged = journal.get('acknowledged')
        if pending not in (None, 'credential', 'role', 'hba') or not isinstance(acknowledged, dict) or not set(acknowledged) <= {'role', 'hba'}: raise PermissionError()
        # Metadata only; no credential hash, contents or receipt bodies are exported.
        result = {'status': 'readonly_state_measured', 'pending': pending, 'acknowledgedStages': sorted(acknowledged),
                  'credentialBound': True, 'files': {}}
        for key, pin in (('journal', journal_pin), ('credential', credential_pin)):
            result['files'][key] = {k: pin[k] for k in ('uid', 'gid', 'mode', 'device', 'inode')}
        PHASE = 'authentication_source_binding'
        # Source location is explicit, derived from the reviewed helper's sibling deployment argument.
        auth_path = os.environ.get('REVIEWED_AUTH_SOURCE')
        if not auth_path: raise PermissionError()
        auth_pin, auth_body = read(auth_path, 1048576, expected='dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61')
        auth = helper.load_module(auth_body, auth_path, 'readonly_auth_probe')
        provisioning_pin, _ = read(plan['provisioningModule']['path'], 1048576, expected=auth.PROVISIONING_SHA256)
        if provisioning_pin != plan['provisioningModule']: raise PermissionError()
        provisioning = auth.load_provisioning(plan['provisioningModule'])
        PHASE = 'plan_validation'
        prepared = auth.validate_plan(plan, provisioning, int(time.time() * 1000))
        auth.validate_credential(credential, prepared)
        real_os = auth.os; proxy = types.SimpleNamespace(**vars(real_os)); active_stderr = {'fd': None}
        def safe_read(fd, size):
            global SQLSTATE, STDERR_BYTES
            body = real_os.read(fd, size)
            if fd == active_stderr['fd']:
                STDERR_BYTES += len(body)
                matches = re.findall(rb'(?:ERROR|FATAL|PANIC):[ \t]+([0-9A-Z]{5})(?=[\s:]|$)', body)
                if matches: SQLSTATE = matches[-1].decode('ascii')
            return body
        proxy.read = safe_read; auth.os = proxy
        real_child = auth.OwnedPsqlChild
        class ProcessProbe:
            def __init__(self, process): self.process = process
            def __getattr__(self, key): return getattr(self.process, key)
            def communicate(self, *args, **kwargs):
                global NATIVE_EXIT_CODE, STDERR_BYTES, SQLSTATE
                body = args[0] if args else kwargs.get('input',b'')
                output, error = bounded_communicate(self.process,body,kwargs['timeout'])
                NATIVE_EXIT_CODE = self.process.returncode; STDERR_BYTES += len(error)
                matches = re.findall(rb'(?:ERROR|FATAL|PANIC):[ \t]+([0-9A-Z]{5})(?=[\s:]|$)', error)
                if matches: SQLSTATE = matches[-1].decode('ascii')
                return output, error
        def child(argv, *args, **kwargs):
            owned = guarded_owned_child(real_child,[*argv, '-v', 'VERBOSITY=sqlstate'], *args, **kwargs)
            owned.process = ProcessProbe(owned.process)
            return owned
        auth.OwnedPsqlChild = child
        original_exchange = auth.PrivateSqlSession.exchange
        def exchange(self, text):
            global PHASE
            PHASE = 'logging_boundary_ack' if text.startswith('SET ') else 'readonly_catalog_ack'
            active_stderr['fd'] = self.process.stderr.fileno()
            try: return original_exchange(self, text)
            finally: active_stderr['fd'] = None
        auth.PrivateSqlSession.exchange = exchange
        adapter = auth.NativeAdapter(prepared, provisioning); adapter.base.deadline = min(adapter.base.deadline, deadline)
        def owned_readonly_command(tool, arguments, body=None, postgres=False):
            import pwd
            if tool != 'psql' or not postgres or not isinstance(body,bytes) or not body.lstrip().upper().startswith(b'SELECT '): raise PermissionError()
            adapter.guard(); executable = adapter.base.pinned_file(adapter.p['tools']['psql'])
            account = pwd.getpwnam('postgres'); owner = adapter.p['ownership']['data']
            if (account.pw_uid,account.pw_gid) != (owner['uid'],owner['gid']): raise PermissionError()
            owned = auth.OwnedPsqlChild([executable,*arguments],adapter.base.remaining,
                stdin=auth.subprocess.PIPE,stdout=auth.subprocess.PIPE,stderr=auth.subprocess.PIPE,
                env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'},
                user=account.pw_uid,group=account.pw_gid,extra_groups=[],start_new_session=True)
            try:
                output,_ = owned.process.communicate(body,timeout=min(adapter.base.remaining(),adapter.p['stageTimeoutSeconds']))
                if owned.process.returncode != 0 or len(output)>1048576: raise PermissionError()
                return output
            finally: owned.close()
        # Keep the frozen module unchanged: only this read-only observer instance uses owned direct children.
        adapter.base.command = owned_readonly_command
        original_sql = adapter.sql
        def readonly_sql(text):
            if not text.lstrip().upper().startswith('SELECT '): raise PermissionError()
            return original_sql(text)
        adapter.sql = readonly_sql
        producer_pin, _ = read(__file__, 1048576)
        record_producer_pin = producer_pin
        if expected_record_producer_pin is not None:
            if expected_recovery_proof is None or record_path is not None: raise PermissionError()
            if expected_record_producer_pin.get('sha256') not in ('eac155c618a5c7854744917cf2fa1b46949e063cbd842711c28aff4da1fd77ff', producer_pin['sha256']): raise PermissionError()
            record_producer_pin, _ = read(expected_record_producer_pin['path'], 1048576, expected=expected_record_producer_pin['sha256'])
            if record_producer_pin != expected_record_producer_pin: raise PermissionError()
        if expected_recovery_proof is not None:
            validate_recovery_bindings(expected_recovery_proof, plan, credential,
                {'candidate':plan_pin,'producer':record_producer_pin,'authenticationSource':auth_pin,
                 'journal':journal_pin,'credential':credential_pin,'pinHelper':helper_pin})
        address_proof = {}
        tcp_diff = {}; original_tcp = adapter.tcp_identity
        def measured_tcp(value):
            actual = original_tcp(value)
            expected = {'database': value['database'], 'user': value['user'], 'sessionUser': value['user'],
                        'databaseOid': plan['targetPins']['databaseOid'],
                        'roleOid': plan['targetPins']['roleOids'][value['user']],
                        'address': '127.0.0.1', 'port': 5432,
                        'start': journal['acknowledged']['role']['postmasterStart']}
            tcp_diff.update(safe_tcp_difference(actual, expected))
            canonical, observed_address = exact_loopback_host_tcp(actual)
            address_proof.update(observed_address)
            return canonical
        adapter.tcp_identity = measured_tcp
        try:
            PHASE = 'native_authentication_observation'
            expected_hba_sha = hashlib.sha256(adapter.hba()).hexdigest()
            if expected_hba_sha != 'f4871503662bf298c9b730c3017eb19339771328a5928b614197fe10e21d6821': raise PermissionError()
            observed = adapter.observe(credential, verify_tcp=verify_tcp)
            validate_measurement = validate_pending_hba if verify_tcp else validate_pending_hba_root
            measured_receipts = validate_measurement(plan, journal, credential, observed, expected_hba_sha)
            second = adapter.observe(credential, verify_tcp=verify_tcp)
            if validate_measurement(plan, journal, credential, second, expected_hba_sha) != measured_receipts: raise PermissionError()
            # Server-measured lease; no local renewal or expiry override.
            adapter.guard()
            clock = helper.strict_json(adapter.base.sql("SELECT json_build_object('database',current_database(),'serverTimeMs',floor(extract(epoch from clock_timestamp())*1000)::bigint::text);", database=credential['database']))
            if clock.get('database') != credential['database'] or not isinstance(clock.get('serverTimeMs'),str) or not re.fullmatch(r'[1-9][0-9]*',clock['serverTimeMs']): raise PermissionError()
            if int(clock['serverTimeMs']) + plan['invocationTimeoutSeconds']*1000 >= credential['expiresAtMs']: raise PermissionError()
            if expected_recovery_proof is not None:
                expected_receipts = json.loads(json.dumps(expected_recovery_proof['receipts']))
                if not verify_tcp:
                    expected_receipts['hba'].pop('tcp')
                    if expected_recovery_proof['tcpAddressProof'] != {'kind':'exact-ipv4-loopback32-host-canonicalization','wireAddress':'127.0.0.1/32','canonicalAddress':'127.0.0.1'}: raise PermissionError()
                if expected_receipts != measured_receipts or (verify_tcp and expected_recovery_proof['tcpAddressProof'] != address_proof) or expected_recovery_proof['measuredAtMs'] > int(clock['serverTimeMs']): raise PermissionError()
            adapter.guard()
            result['measuredReceiptsSha256'] = hashlib.sha256(helper.encoded(measured_receipts)).hexdigest()
            result['tcpAddressProof'] = dict(address_proof)
            result['serverTimeMs'] = clock['serverTimeMs']
            result['nativePhase'] = observed['phase']
            result['measuredStages'] = sorted(observed['receipts'])
            result['pendingHasMeasuredAck'] = pending in observed['receipts'] if pending is not None else False
            result['priorAckMatches'] = all(observed['receipts'].get(k) == v for k,v in acknowledged.items() if k != 'hba')
            result['tcpMeasured'] = verify_tcp
            result['boundary'] = {'systemIdentifier':measured_receipts['role']['systemIdentifier'],
                'databaseOid':measured_receipts['role']['databaseOid'],
                'roleOid':plan['targetPins']['roleOids'][credential['user']],
                'postmasterStart':measured_receipts['role']['postmasterStart']}
            if not verify_tcp: result['status'] = 'readonly_root_boundary_measured'
        except Exception as error:
            result['status'] = 'readonly_native_observation_refused'
            result['category'] = category(error); result['phase'] = PHASE
            tb = error.__traceback__; location = None
            while tb:
                location = {'module': Path(tb.tb_frame.f_code.co_filename).name, 'line': tb.tb_lineno}; tb = tb.tb_next
            result['location'] = location
        if tcp_diff: result['tcpIdentityDifference'] = tcp_diff
        result['nativeSql'] = {'sqlState': SQLSTATE, 'stderrBytes': STDERR_BYTES, 'exitCode': NATIVE_EXIT_CODE}
        helper.check_bindings(parent, bindings)
        for path, maximum, mode, expected in pins:
            current, _ = helper.file_pin(path, maximum, remaining, False, mode=mode)
            if current != expected: raise PermissionError()
        if record_path is not None and result['status'] == 'readonly_state_measured':
            record = Path(record_path)
            if not record.is_absolute() or '..' in record.parts or record == state or record.is_relative_to(state): raise PermissionError()
            helper.check_bindings(parent, bindings)
            # This is a newly measured fact, not a reconstructed historical ACK or independent signed review.
            proof = {'version': 1, 'kind': 'pending-hba-current-native-measurement', 'approvalRef': approval_ref,
                     'planSha256': canonical_sha, 'candidate': plan_pin, 'producer': producer_pin,
                     'authenticationSource': auth_pin, 'provisioningSource': plan['provisioningModule'], 'pinHelper': helper_pin,
                     'provisioningPlanSha256': plan['provisioningPlanSha256'],
                     'credentialValidUntilMs': credential['expiresAtMs'],
                     'targetPins': plan['targetPins'], 'operationId': plan['operationId'], 'originalJournal': journal_pin,
                     'credential': credential_pin, 'authenticationSourceSha256': 'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61',
                     'originalPending': 'hba', 'measuredAtMs': int(clock['serverTimeMs']), 'receipts': measured_receipts,
                     'tcpAddressProof': dict(address_proof),
                     'historicalHbaAckProved': False, 'independentSoftwareTrustIssued': False,
                     'originalJournalPreserved': True, 'credentialRenewed': False}
            canonical_body = helper.encoded(proof); file_body = canonical_body + b'\n'
            helper.write_once(str(record), file_body, remaining)
            result['recoveryRecordWritten'] = True
            result.update(recovery_record_hashes(file_body, canonical_body))
        else: result['recoveryRecordWritten'] = False
        result['journalWritten'] = False; result['credentialWritten'] = False
        return result
    finally:
        if lock_fd is not None: os.close(lock_fd)
        helper.close_parent(parent, bindings)


if __name__ == '__main__':
    try: result = main()
    except Exception as error:
        result = {'status': 'readonly_diagnostic_refused', 'category': category(error), 'phase': PHASE}
    result['productionMigrationReady'] = False
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result['status'] in ('readonly_state_measured','readonly_root_boundary_measured') else 1)
