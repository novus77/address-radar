import type { DatabaseSync } from "node:sqlite";

const WINDOW_MS = 30 * 24 * 60 * 60_000;
const tokenKey = `CASE WHEN token_id LIKE 'solana:%' THEN token_id ELSE LOWER(token_id) END`;
const eligible = `status = 'pending' AND reason_code = 'market_range_missing'
  AND purpose IN ('positive_hit', 'complete_range')
  AND typeof(required_from) = 'integer' AND typeof(required_to) = 'integer'
  AND typeof(evaluated_at) = 'integer'
  AND required_from >= 0 AND required_to > required_from
  AND required_to - required_from <= ${WINDOW_MS}
  AND required_to <= evaluated_at AND evaluated_at <= ?
  AND substr(token_id, 1, instr(token_id, ':') - 1)
    IN ('solana', 'eth', 'bsc', 'base', 'robinhood')
  AND length(substr(token_id, instr(token_id, ':') + 1)) > 0`;

export function readConsumerMarketHistoryRange(database: DatabaseSync, tokenId: string, asOf: number) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) return null;
  const normalized = tokenId.startsWith("solana:") ? tokenId : tokenId.toLowerCase();
  const row = database.prepare(`SELECT MIN(required_from) fromAt, MAX(required_to) toAt
    FROM consumer_fact_demands WHERE ${eligible} AND ${tokenKey} = ?`)
    .get(asOf, normalized) as { fromAt: number | null; toAt: number | null };
  if (row.fromAt === null || row.toAt === null) return null;
  return Object.freeze({ fromAt: row.fromAt, toAt: row.toAt });
}

export function listUnscheduledConsumerHistoryTokens(database: DatabaseSync, asOf: number, limit: number) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error("Invalid consumer recovery batch limit");
  return database.prepare(`WITH needs AS (
    SELECT ${tokenKey} tokenId, MIN(evaluated_at) oldestEvaluation
    FROM consumer_fact_demands WHERE ${eligible} GROUP BY ${tokenKey}
  ) SELECT tokenId FROM needs
    WHERE NOT EXISTS (SELECT 1 FROM recovery_jobs job
      WHERE job.job_id = 'recovery:' ||
        CASE WHEN needs.tokenId LIKE 'robinhood:%' THEN 'fomo_token_history' ELSE 'market_history' END
        || ':' || needs.tokenId)
    ORDER BY oldestEvaluation, tokenId LIMIT ?`).all(asOf, limit) as Array<{ tokenId: string }>;
}

export function listConsumerHistoryWakeupNeeds(database: DatabaseSync, asOf: number, limit: number) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error("Invalid consumer wakeup batch limit");
  return database.prepare(`WITH needs AS (
    SELECT consumer_id consumerId, ${tokenKey} tokenId, MIN(required_from) fromAt, MAX(required_to) toAt
    FROM consumer_fact_demands WHERE ${eligible} GROUP BY consumer_id,${tokenKey}
  ) SELECT needs.*,receipt.dispatched_fingerprint dispatchedFingerprint
    FROM needs LEFT JOIN consumer_history_wakeup_receipts receipt
      ON receipt.consumer_id=needs.consumerId AND receipt.token_id=needs.tokenId
    ORDER BY COALESCE(receipt.checked_at,-1),needs.consumerId,needs.tokenId LIMIT ?`)
    .all(asOf,limit) as Array<{ consumerId: string; tokenId: string; fromAt: number; toAt: number; dispatchedFingerprint: string | null }>;
}

export function listConsumerHistoryRangeRechecks(database: DatabaseSync, asOf: number, limit: number) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error("Invalid consumer range batch limit");
  return database.prepare(`WITH needs AS (
    SELECT ${tokenKey} tokenId,MIN(required_from) fromAt,MAX(required_to) toAt
    FROM consumer_fact_demands WHERE ${eligible} GROUP BY ${tokenKey}
  ) SELECT needs.*,job.job_id jobId,job.status,job.updated_at updatedAt FROM needs
    JOIN recovery_jobs job ON job.job_id='recovery:'||
      CASE WHEN needs.tokenId LIKE 'robinhood:%' THEN 'fomo_token_history' ELSE 'market_history' END||':'||needs.tokenId
    LEFT JOIN consumer_history_recovery_requests receipt ON receipt.job_id=job.job_id
    WHERE (job.status='completed' OR job.status='dead_letter' AND job.last_error='historical_market_range_unavailable')
      AND (receipt.next_check_at IS NULL OR receipt.next_check_at<=?)
    ORDER BY COALESCE(receipt.checked_at,-1),job.updated_at,needs.tokenId LIMIT ?`)
    .all(asOf,asOf,limit) as Array<{ tokenId: string; fromAt: number; toAt: number; jobId: string; status: string; updatedAt: number }>;
}
