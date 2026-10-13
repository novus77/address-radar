import { createHash } from "node:crypto";
import {
  fullDataPreservationLimits, fullDataPreservationSql, readOpaqueFullDataPreservationBundle,
  readFullDataPreservationSourceFile, verifyOpaqueFullDataPreservationChunk, preservationRowByteWindows,
  type FullDataPreservationImportInput, type FullDataPreservationSegmentOptions,
  type FullDataPreservationChunkPlan,
} from "./postgres-full-data-import.js";
import { PostgresCommitUncertainError, type PostgresTransaction } from "./postgres-unit-of-work.js";

export interface StagedPreservationFreezeBinding {
  readonly sessionId: string;
  readonly freezeEpoch: string;
  readonly operationId: string;
  readonly snapshotSha256: string;
  readonly manifestSha256: string;
  readonly target: { readonly database: string; readonly schema: string; readonly endpoint: string; readonly systemIdentifier: string };
  /** Protected measured ACL/admission/owner evidence, authenticated by the parent verifier. */
  readonly freezeEvidenceSha256: string;
}
export interface StagedPreservationFreezeMeasurement {
  readonly binding: StagedPreservationFreezeBinding;
  readonly observedAtMs: number;
  readonly validUntilMs: number;
}
export interface StagedPreservationFreezePorts {
  /** Must collect current ACL, writer admission and session/transaction exclusion observations. */
  readLiveMeasurement(binding: StagedPreservationFreezeBinding): Promise<Uint8Array>;
  /** Privileged parent dependency: independently authenticates measured bytes, never echoes candidate claims.
   * The boundary excludes data mutation, including owner mutation, throughout the epoch.
   * Only bounded finalization-ledger writes are admitted. Missing measurement returns null.
   */
  verifyMeasurement(bytes: Uint8Array, binding: StagedPreservationFreezeBinding): Promise<StagedPreservationFreezeMeasurement | null>;
}
export interface StagedPreservationParityInput extends FullDataPreservationImportInput {
  readonly binding: StagedPreservationFreezeBinding;
  readonly freeze: StagedPreservationFreezePorts;
  readonly closeReserveMs: number;
  readonly maximumEvidenceAgeMs: number;
}
export interface StagedPreservationParityArtifact {
  readonly artifactSha256: string;
  readonly bytes: Uint8Array;
}
export interface StagedPreservationArtifactTrust {
  readonly trustedVerifierId: string;
  /** Must verify protected provenance and actual execution, not accept a digest or success flag alone. */
  verifyArtifact(bytes: Uint8Array, context: { readonly binding: StagedPreservationFreezeBinding; readonly artifactSha256: string }): Promise<{
    readonly artifactSha256: string; readonly verifierId: string;
  } | null>;
}
export interface StagedPreservationFinalizerInput extends StagedPreservationParityInput {
  readonly proofs: readonly StagedPreservationParityArtifact[];
  readonly evidence: StagedPreservationArtifactTrust;
}
type Row = Record<string, unknown>;
type ChunkProof = { index: number; sha256: string; rowCount: number; rowBytesSha256: string };
type Proof = { version: 1; kind: "staged-preservation-parity"; binding: StagedPreservationFreezeBinding; boundarySha256: string;
  selection: FullDataPreservationSegmentOptions["selection"]; observedAtMs: number;
  preMeasurementSha256: string; postMeasurementSha256: string; chunks: ChunkProof[] };
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function gate(value: unknown, code: string): asserts value { if (!value) throw new Error("staged_parity_" + code); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child)).join(",") + "}";
  gate(value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)), "invalid_json");
  return JSON.stringify(value);
}
function parse(bytes: Uint8Array): unknown {
  gate(bytes.byteLength > 0 && bytes.byteLength <= 4 * 1024 ** 2, "artifact_size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  gate(canonical(value) === text, "noncanonical_artifact");
  return value;
}
function count(value: unknown): number {
  gate(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)), "invalid_count");
  return Number(value);
}
function integer(value: unknown, maximum: number, minimum = 1): asserts value is number {
  gate(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum, "invalid_budget");
}
function digest(value: unknown): asserts value is string { gate(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "invalid_digest"); }
function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
function identifier(schema: string): string {
  gate(/^[a-z_][a-z0-9_]{0,62}$/.test(schema) && schema !== "public" && schema !== "information_schema" && !schema.startsWith("pg_"), "schema");
  return '"' + schema + '"';
}

/** Opt-in provisioning only. Neither parity nor finalization executes this DDL.
 * Owner-only completion receipts must be denied to importer and verifier roles.
 */
export function createStagedPreservationCompletionSchemaSql(schema: string): string {
  const s = identifier(schema);
  return `CREATE TABLE ${s}.full_data_preservation_staged_completions (
    operation_id TEXT PRIMARY KEY, snapshot_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
    session_id TEXT NOT NULL, freeze_epoch TEXT NOT NULL,
    boundary_sha256 TEXT NOT NULL CHECK (boundary_sha256 ~ '^[0-9a-f]{64}$'),
    proofs_sha256 TEXT NOT NULL CHECK (proofs_sha256 ~ '^[0-9a-f]{64}$'),
    FOREIGN KEY (operation_id,snapshot_sha256,manifest_sha256)
      REFERENCES ${s}.full_data_preservation_operations (operation_id,snapshot_sha256,manifest_sha256)
  )`;
}

async function prepare(input: StagedPreservationParityInput) {
  const budget = Object.freeze({ ...input.executionBudget });
  integer(budget.deadlineAtMs, Number.MAX_SAFE_INTEGER);
  gate(budget.deadlineAtMs - Date.now() <= 900_000, "invocation_budget");
  integer(budget.maximumTransactionMs, 60_000);
  integer(budget.maximumQueriesPerTransaction, 100_000);
  integer(budget.maximumTotalQueries, 100_000_000);
  integer(input.closeReserveMs, Number.MAX_SAFE_INTEGER);
  integer(input.maximumEvidenceAgeMs, Number.MAX_SAFE_INTEGER);
  gate(budget.opaqueRowWindows, "explicit_row_windows_required");
  const windows = Object.freeze({ ...budget.opaqueRowWindows });
  integer(windows.maximumRows, 4096); integer(windows.maximumBytes, 2 * 1024 ** 2);
  gate(typeof input.freeze?.readLiveMeasurement === "function" && typeof input.freeze.verifyMeasurement === "function", "freeze_ports_required");
  // Copy through canonical bytes before asynchronous work; caller mutation cannot change the epoch.
  const binding = parse(Buffer.from(canonical(input.binding))) as StagedPreservationFreezeBinding;
  freezeJson(binding);
  for (const name of [binding.sessionId, binding.freezeEpoch, binding.operationId]) gate(typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name), "binding");
  digest(binding.manifestSha256); digest(binding.snapshotSha256); digest(binding.freezeEvidenceSha256);
  gate(binding.target?.database === input.target.database && binding.target.schema === input.target.schema &&
    typeof binding.target.endpoint === "string" && binding.target.endpoint.length > 0 &&
    typeof binding.target.systemIdentifier === "string" && binding.target.systemIdentifier.length > 0, "target_binding");
  const target = Object.freeze({ ...input.target });
  const s = identifier(target.schema);
  const sql = Object.fromEntries(Object.entries(fullDataPreservationSql).map(([key, value]) => [key, value.replaceAll("__SCHEMA__", s)])) as typeof fullDataPreservationSql;
  const checkpoint = (released = false) => {
    gate(Date.now() < budget.deadlineAtMs, "deadline"); input.checkpoint?.(released);
  };
  const bundle = await readOpaqueFullDataPreservationBundle(input.bundleDirectory, input.limits, checkpoint);
  gate(bundle.manifest.manifestSha256 === binding.manifestSha256 && bundle.manifest.value.snapshotSha256 === binding.snapshotSha256 &&
    bundle.manifest.value.operationId === binding.operationId, "source_binding");
  const plans = bundle.manifest.value.tables.flatMap(table => table.chunks);
  const boundarySha256 = hash(canonical(binding));
  let totalQueries = 0;
  async function live(): Promise<string> {
    checkpoint();
    const measurementStarted = Date.now();
    const bytes = Buffer.from(await input.freeze.readLiveMeasurement(binding));
    gate(bytes.length > 0 && bytes.length <= 4 * 1024 ** 2, "freeze_measurement_size");
    const verified = await input.freeze.verifyMeasurement(Buffer.from(bytes), binding);
    checkpoint();
    gate(verified && canonical(verified.binding) === canonical(binding), "freeze_changed_or_unverified");
    integer(verified.observedAtMs, Number.MAX_SAFE_INTEGER); integer(verified.validUntilMs, Number.MAX_SAFE_INTEGER);
    gate(verified.observedAtMs >= measurementStarted && verified.observedAtMs <= Date.now() &&
      Date.now() - verified.observedAtMs <= input.maximumEvidenceAgeMs &&
      verified.validUntilMs >= budget.deadlineAtMs + input.closeReserveMs, "freeze_lifetime");
    return hash(bytes);
  }
  async function transaction<T>(readOnly: boolean, operation: (tx: PostgresTransaction) => Promise<T>): Promise<T> {
    checkpoint();
    gate(Date.now() + budget.maximumTransactionMs + input.closeReserveMs < budget.deadlineAtMs, "transaction_admission_budget");
    const result = await input.unitOfWork.run(async raw => {
      const expiresAt = Math.min(budget.deadlineAtMs, Date.now() + budget.maximumTransactionMs);
      let queries = 0;
      const tx: PostgresTransaction = { async query(text, values = []) {
        checkpoint();
        gate(Date.now() < expiresAt, "transaction_deadline");
        gate(queries + 2 <= budget.maximumQueriesPerTransaction && totalQueries + 2 <= budget.maximumTotalQueries, "query_budget");
        queries += 2; totalQueries += 2;
        await raw.query(sql.queryTimeout, [String(expiresAt - Date.now())]);
        checkpoint(); gate(Date.now() < expiresAt, "transaction_deadline");
        const result = await raw.query(text, values);
        checkpoint(); gate(Date.now() < expiresAt, "transaction_deadline");
        return result;
      } };
      // First statement after the UOW's timeout setup; a parent-enforced read role is still required.
      if (readOnly) await tx.query("SET TRANSACTION READ ONLY");
      const identity = await tx.query(sql.targetIdentity, [target.schema]);
      gate(identity.rows.length === 1 && identity.rows[0]!.database === target.database && identity.rows[0]!.schema === target.schema && identity.rows[0]!.role === target.role, "target_identity");
      if (!readOnly) await tx.query(sql.lockOperation, [target.schema + ":" + binding.operationId]);
      return operation(tx);
    });
    checkpoint(); return result;
  }
  const operationSql = sql.selectOperation.replace(" FOR UPDATE", "");
  async function operation(tx: PostgresTransaction, write = false): Promise<Row> {
    const result = await tx.query(write ? sql.selectOperation : operationSql, [binding.operationId, fullDataPreservationLimits.maxManifestBytes]);
    gate(result.rows.length === 1, "operation_missing"); const row = result.rows[0]!;
    lineage(row);
    gate(Buffer.isBuffer(row.manifest_body) && row.manifest_body.equals(bundle.manifest.body) && row.catalog_fingerprint === bundle.manifest.value.catalogFingerprint &&
      count(row.planned_tables) === bundle.manifest.value.tables.length && count(row.planned_chunks) === plans.length &&
      count(row.planned_rows) === bundle.manifest.totalRows && typeof row.completed === "boolean", "operation_plan");
    return row;
  }
  function lineage(row: Row) {
    gate(row.operation_id === binding.operationId && row.manifest_sha256 === binding.manifestSha256 && row.snapshot_sha256 === binding.snapshotSha256, "lineage");
  }
  function receipt(row: Row, plan: FullDataPreservationChunkPlan) {
    lineage(row);
    gate(row.table_name === plan.table && count(row.ordinal) === plan.ordinal && row.file === plan.file &&
      count(row.start_row) === plan.startRow && count(row.row_count) === plan.rowCount && row.sha256 === plan.sha256, "chunk_plan");
  }
  async function unchangedSource() {
    checkpoint();
    gate(hash(await readFullDataPreservationSourceFile(bundle.directory, "manifest.json", fullDataPreservationLimits.maxManifestBytes)) === binding.manifestSha256, "source_changed");
    checkpoint();
  }
  return { binding, boundarySha256, bundle, plans, sql, s, windows, checkpoint, live, transaction, operation, lineage, receipt, unchangedSource };
}

/** Independent SELECT-only comparison of both target byte representations. No importer proofs are trusted.
 * Fresh whole-source validation is performed on every invocation. A selection must fit the caller's budget.
 */
export async function verifyStagedFullDataPreservationSegment(input: StagedPreservationParityInput & {
  readonly selection: FullDataPreservationSegmentOptions["selection"];
}): Promise<StagedPreservationParityArtifact> {
  const selection = Object.freeze({ ...input.selection });
  integer(selection.startChunkIndex, Number.MAX_SAFE_INTEGER, 0);
  integer(selection.endChunkIndexExclusive, Number.MAX_SAFE_INTEGER, selection.startChunkIndex + 1);
  const p = await prepare(input);
  gate(selection.endChunkIndexExclusive <= p.plans.length, "selection");
  const preMeasurementSha256 = await p.live();
  const chunks: ChunkProof[] = [];
  for (let index = selection.startChunkIndex; index < selection.endChunkIndexExclusive; index++) {
    const plan = p.plans[index]!;
    async function verifyChunk(): Promise<ChunkProof> {
      p.checkpoint();
      const bytes = await readFullDataPreservationSourceFile(p.bundle.directory, plan.file, p.bundle.manifest.value.limits.maximumChunkBytes);
      const chunk = verifyOpaqueFullDataPreservationChunk(bytes, p.bundle.manifest, plan.table, plan.ordinal, input.limits);
      const rowDigest = createHash("sha256");
      await p.transaction(true, async tx => {
        await p.operation(tx);
        const receipt = await tx.query(p.sql.selectChunk, [p.binding.operationId, plan.table, plan.ordinal, 0]);
        gate(receipt.rows.length === 1, "chunk_accounting"); p.receipt(receipt.rows[0]!, plan);
        gate(count(receipt.rows[0]!.chunk_bytes) === bytes.length, "chunk_body_length");
        for (let offset = 0; offset < bytes.length; offset += p.windows.maximumBytes) {
          const length = Math.min(p.windows.maximumBytes, bytes.length - offset);
          const slice = await tx.query(p.sql.selectChunkBodySlice, [p.binding.operationId, plan.table, plan.ordinal, offset + 1, length]);
          gate(slice.rows.length === 1 && Buffer.isBuffer(slice.rows[0]!.body) && slice.rows[0]!.body.equals(bytes.subarray(offset, offset + length)), "chunk_body_mismatch");
        }
        for (const page of preservationRowByteWindows(chunk.rowBodies, p.windows.maximumRows, p.windows.maximumBytes)) {
          const result = await tx.query(p.sql.selectRows, [p.binding.operationId, plan.table, plan.startRow + page.start,
            plan.startRow + page.end, fullDataPreservationLimits.maxRowBytes, page.end - page.start + 1]);
          gate(result.rows.length === page.end - page.start, "row_accounting");
          for (const [ordinal, row] of result.rows.entries()) {
            p.lineage(row);
            const expected = chunk.rowBodies[page.start + ordinal]!;
            gate(row.table_name === plan.table && count(row.row_ordinal) === plan.startRow + page.start + ordinal &&
              count(row.chunk_ordinal) === plan.ordinal && Buffer.isBuffer(row.row_body) && row.row_body.equals(expected), "row_body_mismatch");
            rowDigest.update(expected); rowDigest.update("\n");
          }
        }
      });
      return { index, sha256: plan.sha256, rowCount: plan.rowCount, rowBytesSha256: rowDigest.digest("hex") };
    }
    chunks.push(await verifyChunk());
    p.checkpoint(true);
  }
  await p.unchangedSource();
  const postMeasurementSha256 = await p.live();
  const proof: Proof = { version: 1, kind: "staged-preservation-parity", binding: p.binding, boundarySha256: p.boundarySha256,
    selection, observedAtMs: Date.now(), preMeasurementSha256, postMeasurementSha256, chunks };
  const bytes = Buffer.from(canonical(proof));
  gate(bytes.length <= 4 * 1024 ** 2, "artifact_size");
  return Object.freeze({ artifactSha256: hash(bytes), bytes });
}

/** Requires independently authenticated artifact bytes and a continuously measured frozen epoch.
 * Completion receipt and legacy completion marker commit atomically through the existing top-level UOW.
 * The owner connection may write only finalization ledgers; parent ACL/admission enforcement owns this rule.
 */
export async function finalizeStagedFullDataPreservation(input: StagedPreservationFinalizerInput): Promise<{
  completed: true; parityComplete: true; completionOutcome: "acknowledged" | "reconciled";
  boundarySha256: string; proofsSha256: string; grantsBusinessEligibility: false;
}> {
  gate(typeof input.evidence?.verifyArtifact === "function" && typeof input.evidence.trustedVerifierId === "string" && input.evidence.trustedVerifierId.length > 0, "artifact_trust_required");
  // Copy actual bytes and references before the first await.
  gate(Array.isArray(input.proofs) && input.proofs.length > 0 && input.proofs.length <= fullDataPreservationLimits.maxChunks, "proofs_required");
  let totalArtifactBytes = 0;
  const artifacts = input.proofs.map(proof => {
    gate(proof.bytes instanceof Uint8Array && proof.bytes.byteLength > 0 && proof.bytes.byteLength <= 4 * 1024 ** 2, "artifact_size");
    totalArtifactBytes += proof.bytes.byteLength;
    gate(totalArtifactBytes <= fullDataPreservationLimits.maxManifestBytes, "artifact_total_size");
    return { artifactSha256: proof.artifactSha256, bytes: Buffer.from(proof.bytes) };
  });
  const p = await prepare(input);
  gate(artifacts.length > 0 && artifacts.length <= p.plans.length + 1, "proof_count");
  await p.live();
  const coverage = new Set<number>();
  for (const artifact of artifacts) {
    p.checkpoint(); digest(artifact.artifactSha256);
    gate(hash(artifact.bytes) === artifact.artifactSha256, "artifact_digest");
    const verification = await input.evidence.verifyArtifact(Buffer.from(artifact.bytes), { binding: p.binding, artifactSha256: artifact.artifactSha256 });
    p.checkpoint();
    gate(verification?.artifactSha256 === artifact.artifactSha256 && verification.verifierId === input.evidence.trustedVerifierId, "artifact_untrusted");
    const proof = parse(artifact.bytes) as Proof;
    gate(proof.version === 1 && proof.kind === "staged-preservation-parity" && canonical(proof.binding) === canonical(p.binding) &&
      proof.boundarySha256 === p.boundarySha256, "proof_epoch_or_binding");
    integer(proof.observedAtMs, Number.MAX_SAFE_INTEGER);
    gate(proof.observedAtMs <= Date.now() && Date.now() - proof.observedAtMs <= input.maximumEvidenceAgeMs, "proof_age");
    digest(proof.preMeasurementSha256); digest(proof.postMeasurementSha256);
    integer(proof.selection?.startChunkIndex, p.plans.length, 0);
    integer(proof.selection?.endChunkIndexExclusive, p.plans.length, proof.selection.startChunkIndex + 1);
    gate(Array.isArray(proof.chunks) && proof.chunks.length === proof.selection.endChunkIndexExclusive - proof.selection.startChunkIndex, "proof_coverage");
    for (const [offset, chunk] of proof.chunks.entries()) {
      const index = proof.selection.startChunkIndex + offset, plan = p.plans[index]!;
      gate(chunk.index === index && chunk.sha256 === plan.sha256 && chunk.rowCount === plan.rowCount && !coverage.has(index), "proof_coverage");
      digest(chunk.rowBytesSha256); coverage.add(index);
    }
  }
  gate(coverage.size === p.plans.length, "incomplete_coverage");
  const proofsSha256 = hash(canonical(artifacts.map(a => a.artifactSha256).sort()));
  const values = [p.binding.operationId, p.binding.snapshotSha256, p.binding.manifestSha256,
    p.binding.sessionId, p.binding.freezeEpoch, p.boundarySha256, proofsSha256];
  const select = `/* staged-parity:selectCompletion */ SELECT operation_id,snapshot_sha256,manifest_sha256,session_id,freeze_epoch,boundary_sha256,proofs_sha256
    FROM ${p.s}.full_data_preservation_staged_completions WHERE operation_id=$1`;
  const expected = { operation_id: values[0], snapshot_sha256: values[1], manifest_sha256: values[2], session_id: values[3],
    freeze_epoch: values[4], boundary_sha256: values[5], proofs_sha256: values[6] };
  async function accounting(tx: PostgresTransaction) {
    const tables = await tx.query(p.sql.selectTables, [p.binding.operationId, p.bundle.manifest.value.tables.length + 1]);
    gate(tables.rows.length === p.bundle.manifest.value.tables.length, "table_accounting");
    const seen = new Set<string>();
    for (const row of tables.rows) {
      p.lineage(row);
      const table = p.bundle.manifest.value.tables.find(t => t.name === row.table_name);
      gate(table && !seen.has(table.name) && count(row.row_count) === table.rowCount && count(row.chunk_count) === table.chunks.length && row.content_sha256 === table.contentSha256, "table_plan");
      seen.add(table.name);
    }
    const result = await tx.query(`/* staged-parity:counts */ SELECT
      (SELECT count(*)::text FROM ${p.s}.full_data_preservation_tables WHERE operation_id=$1) AS table_count,
      (SELECT count(*)::text FROM ${p.s}.full_data_preservation_chunks WHERE operation_id=$1) AS chunk_count,
      (SELECT count(*)::text FROM ${p.s}.full_data_preservation_rows WHERE operation_id=$1) AS row_count`, [p.binding.operationId]);
    gate(result.rows.length === 1 && count(result.rows[0]!.table_count) === p.bundle.manifest.value.tables.length &&
      count(result.rows[0]!.chunk_count) === p.plans.length && count(result.rows[0]!.row_count) === p.bundle.manifest.totalRows, "extra_or_missing_records");
  }
  await p.unchangedSource(); await p.live();
  let completionOutcome: "acknowledged" | "reconciled" = "acknowledged";
  try {
    await p.transaction(false, async tx => {
      const operation = await p.operation(tx, true);
      await accounting(tx);
      const prior = await tx.query(select, [p.binding.operationId]);
      if (prior.rows.length) {
        gate(prior.rows.length === 1 && canonical(prior.rows[0]) === canonical(expected) && operation.completed === true, "completion_binding");
        return;
      }
      gate(operation.completed === false, "completion_without_staged_receipt");
      for (const table of p.bundle.manifest.value.tables) {
        const verified = await tx.query(p.sql.verifyTable, [p.binding.operationId, table.name, p.binding.manifestSha256, table.rowCount, table.chunks.length]);
        gate(verified.rowCount === 1, "table_proof_write");
      }
      const inserted = await tx.query(`/* staged-parity:insertCompletion */ INSERT INTO ${p.s}.full_data_preservation_staged_completions
        (operation_id,snapshot_sha256,manifest_sha256,session_id,freeze_epoch,boundary_sha256,proofs_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING operation_id,snapshot_sha256,manifest_sha256,session_id,freeze_epoch,boundary_sha256,proofs_sha256`, values);
      gate(inserted.rowCount === 1 && inserted.rows.length === 1 && canonical(inserted.rows[0]) === canonical(expected), "completion_receipt_write");
      const completed = await tx.query(p.sql.completeOperation, values.slice(0, 3));
      gate(completed.rowCount === 1 && completed.rows.length === 1 && completed.rows[0]!.operation_id === p.binding.operationId, "completion_write");
    });
  } catch (error) {
    if (!(error instanceof PostgresCommitUncertainError)) throw error;
    // A fresh read under the same live epoch is the only reconciliation; no blind rewrite.
    await p.live();
    await p.transaction(true, async tx => {
      const operation = await p.operation(tx);
      const durable = await tx.query(select.replace(" FOR UPDATE", ""), [p.binding.operationId]);
      gate(operation.completed === true && durable.rows.length === 1 && canonical(durable.rows[0]) === canonical(expected), "completion_unknown_unreconciled");
      await accounting(tx);
    });
    completionOutcome = "reconciled";
  }
  await p.unchangedSource(); await p.live();
  return Object.freeze({ completed: true, parityComplete: true, completionOutcome,
    boundarySha256: p.boundarySha256, proofsSha256, grantsBusinessEligibility: false });
}
