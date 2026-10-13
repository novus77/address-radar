import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const enabled = process.env.ADDRESS_RADAR_REPORTED_MARKET_LOCAL_PG === '1';
const cases = ['reported_100k', 'fdv_only', 'missing_approval', 'candle_only_approval', 'conflicting_approval',
  'revoked_approval', 'expired_approval', 'wrong_approval_provider', 'wrong_approval_mapping', 'source_snapshot_conflict',
  'pending_revision', 'wrong_revision', 'expired_sample', 'expired_signature', 'revoked_validator',
  'rollback_attestation', 'rollback_wake', 'rollback_consumer', 'commit_ack_unknown', 'acl_drift',
  'role_scanner', 'role_automation', 'role_wallet_monitor', 'role_wallet_analysis', 'role_historical_backfill', 'role_console', 'role_migrator',
  'dedicated_revoke_before_publish','dedicated_revoke_before_read','dedicated_revoke_before_ack',
  'dedicated_expired_before_publish','dedicated_expired_before_read','dedicated_expired_before_ack',
  'dedicated_scope_drift','dedicated_fingerprint_drift','dedicated_identity_drift',
  'dedicated_revoke_rollback','dedicated_revoke_commit_unknown',
  'dedicated_revoke_blocks_publish','dedicated_publish_blocks_revoke',
  'dedicated_revoke_blocks_ack','dedicated_ack_blocks_revoke',
  'dedicated_publish_expiry_rollback','dedicated_ack_expiry_rollback','dedicated_overlong_signature_ttl','dedicated_acl','dedicated_pg_control_acl',"loader_100k","loader_revoke_publish","loader_revoke_consume","loader_provider_revoke","loader_validator_revoke","loader_scope","loader_generation","loader_cluster","loader_credential","loader_key","loader_allocation","loader_401","loader_403","loader_429","loader_cancel","loader_budget_window","loader_identity","loader_material_mode","loader_material_symlink","loader_material_drift","loader_provider_scope","loader_validator_scope"] as const;

// This suite creates its own Docker cluster. It never consumes a production/test connection URL.
describe.skipIf(!enabled)('isolated native reported-market LOGIN/ACL acceptance (not production authority)', () => {
  const nonce = randomBytes(8).toString('hex'), database = 'radar_rehearsal_' + nonce;
  const password = randomBytes(32).toString('hex');
  let pg = '', directory = '';
  function docker(args: string[], input?: string, timeout = 15000, passwordEnvironment = false) {
    try {
      return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 65536,
        stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }),
        ...(passwordEnvironment ? { env: { ...process.env, POSTGRES_PASSWORD: password } } : {}) }).trim();
    } catch (error) {
      const result = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
      const output = String(result.stdout ?? '');
      // Workers return only closed diagnostic metadata; never expose docker argv/stderr or PG messages.
      if (output.length <= 4096 && /^\{"status":"failed",/.test(output) && !output.includes(password)) throw new Error(output);
      let oomKilled = false, diskExhausted = false;
      if (pg) {
        try { oomKilled = execFileSync('docker', ['inspect', '--format', '{{.State.OOMKilled}}', pg],
          { encoding:'utf8',timeout:2000,maxBuffer:1024,stdio:['ignore','pipe','ignore'] }).trim()==='true'; } catch { /* Diagnostic only. */ }
        const log=spawnSync('docker',['logs','--tail','30',pg],{encoding:'utf8',timeout:2000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
        diskExhausted=/No space left on device/.test(String(log.stdout)+String(log.stderr));
      }
      throw new Error(JSON.stringify({status:'isolated_native_command_failed',exitStatus:result.status??null,oomKilled,
        diskExhausted:diskExhausted||/No space left on device/.test(String(result.stderr??''))}));
    }
  }
  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'reported-market-native-')));
    const builder = new URL('../../../scripts/build-address-only-compiled-release.mjs', import.meta.url);
    const entry = fileURLToPath(new URL('./support/postgres-reported-market-native-fixture.ts', import.meta.url));
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e',
        'const {buildAddressOnlyMaintenanceModule}=await import(process.argv[1]);await buildAddressOnlyMaintenanceModule({entry:process.argv[2],output:process.argv[3],seal:false});',
        pathToFileURL(fileURLToPath(builder)).href, entry, join(directory, 'fixture.mjs')],
      { timeout: 15000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw new Error('isolated_fixture_bundle_failed'); }
    // Keep real durability settings; bound WAL to fit repeated real-DDL scenarios in the tmpfs.
    pg = docker(['run', '--pull=never', '-d', '--memory=512m', '--cpus=1', '--pids-limit=128',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=256m', '-e', 'POSTGRES_PASSWORD',
      '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256', '-e', 'POSTGRES_DB=' + database, 'pgvector/pgvector:pg16',
      'postgres','-c','shared_buffers=32MB','-c','max_wal_size=64MB','-c','min_wal_size=32MB'], undefined, 15000, true);
    expect(pg).toMatch(/^[a-f0-9]{64}$/);
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt++) {
      try { ready = docker(['exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', database]).includes('accepting connections'); }
      catch { /* Fresh fixture initialization only; never retry a business operation. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
  }, 30000);
  afterAll(() => {
    try { if (pg) docker(['rm', '-f', pg]); }
    finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(cases)('%s through real TCP identities and schema', scenario => {
    const name = 'reported-node-' + nonce + '-' + scenario.replaceAll('_', '-');
    let output = '';
    try {
      output = docker(['run', '--rm', '-i', '--pull=never', '--name', name, '--network', 'container:' + pg,
        '--read-only', '--tmpfs', '/tmp:rw,size=16m', '--tmpfs', '/authority:rw,size=2m,mode=0700', '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true',
        '--memory=256m', '--cpus=1', '--pids-limit=64', '-v', directory + ':/input:ro',
        '--entrypoint', 'node', 'openclew/trial-base:latest', '--no-global-search-paths', '--input-type=module', '-e', "await import('file:///input/fixture.mjs')", '--', '--isolated-fixture'],
      JSON.stringify({ nonce, database, password, scenario }), 35000);
    } finally {
      // Only this invocation's nonce-bound container may be removed after an interrupted docker client.
      try { docker(['rm', '-f', name]); } catch { /* --rm normally already removed it. */ }
    }
    expect(output).not.toContain(password);
    expect(JSON.parse(output)).toMatchObject({ status: 'passed', scenario, fixtureOnly: true,
      productionAuthorityProven: false, externalRequests: 0, setRoleUsed: false });
  }, 40000);
});
