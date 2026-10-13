/** Native maintenance CLI: execution-purpose probe only, never a publisher.
 * Production uses the formally bundled, root-private maintenance module.
 * Release verification runs in a separate unprivileged process group.
 */
import { createHash, createPrivateKey, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { lstat, mkdir, open, realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresBusinessRuntime } from '../packages/database/src/postgres-business-driver.js';
import { verifyPostgresServiceRelease } from '../packages/database/src/postgres-service-dispatch.js';
import { validatePostgresServiceDeployment } from './postgres-service-entry.js';
import { readPrivateAuthorityPin, type PostgresCliExecutionAuthorityConfiguration } from './postgres-service-cli-authority.js';
import { createPostgresServiceFactAdapters } from '../apps/automation/src/postgres-service-fact-adapters.js';
import { createConfiguredSourceProbe, type ConfiguredSourceProbeOptions } from './probe-address-only-configured-source.js';
import { runtimeAuthorityFingerprint, type RuntimeAuthorityJob } from './provision-address-only-runtime-authority.js';
import type { CapturedPostgresWalletEvent } from '../apps/wallet-monitor/src/postgres-wallet-channel.js';
import type { FetchLike } from '../packages/collectors/src/types.js';

interface Pin { readonly path: string; readonly sha256: string }
interface Job {
  readonly protocol: 'address-only-configured-source-probe-job-v1';
  readonly deadlineAtMs: number;
  readonly deployment: Pin; readonly environment: Pin; readonly authority: Pin;
  readonly settings: Pin; readonly runtimeAuthority: Pin; readonly credential: Pin; readonly payload: Pin;
  readonly maximumRunMs: number; readonly maximumBodyBytes: number;
}
/** Test seams are native IO boundaries only; CLI never loads implementations from JSON. */
export interface ConfiguredSourceProbeCliPorts {
  readonly readPin?: typeof readPrivateAuthorityPin;
  readonly createRuntime?: typeof createPostgresBusinessRuntime;
  readonly verifyRelease?: typeof verifyPostgresServiceRelease;
  readonly verifierAudit?: (audit: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => number;
  readonly transport?: FetchLike;
}
function demand(value: unknown): asserts value {
  if (!value) throw new Error('configured_source_probe_cli_refused');
}
const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
function same(pin: Pin, path: unknown, sha256: unknown) { demand(pin.path === path && pin.sha256 === sha256); }


/** Only public inventory expectations cross the privilege boundary. */
export function configuredSourceVerifierSummary(config: Parameters<typeof verifyPostgresServiceRelease>[0] & {
  lifecycle?: { startupMs: number; pollMs: number; shutdownMs: number; killMs: number };
}, env: Parameters<typeof verifyPostgresServiceRelease>[1]) {
  const publicEnv: Record<string, string> = {
    ADDRESS_RADAR_POSTGRES_URL: 'verification-only',
  };
  for (const key of ['ADDRESS_RADAR_DATABASE_BACKEND', 'ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED',
    'ADDRESS_RADAR_FOMO_BROWSER_ENABLED', 'ADDRESS_RADAR_FOMO_CAPTURE_ENABLED', 'ADDRESS_RADAR_FULL_HISTORICAL_MINING_ENABLED']) {
    if (env[key] !== undefined) publicEnv[key] = env[key];
  }
  for (const name of ['DEPLOYMENT_SHA256', 'ENTRY_SHA256', 'RELEASE_SHA256', 'EXECUTION_FORMAT']) {
    const key = 'ADDRESS_RADAR_POSTGRES_' + name;
    if (env[key] !== undefined) publicEnv[key] = env[key];
  }
  for (const [name, key] of [['STARTUP', 'startupMs'], ['POLL', 'pollMs'], ['SHUTDOWN', 'shutdownMs'], ['KILL', 'killMs']] as const) {
    publicEnv['ADDRESS_RADAR_POSTGRES_' + name + '_MS'] = String(config.lifecycle?.[key]);
  }
  return { deployment: { releaseRoot: config.releaseRoot,
    execution: { maximumEntries: config.execution.maximumEntries, maximumBytes: config.execution.maximumBytes },
    ...(config.executionFormat === undefined ? {} : { executionFormat: config.executionFormat }),
    cutover: { addressOnly: { protocol: 'address-only-v1' } } }, env: publicEnv };
}

let verifierStage = 'verifier_start';
async function verifierChild() {
  demand(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0);
  let raw = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    raw = Buffer.concat([raw, Buffer.from(chunk)]); demand(raw.length <= 8192);
  }
  verifierStage = 'verifier_input';
  const summary = JSON.parse(raw.toString('utf8')) as ReturnType<typeof configuredSourceVerifierSummary>;
  // Resolve a fixed OS identity, never an identity supplied by private JSON.
  const fields = execFileSync('/usr/bin/getent', ['passwd', 'nobody'], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  }).trim().split(':');
  const uid = Number(fields[2]), gid = Number(fields[3]);
  demand(fields[0] === 'nobody' && Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
  let rootRejected = false;
  try { await verifyPostgresServiceRelease(summary.deployment, summary.env); } catch { rootRejected = true; }
  demand(rootRejected);
  verifierStage = 'verifier_identity';
  process.setgroups!([]); process.setgid!(gid); process.setuid!(uid);
  demand(process.getuid!() === uid && process.geteuid!() === uid && process.getgid!() === gid
    && process.getegid!() === gid && process.getgroups!().every(group => group === gid));
  const stat = await readFile('/proc/self/stat', 'utf8');
  const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  demand(pgid === process.pid);
  verifierStage = 'verifier_release';
  const sealed = await verifyPostgresServiceRelease(summary.deployment, summary.env);
  process.stdout.write(JSON.stringify({ sealed, identity: { uid, gid, groups: process.getgroups!(),
    pid: process.pid, pgid, rootRejected } }) + '\n');
}

/** Root loads its private standalone tool; only the child drops privileges. */
export async function verifyConfiguredSourceRelease(config: Parameters<typeof configuredSourceVerifierSummary>[0],
  env: Parameters<typeof verifyPostgresServiceRelease>[1], signal: AbortSignal,
  audit: (value: Readonly<Record<string, unknown>>) => void = () => {}) {
  signal.throwIfAborted();
  demand(process.platform === 'linux' && process.geteuid?.() === 0);
  const tool = process.argv[1];
  demand(tool && tool.endsWith('.mjs') && resolve(tool) === tool && await realpath(tool) === tool);
  for (let path = tool;; path = dirname(path)) {
    const st = await lstat(path);
    demand(st.uid === 0 && !(st.mode & 0o022) && !st.isSymbolicLink()
      && (path === tool ? st.isFile() && st.nlink === 1 && !(st.mode & 0o077) : st.isDirectory()));
    if (dirname(path) === path) break;
  }
  const fd = await open(tool, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true }); demand(before.size > 0n && before.size <= 128n * 1024n * 1024n);
    const toolSha256 = digest(await fd.readFile());
    const summary = Buffer.from(JSON.stringify(configuredSourceVerifierSummary(config, env)));
    demand(summary.length <= 8192); signal.throwIfAborted();
    const started = performance.now();
    const result = await new Promise<{ sealed: { root: string; releaseSha256: string }; identity: Record<string, unknown> }>((resolve_, reject) => {
      const child = spawn(process.execPath, ['--no-global-search-paths', tool, '--verify-release-summary'], {
        detached: true, cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', NODE_DISABLE_COMPILE_CACHE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      });
      let output = '', errors = '', failed = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        failed = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Exit is still required. */ } }
        drainTimer ??= setTimeout(() => {
          audit({ status: 'exit_uncertain', pid: child.pid ?? null, pgid: child.pid ?? null, toolSha256 });
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          clearTimeout(timer); signal.removeEventListener('abort', stop);
          reject(Error('configured_source_probe_verifier_exit_uncertain'));
        }, 1000);
      };
      const timer = setTimeout(stop, 10_000);
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', chunk => { output += chunk.toString(); if (Buffer.byteLength(output) > 8192) stop(); });
      child.stderr.on('data', chunk => { errors += chunk.toString(); if (Buffer.byteLength(errors) > 8192) stop(); });
      child.stdin.on('error', stop);
      child.on('error', stop);
      child.once('close', (code, termination) => {
        clearTimeout(timer); clearTimeout(drainTimer); signal.removeEventListener('abort', stop);
        audit({ status: failed || code !== 0 || errors ? 'refused_or_uncertain' : 'exited',
          pid: child.pid ?? null, pgid: child.pid ?? null, exitCode: code, signal: termination,
          reasonCode: code === 0 ? null : (() => { try { const value = JSON.parse(output); return ['verifier_start', 'verifier_input', 'verifier_identity', 'verifier_release'].includes(value.reasonCode) ? value.reasonCode : 'verifier_child_failed'; } catch { return 'verifier_child_failed'; } })(),
          toolSha256, elapsedMs: Math.ceil(performance.now() - started), aborted: signal.aborted });
        try {
          demand(!failed && !signal.aborted && performance.now() - started < 10_000 && code === 0 && termination === null && errors === '');
          const value = JSON.parse(output);
          demand(value.identity.uid > 0 && value.identity.gid > 0 && value.identity.pid === child.pid
            && value.identity.pgid === child.pid && value.identity.groups.every((group: unknown) => group === value.identity.gid)
            && value.sealed.root === config.releaseRoot && value.sealed.releaseSha256 === env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256);
          audit({ status: 'verified', toolSha256, ...value.identity }); resolve_(value);
        } catch { reject(Error('configured_source_probe_verifier_refused')); }
      });
      child.stdin.end(summary);
      if (signal.aborted) stop();
    });
    const after = await fd.stat({ bigint: true }), current = await lstat(tool, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'] as const) {
      demand(before[key] === after[key] && before[key] === current[key]);
    }
    signal.throwIfAborted(); return result.sealed;
  } finally { await fd.close(); }
}

export async function runConfiguredSourceProbeCli(jobPin: Pin, signal: AbortSignal,
  ports: ConfiguredSourceProbeCliPorts = {}) {
  const read = ports.readPin ?? readPrivateAuthorityPin, now = ports.now ?? Date.now;
  const pinned = async (pin: Pin) => {
    signal.throwIfAborted();
    const raw = await read(pin);
    demand(raw.length > 0 && raw.length <= 524288 && digest(raw) === pin.sha256);
    signal.throwIfAborted(); return raw;
  };
  const job = JSON.parse((await pinned(jobPin)).toString('utf8')) as Job;
  demand(job.protocol === 'address-only-configured-source-probe-job-v1'
    && Number.isSafeInteger(job.deadlineAtMs) && job.deadlineAtMs > now() && job.deadlineAtMs - now() <= 60_000
    && Number.isSafeInteger(job.maximumRunMs) && job.maximumRunMs > 0 && job.maximumRunMs <= 5000
    && Number.isSafeInteger(job.maximumBodyBytes) && job.maximumBodyBytes > 0 && job.maximumBodyBytes <= 2_097_152);
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, job.deadlineAtMs - now()));
  const check = () => { signal.throwIfAborted(); controller.signal.throwIfAborted(); demand(now() < job.deadlineAtMs); };
  let runtime: ReturnType<typeof createPostgresBusinessRuntime> | undefined;
  try {
    const env = JSON.parse((await pinned(job.environment)).toString('utf8')) as Record<string, string>;
    demand(Object.values(env).every(v => typeof v === 'string'));
    const credential = JSON.parse((await pinned(job.credential)).toString('utf8')) as { connectionString: string; username: string; gatewayDeliveryEnabled: boolean };
    same(job.deployment, env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE, env.ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256);
    same(job.authority, env.ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE, env.ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256);
    same(job.settings, env.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE, env.ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256);
    demand(credential.gatewayDeliveryEnabled === false && typeof credential.connectionString === 'string');
    env.ADDRESS_RADAR_POSTGRES_URL = credential.connectionString;
    const config = validatePostgresServiceDeployment(JSON.parse((await pinned(job.deployment)).toString('utf8')), env);
    demand(config.cutover.addressOnly && config.sources.mode !== 'waiting_configuration' && !('priceAcquisition' in config)
      && !('fetchImpl' in config.sources) && config.sources.evmProviderPacingEnabled !== true);
    demand(config.wallet);
    const settings = JSON.parse((await pinned(job.settings)).toString('utf8')) as {
      protocol: string; providerContracts: Array<Omit<ConfiguredSourceProbeOptions['source'], 'endpoint'> & { origin: string }>;
    };
    const authority = JSON.parse((await pinned(job.authority)).toString('utf8')) as PostgresCliExecutionAuthorityConfiguration;
    const approved = JSON.parse((await pinned(job.runtimeAuthority)).toString('utf8')) as RuntimeAuthorityJob;
    const payload = JSON.parse((await pinned(job.payload)).toString('utf8')) as CapturedPostgresWalletEvent;
    const selected = config.services['wallet-monitor'], source = config.walletExecution?.solana;
    demand(source && selected.maximumConnections === 1 && credential.username === selected.username
      && env.RADAR_RPC_SOLANA_HTTP_URL === source.endpoint
      && settings.protocol === 'address-only-configured-preflight-settings-v1'
      && authority.protocol === 'address-only-cli-execution-authority-v1'
      && authority.operationId === config.operationId && authority.generationId === config.generationId
      && authority.releaseSha256 === env.ADDRESS_RADAR_POSTGRES_RELEASE_SHA256);
    const pairs = authority.validator.reviewedProviderBindings.filter(v => v.chain === 'solana');
    demand(pairs.length === 1); const pair = pairs[0]!;
    demand(pair.sourceProviderId === source.providerId && pair.sourceEndpoint === source.endpoint
      && pair.expectedGenesisHash === source.expectedGenesisHash);
    const validators = approved.validators.filter(v => v.kind === 'execution' && v.validatorId === authority.validator.validatorId);
    const keys = authority.publisher.validators.filter(v => v.validatorId === authority.validator.validatorId && v.keyId === authority.validator.keyId);
    demand(validators.length === 1 && keys.length === 1 && typeof approved.approvalRef === 'string'
      && approved.target.database === config.database && approved.target.schema === config.schema
      && approved.target.generationId === config.generationId
      && approved.target.systemIdentifier === config.cutover.addressOnly.target.systemIdentifier);
    const validator = validators[0]!, key = keys[0]!;
    const contract = (providerId: string, endpoint: string): ConfiguredSourceProbeOptions['source'] => {
      const rows = settings.providerContracts.filter(c => c.providerId === providerId);
      demand(rows.length === 1 && rows[0]!.origin === new URL(endpoint).origin);
      return { ...rows[0]!, endpoint };
    };
    const sourceContract = contract(pair.sourceProviderId, pair.sourceEndpoint), replayContract = contract(pair.replayProviderId, pair.replayEndpoint);
    const privateKey = createPrivateKey(await pinned(authority.privateKey));
    // Construct before opening any runtime: core performs its fixed-contract checks here.
    const fingerprint = runtimeAuthorityFingerprint({ approvalRef: approved.approvalRef, proofScope: 'validator_authority', configuration: validator });
    const common = { schema: config.schema, generationId: config.generationId, activatedAt: config.activatedAt,
      source: sourceContract, replay: replayContract,
      authority: { pin: job.authority, operationId: config.operationId, releaseSha256: authority.releaseSha256,
        actorId: key.actorId, authorizationRef: key.authorizationRef },
      validatorImport: { importId: validator.importId, sourceFingerprint: fingerprint, approvalRef: approved.approvalRef, configuration: validator },
      maximumRunMs: job.maximumRunMs, maximumRequests: 8, maximumBodyBytes: job.maximumBodyBytes,
      validator: { ...authority.validator, generationId: config.generationId, activatedAt: config.activatedAt,
        signingKey: { loadPrivateKey: () => privateKey }, nonce: randomUUID }, now };
    // A deferred port is never used; it only permits preflight construction checks.
    createConfiguredSourceProbe({ ...common, ports: { fetch: async () => { throw Error('unbound'); },
      profiles: { load: async () => { throw Error('unbound'); } }, run: async () => { throw Error('unbound'); } } });
    check();
    const sealed = await (ports.verifyRelease ?? ((deployment, environment, abortSignal) => verifyConfiguredSourceRelease(deployment, environment, abortSignal!, ports.verifierAudit)))(config, env, controller.signal);
    demand(sealed.root === config.releaseRoot && sealed.releaseSha256 === authority.releaseSha256); check();
    const connection = new URL(credential.connectionString), target = config.cutover.addressOnly.target;
    demand(['postgresql:', 'postgres:'].includes(connection.protocol) && connection.hostname === target.serverAddress
      && connection.port === String(target.serverPort) && connection.pathname === '/' + config.database
      && decodeURIComponent(connection.username) === selected.username && connection.password && !connection.search && !connection.hash);
    runtime = (ports.createRuntime ?? createPostgresBusinessRuntime)({ ...config.driver, connectionString: credential.connectionString,
      target: { database: config.database, schema: config.schema, username: selected.username, generation: config.generationId, service: 'wallet-monitor' },
      maximumConnections: selected.maximumConnections, access: 'runtime' });
    const identity = await runtime.probe(); check();
    demand(identity.database === config.database && identity.schema === config.schema && identity.generation === config.generationId
      && identity.username === selected.username && identity.service === 'wallet-monitor'
      && identity.serverAddress === target.serverAddress && identity.serverPort === target.serverPort
      && identity.schemaVersion === config.driver.schemaVersion && identity.schemaFingerprint === config.driver.schemaFingerprint);
    const rows = (await runtime.run(tx => tx.query(`/* source-probe-cli-cluster: read only */ SELECT system_identifier::text AS system_identifier,
      current_user AS username,session_user AS session_username FROM pg_catalog.pg_control_system()`))).rows;
    demand(rows.length === 1 && rows[0]!.system_identifier === target.systemIdentifier
      && rows[0]!.username === selected.username && rows[0]!.session_username === selected.username); check();
    const facts = await createPostgresServiceFactAdapters({ runtime, generationId: config.generationId, maximumProfiles: config.wallet.maximumProfiles,
      now, sources: { ...config.sources, ...(ports.transport ? { fetchImpl: ports.transport } : {}) } });
    const probe = createConfiguredSourceProbe({ ...common, ports: { readPin: pinned, fetch: facts.fetch, profiles: facts.profiles, run: runtime.run } });
    const result = await probe.probe({ payload, signal: controller.signal }); check();
    // Successful output is withheld unless the runtime acknowledges shutdown/drain.
    await runtime.close(); runtime = undefined;
    return result;
  } finally {
    controller.abort(); clearTimeout(timer); signal.removeEventListener('abort', abort);
    if (runtime) await runtime.close();
  }
}

export function parseConfiguredSourceProbeCliArgs(args: readonly string[]) {
  demand(args.length === 6 && args[0] === '--job' && args[2] === '--job-sha256' && args[4] === '--output-directory');
  const path = args[1]!, sha256 = args[3]!, outputDirectory = args[5]!;
  demand(isAbsolute(path) && resolve(path) === path && /^[a-f0-9]{64}$/.test(sha256)
    && resolve(outputDirectory) === outputDirectory && outputDirectory.startsWith('/var/lib/address-radar-maintenance-tools/'));
  return { job: { path, sha256 }, outputDirectory };
}
export async function createConfiguredSourceProbeOutputDirectory(outputDirectory: string,
  io: Pick<typeof import('node:fs/promises'), 'mkdir' | 'open'> = { mkdir, open }) {
  await io.mkdir(outputDirectory, { mode: 0o700 }); // Exclusive; retain failed artifacts, never overwrite.
  // Persist the new directory entry before any budget-consuming work can begin.
  const parent = await io.open(dirname(outputDirectory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function nativeCli() {
  demand(process.platform === 'linux' && process.geteuid?.() === 0);
  const { job, outputDirectory } = parseConfiguredSourceProbeCliArgs(process.argv.slice(2));
  for (let p = dirname(outputDirectory);; p = dirname(p)) {
    const s = await lstat(p); demand(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022));
    if (dirname(p) === p) break;
  }
  await createConfiguredSourceProbeOutputDirectory(outputDirectory);
  const store = async (name: string, value: unknown) => {
    const fd = await open(outputDirectory + '/' + name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
    const dir = await open(outputDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  };
  await store('intent.json', { protocol: 'address-only-configured-source-probe-intent-v1', job, businessWritesAuthorized: false });
  const verifierAudits: Readonly<Record<string, unknown>>[] = [];
  try {
    const result = await runConfiguredSourceProbeCli(job, AbortSignal.timeout(60_000), {
      verifierAudit: value => verifierAudits.push(value),
    });
    await store('receipt.json', { protocol: 'address-only-configured-source-probe-receipt-v1', job, result, verifierAudits,
      factsPublished: false, servicesActivated: false, monitoringCompleted: false });
    process.stdout.write(JSON.stringify({ status: result.status, receipt: outputDirectory + '/receipt.json', monitoringCompleted: false }) + '\n');
    if (result.status !== 'verified') process.exitCode = 1;
  } catch {
    await store('refused.json', { status: 'refused_or_uncertain', retryAuthorized: false, factsPublished: false, verifierAudits });
    throw Error('configured_source_probe_cli_refused');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await (process.argv.length === 3 && process.argv[2] === '--verify-release-summary' ? verifierChild() : nativeCli()).catch(() => { process.stdout.write(JSON.stringify({ status: 'refused_or_uncertain', retryAuthorized: false, factsPublished: false,
    ...(process.argv[2] === '--verify-release-summary' ? { reasonCode: verifierStage } : {}) }) + '\n'); process.exitCode = 1; });
}
