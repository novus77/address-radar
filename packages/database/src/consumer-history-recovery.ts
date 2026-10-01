import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "./connection.js";
import { hasConsumerHistoryRequestCoverage } from "./consumer-history-range-store.js";

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

function recoveryJobId(tokenId: string): string {
  return 'recovery:' + (tokenId.startsWith('robinhood:') ? 'fomo_token_history' : 'market_history') + ':' + tokenId;
}

function selectConsumerMarketHistoryRange(database: DatabaseSync, tokenId: string, asOf: number, includeCovered = false) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) return null;
  const normalized = tokenId.startsWith("solana:") ? tokenId : tokenId.toLowerCase();
  const rows = database.prepare(`SELECT required_from fromAt, required_to toAt, MIN(evaluated_at) oldestEvaluation
    FROM consumer_fact_demands WHERE ${eligible} AND ${tokenKey} = ?
    GROUP BY required_from,required_to ORDER BY oldestEvaluation,required_from,required_to`)
    .all(asOf, normalized) as Array<{ fromAt: number; toAt: number }>;
  const attempted = database.prepare(`SELECT 1 FROM consumer_history_recovery_audits
    WHERE job_id=? AND requested_from<=? AND requested_to>=?
      AND requested_to-requested_from<=? LIMIT 1`);
  let coveredFallback: { fromAt: number; toAt: number } | null = null;
  for (const row of rows) {
    if (attempted.get(recoveryJobId(normalized),row.fromAt,row.toAt,WINDOW_MS)) continue;
    const range = Object.freeze({ fromAt: row.fromAt, toAt: row.toAt });
    if (!hasConsumerHistoryRequestCoverage(database,normalized,row.fromAt,row.toAt)) return range;
    coveredFallback ??= range;
  }
  return includeCovered ? coveredFallback : null;
}

export function readConsumerMarketHistoryRange(database: DatabaseSync, tokenId: string, asOf: number) {
  return selectConsumerMarketHistoryRange(database,tokenId,asOf);
}

export function resolveConsumerMarketHistoryRequestRange(database: DatabaseSync, tokenId: string, asOf: number) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) return null;
  const normalized = tokenId.startsWith("solana:") ? tokenId : tokenId.toLowerCase();
  const jobId = recoveryJobId(normalized);
  return withAddressRadarWriteTransaction(database, () => {
    const job = database.prepare(`SELECT status,last_error lastError,updated_at updatedAt FROM recovery_jobs
      WHERE job_id=? AND subject_key=? AND job_type IN ('market_history','fomo_token_history')`)
      .get(jobId,normalized) as { status: string; lastError: string | null; updatedAt: number } | undefined;
    const active = job && ['pending','running','failed'].includes(job.status);
    const prior = database.prepare(`SELECT requested_from fromAt,requested_to toAt
      FROM consumer_history_recovery_requests WHERE job_id=?`).get(jobId) as { fromAt: number | null; toAt: number | null } | undefined;
    if (active && prior && Number.isSafeInteger(prior.fromAt) && Number.isSafeInteger(prior.toAt)
      && prior.fromAt!>=0 && prior.toAt!>prior.fromAt! && prior.toAt!-prior.fromAt!<=WINDOW_MS && prior.toAt!<=asOf) {
      return Object.freeze({ fromAt: prior.fromAt!, toAt: prior.toAt! });
    }
    const range = readConsumerMarketHistoryRange(database,normalized,asOf);
    if (!range || !active) return range;
    const links = database.prepare(`SELECT * FROM recovery_fact_links
      WHERE recovery_job_id=? AND fact_type='price_history' AND fact_key=?`).all(jobId,normalized);
    database.prepare(`INSERT OR IGNORE INTO consumer_history_recovery_audits(
      job_id,token_id,previous_status,previous_error,previous_updated_at,previous_fact_links,
      action,requested_from,requested_to,recorded_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(jobId,normalized,job.status,job.lastError,job.updatedAt,JSON.stringify(links),
      prior?.fromAt!==null && prior?.fromAt!==undefined ? 'bound_request' : 'freeze_request',range.fromAt,range.toAt,asOf);
    database.prepare(`INSERT INTO consumer_history_recovery_requests(
      job_id,requested_from,requested_to,last_requested_at,checked_at,next_check_at
    ) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET requested_from=excluded.requested_from,
      requested_to=excluded.requested_to,last_requested_at=excluded.last_requested_at,
      checked_at=excluded.checked_at,next_check_at=excluded.next_check_at`)
      .run(jobId,range.fromAt,range.toAt,asOf,asOf,asOf+30*60_000);
    return range;
  });
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
  const rows = database.prepare(`WITH windows AS (
    SELECT ${tokenKey} tokenId,required_from fromAt,required_to toAt
    FROM consumer_fact_demands WHERE ${eligible}
  ),needs AS (
    SELECT tokenId,MIN(fromAt) fromAt,MAX(toAt) toAt FROM windows
    WHERE NOT EXISTS(SELECT 1 FROM consumer_history_recovery_audits audit
      WHERE audit.job_id='recovery:'||CASE WHEN windows.tokenId LIKE 'robinhood:%'
        THEN 'fomo_token_history' ELSE 'market_history' END||':'||windows.tokenId
        AND audit.requested_from<=windows.fromAt AND audit.requested_to>=windows.toAt
        AND audit.requested_to-audit.requested_from<=${WINDOW_MS}) GROUP BY tokenId
  ) SELECT needs.*,job.job_id jobId,job.status,job.updated_at updatedAt FROM needs
    JOIN recovery_jobs job ON job.job_id='recovery:'||
      CASE WHEN needs.tokenId LIKE 'robinhood:%' THEN 'fomo_token_history' ELSE 'market_history' END||':'||needs.tokenId
    LEFT JOIN consumer_history_recovery_requests receipt ON receipt.job_id=job.job_id
    WHERE (job.status='completed' OR job.status='dead_letter' AND job.last_error='historical_market_range_unavailable')
      AND (receipt.next_check_at IS NULL OR receipt.next_check_at<=?)
    ORDER BY COALESCE(receipt.checked_at,-1),job.updated_at,needs.tokenId LIMIT ?`)
    .all(asOf,asOf,limit) as Array<{ tokenId: string; fromAt: number; toAt: number; jobId: string; status: string; updatedAt: number }>;
  return rows.flatMap(row => {
    const range=selectConsumerMarketHistoryRange(database,row.tokenId,asOf,true);
    return range ? [{...row,...range}] : [];
  });
}
