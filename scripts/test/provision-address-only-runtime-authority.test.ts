import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  provisionRuntimeAuthority, runtimeAuthorityFingerprint, createScramVerifier,
  passwordMatchesVerifier, validateRuntimeAuthorityInput,
  type RuntimeAuthorityJob, type AuthorityClient,
} from '../provision-address-only-runtime-authority.js';

const now = 1791417600000;
const cohort = [{ generation_id: 'production-20261006-v1', subject_key: 'wallet', entity_id: 'entity', import_id: 'existing-cohort' }];
function fixture() {
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const username = 'address_radar_execution_publisher';
  const credential = { connectionString: `postgresql://${username}:${'ab'.repeat(32)}@127.0.0.1:5432/address_radar`,
    gatewayDeliveryEnabled: false as const, service: 'execution-publisher' as const, username };
  const job: RuntimeAuthorityJob = {
    version: 1, approvalRef: 'root-approved-authority', approvedAt: now - 1000, expiresAt: now + 60000,
    target: { database: 'address_radar', schema: 'address_radar_business', adminUsername: 'postgres',
      serverAddress: '127.0.0.1', serverPort: 5432, systemIdentifier: '7693392208475083526',
      generationId: 'production-20261006-v1', schemaVersion: 3, schemaFingerprint: 'a'.repeat(64) },
    publisherRole: username,
    forbiddenRoles: { scanner: 'address_radar_scanner', automation: 'address_radar_automation',
      'wallet-monitor': 'address_radar_wallet_monitor', 'wallet-analysis': 'address_radar_wallet_analysis',
      'historical-backfill': 'address_radar_historical_backfill', console: 'address_radar_console', migrator: 'address_radar_migrator' },
    cohort: { importId: 'existing-cohort', wallets: 1, entities: 1, sha256: runtimeAuthorityFingerprint(cohort) },
    credential: { path: '/var/lib/address-radar-maintenance-tools/authority/publisher.json', sha256: 'b'.repeat(64) },
    adminCredential: { path: '/var/lib/address-radar-maintenance-tools/authority/admin.json', sha256: 'c'.repeat(64) },
    providers: [{ providerId: 'approved-rpc', origin: 'https://rpc.example.org', importId: 'provider-authority',
      evidenceSha256: 'd'.repeat(64), importedAt: now - 500, windowStartedAt: now - 500, requestsUsed: 0, cooldownUntil: 0 },
      { providerId: 'independent-rpc', origin: 'https://independent.example.org', importId: 'replay-authority',
        evidenceSha256: 'f'.repeat(64), importedAt: now - 500, windowStartedAt: now - 500, requestsUsed: 0, cooldownUntil: 0 }],
    validators: [{ kind: 'execution', validatorId: 'external-validator', importId: 'execution-authority', evidenceSha256: 'e'.repeat(64),
      importedAt: now - 500, validFrom: now - 500, validUntil: now + 60000, keyId: 'approved-ed25519', publicKey: key,
      actorId: 'approved-validator-actor', authorizationRef: 'validator-approval', reviewedSourceProviders: ['independent-rpc'] }],
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let role: Record<string, unknown> | undefined;
  const rows = new Map<string, Record<string, unknown>>();
  let fail = '';
  let clock = now;
  let unsafeEnvironment = false;
  let unsafeAcl = false;
  let peer = false;
  const client: AuthorityClient = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (fail && sql.includes(fail)) throw new Error('SECRET_URL verifier database diagnostic');
      let result: Record<string, unknown>[] = [];
      if (sql.includes('provision-identity')) result = [{ ...job.target, username: 'postgres', session_username: 'postgres',
        superuser: true, generationExists: true, schemaGeneration: job.target.generationId,
        installedVersion: 3, installedFingerprint: job.target.schemaFingerprint, forbiddenCount: 7, objectsSafe: true,
        ...(peer ? { serverAddress: 'local', serverPort: 0 } : {}) }];
      else if (sql.includes('provision-cohort')) result = cohort.map(value => ({ value }));
      else if (sql.includes('provision-lock')) result = [{ locked: true }];
      else if (sql.includes('provision-role-environment')) result = [{ safe: !unsafeEnvironment }];
      else if (sql.includes('provision-role-state')) result = role ? [role] : [];
      else if (sql.includes('provision-role-acl')) result = role ? publisherAcl(job.target.schema).map((row, index) => ({ ...row,
        update_any: unsafeAcl && index === 0 })) : [];
      else if (sql.includes('provision-ledger-read')) result = rows.has(String(values[0])) ? [rows.get(String(values[0]))!] : [];
      else if (sql.includes('provision-budget-read')) {
        const key = values[1] === job.providers[0]!.providerId ? 'budget' : 'budget:' + String(values[1]);
        result = rows.has(key) ? [rows.get(key)!] : [];
      }
      else if (sql.includes('provision-validator-read')) result = rows.has('validator') ? [rows.get('validator')!] : [];
      else if (sql.includes('provision-create-role')) existing();
      return { rows: result, rowCount: result.length };
    },
  };
  function existing() {
    role = { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
      rolbypassrls: false, rolinherit: false, rolconnlimit: 1, rolvaliduntil: null,
      rolpassword: createScramVerifier('ab'.repeat(32)), memberships: 0, settings: true };
    for (const provider of job.providers) {
    rows.set(provider.importId, { import_id: provider.importId, generation_id: job.target.generationId,
      approval_ref: job.approvalRef, source_fingerprint: runtimeAuthorityFingerprint({ approvalRef: job.approvalRef, proofScope: 'provider_contract', configuration: provider }), proof_scope: 'provider_contract',
      imported_at: String(provider.importedAt), revoked_at: null });
    rows.set(provider === job.providers[0] ? 'budget' : 'budget:' + provider.providerId, { generation_id: job.target.generationId, provider_id: provider.providerId, origin: provider.origin,
      import_id: provider.importId, window_started_at: String(now), window_ms: 60000, maximum_requests: 60,
      requests_used: 17, cooldown_until: '0', maximum_concurrency: 1 });
    }
    const validator = job.validators[0]!;
    rows.set(validator.importId, { import_id: validator.importId, generation_id: job.target.generationId,
      approval_ref: job.approvalRef, source_fingerprint: runtimeAuthorityFingerprint({ approvalRef: job.approvalRef, proofScope: 'validator_authority', configuration: validator }), proof_scope: 'validator_authority',
      imported_at: String(validator.importedAt), revoked_at: null });
    rows.set('validator', { generation_id: job.target.generationId, validator_id: validator.validatorId, kind: validator.kind,
      import_id: validator.importId, valid_from: String(validator.validFrom), valid_until: String(validator.validUntil), revoked_at: null });
  }
  return { job, credential, calls, client, rows, existing, role: () => role!, setFailure: (value: string) => { fail = value; },
    unsafeEnvironment: () => { unsafeEnvironment = true; }, unsafeAcl: () => { unsafeAcl = true; }, peer: () => { peer = true; },
    options: { now: () => clock }, advance: () => { clock += 31000; } };
}
function publisherAcl(schema: string) {
  const read = ['business_schema_identity', 'business_schema_ledger', 'wallet_service_import_ledger', 'wallet_service_fact_validators', 'wallet_service_provider_budgets',
    'wallet_service_fact_inputs', 'wallet_service_fact_attestations', 'forward_purchase_samples', 'forward_trade_revisions', 'forward_strategy_generations'];
  return [...read, 'wallet_forward_signal_wake_intents'].map(name => ({ schema, name, kind: 'r', persistence: 'p',
    select_all: read.includes(name), select_any: read.includes(name),
    insert_all: ['wallet_service_fact_inputs', 'wallet_service_fact_attestations', 'wallet_forward_signal_wake_intents'].includes(name),
    insert_any: ['wallet_service_fact_inputs', 'wallet_service_fact_attestations', 'wallet_forward_signal_wake_intents'].includes(name),
    update_any: false, delete_any: false, truncate_any: false, references_any: false, trigger_any: false }));
}

describe('address-only runtime authority provisioning', () => {
  it('preflights by default without DDL or business writes', async () => {
    const f = fixture(); const result = await provisionRuntimeAuthority(f.job, f.credential, f.client, f.options);
    expect(result.status).toBe('preflight-only');
    expect(f.calls[0]!.sql).toContain('READ ONLY');
    expect(f.calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(f.calls.map(x => x.sql).join('\n')).not.toMatch(/CREATE ROLE|INSERT INTO|GRANT /);
    expect(result.gatewayDeliveryEnabled).toBe(false);
  });
  it('applies only scoped authority inserts and role ACL in one transaction', async () => {
    const f = fixture();
    const result = await provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, apply: true });
    expect(result.status).toBe('provisioned');
    expect(f.calls.at(-1)!.sql).toBe('COMMIT');
    const sql = f.calls.map(x => x.sql).join('\n');
    expect(f.calls.flatMap(x => x.values)).toContain('provider_contract');
    expect(f.calls.flatMap(x => x.values)).toContain('validator_authority');
    expect(sql).not.toMatch(/INSERT INTO .*wallet_service_fact_inputs|INSERT INTO .*profile_cohort|UPDATE |DELETE FROM|ALTER TABLE|pg_hba/);
    expect(sql).toContain('NOINHERIT CONNECTION LIMIT 1');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system()');
    expect(sql).toContain('"wallet_service_provider_budgets"');
    expect(sql).not.toContain('ab'.repeat(32)); expect(sql).not.toContain('SCRAM-SHA-256$');
    expect(JSON.stringify(result)).not.toMatch(/postgresql:|SCRAM|publicKey/);
  });
  it('is idempotent and preserves consumed provider budget', async () => {
    const f = fixture(); f.existing();
    const result = await provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, apply: true });
    expect(result.changed).toBe(false);
    expect(f.calls.map(x => x.sql).join('\n')).not.toMatch(/CREATE ROLE|INSERT INTO|GRANT |publisher_verifier/);
    expect(f.rows.get('budget')!.requests_used).toBe(17);
  });
  it.each(['role', 'password', 'budget', 'ledger', 'validator'])('rejects %s drift and rolls back', async kind => {
    const f = fixture(); f.existing();
    if (kind === 'role') f.role().rolsuper = true;
    if (kind === 'password') f.role().rolpassword = createScramVerifier('ff'.repeat(32));
    if (kind === 'budget') f.rows.get('budget')!.maximum_requests = 61;
    if (kind === 'ledger') f.rows.get('provider-authority')!.revoked_at = now;
    if (kind === 'validator') f.rows.get('validator')!.valid_until = now + 1;
    await expect(provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, apply: true })).rejects.toThrow('runtime_authority_refused');
    expect(f.calls.at(-1)!.sql).toBe('ROLLBACK');
    expect(f.calls.map(x => x.sql).join('\n')).not.toMatch(/CREATE ROLE|INSERT INTO|GRANT /);
  });
  it('rejects forbidden publisher roles, incorrect origin, expired approval and private keys before SQL', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.job.publisherRole = f.job.forbiddenRoles.scanner; },
      (f: ReturnType<typeof fixture>) => { f.job.providers[0]!.origin = 'https://user:secret@rpc.example.org'; },
      (f: ReturnType<typeof fixture>) => { f.job.expiresAt = now; },
      (f: ReturnType<typeof fixture>) => { f.job.validators[0]!.publicKey = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(); },
    ]) { const f = fixture(); change(f); expect(() => validateRuntimeAuthorityInput(f.job, f.credential, now)).toThrow(); }
  });
  it('rejects cohort drift before any authority mutation', async () => {
    const f = fixture(); f.job.cohort.sha256 = '0'.repeat(64);
    await expect(provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, apply: true })).rejects.toThrow('runtime_authority_refused');
    expect(f.calls.map(x => x.sql).join('\n')).not.toMatch(/CREATE ROLE|INSERT INTO|GRANT /);
  });
  it('refuses an exhausted original deadline before opening a transaction', async () => {
    const f = fixture(); f.advance();
    await expect(provisionRuntimeAuthority(f.job, f.credential, f.client, { now: f.options.now, startedAt: now })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it('sanitizes database errors and distinguishes uncertain commit', async () => {
    const f = fixture(); f.setFailure('provision-identity');
    await expect(provisionRuntimeAuthority(f.job, f.credential, f.client, f.options)).rejects.toThrow(/^runtime_authority_refused$/);
    const g = fixture(); g.existing(); g.setFailure('COMMIT');
    await expect(provisionRuntimeAuthority(g.job, g.credential, g.client, { ...g.options, apply: true })).rejects.toThrow(/^runtime_authority_commit_unknown$/);
  });
  it('SCRAM checks reject wrong passwords and malformed verifiers', () => {
    const password = '12'.repeat(32), verifier = createScramVerifier(password);
    expect(passwordMatchesVerifier(password, verifier)).toBe(true);
    expect(passwordMatchesVerifier('34'.repeat(32), verifier)).toBe(false);
    expect(passwordMatchesVerifier(password, 'SCRAM-SHA-256$999999999:bad$bad:bad')).toBe(false);
  });
  it('rejects key changes against an existing authority ledger', async () => {
    const f = fixture(); f.existing();
    f.job.validators[0]!.publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString();
    await expect(provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, apply: true })).rejects.toThrow('runtime_authority_refused');
    expect(f.calls.map(x => x.sql).join('\n')).not.toMatch(/CREATE ROLE|INSERT INTO|GRANT /);
  });
  it.each(['environment', 'acl'])('rejects unsafe %s instead of repairing permissions', async kind => {
    const f = fixture(); f.existing(); if (kind === 'environment') f.unsafeEnvironment(); else f.unsafeAcl();
    await expect(provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, apply: true })).rejects.toThrow('runtime_authority_refused');
    expect(f.calls.at(-1)!.sql).toBe('ROLLBACK');
  });
  it('supports explicitly approved local peer administration without a database password', async () => {
    const f = fixture(); f.peer(); f.job.adminCredential = { mode: 'peer', socketDirectory: '/var/run/postgresql' };
    const result = await provisionRuntimeAuthority(f.job, f.credential, f.client, { ...f.options, peerAdmin: true });
    expect(result.status).toBe('preflight-only');
    const g = fixture(); g.peer();
    await expect(provisionRuntimeAuthority(g.job, g.credential, g.client, g.options)).rejects.toThrow('runtime_authority_refused');
  });
  it('requires an approved budget for each replay provider', () => {
    const f = fixture(); f.job.providers.pop();
    expect(() => validateRuntimeAuthorityInput(f.job, f.credential, now)).toThrow('runtime_authority_refused');
  });
  it.each([false, true])('guards catalog permission evaluation with CASE (existing role: %s)', async existing => {
    const f = fixture(); if (existing) f.existing();
    await provisionRuntimeAuthority(f.job, f.credential, f.client, f.options);
    const environment = f.calls.find(call => call.sql.includes('provision-role-environment'))!.sql;
    const acl = f.calls.find(call => call.sql.includes('provision-role-acl'))!.sql;
    expect(environment).toContain("CASE WHEN c.relkind='S' THEN");
    if (existing) expect(environment).toContain("CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END");
    const guards = [...acl.matchAll(/CASE WHEN c\.relkind IN \('r','p','v','m','f'\) THEN \([\s\S]*? ELSE false END/g)].map(match => match[0]);
    expect(guards).toHaveLength(9);
    if (existing) {
      expect(guards.join('\n').match(/has_table_privilege\(/g)).toHaveLength(9);
      expect(guards.join('\n').match(/has_any_column_privilege\(/g)).toHaveLength(4);
    }
    expect(environment).toContain("c.relkind='S' AND");
    expect(acl).toContain("c.relkind IN ('r','p','v','m','f')");
  });
});

describe('standalone runtime authority maintenance bundle', () => {
  let directory: string, output: string;
  beforeAll(async () => {
    const { buildAddressOnlyMaintenanceModule } = await import('../build-address-only-compiled-release.mjs');
    directory = await realpath(await mkdtemp(join(tmpdir(), 'runtime-authority-standalone-')));
    output = join(directory, 'authority.mjs');
    await buildAddressOnlyMaintenanceModule({ entry: resolve('scripts/provision-address-only-runtime-authority.ts'), output, seal: false });
  }, 15000);
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
  it('bundles pg without a runtime packages/database or node_modules dependency', async () => {
    const source = await readFile(output, 'utf8');
    expect(source).not.toContain('../packages/database/package.json');
    expect(source).toContain('pg/lib/client.js');
    expect(source).toContain('pg-protocol');
  });
  it('imports safely outside the repository without opening a database or running its CLI', () => {
    const harness = `import net from 'node:net';
      net.Socket.prototype.connect=function(){throw Error('Database/network connection forbidden during import')};
      await import(${JSON.stringify(pathToFileURL(output).href)});`;
    const child = spawnSync(process.execPath, ['--no-global-search-paths', '--input-type=module', '-e',
      harness],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    expect(child.status).toBe(0); expect(child.stdout).toBe(''); expect(child.stderr).toBe('');
  });
  it('refuses native CLI execution with an unprotected job and emits no success receipt', () => {
    const child = spawnSync(process.execPath, ['--no-global-search-paths', output, '--job', join(directory, 'missing-secret-job.json'),
      '--job-sha256', 'a'.repeat(64)],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    expect(child.status).toBe(1); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout)).toEqual({ status: 'refused-or-commit-unknown', activationAuthorized: false, gatewayDeliveryEnabled: false });
  });
  it('rejects a forced native driver during standalone import', () => {
    const child = spawnSync(process.execPath, ['--no-global-search-paths', '--input-type=module', '-e',
      `await import(${JSON.stringify(pathToFileURL(output).href)});`],
    { cwd: directory, env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_PG_FORCE_NATIVE: '1' }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr).toContain('Native PostgreSQL driver forbidden');
  });
});
