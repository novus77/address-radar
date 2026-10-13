"""Read-only diagnostic wrapper for the frozen activation candidate builder."""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import types

BUILDER_SHA256 = 'f6486e6e32b4432561760a56c915931456ec1ada8acb234950885dea0b355c3f'
SAFE_CODES = frozenset(('capacity_age', 'empty_target_disk_guard', 'operation_deadline',
    'stage_deadline', 'unknown_instance_override', 'config_ancestor_changed', 'cluster_path_identity',
    'cluster_system_identity', 'tool_pin_changed', 'memory_pressure_unavailable',
    'frozen_dependency_pin', 'private_ancestor', 'target_pin', 'role_oid_pins',
    'empty_target_memory_guard', 'empty_target_resource_guard',
    'resource_guard_failed', 'host_command_failed', 'startup_unit_changed',
    'target_ownership_changed', 'native_target_changed', 'native_roles_changed',
    'server_clock', 'reviewed_role_contract', 'original_source_pin_changed',
    'original_plan_changed', 'initial_hba_changed', 'hba_owner_changed',
    'artifact_changed_before_candidate', 'builder_budget_exhausted',
    'frozen_provisioning_source_changed', 'frozen_activation_source_changed',
    'unknown_or_missing_field', 'provisioning_binding', 'credential_lifetime',
    'private_metadata', 'private_changed', 'unsafe_root_ancestor',
    'unsafe_root_parent', 'unsafe_root_file', 'ancestor_changed', 'file_changed',
    'output_parent_must_be_root0700', 'linux_root_required', 'native_root_required',
    'machine_identity_changed', 'target_identity_changed', 'database_identity_changed'))


def category(error):
    # Never stringify arbitrary exception arguments, SQL, paths or key names.
    if type(error).__name__ == 'Refused':
        code = error.args[0] if len(error.args) == 1 else None
        return code if isinstance(code, str) and code in SAFE_CODES else 'unclassified_contract_refusal'
    for kind, code in ((KeyError, 'interface_missing_field'), (TypeError, 'interface_type_mismatch'),
                       (FileExistsError, 'existing_output_preserved'), (PermissionError, 'filesystem_permission'),
                       (OSError, 'filesystem_or_process_failure'), (ValueError, 'invalid_native_value')):
        if isinstance(error, kind): return code
    return 'unclassified_failure'


class DiagnosticBoundary(Exception):
    pass


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


NATIVE_SQL_DIAGNOSTIC = None


def safe_sql_failure(returncode, stderr, body):
    import re
    value = {'exitCode': returncode if type(returncode) is int else None,
             'sqlState': None, 'stderrBytes': len(stderr), 'querySha256': hashlib.sha256(body).hexdigest()}
    # VERBOSITY=sqlstate emits only the code; never export unmatched diagnostic text.
    matches = re.findall(rb'(?:ERROR|FATAL|PANIC):[ \t]+([0-9A-Z]{5})(?=[\s:]|$)', stderr)
    if matches and len(set(matches)) == 1: value['sqlState'] = matches[0].decode('ascii')
    return value


def install_transport_probe(loaded):
    """Instrument this loaded module only, without modifying the frozen source."""
    original_command = loaded.NativeAdapter.command
    real_subprocess = loaded.subprocess
    original_popen = real_subprocess.Popen
    active = {'body': None, 'psql': None}
    def command(self, tool, arguments, body=None, postgres=False):
        if tool != 'psql': return original_command(self, tool, arguments, body, postgres)
        # Only the frozen preparation module's SELECT-only SQL is eligible.
        if not isinstance(body, bytes) or not body.lstrip().upper().startswith(b'SELECT '):
            raise PermissionError()
        active['body'] = body; active['psql'] = self.p['plan']['tools']['psql']['path']
        try:
            return original_command(self, tool, [*arguments, '-v', 'VERBOSITY=sqlstate'], body, postgres)
        finally:
            active['body'] = None; active['psql'] = None
    class CapturedProcess:
        def __init__(self, process, body): self.process = process; self.body = body
        def __getattr__(self, key): return getattr(self.process, key)
        def communicate(self, *args, **kwargs):
            global NATIVE_SQL_DIAGNOSTIC
            stdout, stderr = self.process.communicate(*args, **kwargs)
            NATIVE_SQL_DIAGNOSTIC = safe_sql_failure(self.process.returncode, stderr, self.body)
            return stdout, stderr
    def popen(argv, *args, **kwargs):
        process = original_popen(argv, *args, **kwargs)
        if active['body'] is not None and active['psql'] in argv:
            return CapturedProcess(process, active['body'])
        return process
    proxy = types.SimpleNamespace(**vars(real_subprocess)); proxy.Popen = popen
    loaded.subprocess = proxy
    loaded.NativeAdapter.command = command


PHASE = 'bootstrap'


def instrument(module):
    """Fixed labels only: no runtime values, SQL or exception arguments."""
    global PHASE
    def wrap(function, phase):
        def call(*args, **kwargs):
            global PHASE
            PHASE = phase
            return function(*args, **kwargs)
        return call
    original_load = module.load_module
    def load(body, path, name):
        loaded = original_load(body, path, name)
        if name == 'frozen439':
            install_transport_probe(loaded)
            loaded.validate_plan = wrap(loaded.validate_plan, 'provisioning_plan_validation')
            for method, phase in (('resource_guard', 'fresh_resource_guard'),
                                  ('observe', 'prepared_target_observation'), ('sql', 'target_metadata_query')):
                original = getattr(loaded.NativeAdapter, method)
                setattr(loaded.NativeAdapter, method, wrap(original, phase))
        elif name == 'frozen_activation':
            loaded.validate_plan = wrap(loaded.validate_plan, 'activation_plan_validation')
        return loaded
    module.load_module = load
    for method, phase in (('file_pin', 'protected_artifact_read'), ('require_original_pin', 'original_artifact_binding'),
                          ('validate_observation', 'target_metadata_validation')):
        setattr(module, method, wrap(getattr(module, method), phase))


def main():
    if sys.platform != 'linux' or os.geteuid() != 0: raise PermissionError()
    # Invocation: wrapper FROZEN_BUILDER -- <original explicit builder arguments>
    if len(sys.argv) < 4 or sys.argv[2] != '--': raise ValueError()
    module = load_frozen(sys.argv[1]); instrument(module); sys.argv = [sys.argv[1], *sys.argv[3:]]
    def no_write(*args, **kwargs): raise DiagnosticBoundary()
    module.write_once = no_write
    module.cli()


if __name__ == '__main__':
    try:
        main()
        result = {'status': 'refused', 'category': 'unexpected_return'}
    except DiagnosticBoundary:
        result = {'status': 'readonly_builder_checks_passed', 'candidateWritten': False}
    except Exception as error:
        location = None; tb = error.__traceback__
        while tb:
            frame = tb.tb_frame
            if frame.f_code.co_filename.endswith('.py'):
                location = {'module': Path(frame.f_code.co_filename).name, 'line': tb.tb_lineno}
            tb = tb.tb_next
        result = {'status': 'refused', 'category': category(error), 'phase': PHASE, 'location': location}
    if NATIVE_SQL_DIAGNOSTIC is not None: result['nativeSql'] = NATIVE_SQL_DIAGNOSTIC
    result['productionMigrationReady'] = False
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result['status'] == 'readonly_builder_checks_passed' else 1)
