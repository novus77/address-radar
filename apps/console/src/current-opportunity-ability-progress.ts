import type { DatabaseSync } from "node:sqlite";

const STRATEGY_VERSION = "trader-ability-v4-opportunity";

/** Keep legacy evaluations and repeat runs out of current trader coverage. */
export function readCurrentOpportunityAbilityProgress(database: DatabaseSync, asOf: number) {
  const row = database.prepare(`
    WITH evaluations AS (
      SELECT entity_id, MIN(evaluated_at) AS first_evaluated_at,
        MAX(evaluated_at) AS last_evaluated_at
      FROM trader_repeatable_ability_snapshots
      WHERE window = '30d' AND strategy_version = ?
        AND typeof(evaluated_at) = 'integer' AND evaluated_at BETWEEN 0 AND ?
      GROUP BY entity_id
    ), cohort AS (
      SELECT e.entity_id, v.first_evaluated_at, v.last_evaluated_at,
        CASE WHEN v.entity_id IS NULL AND EXISTS (
          SELECT 1 FROM automation_jobs j WHERE j.job_type = 'ability_evaluation'
            AND j.subject_key = e.entity_id AND j.status IN ('blocked_source', 'waiting_source')
        ) THEN 1 ELSE 0 END AS blocked,
        CASE WHEN v.entity_id IS NULL AND EXISTS (
          SELECT 1 FROM automation_jobs j WHERE j.job_type = 'ability_evaluation'
            AND j.subject_key = e.entity_id AND j.status = 'terminal'
        ) AND NOT EXISTS (
          SELECT 1 FROM automation_jobs j WHERE j.job_type = 'ability_evaluation'
            AND j.subject_key = e.entity_id
            AND j.status IN ('pending', 'retry_scheduled', 'retryable', 'leased', 'running', 'blocked_source', 'waiting_source')
        ) THEN 1 ELSE 0 END AS terminal
      FROM trader_entities e LEFT JOIN evaluations v ON v.entity_id = e.entity_id
      WHERE v.entity_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM trader_token_samples s WHERE s.entity_id = e.entity_id)
        OR EXISTS (SELECT 1 FROM candidate_evidence_v3 c WHERE c.trader_id = e.entity_id)
        OR EXISTS (SELECT 1 FROM candidate_admission_snapshots a WHERE a.trader_id = e.entity_id)
    )
    SELECT (SELECT COUNT(*) FROM trader_entities) AS discovered,
      COUNT(*) AS eligible, COUNT(first_evaluated_at) AS completed,
      COALESCE(SUM(blocked), 0) AS blocked, COALESCE(SUM(terminal), 0) AS terminal,
      COALESCE(SUM(first_evaluated_at >= ?), 0) AS completed15m,
      COALESCE(SUM(first_evaluated_at >= ?), 0) AS completed1h,
      COALESCE(SUM(first_evaluated_at >= ?), 0) AS completed24h,
      COALESCE(SUM(last_evaluated_at >= ?), 0) AS evaluatedTraders1h,
      MAX(last_evaluated_at) AS lastProgressAt
    FROM cohort
  `).get(STRATEGY_VERSION, asOf, asOf - 15 * 60_000, asOf - 60 * 60_000,
    asOf - 24 * 60 * 60_000, asOf - 60 * 60_000) as {
    discovered: number; eligible: number; completed: number; blocked: number; terminal: number;
    completed15m: number; completed1h: number; completed24h: number;
    evaluatedTraders1h: number; lastProgressAt: number | null;
  };
  return Object.freeze({
    ...row,
    unit: "trader" as const,
    strategyVersion: STRATEGY_VERSION,
    pending: row.eligible - row.completed - row.blocked - row.terminal,
    producedFacts: row.completed,
    lastProgressAt: row.lastProgressAt === null ? null : new Date(row.lastProgressAt).toISOString(),
  });
}
