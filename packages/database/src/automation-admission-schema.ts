export const AUTOMATION_ADMISSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_admission_intents (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  lane TEXT NOT NULL,
  high_water_mark INTEGER NOT NULL CHECK(high_water_mark > 0),
  next_attempt_at INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  admitted_at INTEGER,
  admitted_job_id TEXT
);
CREATE INDEX IF NOT EXISTS automation_admission_intents_pending
  ON automation_admission_intents(lane,job_type,requested_at,idempotency_key)
  WHERE admitted_at IS NULL;
`;

export const CLOSED_LOOP_QUERY_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS trader_repeatable_ability_strategy_coverage
  ON trader_repeatable_ability_snapshots(strategy_version,window,entity_id,evaluated_at);
CREATE INDEX IF NOT EXISTS automation_job_outcomes_closure_time
  ON automation_job_outcomes(created_at,job_type,outcome);
CREATE INDEX IF NOT EXISTS token_fact_attempts_closure_time
  ON token_fact_attempts(finished_at,provider,outcome,facts_written);
`;
