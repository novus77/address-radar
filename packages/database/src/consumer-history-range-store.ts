import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "./connection.js";

const HOUR = 60 * 60_000;
const RECHECK_MS = 30 * 60_000;

export function initializeConsumerHistoryRecoverySchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS consumer_history_recovery_requests (
    job_id TEXT PRIMARY KEY, requested_from INTEGER, requested_to INTEGER,
    last_requested_at INTEGER, checked_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS consumer_history_recovery_due
    ON consumer_history_recovery_requests(next_check_at,job_id);
  CREATE TABLE IF NOT EXISTS consumer_history_recovery_audits (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, token_id TEXT NOT NULL,
    previous_status TEXT NOT NULL, previous_error TEXT, previous_updated_at INTEGER NOT NULL,
    previous_fact_links TEXT NOT NULL, action TEXT NOT NULL,
    requested_from INTEGER NOT NULL, requested_to INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
    UNIQUE(job_id,action,requested_from,requested_to)
  );`);
}

export function hasConsumerHistoryRequestCoverage(database: DatabaseSync, tokenId: string, fromAt: number, toAt: number): boolean {
  const separator = tokenId.indexOf(":");
  const chain = tokenId.slice(0,separator);
  const address = tokenId.slice(separator+1);
  const rows = database.prepare(`SELECT observed_at observedAt,price_usd priceUsd FROM market_observations
    WHERE chain=? AND ${chain === "solana" ? "token_address" : "LOWER(token_address)"}=?
      AND observed_at>=? AND observed_at<=? AND price_usd>0 AND length(trim(source))>0
    ORDER BY observed_at`).all(chain,address,Math.max(0,fromAt-HOUR),toAt);
  const points = rows.filter(row => Number.isSafeInteger(row.observedAt) && Number.isFinite(row.priceUsd))
    .map(row => Number(row.observedAt));
  // Match recovery's hourly request tolerance, never opportunity extrema certification.
  if (!points.length || points[0]!>fromAt || points.at(-1)!<toAt-HOUR) return false;
  return points.every((point,index) => index===0 || point-points[index-1]!<=HOUR);
}

export function reconsiderConsumerHistoryRecovery(database: DatabaseSync, input: {
  readonly jobId: string; readonly tokenId: string; readonly fromAt: number; readonly toAt: number;
  readonly expectedUpdatedAt: number; readonly expectedStatus: string;
  readonly covered: boolean; readonly at: number;
}): "requeued" | "reopened" | "unchanged" {
  return withAddressRadarWriteTransaction(database, () => {
    const job = database.prepare(`SELECT status,last_error lastError,updated_at updatedAt FROM recovery_jobs
      WHERE job_id=? AND subject_key=? AND job_type IN ('market_history','fomo_token_history')`)
      .get(input.jobId,input.tokenId) as { status: string; lastError: string | null; updatedAt: number } | undefined;
    if (!job || job.updatedAt!==input.expectedUpdatedAt || job.status!==input.expectedStatus) return "unchanged";
    const allowed = job.status==="completed" || job.status==="dead_letter" && job.lastError==="historical_market_range_unavailable";
    if (!allowed) return "unchanged";
    const prior = database.prepare(`SELECT requested_from fromAt,requested_to toAt,next_check_at nextCheckAt
      FROM consumer_history_recovery_requests WHERE job_id=?`).get(input.jobId) as { fromAt: number | null; toAt: number | null; nextCheckAt: number } | undefined;
    if (prior && prior.nextCheckAt>input.at) return "unchanged";
    const unchanged = prior?.fromAt!==null && prior?.fromAt!==undefined && prior.toAt!==null
      && prior.fromAt<=input.fromAt && prior.toAt>=input.toAt;
    const dispatch = !input.covered && !unchanged;
    database.prepare(`INSERT INTO consumer_history_recovery_requests(
      job_id,requested_from,requested_to,last_requested_at,checked_at,next_check_at
    ) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET
      requested_from=COALESCE(excluded.requested_from,consumer_history_recovery_requests.requested_from),
      requested_to=COALESCE(excluded.requested_to,consumer_history_recovery_requests.requested_to),
      last_requested_at=COALESCE(excluded.last_requested_at,consumer_history_recovery_requests.last_requested_at),
      checked_at=excluded.checked_at,next_check_at=excluded.next_check_at`)
      .run(input.jobId,dispatch?input.fromAt:null,dispatch?input.toAt:null,dispatch?input.at:null,input.at,input.at+RECHECK_MS);
    if (!dispatch) return "unchanged";
    const action = job.status==="completed"?"expand_completed":"recover_missing_range";
    const links = database.prepare(`SELECT * FROM recovery_fact_links
      WHERE recovery_job_id=? AND fact_type='price_history' AND fact_key=?`).all(input.jobId,input.tokenId);
    database.prepare(`INSERT INTO consumer_history_recovery_audits(
      job_id,token_id,previous_status,previous_error,previous_updated_at,previous_fact_links,
      action,requested_from,requested_to,recorded_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.jobId,input.tokenId,job.status,job.lastError,job.updatedAt,JSON.stringify(links),action,input.fromAt,input.toAt,input.at);
    database.prepare(`UPDATE recovery_jobs SET status='pending',next_attempt_at=?,lease_expires_at=NULL,
      last_error=NULL,completed_at=NULL,updated_at=? WHERE job_id=? AND status=? AND updated_at=?`)
      .run(input.at,input.at,input.jobId,job.status,job.updatedAt);
    database.prepare(`UPDATE recovery_fact_links SET status='pending',terminal_reason=NULL,
      verified_at=NULL,updated_at=? WHERE recovery_job_id=? AND fact_type='price_history' AND fact_key=?`)
      .run(input.at,input.jobId,input.tokenId);
    return job.status==="completed"?"requeued":"reopened";
  });
}
