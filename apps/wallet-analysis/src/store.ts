import {
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
  withAddressRadarWriteTransaction,
} from "@address-radar/database";
import type { ChainFamily, WalletAnalysisMetrics, WalletAnalysisPhase, WalletAnalysisPosition } from "@address-radar/domain";

export interface WalletAnalysisJob {
  readonly analysisId: string;
  readonly chainFamily: ChainFamily;
  readonly address: string;
  readonly requestedSamples: number;
  readonly from: number;
  readonly to: number;
  readonly maxTokens: number;
  readonly status: "collecting" | "review_required" | "insufficient_data" | "accepted" | "rejected" | "failed";
  readonly checkpoint: string | null;
  readonly metrics: WalletAnalysisMetrics | null;
  readonly lastError: string | null;
  readonly provenance: readonly string[];
  readonly phase: WalletAnalysisPhase;
  readonly processedTransactions: number;
  readonly discoveredTokens: number;
  readonly progressPercent: number;
  readonly heartbeatAt: number;
  readonly nextRetryAt: number | null;
}

export interface WalletAnalysisStore {
  enqueue(input: { readonly analysisId: string; readonly chainFamily: ChainFamily; readonly address: string; readonly requestedSamples: number; readonly createdAt: number }): void;
  next(now?: number): WalletAnalysisJob | null;
  job(analysisId: string): WalletAnalysisJob | null;
  positions(analysisId: string): readonly WalletAnalysisPosition[];
  savePage(analysisId: string, positions: readonly WalletAnalysisPosition[], nextCursor: string | null, provenance: string, updatedAt: number): number;
  complete(analysisId: string, metrics: WalletAnalysisMetrics, updatedAt: number): WalletAnalysisJob["status"];
  review(analysisId: string, status: "accepted" | "rejected", reviewedAt: number): void;
  fail(analysisId: string, error: string, updatedAt: number): void;
  heartbeat(analysisId: string, phase: WalletAnalysisPhase, updatedAt: number): void;
  blockStale(now: number, timeoutMs: number): number;
  retry(analysisId: string, updatedAt: number): void;
  close(): void;
}

export function openWalletAnalysisStore(databasePath: string): WalletAnalysisStore {
  const database = openAddressRadarDatabase(databasePath);
  migrateAddressRadarDatabase(database);
  const transaction = <T>(operation: () => T): T =>
    withAddressRadarWriteTransaction(database, operation);

  transaction(() => database.exec(`
    INSERT OR IGNORE INTO wallet_analysis_job_bounds(analysis_id, from_at, to_at, max_tokens)
    SELECT analysis_id,
      created_at - 60 * 24 * 60 * 60 * 1000,
      created_at,
      CASE
        WHEN requested_sample_count < 1 THEN 1
        WHEN requested_sample_count > 300 THEN 300
        ELSE requested_sample_count
      END
    FROM wallet_analysis_jobs;
  `));

  const savePage = (analysisId: string, positions: readonly WalletAnalysisPosition[], nextCursor: string | null, provenance: string, updatedAt: number): number => transaction(() => {
    const capacity = database.prepare(`
      SELECT MIN(j.requested_sample_count, b.max_tokens) AS maximum,
        (SELECT COUNT(*) FROM wallet_analysis_positions p WHERE p.analysis_id = j.analysis_id) AS existing
      FROM wallet_analysis_jobs j JOIN wallet_analysis_job_bounds b ON b.analysis_id = j.analysis_id
      WHERE j.analysis_id = ?
    `).get(analysisId) as { maximum: number; existing: number } | undefined;
    if (!capacity) throw new Error(`Wallet analysis not found: ${analysisId}`);
    const insert = database.prepare("INSERT OR IGNORE INTO wallet_analysis_positions(analysis_id, token_id, payload, entered_at) VALUES (?, ?, ?, ?)");
    let saved = 0;
    for (const position of positions) {
      if (capacity.existing + saved >= capacity.maximum) break;
      saved += Number(insert.run(analysisId, position.tokenId, JSON.stringify(position), position.enteredAt).changes);
    }
    if (nextCursor === null) database.prepare("DELETE FROM wallet_analysis_checkpoints WHERE analysis_id = ? AND scope = 'history'").run(analysisId);
    else database.prepare(`
      INSERT INTO wallet_analysis_checkpoints(analysis_id, scope, cursor, updated_at) VALUES (?, 'history', ?, ?)
      ON CONFLICT(analysis_id, scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(analysisId, nextCursor, updatedAt);
    database.prepare("INSERT OR IGNORE INTO wallet_analysis_provenance(analysis_id, source, observed_at) VALUES (?, ?, ?)").run(analysisId, provenance, updatedAt);
    database.prepare("UPDATE wallet_analysis_jobs SET last_error = NULL, updated_at = ? WHERE analysis_id = ?").run(updatedAt, analysisId);
    const count = database.prepare("SELECT COUNT(*) AS count FROM wallet_analysis_positions WHERE analysis_id = ?").get(analysisId) as { count: number };
    database.prepare(`
      UPDATE wallet_analysis_progress SET phase = 'collecting', discovered_tokens = ?,
        progress_percent = MIN(99, ? * 100.0 / MAX(1, (SELECT requested_sample_count FROM wallet_analysis_jobs WHERE analysis_id = ?))),
        heartbeat_at = ?, next_retry_at = NULL, updated_at = ? WHERE analysis_id = ?
    `).run(count.count, count.count, analysisId, updatedAt, updatedAt, analysisId);
    return saved;
  });

  const readJob = (analysisId?: string, now = Date.now()): WalletAnalysisJob | null => {
    const sql = analysisId
      ? "SELECT * FROM wallet_analysis_jobs WHERE analysis_id = ?"
      : `SELECT j.* FROM wallet_analysis_jobs j
         LEFT JOIN wallet_analysis_progress p ON p.analysis_id = j.analysis_id
         WHERE j.status = 'collecting'
           AND COALESCE(p.phase, 'queued') NOT IN ('blocked', 'cancelled')
           AND (p.next_retry_at IS NULL OR p.next_retry_at <= ?)
         ORDER BY j.updated_at, j.created_at, j.analysis_id LIMIT 1`;
    const row = (analysisId ? database.prepare(sql).get(analysisId) : database.prepare(sql).get(now)) as Record<string, unknown> | undefined;
    if (!row) return null;
    const checkpoint = database.prepare("SELECT cursor FROM wallet_analysis_checkpoints WHERE analysis_id = ? AND scope = 'history'").get(row.analysis_id as string) as { cursor: string } | undefined;
    const sources = database.prepare("SELECT source FROM wallet_analysis_provenance WHERE analysis_id = ? ORDER BY source").all(row.analysis_id as string) as { source: string }[];
    const bounds = database.prepare("SELECT from_at AS fromAt, to_at AS toAt, max_tokens AS maxTokens FROM wallet_analysis_job_bounds WHERE analysis_id = ?").get(row.analysis_id as string) as { fromAt: number; toAt: number; maxTokens: number } | undefined;
    const progress = database.prepare(`
      SELECT phase, processed_transactions AS processedTransactions, discovered_tokens AS discoveredTokens,
        progress_percent AS progressPercent, heartbeat_at AS heartbeatAt, next_retry_at AS nextRetryAt
      FROM wallet_analysis_progress WHERE analysis_id = ?
    `).get(row.analysis_id as string) as { phase: WalletAnalysisPhase; processedTransactions: number; discoveredTokens: number; progressPercent: number; heartbeatAt: number; nextRetryAt: number | null } | undefined;
    if (!bounds) throw new Error(`Wallet analysis bounds are missing: ${String(row.analysis_id)}`);
    return Object.freeze({
      analysisId: row.analysis_id as string,
      chainFamily: row.chain_family as ChainFamily,
      address: row.address as string,
      requestedSamples: row.requested_sample_count as number,
      from: bounds.fromAt,
      to: bounds.toAt,
      maxTokens: bounds.maxTokens,
      status: row.status as WalletAnalysisJob["status"],
      checkpoint: checkpoint?.cursor ?? null,
      metrics: row.metrics ? Object.freeze(JSON.parse(row.metrics as string) as WalletAnalysisMetrics) : null,
      lastError: row.last_error as string | null,
      provenance: Object.freeze(sources.map(item => item.source)),
      phase: progress?.phase ?? "collecting",
      processedTransactions: progress?.processedTransactions ?? 0,
      discoveredTokens: progress?.discoveredTokens ?? 0,
      progressPercent: progress?.progressPercent ?? 0,
      heartbeatAt: progress?.heartbeatAt ?? Number(row.updated_at),
      nextRetryAt: progress?.nextRetryAt ?? null,
    });
  };

  const store: WalletAnalysisStore = {
    enqueue(input) {
      const requestedSamples = Math.max(1, Math.min(300, Math.trunc(input.requestedSamples)));
      transaction(() => {
        database.prepare(`
          INSERT OR IGNORE INTO wallet_analysis_jobs(
            analysis_id, chain_family, address, status, requested_sample_count,
            valid_sample_count, coverage_rate, created_at, updated_at
          ) VALUES (?, ?, ?, 'collecting', ?, 0, 0, ?, ?)
        `).run(input.analysisId, input.chainFamily, input.address, requestedSamples, input.createdAt, input.createdAt);
        database.prepare("INSERT OR IGNORE INTO wallet_analysis_job_bounds(analysis_id, from_at, to_at, max_tokens) VALUES (?, ?, ?, 300)").run(input.analysisId, input.createdAt - 60 * 24 * 60 * 60_000, input.createdAt);
        database.prepare(`
          INSERT OR IGNORE INTO wallet_analysis_progress(analysis_id, phase, processed_transactions, discovered_tokens, progress_percent, heartbeat_at, next_retry_at, updated_at)
          VALUES (?, 'queued', 0, 0, 0, ?, NULL, ?)
        `).run(input.analysisId, input.createdAt, input.createdAt);
      });
    },
    next(now) { return readJob(undefined, now); },
    job(analysisId) { return readJob(analysisId); },
    positions(analysisId) {
      const rows = database.prepare("SELECT payload FROM wallet_analysis_positions WHERE analysis_id = ? ORDER BY entered_at, token_id").all(analysisId) as { payload: string }[];
      return Object.freeze(rows.map(row => Object.freeze(JSON.parse(row.payload) as WalletAnalysisPosition)));
    },
    savePage,
    complete(analysisId, metrics, updatedAt) {
      const status = metrics.validSamples > 0 ? "review_required" : "insufficient_data";
      transaction(() => {
        database.prepare(`
          UPDATE wallet_analysis_jobs SET status = ?, valid_sample_count = ?, coverage_rate = ?, metrics = ?,
            last_error = NULL, updated_at = ? WHERE analysis_id = ?
        `).run(status, metrics.validSamples, metrics.coverageRate, JSON.stringify(metrics), updatedAt, analysisId);
        database.prepare("DELETE FROM wallet_analysis_checkpoints WHERE analysis_id = ?").run(analysisId);
        database.prepare("UPDATE wallet_analysis_progress SET phase = 'completed', discovered_tokens = ?, progress_percent = 100, heartbeat_at = ?, next_retry_at = NULL, updated_at = ? WHERE analysis_id = ?")
          .run(metrics.validSamples, updatedAt, updatedAt, analysisId);
      });
      return status;
    },
    review(analysisId, status, reviewedAt) {
      transaction(() => {
        const changed = database.prepare("UPDATE wallet_analysis_jobs SET status = ?, reviewed_at = ?, updated_at = ? WHERE analysis_id = ? AND status = 'review_required'").run(status, reviewedAt, reviewedAt, analysisId).changes;
        if (Number(changed) !== 1) throw new Error("Wallet analysis is not pending review");
      });
    },
    fail(analysisId, error, updatedAt) {
      transaction(() => {
        database.prepare("UPDATE wallet_analysis_jobs SET last_error = ?, updated_at = ? WHERE analysis_id = ?").run(error, updatedAt, analysisId);
        database.prepare("UPDATE wallet_analysis_progress SET phase = 'retrying', heartbeat_at = ?, next_retry_at = ?, updated_at = ? WHERE analysis_id = ?")
          .run(updatedAt, updatedAt + 60_000, updatedAt, analysisId);
      });
    },
    heartbeat(analysisId, phase, updatedAt) {
      transaction(() => {
        database.prepare("UPDATE wallet_analysis_progress SET phase = ?, heartbeat_at = ?, updated_at = ? WHERE analysis_id = ?")
          .run(phase, updatedAt, updatedAt, analysisId);
      });
    },
    blockStale(now, timeoutMs) {
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid stale-job boundary");
      return transaction(() => Number(database.prepare(`
          UPDATE wallet_analysis_progress SET phase = 'blocked', updated_at = ?
          WHERE phase IN ('queued', 'collecting', 'normalizing', 'pricing', 'evaluating', 'retrying') AND heartbeat_at < ?
        `).run(now, now - timeoutMs).changes));
    },
    retry(analysisId, updatedAt) {
      transaction(() => {
        const changed = database.prepare(`
          UPDATE wallet_analysis_progress SET phase = 'queued', heartbeat_at = ?, next_retry_at = NULL, updated_at = ?
          WHERE analysis_id = ? AND phase IN ('blocked', 'retrying', 'failed', 'partial')
        `).run(updatedAt, updatedAt, analysisId).changes;
        if (Number(changed) !== 1) throw new Error("Wallet analysis is not retryable");
        database.prepare("UPDATE wallet_analysis_jobs SET last_error = NULL, updated_at = ? WHERE analysis_id = ?").run(updatedAt, analysisId);
      });
    },
    close() { database.close(); },
  };
  return Object.freeze(store);
}
