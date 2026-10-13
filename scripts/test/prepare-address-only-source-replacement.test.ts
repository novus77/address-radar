import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrationCutoverCanonicalJson } from '../../packages/database/src/migration-cutover-coordinator.js';
import * as replacement from '../prepare-address-only-source-replacement.js';
const at = Date.now(), hash = 'a'.repeat(64);
const proof = (plan: replacement.SourceReplacementPlan, stoppedAtMs: number, measuredAtMs = Date.now()) => ({
  protocol: 'address-only-pg-source-fence-proof-v1' as const, replacementSha256: plan.replacementSha256,
  journalSha256: hash, bootId: 'fixture-boot', measuredAtMs, stoppedAtMs,
  controllerLockHeld: true as const, acquisitionsBlocked: true as const, processesExited: true as const,
  cgroupsEmpty: true as const, pendingRequestCount: 0 as const, servicesActivated: false as const });
function fixture() {
  const review = { version: 1 as const, importId: 'publicnode-contract', approvalRef: 'user-source-replacement', generationId: 'gen', importedAt: at,
    contractRef: 'publicnode-rpc-terms', budgets: [{ providerId: 'solana-publicnode-source', origin: 'https://solana-rpc.publicnode.com', windowStartedAt: at,
      windowMs: 60000, maximumRequests: 60, requestsUsed: 0, maximumConcurrency: 1, cooldownUntil: '0' }] };
  return { oldProviderId: 'solana-helius-source', oldOrigin: 'https://helius.example', oldOperator: 'Helius', newOperator: 'Allnodes/PublicNode',
    review, trustedReviewSha256: createHash('sha256').update(migrationCutoverCanonicalJson(review)).digest('hex'),
    material: { authority: { generationId: 'gen', username: 'publisher', credential: { path: '/private/credential', sha256: hash }, privateKey: { path: '/private/key', sha256: hash },
      validator: { validationTtlMs: 60000, reviewedProviderBindings: [{ chain: 'solana', sourceProviderId: 'solana-helius-source', sourceEndpoint: 'https://helius.example/private', replayProviderId: 'solana-official-replay', replayEndpoint: 'https://api.mainnet-beta.solana.com', expectedGenesisHash: 'mainnet-genesis' }] }, publisher: { maximumValidationAgeMs: 60000 } },
      deployment: { generationId: 'gen', gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false,
        walletExecution: { solana: { providerId: 'solana-helius-source', endpoint: 'https://helius.example/private', maximumRunMs: 5000 }, receiver: { maximumRunMs: 5000 } },
        executionRetry: { maximumCaptures: 1, maximumPayloadBytes: 2097152, maximumRunMs: 5000 } },
      settings: { protocol: 'address-only-configured-preflight-settings-v1', credential: { path: '/private/operator', sha256: hash }, validators: [],
        providerContracts: [{ providerId: 'solana-helius-source', origin: 'https://helius.example', importId: 'helius-contract', sourceFingerprint: hash, windowMs: 60000, maximumRequests: 60, maximumConcurrency: 1 }] },
      environment: { RADAR_RPC_SOLANA_HTTP_URL: 'https://helius.example/private', ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED: 'false' } } };
}
describe('bounded immutable source replacement', () => {
  it('exports the preparation implementation', () => { expect(replacement.createSourceReplacementPlan).toBeTypeOf('function'); });
  it('refuses a production caller-supplied fence before connecting', async () => {
    const plan = replacement.createSourceReplacementPlan(fixture());
    await expect(replacement.importSourceReplacementContract(plan, {
      migration: { capability: { mode: 'production' } } as unknown as PostgresMigrationRuntimeOptions,
      measureExclusiveFence: async () => proof(plan, at - 60000),
    })).rejects.toThrow('NATIVE_OBSERVER_REQUIRED');
  });
  it('replaces only source identity and retains key/credential/TTL/receiver/retry', () => {
    const f = fixture(), before = structuredClone(f), p = replacement.createSourceReplacementPlan(f);
    expect(f).toEqual(before);
    expect(p.material.authority.credential).toEqual(f.material.authority.credential);
    expect(p.material.authority.privateKey).toEqual(f.material.authority.privateKey);
    expect(p.material.authority.validator.validationTtlMs).toBe(60000);
    expect(p.material.deployment.executionRetry).toEqual(f.material.deployment.executionRetry);
    expect(p.material.deployment.walletExecution.receiver).toEqual(f.material.deployment.walletExecution.receiver);
    expect(p.material.authority.validator.reviewedProviderBindings[0]?.replayProviderId).toBe('solana-official-replay');
    expect(p.material.settings.providerContracts[0]?.sourceFingerprint).toBe(p.seed.planSha256);
    expect(JSON.stringify(p.material)).not.toContain('helius');
    expect(p.seed.budgets[0]?.maximumRequests).toBe(60);
  });
  it.each(['same-id','quota','origin','review-pin','replay','gateway'])('refuses %s before publishing', fault => {
    const f = fixture();
    if (fault === 'same-id') f.oldProviderId = 'solana-publicnode-source';
    if (fault === 'quota') f.review.budgets[0]!.maximumRequests = 61;
    if (fault === 'origin') f.review.budgets[0]!.origin = 'https://unapproved.example';
    if (fault === 'review-pin') f.trustedReviewSha256 = 'b'.repeat(64);
    if (fault === 'replay') f.material.authority.validator.reviewedProviderBindings[0]!.replayEndpoint = 'https://solana-rpc.publicnode.com';
    if (fault === 'gateway') f.material.deployment.gatewayDeliveryEnabled = true;
    if (fault === 'quota' || fault === 'origin') f.trustedReviewSha256 = createHash('sha256').update(migrationCutoverCanonicalJson(f.review)).digest('hex');
    expect(() => replacement.createSourceReplacementPlan(f)).toThrow();
  });
  it('requires full stopped-source window, drained leases and unchanged old budget', async () => {
    const p = replacement.createSourceReplacementPlan(fixture());
    const row = { generation_id: 'gen', provider_id: 'solana-helius-source', origin: 'https://helius.example', window_started_at: String(at - 60000),
      window_ms: 60000, maximum_requests: 60, requests_used: 60, maximum_concurrency: 1, cooldown_until: '9223372036854775807' };
    const tx = { query: async (sql: string) => ({ rows: sql.includes('replacement-old-budget') ? [row] : [{ active: '0' }], rowCount: 1 }) };
    await expect(replacement.verifySourceReplacementDrain(tx, p, proof(p, at - 59999, at), at)).rejects.toThrow('WINDOW');
    await expect(replacement.verifySourceReplacementDrain(tx, p, proof(p, at - 60000, at), at)).resolves.toEqual(row);
    const busy = { query: async (sql: string) => ({ rows: sql.includes('replacement-old-budget') ? [row] : [{ active: '1' }], rowCount: 1 }) };
    await expect(replacement.verifySourceReplacementDrain(busy, p, proof(p, at - 60000, at), at)).rejects.toThrow('LEASE');
    expect(row.cooldown_until).toBe('9223372036854775807');
  });
});

// Opt-in disposable local PG16 only. Never connects to a supplied/production URL.
import { beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { postgresCohortImportSchemaContract } from '../../apps/automation/src/postgres-cohort-import.js';
import type { PostgresMigrationRuntimeOptions } from '../../packages/database/src/postgres-migration-runtime.js';
const pgEnabled = process.env.ADDRESS_RADAR_SOURCE_REPLACEMENT_LOCAL_PG === '1';
const { Pool } = createRequire(new URL('../../packages/database/package.json', import.meta.url))('pg') as {
  Pool: new (o: Record<string, unknown>) => PostgresMigrationRuntimeOptions['pool'] & { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
};
describe.skipIf(!pgEnabled)('real disposable isolated PG replacement', () => {
  const nonce = randomBytes(8).toString('hex'), database = 'radar_rehearsal_' + nonce, schema = database;
  const username = 'radar_migrator_' + nonce, password = randomBytes(24).toString('hex');
  let container = '', port = 0, systemIdentifier = '', admin: InstanceType<typeof Pool>;
  const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeAll(async () => {
    container = docker(['run', '--pull=never', '-d', '--name', 'radar-source-test-' + nonce, '--memory=256m', '--cpus=1',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=128m', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password,
      '-e', 'POSTGRES_DB=' + database, 'pgvector/pgvector:pg16', 'postgres', '-c', 'listen_addresses=127.0.0.1']);
    const containerIp = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container]);
    // Relay only this disposable container's mapped interface into its loopback PG socket.
    // The real server now reports 127.0.0.1:5432; no identity result is mocked or rewritten.
    docker(['exec', '-d', container, 'perl', '-MIO::Socket::INET', '-MIO::Select', '-e',
      'my $l=IO::Socket::INET->new(LocalAddr=>$ARGV[0],LocalPort=>5432,Listen=>8,ReuseAddr=>1) or die;'+
      '$SIG{CHLD}="IGNORE";while(my $c=$l->accept()){my $p=fork();next if $p;close $l;'+
      'my $s=IO::Socket::INET->new(PeerAddr=>"127.0.0.1",PeerPort=>5432) or exit;my $sel=IO::Select->new($c,$s);'+
      'while(my @r=$sel->can_read()){for my $r(@r){my $n=sysread($r,my $b,65536);exit unless $n;'+
      'my $w=fileno($r)==fileno($c)?$s:$c;my $o=0;while($o<$n){my $k=syswrite($w,$b,$n-$o,$o);exit unless $k;$o+=$k;}}}exit;}', containerIp]);
    port = Number(docker(['port', container, '5432/tcp']).split(':').at(-1));
    expect(port).not.toBe(5432); expect(port).not.toBe(5433);
    admin = new Pool({ host: '127.0.0.1', port, database, user: 'postgres', password, max: 1, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let n = 0; n < 30 && !ready; n++) { try { await admin.query('SELECT 1'); ready = true; } catch { await new Promise(r => setTimeout(r, 100)); } }
    expect(ready).toBe(true);
    systemIdentifier = String((await admin.query('SELECT system_identifier::text id FROM pg_control_system()')).rows[0]!.id);
    expect(systemIdentifier).not.toBe('7693392208475083526');
    await admin.query(`CREATE ROLE "${username}" LOGIN PASSWORD '${password}'; REVOKE ALL ON DATABASE "${database}" FROM PUBLIC;
      GRANT CONNECT ON DATABASE "${database}" TO "${username}"; CREATE SCHEMA "${schema}" AUTHORIZATION "${username}";
      GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO "${username}"; SET ROLE "${username}"; SET search_path TO "${schema}"`);
    for (const name of ['forward_strategy_generations', 'wallet_service_import_ledger', 'wallet_service_provider_budgets'] as const) {
      const c = postgresCohortImportSchemaContract[name]!;
      const columns = Object.entries(c.columns).map(([k, t]) => `"${k}" ${t}${c.nullable.includes(k) ? '' : ' NOT NULL'}`);
      columns.push('PRIMARY KEY(' + c.primaryKey.map(k => '"' + k + '"').join(',') + ')');
      for (const keys of c.unique) columns.push('UNIQUE(' + keys.map(k => '"' + k + '"').join(',') + ')');
      for (const fk of c.foreignKeys) columns.push('FOREIGN KEY(' + fk.columns.join(',') + ') REFERENCES ' + fk.table + '(' + fk.targetColumns.join(',') + ')');
      columns.push(...c.checks); await admin.query(`CREATE TABLE "${name}" (${columns.join(',')})`);
    }
    await admin.query(`CREATE TABLE business_schema_identity(singleton boolean,database_name text,schema_name text,generation_id text,ledger_format integer);
      CREATE TABLE business_schema_ledger(version integer,fingerprint text);
      CREATE TABLE wallet_service_provider_leases(generation_id text,provider_id text,released_at bigint,expires_at bigint);
      INSERT INTO business_schema_identity VALUES(true,'${database}','${schema}','gen',1);
      INSERT INTO business_schema_ledger VALUES(3,'${hash}'); INSERT INTO forward_strategy_generations(generation_id) VALUES('gen');
      INSERT INTO wallet_service_import_ledger(import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at)
        VALUES('old','gen','old-approval','${hash}','provider_contract',1);
      INSERT INTO wallet_service_provider_budgets VALUES('gen','solana-helius-source','https://helius.example','old',1,60000,60,60,1,9223372036854775807)`);
    await admin.query('RESET ROLE');
  }, 30000);
  afterAll(async () => { if (admin) await admin.end(); if (container) docker(['rm', '-f', container]); });
  function migration(plan: replacement.SourceReplacementPlan): PostgresMigrationRuntimeOptions {
    const target = { database, schema, username, generation: 'gen', service: 'migrator', serverAddress: '127.0.0.1', serverPort: 5432,
      schemaVersion: 3, schemaFingerprint: hash, systemIdentifier };
    return { pool: new Pool({ host: '127.0.0.1', port, database, user: username, password, max: 1 }), target,
      capability: { mode: 'isolated', purpose: 'business_import', approvalRef: plan.seed.approvalRef, planSha256: plan.replacementSha256, expiresAtMs: Date.now() + 10000 },
      limits: { operationTimeoutMs: 3000, connectionTimeoutMs: 1000, statementTimeoutMs: 1000, lockTimeoutMs: 1000,
        maximumSqlStatements: 128, workMemKb: 1024, closeTimeoutMs: 1000 }, clock: Date.now,
      assertAuthorized: async request => {
        if (request.capability.mode !== 'isolated' || request.target.database !== database || request.target.systemIdentifier !== systemIdentifier
          || request.capability.planSha256 !== plan.replacementSha256) throw new Error('ISOLATED_AUTHORITY_DENIED');
      } };
  }
  const countNew = async () => (await admin.query(`SELECT count(*)::int n FROM "${schema}".wallet_service_provider_budgets WHERE provider_id='solana-publicnode-source'`)).rows[0]!.n;
  it('uses actual migrator LOGIN and rolls back seed on a post-import fence failure', async () => {
    const plan = replacement.createSourceReplacementPlan(fixture()); let calls = 0;
    await expect(replacement.importSourceReplacementContract(plan, { migration: migration(plan), measureExclusiveFence: async () => {
      if (++calls === 2) throw new Error('FENCE_LOST'); return proof(plan, Date.now() - 61000);
    } })).rejects.toThrow('FENCE_LOST');
    expect(await countNew()).toBe(0);
    expect((await admin.query(`SELECT count(*)::int n FROM "${schema}".wallet_service_import_ledger WHERE import_id='publicnode-contract'`)).rows[0]!.n).toBe(0);
  });
  it('commits exactly one reviewed seed and preserves old MAX cooldown/usage', async () => {
    const plan = replacement.createSourceReplacementPlan(fixture()), stoppedAtMs = Date.now() - 61000;
    const receipt = await replacement.importSourceReplacementContract(plan, { migration: migration(plan), measureExclusiveFence: async () => proof(plan, stoppedAtMs) });
    expect(receipt.committed).toBe(true); expect(receipt.stagedBudgets).toBe(1); expect(await countNew()).toBe(1);
    expect(receipt.fenceProofScope).toBe('isolated-test-port');
    const row = (await admin.query(`SELECT cooldown_until::text cooldown,requests_used FROM "${schema}".wallet_service_provider_budgets WHERE provider_id='solana-helius-source'`)).rows[0]!;
    expect(row).toEqual({ cooldown: '9223372036854775807', requests_used: 60 });
    expect(receipt.oldCooldownUntil).toBe('9223372036854775807');
  });
  it('refuses an expired lease when an old request process remains alive', async () => {
    await admin.query(`INSERT INTO "${schema}".wallet_service_provider_leases VALUES('gen','solana-helius-source',NULL,$1)`, [Date.now() - 1]);
    try {
      const plan = replacement.createSourceReplacementPlan(fixture()), stoppedAtMs = Date.now() - 61000;
      await expect(replacement.importSourceReplacementContract(plan, { migration: migration(plan),
        measureExclusiveFence: async () => ({ ...proof(plan, stoppedAtMs), measuredAtMs: Date.now(), processesExited: false, pendingRequestCount: 1 }) as unknown as replacement.SourceReplacementFence,
      })).rejects.toThrow('PHYSICAL_FENCE_REQUIRED');
    } finally { await admin.query(`DELETE FROM "${schema}".wallet_service_provider_leases`); }
  });
  it('refuses missing authority before writes', async () => {
    const plan = replacement.createSourceReplacementPlan(fixture()), m = migration(plan);
    await expect(replacement.importSourceReplacementContract(plan, { migration: { ...m, assertAuthorized: async () => { throw new Error('DENIED'); } },
      measureExclusiveFence: async () => proof(plan, Date.now() - 61000) })).rejects.toThrow('DENIED');
  });
  it('refuses live old leases without clearing them or touching the old pause', async () => {
    await admin.query(`INSERT INTO "${schema}".wallet_service_provider_leases VALUES('gen','solana-helius-source',NULL,$1)`, [Date.now() + 60000]);
    try {
      const plan = replacement.createSourceReplacementPlan(fixture());
      await expect(replacement.importSourceReplacementContract(plan, { migration: migration(plan),
        measureExclusiveFence: async () => proof(plan, Date.now() - 61000) })).rejects.toThrow('LEASES_NOT_DRAINED');
      expect((await admin.query(`SELECT count(*)::int n FROM "${schema}".wallet_service_provider_leases`)).rows[0]!.n).toBe(1);
    } finally { await admin.query(`DELETE FROM "${schema}".wallet_service_provider_leases`); }
  });
  it('rejects a stopped interval shorter than one full window', async () => {
    const plan = replacement.createSourceReplacementPlan(fixture());
    await expect(replacement.importSourceReplacementContract(plan, { migration: migration(plan),
      measureExclusiveFence: async () => proof(plan, Date.now() - 59000) })).rejects.toThrow('FULL_WINDOW_REQUIRED');
  });
  it('rejects an admin login pretending to be the migrator', async () => {
    const plan = replacement.createSourceReplacementPlan(fixture()), m = migration(plan);
    await m.pool.end();
    await expect(replacement.importSourceReplacementContract(plan, { migration: { ...m,
      pool: new Pool({ host: '127.0.0.1', port, database, user: 'postgres', password, max: 1 }) },
      measureExclusiveFence: async () => proof(plan, Date.now() - 61000) })).rejects.toThrow('identity_or_authority_mismatch');
  });
  it('rolls back a conflicting new contract including its new ledger row', async () => {
    const f = fixture(); f.review.importId = 'conflicting-import';
    f.trustedReviewSha256 = createHash('sha256').update(migrationCutoverCanonicalJson(f.review)).digest('hex');
    const plan = replacement.createSourceReplacementPlan(f);
    await expect(replacement.importSourceReplacementContract(plan, { migration: migration(plan),
      measureExclusiveFence: async () => proof(plan, Date.now() - 61000) })).rejects.toThrow('provider_seed_collision');
    expect((await admin.query(`SELECT count(*)::int n FROM "${schema}".wallet_service_import_ledger WHERE import_id='conflicting-import'`)).rows[0]!.n).toBe(0);
  });
});
