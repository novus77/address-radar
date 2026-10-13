"""Read-only native schema candidate builder; no authentication, schema or service mutations."""
import copy
import os
import time
import re

AUTH_SOURCE_SHA256 = 'dfc4f1c4fd6f506e36ab40429372d285905ab4ecee848f0426919ddd51ff4b61'
PIN_HELPER_SHA256 = 'f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f'
SCHEMA_ENTRY_SHA256 = '2750b013c1aab325717ab934e38c490ec41b625ff3757d0fa9b30e471875ca5b'
SCHEMA_FINGERPRINT = '9f8214848d49e75f9b81248c564b27674070aaa440eb73febd7632c70dca8c22'
RELEASE_INVENTORY_SHA256 = '9c0e7d6a1f8753a694d303c5eb694b5ab63206cdd5f9f163731b34cc2f6a6a08'
REVIEWED_NODE = {
    'path': '/var/lib/address-radar-maintenance-tools/native-node-7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c/node',
    'sha256': '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c',
    'uid': 0, 'gid': 0, 'mode': 320, 'device': '64769', 'inode': '6029447',
}


def guarded_owned_child(factory, argv, remaining, **kwargs):
    import signal
    remaining()
    old = signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM,signal.SIGINT})
    child = None
    try:
        child = factory(argv,remaining,**kwargs)
        child.remaining = lambda: 0.25
    finally:
        try: signal.pthread_sigmask(signal.SIG_SETMASK,old)
        except BaseException:
            if child is not None:
                try: child.process.stdin.close()
                finally: child.close()
            raise
    return child


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


class Refused(Exception):
    pass


def demand(condition, code):
    if not condition: raise Refused(code)


def validate_completed_auth(plan, credential, journal, plan_sha256, credential_sha256, measured):
    demand(journal.get('version') == 1 and journal.get('operationId') == plan['operationId']
           and journal.get('planSha256') == plan_sha256 and journal.get('pending') is None
           and journal.get('credentialSha256') == credential_sha256, 'authentication_not_completed')
    expected = copy.deepcopy(journal.get('acknowledged', {}))
    demand(set(expected) == {'role', 'hba'} and isinstance(expected['role'], dict)
           and isinstance(expected['hba'], dict) and isinstance(expected['hba'].get('tcp'), dict),
           'authentication_ack_missing')
    expected['hba'].pop('tcp')
    demand(measured.get('receipts') == expected, 'authentication_live_boundary_changed')
    epoch = expected['role'].get('postmasterStart')
    demand(isinstance(epoch, str) and bool(epoch), 'authentication_epoch_missing')
    return epoch


def validate_live_observation(observation, expires_at_ms, invocation_timeout_ms):
    clock = observation.get('serverTimeMs')
    demand(isinstance(clock, str) and re.fullmatch(r'[1-9][0-9]*', clock)
           and type(observation.get('namespaceCount')) is int and observation['namespaceCount'] == 0,
           'namespace_or_clock_unproved')
    demand(type(expires_at_ms) is int and type(invocation_timeout_ms) is int
           and 0 < invocation_timeout_ms <= 180000 and int(clock) + invocation_timeout_ms < expires_at_ms,
           'credential_lease_insufficient')


def validate_release_measurement(proof, schema_plan, candidate_sha256):
    demand(proof.get('inventorySha256') == RELEASE_INVENTORY_SHA256
           and proof.get('entries') == 306 and proof.get('bytes') == 1016989
           and proof.get('schemaPlan') == schema_plan and schema_plan.get('version') == 1
           and schema_plan.get('fingerprint') == SCHEMA_FINGERPRINT
           and proof.get('candidateSha256') == candidate_sha256, 'compiled_release_changed')



def bootstrap_helper(path, remaining):
    """Verify protected source before executing the shared bounded pin mechanisms."""
    import os
    import stat
    import hashlib
    import types
    from pathlib import Path
    p = Path(path)
    demand(p.is_absolute() and '..' not in p.parts, 'helper_path')
    fds = []; bindings = []
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); fds.append(fd)
        for name in p.parts[1:-1]:
            remaining(); before = os.stat(name, dir_fd=fd, follow_symlinks=False)
            demand(stat.S_ISDIR(before.st_mode) and before.st_uid == 0 and before.st_gid == 0
                   and not before.st_mode & 0o022, 'helper_ancestor')
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            fds.append(child); after = os.fstat(child)
            demand((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino), 'helper_ancestor_changed')
            bindings.append((fd, name, before)); fd = child
        def stamp(v):
            return (v.st_dev, v.st_ino, v.st_mode, v.st_uid, v.st_gid, v.st_nlink, v.st_size, v.st_mtime_ns, v.st_ctime_ns)
        before = os.stat(p.name, dir_fd=fd, follow_symlinks=False)
        demand(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0
               and not before.st_mode & 0o022 and before.st_nlink == 1 and before.st_size <= 1048576, 'helper_metadata')
        file_fd = os.open(p.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd); fds.append(file_fd)
        demand(stamp(before) == stamp(os.fstat(file_fd)), 'helper_changed')
        chunks = []; size = 0
        while size <= 1048576:
            remaining(); part = os.read(file_fd, min(65536, 1048577 - size))
            if not part: break
            size += len(part); chunks.append(part)
        body = b''.join(chunks)
        demand(size == before.st_size and hashlib.sha256(body).hexdigest() == PIN_HELPER_SHA256
               and stamp(before) == stamp(os.fstat(file_fd)) == stamp(os.stat(p.name, dir_fd=fd, follow_symlinks=False)), 'helper_changed')
        for parent, name, expected in bindings:
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            demand(stamp(actual) == stamp(expected), 'helper_ancestor_changed')
        module = types.ModuleType('reviewed_schema_pin_helper'); module.__file__ = path
        exec(compile(body, path, 'exec'), module.__dict__)
        return module
    finally:
        for fd in reversed(fds): os.close(fd)


def require_target_observation(value, database):
    demand(value.get('database') == database == 'address_radar', 'namespace_database_changed')
    return value


def cli():
    import argparse
    import hashlib
    import json
    import os
    import stat
    import subprocess
    import sys
    import time
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('pin-helper', 'activation-source', 'activation-plan', 'authentication-state-directory',
                 'original-provisioning-plan', 'compiled-release', 'build-receipt', 'schema-entry',
                 'node', 'python', 'operation-id', 'approval-ref', 'output', 'schema-state-directory'):
        parser.add_argument('--' + name, required=True)
    for name in ('invocation-timeout-ms', 'statement-timeout-ms', 'lock-timeout-ms', 'maximum-entries', 'maximum-bytes'):
        parser.add_argument('--' + name, required=True, type=int)
    parser.add_argument('--authentication-recovery-mode', choices=('known-pending-hba',))
    for name in ('recovery-proof','recovery-record-file-sha256','recovery-producer','recovery-revalidator','recovery-consumer'):
        parser.add_argument('--'+name)
    args = parser.parse_args()
    demand(sys.platform == 'linux' and os.geteuid() == 0, 'native_root_required')
    demand(0 < args.lock_timeout_ms <= args.statement_timeout_ms <= args.invocation_timeout_ms <= 180000
           and 306 <= args.maximum_entries <= 4096 and 1016989 <= args.maximum_bytes <= 134217728, 'candidate_budget')
    deadline = time.monotonic() + args.invocation_timeout_ms / 1000
    def remaining():
        value = deadline - time.monotonic(); demand(value > 0, 'candidate_budget_exhausted'); return value
    helper = bootstrap_helper(args.pin_helper, remaining)
    pins = []
    def read(path, maximum=1048576, mode=None, expected=None, keep=True):
        pin, body = helper.file_pin(path, maximum, remaining, keep, mode=mode)
        demand(pin['gid'] == 0 and (expected is None or pin['sha256'] == expected), 'dependency_pin_changed')
        pins.append((path, maximum, mode, pin)); return pin, body
    helper_pin, _ = read(args.pin_helper, expected=PIN_HELPER_SHA256)
    auth_pin, auth_body = read(args.activation_source, expected=AUTH_SOURCE_SHA256)
    entry_pin, _ = read(args.schema_entry, expected=SCHEMA_ENTRY_SHA256)
    original_pin, original_body = read(args.original_provisioning_plan, 65536, 0o600)
    helper.require_original_pin('plan', original_pin)
    original = helper.strict_json(original_body)
    demand(hashlib.sha256(helper.encoded(original)).hexdigest() == helper.PROVISIONING_PLAN_SHA256, 'original_plan_changed')
    plan_pin, plan_body = read(args.activation_plan, 1048576, 0o600)
    plan = helper.strict_json(plan_body)
    demand(plan['provisioningPlan'] == original and plan['provisioningPlanSha256'] == helper.PROVISIONING_PLAN_SHA256, 'original_plan_binding')
    auth = helper.load_module(auth_body, args.activation_source, 'reviewed_authentication')
    provisioning = auth.load_provisioning(plan['provisioningModule'])
    read(plan['provisioningModule']['path'], expected=auth.PROVISIONING_SHA256)
    prepared = auth.validate_plan(plan, provisioning, int(time.time() * 1000))
    state = Path(args.authentication_state_directory)
    state_parent, state_bindings = helper.parent_fd(str(state / 'journal.json'))
    try:
        demand(os.fstat(state_parent).st_uid == 0 and os.fstat(state_parent).st_gid == 0
               and stat.S_IMODE(os.fstat(state_parent).st_mode) == 0o700, 'authentication_state_metadata')
        journal_pin, journal_body = read(str(state / 'journal.json'), 65536, 0o600)
        credential_pin, credential_body = read(str(state / 'secrets.json'), 65536, 0o600)
        journal = helper.strict_json(journal_body); credential = helper.strict_json(credential_body)
        auth.validate_credential(credential, prepared)
        recovery = None; recovery_consumer = None
        recovery_args = (args.recovery_proof, args.recovery_record_file_sha256, args.recovery_producer,
                         args.recovery_revalidator, args.recovery_consumer)
        if args.authentication_recovery_mode is not None:
            demand(all(recovery_args) and re.fullmatch(r'[a-f0-9]{64}', args.recovery_record_file_sha256), 'recovery_inputs_required')
            proof_pin, _ = read(args.recovery_proof, 65536, 0o600, args.recovery_record_file_sha256)
            producer_pin, _ = read(args.recovery_producer, expected='eac155c618a5c7854744917cf2fa1b46949e063cbd842711c28aff4da1fd77ff')
            revalidator_pin, _ = read(args.recovery_revalidator, expected='11fa16d2aa49da8cf55cb8c791421b24745f6cbebd8db18224cc7eca5b849e51')
            consumer_pin, consumer_body = read(args.recovery_consumer, expected='0b8edb0c600920cd7ec42c1b42d95ae979c429a6fbdd43281708034f82a588f7')
            recovery = {'mode':'known-pending-hba','proof':proof_pin,'producer':producer_pin,
                        'revalidator':revalidator_pin,'consumer':consumer_pin,'pinHelper':helper_pin}
            recovery_consumer = helper.load_module(consumer_body,args.recovery_consumer,'reviewed_schema_recovery_consumer')
        else:
            demand(not any(recovery_args), 'explicit_recovery_mode_required')
        adapter = auth.NativeAdapter(prepared, provisioning)
        adapter.base.deadline = min(adapter.base.deadline, deadline)
        def live():
            remaining()
            if recovery is not None:
                fresh = recovery_consumer.consume(args.pin_helper,args.recovery_producer,args.recovery_proof,
                    args.recovery_record_file_sha256,args.activation_plan,str(state),'full',args.recovery_revalidator)
                demand(fresh.get('status') == 'recovery_current_native_verified' and fresh.get('tcpAuthenticationChecked') is True
                    and fresh.get('planSha256') == prepared['planSha256']
                    and fresh.get('recoveryRecordFileSha256') == args.recovery_record_file_sha256, 'recovery_native_unproved')
                boundary = fresh['boundary']
                demand(boundary['systemIdentifier'] == plan['targetPins']['systemIdentifier']
                    and boundary['databaseOid'] == plan['targetPins']['databaseOid']
                    and boundary['roleOid'] == plan['targetPins']['roleOids'][original['migratorRole']], 'recovery_target_changed')
                epoch = boundary['postmasterStart']
            else:
                measured = adapter.observe(credential, verify_tcp=False)
                epoch = validate_completed_auth(plan, credential, journal, prepared['planSha256'],
                    hashlib.sha256(helper.encoded(credential)).hexdigest(), measured)
            # This SELECT is non-sensitive; it must execute in the actual target database.
            sql = "SELECT json_build_object('database',current_database(),'serverTimeMs'," \
                "floor(extract(epoch from clock_timestamp())*1000)::bigint::text,'namespaceCount'," \
                "(SELECT count(*) FROM pg_namespace WHERE nspname='" + original['schema'].replace("'", "''") + "'));"
            adapter.guard(); observation = helper.strict_json(adapter.base.sql(sql, database=original['database']))
            require_target_observation(observation, original['database'])
            validate_live_observation(observation, credential['expiresAtMs'], args.invocation_timeout_ms)
            adapter.guard(); return epoch
        epoch = live()
        node_pin, _ = read(args.node, 134217728, 0o500, REVIEWED_NODE['sha256'], False)
        demand(node_pin == REVIEWED_NODE, 'reviewed_node_changed')
        python_pin, _ = read(args.python, 67108864, 0o755,
            '359ca926ba4596147d7d558c1e0cbf6a5784f5475d7e8bf0a55d9d7c4fa7106c', False)
        demand(python_pin['path'] == '/usr/bin/python3.12' and python_pin['device'] == '64769'
               and python_pin['inode'] == '2012', 'reviewed_python_changed')
        receipt_pin, receipt_body = read(args.build_receipt, 1048576, expected=
            '63c0e45783f9c3670cd83f62981ad62d7b935a00547bab317250f16130311ab0')
        receipt = helper.strict_json(receipt_body)
        demand(receipt['inventorySha256'] == RELEASE_INVENTORY_SHA256 and receipt['entries'] == 306
               and receipt['bytes'] == 1016989, 'build_receipt_changed')
        private = Path(args.schema_state_directory)
        demand(private.is_absolute() and '..' not in private.parts and private != state
               and not private.is_relative_to(state) and not state.is_relative_to(private), 'private_state_collision')
        private_parent, private_bindings = helper.parent_fd(str(private))
        try:
            try: os.stat(private.name, dir_fd=private_parent, follow_symlinks=False)
            except FileNotFoundError: pass
            else: raise Refused('schema_state_already_exists')
            helper.check_bindings(private_parent, private_bindings)
        finally: helper.close_parent(private_parent, private_bindings)
        candidate = {'version': 1, 'operationId': args.operation_id, 'approvalRef': args.approval_ref,
            'authenticationPlanSha256': prepared['planSha256'], 'authenticationPlan': plan_pin,
            'authenticationScript': auth_pin, 'authenticationStateDirectory': str(state),
            'python': python_pin, 'credential': credential_pin,
            'target': {'database': original['database'], 'schema': original['schema'], 'username': original['migratorRole'],
                       'generation': original['generation'], 'service': 'migration'},
            'targetPins': {'systemIdentifier': plan['targetPins']['systemIdentifier'],
                          'databaseOid': plan['targetPins']['databaseOid'],
                          'roleOid': plan['targetPins']['roleOids'][original['migratorRole']]},
            'schemaPlan': receipt['schemaPlan'],
            'release': {'root': args.compiled_release, 'inventorySha256': RELEASE_INVENTORY_SHA256,
                        'maximumEntries': args.maximum_entries, 'maximumBytes': args.maximum_bytes},
            'invocationTimeoutMs': args.invocation_timeout_ms, 'statementTimeoutMs': args.statement_timeout_ms,
            'lockTimeoutMs': args.lock_timeout_ms, 'privateDirectory': str(private)}
        if recovery is not None: candidate['authenticationRecovery'] = recovery
        candidate_sha = hashlib.sha256(helper.encoded(candidate)).hexdigest()
        # Only public candidate metadata enters Node stdin; never credentials or SCRAM.
        script = "import {pathToFileURL} from 'node:url';\n" \
            "const c=" + helper.encoded(candidate).decode() + ";\n" \
            "const m=await import(pathToFileURL(" + json.dumps(args.schema_entry) + ").href);\n" \
            "m.validateCandidate(c); const end=performance.now()+" + str(int(remaining()*1000)) + ";\n" \
            "const guard=()=>{if(performance.now()>=end)throw Error('budget');};\n" \
            "const i=await m.releaseInventory(c.release,guard);\n" \
            "if(m.digest(i.entries)!==c.release.inventorySha256)throw Error('inventory');\n" \
            "const s=await import(pathToFileURL(c.release.root+'/packages/database/src/postgres-business-schema.js').href);\n" \
            "guard(); console.log(JSON.stringify({inventorySha256:m.digest(i.entries),entries:i.entries.length," \
            "bytes:i.bytes,schemaPlan:s.POSTGRES_BUSINESS_SCHEMA_PLAN,candidateSha256:m.digest(c)}));\n"
        child = guarded_owned_child(auth.OwnedPsqlChild, [args.node, '--input-type=module', '-'], remaining,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, start_new_session=True)
        try:
            output, _ = bounded_communicate(child.process, script.encode(), remaining(), 65536)
            demand(child.process.returncode == 0 and len(output) <= 65536, 'release_measurement_failed')
            validate_release_measurement(helper.strict_json(output), receipt['schemaPlan'], candidate_sha)
        finally:
            child.remaining = lambda: 0.25
            child.close()
        demand(live() == epoch, 'authentication_epoch_changed')
        helper.check_bindings(state_parent, state_bindings)
        for path, maximum, mode, expected in pins:
            current, _ = helper.file_pin(path, maximum, remaining, False, mode=mode)
            demand(current == expected, 'candidate_artifact_changed')
        helper.write_once(args.output, helper.encoded(candidate) + b'\n', remaining)
        return {'status': 'schema_candidate_created', 'candidatePath': args.output, 'candidateSha256': candidate_sha,
                'schemaInstalled': False, 'dataImported': False, 'productionMigrationReady': False}
    finally:
        helper.close_parent(state_parent, state_bindings)


if __name__ == '__main__':
    import json
    import signal
    def cancelled(signum, frame): raise InterruptedError('candidate_cancelled')
    for sig in (signal.SIGTERM,signal.SIGINT): signal.signal(sig,cancelled)
    try: print(json.dumps(cli(), sort_keys=True))
    except Exception:
        print('{"status":"refused","code":"schema_candidate_unproved","productionMigrationReady":false}')
        raise SystemExit(1)
