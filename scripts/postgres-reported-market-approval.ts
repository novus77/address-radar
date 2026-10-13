import { createHash, createPublicKey } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readPrivateAuthorityPin } from './postgres-service-cli-authority.js';
import { createPostgresMigrationRuntime, type PostgresMigrationRuntimeOptions } from '../packages/database/src/postgres-migration-runtime.js';
import type { PostgresTransaction } from '../packages/database/src/postgres-unit-of-work.js';
import type { PostgresPricePoolMapping } from '../apps/automation/src/postgres-controlled-price-producer.js';
import type { PostgresReportedMarketCapApproval, PostgresReportedMarketCapValidatorOptions } from '../apps/automation/src/postgres-independent-price-validator.js';
import { postgresServiceFactFingerprint } from '../apps/automation/src/postgres-service-fact-adapters.js';

export { REPORTED_MARKET_APPROVAL_SCOPE, reportedMarketApprovalFingerprint, validateReportedMarketApproval } from '../apps/automation/src/postgres-reported-market-approval-ledger.js';
export type { ReportedApprovalPin, ReportedApprovalTarget, ReportedMarketApprovalDocument } from '../apps/automation/src/postgres-reported-market-approval-ledger.js';
import { REPORTED_MARKET_APPROVAL_SCOPE, reportedMarketApprovalFingerprint, validateReportedMarketApproval,
  type ReportedApprovalPin, type ReportedApprovalTarget, type ReportedMarketApprovalDocument } from '../apps/automation/src/postgres-reported-market-approval-ledger.js';
function demand(value: unknown, reason: string): asserts value { if (!value) throw Error('REPORTED_APPROVAL_' + reason); }
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
export async function readRootReportedMarketApproval(pin: ReportedApprovalPin): Promise<ReportedMarketApprovalDocument> {
  const raw = await readPrivateAuthorityPin(pin);
  const file = await lstat(pin.path); demand(file.uid === 0 && file.isFile() && !file.isSymbolicLink(), 'ROOT_MATERIAL');
  demand(createHash('sha256').update(raw).digest('hex') === pin.sha256, 'PIN');
  return validateReportedMarketApproval(JSON.parse(raw.toString('utf8')));
}
export type ReportedApprovalRun = <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
function sameTarget(document: ReportedMarketApprovalDocument, target: ReportedApprovalTarget) {
  demand(isDeepStrictEqual(document.target, target), 'TARGET_BINDING');
}
/** Read-only identity observation; never assumes the supplied UOW is already attested. */
async function identity(tx: PostgresTransaction, target: ReportedApprovalTarget) {
  const s = '"' + target.schema + '"';
  const rows = (await tx.query(`/* reported-approval-identity */ SELECT current_database() database,
    host(inet_server_addr()) server_address,inet_server_port() server_port,
    (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) system_identifier,
    i.database_name,i.schema_name,i.generation_id,i.ledger_format,l.version,l.fingerprint
    FROM ${s}.business_schema_identity i CROSS JOIN ${s}.business_schema_ledger l
    WHERE i.singleton=true ORDER BY l.version DESC LIMIT 1`)).rows;
  const r = rows[0]; demand(rows.length === 1 && r && r.database === target.database && r.database_name === target.database
    && r.schema_name === target.schema && r.generation_id === target.generationId && r.ledger_format === 1
    && r.server_address === target.serverAddress && r.server_port === target.serverPort && r.system_identifier === target.systemIdentifier
    && r.version === target.schemaVersion && r.fingerprint === target.schemaFingerprint, 'ACTUAL_IDENTITY');
}
function ledgerMatches(row: Record<string, unknown>, document: ReportedMarketApprovalDocument, at: number): boolean {
  return row.import_id === document.importId && row.generation_id === document.target.generationId
    && row.approval_ref === document.approvalRef && row.source_fingerprint === reportedMarketApprovalFingerprint(document)
    && row.proof_scope === REPORTED_MARKET_APPROVAL_SCOPE && row.revoked_at === null
    && row.imported_at !== null && /^\d+$/.test(String(row.imported_at)) && Number.isSafeInteger(Number(row.imported_at))
    && Number(row.imported_at) >= document.approvedAt && Number(row.imported_at) <= at;
}
/** The migration runtime supplies real cluster/role checks, bounded SQL, authorization and atomic commit. */
export async function importReportedMarketApproval(documentInput: unknown, migration: PostgresMigrationRuntimeOptions) {
  const document = validateReportedMarketApproval(documentInput), fingerprint = reportedMarketApprovalFingerprint(document);
  const { generation, username: _username, service: _service, ...target } = migration.target;
  sameTarget(document, { ...target, generationId: generation });
  demand(migration.capability.purpose === 'business_import' && migration.capability.planSha256 === fingerprint
    && migration.capability.approvalRef === document.approvalRef && migration.limits.operationTimeoutMs <= 5000
    && migration.limits.maximumSqlStatements <= 64 && migration.limits.statementTimeoutMs <= 3000
    && migration.limits.lockTimeoutMs <= 1000, 'IMPORT_CAPABILITY');
  const runtime = createPostgresMigrationRuntime(migration);
  try {
    return await runtime.run(async tx => {
      const at = migration.clock(); demand(time(at) && at >= document.validFrom && at < document.validUntil, 'INACTIVE');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([REPORTED_MARKET_APPROVAL_SCOPE,document.importId])]);
      const s = '"' + document.target.schema + '"';
      const rows = (await tx.query(`/* reported-approval-import-existing */ SELECT * FROM ${s}.wallet_service_import_ledger WHERE import_id=$1 FOR UPDATE`, [document.importId])).rows;
      demand(rows.length <= 1, 'COLLISION');
      if (rows.length) demand(ledgerMatches(rows[0]!, document, at), 'COLLISION_OR_REVOKED');
      else {
        const written = await tx.query(`/* reported-approval-import */ INSERT INTO ${s}.wallet_service_import_ledger
          (import_id,generation_id,approval_ref,source_fingerprint,proof_scope,imported_at,revoked_at)
          VALUES($1,$2,$3,$4,$5,$6,NULL) RETURNING import_id`,
        [document.importId,document.target.generationId,document.approvalRef,fingerprint,REPORTED_MARKET_APPROVAL_SCOPE,at]);
        demand(written.rows.length === 1 && written.rows[0]?.import_id === document.importId && written.rowCount === 1, 'INSERT');
      }
      const end = migration.clock(); demand(time(end) && end >= at && end < document.validUntil, 'EXPIRED');
      return { protocol: 'address-only-reported-market-cap-import-receipt-v1' as const, status: rows.length ? 'existing' as const : 'imported' as const,
        importId: document.importId, fingerprint, approvalRef: document.approvalRef, servicesActivated: false, monitoringCompleted: false };
    });
  } finally { await runtime.close(); }
}
export interface ReportedMarketApprovalReaderOptions {
  readonly pin: ReportedApprovalPin; readonly target: ReportedApprovalTarget; readonly run: ReportedApprovalRun;
  readonly now: () => number;
  /** Trusted IO seam for isolated tests. Production defaults to root-owner/no-follow pinned reads. */
  readonly read?: typeof readRootReportedMarketApproval;
}
export function createPostgresReportedMarketApprovalReader(input: ReportedMarketApprovalReaderOptions): NonNullable<PostgresReportedMarketCapValidatorOptions['approval']> {
  const pin = structuredClone(input.pin), target = structuredClone(input.target), run = input.run.bind(input), now = input.now;
  const read = input.read ?? readRootReportedMarketApproval;
  return Object.freeze({ async authorizeReportedMarketCap(request) {
    const defer = () => ({ status: 'deferred' as const, reasonCode: 'reported_market_actual_source_approval_unavailable' });
    try {
      request.signal.throwIfAborted(); const at = now();
      demand(time(at) && time(request.checkedAt) && request.checkedAt <= at, 'CLOCK');
      const document = validateReportedMarketApproval(await read(pin)); sameTarget(document, target);
      const d = document, a = d.validator;
      demand(request.generationId === target.generationId && request.authorizationRef === d.authorizationRef
        && request.validatorId === a.validatorId && request.keyId === a.keyId && request.actorId === a.actorId
        && request.providerId === d.source.providerId && request.sourceApprovalRef === d.source.sourceApprovalRef
        && request.mappingApprovalRef === d.mappingApprovalRef && request.mappingFingerprint === d.mappingFingerprint
        && request.quoteAddress === d.quoteAddress && hash(request.candidateFingerprint) && hash(request.executionFingerprint)
        && label(request.sampleId) && at >= d.validFrom && at < d.validUntil && request.checkedAt >= d.validFrom
        && d.reviewer.conflictVerdict === 'none_observed', 'SCOPE_OR_REVIEW');
      await run(async tx => {
        request.signal.throwIfAborted(); await identity(tx, target);
        const rows = (await tx.query(`/* reported-approval-reader: read only */ SELECT * FROM "${target.schema}".wallet_service_import_ledger
          WHERE import_id=$1 AND generation_id=$2`, [d.importId,target.generationId])).rows;
        demand(rows.length === 1 && ledgerMatches(rows[0]!, d, at), 'ACTUAL_LEDGER');
        request.signal.throwIfAborted();
      });
      const final = validateReportedMarketApproval(await read(pin)), ended = now();
      demand(isDeepStrictEqual(final, d) && time(ended) && ended >= at && ended < d.validUntil, 'CHANGED_OR_EXPIRED');
      request.signal.throwIfAborted();
      const approval: PostgresReportedMarketCapApproval & { approvalImportId: string; approvalDocument: ReportedMarketApprovalDocument; approvalDocumentFingerprint: string; sourceOrigin: string; reviewer: ReportedMarketApprovalDocument['reviewer'] } = {
        approvalRef: d.authorizationRef, generationId: target.generationId, validatorId: a.validatorId, keyId: a.keyId, actorId: a.actorId,
        providerId: d.source.providerId, mappingApprovalRef: d.mappingApprovalRef, sourceApprovalRef: d.source.sourceApprovalRef,
        mappingFingerprint: d.mappingFingerprint, quoteAddress: d.quoteAddress, sourceProofKind: d.sourceProofKind,
        quality: d.quality, conflictState: d.reviewer.conflictVerdict, validFrom: d.validFrom, validUntil: d.validUntil, revokedAt: null,
        approvalImportId: d.importId, approvalDocument: structuredClone(d), approvalDocumentFingerprint: reportedMarketApprovalFingerprint(d), sourceOrigin: d.source.origin, reviewer: structuredClone(d.reviewer) };
      return { status: 'approved' as const, approval };
    } catch { return defer(); }
  } });
}

export interface ReportedMarketApprovalRevocation { readonly approvalRef: string; readonly revokedAt: number }
export function reportedMarketApprovalRevocationFingerprint(document: ReportedMarketApprovalDocument, revocation: ReportedMarketApprovalRevocation): string {
  demand(label(revocation.approvalRef) && time(revocation.revokedAt), 'REVOCATION');
  return postgresServiceFactFingerprint({ action: 'revoke_reported_market_cap_approval_v1', documentFingerprint: reportedMarketApprovalFingerprint(document), revocation });
}
/** All controlled revocations use the same exclusive transaction lock as imports.
 * Publishers/consumers hold its shared counterpart until commit, without ledger UPDATE ACL.
 */
export async function revokeReportedMarketApproval(documentInput: unknown, revocation: ReportedMarketApprovalRevocation,
  migration: PostgresMigrationRuntimeOptions) {
  const document = validateReportedMarketApproval(documentInput), fingerprint = reportedMarketApprovalFingerprint(document);
  const { generation, username: _username, service: _service, ...target } = migration.target;
  sameTarget(document, { ...target, generationId: generation });
  demand(migration.capability.purpose === 'business_import' && migration.capability.approvalRef === revocation.approvalRef
    && migration.capability.planSha256 === reportedMarketApprovalRevocationFingerprint(document,revocation)
    && migration.limits.operationTimeoutMs <= 5000 && migration.limits.statementTimeoutMs <= 3000
    && migration.limits.lockTimeoutMs <= 1000 && migration.limits.maximumSqlStatements <= 64, 'REVOCATION_CAPABILITY');
  const runtime = createPostgresMigrationRuntime(migration);
  try {
    return await runtime.run(async tx => {
      demand(time(revocation.revokedAt) && revocation.revokedAt <= migration.clock(), 'REVOCATION_CLOCK');
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([REPORTED_MARKET_APPROVAL_SCOPE,document.importId])]);
      const s = '"'+document.target.schema+'"';
      const rows = (await tx.query(`/* reported-approval-revoke-read */ SELECT * FROM ${s}.wallet_service_import_ledger WHERE import_id=$1 FOR UPDATE`,[document.importId])).rows;
      demand(rows.length === 1 && rows[0]?.generation_id === document.target.generationId && rows[0]?.approval_ref === document.approvalRef
        && rows[0]?.source_fingerprint === fingerprint && rows[0]?.proof_scope === REPORTED_MARKET_APPROVAL_SCOPE, 'REVOCATION_BINDING');
      const previous = rows[0]!.revoked_at;
      if (previous === null) {
        const result = await tx.query(`/* reported-approval-revoke */ UPDATE ${s}.wallet_service_import_ledger SET revoked_at=$2
          WHERE import_id=$1 AND source_fingerprint=$3 AND proof_scope=$4 AND revoked_at IS NULL RETURNING import_id`,
          [document.importId,revocation.revokedAt,fingerprint,REPORTED_MARKET_APPROVAL_SCOPE]);
        demand(result.rowCount === 1 && result.rows.length === 1 && result.rows[0]?.import_id === document.importId, 'REVOCATION_WRITE');
      } else demand(Number(previous) === revocation.revokedAt, 'REVOCATION_COLLISION');
      return { status: previous === null ? 'revoked' as const : 'existing' as const, importId: document.importId,
        fingerprint, revokedAt: revocation.revokedAt, servicesActivated: false, monitoringCompleted: false };
    });
  } finally { await runtime.close(); }
}

/** Source-configuration inspection only. No synthetic sample, signature or business eligibility. */
export async function verifyReportedMarketApprovalConfiguration(input: ReportedMarketApprovalReaderOptions): Promise<ReportedMarketApprovalDocument> {
  const read = input.read ?? readRootReportedMarketApproval, at = input.now();
  const document = validateReportedMarketApproval(await read(input.pin)); sameTarget(document,input.target);
  demand(time(at) && at >= document.validFrom && at < document.validUntil && document.reviewer.conflictVerdict === 'none_observed','CONFIGURATION_APPROVAL');
  await input.run(async tx => {
    await identity(tx,input.target);
    const rows=(await tx.query(`/* reported-approval-reader: read only */ SELECT * FROM "${input.target.schema}".wallet_service_import_ledger WHERE import_id=$1 AND generation_id=$2`,[document.importId,document.target.generationId])).rows;
    demand(rows.length===1 && ledgerMatches(rows[0]!,document,at),'ACTUAL_LEDGER');
  });
  const ended=input.now(), final=validateReportedMarketApproval(await read(input.pin));
  demand(isDeepStrictEqual(final,document) && time(ended) && ended>=at && ended<document.validUntil,'CHANGED_OR_EXPIRED');
  return document;
}
