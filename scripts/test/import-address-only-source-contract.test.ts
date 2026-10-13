import { describe, expect, it } from 'vitest';
import { validateRotationBinding, validateNativeFenceBinding, withSourceImportAudit } from '../import-address-only-source-contract.js';
const sha = 'a'.repeat(64);
function fixture() {
  const job = { operationId: 'op', approvalRef: 'approved', replacementSha256: sha, expiresAtMs: Date.now() + 10000 };
  const authorization = { operationId: 'op', approvalRef: 'approved', replacementSha256: sha };
  const plan = { ...authorization, expiresAtMs: job.expiresAtMs + 10000, role: 'test_migrator' };
  const credential = { host: '127.0.0.1', port: 5432, database: 'test_import', user: 'test_migrator', password: 'private', operationId: 'op', expiresAtMs: plan.expiresAtMs };
  return { job, plan, credential, receipt: { ...authorization, status: 'rotated-authenticated', expiresAtMs: plan.expiresAtMs,
    system: '123', oldRecordsPreserved: true, hbaChanged: false, schemaChanged: false, businessActivated: false },
    target: { username: credential.user, database: credential.database, systemIdentifier: '123' } };
}
describe('source contract import rotation binding', () => {
  it('accepts the exact operation, replacement and authenticated credential', () => {
    const f = fixture(); expect(() => validateRotationBinding(f.job, f.plan, f.credential, f.receipt, f.target)).not.toThrow();
  });
  it.each(['operation', 'replacement', 'expiry', 'role', 'receipt'])('rejects %s drift without leaking credential', fault => {
    const f = fixture();
    if (fault === 'operation') f.credential.operationId = 'other';
    if (fault === 'replacement') f.receipt.replacementSha256 = 'b'.repeat(64);
    if (fault === 'expiry') f.credential.expiresAtMs = 1;
    if (fault === 'role') f.plan.role = 'postgres';
    if (fault === 'receipt') f.receipt.status = 'uncertain';
    expect(() => validateRotationBinding(f.job, f.plan, f.credential, f.receipt, f.target)).toThrow('IMPORT_ROTATION_BINDING');
  });
});

describe('native fence request binding', () => {
  const job = { operationId: 'op', replacementSha256: sha, approvalRef: 'approved' };
  const source = { generationId: 'gen', oldProviderId: 'old', oldOrigin: 'https://helius.example',
    newProviderId: 'new', newOrigin: 'https://solana-rpc.publicnode.com' };
  it('accepts only the exact operation, generation and source pair', () => {
    expect(() => validateNativeFenceBinding({ protocol: 'address-only-pg-source-fence-v1', ...job, ...source }, job, source)).not.toThrow();
  });
  it.each(['operationId', 'generationId', 'oldProviderId', 'newProviderId', 'approvalRef'])('refuses %s mismatch', key => {
    expect(() => validateNativeFenceBinding({ protocol: 'address-only-pg-source-fence-v1', ...job, ...source, [key]: 'other' }, job, source)).toThrow('IMPORT_NATIVE_FENCE_BINDING');
  });
});

import { beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createSourceReplacementPlan } from '../prepare-address-only-source-replacement.js';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';
import { postgresCohortImportSchemaContract } from '../../apps/automation/src/postgres-cohort-import.js';

describe('intent-to-driver failure audit lifecycle', () => {
  it.each(['load', 'construct'])('preserves intent and writes failed receipt on driver %s failure', async phase => {
    const directory = mkdtempSync(join(tmpdir(), 'source-import-audit-'));
    const audit = join(directory, 'source-contract-import');
    try {
      const intent = { operationId: 'op', replacementSha256: sha, jobSha256: sha, rotationReceiptSha256: sha,
        mode: 'isolated', retryAuthorized: false };
      await expect(withSourceImportAudit(audit, intent, async () => {
        if (phase === 'load') throw new Error('private-driver-load-error');
        class Driver { constructor() { throw new Error('private-driver-constructor-error'); } }
        return new Driver();
      })).rejects.toThrow('IMPORT_REFUSED_OR_UNCERTAIN');
      expect(JSON.parse(readFileSync(audit + '-intent.json', 'utf8'))).toEqual(intent);
      const failure = JSON.parse(readFileSync(audit + '-failed.json', 'utf8'));
      expect(failure.status).toBe('REFUSED_OR_UNCERTAIN');
      expect(failure.retryAuthorized).toBe(false);
      expect(JSON.stringify(failure)).not.toContain('private-driver');
      expect(() => readFileSync(audit + '-receipt.json')).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

const enabled = process.env.ADDRESS_RADAR_SOURCE_IMPORT_CLI_LOCAL_PG === '1';
describe.skipIf(!enabled)('real isolated TCP PG CLI (not native fence proof)', () => {
  const nonce = randomBytes(8).toString('hex'), database = 'radar_rehearsal_' + nonce;
  const username = 'radar_migrator_' + nonce, password = randomBytes(24).toString('hex');
  let container = '', directory = '', system = '';
  const docker = (args: string[], input?: string) => execFileSync('docker', args, {
    encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }),
  }).trim();
  const sql = (text: string) => docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], text);
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'source-import-cli-'));
    const builderPath = new URL('../build-address-only-compiled-release.mjs', import.meta.url).pathname;
    execFileSync(process.execPath, ['--input-type=module', '-e',
      'const {buildAddressOnlyMaintenanceModule}=await import(process.argv[1]);await buildAddressOnlyMaintenanceModule({entry:process.argv[2],output:process.argv[3],seal:false});',
      pathToFileURL(builderPath).href, new URL('../import-address-only-source-contract.ts', import.meta.url).pathname,
      join(directory, 'cli.mjs')], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    container = docker(['run', '--pull=never', '-d', '--memory=256m', '--cpus=1', '--tmpfs', '/var/lib/postgresql/data:rw,size=128m',
      '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256', '-e', 'POSTGRES_DB=' + database, 'pgvector/pgvector:pg16']);
    let ready = false;
    for (let n = 0; n < 40 && !ready; n++) {
      try { sql('SELECT 1'); ready = true; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    expect(ready).toBe(true);
    system = sql('SELECT system_identifier::text FROM pg_control_system()');
    expect(system).not.toBe('7693392208475083526');
    let ddl = `CREATE ROLE "${username}" LOGIN PASSWORD '${password}'; REVOKE ALL ON DATABASE "${database}" FROM PUBLIC;
      GRANT CONNECT ON DATABASE "${database}" TO "${username}"; CREATE SCHEMA "${database}" AUTHORIZATION "${username}";
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "${username}"; SET ROLE "${username}"; SET search_path TO "${database}";`;
    for (const name of ['forward_strategy_generations', 'wallet_service_import_ledger', 'wallet_service_provider_budgets'] as const) {
      const c = postgresCohortImportSchemaContract[name]!;
      const columns = Object.entries(c.columns).map(([key, type]) => `"${key}" ${type}${c.nullable.includes(key) ? '' : ' NOT NULL'}`);
      columns.push('PRIMARY KEY(' + c.primaryKey.join(',') + ')');
      for (const keys of c.unique) columns.push('UNIQUE(' + keys.join(',') + ')');
      for (const fk of c.foreignKeys) columns.push('FOREIGN KEY(' + fk.columns.join(',') + ') REFERENCES ' + fk.table + '(' + fk.targetColumns.join(',') + ')');
      columns.push(...c.checks); ddl += `CREATE TABLE "${name}" (${columns.join(',')});`;
    }
    sql(ddl + `CREATE TABLE business_schema_identity(singleton boolean,database_name text,schema_name text,generation_id text,ledger_format integer);
      CREATE TABLE business_schema_ledger(version integer,fingerprint text);
      CREATE TABLE wallet_service_provider_leases(generation_id text,provider_id text,released_at bigint,expires_at bigint);
      INSERT INTO business_schema_identity VALUES(true,'${database}','${database}','gen',1);
      INSERT INTO business_schema_ledger VALUES(3,'${sha}'); INSERT INTO forward_strategy_generations(generation_id) VALUES('gen');
      INSERT INTO wallet_service_import_ledger VALUES('old','gen','old-approval','${sha}','provider_contract',1);
      INSERT INTO wallet_service_provider_budgets VALUES('gen','old-source','https://helius.example','old',1,60000,60,60,1,9223372036854775807);`);
  }, 30000);
  afterAll(() => { if (container) docker(['rm', '-f', container]); if (directory) rmSync(directory, { recursive: true, force: true }); });
  function launch(fault?: 'intent' | 'cluster' | 'password' | 'proof') {
    const at = Date.now();
    const review = { version: 1 as const, importId: 'new-contract', approvalRef: 'approved', generationId: 'gen', importedAt: at,
      contractRef: 'publicnode-terms', budgets: [{ providerId: 'new-source', origin: 'https://solana-rpc.publicnode.com', windowStartedAt: at,
        windowMs: 60000, maximumRequests: 60, requestsUsed: 0, maximumConcurrency: 1, cooldownUntil: '0' }] };
    const input = { oldProviderId: 'old-source', oldOrigin: 'https://helius.example', oldOperator: 'Helius', newOperator: 'Allnodes/PublicNode', review,
      trustedReviewSha256: createHash('sha256').update(migrationCutoverCanonicalJson(review)).digest('hex'),
      material: { authority: { generationId: 'gen', credential: {}, privateKey: {}, validator: { reviewedProviderBindings: [{
        chain: 'solana', sourceProviderId: 'old-source', sourceEndpoint: 'https://helius.example', replayProviderId: 'official-replay', replayEndpoint: 'https://api.mainnet-beta.solana.com' }] } },
      deployment: { generationId: 'gen', gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
        walletExecution: { solana: { providerId: 'old-source', endpoint: 'https://helius.example' } } },
      settings: { providerContracts: [{ providerId: 'old-source', origin: 'https://helius.example', importId: 'old', sourceFingerprint: sha,
        windowMs: 60000, maximumRequests: 60, maximumConcurrency: 1 }] }, environment: { RADAR_RPC_SOLANA_HTTP_URL: 'https://helius.example' } } };
    const replacement = createSourceReplacementPlan(input).replacementSha256;
    const pin = (name: string, value: unknown) => {
      const raw = JSON.stringify(value); writeFileSync(join(directory, name), raw, { mode: 0o600 });
      return { path: '/work/' + name, sha256: createHash('sha256').update(raw).digest('hex') };
    };
    const authorization = { operationId: 'op', approvalRef: 'approved', replacementSha256: replacement };
    const rotationPlan = pin('plan.json', { ...authorization, expiresAtMs: at + 120000, role: username });
    const intent = pin('rotation-intent.json', { ...authorization, planSha256: fault === 'intent' ? sha : rotationPlan.sha256 });
    const credential = pin('credential.json', { host: '127.0.0.1', port: 5432, database, user: username,
      password: fault === 'password' ? 'wrong-private-password' : password, expiresAtMs: at + 120000, operationId: 'op' });
    const receipt = pin('rotation-receipt.json', { ...authorization, status: 'rotated-authenticated', expiresAtMs: at + 120000,
      system, oldRecordsPreserved: true, hbaChanged: false, schemaChanged: false, businessActivated: false });
    const proof = pin('proof.json', { protocol: 'address-only-pg-source-fence-proof-v1', replacementSha256: replacement,
      journalSha256: sha, bootId: 'isolated-fixture', measuredAtMs: at, stoppedAtMs: at - 61000,
      controllerLockHeld: true, acquisitionsBlocked: true, processesExited: fault !== 'proof', cgroupsEmpty: true, pendingRequestCount: 0, servicesActivated: false });
    const job = pin('job.json', { protocol: 'address-only-source-contract-import-job-v1', ...authorization, expiresAtMs: at + 60000,
      mode: 'isolated', input: pin('input.json', input), rotation: { plan: rotationPlan, intent, credential, receipt }, fence: { isolatedProof: proof },
      target: { database, schema: database, username, service: 'migrator', generation: 'gen', serverAddress: '127.0.0.1', serverPort: 5432,
        schemaVersion: 3, schemaFingerprint: sha, systemIdentifier: fault === 'cluster' ? '7693392208475083526' : system } });
    try {
      const output = docker(['run', '--rm', '--pull=never', '--network', 'container:' + container,
        '-v', directory + ':/input:ro', '--entrypoint', '/bin/sh', 'openclew/trial-base:latest', '-c',
        'set -e; test ! -e /packages; test ! -e /node_modules; mkdir -m 700 /work; cp /input/* /work/; chmod 600 /work/*; chmod 400 /work/cli.mjs; cd /work; test ! -e node_modules; node /work/cli.mjs --job /work/job.json --job-sha256 ' + job.sha256]);
      return { ok: true, output };
    } catch (error) {
      const e = error as { stdout: Buffer | string; stderr: Buffer | string };
      const output = String(e.stdout) + String(e.stderr);
      expect(output).not.toContain(password);
      return { ok: false, output };
    }
  }
  it.each(['intent', 'cluster', 'password', 'proof'] as const)('actual CLI refuses %s and writes no new provider', fault => {
    expect(launch(fault).ok).toBe(false);
    expect(sql(`SELECT count(*) FROM "${database}".wallet_service_provider_budgets WHERE provider_id='new-source'`)).toBe('0');
  });
  it('actual CLI commits through TCP migrator and preserves old MAX pause', () => {
    const result = launch(); expect(result.output).not.toContain(password); expect(result.ok, result.output).toBe(true);
    expect(result.output).toContain('"fenceProofScope":"isolated-test-port"');
    expect(sql(`SELECT count(*) FROM "${database}".wallet_service_provider_budgets WHERE provider_id='new-source'`)).toBe('1');
    expect(sql(`SELECT requests_used::text||':'||cooldown_until::text FROM "${database}".wallet_service_provider_budgets WHERE provider_id='old-source'`)).toBe('60:9223372036854775807');
  });
  it('commit connection loss is refused, never reported as success or retried', () => {
    sql(`DELETE FROM "${database}".wallet_service_provider_budgets WHERE provider_id='new-source';
      DELETE FROM "${database}".wallet_service_import_ledger WHERE import_id='new-contract';
      CREATE FUNCTION "${database}".drop_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_terminate_backend(pg_backend_pid()); RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER drop_commit AFTER INSERT ON "${database}".wallet_service_provider_budgets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${database}".drop_commit();`);
    const result = launch(); expect(result.ok).toBe(false); expect(result.output).not.toContain('"status":"COMMITTED"');
    expect(sql(`SELECT count(*) FROM "${database}".wallet_service_provider_budgets WHERE provider_id='new-source'`)).toBe('0');
  });
});
