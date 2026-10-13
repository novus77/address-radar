"""Hold the original authentication flock across exec, all DDL and cleanup."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat


def protected(path, maximum, expected=None):
    p = Path(path)
    if not p.is_absolute() or '..' in p.parts: raise PermissionError()
    for parent in (p.parent, *p.parent.parents):
        s = os.lstat(parent)
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022: raise PermissionError()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != 0 or before.st_gid != 0 or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > maximum: raise PermissionError()
        body = bytearray()
        while len(body) <= maximum:
            chunk = os.read(fd, min(65536,maximum+1-len(body)))
            if not chunk: break
            body.extend(chunk)
        after = os.fstat(fd); named = os.lstat(path)
        stamp = lambda s:(s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
        if len(body) != before.st_size or stamp(before) != stamp(after) or stamp(before) != stamp(named): raise PermissionError()
        if expected is not None and hashlib.sha256(body).hexdigest() != expected: raise PermissionError()
        return fd,bytes(body)
    except BaseException:
        os.close(fd); raise


def acquire_original_lock(path):
    fd,body = protected(path,0)
    try:
        s = os.fstat(fd)
        if stat.S_IMODE(s.st_mode) != 0o600 or body: raise PermissionError()
        fcntl.flock(fd,fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd); raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('node','node-sha256','entry','entry-sha256','plan','approved-plan-sha256','mode','original-entry'):
        parser.add_argument('--'+name,required=True)
    a=parser.parse_args()
    if os.geteuid()!=0 or a.mode not in ('preflight','roles','apply','reconcile'): raise PermissionError()
    candidate_fd,body=protected(a.plan,1048576)
    try:
        c=json.loads(body)
        canonical=json.dumps(c,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
        if hashlib.sha256(canonical).hexdigest()!=a.approved_plan_sha256: raise PermissionError()
        entry_fd,_=protected(a.entry,1048576,a.entry_sha256)
        node_fd,_=protected(a.node,134217728,a.node_sha256)
        base_fd,base_body=protected(c['schemaCandidate']['path'],1048576,c['schemaCandidate']['sha256'])
        base=json.loads(base_body)
        if hashlib.sha256(json.dumps(base,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!='7d33863ac425f4531ceb9c036cdadbe3ddf8768570899b6311a42088e5f08278':raise PermissionError()
        lock_fd=acquire_original_lock(str(Path(base['authenticationStateDirectory'])/'operation.lock'))
        # No unlock before exec: this exact open-file description is inherited until Node exits.
        os.set_inheritable(lock_fd,True)
        os.set_inheritable(node_fd,True)
        env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','SCHEMA_AUTH_LOCK_FD':str(lock_fd)}
        os.execve('/proc/self/fd/'+str(node_fd),[a.node,a.entry,'--plan',a.plan,'--mode',a.mode,
            '--approved-plan-sha256',a.approved_plan_sha256,'--original-entry',a.original_entry],env)
    finally: os.close(candidate_fd)


if __name__=='__main__':
    try: main()
    except Exception:
        print('{"status":"refused","code":"service_upgrade_lock_supervisor_refused","productionMigrationReady":false}')
        raise SystemExit(1)
