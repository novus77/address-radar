import type { DatabaseSync } from "node:sqlite";

const OPPORTUNITY_STRATEGY = "trader-ability-v4-opportunity";

/** SELECT-only diagnostics; deliberately does not initialize or reconcile schemas. */
export function readDataFlowProgress(database: DatabaseSync, asOf = Date.now()) {
  const since = asOf - 60 * 60_000;
  const hasTable = (name: string) => database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name) !== undefined;
  const readRows = (sql: string, ...parameters: (string | number)[]) => database.prepare(sql).all(...parameters);
  const abilityAvailable = hasTable("trader_repeatable_ability_snapshots");
  const ability = abilityAvailable ? readRows(`
    WITH ranked AS (
      SELECT entity_id, ability_stage, evaluated_at,
        ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY evaluated_at DESC, snapshot_id DESC) AS rank
      FROM trader_repeatable_ability_snapshots
      WHERE strategy_version=? AND window='30d' AND evaluated_at<=?
    ) SELECT ability_stage AS state, COUNT(*) AS traders, MAX(evaluated_at) AS lastEvaluationAt
      FROM ranked WHERE rank=1 GROUP BY ability_stage ORDER BY ability_stage
  `, OPPORTUNITY_STRATEGY, asOf) : [];
  const evaluatedTraders = ability.reduce((sum, row) => sum + Number(row.traders), 0);
  const sourceAvailable = hasTable("trader_events");
  const sources = sourceAvailable ? readRows(`
    SELECT source, chain, COUNT(*) AS observationRows,
      MAX(collected_at) AS latestCollectedAt, MAX(occurred_at) AS latestEventAt,
      SUM(CASE WHEN collected_at>=? THEN 1 ELSE 0 END) AS collectedRows1h,
      SUM(CASE WHEN occurred_at>=? AND side='buy' THEN 1 ELSE 0 END) AS recentBuyRows1h
    FROM trader_events WHERE collected_at<=? AND occurred_at<=?
    GROUP BY source, chain ORDER BY source, chain
  `, since, since, asOf, asOf) : [];
  const walletAvailable = hasTable("wallet_monitor_observations");
  const wallets = walletAvailable ? readRows(`
    SELECT chain, COUNT(*) AS observationRows,
      COUNT(DISTINCT entity_id) AS observedTraders,
      MAX(collected_at) AS latestCollectedAt, MAX(occurred_at) AS latestEventAt,
      SUM(CASE WHEN collected_at>=? THEN 1 ELSE 0 END) AS collectedRows1h,
      SUM(CASE WHEN occurred_at>=? AND side='buy' THEN 1 ELSE 0 END) AS recentBuyRows1h,
      SUM(CASE WHEN side='buy' AND (amount_usd IS NULL OR price_usd IS NULL
        OR amount_usd<=0 OR price_usd<=0) THEN 1 ELSE 0 END) AS buysMissingExecutionBasis
    FROM wallet_monitor_observations
    WHERE orphaned_at IS NULL AND collected_at<=? AND occurred_at<=?
    GROUP BY chain ORDER BY chain
  `, since, since, asOf, asOf) : [];
  const queueAvailable = hasTable("automation_jobs");
  const queue = queueAvailable ? readRows(`
    SELECT job_type AS jobType, status, COUNT(*) AS tasks,
      SUM(CASE WHEN status IN ('pending','retryable','waiting_source') AND next_attempt_at<=?
        THEN 1 ELSE 0 END) AS dueTasks
    FROM automation_jobs GROUP BY job_type,status ORDER BY job_type,status
  `, asOf) : [];
  const factsAvailable = hasTable("token_fact_status");
  const facts = factsAvailable ? readRows(`
    SELECT fact_type AS factType,status,precision,COUNT(*) AS tokenFactRecords
    FROM token_fact_status GROUP BY fact_type,status,precision ORDER BY fact_type,status,precision
  `) : [];
  return {
    schemaVersion: "data-flow-v1",
    asOf,
    windowStart: since,
    consistency: "best_effort_read",
    scope: { cohortId: "local-observed-inventory", externalInventoryComplete: false },
    ability: {
      available: abilityAvailable, unit: "trader", strategyVersion: OPPORTUNITY_STRATEGY,
      window: "30d", evaluatedTraders, eligibleTraders: null, coverage: null,
      newUniqueFacts: null, states: ability,
    },
    sources: { available: sourceAvailable, unit: "source_event_row", rows: sources },
    walletMonitoring: { available: walletAvailable, unit: "source_event_row", rows: wallets },
    queue: { available: queueAvailable, unit: "task", rows: queue },
    facts: { available: factsAvailable, unit: "token_fact_record", rows: facts },
    limitations: [
      "Local inventory is not an exhaustive external cohort.",
      "Collection and evaluation timestamps do not prove new unique economic events or facts.",
      "Snapshot age does not prove completeness of a 30-day opportunity range.",
      "Partial fact status does not prove that a consumer's coverage requirements are satisfied.",
      "Eligibility denominator and immutable first-ingestion deltas are not established by this endpoint.",
      "A missing table means unavailable metrics, not an empty successfully processed population.",
    ],
  };
}
