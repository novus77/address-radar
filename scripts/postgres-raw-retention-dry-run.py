"""Read-only bounded raw-retention inventory. No purge or execution interface."""
import argparse
import collections
import hashlib
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
import stat
from pathlib import Path

TOTAL_SECONDS = 30
OUTPUT_CAP = 1024*1024
ROOT_UID = 0
PASSFILE = '/etc/address-radar-postgres-backup/pgpass'
PSQL = '/usr/lib/postgresql/16/bin/psql'
SQL = """
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='3s';
SET LOCAL lock_timeout='1s';
SET LOCAL idle_in_transaction_session_timeout='5s';
WITH clock AS MATERIALIZED (
 SELECT floor(extract(epoch FROM transaction_timestamp())*1000)::bigint AS now_ms
), candidate_window AS MATERIALIZED (
 SELECT p.payload_id,p.source_namespace,p.source_event_id,p.semantic_fingerprint,
        p.session_id,p.received_at,p.payload_hash
 FROM address_radar_business.capture_raw_payloads p, clock c
 WHERE p.received_at < c.now_ms-1296000000
 ORDER BY p.received_at,p.payload_id LIMIT 500
), classified AS (
 SELECT p.payload_id,p.received_at,p.payload_hash,
 array_remove(ARRAY[
 'consumer_registry_unproven',
 CASE WHEN NOT EXISTS (
   SELECT 1 FROM address_radar_business.capture_normalization_jobs j
   WHERE (j.source_namespace,j.source_event_id,j.semantic_fingerprint)=
         (p.source_namespace,p.source_event_id,p.semantic_fingerprint)
 ) THEN 'normalization_missing' END,
 CASE WHEN EXISTS (
   SELECT 1 FROM address_radar_business.capture_normalization_jobs j
   WHERE (j.source_namespace,j.source_event_id,j.semantic_fingerprint)=
         (p.source_namespace,p.source_event_id,p.semantic_fingerprint)
   AND (j.status<>'completed' OR j.completed_at IS NULL)
 ) THEN 'normalization_unfinished' END,
 CASE WHEN EXISTS (
   SELECT 1 FROM address_radar_business.capture_normalization_jobs j
   LEFT JOIN address_radar_business.capture_normalized_results n USING(job_id)
   LEFT JOIN address_radar_business.capture_consumer_intents i USING(job_id)
   WHERE (j.source_namespace,j.source_event_id,j.semantic_fingerprint)=
         (p.source_namespace,p.source_event_id,p.semantic_fingerprint)
   AND (n.job_id IS NULL OR n.requires_review OR i.intent_id IS NULL OR i.status<>'dispatched'
     OR NOT EXISTS(SELECT 1 FROM address_radar_business.capture_consumer_jobs w WHERE w.intent_id=i.intent_id)
     OR EXISTS(SELECT 1 FROM address_radar_business.capture_consumer_jobs w
       LEFT JOIN address_radar_business.capture_consumer_receipts r
         USING(intent_id,consumer_name,consumer_version)
       WHERE w.intent_id=i.intent_id AND (w.status<>'completed' OR w.completed_at IS NULL OR r.intent_id IS NULL)))
 ) THEN 'consumer_unfinished_or_review' END,
 CASE WHEN EXISTS (
   SELECT 1 FROM address_radar_business.capture_normalization_jobs j
   WHERE (j.source_namespace,j.source_event_id,j.semantic_fingerprint)=
         (p.source_namespace,p.source_event_id,p.semantic_fingerprint)
   AND (EXISTS(SELECT 1 FROM address_radar_business.forward_trade_source_links l WHERE l.job_id=j.job_id)
     OR EXISTS(SELECT 1 FROM address_radar_business.wallet_capture_generation_bindings b
       JOIN address_radar_business.forward_token_discovery_links d ON d.generation_id=b.generation_id AND d.source_job_id=j.job_id
       WHERE (b.source_namespace,b.source_event_id,b.semantic_fingerprint)=
             (p.source_namespace,p.source_event_id,p.semantic_fingerprint)))
 ) THEN 'downstream_proof_reference' END,
 CASE WHEN EXISTS(SELECT 1 FROM address_radar_business.capture_source_gaps g WHERE g.session_id=p.session_id)
   THEN 'unverified_source_gap' END,
 CASE WHEN EXISTS(SELECT 1 FROM address_radar_business.wallet_service_fact_inputs LIMIT 1)
   THEN 'semantic_fact_reference_unresolved' END
 ],NULL) AS reasons FROM candidate_window p
)
SELECT json_build_object(
 'database',current_database(),
 'schemaVersion',(SELECT max(version) FROM address_radar_business.business_schema_ledger),
 'fingerprint',(SELECT fingerprint FROM address_radar_business.business_schema_ledger ORDER BY version DESC LIMIT 1),
 'generations',(SELECT coalesce(json_agg(generation_id ORDER BY generation_id),'[]'::json) FROM address_radar_business.forward_strategy_generations),
 'snapshot',txid_current_snapshot()::text,
 'asOfMs',(SELECT now_ms FROM clock),
 'rows',(SELECT coalesce(json_agg(c ORDER BY received_at,payload_id),'[]'::json) FROM classified c)
);
COMMIT;
"""

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()).hexdigest()


def report(value, generation, fingerprint):
    if (value['database'] != 'address_radar' or value['schemaVersion'] != 3
        or value['fingerprint'] != fingerprint or value['generations'] != [generation]
        or not isinstance(value['snapshot'], str)):
        raise ValueError('snapshot_identity_refused')
    now = value['asOfMs']
    if type(now) is not int or now < 1296000000 or now > 9007199254740991:
        raise ValueError('snapshot_time_refused')
    rows = value['rows']; cutoff = now-1296000000
    if not isinstance(rows,list) or len(rows)>500:
        raise ValueError('window_refused')
    counts = collections.Counter()
    seen = set()
    for row in rows:
        if (type(row['received_at']) is not int or not 0<=row['received_at']<cutoff
            or not isinstance(row['payload_id'],str) or row['payload_id'] in seen
            or not re.fullmatch('[0-9a-f]{64}',row['payload_hash'])
            or 'consumer_registry_unproven' not in row['reasons']):
            raise ValueError('candidate_refused')
        seen.add(row['payload_id']); counts.update(set(row['reasons']))
    return dict(protocol='postgres-raw-retention-dry-run-v1',database=value['database'],
        schema='address_radar_business',schemaVersion=3,schemaFingerprint=fingerprint,
        generationId=generation,snapshot=value['snapshot'],asOfMs=now,cutoffExclusiveMs=cutoff,
        rawHotDays=15,minimumProofDays=30,windowLimit=500,candidateCount=len(rows),
        windowMayBeTruncated=len(rows)==500,wholeDatabaseInventoryComplete=len(rows)<500,
        protectedCount=len(rows),protectedReasonCounts=dict(sorted(counts.items())),
        selectionSha256=digest(rows),protectedExclusionSha256=digest([r for r in rows]),
        wouldDeleteCount=0,proofPurge='deferred',executeSupported=False,
        automaticDeletionEnabled=False,productionDataWritten=False)


def check_parents(path):
    if not path.startswith('/') or os.path.normpath(path) != path or '//' in path:
        raise ValueError('path_refused')
    for parent in [Path('/'), *reversed(Path(path).parents[:-1])]:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != ROOT_UID or info.st_mode & 0o022:
            raise ValueError('parent_refused')


def read_pin(path, maximum, private=False):
    check_parents(path)
    fd = os.open(path, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != ROOT_UID
            or before.st_nlink != 1 or before.st_mode & 0o022
            or (private and stat.S_IMODE(before.st_mode) != 0o600)
            or before.st_size > maximum):
            raise ValueError('pin_refused')
        raw = bytearray()
        while len(raw) <= maximum:
            chunk = os.read(fd, min(65536, maximum+1-len(raw)))
            if not chunk: break
            raw.extend(chunk)
        after = os.fstat(fd)
        if len(raw)>maximum or (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns) != (after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):
            raise ValueError('pin_changed')
        return bytes(raw)
    finally:
        os.close(fd)


def validate_config(value):
    if (not isinstance(value,dict) or set(value) != {'generation','schemaFingerprint','passfile','passfileSha256','psqlSha256'}
        or value['passfile'] != PASSFILE
        or any(not isinstance(value[k],str) or not re.fullmatch('[0-9a-f]{64}',value[k])
               for k in ['schemaFingerprint','passfileSha256','psqlSha256'])
        or not isinstance(value['generation'],str) or not value['generation'].strip()
        or len(value['generation'].encode())>512
        or any(ord(c)<32 or ord(c)==127 for c in value['generation'])):
        raise ValueError('config_refused')
    return value


def query_environment(passfile=None):
    env = dict(PATH='/usr/bin:/bin',LANG='C',PGCONNECT_TIMEOUT='3',
               PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=3000')
    if passfile is not None: env['PGPASSFILE']=passfile
    return env


def query(psql, username, passfile=None, deadline=None):
    deadline = time.monotonic()+TOTAL_SECONDS if deadline is None else deadline
    if time.monotonic() >= deadline: raise ValueError('total_deadline')
    env = query_environment(passfile)
    process = subprocess.Popen([psql,'-X','-q','-A','-t','-w','-v','ON_ERROR_STOP=1',
        '-h','/run/postgresql','-p','5432','-U',username,'-d','address_radar'],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
        env=env,start_new_session=True)
    try:
        process.stdin.write(SQL.encode()); process.stdin.close()
        output=bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout,selectors.EVENT_READ)
            while selector.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0: raise ValueError('total_deadline')
                for key,_ in selector.select(min(remaining,0.1)):
                    chunk=os.read(key.fileobj.fileno(),65536)
                    if not chunk: selector.unregister(key.fileobj)
                    else: output.extend(chunk)
                    if len(output)>OUTPUT_CAP: raise ValueError('output_cap')
        remaining=deadline-time.monotonic()
        if remaining<=0: raise ValueError('total_deadline')
        if process.wait(timeout=remaining)!=0: raise ValueError('readonly_query_refused')
        return json.loads(output)
    finally:
        try: os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait()
        process.stdout.close()


def main():
    deadline=time.monotonic()+TOTAL_SECONDS
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--generation')
    parser.add_argument('--schema-fingerprint')
    parser.add_argument('--username',default='postgres')
    args=parser.parse_args()
    passfile=None
    if args.config:
        if args.generation is not None or args.schema_fingerprint is not None or args.username != 'postgres':
            raise ValueError('mixed_arguments_refused')
        config=validate_config(json.loads(read_pin(args.config,16384,private=True)))
        for path,key,cap,private in [(PASSFILE,'passfileSha256',65536,True),(PSQL,'psqlSha256',32*1024**2,False)]:
            if hashlib.sha256(read_pin(path,cap,private=private)).hexdigest()!=config[key]:
                raise ValueError('digest_refused')
        args.generation=config['generation']; args.schema_fingerprint=config['schemaFingerprint']
        args.username='address_radar_readonly_operator'; passfile=PASSFILE
    if (not isinstance(args.schema_fingerprint,str) or not re.fullmatch('[0-9a-f]{64}',args.schema_fingerprint)
        or not isinstance(args.generation,str) or not args.generation.strip() or len(args.generation.encode())>512
        or not re.fullmatch('[a-z_][a-z0-9_]{0,62}',args.username)):
        raise ValueError('arguments_refused')
    result=report(query(PSQL,args.username,passfile,deadline),args.generation,args.schema_fingerprint)
    if time.monotonic() >= deadline: raise ValueError('total_deadline')
    print(json.dumps(result,sort_keys=True,separators=(',',':')))

if __name__=='__main__':
    try: main()
    except Exception:
        print('readonly_retention_refused',file=sys.stderr)
        sys.exit(1)
