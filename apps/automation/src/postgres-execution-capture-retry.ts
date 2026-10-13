import { performance } from "node:perf_hooks";
import type { PostgresTransaction } from "../../../packages/database/src/postgres-unit-of-work.js";
import { preparePostgresWalletCapture, type CapturedPostgresWalletEvent } from "../../wallet-monitor/src/postgres-wallet-channel.js";
import type { createPostgresWalletExecutionReceiver } from "./postgres-wallet-execution-receiver.js";
import { POSTGRES_EXECUTION_ACQUISITION_TRANSPORT_REASONS } from "./postgres-wallet-rpc-producer.js";

export interface PostgresExecutionCaptureRetryOptions {
  readonly generationId: string; readonly activatedAt: number;
  readonly maximumCaptures: number; readonly maximumPayloadBytes: number; readonly maximumRunMs: number; readonly lookaheadMs: number;
  readonly maximumFactAgeMs: number; readonly maximumFactPayloadBytes: number;
  readonly now: () => number;
  readonly run: <T>(operation: (transaction: PostgresTransaction) => Promise<T>) => Promise<T>;
  /** The already approved receiver and its native publisher own RPC leases and commit acknowledgement. */
  readonly receiver?: Pick<ReturnType<typeof createPostgresWalletExecutionReceiver>, "receive"> | undefined;
}
export interface PostgresExecutionCaptureRetryReport {
  readonly status: "polled" | "deferred"; readonly reasonCode?: string;
  readonly scanned: number; readonly attempted: number; readonly published: number; readonly deferred: number;
  readonly alreadyAvailable: number; readonly failed: number; readonly diagnostics: readonly string[]; readonly diagnosticsDropped: number;
}
const PAGE_CONTAINER_BYTES = 2;
const clock = (value: unknown): number => {
  const result = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) throw new Error("Invalid execution retry clock");
  return result;
};
function requireBound(value: unknown): asserts value { if (!value) throw new Error("Execution retry binding unavailable"); }
const diagnosticReasons = new Set([...POSTGRES_EXECUTION_ACQUISITION_TRANSPORT_REASONS,
  "execution_not_finalized", "actual_trade_basis_unavailable", "current_wallet_owner_unavailable", "profile_cohort_unavailable",
  "profile_changed_during_acquisition", "producer_aborted_or_timed_out", "receiver_aborted_or_timed_out",
  "validator_aborted_or_timed_out", "validator_replay_unavailable", "validator_independent_replay_mismatch",
  "execution_validation_or_publication_unavailable", "independent_validator_or_publisher_unavailable"]);
/** Cursor positions are scheduling only. Persisted facts, never a local success cache, acknowledge publication after restart. */
export function createPostgresExecutionCaptureRetry(input: PostgresExecutionCaptureRetryOptions) {
  const options = { ...input };
  requireBound(typeof options.generationId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(options.generationId));
  clock(options.activatedAt);
  for (const [value,max] of [[options.maximumCaptures,1000],[options.maximumPayloadBytes,2_097_152],
    [options.maximumRunMs,60_000],[options.lookaheadMs,60_000],[options.maximumFactAgeMs,2_147_483_647],
    [options.maximumFactPayloadBytes,2_097_152]]) requireBound(clock(value) > 0 && value! <= max!);
  type Position = { at: number; job: string };
  const compare = (a: Position,b: Position) => a.at - b.at || Buffer.compare(Buffer.from(a.job),Buffer.from(b.job));
  let cursor: Position | null = null, cycleTail: Position | null = null, busy = false, lastAt = options.activatedAt;
  return Object.freeze({ async pollOnce(signal: AbortSignal): Promise<PostgresExecutionCaptureRetryReport> {
    const report = { status: "polled" as "polled" | "deferred", scanned: 0, attempted: 0, published: 0,
      deferred: 0, alreadyAvailable: 0, failed: 0, diagnostics: [] as string[], diagnosticsDropped: 0 };
    const diagnose = (reason: string) => { if (report.diagnostics.length < 32) report.diagnostics.push(reason); else report.diagnosticsDropped++; };
    const finish = (reasonCode?: string): PostgresExecutionCaptureRetryReport => ({ ...report,
      ...(reasonCode ? { status: "deferred" as const,reasonCode } : {}),diagnostics: [...report.diagnostics] });
    const receiver = options.receiver;
    if (!receiver) return finish("execution_retry_authority_unavailable");
    if (busy) return finish("execution_retry_busy");
    if (signal.aborted) return finish("execution_retry_aborted_or_timed_out");
    busy = true;
    const controller = new AbortController(), abort = () => controller.abort(), monotonicStart = performance.now();
    signal.addEventListener("abort",abort,{ once: true }); if (signal.aborted) abort();
    const timer = setTimeout(abort,options.maximumRunMs);
    let start: number | undefined, scanPending: Promise<unknown> | undefined;
    let scanSettled = true;
    const check = () => {
      controller.signal.throwIfAborted(); const at = clock(options.now()); start ??= at;
      requireBound(at >= lastAt && at - start < options.maximumRunMs && performance.now() - monotonicStart < options.maximumRunMs
        && Number.isSafeInteger(at + options.lookaheadMs + options.maximumRunMs));
      lastAt = at; return at;
    };
    try {
      const asOf = check();
      const scan = options.run(async tx => {
        const at = check();
        const remaining = Math.floor(Math.min(options.maximumRunMs - (at - asOf),
          options.maximumRunMs - (performance.now() - monotonicStart)));
        requireBound(remaining > 0);
        await tx.query(`/* execution-retry-scan-timeout */ SELECT set_config('statement_timeout',
          least($1::numeric,CASE WHEN current_setting('statement_timeout')::interval=interval '0'
            THEN $1::numeric ELSE extract(epoch FROM current_setting('statement_timeout')::interval)*1000 END)::bigint::text,true)`,[remaining]);
        check();
        const result = await tx.query(`/* execution-retry-committed-captures */ WITH eligible AS NOT MATERIALIZED (
          SELECT n.job_id,g.generation_id,n.committed_at,octet_length(n.normalized_payload) payload_bytes,
            CASE WHEN octet_length(n.normalized_payload)<=($4-${PAGE_CONTAINER_BYTES}) THEN n.normalized_payload ELSE NULL END normalized_payload,
            wanted.next_attempt_at
          FROM capture_normalized_results n JOIN capture_normalization_jobs j ON j.job_id=n.job_id
          JOIN wallet_capture_generation_bindings g ON g.source_namespace=j.source_namespace
            AND g.source_event_id=j.source_event_id AND g.semantic_fingerprint=j.semantic_fingerprint
          JOIN forward_strategy_generations sg ON sg.generation_id=g.generation_id AND sg.activated_at=$11
          JOIN LATERAL (SELECT min(c.next_attempt_at) next_attempt_at FROM capture_consumer_intents i
            JOIN capture_consumer_jobs c ON c.intent_id=i.intent_id
            WHERE i.job_id=n.job_id AND c.consumer_name='forward_purchase_match' AND c.status='pending'
              AND c.next_attempt_at<=$2::bigint+$3::bigint) wanted ON wanted.next_attempt_at IS NOT NULL
          WHERE g.generation_id=$1 AND n.event_kind='buy' AND n.requires_review=false AND j.status='completed'
            AND n.committed_at<=$2 AND g.created_at<=$2
            AND NOT EXISTS(SELECT 1 FROM wallet_capture_generation_bindings changed
              WHERE changed.generation_id=g.generation_id AND changed.source_namespace=g.source_namespace
                AND changed.source_event_id=g.source_event_id AND changed.semantic_fingerprint<>g.semantic_fingerprint
                AND changed.created_at<=$2)
        ), tail AS MATERIALIZED (
          SELECT committed_at,job_id FROM eligible WHERE $12::bigint IS NULL
          ORDER BY committed_at DESC,job_id COLLATE "C" DESC LIMIT 1
        ), horizon AS MATERIALIZED (
          SELECT $12::bigint cycle_tail_at,$13::text cycle_tail_job WHERE $12::bigint IS NOT NULL
          UNION ALL SELECT committed_at,job_id FROM tail
        ), bounded AS MATERIALIZED (
          SELECT e.*,h.cycle_tail_at,h.cycle_tail_job FROM eligible e CROSS JOIN horizon h
          WHERE ($5::bigint IS NULL OR (e.committed_at,e.job_id COLLATE "C")>($5,$6::text COLLATE "C"))
            AND (e.committed_at,e.job_id COLLATE "C")<=(h.cycle_tail_at,h.cycle_tail_job COLLATE "C")
          ORDER BY e.committed_at,e.job_id COLLATE "C" LIMIT $7
        ), sized AS MATERIALIZED (
          SELECT b.*,octet_length(row_to_json(b)::text)+512 item_bytes,
            octet_length((to_jsonb(b)||jsonb_build_object('normalized_payload',NULL))::text)+512 metadata_bytes
          FROM bounded b
        ), measured AS MATERIALIZED (
          SELECT b.*,CASE WHEN b.item_bytes<=($4-${PAGE_CONTAINER_BYTES}) THEN b.normalized_payload::jsonb ELSE NULL END p,
            sum(CASE WHEN b.item_bytes<=($4-${PAGE_CONTAINER_BYTES}) THEN b.item_bytes ELSE b.metadata_bytes END)
              OVER (ORDER BY b.committed_at,b.job_id COLLATE "C" ROWS UNBOUNDED PRECEDING)+${PAGE_CONTAINER_BYTES} result_bytes FROM sized b
        ) SELECT m.job_id,m.generation_id,m.committed_at,m.payload_bytes,m.item_bytes,m.result_bytes,
          m.cycle_tail_at,m.cycle_tail_job,
          CASE WHEN m.item_bytes<=($4-${PAGE_CONTAINER_BYTES}) THEN m.normalized_payload ELSE NULL END normalized_payload,
          proof.live_count>0 proof_live,proof.live_count>1 proof_conflict,
          proof.live_count=1 AND proof.usable proof_available
          FROM measured m LEFT JOIN LATERAL (
            SELECT count(*) live_count,coalesce(bool_and(
              f.observed_at<=f.known_at AND f.known_at<=f.checked_at AND $2::bigint-f.known_at<=$9::bigint /* maximum_fact_age */
              AND f.payload_bytes<=$10 AND f.fingerprint=encode(sha256(convert_to(f.payload,'UTF8')),'hex')
              AND f.expires_at>greatest($2::bigint,m.next_attempt_at)+$8::bigint AND f.validator_until>greatest($2::bigint,m.next_attempt_at)+$8::bigint
              AND f.value->>'canonical'='confirmed_execution'
              AND f.value->>'sourceReference'=m.p->'event'->>'sourceReference'
              AND f.value->'purchase'->>'chain'=m.p->'event'->>'chain'
              AND f.value->'purchase'->>'tokenAddress'=m.p->'event'->>'tokenAddress'
              AND f.value->'purchase'->>'occurredAt'=m.p->'event'->>'occurredAt'
              AND f.value->'purchase'->>'entityId'=m.p->'profile'->'wallet'->>'entityId'
              AND f.value->'purchase'->>'sourceUserId'=m.p->'profile'->'wallet'->>'accountId'
              AND f.value->'purchase'->>'ownershipEvidenceRef'=m.p->'profile'->'fact'->>'ownershipEvidenceRef'
              AND f.value->'purchase'->>'executionEvidenceRef'=f.validation_ref),false) usable
            FROM (SELECT DISTINCT ON(f.fact_id) f.fact_id,f.fingerprint,f.payload,f.observed_at,f.known_at,
              a.checked_at,a.expires_at,a.validation_ref,v.valid_until validator_until,octet_length(f.payload) payload_bytes,
              CASE WHEN octet_length(f.payload)<=$10 THEN f.payload::jsonb ELSE NULL END value
              FROM wallet_service_fact_inputs f
              JOIN wallet_service_fact_attestations a ON a.generation_id=f.generation_id AND a.fact_id=f.fact_id
                AND a.kind=f.kind AND a.fingerprint=f.fingerprint
              JOIN wallet_service_fact_validators v ON v.generation_id=a.generation_id AND v.validator_id=a.validator_id AND v.kind=a.kind
              JOIN wallet_service_import_ledger l ON l.generation_id=v.generation_id AND l.import_id=v.import_id
              WHERE f.generation_id=$1 AND f.kind='execution' AND f.known_at<=$2 AND a.checked_at<=$2 AND a.expires_at>$2
                AND v.valid_from<=a.checked_at AND v.valid_until>$2
                AND (v.revoked_at IS NULL OR v.revoked_at>$2) AND (l.revoked_at IS NULL OR l.revoked_at>$2)
                AND l.proof_scope='validator_authority' AND l.imported_at<=a.checked_at AND v.validator_id<>f.provider_id
                AND f.subject_key=encode(sha256(convert_to('['||to_json(m.p->'event'->>'chain')::text||','||
                  to_json(m.p->'event'->>'walletAddress')::text||','||to_json(m.p->'event'->>'sourceReference')::text||','||
                  to_json(m.p->'event'->>'tokenAddress')::text||']','UTF8')),'hex')
              ORDER BY f.fact_id,a.checked_at DESC,a.validator_id LIMIT 2) f
          ) proof ON true WHERE m.result_bytes<=$4 ORDER BY m.committed_at,m.job_id COLLATE "C"`,
        [options.generationId,asOf,options.lookaheadMs,options.maximumPayloadBytes,cursor?.at ?? null,cursor?.job ?? null,
          options.maximumCaptures,options.maximumRunMs,options.maximumFactAgeMs,options.maximumFactPayloadBytes,options.activatedAt,
          cycleTail?.at ?? null,cycleTail?.job ?? null]);
        check(); return result;
      });
      scanSettled = false; scanPending = scan;
      void scan.then(() => { scanSettled = true; },() => { scanSettled = true; });
      let onScanAbort!: () => void;
      const cancelled = new Promise<never>((_,reject) => {
        onScanAbort = () => reject(new Error("Execution retry scan deadline"));
        controller.signal.addEventListener("abort",onScanAbort,{ once: true });
        if (controller.signal.aborted) onScanAbort();
      });
      const page = await Promise.race([scan,cancelled]).finally(() => controller.signal.removeEventListener("abort",onScanAbort));
      check();
      requireBound(page.rows.length <= options.maximumCaptures && Buffer.byteLength(JSON.stringify(page.rows)) <= options.maximumPayloadBytes);
      let prior = cursor;
      const jobs = new Set<string>();
      const captures = [];
      for (const row of page.rows) {
        requireBound(row.generation_id === options.generationId && typeof row.job_id === "string" && row.job_id.length > 0
          && row.job_id.length <= 512 && !jobs.has(row.job_id)
          && typeof row.proof_available === "boolean");
        jobs.add(row.job_id);
        // An otherwise legal row outside the cumulative prefix remains pending for the next page.
        if (row.result_bytes !== undefined && clock(row.result_bytes) > options.maximumPayloadBytes) break;
        const at = clock(row.committed_at), job = row.job_id;
        requireBound(at <= asOf && (prior === null || at > prior.at || at === prior.at && Buffer.compare(Buffer.from(job),Buffer.from(prior.job)) > 0));
        prior = { at,job };
        if (row.cycle_tail_at !== undefined || row.cycle_tail_job !== undefined) {
          const tailAt = clock(row.cycle_tail_at);
          requireBound(tailAt <= asOf && typeof row.cycle_tail_job === "string" && row.cycle_tail_job.length > 0 && row.cycle_tail_job.length <= 512);
          const tail = { at: tailAt,job: row.cycle_tail_job };
          requireBound(compare(prior,tail) <= 0 && (cycleTail === null || compare(cycleTail,tail) === 0));
          cycleTail ??= tail;
        }
        const oversized = row.payload_bytes !== undefined && clock(row.payload_bytes) > options.maximumPayloadBytes - PAGE_CONTAINER_BYTES
          || row.item_bytes !== undefined && clock(row.item_bytes) > options.maximumPayloadBytes - PAGE_CONTAINER_BYTES;
        if (oversized) {
          requireBound(row.normalized_payload === null);
          captures.push({ cursor: prior,payload: null,available: false,live: false,conflict: false }); continue;
        }
        requireBound(typeof row.normalized_payload === "string");
        const payload = JSON.parse(row.normalized_payload) as CapturedPostgresWalletEvent;
        requireBound(payload.schemaVersion === "wallet-chain-v1" && payload.generationId === options.generationId
          && payload.profile && payload.event.side === "buy" && ["solana","eth","bsc","base"].includes(payload.event.chain)
          && payload.chainFamily === (payload.event.chain === "solana" ? "solana" : "evm")
          && clock(payload.event.occurredAt) >= options.activatedAt && clock(payload.event.occurredAt) <= asOf);
        // Old verification outputs are never treated as new acquisition inputs or signing authority.
        captures.push({ cursor: { at,job },payload: { ...payload,purchase: null,externalBasis: null,entryPriceBasis: null },
          available: row.proof_available,live: row.proof_live === true,conflict: row.proof_conflict === true });
      }
      report.scanned = captures.length;
      const attempted = new Set<string>();
      for (const capture of captures) {
        check();
        if (capture.payload === null) {
          report.deferred++; diagnose("execution_retry_capture_payload_exceeded"); cursor = capture.cursor; continue;
        }
        if (capture.available) { report.alreadyAvailable++; cursor = capture.cursor; continue; }
        const event = capture.payload.event;
        const key = JSON.stringify([event.chain,event.walletAddress,event.sourceReference,event.tokenAddress]);
        if (capture.live || capture.conflict || attempted.has(key)) {
          report.deferred++; diagnose(capture.conflict ? "execution_retry_live_proof_conflict" : "execution_retry_live_or_duplicate_capture");
          cursor = capture.cursor; continue;
        }
        attempted.add(key); report.attempted++;
        try {
          // Never race native commit. A cancelled call keeps busy until the actual receiver settles.
          const result = await receiver.receive({ payloads: [capture.payload],signal: controller.signal });
          const ack = result.results[0];
          requireBound(result.processed === 1 && result.results.length === 1 && Number.isInteger(result.published)
            && Number.isInteger(result.deferred) && result.published >= 0 && result.deferred >= 0 && result.published + result.deferred === 1);
          if (result.published === 1) {
            requireBound(ack?.status === "verified" && ack.externalBasis && ack.externalBasis.generationId === options.generationId);
            const receivedAt = clock(options.now()); requireBound(receivedAt >= lastAt && ack.externalBasis.verifiedAt <= receivedAt);
            preparePostgresWalletCapture({ ...capture.payload,sessionId: "execution-retry-ack",receivedAt,
              executionTrust: "unverified",verifiedPurchase: ack.purchase,externalBasis: ack.externalBasis });
            report.published++;
          } else {
            requireBound(ack?.status === "deferred"); report.deferred++;
            diagnose(diagnosticReasons.has(ack.reasonCode) ? ack.reasonCode : "execution_retry_receiver_deferred");
          }
        } catch { report.failed++; diagnose("execution_retry_receiver_failed"); }
        // A settled failure advances scheduling, not business success. Restart still consults durable facts.
        cursor = capture.cursor; check();
      }
      // A fixed tail, not a moving stream head or a byte-short prefix, ends this scheduling cycle.
      if (page.rows.length === 0 || cursor !== null && cycleTail !== null && compare(cursor,cycleTail) >= 0) {
        cursor = null; cycleTail = null;
      }
      return finish();
    } catch {
      return finish(controller.signal.aborted ? "execution_retry_aborted_or_timed_out" : "execution_retry_scan_or_binding_unavailable");
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort",abort); controller.abort();
      // A timed-out scan may still own its native SQL transaction/connection. Drain before reentry.
      if (scanPending && !scanSettled) void scanPending.then(() => { busy = false; },() => { busy = false; });
      else busy = false;
    }
  } });
}
