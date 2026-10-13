import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import { createSourceReplacementPlan, createNativePgSourceFenceObserver, importSourceReplacementContract,
  type SourceReplacementInput, type SourceReplacementFence } from './prepare-address-only-source-replacement.js';
import type { PostgresMigrationRuntimeOptions, PostgresMigrationTarget } from '../packages/database/src/postgres-migration-runtime.js';

interface Pin { path: string; sha256: string }
interface Authorization { operationId: string; approvalRef: string; replacementSha256: string; expiresAtMs: number }
interface Credential { host: string; port: number; database: string; user: string; password: string; operationId: string; expiresAtMs: number }
interface RotationPlan extends Authorization { role: string }
interface RotationReceipt extends Authorization { status: string; system: string; oldRecordsPreserved: boolean; hbaChanged: boolean; schemaChanged: boolean; businessActivated: boolean }
export interface SourceContractImportJob extends Authorization {
  protocol: 'address-only-source-contract-import-job-v1';
  mode: 'approved_cutover' | 'isolated';
  input: Pin; target: PostgresMigrationTarget;
  rotation: { plan: Pin; intent: Pin; credential: Pin; receipt: Pin };
  fence: { python: Pin; tool: Pin; request: Pin } | { isolatedProof: Pin };
}
const hash = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
function demand(value: unknown, code: string): asserts value { if (!value) throw new Error('IMPORT_' + code); }
export function validateRotationBinding(job: Authorization, plan: RotationPlan, credential: Credential,
  receipt: RotationReceipt, target: Pick<PostgresMigrationTarget, 'username' | 'database' | 'systemIdentifier'>) {
  demand([plan, receipt].every(value => value.operationId === job.operationId && value.approvalRef === job.approvalRef
    && value.replacementSha256 === job.replacementSha256)
    && credential.operationId === job.operationId && plan.role === target.username && credential.user === target.username
    && credential.database === target.database && credential.host === '127.0.0.1' && credential.port === 5432
    && typeof credential.password === 'string' && credential.password.length > 0
    && Number.isSafeInteger(job.expiresAtMs) && job.expiresAtMs > Date.now()
    && Number.isSafeInteger(plan.expiresAtMs) && plan.expiresAtMs >= job.expiresAtMs
    && receipt.expiresAtMs === plan.expiresAtMs && credential.expiresAtMs === plan.expiresAtMs
    && receipt.status === 'rotated-authenticated' && receipt.system === target.systemIdentifier
    && receipt.oldRecordsPreserved === true && receipt.hbaChanged === false && receipt.schemaChanged === false
    && receipt.businessActivated === false, 'ROTATION_BINDING');
}
export function validateNativeFenceBinding(request: Record<string, unknown>,
  job: Pick<Authorization, 'operationId' | 'approvalRef' | 'replacementSha256'>,
  source: { generationId: string; oldProviderId: string; oldOrigin: string; newProviderId: string; newOrigin: string }) {
  const expected = { ...job, ...source };
  demand(request.protocol === 'address-only-pg-source-fence-v1'
    && Object.entries(expected).every(([key, value]) => request[key] === value), 'NATIVE_FENCE_BINDING');
}
async function publish(path: string, value: unknown) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
interface ImportIntent {
  operationId: string; replacementSha256: string; jobSha256: string;
  rotationReceiptSha256: string; mode: string; retryAuthorized: boolean;
}
/** Cover driver initialization as well as transaction and receipt publication. */
export async function withSourceImportAudit<T extends object>(audit: string, intent: ImportIntent, execute: () => Promise<T>): Promise<T> {
  await publish(audit + '-intent.json', intent);
  try {
    const result = await execute();
    await publish(audit + '-receipt.json', { ...result, ...intent });
    return result;
  } catch {
    await publish(audit + '-failed.json', { status: 'REFUSED_OR_UNCERTAIN', operationId: intent.operationId,
      replacementSha256: intent.replacementSha256, retryAuthorized: false, servicesActivated: false });
    throw new Error('IMPORT_REFUSED_OR_UNCERTAIN');
  }
}
/** Root-pinned maintenance job is the approval port. No caller-injected pool or authority callback. */
export async function runSourceContractImport(jobPin: Pin) {
  demand(process.platform === 'linux' && process.geteuid?.() === 0, 'NATIVE_ROOT_REQUIRED');
  const read = async <T>(pin: Pin): Promise<T> => JSON.parse((await readPrivateAuthorityPin(pin)).toString('utf8')) as T;
  const job = await read<SourceContractImportJob>(jobPin);
  demand(job.protocol === 'address-only-source-contract-import-job-v1'
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(job.operationId) && /^[a-f0-9]{64}$/.test(job.replacementSha256)
    && typeof job.approvalRef === 'string' && job.approvalRef.length > 0
    && job.expiresAtMs <= Date.now() + 240000, 'JOB_BINDING');
  const plan = createSourceReplacementPlan(await read<SourceReplacementInput>(job.input));
  demand(plan.replacementSha256 === job.replacementSha256 && plan.seed.approvalRef === job.approvalRef
    && job.target.generation === plan.seed.generationId && job.target.service === 'migrator', 'PLAN_BINDING');
  const isolated = job.mode === 'isolated';
  demand(isolated || job.mode === 'approved_cutover', 'MODE');
  if (isolated) {
    demand(job.target.systemIdentifier !== '7693392208475083526'
      && /^radar_rehearsal_[a-f0-9]{16}$/.test(job.target.database)
      && job.target.schema === job.target.database && job.target.serverAddress === '127.0.0.1'
      && 'isolatedProof' in job.fence, 'ISOLATED_TARGET');
  } else {
    demand(job.target.systemIdentifier === '7693392208475083526' && job.target.database === 'address_radar'
      && job.target.schema === 'address_radar_business' && job.target.username === 'address_radar_migrator'
      && job.target.generation === 'production-20261006-v1' && job.target.serverAddress === '127.0.0.1'
      && job.target.serverPort === 5432 && 'python' in job.fence, 'PRODUCTION_TARGET');
  }
  let credential!: Credential;
  const authorize: PostgresMigrationRuntimeOptions['assertAuthorized'] = async request => {
    demand(isDeepStrictEqual(await read<SourceContractImportJob>(jobPin), job)
      && request.capability.mode === job.mode && request.capability.purpose === 'business_import'
      && request.capability.planSha256 === job.replacementSha256 && request.capability.approvalRef === job.approvalRef
      && request.capability.expiresAtMs === job.expiresAtMs && isDeepStrictEqual(request.target, job.target), 'AUTHORITY_CHANGED');
    await readPrivateAuthorityPin(job.input);
    if ('python' in job.fence) {
      validateNativeFenceBinding(await read<Record<string, unknown>>(job.fence.request),
        { operationId: job.operationId, approvalRef: job.approvalRef, replacementSha256: job.replacementSha256 },
        { generationId: job.target.generation, oldProviderId: plan.oldProviderId, oldOrigin: plan.oldOrigin,
          newProviderId: plan.seed.budgets[0]!.providerId, newOrigin: plan.seed.budgets[0]!.origin });
    }
    const rotationPlan = await read<RotationPlan>(job.rotation.plan);
    const intent = await read<Authorization & { planSha256: string }>(job.rotation.intent);
    const actualCredential = await read<Credential>(job.rotation.credential);
    const receipt = await read<RotationReceipt>(job.rotation.receipt);
    validateRotationBinding(job, rotationPlan, actualCredential, receipt, job.target);
    demand(intent.operationId === job.operationId && intent.approvalRef === job.approvalRef
      && intent.replacementSha256 === job.replacementSha256 && intent.planSha256 === job.rotation.plan.sha256, 'ROTATION_INTENT');
    if (credential) demand(isDeepStrictEqual(credential, actualCredential), 'CREDENTIAL_CHANGED');
    credential = actualCredential;
  };
  const capability = { mode: job.mode, purpose: 'business_import' as const, approvalRef: job.approvalRef,
    planSha256: job.replacementSha256, expiresAtMs: job.expiresAtMs };
  await authorize({ target: job.target, capability });
  const observer = 'isolatedProof' in job.fence
    ? async (): Promise<SourceReplacementFence> => read<SourceReplacementFence>((job.fence as { isolatedProof: Pin }).isolatedProof)
    : createNativePgSourceFenceObserver(job.fence);
  // The native factory authenticates the retained owner; fixture proof is isolated-only.
  await observer(plan.replacementSha256);
  const audit = join(dirname(jobPin.path), 'source-contract-import');
  return withSourceImportAudit(audit, { operationId: job.operationId, replacementSha256: job.replacementSha256,
    jobSha256: jobPin.sha256, rotationReceiptSha256: job.rotation.receipt.sha256, mode: job.mode, retryAuthorized: false }, async () => {
    // Literal import is part of the formal standalone bundle. Load and construct
    // inside the audited lifecycle, never resolve a repository package at runtime.
    const { PostgresAuthorityPool } = await import('../packages/database/src/postgres-authority-client.js');
    const pool = new PostgresAuthorityPool({ host: credential.host, port: credential.port, database: credential.database,
      user: credential.user, password: credential.password, max: 1, connectionTimeoutMillis: 1000,
      ssl: false, options: '', statement_timeout: 1000, lock_timeout: 1000,
      application_name: 'address-radar-source-contract-import' });
    const result = await importSourceReplacementContract(plan, { migration: { pool, target: job.target, capability,
      limits: { operationTimeoutMs: 3000, connectionTimeoutMs: 1000, statementTimeoutMs: 1000,
        lockTimeoutMs: 1000, maximumSqlStatements: 128, workMemKb: 1024, closeTimeoutMs: 1000 },
      clock: Date.now, assertAuthorized: authorize }, measureExclusiveFence: observer });
    return result;
  });
}

export async function main(args: string[]) {
  demand(args.length === 4 && args[0] === '--job' && args[2] === '--job-sha256', 'ARGUMENTS');
  const result = await runSourceContractImport({ path: args[1]!, sha256: args[3]! });
  process.stdout.write(JSON.stringify({ status: 'COMMITTED', replacementSha256: result.replacementSha256,
    fenceProofScope: result.fenceProofScope, servicesActivated: false }) + '\n');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('IMPORT_REFUSED_OR_UNCERTAIN\n'); process.exitCode = 1; });
}
