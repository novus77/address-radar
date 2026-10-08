import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationDeadline, validateOutputDirectoryChain, runBoundedChild } from '../prepare-address-only-final-plan.mjs';

test('deadline includes loading time and never resets between steps', () => {
  let time = 10;
  const check = createOperationDeadline(30, () => time);
  time = 39; check(); time = 40;
  assert.throws(check, /deadline/);
});
test('output chain refuses a symlink or writable intermediate ancestor', () => {
  const good = () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o40700 });
  for (const bad of [{ ...good(), isSymbolicLink: () => true }, { ...good(), mode: 0o40777 }, { ...good(), uid: 501 }]) {
    assert.throws(() => validateOutputDirectoryChain([good(), bad]), /unprotected/);
  }
  validateOutputDirectoryChain([good(), good()]);
});
test('hard timeout terminates synchronous worker even when its event loop is blocked', async () => {
  const result = await runBoundedChild(['-e', 'while(true){}'], 80);
  assert.equal(result.status, 'refused');
  assert.equal(result.timedOut, true);
});
test('worker output is bounded without printing partial success', async () => {
  const result = await runBoundedChild(['-e', 'process.stdout.write("x".repeat(100000))'], 3000);
  assert.equal(result.status, 'refused');
  assert.equal(result.outputExceeded, true);
  assert.equal(result.stdout, '');
});
