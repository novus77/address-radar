import { createRequire, builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, chmod, chown, lstat, readdir, readFile, open, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('tsx/package.json'))('esbuild');
const pgRequire = createRequire(join(sourceRoot, 'packages/database/package.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// This is the exact preorder, sorted-child wire encoding used by the dispatcher.
export async function inventoryRelease(root) {
  const hash = createHash('sha256');
  let entries = 0, bytes = 0;
  const walk = async path => {
    const stat = await lstat(path);
    if (++entries > 10000 || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())
      || (stat.isFile() && stat.nlink !== 1)) throw new Error('Unsafe release inventory');
    const name = relative(root, path).split('\\').join('/') || '.';
    if (stat.isDirectory()) {
      hash.update(JSON.stringify({ path: name, mode: stat.mode & 0o777, kind: 'directory' }) + '\n');
      for (const child of (await readdir(path)).sort()) await walk(join(path, child));
    } else {
      if ((bytes += stat.size) > 256 * 1024 * 1024) throw new Error('Release byte budget exceeded');
      const content = await readFile(path);
      hash.update(JSON.stringify({ path: name, mode: stat.mode & 0o777, kind: 'file', size: content.length, sha256: sha(content) }) + '\n');
    }
  };
  await walk(root);
  return { releaseSha256: hash.digest('hex'), entries, bytes };
}


/** Disable only the imported service executable. Keep the chosen entry's CLI intact.
 * Plain esbuild bundling collapses import.meta.url and cannot distinguish these mains.
 */
export function addressOnlyServiceEntryLibraryPlugin() {
  return { name: 'address-only-service-entry-library', setup(build) {
    build.onLoad({ filter: /[\\/]postgres-service-entry\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const guard = 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {';
      if (source.split(guard).length !== 2) throw new Error('Service entry CLI guard contract changed');
      return { contents: source.replace(guard, 'if (false) {'), loader: 'ts' };
    });
  } };
}

/** Imported CLIs must not compare a collapsed bundle import.meta.url with argv[1]. */
export function addressOnlyMaintenanceCliLibraryPlugin(entry) {
  const guards = new Map([
    ['provision-address-only-runtime-authority.ts', 'if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {'],
    ['validate-production-source-material.ts', 'if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {'],
    ['produce-final-source-material.ts', 'if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {'],
    ['create-address-only-waiting-deployment.ts', 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {'],
    ['postgres-address-only-configured-preflight.ts', 'if(process.argv[1] && import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href) {'],
    ['measure-address-only-evm-bootstrap-floors.ts', 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();'],
  ]);
  return { name: 'address-only-maintenance-cli-library', setup(build) {
    build.onLoad({ filter: /[\\/](provision-address-only-runtime-authority|postgres-address-only-configured-preflight|measure-address-only-evm-bootstrap-floors|create-address-only-waiting-deployment|validate-production-source-material|produce-final-source-material)\.ts$/ }, async ({ path }) => {
      if (resolve(path) === entry) return;
      const name = path.split(/[\\/]/).at(-1), guard = guards.get(name);
      const source = await readFile(path, 'utf8');
      if (!guard || source.split(guard).length !== 2) throw new Error('Maintenance CLI guard contract changed');
      const replacement = name === 'measure-address-only-evm-bootstrap-floors.ts' ? 'if (false) void main();' : 'if (false) {';
      return { contents: source.replace(guard, replacement), loader: 'ts' };
    });
  } };
}

function standaloneBuildOptions(libraryOnly, entry) {
  const nativeDisabled = { name: 'disable-pg-native', setup(build) {
    build.onResolve({ filter: /^pg-native$/ }, () => ({ path: 'pg-native', namespace: 'disabled-native' }));
    build.onLoad({ filter: /.*/, namespace: 'disabled-native' }, () => ({
      contents: 'throw new Error("Native PostgreSQL driver forbidden");', loader: 'js',
    }));
  } };
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
  const common = { bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', target: 'node24',
    absWorkingDir: sourceRoot, alias: { pg: pgRequire.resolve('pg') }, plugins: [nativeDisabled, ...(libraryOnly ? [addressOnlyServiceEntryLibraryPlugin(), addressOnlyMaintenanceCliLibraryPlugin(entry)] : [])],
    banner: { js: 'import {createRequire as __radarRequire} from "node:module";const require=__radarRequire(import.meta.url);if(process.env.NODE_PG_FORCE_NATIVE!==undefined)throw new Error("Native PostgreSQL driver forbidden");' } };
  return common;
}

async function requireProtectedOutput(output, seal) {
  if (!isAbsolute(output) || resolve(output) !== output) throw new Error('Canonical absolute output required');
  if (seal && process.geteuid?.() !== 0) throw new Error('Actual root ownership required to seal release');
  if (seal) {
    for (let parent = resolve(output, '..');;) {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0
        || await realpath(parent) !== parent) throw new Error('Protected root-owned release ancestry required');
      try { await lstat(join(parent, 'node_modules')); throw new Error('Ambient module resolution refused'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const next = resolve(parent, '..'); if (next === parent) break; parent = next;
    }
  }
}

export async function buildAddressOnlyMaintenanceModule({ entry, output, seal = true }) {
  await requireProtectedOutput(output, seal);
  if (!output.endsWith('.mjs') || !isAbsolute(entry) || resolve(entry) !== entry) throw new Error('Explicit ESM entry and output required');
  const handle = await open(output, 'wx', 0o600);
  try {
    const result = await esbuild.build({ ...standaloneBuildOptions(true, entry), entryPoints: [entry] });
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
    for (const item of Object.values(result.metafile.outputs)) for (const dependency of item.imports) {
      if (dependency.external && !builtins.has(dependency.path)) throw new Error('Unbundled dependency: ' + dependency.path);
    }
    if (result.outputFiles.length !== 1 || result.outputFiles[0].contents.length > 128 * 1024 * 1024) throw new Error('Standalone bundle bound exceeded');
    const bytes = result.outputFiles[0].contents;
    await handle.writeFile(bytes);
    if (seal) { await handle.chown(0, 0); await handle.chmod(0o444); }
    await handle.sync();
    const parent = await open(resolve(output, '..'), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return { output, sealed: seal, sha256: sha(bytes), bytes: bytes.length };
  } finally { await handle.close(); }
}

export async function buildAddressOnlyConfigGenerator(options) {
  return buildAddressOnlyMaintenanceModule({ ...options, entry: join(sourceRoot, 'scripts/create-address-only-waiting-deployment.ts') });
}

export async function buildAddressOnlyCompiledRelease({ output, seal = true }) {
  await requireProtectedOutput(output, seal);
  // Never reuse, replace or delete an existing output. Failed builds remain private and untrusted.
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, 'scripts'), { mode: 0o700 });
  const common = standaloneBuildOptions(false);
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
  const specifications = [
    ['scripts/postgres-service-entry.mjs', { entryPoints: [join(sourceRoot, 'scripts/postgres-service-entry.ts')] }],
    ['scripts/postgres-address-only-dispatch.mjs', { entryPoints: [join(sourceRoot, 'scripts/postgres-address-only-dispatch.ts')] }],
    ['pg.mjs', { stdin: { contents: 'import pg from "pg";export default pg;export const Pool=pg.Pool;export const Client=pg.Client;', resolveDir: sourceRoot, sourcefile: 'pg-entry.mjs' } }],
  ];
  for (const [name, input] of specifications) {
    const result = await esbuild.build({ ...common, ...input });
    for (const item of Object.values(result.metafile.outputs)) for (const dependency of item.imports) {
      if (dependency.external && !builtins.has(dependency.path)) throw new Error(`Unbundled dependency: ${dependency.path}`);
    }
    if (result.outputFiles.length !== 1) throw new Error('Single standalone output required');
    await writeFile(join(output, name), result.outputFiles[0].contents, { flag: 'wx', mode: 0o600 });
  }
  for (const name of ['scripts/postgres-service-entry.mjs', 'scripts/postgres-address-only-dispatch.mjs', 'pg.mjs', 'scripts', '.']) {
    const path = join(output, name);
    if (seal) await chown(path, 0, 0);
    await chmod(path, seal ? (name === '.' || name === 'scripts' ? 0o555 : 0o444) : (name === '.' || name === 'scripts' ? 0o700 : 0o600));
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const parent = await open(resolve(output, '..'), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  return { output, sealed: seal, executionFormat: 'compiled-esm', ...(await inventoryRelease(output)),
    entrySha256: sha(await readFile(join(output, 'scripts/postgres-service-entry.mjs'))),
    dispatcherSha256: sha(await readFile(join(output, 'scripts/postgres-address-only-dispatch.mjs'))),
    pgSha256: sha(await readFile(join(output, 'pg.mjs'))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 4 && process.argv[2] === '--config-generator') {
    console.log(JSON.stringify(await buildAddressOnlyConfigGenerator({ output: process.argv[3] })));
  } else {
    if (process.argv.length !== 3) throw new Error('Usage: node build-address-only-compiled-release.mjs [--config-generator] /absolute/new-output');
    console.log(JSON.stringify(await buildAddressOnlyCompiledRelease({ output: process.argv[2] })));
  }
}
