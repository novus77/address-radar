import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assembleRelease, validateOptions } from '../assemble-production-postgres-schema-release.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'radar-schema-assembler-test-'));
  const repo = join(root, 'repo'); await mkdir(join(repo, 'packages/database/src'), { recursive: true });
  await writeFile(join(repo, 'package.json'), '{"type":"module"}');
  await writeFile(join(repo, 'packages/database/src/postgres-business-schema.ts'),
    'import { value } from "./dependency.js"; export const POSTGRES_BUSINESS_SCHEMA_PLAN = {version:1,fingerprint:value,migrations:[]};');
  await writeFile(join(repo, 'packages/database/src/dependency.ts'), 'export const value: string = "a".repeat(64);');
  await writeFile(join(repo, 'packages/database/src/postgres-unit-of-work.ts'), 'export function createPostgresUnitOfWork(pool: unknown) { return pool; }');
  const pg = join(repo, 'packages/database/node_modules/pg'); await mkdir(join(pg, 'lib'), { recursive: true });
  await writeFile(join(pg, 'package.json'), '{"name":"pg","version":"0.0.0-fixture","main":"lib/index.js"}');
  await writeFile(join(pg, 'lib/index.js'), 'module.exports = {Pool:class Pool {}};');
  return { root, repo, output: join(root, 'release'), maximumEntries: 4096, maximumBytes: 134217728, maximumMs: 180000 };
}
test('assembles executable JS closure plus copied PG; deterministic deployed inventory; never connects', async () => {
  const options = await fixture();
  try {
    const receipt = await assembleRelease(options);
    assert.equal(receipt.status, 'compiled_schema_release_assembled');
    assert.equal(receipt.schemaPlan.fingerprint, 'a'.repeat(64));
    assert.equal((await import(pathToFileURL(join(options.output, 'packages/database/src/dependency.js')).href)).value, 'a'.repeat(64));
    assert.match(await readFile(join(options.output, 'node_modules/pg/lib/index.js'), 'utf8'), /Pool/);
    assert.equal(receipt.productionMigrationReady, false); assert.equal(receipt.databaseConnected, false);
    assert.equal(receipt.inventorySha256.length, 64);
    await assert.rejects(assembleRelease(options), /output_already_exists/);
  } finally { await rm(options.root, { recursive: true, force: true }); }
});
test('bounded limits and symlink/dynamic import source refusal preserve partial build', async () => {
  assert.throws(() => validateOptions({repository:'/repo',output:'/out',maximumEntries:5000,maximumBytes:1,maximumMs:1}));
  for (const kind of ['symlink', 'dynamic', 'budget']) {
    const options = await fixture();
    try {
      if (kind === 'symlink') {
        await rm(join(options.repo, 'packages/database/src/dependency.ts'));
        await symlink('/etc/passwd', join(options.repo, 'packages/database/src/dependency.ts'));
      }
      if (kind === 'dynamic') await writeFile(join(options.repo, 'packages/database/src/postgres-business-schema.ts'), 'const path="x"; export const x=import(path);');
      if (kind === 'budget') options.maximumEntries = 1;
      await assert.rejects(assembleRelease(options));
      assert.match(await readFile(join(options.output, 'BUILD_PENDING'), 'utf8'), /partial/);
    } finally { await rm(options.root, { recursive: true, force: true }); }
  }
});
test('hardlinked build snapshots become fresh single-link deployed files, not immutable-source proof', async () => {
  const options = await fixture();
  try {
    await link(join(options.repo, 'packages/database/src/dependency.ts'), join(options.root, 'shared-source.ts'));
    const receipt = await assembleRelease(options);
    assert.equal(receipt.deploymentOwnershipMeasured, false);
    assert.equal((await lstat(join(options.output, 'packages/database/src/dependency.js'))).nlink, 1);
  } finally { await rm(options.root, { recursive: true, force: true }); }
});
