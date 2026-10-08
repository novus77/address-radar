import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRACT } from '../migration-authority-bootstrap.mjs';

test('bootstrap pins match the reviewed coordinator and closure source bytes', () => {
  const files = {
    coordinatorSha256: '../../packages/database/src/migration-cutover-coordinator.ts',
    closureSha256: '../../packages/database/src/migration-writer-fence-closure.ts',
  };
  for (const [key, path] of Object.entries(files)) {
    const actual = createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');
    assert.equal(CONTRACT[key], actual, key + ' requires explicit contract review after source changes');
  }
});
