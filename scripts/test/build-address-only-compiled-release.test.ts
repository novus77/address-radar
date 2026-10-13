import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAddressOnlyCompiledRelease, inventoryRelease } from '../build-address-only-compiled-release.mjs';
it('builds exclusive standalone inventory without native pg or SQLite open', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'radar-builder-'));
  try {
    const root = join(parent, 'release');
    const result = await buildAddressOnlyCompiledRelease({ output: root, seal: false });
    expect(result.sealed).toBe(false);
    expect(result.releaseSha256).toBe((await inventoryRelease(root)).releaseSha256);
    expect(result.entrySha256).toMatch(/^[a-f0-9]{64}$/);
    const pg = spawnSync(process.execPath, ['--no-global-search-paths', '--input-type=module', '-e',
      `import pg,{Pool,Client} from ${JSON.stringify(join(root, 'pg.mjs'))};
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
require("node:net").Socket.prototype.connect=()=>{throw Error("NETWORK_FORBIDDEN")};
if(Pool!==pg.Pool || Client!==pg.Client) throw Error("Driver export mismatch");
const client=new Client({connectionString:"postgresql://smoke@127.0.0.1:1/smoke"});
const pool=new Pool({Client,max:1});
if(typeof client.connect!=="function" || typeof pool.connect!=="function") throw Error("Constructor ABI missing");
await pool.end();
try { pg.native; process.exit(7); } catch {}`], { env: {} });
    expect(pg.status, pg.stderr.toString()).toBe(0);
    const dispatch = spawnSync(process.execPath, [join(root, 'scripts/postgres-address-only-dispatch.mjs'), 'scanner'], { env: {} });
    expect(dispatch.status).toBe(1);
    expect(dispatch.stderr.toString()).toContain('Explicit compiled PostgreSQL');
    await expect(buildAddressOnlyCompiledRelease({ output: root, seal: false })).rejects.toThrow();
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 30000);

it('refuses fake sealing without root and native driver activation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'radar-native-'));
  try {
    if (process.geteuid?.() !== 0) {
      await expect(buildAddressOnlyCompiledRelease({ output: join(parent, 'sealed') })).rejects.toThrow('root');
    }
    const root = join(parent, 'release');
    await buildAddressOnlyCompiledRelease({ output: root, seal: false });
    for (const name of ['pg.mjs', 'scripts/postgres-service-entry.mjs', 'scripts/postgres-address-only-dispatch.mjs']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(root, name))})`],
        { cwd: parent, env: { NODE_PG_FORCE_NATIVE: '1' } });
      expect(child.status).toBe(1); expect(child.stderr.toString()).toContain('Native PostgreSQL driver forbidden');
    }
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);require('node:sqlite').DatabaseSync=class {constructor(){throw Error('SQLite open forbidden')}};syncBuiltinESMExports();await import(${JSON.stringify(join(root, 'scripts/postgres-service-entry.mjs'))});`], { cwd: parent, env: {} });
    expect(child.status, child.stderr.toString()).toBe(0);
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 30000);

it('matches the dispatcher wire digest independently including modes, directories and every bundle', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile, lstat } = await import('node:fs/promises');
  const parent = await mkdtemp(join(tmpdir(), 'radar-inventory-'));
  try {
    const root = join(parent, 'release');
    const result = await buildAddressOnlyCompiledRelease({ output: root, seal: false });
    const hash = createHash('sha256');
    for (const path of ['.', 'pg.mjs', 'scripts', 'scripts/postgres-address-only-dispatch.mjs', 'scripts/postgres-service-entry.mjs']) {
      const stat = await lstat(join(root, path));
      const record: Record<string, unknown> = { path, mode: stat.mode & 0o777, kind: stat.isDirectory() ? 'directory' : 'file' };
      if (stat.isFile()) {
        const bytes = await readFile(join(root, path));
        record.size = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
        if (path === 'scripts/postgres-service-entry.mjs') expect(record.sha256).toBe(result.entrySha256);
      }
      hash.update(JSON.stringify(record) + '\n');
    }
    expect(result.releaseSha256).toBe(hash.digest('hex'));
    expect(result.entries).toBe(5);
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 30000);

it('runs the standalone config generator without entering the imported service CLI', async () => {
  const { buildAddressOnlyConfigGenerator } = await import('../build-address-only-compiled-release.mjs');
  const { writeFile, realpath } = await import('node:fs/promises');
  const parent = await mkdtemp(join(tmpdir(), 'radar-configgen-'));
  try {
    const output = join(parent, 'configgen.mjs');
    const result = await buildAddressOnlyConfigGenerator({ output, seal: false });
    expect(result.sealed).toBe(false);
    const input = join(parent, 'input.json');
    await writeFile(input, JSON.stringify({ manifest: { protocol: 'address-only-v1', operationId: 'bundle-operation',
      importId: 'bundle-import', generationId: 'bundle-generation', activatedAt: 1000,
      planSha256: 'a'.repeat(64), seedSha256: 'b'.repeat(64), cohortSha256: 'c'.repeat(64),
      walletCount: 1, entityCount: 1, releaseSha256: 'd'.repeat(64), backupSha256: 'e'.repeat(64), fenceSha256: 'f'.repeat(64),
      target: { database: 'address_radar', schema: 'address_radar_business', schemaFingerprint: 'a'.repeat(64),
        systemIdentifier: '7693392208475083526', serverAddress: '127.0.0.1', serverPort: 5432 },
      gatewayDeliveryEnabled: false, fomoEnabled: false, fullHistoricalMiningEnabled: false },
      releaseRoot: '/var/lib/address-radar-release', execution: { maximumEntries: 5, maximumBytes: 10000000 },
      roles: Object.fromEntries(['scanner','automation','wallet-monitor','wallet-analysis','historical-backfill','console']
        .map(service => [service, 'address_radar_' + service.replaceAll('-', '_')])), intervalMs: 15000 }));
    const child = spawnSync(process.execPath, ['--no-global-search-paths', await realpath(output), input], { cwd: parent, env: {} });
    expect(child.status, child.stderr.toString()).toBe(0);
    expect(child.stderr.toString()).not.toContain('Explicit PostgreSQL business service required');
    const generated = JSON.parse(child.stdout.toString());
    expect(generated.deployment.sources).toEqual({ mode: 'waiting_configuration' });
    expect(generated.deployment).not.toHaveProperty('wallet');
    expect(generated.deployment).not.toHaveProperty('composition');
    await expect(buildAddressOnlyConfigGenerator({ output, seal: false })).rejects.toThrow();
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 30000);

it('imports the standalone floor runner as a root library without stdin, DB or RPC side effects', async () => {
  const { buildAddressOnlyMaintenanceModule } = await import('../build-address-only-compiled-release.mjs');
  const { writeFile } = await import('node:fs/promises');
  const parent = await mkdtemp(join(tmpdir(),'radar-floor-library-'));
  try {
    const entry=join(parent,'entry.mjs'), probe=join(parent,'probe.mjs'), output=join(parent,'library.mjs');
    const runner=new URL('../measure-address-only-evm-bootstrap-floors.ts',import.meta.url).pathname;
    await writeFile(entry,`import {runFloorJob} from ${JSON.stringify(runner)};if(typeof runFloorJob!=='function')throw Error('missing runner');console.log('LIBRARY_ONLY');`);
    await writeFile(probe,`
import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url);
Object.defineProperty(process,'geteuid',{value:()=>0});
const refuse=()=>{throw Error('FORBIDDEN_SIDE_EFFECT')};
process.stdin.read=refuse;process.stdin.resume=refuse;process.stdin.on=refuse;
const fs=require('node:fs');const read=fs.readSync;
fs.readSync=function(fd,...args){if(fd===0)refuse();return read.call(this,fd,...args)};
require('node:net').Socket.prototype.connect=refuse;
require('node:tls').connect=refuse;require('node:http').request=refuse;require('node:https').request=refuse;
globalThis.fetch=refuse;syncBuiltinESMExports();`);
    await buildAddressOnlyMaintenanceModule({entry,output,seal:false});
    // stdin remains an open pipe: an accidental imported CLI cannot wait for input unnoticed.
    const child=spawnSync(process.execPath,['--import',probe,output],{env:{},timeout:5000});
    expect(child.error).toBeUndefined();expect(child.status,child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toBe('LIBRARY_ONLY\n');expect(child.stderr.toString()).toBe('');
  } finally {await rm(parent,{recursive:true,force:true});}
},30000);

it('keeps the selected floor runner and native preflight CLIs, but suppresses imported CLIs',async()=>{
  const {buildAddressOnlyMaintenanceModule}=await import('../build-address-only-compiled-release.mjs');
  const {realpath}=await import('node:fs/promises');
  const parent=await mkdtemp(join(tmpdir(),'radar-maintenance-cli-'));
  try {
    for(const [name,expected] of [
      ['measure-address-only-evm-bootstrap-floors','{"error":"EVM_FLOOR_REFUSED"}'],
      ['postgres-address-only-configured-preflight','Configured native preflight refused; no deployment authorization issued'],
    ]) {
      const output=join(parent,name+'.mjs');
      await buildAddressOnlyMaintenanceModule({entry:new URL('../'+name+'.ts',import.meta.url).pathname,output,seal:false});
      const child=spawnSync(process.execPath,[await realpath(output)],{env:{},timeout:5000});
      expect(child.error).toBeUndefined();expect(child.status).toBe(1);
      expect(child.stdout.toString()).toBe('');expect(child.stderr.toString().trim()).toBe(expected);
    }
  } finally {await rm(parent,{recursive:true,force:true});}
},30000);


it('isolates final producer and validator mains while preserving the selected CLI', async () => {
  const { buildAddressOnlyMaintenanceModule } = await import('../build-address-only-compiled-release.mjs');
  const { writeFile, realpath } = await import('node:fs/promises');
  const parent = await mkdtemp(join(tmpdir(), 'radar-final-producer-cli-'));
  try {
    for (const [name, argument, expected] of [
      ['produce-final-source-material', '--generate', '{"status":"REFUSED_NOT_EXECUTED"}'],
      ['validate-production-source-material', '--validate',
        '{"status":"REFUSED_NOT_EXECUTED","reasonCode":"PRODUCTION_SOURCE_MATERIAL_REFUSED"}'],
    ]) {
      const output = join(parent, name + '.mjs');
      await buildAddressOnlyMaintenanceModule({ entry: new URL('../' + name + '.ts', import.meta.url).pathname,
        output, seal: false });
      const child = spawnSync(process.execPath, ['--no-global-search-paths', await realpath(output), argument!],
        { env: {}, input: '{}', timeout: 5000, maxBuffer: 8192 });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stdout.toString()).toBe(expected + '\n');
      expect(child.stderr.toString()).toBe('');
    }
    const entry = join(parent, 'entry.mjs'), output = join(parent, 'library.mjs');
    await writeFile(entry, `import {generateFinalSourceMaterial} from ${JSON.stringify(
      new URL('../produce-final-source-material.ts', import.meta.url).pathname)};
if(typeof generateFinalSourceMaterial!=='function')throw Error('missing producer');console.log('LIBRARY_ONLY');`);
    await buildAddressOnlyMaintenanceModule({ entry, output, seal: false });
    const child = spawnSync(process.execPath, ['--no-global-search-paths', await realpath(output)],
      { env: {}, input: '{}', timeout: 5000, maxBuffer: 8192 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toBe('LIBRARY_ONLY\n');
    expect(child.stderr.toString()).toBe('');
  } finally { await rm(parent, { recursive: true, force: true }); }
}, 30000);
