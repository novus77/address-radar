import type { DatabaseSync } from "node:sqlite";

export function recoveryExecutionMetrics(database: DatabaseSync, now: number) {
  const totals = database.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN status IN ('pending','failed') AND next_attempt_at<=? THEN 1 ELSE 0 END) runnable,
    SUM(CASE WHEN status IN ('pending','failed') AND next_attempt_at>? THEN 1 ELSE 0 END) scheduled,
    SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) terminal,
    MIN(CASE WHEN status IN ('pending','failed') AND next_attempt_at<=? THEN next_attempt_at END) oldestDueAt
    FROM recovery_jobs`).get(now, now, now) as Record<string, number | null>;
  const attempts = database.prepare(`SELECT COUNT(*) attempts30m,
    SUM(facts_written) factUpdates30m, MAX(finished_at) lastAttemptAt,
    MAX(CASE WHEN facts_written>0 THEN finished_at END) lastFactProgressAt
    FROM token_fact_attempts WHERE finished_at>=?`).get(now - 30 * 60_000) as Record<string, number | null>;
  const byTypeAndChain = database.prepare(`SELECT job_type jobType, chain, status, COUNT(*) count,
    MIN(next_attempt_at) nextAttemptAt
    FROM recovery_jobs GROUP BY job_type,chain,status ORDER BY job_type,chain,status`).all();
  const waitingResults = database.prepare(`SELECT COUNT(*) count FROM recovery_jobs
    WHERE status IN ('pending','failed') AND last_error IN (
      'waiting_result','waiting_canonical_trade','no_eligible_trade','lookup_retries_exhausted')`).get() as { count: number };
  const attemptOutcomes = database.prepare(`SELECT provider,outcome,COUNT(*) attempts,SUM(facts_written) factUpdates
    FROM token_fact_attempts WHERE finished_at>=? GROUP BY provider,outcome ORDER BY provider,outcome`).all(now - 30 * 60_000);
  return Object.freeze({
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, key === "oldestDueAt" ? value : Number(value ?? 0)])),
    ...Object.fromEntries(Object.entries(attempts).map(([key, value]) => [key, key.endsWith("At") ? value : Number(value ?? 0)])),
    oldestDueAgeMs: totals.oldestDueAt === null ? 0 : Math.max(0, now - Number(totals.oldestDueAt)),
    waitingResults: Number(waitingResults.count), byTypeAndChain, attemptOutcomes,
    diagnosticZh: "补数队列独立于自动化队列；事实更新次数不等于新增代币数，空结果不等于补齐成功",
  });
}
