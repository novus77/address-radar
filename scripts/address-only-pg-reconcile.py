#!/usr/bin/env python3
"""Bounded peer-authenticated read-only reconciliation; no schema or business writes."""
import contextlib
import json
import os
import secrets
import select
import subprocess
import time

DATABASE = 'address_radar'
SCHEMA = 'address_radar_business'
SYSTEM = '7693392208475083526'
FINGERPRINT = 'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383'
SCHEMA_VERSION = 3

def require(value, reason):
    if not value:
        raise ValueError(reason)

def literal(value):
    require(isinstance(value, str) and 0 < len(value.encode()) <= 512
            and not any(ord(c) < 32 for c in value), 'invalid_sql_identifier_value')
    return "'" + value.replace("'", "''") + "'"

def validate_target(binding):
    target = binding['target']
    require(target['database'] == DATABASE and target['schema'] == SCHEMA
            and target['systemIdentifier'] == SYSTEM and target['schemaFingerprint'] == FINGERPRINT
            and target['serverAddress'] == '127.0.0.1' and target['serverPort'] == 5432, 'unexpected_target')

def reconciliation_sql(binding):
    validate_target(binding)
    operation = literal('address-only-v1:' + binding['operationId'])
    import_id, generation_id = literal(binding['importId']), literal(binding['generationId'])
    # The next exchange uses READ COMMITTED after this operation lock is acquired.
    lock_sql = 'SELECT pg_advisory_xact_lock(hashtextextended(' + operation + ',0));'
    observation = """SELECT json_build_object(
      'system',(pg_control_system()).system_identifier::text,
      'database',current_database(),'port',current_setting('port')::int,
      'schemaIdentity',(SELECT coalesce(json_agg(x),'[]'::json) FROM (
        SELECT singleton,ledger_format,database_name,schema_name,generation_id
        FROM address_radar_business.business_schema_identity LIMIT 2) x),
      'schemaLedger',(SELECT coalesce(json_agg(x),'[]'::json) FROM (
        SELECT version,fingerprint FROM address_radar_business.business_schema_ledger
        ORDER BY version DESC LIMIT 1) x),
      'importerSessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='address_radar_migrator'),
      'ledger',(SELECT coalesce(json_agg(x),'[]'::json) FROM (
        SELECT import_id,generation_id,source_fingerprint,proof_scope,revoked_at
        FROM address_radar_business.wallet_service_import_ledger WHERE import_id=%s LIMIT 2) x),
      'cohortCount',(SELECT count(*) FROM address_radar_business.wallet_service_profile_cohort WHERE generation_id=%s),
      'generationCount',(SELECT count(*) FROM address_radar_business.forward_strategy_generations WHERE generation_id=%s));""" % (import_id,generation_id,generation_id)
    return lock_sql, observation

def classify(binding, observed):
    validate_target(binding)
    require(isinstance(observed,dict), 'invalid_reconciliation_observation')
    require(observed.get('system') == SYSTEM and observed.get('database') == DATABASE
            and type(observed.get('port')) is int and observed['port'] == 5432
            and type(observed.get('importerSessions')) is int
            and observed['importerSessions'] == 0, 'target_or_importer_not_excluded')
    identity = observed.get('schemaIdentity')
    require(isinstance(identity,list) and len(identity) == 1 and isinstance(identity[0],dict),
            'schema_identity_mismatch')
    header = identity[0]
    require(header.get('singleton') is True and type(header.get('ledger_format')) is int
            and header['ledger_format'] == 1 and header.get('database_name') == DATABASE
            and header.get('schema_name') == SCHEMA and header.get('generation_id') == binding['generationId'],
            'schema_identity_mismatch')
    history = observed.get('schemaLedger')
    require(isinstance(history,list) and len(history) == 1 and isinstance(history[0],dict)
            and type(history[0].get('version')) is int and history[0]['version'] == SCHEMA_VERSION
            and history[0].get('fingerprint') == FINGERPRINT, 'schema_ledger_mismatch')
    ledger = observed.get('ledger')
    require(isinstance(ledger,list) and len(ledger)<=1, 'ambiguous_ledger')
    matches = False
    if not ledger:
        require(type(observed.get('cohortCount')) is int and observed['cohortCount'] == 0
                and type(observed.get('generationCount')) is int
                and observed['generationCount'] in (0, 1), 'absent_import_has_conflicting_data')
    if ledger:
        row = ledger[0]
        require(isinstance(row,dict) and isinstance(binding['planSha256'],str), 'committed_import_conflict')
        matches = (row.get('import_id') == binding['importId'] and row.get('generation_id') == binding['generationId']
            and row.get('source_fingerprint') == binding['planSha256'] and row.get('proof_scope') == 'address_only_registry'
            and row.get('revoked_at') is None and type(observed.get('generationCount')) is int
            and observed['generationCount'] == 1 and type(observed.get('cohortCount')) is int
            and observed['cohortCount'] > 0)
        require(matches, 'committed_import_conflict')
    return {'outcomeKnown':True,'importExists':bool(ledger),'committedMatches':matches,
            'importerExcluded':True,'advisoryLockHeld':True,'binding':json.loads(json.dumps(binding))}

def lock_proof_sql(operation_id):
    operation = literal('address-only-v1:' + operation_id)
    return """SELECT json_build_object(
      'backendPid',pg_backend_pid(),
      'transactionStartedAt',(SELECT xact_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()),
      'idleTimeout',current_setting('idle_in_transaction_session_timeout'),
      'isolation',current_setting('transaction_isolation'),
      'readOnly',current_setting('transaction_read_only'),
      'importerSessions',(SELECT count(*) FROM pg_stat_activity WHERE usename='address_radar_migrator'),
      'lockHeld',EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND mode='ExclusiveLock' AND granted AND objsubid=1
        AND classid=((hashtextextended(%s,0)>>32)&4294967295)::oid
        AND objid=(hashtextextended(%s,0)&4294967295)::oid));""" % (operation,operation)

class Session:
    def __init__(self, deadline):
        require(os.geteuid() == 0, 'native_root_required')
        self.deadline, self.child = deadline, None
        self.operation_id, self.lock_identity = None, None
        deadline.check()
        self.child = subprocess.Popen(['/usr/bin/sudo','-n','-u','postgres',
            '/usr/lib/postgresql/16/bin/psql','-X','-qAt','-v','ON_ERROR_STOP=1',
            '-h','/var/run/postgresql','-p','5432','-d',DATABASE],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
            env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},close_fds=True,start_new_session=True)
    def exchange(self, sql):
        self.deadline.check()
        require(self.child is not None, 'reconcile_session_closed')
        require(self.child.poll() is None, 'reconcile_session_exited')
        marker = 'boundary-' + secrets.token_hex(16)
        raw = (sql + '\nSELECT ' + literal(marker) + ';\n').encode()
        require(len(raw)<=16384, 'sql_budget')
        self.child.stdin.write(raw); self.child.stdin.flush()
        result = bytearray()
        while True:
            self.deadline.check()
            require(self.child.poll() is None, 'reconcile_session_exited')
            ready,_,_ = select.select([self.child.stdout],[],[],min(1,max(0,self.deadline.expires-time.monotonic())))
            if not ready:
                continue
            chunk = os.read(self.child.stdout.fileno(),65536)
            require(chunk, 'reconcile_session_closed')
            result.extend(chunk); require(len(result)<=65536, 'reconcile_output_budget')
            lines = bytes(result).splitlines()
            if lines and lines[-1] == marker.encode():
                require(bytes(result).endswith(b'\n'), 'reconcile_partial_boundary')
                return b'\n'.join(lines[:-1]).strip()
    def assert_alive_and_locked(self):
        """Fresh same-connection proof; call immediately before EACH restore mutation.

        Never reconnect or reacquire here: either would hide the loss of exclusion.
        No stored outcome or previously successful check is a substitute for this call.
        """
        self.deadline.check()
        require(self.child is not None, 'reconcile_session_closed')
        require(self.child.poll() is None, 'reconcile_session_exited')
        require(isinstance(self.operation_id,str), 'reconcile_operation_not_locked')
        self.exchange('SELECT pg_stat_clear_snapshot();')
        proof = json.loads(self.exchange(lock_proof_sql(self.operation_id)))
        require(isinstance(proof,dict) and proof.get('lockHeld') is True
                and proof.get('idleTimeout') == '0' and proof.get('isolation') == 'read committed'
                and proof.get('readOnly') == 'on' and type(proof.get('importerSessions')) is int
                and proof['importerSessions'] == 0 and type(proof.get('backendPid')) is int
                and proof['backendPid'] > 0 and isinstance(proof.get('transactionStartedAt'),str)
                and 0 < len(proof['transactionStartedAt']) <= 128, 'reconcile_lock_or_transaction_lost')
        identity = (proof['backendPid'],proof['transactionStartedAt'])
        require(self.lock_identity is None or self.lock_identity == identity, 'reconcile_connection_or_transaction_changed')
        self.lock_identity = identity
        self.deadline.check()
        require(self.child.poll() is None, 'reconcile_session_exited')
        return proof
    def close(self):
        if self.child is None:
            return
        child, self.child = self.child, None
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait(timeout=3)
        child.stdin.close(); child.stdout.close()

@contextlib.contextmanager
def reconcile_import(binding, deadline):
    """Caller retains the native controller lock throughout this context.

    No active migration-role session may coexist. The transaction-scoped operation
    advisory lock remains held through every source restoration mutation. The
    caller MUST invoke result['assert_alive_and_locked'] immediately before each
    filesystem or systemd mutation and abort recovery if it raises.
    """
    binding = json.loads(json.dumps(binding,allow_nan=False))
    lock_sql, observation = reconciliation_sql(binding)
    session = Session(deadline)
    try:
        session.exchange("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL search_path=pg_catalog; "
                         "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; "
                         "SET LOCAL idle_in_transaction_session_timeout=0;")
        require(session.exchange("SELECT current_setting('idle_in_transaction_session_timeout');") == b'0',
                'reconcile_idle_timeout_not_disabled')
        session.exchange(lock_sql)
        session.operation_id = binding['operationId']
        session.assert_alive_and_locked()
        session.exchange('SELECT pg_stat_clear_snapshot();')
        observed = json.loads(session.exchange(observation))
        result = classify(binding,observed)
        session.assert_alive_and_locked()
        result['assert_alive_and_locked'] = session.assert_alive_and_locked
        yield result
        session.assert_alive_and_locked()
        session.exchange('ROLLBACK;')
    finally:
        session.close()
