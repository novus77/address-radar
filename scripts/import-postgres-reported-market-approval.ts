/** Unbundled root maintenance entry. Never supplies approval content or credentials implicitly. */
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { importReportedMarketApproval, revokeReportedMarketApproval, reportedMarketApprovalRevocationFingerprint, type ReportedMarketApprovalRevocation, readRootReportedMarketApproval, reportedMarketApprovalFingerprint, type ReportedApprovalPin } from './postgres-reported-market-approval.js';
import type { PostgresMigrationTarget } from '../packages/database/src/postgres-migration-runtime.js';

interface Job {
  protocol: 'address-only-reported-market-cap-import-job-v1' | 'address-only-reported-market-cap-revocation-job-v1';
  revocation?: ReportedMarketApprovalRevocation;
  operationId: string; approval: ReportedApprovalPin; credential: ReportedApprovalPin;
  target: PostgresMigrationTarget; mode: 'isolated' | 'approved_cutover'; expiresAtMs: number;
}
export async function withReportedMarketApprovalImportAudit<T>(base: string, intent: {
  readonly operationId: string; readonly jobSha256: string; readonly approvalDocumentSha256: string;
  readonly approvalFingerprint: string; readonly credentialSha256: string; readonly mode: string;
}, execute: () => Promise<T>): Promise<T> {
  const store = async (suffix: string, value: unknown) => {
    const fd = await open(base + suffix + '.json', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
    const directory = await open(dirname(base), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  };
  await store('-intent', { protocol: 'address-only-reported-market-cap-import-intent-v1', ...intent, retryAuthorized: false });
  try {
    const result = await execute();
    await store('-receipt', { protocol: 'address-only-reported-market-cap-import-audit-v1', ...intent, result, servicesActivated: false });
    return result;
  } catch {
    await store('-failed', { status: 'REFUSED_OR_UNCERTAIN', operationId: intent.operationId, retryAuthorized: false, servicesActivated: false });
    throw Error('REPORTED_APPROVAL_IMPORT_REFUSED_OR_UNCERTAIN');
  }
}
const requireValue = (value: unknown): void => { if (!value) throw Error('REPORTED_APPROVAL_IMPORT_REFUSED_OR_UNCERTAIN'); };
export async function runReportedMarketApprovalImport(pin: ReportedApprovalPin) {
  requireValue(process.platform === 'linux' && process.geteuid?.() === 0);
  const read = async () => JSON.parse((await readPrivateAuthorityPin(pin)).toString('utf8')) as Job;
  const job = await read();
  const revoking = job.protocol === 'address-only-reported-market-cap-revocation-job-v1';
  requireValue(Object.keys(job).sort().join(',') === ['protocol','operationId','approval','credential','target','mode','expiresAtMs',...(revoking ? ['revocation'] : [])].sort().join(',')
    && (revoking || job.protocol === 'address-only-reported-market-cap-import-job-v1') && /^[A-Za-z0-9_.:-]{1,128}$/.test(job.operationId)
    && ['isolated','approved_cutover'].includes(job.mode) && Number.isSafeInteger(job.expiresAtMs)
    && job.expiresAtMs > Date.now() && job.expiresAtMs <= Date.now() + 60000 && job.target.service === 'migrator');
  const document = await readRootReportedMarketApproval(job.approval), fingerprint = reportedMarketApprovalFingerprint(document);
  const credential = JSON.parse((await readPrivateAuthorityPin(job.credential)).toString('utf8')) as {
    host: string; port: number; database: string; user: string; password: string; operationId: string; expiresAtMs: number;
  };
  requireValue(credential.host === job.target.serverAddress && credential.port === job.target.serverPort
    && credential.database === job.target.database && credential.user === job.target.username && credential.operationId === job.operationId
    && credential.expiresAtMs >= job.expiresAtMs && typeof credential.password === 'string' && credential.password.length > 0);
  if (revoking) requireValue(job.revocation && Object.keys(job.revocation).sort().join(',') === 'approvalRef,revokedAt');
  const planSha256 = revoking ? reportedMarketApprovalRevocationFingerprint(document,job.revocation!) : fingerprint;
  const capability = { mode: job.mode, purpose: 'business_import' as const,
    approvalRef: revoking ? job.revocation!.approvalRef : document.approvalRef, planSha256, expiresAtMs: job.expiresAtMs };
  const authorize = async () => {
    requireValue(isDeepStrictEqual(await read(), job) && isDeepStrictEqual(await readRootReportedMarketApproval(job.approval), document)
      && isDeepStrictEqual(JSON.parse((await readPrivateAuthorityPin(job.credential)).toString('utf8')), credential)
      && Date.now() < job.expiresAtMs);
  };
  await authorize();
  return withReportedMarketApprovalImportAudit(join(dirname(pin.path),'reported-market-approval-import'), {
    operationId: job.operationId, approvalFingerprint: fingerprint, jobSha256: pin.sha256,
    approvalDocumentSha256: job.approval.sha256, credentialSha256: job.credential.sha256, mode: job.mode }, async () => {
    const { PostgresAuthorityPool } = await import('../packages/database/src/postgres-authority-client.js');
    const pool = new PostgresAuthorityPool({ host: credential.host, port: credential.port, database: credential.database,
      user: credential.user, password: credential.password, max: 1, ssl: false, options: '', connectionTimeoutMillis: 1000,
      statement_timeout: 1000, lock_timeout: 1000, application_name: 'address-radar-reported-approval-import' });
    const migration = { pool, target: job.target, capability, assertAuthorized: authorize, clock: Date.now,
      limits: { operationTimeoutMs: 5000, connectionTimeoutMs: 1000, statementTimeoutMs: 1000, lockTimeoutMs: 1000,
        maximumSqlStatements: 64, workMemKb: 1024, closeTimeoutMs: 1000 } };
    return revoking ? revokeReportedMarketApproval(document,job.revocation!,migration) : importReportedMarketApproval(document,migration);
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    requireValue(args.length === 4 && args[0] === '--job' && args[2] === '--job-sha256');
    return runReportedMarketApprovalImport({ path: args[1]!, sha256: args[3]! });
  }).then(result => process.stdout.write(JSON.stringify(result) + '\n'), () => {
    process.stderr.write('REPORTED_APPROVAL_IMPORT_REFUSED_OR_UNCERTAIN\n'); process.exitCode = 1;
  });
}
