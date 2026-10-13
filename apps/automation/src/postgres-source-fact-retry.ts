import { performance } from "node:perf_hooks";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import type { createPostgresExecutionEnvelopeReader } from "./postgres-execution-envelope-reader.js";
import type { createPostgresSourceFactReceiver } from "./postgres-source-fact-receiver.js";

export interface PostgresSourceFactRetryAuthority {
  /** Preconstructed trusted ports; this scheduler never creates keys, validators, publishers or pools. */
  readonly reader: Pick<ReturnType<typeof createPostgresExecutionEnvelopeReader>, "load">;
  readonly receiver: Pick<ReturnType<typeof createPostgresSourceFactReceiver>, "receive">;
}
export interface PostgresSourceFactRetryOptions {
  readonly generationId: string; readonly activatedAt: number;
  /** Read-only native UOW, configured with statement timeout by its owner. */
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  readonly authority?: PostgresSourceFactRetryAuthority | undefined;
  readonly maximumSamples: number; readonly maximumPayloadBytes: number; readonly maximumRunMs: number;
  readonly now: () => number;
}
export interface PostgresSourceFactRetryReport {
  readonly status: "polled" | "deferred"; readonly reasonCode?: string;
  readonly scanned: number; readonly attempted: number; readonly published: number; readonly duplicates: number;
  readonly deferred: number; readonly alreadyRecorded: number; readonly failed: number;
  readonly diagnostics: readonly { readonly stage: "scan" | "read" | "receive"; readonly reasonCode: string }[];
  readonly diagnosticsDropped: number;
}
type Cursor = { readonly createdAt: number; readonly sampleId: string };
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_:.\-/]+$/.test(value)
  && value.length <= 512 && !value.includes("://");
function requireBinding(value: unknown): asserts value { if (!value) throw new Error("Source retry binding unavailable"); }
function clock(value: unknown): number {
  requireBinding(time(value) || typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value));
  const at = Number(value); requireBinding(time(at)); return at;
}
function after(left: Cursor, right: Cursor): boolean {
  return left.createdAt > right.createdAt || left.createdAt === right.createdAt
    && Buffer.compare(Buffer.from(left.sampleId), Buffer.from(right.sampleId)) > 0;
}

/** Scheduling state is disposable. Only actual fact/attestation rows acknowledge a publication after restart. */
export function createPostgresSourceFactRetry(input: PostgresSourceFactRetryOptions) {
  const options = { ...input, authority: input.authority ? { ...input.authority } : undefined };
  requireBinding(id(options.generationId) && time(options.activatedAt) && typeof options.run === "function" && typeof options.now === "function");
  for (const [value, maximum] of [[options.maximumSamples, 1000], [options.maximumPayloadBytes, 10_000_000], [options.maximumRunMs, 300_000]]) {
    requireBinding(time(value) && value > 0 && value <= maximum!);
  }
  if (options.authority) requireBinding(typeof options.authority.reader?.load === "function" && typeof options.authority.receiver?.receive === "function");
  let cursor: Cursor | null = null, busy = false, lastAt = options.activatedAt;
  return Object.freeze({ async pollOnce(signal: AbortSignal): Promise<PostgresSourceFactRetryReport> {
    const report = { status: "polled" as "polled" | "deferred",
      scanned: 0, attempted: 0, published: 0, duplicates: 0, deferred: 0, alreadyRecorded: 0, failed: 0,
      diagnostics: [] as { stage: "scan" | "read" | "receive"; reasonCode: string }[], diagnosticsDropped: 0 };
    const finish = (reasonCode?: string): PostgresSourceFactRetryReport => Object.freeze({ ...report,
      ...(reasonCode ? { status: "deferred" as const, reasonCode } : {}), diagnostics: Object.freeze([...report.diagnostics]) });
    const diagnose = (stage: "scan" | "read" | "receive", reasonCode: string) => {
      if (report.diagnostics.length < 32) report.diagnostics.push({ stage, reasonCode }); else report.diagnosticsDropped++;
    };
    const authority = options.authority;
    if (!authority) return finish("source_retry_authority_unavailable");
    if (signal.aborted) return finish("source_retry_aborted_or_timed_out");
    if (busy) return finish("source_retry_busy");
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort(), started = performance.now();
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(abort, options.maximumRunMs);
    let stage: "scan" | "read" | "receive" = "scan", startedAt: number | undefined;
    const check = () => {
      controller.signal.throwIfAborted(); const at = options.now();
      requireBinding(time(at) && at >= lastAt && (startedAt === undefined || at - startedAt < options.maximumRunMs)
        && performance.now() - started < options.maximumRunMs);
      lastAt = at; startedAt ??= at; return at;
    };
    try {
      const asOf = check();
      const page = await options.run(async tx => {
        check(); const result = await tx.query(`SELECT /* source-retry-committed-samples */
          s.sample_id,s.generation_id,s.execution_fingerprint,s.entity_id,s.chain,s.token_address,s.occurred_at,s.created_at,
          r.recorded_at,r.state AS revision_state,t.original_fingerprint,g.activated_at,
          EXISTS(SELECT 1 FROM wallet_service_fact_inputs f WHERE f.generation_id=s.generation_id AND f.kind='source'
            AND f.payload::jsonb->>'sampleId'=s.sample_id
            AND f.payload::jsonb->>'executionFingerprint'=s.execution_fingerprint) AS source_recorded
          FROM forward_purchase_samples s
          JOIN forward_strategy_generations g ON g.generation_id=s.generation_id AND g.activated_at=$3
          JOIN forward_economic_trades t ON t.trade_id=s.trade_id AND t.original_fingerprint=s.execution_fingerprint
          JOIN forward_trade_revisions r ON r.trade_id=s.trade_id AND r.fingerprint=s.execution_fingerprint
          WHERE s.generation_id=$1 AND r.state='original' AND s.created_at<=$2 AND r.recorded_at<=$2
            AND s.occurred_at>=g.activated_at AND s.occurred_at<=$2
            AND s.entity_id=r.entity_id AND s.entity_id=t.entity_id AND s.chain=t.chain
            AND s.token_address=r.token_address AND s.token_address=t.token_address
            AND s.occurred_at=r.occurred_at AND s.occurred_at=t.occurred_at
            AND s.chain IN ('solana','eth','bsc','base')
            AND NOT EXISTS(SELECT 1 FROM forward_trade_revisions pending WHERE pending.trade_id=s.trade_id
              AND pending.state='pending_review' AND pending.recorded_at<=$2)
            AND ($4::bigint IS NULL OR (s.created_at,s.sample_id COLLATE "C")>($4,$5::text COLLATE "C"))
          ORDER BY s.created_at,s.sample_id COLLATE "C" LIMIT $6`,
        [options.generationId, asOf, options.activatedAt, cursor?.createdAt ?? null, cursor?.sampleId ?? null, options.maximumSamples]);
        check(); return result;
      }); check();
      requireBinding(page.rows.length <= options.maximumSamples && Buffer.byteLength(JSON.stringify(page.rows)) <= options.maximumPayloadBytes);
      let previous = cursor;
      // Validate the entire page before invoking any port capable of publication.
      const samples = page.rows.map(row => {
        requireBinding(id(row.sample_id) && id(row.entity_id) && id(row.token_address)
          && row.generation_id === options.generationId && typeof row.execution_fingerprint === "string"
          && /^[a-f0-9]{64}$/.test(row.execution_fingerprint) && row.original_fingerprint === row.execution_fingerprint
          && row.revision_state === "original" && clock(row.activated_at) === options.activatedAt
          && ["solana", "eth", "bsc", "base"].includes(String(row.chain))
          && clock(row.occurred_at) >= options.activatedAt && clock(row.occurred_at) <= asOf
          && clock(row.created_at) <= asOf && clock(row.recorded_at) <= asOf && typeof row.source_recorded === "boolean");
        const next = { createdAt: clock(row.created_at), sampleId: row.sample_id };
        requireBinding(previous === null || after(next, previous)); previous = next;
        return { cursor: next, sampleId: row.sample_id, executionFingerprint: row.execution_fingerprint, recorded: row.source_recorded };
      });
      report.scanned = samples.length;
      for (const sample of samples) {
        check();
        // This is a scheduling tombstone, NOT validation of stale, revoked or metadata-only evidence.
        // Re-attesting an immutable source fact with a new clock/nonce would collide after restart.
        if (sample.recorded) { report.alreadyRecorded++; cursor = sample.cursor; continue; }
        stage = "read"; report.attempted++;
        const loaded = await authority.reader.load({ generationId: options.generationId, sampleId: sample.sampleId,
          executionFingerprint: sample.executionFingerprint, signal: controller.signal }); check();
        if (loaded.status === "deferred") {
          report.deferred++; diagnose(stage, "source_retry_execution_envelope_deferred"); cursor = sample.cursor; continue;
        }
        requireBinding(loaded.status === "ready" && loaded.request.sampleId === sample.sampleId
          && loaded.request.executionFingerprint === sample.executionFingerprint && loaded.request.signal === controller.signal
          && loaded.request.execution.generationId === options.generationId
          && Buffer.byteLength(JSON.stringify(loaded.request)) <= options.maximumPayloadBytes);
        const request = { ...structuredClone({ sampleId: loaded.request.sampleId, executionFingerprint: loaded.request.executionFingerprint,
          execution: loaded.request.execution, validation: loaded.request.validation }), signal: controller.signal };
        requireBinding(time(request.validation.claims.expiresAt));
        if (request.validation.claims.expiresAt <= check()) {
          report.deferred++; diagnose(stage, "source_retry_execution_envelope_expired"); cursor = sample.cursor; continue;
        }
        stage = "receive";
        // Never race a native publication/commit. Keep busy until its actual receipt or failure settles.
        const result = await authority.receiver.receive(request); check();
        if (result.status === "published") report.published++;
        else if (result.status === "duplicate") report.duplicates++;
        else if (result.status === "deferred") { report.deferred++; diagnose(stage, "source_retry_receiver_deferred"); }
        else requireBinding(false);
        cursor = sample.cursor;
      }
      check();
      // Cyclic keyset scans recover late commits and revisit deferred earlier rows. No success cache or durable cursor is invented.
      if (samples.length < options.maximumSamples) cursor = null;
      return finish();
    } catch {
      report.failed++; diagnose(stage, `source_retry_${stage}_failed`);
      return finish(controller.signal.aborted ? "source_retry_aborted_or_timed_out" : `source_retry_${stage}_failed`);
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort(); busy = false; }
  } });
}
