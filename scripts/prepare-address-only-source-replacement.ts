import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { parseServerRpcEnvironment } from './create-address-only-server-material.js';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import { createReviewedPostgresProviderBudgetSeedPlan, applyReviewedPostgresProviderBudgetSeedPlanInTransaction,
  type PostgresProviderBudgetReview } from '../apps/automation/src/postgres-cohort-import.js';
import { createPostgresMigrationRuntime, type PostgresMigrationRuntimeOptions } from '../packages/database/src/postgres-migration-runtime.js';
import { migrationCutoverCanonicalJson } from '../packages/database/src/migration-cutover-coordinator.js';
import type { PostgresTransaction } from '../packages/database/src/postgres-unit-of-work.js';

interface Pin { readonly path: string; readonly sha256: string }
interface Binding { chain: string; sourceProviderId: string; sourceEndpoint: string; replayProviderId: string; replayEndpoint: string; [key: string]: unknown }
export interface SourceReplacementMaterial {
  authority: { generationId: string; credential: unknown; privateKey: unknown; validator: { reviewedProviderBindings: Binding[]; [key: string]: unknown }; [key: string]: unknown };
  deployment: { generationId: string; gatewayDeliveryEnabled: boolean; fomoEnabled: boolean; fullHistoricalMiningEnabled: boolean;
    walletExecution: { solana: { providerId: string; endpoint: string; [key: string]: unknown }; [key: string]: unknown }; [key: string]: unknown };
  settings: { providerContracts: { providerId: string; origin: string; importId: string; sourceFingerprint: string; windowMs: number; maximumRequests: number; maximumConcurrency: number }[]; [key: string]: unknown };
  environment: Record<string, string>;
}
export interface SourceReplacementInput {
  readonly oldProviderId: string; readonly oldOrigin: string; readonly oldOperator: string; readonly newOperator: string;
  readonly review: PostgresProviderBudgetReview; readonly trustedReviewSha256: string; readonly material: SourceReplacementMaterial;
}
const demand: (v: unknown, code: string) => asserts v = (v, code) => { if (!v) throw new Error('SOURCE_REPLACEMENT_' + code); };
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const encode = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
const plans = new WeakSet<object>();
const nativeObservers = new WeakSet<object>();
function freeze<T>(v: T): T { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
/** Technical source approval only. This never mints an execution/price attestation or independent approval. */
export function createSourceReplacementPlan(input: SourceReplacementInput) {
  const seed = createReviewedPostgresProviderBudgetSeedPlan({ review: input.review, trustedReviewSha256: input.trustedReviewSha256 });
  demand(seed.budgets.length === 1, 'ONE_NEW_PROVIDER_REQUIRED');
  const next = seed.budgets[0]!;
  demand(input.oldProviderId !== next.providerId && input.oldOrigin !== next.origin && input.oldOperator === 'Helius'
    && input.newOperator === 'Allnodes/PublicNode' && next.origin === 'https://solana-rpc.publicnode.com', 'DISTINCT_OPERATOR_IDENTITY');
  demand(next.windowMs === 60000 && next.maximumRequests === 60 && next.maximumConcurrency === 1
    && next.requestsUsed === 0 && next.cooldownUntil === '0', 'FIXED_BUDGET');
  const material = structuredClone(input.material), bindings = material.authority.validator.reviewedProviderBindings;
  demand(material.authority.generationId === seed.generationId && material.deployment.generationId === seed.generationId, 'GENERATION');
  demand(material.deployment.gatewayDeliveryEnabled === false && material.deployment.fomoEnabled === false
    && material.deployment.fullHistoricalMiningEnabled === false && !('priceAcquisition' in material.deployment), 'SAFETY');
  const selected = bindings.filter(b => b.chain === 'solana');
  demand(selected.length === 1 && selected[0]!.sourceProviderId === input.oldProviderId
    && new URL(selected[0]!.sourceEndpoint).origin === input.oldOrigin, 'OLD_BINDING');
  const pair = selected[0]!;
  // Explicit reviewed operator pairing, not hostname-based independence inference.
  demand(pair.replayProviderId !== next.providerId && new URL(pair.replayEndpoint).origin === 'https://api.mainnet-beta.solana.com', 'OFFICIAL_REPLAY_REQUIRED');
  demand(material.deployment.walletExecution.solana.providerId === input.oldProviderId
    && material.deployment.walletExecution.solana.endpoint === pair.sourceEndpoint
    && material.environment.RADAR_RPC_SOLANA_HTTP_URL === pair.sourceEndpoint, 'SOURCE_ENDPOINT_BINDING');
  const oldContracts = material.settings.providerContracts.filter(p => p.providerId === input.oldProviderId);
  demand(oldContracts.length === 1 && oldContracts[0]!.origin === input.oldOrigin
    && oldContracts[0]!.windowMs === 60000 && oldContracts[0]!.maximumRequests === 60 && oldContracts[0]!.maximumConcurrency === 1, 'OLD_CONTRACT');
  demand(!material.settings.providerContracts.some(p => p.providerId === next.providerId || p.origin === next.origin), 'NEW_CONTRACT_COLLISION');
  pair.sourceProviderId = next.providerId; pair.sourceEndpoint = next.origin;
  material.deployment.walletExecution.solana.providerId = next.providerId; material.deployment.walletExecution.solana.endpoint = next.origin;
  material.environment.RADAR_RPC_SOLANA_HTTP_URL = next.origin;
  material.settings.providerContracts = material.settings.providerContracts.map(p => p.providerId !== input.oldProviderId ? p : {
    providerId: next.providerId, origin: next.origin, importId: seed.importId, sourceFingerprint: seed.planSha256,
    windowMs: 60000, maximumRequests: 60, maximumConcurrency: 1 });
  const serialized = JSON.stringify(material);
  demand(!serialized.includes(input.oldProviderId) && !serialized.includes(new URL(input.oldOrigin).hostname), 'OLD_SOURCE_STILL_REFERENCED');
  // Reuse the server-material strict parser, never shell-evaluate an environment value.
  demand(parseServerRpcEnvironment(Buffer.from('RADAR_RPC_SOLANA_HTTP_URL=' + JSON.stringify(next.origin)))
    .RADAR_RPC_SOLANA_HTTP_URL === next.origin, 'ENVIRONMENT');
  const replacementSha256 = hash(Buffer.from(migrationCutoverCanonicalJson({ seedSha256: seed.planSha256,
    oldProviderId: input.oldProviderId, oldOrigin: input.oldOrigin, oldOperator: input.oldOperator,
    newOperator: input.newOperator, materialSha256: hash(Buffer.from(migrationCutoverCanonicalJson(material))), stoppedWindowMs: 60000 })));
  const plan = freeze({ protocol: 'address-only-source-replacement-v1' as const, seed, material, replacementSha256,
    oldProviderId: input.oldProviderId, oldOrigin: input.oldOrigin, oldOperator: input.oldOperator, newOperator: input.newOperator,
    stoppedWindowMs: 60000, grantsBusinessEligibility: false as const, monitoringCompleted: false as const });
  plans.add(plan); return plan;
}
export type SourceReplacementPlan = ReturnType<typeof createSourceReplacementPlan>;
export interface SourceReplacementFence {
  readonly protocol: 'address-only-pg-source-fence-proof-v1';
  readonly replacementSha256: string; readonly journalSha256: string; readonly bootId: string;
  readonly measuredAtMs: number; readonly stoppedAtMs: number;
  readonly controllerLockHeld: true; readonly acquisitionsBlocked: true;
  readonly processesExited: true; readonly cgroupsEmpty: true;
  readonly pendingRequestCount: 0; readonly servicesActivated: false;
}
/** Native observer: its parent must retain the real configured controller lock.
 * All three pins come from the reviewed maintenance launcher, never source candidates.
 */
export function createNativePgSourceFenceObserver(input: { readonly python: Pin; readonly tool: Pin; readonly request: Pin }) {
  const pins = structuredClone(input);
  const observe = async (replacementSha256: string): Promise<SourceReplacementFence> => {
    const input = pins;
    demand(process.platform === 'linux' && process.geteuid?.() === 0, 'NATIVE_ROOT_REQUIRED');
    demand(isAbsolute(input.python.path) && resolve(input.python.path) === input.python.path, 'PYTHON_PIN');
    for (let path = input.python.path;; path = dirname(path)) {
      const info = await lstat(path);
      demand(info.uid === 0 && !(info.mode & 0o022) && !info.isSymbolicLink()
        && (path === input.python.path ? info.isFile() : info.isDirectory()), 'PYTHON_PIN');
      if (dirname(path) === path) break;
    }
    demand(hash(await readFile(input.python.path)) === input.python.sha256, 'PYTHON_PIN');
    await readPrivateAuthorityPin(input.tool); await readPrivateAuthorityPin(input.request);
    const request = JSON.parse((await readPrivateAuthorityPin(input.request)).toString('utf8')) as { replacementSha256?: unknown };
    demand(request.replacementSha256 === replacementSha256, 'NATIVE_FENCE_BINDING');
    const { stdout } = await promisify(execFile)(input.python.path,
      ['-I', '-B', input.tool.path, '--request', input.request.path, '--request-sha256', input.request.sha256, '--mode', 'observe'],
      { timeout: 1000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    await readPrivateAuthorityPin(input.tool); await readPrivateAuthorityPin(input.request);
    return JSON.parse(stdout) as SourceReplacementFence;
  };
  nativeObservers.add(observe);
  return observe;
}
/** Fence measurements must come from an authenticated maintenance port, never from the job JSON. */
export async function verifySourceReplacementDrain(tx: PostgresTransaction, plan: SourceReplacementPlan, fence: SourceReplacementFence, at: number) {
  demand(plans.has(plan), 'UNTRUSTED_PLAN');
  demand(fence.protocol === 'address-only-pg-source-fence-proof-v1' && fence.replacementSha256 === plan.replacementSha256
    && /^[a-f0-9]{64}$/.test(fence.journalSha256) && typeof fence.bootId === 'string' && fence.bootId.length > 0
    && fence.controllerLockHeld === true && fence.acquisitionsBlocked === true && fence.processesExited === true
    && fence.cgroupsEmpty === true && fence.pendingRequestCount === 0 && fence.servicesActivated === false
    && Number.isSafeInteger(fence.measuredAtMs) && at >= fence.measuredAtMs && at - fence.measuredAtMs <= 1000,
  'PHYSICAL_FENCE_REQUIRED');
  demand(Number.isSafeInteger(at) && Number.isSafeInteger(fence.stoppedAtMs) && fence.stoppedAtMs >= 0
    && at >= fence.stoppedAtMs + plan.stoppedWindowMs, 'FULL_WINDOW_REQUIRED');
  const rows = (await tx.query(`/* replacement-old-budget */ SELECT * FROM wallet_service_provider_budgets
    WHERE generation_id=$1 AND provider_id=$2 FOR UPDATE`, [plan.seed.generationId, plan.oldProviderId])).rows;
  const row = rows[0];
  demand(rows.length === 1 && row && row.origin === plan.oldOrigin && Number(row.window_ms) === 60000
    && Number(row.maximum_requests) === 60 && Number(row.maximum_concurrency) === 1, 'OLD_BUDGET');
  demand(/^(0|[1-9][0-9]*)$/.test(String(row.window_started_at)) && BigInt(String(row.window_started_at)) + 60000n <= BigInt(at), 'OLD_WINDOW_ACTIVE');
  const leases = (await tx.query(`/* replacement-active-leases */ SELECT count(*)::text active FROM wallet_service_provider_leases
    WHERE generation_id=$1 AND provider_id=$2 AND released_at IS NULL AND expires_at>$3`, [plan.seed.generationId, plan.oldProviderId, at])).rows;
  demand(leases.length === 1 && leases[0]!.active === '0', 'LEASES_NOT_DRAINED');
  return structuredClone(row);
}
/** A real dedicated migrator LOGIN is mandatory. Runtime checks current_user=session_user,
 * cluster identity, role restrictions and schema ledger. Peer SET ROLE cannot satisfy this API.
 * The caller supplies the existing externally authenticated authority gate; no issuer is fabricated.
 */
export async function importSourceReplacementContract(plan: SourceReplacementPlan, input: {
  readonly migration: PostgresMigrationRuntimeOptions;
  readonly measureExclusiveFence: (planSha256: string) => Promise<SourceReplacementFence>;
}) {
  demand(plans.has(plan), 'UNTRUSTED_PLAN');
  const m = input.migration;
  demand(m.capability.mode === 'isolated' || nativeObservers.has(input.measureExclusiveFence), 'NATIVE_OBSERVER_REQUIRED');
  demand(m.capability.purpose === 'business_import' && m.capability.planSha256 === plan.replacementSha256
    && m.capability.approvalRef === plan.seed.approvalRef && m.target.generation === plan.seed.generationId
    && m.limits.statementTimeoutMs <= 1000 && m.limits.lockTimeoutMs <= 1000 && m.limits.operationTimeoutMs <= 3000
    && m.limits.maximumSqlStatements <= 128, 'MIGRATION_BINDING_OR_LIMITS');
  const runtime = createPostgresMigrationRuntime(m);
  try {
    const result = await runtime.run(async tx => {
      const at = m.clock();
      const fence = await input.measureExclusiveFence(plan.replacementSha256);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(['source-replacement', m.target.schema, plan.seed.generationId])]);
      const before = await verifySourceReplacementDrain(tx, plan, fence, m.clock());
      const imported = await applyReviewedPostgresProviderBudgetSeedPlanInTransaction(plan.seed, {
        transaction: tx,
        capability: { kind: m.capability.mode, purpose: 'provider_budget_seed', authorizationRef: plan.seed.approvalRef,
          target: m.target, planSha256: plan.seed.planSha256, expiresAtMs: m.capability.expiresAtMs },
        budget: { deadlineAtMs: Math.min(at + 1000, m.capability.expiresAtMs), maximumTransactionMs: 1000,
          maximumQueriesPerTransaction: 64, maximumTotalQueries: 64, maximumTransactions: 1, recordsPerTransaction: 1, maximumImportLagMs: 86400000 },
        assertAuthorized: async () => { await m.assertAuthorized({ target: m.target, capability: m.capability }); },
      });
      const afterFence = await input.measureExclusiveFence(plan.replacementSha256);
      demand(afterFence.stoppedAtMs === fence.stoppedAtMs && afterFence.journalSha256 === fence.journalSha256
        && afterFence.bootId === fence.bootId, 'FENCE_CHANGED');
      const after = await verifySourceReplacementDrain(tx, plan, afterFence, m.clock());
      demand(isDeepStrictEqual(before, after), 'OLD_BUDGET_CHANGED');
      return { imported, oldBudgetSha256: hash(encode(before)), oldCooldownUntil: String(before.cooldown_until) };
    });
    return { protocol: 'address-only-source-replacement-import-v1' as const, planSha256: plan.seed.planSha256, replacementSha256: plan.replacementSha256,
      committed: true, stagedBudgets: result.imported.stagedBudgets, checkedExistingBudgets: result.imported.checkedExistingBudgets,
      oldBudgetSha256: result.oldBudgetSha256, oldCooldownUntil: result.oldCooldownUntil,
      fenceProofScope: nativeObservers.has(input.measureExclusiveFence) ? 'native-controller-physical-drain' : 'isolated-test-port',
      servicesActivated: false, probeExecuted: false, grantsBusinessEligibility: false };
  } finally { await runtime.close(); }
}

/** Root-private, exclusive staging only. No DB, RPC, service stop or activation. Reuse existing
 * publisher credentials/validator keys: calling the original material generator would rotate them.
 */
export async function prepareAddressOnlySourceReplacement(input: Omit<SourceReplacementInput, 'material'> & {
  readonly outputDirectory: string;
  readonly pins: Readonly<Record<keyof SourceReplacementMaterial, Pin>>;
}) {
  demand(process.platform === 'linux' && process.geteuid?.() === 0, 'NATIVE_ROOT_REQUIRED');
  const root = input.outputDirectory;
  demand(isAbsolute(root) && resolve(root) === root && root.startsWith('/var/lib/address-radar-maintenance-tools/'), 'OUTPUT_PATH');
  const material = {} as SourceReplacementMaterial;
  for (const name of ['authority', 'deployment', 'settings', 'environment'] as const) {
    Object.assign(material, { [name]: JSON.parse((await readPrivateAuthorityPin(input.pins[name])).toString('utf8')) });
  }
  const plan = createSourceReplacementPlan({ ...input, material });
  for (let p = dirname(root);;) {
    const s = await lstat(p); demand(s.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'PARENT_UNSAFE');
    const next = dirname(p); if (next === p) break; p = next;
  }
  await mkdir(root, { mode: 0o700 });
  async function sync(path: string) { const f = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await f.sync(); } finally { await f.close(); } }
  async function publish(name: string, value: unknown) {
    const bytes = encode(value); demand(bytes.length <= 1048576, 'MATERIAL_BYTES');
    const path = join(root, name), f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    await sync(root); return { path, sha256: hash(bytes) };
  }
  await sync(dirname(root));
  try {
    await publish('preparation-started.json', { protocol: plan.protocol, sourcePins: input.pins, planSha256: plan.seed.planSha256, replacementSha256: plan.replacementSha256 });
    const files: Record<string, Pin> = {};
    files.authority = await publish('authority.json', plan.material.authority);
    files.deployment = await publish('deployment.json', plan.material.deployment);
    files.settings = await publish('preflight-settings.json', plan.material.settings);
    const env = { ...plan.material.environment, ADDRESS_RADAR_POSTGRES_AUTHORITY_FILE: files.authority.path,
      ADDRESS_RADAR_POSTGRES_AUTHORITY_SHA256: files.authority.sha256, ADDRESS_RADAR_POSTGRES_DEPLOYMENT_FILE: files.deployment.path,
      ADDRESS_RADAR_POSTGRES_DEPLOYMENT_SHA256: files.deployment.sha256,
      ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_FILE: files.settings.path, ADDRESS_RADAR_POSTGRES_CONFIGURED_PREFLIGHT_SHA256: files.settings.sha256 };
    files.environment = await publish('environment.json', env);
    files.review = await publish('provider-review.json', input.review);
    files.plan = await publish('provider-plan.json', plan.seed);
    // Recheck every input pin before publishing completion, retaining incomplete artifacts on drift.
    for (const pin of Object.values(input.pins)) await readPrivateAuthorityPin(pin);
    const receipt = { protocol: plan.protocol, status: 'PREPARED_NOT_IMPORTED_NOT_ACTIVATED', files,
      planSha256: plan.seed.planSha256, replacementSha256: plan.replacementSha256, sourcePins: input.pins, oldProviderId: input.oldProviderId,
      newProviderId: plan.seed.budgets[0]!.providerId, oldOperator: input.oldOperator, newOperator: input.newOperator,
      businessBudgetsTtlKeysCredentialsUnchanged: true, oldCooldownUntouched: true, requiredStoppedWindowMs: 60000,
      requiresAuthenticatedExclusiveFence: true, requiresNativePgSourceFence: true, physicalDrainRequired: true,
      requiredFenceProofProtocol: 'address-only-pg-source-fence-proof-v1',
      databaseWritten: false, servicesActivated: false, factsApproved: false };
    const audit = await publish('preparation-complete.json', receipt); return { ...receipt, audit };
  } catch (error) { await publish('preparation-failed.json', { status: 'FAILED_NOT_ACTIVATED' }); throw error; }
}
