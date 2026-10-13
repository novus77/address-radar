import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, opendir, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire, builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { canonical, digest } from './install-production-postgres-business-schema.mjs';

const requireHere = createRequire(import.meta.url);
const entries = ['packages/database/src/postgres-business-schema.ts', 'packages/database/src/postgres-unit-of-work.ts'];
const demand = (value, code) => { if (!value) throw new Error(code); };
const inside = (root, path) => path === root || path.startsWith(root + sep);
const stamp = s => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.ctimeNs, s.mtimeNs].map(String).join(':');
export function validateOptions(options) {
  demand(options.protocolVersion === undefined || options.protocolVersion === 2, 'explicit_protocol_two_required');
  demand(typeof options.repository === 'string' && isAbsolute(options.repository)
    && typeof options.output === 'string' && isAbsolute(options.output)
    && Number.isInteger(options.maximumEntries) && options.maximumEntries >= 1 && options.maximumEntries <= 4096
    && Number.isSafeInteger(options.maximumBytes) && options.maximumBytes >= 1 && options.maximumBytes <= 134217728
    && Number.isInteger(options.maximumMs) && options.maximumMs >= 1 && options.maximumMs <= 180000, 'invalid_assembly_options');
}
export async function assembleRelease(input) {
  const options = { ...input, repository: input.repository ?? input.repo }; validateOptions(options);
  const deadline = performance.now() + options.maximumMs;
  const remaining = () => { demand(performance.now() < deadline, 'assembly_budget_exhausted'); };
  const repository = await realpath(options.repository), output = resolve(options.output);
  demand(!inside(repository, output) && !inside(output, repository), 'output_source_collision');
  try { await mkdir(output, { mode: 0o755 }); } catch (e) { if (e.code === 'EEXIST') throw new Error('output_already_exists'); throw e; }
  const outputIdentity = await lstat(output, { bigint: true });
  async function bindOutput() {
    remaining(); const s = await lstat(output, { bigint: true });
    demand(s.isDirectory() && !s.isSymbolicLink() && s.dev === outputIdentity.dev && s.ino === outputIdentity.ino
      && s.uid === outputIdentity.uid && !(s.mode & 0o022n), 'assembly_output_changed');
  }
  let written = 0, bytesWritten = 0;
  const files = new Map(), directories = new Set(), sourcePins = [], packagePaths = new Map(), processed = new Set();
  async function readStable(path, maximum = options.maximumBytes) {
    remaining(); const beforePath = await lstat(path, { bigint: true });
    // Build inputs may be hardlinked snapshots. Bind captured bytes; never claim source immutability.
    // Deployed artifacts remain freshly created single-link files, checked by the native entry.
    demand(beforePath.isFile() && !beforePath.isSymbolicLink() && beforePath.nlink >= 1n
      && beforePath.size <= BigInt(maximum), 'unsafe_or_oversize_build_input');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true }); demand(stamp(before) === stamp(beforePath), 'build_input_race');
      let size = 0; const chunks = [];
      while (true) {
        remaining(); const buffer = Buffer.alloc(Math.min(65536, maximum - size + 1));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        size += bytesRead; demand(size <= maximum, 'build_input_grew'); chunks.push(buffer.subarray(0, bytesRead));
      }
      demand(stamp(before) === stamp(await handle.stat({ bigint: true })) && stamp(before) === stamp(await lstat(path, { bigint: true }))
        && size === Number(before.size), 'build_input_changed');
      return Buffer.concat(chunks);
    } finally { await handle.close(); }
  }
  async function directory(suffix) {
    const parts = suffix.split('/'); let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!directories.has(current)) {
        remaining(); demand(++written <= options.maximumEntries, 'assembly_entries_exceeded');
        await bindOutput(); await mkdir(join(output, current), { mode: 0o755 }); directories.add(current);
      }
    }
  }
  async function write(suffix, body) {
    demand(!suffix.startsWith('/') && !suffix.split('/').some(p => !p || p === '.' || p === '..') && !files.has(suffix), 'output_path_collision');
    remaining(); demand(++written <= options.maximumEntries && bytesWritten + body.length <= options.maximumBytes, 'assembly_budget_exceeded');
    if (suffix.includes('/')) await directory(suffix.slice(0, suffix.lastIndexOf('/')));
    await bindOutput(); const handle = await open(join(output, suffix), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
    bytesWritten += body.length; files.set(suffix, { path: suffix, kind: 'file', mode: 0o644,
      size: body.length, sha256: createHash('sha256').update(body).digest('hex') });
  }
  await write('BUILD_PENDING', Buffer.from('partial build; no production authority\n'));
  await write('package.json', Buffer.from('{"private":true,"type":"module"}\n'));
  let esbuild;
  try { esbuild = requireHere('esbuild'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; esbuild = createRequire(requireHere.resolve('tsx'))('esbuild'); }
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
  async function runtimeSpecifiers(body, path) {
    for (const match of body.matchAll(/\b(?:import|require)\s*\(\s*([^)]*)\)/g)) {
      demand(/^["']/.test(match[1].trim()), 'runtime_dynamic_import_refused');
    }
    const result = await esbuild.build({ stdin: { contents: body, sourcefile: path, loader: 'js', resolveDir: repository },
      bundle: true, write: false, metafile: true, format: 'esm', logLevel: 'silent',
      plugins: [{ name: 'record-exact-runtime-imports', setup(build) {
        build.onResolve({ filter: /.*/ }, args => ({ path: args.path, external: true }));
      } }] });
    return [...new Set(Object.values(result.metafile.inputs).flatMap(input => input.imports.map(item => item.path)))];
  }
  function packageName(specifier) { return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]; }
  async function packageRoot(name, requireFrom) {
    demand(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), 'package_name_refused');
    let path;
    try { path = dirname(requireFrom.resolve(`${name}/package.json`)); }
    catch {
      path = dirname(requireFrom.resolve(name));
      while (true) {
        try { const data = JSON.parse((await readStable(join(path, 'package.json'), 1048576)).toString('utf8')); if (data.name === name) break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = dirname(path); demand(parent !== path, 'package_metadata_missing'); path = parent;
      }
    }
    path = await realpath(path); demand(inside(repository, path), 'dependency_outside_reviewed_repository'); return path;
  }
  async function copyPackage(name, requireFrom) {
    remaining(); const root = await packageRoot(name, requireFrom);
    if (packagePaths.has(name)) { demand(packagePaths.get(name) === root, 'flattened_dependency_version_conflict'); return; }
    packagePaths.set(name, root);
    const metadataBody = await readStable(join(root, 'package.json'), 1048576), metadata = JSON.parse(metadataBody.toString('utf8'));
    demand(metadata.name === name, 'dependency_name_changed');
    const packageRequire = createRequire(join(root, 'package.json'));
    async function walk(path, suffix, depth) {
      remaining(); demand(depth <= 32, 'package_depth_exceeded');
      const names = [], handle = await opendir(path);
      for await (const item of handle) { remaining(); demand(names.length < options.maximumEntries, 'package_entries_exceeded'); if (item.name !== 'node_modules') names.push(item.name); }
      for (const child of names.sort()) {
        const from = join(path, child), relative = suffix ? `${suffix}/${child}` : child;
        const info = await lstat(from, { bigint: true }); demand(!info.isSymbolicLink(), 'package_internal_symlink_refused');
        if (info.isDirectory()) await walk(from, relative, depth + 1);
        else { demand(info.isFile(), 'package_nonordinary_file_refused'); const body = await readStable(from, options.maximumBytes - bytesWritten);
          sourcePins.push({ path: `${name}/${relative}`, kind: 'package-input', sha256: createHash('sha256').update(body).digest('hex') });
          await write(`node_modules/${name}/${relative}`, body); }
      }
      const after = [], scan = await opendir(path);
      for await (const item of scan) { remaining(); demand(after.length < options.maximumEntries, 'package_rescan_exceeded'); if (item.name !== 'node_modules') after.push(item.name); }
      demand(canonical(names.sort()) === canonical(after.sort()), 'package_inventory_changed');
    }
    await walk(root, '', 0);
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) await copyPackage(dependency, packageRequire);
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {}).sort()) {
      try { await packageRoot(dependency, packageRequire); }
      catch (e) { if (e.code === 'MODULE_NOT_FOUND' || e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue; throw e; }
      await copyPackage(dependency, packageRequire);
    }
  }
  const databaseRequire = createRequire(join(repository, 'packages/database/package.json'));
  async function compileSource(path) {
    demand(inside(repository, path), 'source_outside_repository'); if (processed.has(path)) return; processed.add(path);
    demand(processed.size <= options.maximumEntries, 'source_entries_exceeded');
    const raw = await readStable(path, 1048576); const suffix = relative(repository, path).split(sep).join('/');
    sourcePins.push({ path: suffix, kind: 'source-input', sha256: createHash('sha256').update(raw).digest('hex') });
    let body = raw, destination = suffix;
    if (extname(path) === '.ts') {
      const result = await esbuild.transform(raw.toString('utf8'), { sourcefile: path, loader: 'ts', target: 'es2022',
        format: 'esm', sourcemap: false, logLevel: 'silent' });
      body = Buffer.from(result.code); destination = suffix.replace(/\.ts$/, '.js');
    }
    await write(destination, body);
    if (extname(destination) === '.json') return;
    for (const specifier of await runtimeSpecifiers(body.toString('utf8'), destination)) {
      if (builtins.has(specifier)) continue;
      if (specifier.startsWith('.')) {
        demand(!specifier.includes('?') && !specifier.includes('#'), 'source_specifier_refused');
        let dependency = resolve(dirname(path), specifier);
        if (dependency.endsWith('.js')) {
          const typescript = dependency.replace(/\.js$/, '.ts');
          try { await lstat(typescript); dependency = typescript; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        demand(['.ts', '.js', '.mjs', '.json'].includes(extname(dependency)), 'source_extension_refused');
        await compileSource(dependency);
      } else await copyPackage(packageName(specifier), createRequire(path));
    }
  }
  for (const entry of [...entries,...(options.protocolVersion===2?['apps/automation/src/postgres-service-schema.ts']:[])]) await compileSource(join(repository, entry));
  await copyPackage('pg', databaseRequire);
  // Execute only the compiled static plan export; no Pool or database connection is constructed here.
  remaining(); const schema = await import(pathToFileURL(join(output, 'packages/database/src/postgres-business-schema.js')).href);
  demand(schema.POSTGRES_BUSINESS_SCHEMA_PLAN && typeof schema.POSTGRES_BUSINESS_SCHEMA_PLAN.fingerprint === 'string', 'compiled_plan_export_missing');
  const service = options.protocolVersion===2 ? await import(pathToFileURL(join(output,'apps/automation/src/postgres-service-schema.js')).href) : null;
  const selectedPlan = service ? service.createPostgresServiceSchema({protocolVersion:2}).plan : schema.POSTGRES_BUSINESS_SCHEMA_PLAN;
  if(service) demand(selectedPlan.version===3 && canonical(selectedPlan.migrations.slice(0,1))===canonical(schema.POSTGRES_BUSINESS_SCHEMA_PLAN.migrations),'service_schema_prefix_changed');
  await write('build-manifest.json', Buffer.from(canonical({ version: 1, purpose: options.protocolVersion===2?'production-service-schema-protocol-two-runtime':'production-schema-installer-runtime',
    compiler: 'esbuild', compilerVersion: esbuild.version, nodeVersion: process.version, schemaPlan: selectedPlan,
    inputs: sourcePins.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }) + '\n'));
  await bindOutput(); await unlink(join(output, 'BUILD_PENDING')); files.delete('BUILD_PENDING');
  const inventory = [...files.values(), ...[...directories].map(path => ({ path, kind: 'directory', mode: 0o755 }))]
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { status: 'compiled_schema_release_assembled', root: output, inventorySha256: digest(inventory),
    entries: inventory.length, bytes: inventory.filter(v => v.kind === 'file').reduce((n, v) => n + v.size, 0),
    schemaPlan: selectedPlan, productionMigrationReady: false, databaseConnected: false,
    deploymentOwnershipMeasured: false, fullCapacityProved: false };
}
async function cli() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    demand(['--repository', '--output', '--maximum-entries', '--maximum-bytes', '--maximum-ms', '--protocol-version'].includes(process.argv[i])
      && process.argv[i + 1] && !Object.hasOwn(args, process.argv[i]), 'invalid_cli'); args[process.argv[i]] = process.argv[i + 1];
  }
  return assembleRelease({ repository: args['--repository'], output: args['--output'], maximumEntries: Number(args['--maximum-entries']),
    maximumBytes: Number(args['--maximum-bytes']), maximumMs: Number(args['--maximum-ms']),
    ...(args['--protocol-version']===undefined?{}:{protocolVersion:Number(args['--protocol-version'])}) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().then(value => process.stdout.write(JSON.stringify(value) + '\n'), () => {
    process.stdout.write(JSON.stringify({ status: 'refused', code: 'assembly_failed_partial_preserved', productionMigrationReady: false }) + '\n'); process.exitCode = 1;
  });
}
