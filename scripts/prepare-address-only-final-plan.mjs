import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
const demand = (condition, reason) => { if (!condition) throw new Error(reason); };
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const root = '/var/lib/address-radar-maintenance-tools/';
const safePath = path => typeof path === 'string' && resolve(path) === path && path.startsWith(root);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

export function validateFinalCapture(job, seedBytes, receipt) {
  demand(exact(job, ['version', 'seed', 'receipt', 'cohort', 'outputDirectory', 'review']) && job.version === 1, 'invalid_job');
  for (const pin of [job.seed, job.receipt, job.cohort]) {
    demand(exact(pin, ['path', 'sha256']) && safePath(pin.path) && hex(pin.sha256), 'invalid_pin');
  }
  demand(safePath(job.outputDirectory) && !job.outputDirectory.endsWith('/'), 'invalid_output');
  demand(job.receipt.path === job.seed.path + '.receipt.json', 'receipt_path_mismatch');
  demand(receipt?.status === 'fenced-address-only-seed-captured'
    && receipt.sourceDatabase === '/var/lib/address-radar/address-radar.db'
    && receipt.seedSha256 === job.seed.sha256 && digest(seedBytes) === job.seed.sha256
    && receipt.sourceWrites === false && receipt.databaseImported === false
    && receipt.activationAuthorized === false && receipt.gatewayDeliveryEnabled === false
    && hex(receipt.beforeBoundarySha256) && hex(receipt.afterBoundarySha256), 'unverified_capture');
  const seed = JSON.parse(seedBytes.toString('utf8'));
  demand(seed.capturedAt === receipt.capturedAt && Number.isFinite(Date.parse(seed.capturedAt))
    && seed.sourceDatabase === receipt.sourceDatabase
    && Number.isSafeInteger(receipt.wallets) && receipt.wallets > 0 && receipt.wallets <= 10000
    && Number.isSafeInteger(receipt.entities) && receipt.entities > 0 && receipt.entities <= 10000
    && seed.tables?.wallet_identities?.length === receipt.wallets
    && seed.tables?.trader_entities?.length === receipt.entities, 'capture_counts_mismatch');
  const review = job.review;
  demand(exact(review, ['importId', 'approvalRef', 'actorId', 'actorAuthorizationRef', 'generationId', 'importedAt', 'seedSha256'])
    && ['importId', 'approvalRef', 'actorId', 'actorAuthorizationRef', 'generationId'].every(key =>
      typeof review[key] === 'string' && review[key].length > 0 && review[key].length <= 256)
    && review.seedSha256 === job.seed.sha256 && Number.isSafeInteger(review.importedAt)
    && review.importedAt >= Date.parse(seed.capturedAt), 'invalid_review');
  return seed;
}

export function createOperationDeadline(milliseconds = 30000, now = () => performance.now()) {
  const expires = now() + milliseconds;
  return () => demand(now() < expires, 'original_operation_deadline');
}
export function validateOutputDirectoryChain(infos) {
  demand(infos.length > 0, 'unprotected_output_chain');
  for (const info of infos) demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0
    && !(info.mode & 0o022), 'unprotected_output_chain');
  demand((infos[0].mode & 0o777) === 0o700, 'private_output_required');
}
async function privateOutputDirectory(path, check) {
  demand(safePath(path), 'invalid_output');
  const pins = [];
  for (let parent = path;; parent = dirname(parent)) {
    check(); const info = await lstat(parent); pins.push({ path: parent, info });
    if (parent === '/') break;
  }
  validateOutputDirectoryChain(pins.map(pin => pin.info));
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const verify = async () => {
    check();
    const held = await fd.stat();
    demand(held.dev === pins[0].info.dev && held.ino === pins[0].info.ino, 'output_directory_changed');
    for (const pin of pins) {
      check(); const live = await lstat(pin.path);
      demand(live.isDirectory() && !live.isSymbolicLink() && live.uid === 0 && !(live.mode & 0o022)
        && live.dev === pin.info.dev && live.ino === pin.info.ino
        && (pin.path !== path || (live.mode & 0o777) === 0o700), 'output_ancestor_changed');
    }
  };
  try { await verify(); return { fd, verify }; } catch (error) { await fd.close(); throw error; }
}
async function protectedRead(path, maximum, expected, check) {
  check();
  demand(safePath(path), 'protected_path_required');
  const parents = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    check(); const info = await lstat(parent);
    demand(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022), 'unprotected_parent');
    parents.push([parent, info.dev, info.ino]);
    if (parent === '/') break;
  }
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stamp = info => [info.dev, info.ino, info.mode, info.uid, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(':');
  try {
    const before = await fd.stat();
    demand(before.isFile() && before.uid === 0 && before.nlink === 1 && !(before.mode & 0o077)
      && before.size > 0 && before.size <= maximum, 'unprotected_input');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      check();
      const result = await fd.read(bytes, count, bytes.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    demand(count === before.size && stamp(before) === stamp(await fd.stat())
      && stamp(before) === stamp(await lstat(path)), 'input_changed');
    for (const [parent, dev, ino] of parents) {
      check(); const live = await lstat(parent);
      demand(live.isDirectory() && !live.isSymbolicLink() && live.uid === 0 && !(live.mode & 0o022)
        && live.dev === dev && live.ino === ino, 'parent_changed');
    }
    const body = bytes.subarray(0, count);
    demand(hex(expected) && digest(body) === expected, 'digest_mismatch');
    return body;
  } finally { await fd.close(); }
}
async function writeExclusive(directory, name, value, check) {
  demand(/^[a-z-]+\.json$/.test(name), 'invalid_output_name');
  await directory.verify();
  // Linux procfs resolves this held descriptor, never a newly resolved output ancestor.
  const fd = await open('/proc/self/fd/' + directory.fd.fd + '/' + name,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    check(); const bytes = Buffer.from(JSON.stringify(value) + '\n');
    demand(bytes.length <= 16 * 1024 * 1024, 'output_byte_budget');
    let offset = 0;
    while (offset < bytes.length) {
      check(); const result = await fd.write(bytes, offset, Math.min(65536, bytes.length - offset), null);
      demand(result.bytesWritten > 0, 'output_write_failed'); offset += result.bytesWritten;
    }
    await fd.sync(); check(); await directory.verify();
  } finally { await fd.close(); }
}
export async function main(args = process.argv.slice(2)) {
  const check = createOperationDeadline();
  demand(process.platform === 'linux' && process.geteuid?.() === 0, 'native_root_required');
  demand(args.length === 4 && args[0] === '--job' && args[2] === '--job-sha256', 'invalid_arguments');
  const job = JSON.parse((await protectedRead(args[1], 65536, args[3], check)).toString('utf8'));
  demand(exact(job, ['version', 'seed', 'receipt', 'cohort', 'outputDirectory', 'review']), 'invalid_job');
  const seed = await protectedRead(job.seed.path, 4194304, job.seed.sha256, check);
  const receipt = JSON.parse((await protectedRead(job.receipt.path, 65536, job.receipt.sha256, check)).toString('utf8'));
  validateFinalCapture(job, seed, receipt);
  const code = await protectedRead(job.cohort.path, 1048576, job.cohort.sha256, check);
  const directory = await privateOutputDirectory(job.outputDirectory, check);
  try {
  check();
  // Only a protected, digest-pinned code module is loaded; the seed is not executable input.
  const cohort = await import(pathToFileURL(job.cohort.path).href);
  check();
  const plan = cohort.createReviewedPostgresAddressOnlyImportPlan({ rawSeed: seed.toString('utf8'),
    review: job.review, trustedReviewSha256: cohort.postgresCohortImportFingerprint(job.review) });
  check();
  demand(plan.profiles.length === receipt.wallets
    && new Set(plan.profiles.map(profile => profile.entityId)).size === receipt.entities
    && plan.quarantine.length === 0, 'plan_coverage_mismatch');
  const result = { status: 'final-address-only-plan-prepared-not-imported', sourceSha256: digest(seed),
    captureReceiptSha256: job.receipt.sha256, codeSha256: digest(code), planSha256: plan.planSha256,
    wallets: receipt.wallets, entities: receipt.entities, generationId: job.review.generationId,
    databaseConnected: false, productionImportAdmitted: false, backendChanged: false, gatewayDeliveryEnabled: false };
  await writeExclusive(directory, 'review.json', job.review, check);
  await writeExclusive(directory, 'prepared-plan.json', plan, check);
  await writeExclusive(directory, 'preparation-receipt.json', result, check);
  await directory.fd.sync(); await directory.verify();
  return result;
  } finally { await directory.fd.close(); }
}
export function runBoundedChild(args, milliseconds = 30000) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, timedOut = false, outputExceeded = false, stdout = '', settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, milliseconds);
    const collect = (chunk, output) => {
      bytes += chunk.length;
      if (bytes > 65536) { outputExceeded = true; stdout = ''; child.kill('SIGKILL'); }
      else if (output && !outputExceeded) stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    const finish = code => {
      if (settled) return; settled = true; clearTimeout(timer);
      const passed = code === 0 && !timedOut && !outputExceeded;
      resolveResult({ status: passed ? 'completed' : 'refused', timedOut, outputExceeded,
        stdout: passed ? stdout : '' });
    };
    child.on('error', () => finish(null)); child.on('close', finish);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refused = () => {
    console.log('{"status":"refused","databaseConnected":false,"backendChanged":false}'); process.exitCode = 1;
  };
  if (process.argv[2] === '--bounded-child') {
    main(process.argv.slice(3)).then(result => console.log(JSON.stringify(result)), refused);
  } else if (process.platform !== 'linux' || process.geteuid?.() !== 0) {
    refused();
  } else {
    runBoundedChild(['--max-old-space-size=128', fileURLToPath(import.meta.url), '--bounded-child', ...process.argv.slice(2)])
      .then(result => { if (result.status === 'completed') process.stdout.write(result.stdout); else refused(); }, refused);
  }
}
