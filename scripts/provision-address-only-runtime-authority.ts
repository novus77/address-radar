import { createHash, createHmac, createPublicKey, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresAuthorityClient } from '../packages/database/src/postgres-authority-client.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const GENERATION = 'production-20261006-v1';
const ROOT = '/var/lib/address-radar-maintenance-tools/';
const SERVICES = ['scanner', 'automation', 'wallet-monitor', 'wallet-analysis', 'historical-backfill', 'console', 'migrator'] as const;
const READ_TABLES = ['business_schema_identity', 'business_schema_ledger', 'wallet_service_import_ledger',
  'wallet_service_fact_validators', 'wallet_service_provider_budgets', 'wallet_service_fact_inputs', 'wallet_service_fact_attestations',
  'forward_purchase_samples', 'forward_trade_revisions', 'forward_strategy_generations'];
const INSERT_TABLES = ['wallet_service_fact_inputs', 'wallet_service_fact_attestations', 'wallet_forward_signal_wake_intents'];
const AUTHORITY_TABLES = ['wallet_service_import_ledger', 'wallet_service_provider_budgets', 'wallet_service_fact_validators'];
const demand: (value: unknown) => asserts value = value => { if (!value) throw new Error('runtime_authority_refused'); };
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value)
  && !value.startsWith('pg_') && !['public', 'information_schema', 'template0', 'template1'].includes(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\x00-\x20\x7f]/.test(value) && !value.includes('://');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const epoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const exact = (value: unknown, keys: readonly string[]): boolean => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const safePath = (path: string): boolean => typeof path === 'string' && resolve(path) === path && path.startsWith(ROOT);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  demand(value !== undefined && !(typeof value === 'number' && !Number.isSafeInteger(value)));
  return JSON.stringify(value);
}
export function runtimeAuthorityFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
interface Pin { path: string; sha256: string }
export interface RuntimeAuthorityCredential {
  connectionString: string; gatewayDeliveryEnabled: false; service: 'execution-publisher'; username: string;
}
export interface RuntimeAuthorityJob {
  version: 1; approvalRef: string; approvedAt: number; expiresAt: number;
  target: { database: string; schema: string; adminUsername: string; serverAddress: string; serverPort: number;
    systemIdentifier: string; generationId: string; schemaVersion: number; schemaFingerprint: string };
  publisherRole: string; forbiddenRoles: Record<typeof SERVICES[number], string>;
  cohort: { importId: string; wallets: number; entities: number; sha256: string };
  credential: Pin; adminCredential: Pin | { mode: 'peer'; socketDirectory: string };
  providers: { providerId: string; origin: string; importId: string; evidenceSha256: string; importedAt: number;
    windowStartedAt: number; requestsUsed: number; cooldownUntil: number }[];
  validators: { kind: 'execution' | 'price'; validatorId: string; importId: string; evidenceSha256: string;
    importedAt: number; validFrom: number; validUntil: number; keyId: string; publicKey: string;
    actorId: string; authorizationRef: string; reviewedSourceProviders: string[] }[];
}
export interface AuthorityClient {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
function credentialPassword(credential: { connectionString: string; username: string }, target: RuntimeAuthorityJob['target']): string {
  demand(typeof credential.connectionString === 'string' && credential.connectionString.length <= 4096);
  const url = new URL(credential.connectionString);
  demand(url.protocol === 'postgresql:' && decodeURIComponent(url.username) === credential.username
    && url.hostname.replace(/^\[|\]$/g, '') === target.serverAddress && Number(url.port || 5432) === target.serverPort
    && decodeURIComponent(url.pathname) === '/' + target.database && !url.search && !url.hash);
  const password = decodeURIComponent(url.password);
  demand(password.length >= 32 && password.length <= 256 && !/[\x00-\x1f\x7f]/.test(password));
  return password;
}
function validateInput(job: RuntimeAuthorityJob, credential: RuntimeAuthorityCredential, at: number): void {
  demand(exact(job, ['version', 'approvalRef', 'approvedAt', 'expiresAt', 'target', 'publisherRole', 'forbiddenRoles', 'cohort',
    'credential', 'adminCredential', 'providers', 'validators']) && job.version === 1 && text(job.approvalRef)
    && epoch(at) && epoch(job.approvedAt) && epoch(job.expiresAt) && job.approvedAt <= at && at < job.expiresAt
    && job.expiresAt - job.approvedAt <= 86400000);
  const t = job.target;
  demand(exact(t, ['database', 'schema', 'adminUsername', 'serverAddress', 'serverPort', 'systemIdentifier',
    'generationId', 'schemaVersion', 'schemaFingerprint']) && [t.database, t.schema, t.adminUsername].every(identifier)
    && ['127.0.0.1', '::1'].includes(t.serverAddress) && Number.isSafeInteger(t.serverPort) && t.serverPort > 0 && t.serverPort <= 65535
    && /^[1-9][0-9]{0,19}$/.test(t.systemIdentifier) && t.generationId === GENERATION
    && Number.isSafeInteger(t.schemaVersion) && t.schemaVersion >= 2 && t.schemaVersion <= 100 && hex(t.schemaFingerprint));
  demand(exact(job.forbiddenRoles, SERVICES));
  const forbidden = Object.values(job.forbiddenRoles);
  demand(forbidden.every(identifier) && new Set(forbidden).size === 7 && identifier(job.publisherRole)
    && job.publisherRole !== 'postgres' && job.publisherRole !== t.adminUsername && !forbidden.includes(job.publisherRole));
  demand(exact(job.cohort, ['importId', 'wallets', 'entities', 'sha256']) && text(job.cohort.importId)
    && [job.cohort.wallets, job.cohort.entities].every(value => Number.isSafeInteger(value) && value > 0 && value <= 10000)
    && hex(job.cohort.sha256));
  demand(exact(job.credential, ['path', 'sha256']) && safePath(job.credential.path) && hex(job.credential.sha256));
  if ('mode' in job.adminCredential) demand(exact(job.adminCredential, ['mode', 'socketDirectory']) && job.adminCredential.mode === 'peer'
    && t.adminUsername === 'postgres' && typeof job.adminCredential.socketDirectory === 'string'
    && job.adminCredential.socketDirectory.startsWith('/') && resolve(job.adminCredential.socketDirectory) === job.adminCredential.socketDirectory);
  else demand(exact(job.adminCredential, ['path', 'sha256']) && safePath(job.adminCredential.path) && hex(job.adminCredential.sha256)
    && job.credential.path !== job.adminCredential.path);
  demand(exact(credential, ['connectionString', 'gatewayDeliveryEnabled', 'service', 'username'])
    && credential.username === job.publisherRole && credential.service === 'execution-publisher' && credential.gatewayDeliveryEnabled === false);
  demand(/^[a-f0-9]{64}$/.test(credentialPassword(credential, t)));
  demand(Array.isArray(job.providers) && job.providers.length > 0 && job.providers.length <= 16
    && Array.isArray(job.validators) && job.validators.length > 0 && job.validators.length <= 16);
  const imports = new Set([job.cohort.importId]), providers = new Set<string>(), origins = new Set<string>(), validators = new Set<string>();
  for (const p of job.providers) {
    demand(exact(p, ['providerId', 'origin', 'importId', 'evidenceSha256', 'importedAt', 'windowStartedAt', 'requestsUsed', 'cooldownUntil'])
      && text(p.providerId) && text(p.importId) && hex(p.evidenceSha256) && epoch(p.importedAt) && p.importedAt <= at
      && epoch(p.windowStartedAt) && p.windowStartedAt <= at && p.windowStartedAt >= p.importedAt
      && p.requestsUsed === 0 && p.cooldownUntil === 0 && typeof p.origin === 'string' && p.origin.length <= 512);
    const url = new URL(p.origin);
    demand(url.protocol === 'https:' && url.origin === p.origin && !url.username && !url.password && !url.search && !url.hash
      && !providers.has(p.providerId) && !origins.has(p.origin) && !imports.has(p.importId));
    imports.add(p.importId); providers.add(p.providerId); origins.add(p.origin);
  }
  for (const v of job.validators) {
    demand(exact(v, ['kind', 'validatorId', 'importId', 'evidenceSha256', 'importedAt', 'validFrom', 'validUntil', 'keyId', 'publicKey',
      'actorId', 'authorizationRef', 'reviewedSourceProviders']) && ['execution', 'price'].includes(v.kind)
      && [v.validatorId, v.importId, v.keyId, v.actorId, v.authorizationRef].every(text) && hex(v.evidenceSha256)
      && epoch(v.importedAt) && epoch(v.validFrom) && epoch(v.validUntil) && v.importedAt <= v.validFrom && v.validFrom <= at && at < v.validUntil
      && job.expiresAt <= v.validUntil
      && !imports.has(v.importId) && !validators.has(v.validatorId + ':' + v.kind)
      && typeof v.publicKey === 'string' && v.publicKey.length <= 4096 && v.publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')
      && createPublicKey(v.publicKey).asymmetricKeyType === 'ed25519'
      && Array.isArray(v.reviewedSourceProviders) && v.reviewedSourceProviders.length > 0 && v.reviewedSourceProviders.length <= 16
      && v.reviewedSourceProviders.every(value => text(value) && providers.has(value))
      && !providers.has(v.validatorId) && !providers.has(v.actorId)
      && new Set(v.reviewedSourceProviders).size === v.reviewedSourceProviders.length);
    imports.add(v.importId); validators.add(v.validatorId + ':' + v.kind);
  }
  demand(Buffer.byteLength(canonical(job)) <= 65536);
}
export function validateRuntimeAuthorityInput(job: RuntimeAuthorityJob, credential: RuntimeAuthorityCredential, at: number): void {
  try { validateInput(job, credential, at); } catch { throw new Error('runtime_authority_refused'); }
}
export function createScramVerifier(password: string): string {
  demand(/^[a-f0-9]{64}$/.test(password));
  const salt = randomBytes(16), salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  return 'SCRAM-SHA-256$4096:' + salt.toString('base64') + '$'
    + createHash('sha256').update(client).digest('base64') + ':' + createHmac('sha256', salted).update('Server Key').digest('base64');
}
export function passwordMatchesVerifier(password: string, verifier: unknown): boolean {
  if (typeof verifier !== 'string') return false;
  const match = /^SCRAM-SHA-256\$4096:([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/.exec(verifier);
  if (!match) return false;
  const salt = Buffer.from(match[1]!, 'base64'), stored = Buffer.from(match[2]!, 'base64'), server = Buffer.from(match[3]!, 'base64');
  if (salt.length !== 16 || stored.length !== 32 || server.length !== 32) return false;
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  return timingSafeEqual(stored, createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest())
    && timingSafeEqual(server, createHmac('sha256', salted).update('Server Key').digest());
}
const quote = (name: string): string => { demand(identifier(name)); return '"' + name + '"'; };
function roleSettings(schema: string): string[] {
  return ['search_path=' + schema + ', pg_catalog', 'statement_timeout=5s', 'lock_timeout=1s',
    'idle_in_transaction_session_timeout=10s', 'work_mem=1MB', 'max_parallel_workers_per_gather=0'];
}
const roleSql = `/* provision-role-state */ SELECT r.*,
  (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) memberships,
  (s.setconfig @> $2::text[] AND cardinality(s.setconfig)=cardinality($2::text[])
    AND NOT EXISTS(SELECT 1 FROM pg_db_role_setting x WHERE x.setrole=r.oid AND x.setdatabase<>0)) settings
  FROM pg_authid r LEFT JOIN pg_db_role_setting s ON s.setrole=r.oid AND s.setdatabase=0 WHERE r.rolname=$1`;
function validateRole(rows: Record<string, unknown>[], password: string): boolean {
  demand(rows.length <= 1);
  if (!rows.length) return false;
  const r = rows[0]!;
  demand(r.rolcanlogin === true && ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolinherit'].every(key => r[key] === false)
    && r.rolconnlimit === 1 && r.rolvaliduntil === null && r.memberships === 0 && r.settings === true && passwordMatchesVerifier(password, r.rolpassword));
  return true;
}
function aclSql(existing: boolean): string {
  const acl = (privilege: string, columns = false): string => {
    const permission = existing
      ? `(has_table_privilege($1,c.oid,'${privilege}')${columns ? ` OR has_any_column_privilege($1,c.oid,'${privilege}')` : ''})`
      : `(EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0 AND a.privilege_type='${privilege}')${columns
        ? ` OR EXISTS(SELECT 1 FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a WHERE at.attrelid=c.oid AND a.grantee=0 AND a.privilege_type='${privilege}')` : ''})`;
    // WHERE predicates may be reordered or pushed through the derived table by PostgreSQL.
    return `(CASE WHEN c.relkind IN ('r','p','v','m','f') THEN ${permission} ELSE false END)`;
  };
  return `/* provision-role-acl */ SELECT * FROM (SELECT n.nspname schema,c.relname name,c.relkind kind,c.relpersistence persistence,
    ${acl('SELECT')} select_all,${acl('SELECT', true)} select_any,${acl('INSERT')} insert_all,${acl('INSERT', true)} insert_any,
    ${acl('UPDATE', true)} update_any,${acl('DELETE')} delete_any,${acl('TRUNCATE')} truncate_any,
    ${acl('REFERENCES', true)} references_any,${acl('TRIGGER')} trigger_any
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')) a
    WHERE select_any OR insert_any OR update_any OR delete_any OR truncate_any OR references_any OR trigger_any
    ORDER BY schema,name LIMIT 2001`;
}
function validateAcl(rows: Record<string, unknown>[], schema: string, existing: boolean): void {
  demand(rows.length <= 2000);
  const seen = new Set<string>();
  for (const r of rows) {
    demand(r.schema === schema && typeof r.name === 'string' && !seen.has(r.name) && r.kind === 'r' && r.persistence === 'p');
    seen.add(r.name);
    const read = READ_TABLES.includes(r.name), insert = INSERT_TABLES.includes(r.name);
    demand(read || insert);
    for (const flag of ['select_all', 'select_any', 'insert_all', 'insert_any', 'update_any', 'delete_any', 'truncate_any', 'references_any', 'trigger_any']) {
      const expected = flag.startsWith('select') ? read : flag.startsWith('insert') ? insert : false;
      demand(typeof r[flag] === 'boolean' && (existing ? r[flag] === expected : r[flag] === false || expected));
    }
  }
  if (existing) demand(seen.size === new Set([...READ_TABLES, ...INSERT_TABLES]).size);
}
function environmentSql(existing: boolean): string {
  const schemaCreate = existing ? `has_schema_privilege($1,n.oid,'CREATE')` : `EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee=0 AND a.privilege_type='CREATE')`;
  const databaseCreate = existing ? `has_database_privilege($1,d.oid,'CREATE')` : `EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0 AND a.privilege_type='CREATE')`;
  const execute = existing ? `has_function_privilege($1,p.oid,'EXECUTE')` : `EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')`;
  const sequencePermission = existing ? `has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE')` : `EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a WHERE a.grantee=0)`;
  // The function itself must be guarded; an AND relkind filter does not constrain evaluation order.
  const sequence = `(CASE WHEN c.relkind='S' THEN ${sequencePermission} ELSE false END)`;
  return `/* provision-role-environment */ SELECT
    NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND ${schemaCreate})
    AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND ${databaseCreate})
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND p.prosecdef AND ${execute})
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND c.relkind='S' AND ${sequence})
    ${existing ? `AND has_database_privilege($1,$3,'CONNECT') AND has_schema_privilege($1,$2,'USAGE')
      AND has_function_privilege($1,'pg_catalog.pg_control_system()','EXECUTE')
      AND NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=(SELECT oid FROM pg_roles WHERE rolname=$1) AND deptype='o')
      AND NOT EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.is_grantable)
      AND NOT EXISTS(SELECT 1 FROM pg_attribute at CROSS JOIN LATERAL aclexplode(at.attacl) a
        WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.is_grantable)
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
        WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.is_grantable)
      AND NOT EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
        WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.is_grantable)
      AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND (a.is_grantable OR p.oid<>'pg_catalog.pg_control_system()'::regprocedure))` : ''} AS safe`;
}
function normalized(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    ['imported_at', 'window_started_at', 'cooldown_until', 'valid_from', 'valid_until'].includes(key) && value !== null ? String(value) : value]));
}

/** The caller supplies one dedicated administrative connection, never a six-service runtime. */
export async function provisionRuntimeAuthority(job: RuntimeAuthorityJob, credential: RuntimeAuthorityCredential, client: AuthorityClient,
  options: { apply?: boolean; now?: () => number; startedAt?: number; peerAdmin?: boolean } = {}) {
  const now = options.now ?? Date.now, startedAt = options.startedAt ?? now();
  let began = false, committing = false, statements = 0;
  const check = () => { const at = now(); demand(at >= startedAt && at - startedAt < 30000 && at < job.expiresAt); };
  const query = async (sql: string, values: readonly unknown[] = []) => {
    check(); demand(++statements <= 384);
    const result = await client.query(sql, values);
    demand(Buffer.byteLength(JSON.stringify(result.rows)) <= 4 * 1024 * 1024);
    check(); return result.rows;
  };
  try {
    validateRuntimeAuthorityInput(job, credential, now()); check();
    const t = job.target, schema = quote(t.schema), role = quote(job.publisherRole), password = credentialPassword(credential, t);
    await query(options.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY'); began = true;
    await query(`SELECT set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),
      set_config('idle_in_transaction_session_timeout','10000',true),set_config('search_path',$1,true),
      set_config('work_mem','1MB',true),set_config('max_parallel_workers_per_gather','0',true)`, [t.schema + ',pg_catalog']);
    await query(`SELECT set_config('log_statement','none',true),set_config('log_min_error_statement','panic',true),
      set_config('log_min_duration_statement','-1',true),set_config('log_min_duration_sample','-1',true),
      set_config('log_transaction_sample_rate','0',true),set_config('log_parameter_max_length','0',true),
      set_config('log_parameter_max_length_on_error','0',true)`);
    await query(`DO $settings$ BEGIN
      IF current_setting('pgaudit.log',true) IS NOT NULL THEN PERFORM set_config('pgaudit.log','none',true); END IF;
      IF current_setting('pg_stat_statements.track',true) IS NOT NULL THEN PERFORM set_config('pg_stat_statements.track','none',true); END IF;
      END $settings$`);
    const identity = await query(`/* provision-identity */ SELECT current_database() database,current_user username,session_user session_username,
      COALESCE(host(inet_server_addr()),'local') AS "serverAddress",COALESCE(inet_server_port(),0) AS "serverPort",
      (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser,
      EXISTS(SELECT 1 FROM ${schema}.forward_strategy_generations WHERE generation_id=$1) AS "generationExists",
      (SELECT generation_id FROM ${schema}.business_schema_identity WHERE singleton=true) AS "schemaGeneration",
      (SELECT version FROM ${schema}.business_schema_ledger ORDER BY version DESC LIMIT 1) AS "installedVersion",
      (SELECT fingerprint FROM ${schema}.business_schema_ledger ORDER BY version DESC LIMIT 1) AS "installedFingerprint",
      (SELECT count(*)::int FROM pg_roles WHERE rolname=ANY($2::text[])) AS "forbiddenCount",
      (SELECT count(*)=cardinality($3::text[]) AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity
        AND NOT EXISTS(SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal AND tr.tgenabled<>'D'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$4 AND c.relname=ANY($3::text[])) AS "objectsSafe"`,
    [GENERATION, Object.values(job.forbiddenRoles), [...new Set([...READ_TABLES, ...INSERT_TABLES, ...AUTHORITY_TABLES, 'wallet_service_profile_cohort'])], t.schema]);
    demand(identity.length === 1);
    const actual = identity[0]!;
    demand(actual.database === t.database && actual.username === t.adminUsername && actual.session_username === t.adminUsername
      && (options.peerAdmin ? actual.serverAddress === 'local' && Number(actual.serverPort) === 0
        : actual.serverAddress === t.serverAddress && Number(actual.serverPort) === t.serverPort) && actual.systemIdentifier === t.systemIdentifier
      && actual.superuser === true && actual.generationExists === true && actual.schemaGeneration === GENERATION
      && Number(actual.installedVersion) === t.schemaVersion && actual.installedFingerprint === t.schemaFingerprint
      && actual.forbiddenCount === 7 && actual.objectsSafe === true);
    if (options.apply) {
      const locked = await query('/* provision-lock */ SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked', ['runtime-authority:' + GENERATION]);
      demand(locked.length === 1 && locked[0]!.locked === true);
      await query('LOCK TABLE ' + AUTHORITY_TABLES.map(name => schema + '.' + quote(name)).join(',') + ' IN SHARE ROW EXCLUSIVE MODE');
      await query('LOCK TABLE ' + schema + '.wallet_service_profile_cohort IN SHARE MODE');
    }
    const cohort = (await query(`/* provision-cohort */ SELECT row_to_json(c) value FROM ${schema}.wallet_service_profile_cohort c
      WHERE generation_id=$1 ORDER BY subject_key LIMIT 10001`, [GENERATION])).map(row => row.value as Record<string, unknown>);
    demand(cohort.length === job.cohort.wallets && cohort.every(row => row.import_id === job.cohort.importId)
      && new Set(cohort.map(row => row.entity_id)).size === job.cohort.entities && runtimeAuthorityFingerprint(cohort) === job.cohort.sha256);
    const existingRole = validateRole(await query(roleSql, [job.publisherRole, roleSettings(t.schema)]), password);
    demand((await query(environmentSql(existingRole), existingRole ? [job.publisherRole, t.schema, t.database] : []))[0]?.safe === true);
    validateAcl(await query(aclSql(existingRole), existingRole ? [job.publisherRole] : []), t.schema, existingRole);
    const missing: { table: string; row: Record<string, unknown> }[] = [];
    async function ledger(importId: string, evidenceSha256: string, proofScope: string, importedAt: number) {
      const expected = { import_id: importId, generation_id: GENERATION, approval_ref: job.approvalRef,
        source_fingerprint: evidenceSha256, proof_scope: proofScope, imported_at: String(importedAt), revoked_at: null };
      const live = await query(`/* provision-ledger-read */ SELECT * FROM ${schema}.wallet_service_import_ledger WHERE import_id=$1`, [importId]);
      demand(live.length <= 1);
      if (live.length) demand(canonical(normalized(live[0]!)) === canonical(expected));
      else missing.push({ table: 'wallet_service_import_ledger', row: expected });
    }
    for (const p of job.providers) {
      await ledger(p.importId, runtimeAuthorityFingerprint({ approvalRef: job.approvalRef, proofScope: 'provider_contract', configuration: p }), 'provider_contract', p.importedAt);
      const expected = { generation_id: GENERATION, provider_id: p.providerId, origin: p.origin, import_id: p.importId,
        window_started_at: String(p.windowStartedAt), window_ms: 60000, maximum_requests: 60, requests_used: p.requestsUsed,
        cooldown_until: String(p.cooldownUntil), maximum_concurrency: 1 };
      const live = await query(`/* provision-budget-read */ SELECT * FROM ${schema}.wallet_service_provider_budgets
        WHERE generation_id=$1 AND (provider_id=$2 OR origin=$3) LIMIT 3`, [GENERATION, p.providerId, p.origin]);
      demand(live.length <= 1);
      if (!live.length) missing.push({ table: 'wallet_service_provider_budgets', row: expected });
      else {
        const current = normalized(live[0]!);
        // Usage fields belong to collectors. Replaying an approval must never refill their budget.
        demand(epoch(Number(current.window_started_at)) && Number(current.window_started_at) >= p.windowStartedAt && Number(current.window_started_at) <= now()
          && Number.isSafeInteger(current.requests_used) && Number(current.requests_used) >= 0 && Number(current.requests_used) <= 60
          && epoch(Number(current.cooldown_until)));
        demand(canonical({ ...current, window_started_at: expected.window_started_at, requests_used: expected.requests_used,
          cooldown_until: expected.cooldown_until }) === canonical(expected));
      }
    }
    for (const v of job.validators) {
      await ledger(v.importId, runtimeAuthorityFingerprint({ approvalRef: job.approvalRef, proofScope: 'validator_authority', configuration: v }), 'validator_authority', v.importedAt);
      const expected = { generation_id: GENERATION, validator_id: v.validatorId, kind: v.kind, import_id: v.importId,
        valid_from: String(v.validFrom), valid_until: String(v.validUntil), revoked_at: null };
      const live = await query(`/* provision-validator-read */ SELECT * FROM ${schema}.wallet_service_fact_validators
        WHERE generation_id=$1 AND validator_id=$2 AND kind=$3`, [GENERATION, v.validatorId, v.kind]);
      demand(live.length <= 1);
      if (live.length) demand(canonical(normalized(live[0]!)) === canonical(expected));
      else missing.push({ table: 'wallet_service_fact_validators', row: expected });
    }
    const changed = missing.length > 0 || !existingRole;
    if (options.apply) {
      for (const item of missing) {
        const columns = Object.keys(item.row);
        await query('INSERT INTO ' + schema + '.' + quote(item.table) + '(' + columns.map(quote).join(',') + ') VALUES('
          + columns.map((_, index) => '$' + (index + 1)).join(',') + ')', Object.values(item.row));
      }
      if (!existingRole) {
        // Parameters never become SQL text. Logging/audit/statistics are suppressed before binding the verifier.
        await query("SELECT set_config('address_radar.publisher_role',$1,true),set_config('address_radar.publisher_verifier',$2,true)",
          [job.publisherRole, createScramVerifier(password)]);
        await query(`/* provision-create-role */ DO $role$ BEGIN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 1 PASSWORD %L',
            current_setting('address_radar.publisher_role'),current_setting('address_radar.publisher_verifier'));
          END $role$`);
        await query('GRANT CONNECT ON DATABASE ' + quote(t.database) + ' TO ' + role);
        await query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
        await query('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ' + role);
        await query('GRANT SELECT ON TABLE ' + READ_TABLES.map(name => schema + '.' + quote(name)).join(',') + ' TO ' + role);
        await query('GRANT INSERT ON TABLE ' + INSERT_TABLES.map(name => schema + '.' + quote(name)).join(',') + ' TO ' + role);
        await query(`ALTER ROLE ${role} SET search_path TO ${schema}, pg_catalog`);
        for (const [setting, value] of [['statement_timeout', '5s'], ['lock_timeout', '1s'], ['idle_in_transaction_session_timeout', '10s'],
          ['work_mem', '1MB'], ['max_parallel_workers_per_gather', '0']]) await query(`ALTER ROLE ${role} SET ${setting} TO '${value}'`);
        demand(validateRole(await query(roleSql, [job.publisherRole, roleSettings(t.schema)]), password));
        demand((await query(environmentSql(true), [job.publisherRole, t.schema, t.database]))[0]?.safe === true);
        validateAcl(await query(aclSql(true), [job.publisherRole]), t.schema, true);
      }
      check(); committing = true;
      await client.query('COMMIT'); began = false;
    } else { await client.query('ROLLBACK'); began = false; }
    return { status: options.apply ? 'provisioned' : 'preflight-only', changed: options.apply && changed, changesRequired: changed,
      generationId: GENERATION, publisherRole: job.publisherRole, providerContracts: job.providers.length,
      validatorAuthorities: job.validators.length, approvedConfigSha256: runtimeAuthorityFingerprint(job),
      cohortModified: false, factsCreated: false, activationAuthorized: false, gatewayDeliveryEnabled: false };
  } catch {
    if (began) { try { await client.query('ROLLBACK'); } catch { /* No secret-bearing database diagnostics escape. */ } }
    throw new Error(committing ? 'runtime_authority_commit_unknown' : 'runtime_authority_refused');
  }
}

async function privateRead(pin: Pin, maximum: number, check: () => void): Promise<Buffer> {
  demand(exact(pin, ['path', 'sha256']) && safePath(pin.path) && hex(pin.sha256));
  const parents: { path: string; dev: number; ino: number }[] = [];
  for (let path = dirname(pin.path);; path = dirname(path)) {
    check(); const info = await lstat(path);
    demand(info.isDirectory() && info.uid === 0 && !(info.mode & 0o022)); parents.push({ path, dev: info.dev, ino: info.ino });
    if (path === '/') break;
  }
  const file = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stamp = (info: { dev: number; ino: number; mode: number; uid: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number }) =>
    [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(':');
  try {
    const before = await file.stat();
    demand(before.isFile() && before.uid === 0 && (before.mode & 0o777) === 0o600 && before.nlink === 1 && before.size > 0 && before.size <= maximum);
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { check(); const read = await file.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
    demand(offset === before.size && stamp(before) === stamp(await file.stat()) && stamp(before) === stamp(await lstat(pin.path)));
    for (const parent of parents) {
      check(); const info = await lstat(parent.path);
      demand(info.isDirectory() && info.uid === 0 && !(info.mode & 0o022) && info.dev === parent.dev && info.ino === parent.ino);
    }
    const body = bytes.subarray(0, offset);
    demand(createHash('sha256').update(body).digest('hex') === pin.sha256); check(); return body;
  } finally { await file.close(); }
}
async function nativeMain(args: string[]) {
  demand(process.platform === 'linux' && process.geteuid?.() === 0);
  const startedAt = Date.now(), check = () => demand(Date.now() - startedAt < 30000);
  demand((args.length === 4 || args.length === 5 && args[4] === '--apply') && args[0] === '--job' && args[2] === '--job-sha256');
  const job = JSON.parse((await privateRead({ path: args[1]!, sha256: args[3]! }, 65536, check)).toString('utf8')) as RuntimeAuthorityJob;
  const credential = JSON.parse((await privateRead(job.credential, 8192, check)).toString('utf8')) as RuntimeAuthorityCredential;
  validateRuntimeAuthorityInput(job, credential, Date.now());
  const peerAdmin = 'mode' in job.adminCredential;
  let connection: Record<string, unknown>;
  if ('mode' in job.adminCredential) {
    connection = { host: job.adminCredential.socketDirectory, port: job.target.serverPort, database: job.target.database, user: job.target.adminUsername };
  } else {
    const admin = JSON.parse((await privateRead(job.adminCredential, 8192, check)).toString('utf8')) as RuntimeAuthorityCredential;
    demand(exact(admin, ['connectionString', 'gatewayDeliveryEnabled', 'service', 'username']) && admin.gatewayDeliveryEnabled === false
      && String(admin.service) === 'runtime-authority-provisioner' && admin.username === job.target.adminUsername);
    credentialPassword(admin, job.target); connection = { connectionString: admin.connectionString };
  }
  check();
  const client = new PostgresAuthorityClient({ ...connection, ssl: false, connectionTimeoutMillis: 2000, query_timeout: 5000,
    options: '-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000 -c log_statement=none -c log_min_error_statement=panic' });
  client.on('error', () => undefined); client.on('notice', () => undefined);
  if (peerAdmin) {
    // Resolve the approved local account before dropping all supplementary groups and root privilege.
    const execute = promisify(execFile);
    const uidText = (await execute('/usr/bin/id', ['-u', job.target.adminUsername], { timeout: 2000, maxBuffer: 128 })).stdout.trim();
    const gidText = (await execute('/usr/bin/id', ['-g', job.target.adminUsername], { timeout: 2000, maxBuffer: 128 })).stdout.trim();
    demand(/^[1-9][0-9]*$/.test(uidText) && /^[1-9][0-9]*$/.test(gidText)); check();
    demand(process.setgroups && process.setgid && process.setuid);
    process.setgroups([]); process.setgid(Number(gidText)); process.setuid(Number(uidText));
    demand(process.geteuid?.() === Number(uidText) && process.getegid?.() === Number(gidText));
  }
  try {
    await client.connect(); check();
    const sqlPort: AuthorityClient = { query: (sql, values = []) => client.query(sql, [...values]) };
    return await provisionRuntimeAuthority(job, credential, sqlPort, { apply: args[4] === '--apply', startedAt, peerAdmin });
  } finally { await client.end(); }
}
function boundedCli(args: string[]): Promise<string> {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', fileURLToPath(import.meta.url), '--authority-worker', ...args],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, stdout = '', refused = false;
    const timer = setTimeout(() => { refused = true; child.kill('SIGKILL'); }, 30000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65536) { refused = true; stdout = ''; child.kill('SIGKILL'); }
      else if (stream === child.stdout && !refused) stdout += chunk.toString('utf8');
    });
    child.on('error', () => { refused = true; });
    child.on('close', code => { clearTimeout(timer); resolveResult(code === 0 && !refused ? stdout : ''); });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refuse = () => { process.stdout.write('{"status":"refused-or-commit-unknown","activationAuthorized":false,"gatewayDeliveryEnabled":false}\n'); process.exitCode = 1; };
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) refuse();
  else if (process.argv[2] === '--authority-worker') nativeMain(process.argv.slice(3))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'), refuse);
  else boundedCli(process.argv.slice(2)).then(output => { if (output) process.stdout.write(output); else refuse(); }, refuse);
}
