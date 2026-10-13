"""Apply code-owned runtime grants while all service roles remain NOLOGIN."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

BASE = Path('/var/lib/address-radar-maintenance-tools')
SOURCE_PLAN = BASE / 'provision-d70ab3c0ef4d89b12f40296418cb4b7a83bad561c7ec544d5123f1bf2d308f96/plan.json'
NODE = BASE / 'native-node-7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c/node'
SERVICES = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console']
ROLES = ['address_radar_' + service.replace('-', '_') for service in SERVICES]
ROLE_LIST = ','.join("'" + role + "'" for role in ROLES)
SCHEMA = 'address_radar_business'
PROTECTED = ['business_schema_identity', 'business_schema_ledger', 'migration_cutover_transitions',
             'migration_cutover_transitions_v2', 'migration_cutover_first_write_markers',
             'wallet_service_import_ledger', 'wallet_service_profile_cohort', 'wallet_service_profile_versions',
             'wallet_service_fact_inputs', 'wallet_service_fact_validators', 'wallet_service_fact_attestations']


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def transaction_sql(statements):
    require(isinstance(statements, list) and 0 < len(statements) < 256, 'invalid_grant_program')
    for statement in statements:
        require(isinstance(statement, str) and len(statement) < 65536
                and re.match(r'^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES|ALTER ROLE)\b', statement)
                and not re.search(r'\b(LOGIN|PASSWORD|SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b', statement)
                and not re.search(r'\bGRANT\s+ALL\b|\bTO\s+PUBLIC\b', statement), 'unsafe_grant_program')
    protected = ','.join("'" + name + "'" for name in PROTECTED)
    before = f"""DO $guard$ BEGIN
 IF current_database()<>'address_radar' OR current_user<>'postgres' OR session_user<>'postgres'
   OR current_setting('port')<>'5432'
   OR (SELECT system_identifier::text FROM pg_control_system())<>'7693392208475083526'
   OR (SELECT oid::text FROM pg_database WHERE datname=current_database())<>'16391'
   OR (SELECT count(*) FROM pg_roles WHERE rolname IN ({ROLE_LIST}))<>6
   OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ({ROLE_LIST})
       AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR rolconnlimit<>1))
   OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ({ROLE_LIST})))
   OR (SELECT fingerprint FROM {SCHEMA}.business_schema_ledger ORDER BY version DESC LIMIT 1)<>'b6ef9fd898f7b88d4942275567aca04360c55737f7fd2eecbae9baa8006df383'
   OR (SELECT count(*) FROM {SCHEMA}.business_schema_identity WHERE database_name='address_radar' AND schema_name='{SCHEMA}' AND generation_id='production-20261006-v1')<>1
   OR EXISTS(SELECT 1 FROM {SCHEMA}.migration_cutover_transitions_v2)
   OR EXISTS(SELECT 1 FROM {SCHEMA}.migration_cutover_first_write_markers)
   OR EXISTS(SELECT 1 FROM {SCHEMA}.wallet_service_profile_cohort)
 THEN RAISE EXCEPTION 'runtime_grant_target_or_role_changed'; END IF;
END $guard$;"""
    after = f"""DO $audit$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ({ROLE_LIST}) AND
   (r.rolcanlogin OR has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY')
    OR has_schema_privilege(r.oid,'{SCHEMA}','CREATE')))
 OR EXISTS (SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE r.rolname IN ({ROLE_LIST}) AND n.nspname='{SCHEMA}' AND c.relkind IN ('r','p')
   AND (NOT has_table_privilege(r.oid,c.oid,'SELECT') OR
      (c.relname IN ({protected}) AND
       (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES'))) OR
      (r.rolname='address_radar_console' AND
       (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))))
 OR EXISTS (SELECT 1 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
   WHERE r.rolname IN ({ROLE_LIST}) AND n.nspname='{SCHEMA}' AND c.relname='wallet_service_provider_budgets'
   AND a.attname NOT IN ('window_started_at','requests_used','cooldown_until')
   AND has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE'))
 OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN ({ROLE_LIST}) AND
   (has_column_privilege(r.oid,'{SCHEMA}.wallet_service_provider_budgets','maximum_requests','UPDATE')
    OR has_any_column_privilege(r.oid,'{SCHEMA}.wallet_service_provider_budgets','INSERT,REFERENCES')
    OR has_table_privilege(r.oid,'{SCHEMA}.wallet_service_provider_budgets','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
 THEN RAISE EXCEPTION 'runtime_privilege_boundary_changed'; END IF;
END $audit$;"""
    return '\n'.join(['BEGIN;', "SET LOCAL statement_timeout='10s';", "SET LOCAL lock_timeout='2s';",
                      "SELECT pg_advisory_xact_lock(hashtextextended('address-radar-runtime-grants',0));",
                      f'LOCK TABLE {SCHEMA}.business_schema_identity, {SCHEMA}.business_schema_ledger, {SCHEMA}.migration_cutover_transitions_v2, {SCHEMA}.migration_cutover_first_write_markers, {SCHEMA}.wallet_service_profile_cohort IN ACCESS EXCLUSIVE MODE;',
                      before, *statements, after, 'COMMIT;'])


def psql(sql):
    result = subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-q', '-v',
                             'ON_ERROR_STOP=1', '-d', 'address_radar', '-At'],
                            input=sql, capture_output=True, text=True, timeout=45)
    require(result.returncode == 0, 'native_sql_refused_or_commit_unknown')
    return result.stdout.strip()


def save(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', required=True)
    parser.add_argument('--bundle-sha256', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0 and re.fullmatch('[a-f0-9]{64}', args.bundle_sha256), 'root_pinned_entry_required')
    directory = Path(args.directory)
    require(directory == BASE / ('address-only-runtime-' + args.bundle_sha256), 'private_scope_required')
    module = directory / 'runtime.mjs'
    require(hashlib.sha256(module.read_bytes()).hexdigest() == args.bundle_sha256, 'module_pin')
    node_sha = hashlib.sha256(NODE.read_bytes()).hexdigest()
    subprocess.run([sys.executable, str(directory / 'measure.py'), '--directory', str(directory),
                    '--bundle-sha256', args.bundle_sha256, '--node-sha256', node_sha], check=True, timeout=25,
                   stdout=subprocess.DEVNULL)
    startup = json.loads((directory / 'startup-capacity-receipt.json').read_text())
    source = json.loads(SOURCE_PLAN.read_text())
    require(source['database'] == 'address_radar' and source['schema'] == SCHEMA
            and sorted(source['serviceRoles'].values()) == sorted(ROLES), 'source_plan_scope')
    sizes = json.loads(psql("BEGIN READ ONLY; SET LOCAL statement_timeout='3s'; SELECT json_build_object('database',pg_database_size('address_radar'),'rehearsal',pg_database_size('radar_rehearsal_663b3612f818d519'),'wal',(SELECT coalesce(sum(size),0) FROM pg_ls_waldir())); COMMIT;"))
    payload = dict(database=source['database'], schema=source['schema'], generation=source['generation'],
                   migratorRole=source['migratorRole'], serviceRoles=source['serviceRoles'], resources=source['resources'],
                   startup=startup, sizes=sizes)
    javascript = r"""
import { readFileSync } from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const tools=await import(process.env.ADDRESS_RADAR_CAPACITY_MODULE);
const {startup,sizes,...options}=input;
const measuredAt=startup.observedAt;
const capacity={status:'measured',hostId:'production-152-32-185-240',measurementRef:'native-startup/'+startup.moduleSha256,
 resourcePolicyFingerprint:tools.postgresBusinessResourcePolicyFingerprint(options.resources),measuredAt,
 validUntil:new Date(Date.parse(measuredAt)+60000).toISOString(),availableRamBytes:startup.host.availableRamBytes,
 measuredPeakRamBytes:startup.measuredPeakRamBytes,ramMarginBytes:String(256*1024*1024),availableDiskBytes:startup.host.availableDiskBytes,
 measuredPeakDiskBytes:String(Math.max(sizes.database,sizes.rehearsal)),measuredPeakWalBytes:String(sizes.wal),measuredPeakTempBytes:'0',diskMarginBytes:String(3*1024**3)};
const plan=tools.createExistingPostgresTargetGrantPlan({...options,capacity,now:new Date().toISOString()});
process.stdout.write(JSON.stringify({plan,planSha256:tools.migrationCutoverDigest(plan,2),capacity}));
"""
    generated = subprocess.run([str(NODE), '--max-old-space-size=64', '--input-type=module', '-e', javascript],
                               input=json.dumps(payload), text=True, capture_output=True, timeout=10,
                               env={'PATH': '/usr/bin:/bin', 'ADDRESS_RADAR_CAPACITY_MODULE': module.as_uri()})
    require(generated.returncode == 0, 'grant_plan_refused')
    result = json.loads(generated.stdout)
    require(result['plan']['activationAuthorized'] is False and result['plan']['productionMigrationReady'] is False,
            'unexpected_activation')
    sql = transaction_sql(result['plan']['statements'])
    save(directory / 'grant-intent.json', dict(version=1, planSha256=result['planSha256'],
         approvalRef='user-approved-complete-address-only-migration-20261008',
         sqlSha256=hashlib.sha256(sql.encode()).hexdigest(), startupMeasurement=startup,
         capacityScope='startup-and-existing-native-rehearsal-footprint-only', writesBusinessRows=False, enablesLogin=False))
    psql(sql)
    peer = json.loads(psql("BEGIN READ ONLY; SELECT json_build_object('roles',(SELECT count(*) FROM pg_roles WHERE rolname IN (" + ROLE_LIST + ") AND NOT rolcanlogin),'markers',(SELECT count(*) FROM address_radar_business.migration_cutover_first_write_markers),'cohort',(SELECT count(*) FROM address_radar_business.wallet_service_profile_cohort)); COMMIT;"))
    require(peer == dict(roles=6, markers=0, cohort=0), 'post_commit_state_changed')
    receipt = dict(status='runtime-grants-installed-login-disabled', planSha256=result['planSha256'],
                   roles=6, independentRuntimeLoginProbePassed=False, activationAuthorized=False,
                   steadyStateCapacityVerified=False, businessDataWritten=False, peer=peer)
    save(directory / 'grant-receipt.json', receipt)
    print(json.dumps(receipt, sort_keys=True))


if __name__ == '__main__':
    main()
