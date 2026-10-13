"""Verify protected recovery bytes and rerun locked actual native measurement; no journal writes."""
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

PRODUCER_SHA256 = '11fa16d2aa49da8cf55cb8c791421b24745f6cbebd8db18224cc7eca5b849e51'
RECORD_PRODUCER_SHA256 = 'eac155c618a5c7854744917cf2fa1b46949e063cbd842711c28aff4da1fd77ff'


def consume(helper_path, producer_path, proof_path, approved_raw_sha, plan_path, state_directory, mode="full", revalidator_path=None):
    if mode not in ("full","root-boundary"): raise PermissionError()
    import re
    if sys.platform != 'linux' or os.geteuid() != 0 or not re.fullmatch(r'[a-f0-9]{64}', approved_raw_sha): raise PermissionError()
    helper = load_frozen(helper_path)
    deadline = time.monotonic() + 60
    def remaining():
        value = deadline - time.monotonic()
        if value <= 0: raise TimeoutError()
        return value
    producer_pin, producer_body = helper.file_pin(producer_path, 1048576, remaining, True)
    if producer_pin['gid'] != 0 or producer_pin['sha256'] not in (PRODUCER_SHA256, RECORD_PRODUCER_SHA256): raise PermissionError()
    record_pin, record_body = helper.file_pin(proof_path, 65536, remaining, True, mode=0o600)
    if record_pin['gid'] != 0 or record_pin['sha256'] != approved_raw_sha: raise PermissionError()
    proof = helper.strict_json(record_body)
    if record_body != helper.encoded(proof) + b'\n' or proof.get('producer') != producer_pin: raise PermissionError()
    # Independently require approved producer and exact protected candidate/state paths before execution.
    if proof.get('candidate',{}).get('path') != plan_path: raise PermissionError()
    if proof.get('originalJournal',{}).get('path') != str(Path(state_directory)/'journal.json'): raise PermissionError()
    if proof.get('credential',{}).get('path') != str(Path(state_directory)/'secrets.json'): raise PermissionError()
    revalidator_path = revalidator_path or producer_path
    revalidator_pin, revalidator_body = helper.file_pin(revalidator_path,1048576,remaining,True)
    if revalidator_pin['gid'] != 0 or revalidator_pin['sha256'] != PRODUCER_SHA256: raise PermissionError()
    producer = helper.load_module(revalidator_body, revalidator_path, 'reviewed_pending_hba_revalidator')
    import signal
    old_handlers = {sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
    def interrupted(signum,frame): raise InterruptedError('readonly_child_cancelled')
    old_argv = sys.argv; old_auth = os.environ.get('REVIEWED_AUTH_SOURCE')
    try:
        for sig in old_handlers: signal.signal(sig,interrupted)
        sys.argv = [revalidator_path, helper_path, plan_path, state_directory]
        os.environ['REVIEWED_AUTH_SOURCE'] = proof['authenticationSource']['path']
        # No record arguments: locked fresh measurement only; no ACK conversion or journal mutation.
        result = producer.main(expected_recovery_proof=proof, verify_tcp=mode=="full", expected_record_producer_pin=producer_pin)
    finally:
        for sig,handler in old_handlers.items(): signal.signal(sig,handler)
        sys.argv = old_argv
        if old_auth is None: os.environ.pop('REVIEWED_AUTH_SOURCE',None)
        else: os.environ['REVIEWED_AUTH_SOURCE'] = old_auth
    expected_receipts = json.loads(json.dumps(proof['receipts']))
    if mode == 'root-boundary': expected_receipts['hba'].pop('tcp')
    expected_status = 'readonly_state_measured' if mode == 'full' else 'readonly_root_boundary_measured'
    if result.get('status') != expected_status or result.get('measuredReceiptsSha256') != hashlib.sha256(helper.encoded(expected_receipts)).hexdigest() or result.get('tcpMeasured') is not (mode=='full'):
        return {'status':'recovery_native_verification_refused','category':result.get('category','unproved_native_measurement'),
                'phase':result.get('phase'),'nativeSql':result.get('nativeSql'),
                'originalJournalPreserved':True,'productionMigrationReady':False}
    for path, maximum, file_mode, expected in ((producer_path,1048576,None,producer_pin),(proof_path,65536,0o600,record_pin),(revalidator_path,1048576,None,revalidator_pin)):
        current,_=helper.file_pin(path,maximum,remaining,False,mode=file_mode)
        if current != expected: raise PermissionError()
    return {'status':'recovery_current_native_verified' if mode=='full' else 'recovery_root_boundary_verified',
            'tcpAuthenticationChecked':mode=='full','boundary':result['boundary'],'recoveryRecordFileSha256':record_pin['sha256'],
            'recoveryRecordCanonicalSha256':hashlib.sha256(helper.encoded(proof)).hexdigest(),
            'planSha256':proof['planSha256'],'originalPending':'hba',
            'originalJournalPreserved':True,'credentialRenewed':False,'historicalHbaAckProved':False,
            'independentSoftwareTrustIssued':False,'productionMigrationReady':False,
            'serverTimeMs':result['serverTimeMs'],'measuredReceiptsSha256':result['measuredReceiptsSha256']}


def cli():
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('pin-helper','producer','recovery-proof','approved-record-file-sha256','plan','state-directory'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--revalidator')
    parser.add_argument('--mode',choices=('full','root-boundary'),default='full')
    args=parser.parse_args()
    return consume(args.pin_helper,args.producer,args.recovery_proof,args.approved_record_file_sha256,args.plan,args.state_directory,args.mode,args.revalidator)


if __name__=='__main__':
    try: result=cli()
    except Exception: result={'status':'recovery_proof_refused','productionMigrationReady':False}
    print(json.dumps(result,sort_keys=True))
    sys.exit(0 if result['status'] in ('recovery_current_native_verified','recovery_root_boundary_verified') else 1)
