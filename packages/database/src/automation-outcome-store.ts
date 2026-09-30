import type { DatabaseSync } from "node:sqlite";

import { withAddressRadarWriteTransaction } from "./connection.js";

export type AutomationOutcomeStatus = "produced" | "no_output" | "deferred" | "terminal" | "failed";

export interface AutomationJobOutcomeRecord {
  readonly id: number;
  readonly jobId: string;
  readonly jobType: string;
  readonly attempt: number;
  readonly outcome: AutomationOutcomeStatus;
  readonly reasonCode: string | null;
  readonly inputCount: number;
  readonly producedCount: number;
  readonly deferredCount: number;
  readonly diagnostic: unknown;
  readonly createdAt: number;
}

export interface RecordAutomationJobOutcomeInput {
  readonly jobId: string;
  readonly jobType: string;
  readonly attempt: number;
  readonly outcome: AutomationOutcomeStatus;
  readonly reasonCode?: string | null;
  readonly inputCount?: number;
  readonly producedCount?: number;
  readonly deferredCount?: number;
  readonly diagnostic?: unknown;
  readonly createdAt: number;
}

const assertCount = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
};

const decode = (row: Record<string, unknown>): AutomationJobOutcomeRecord => Object.freeze({
  id: Number(row.id),
  jobId: String(row.job_id),
  jobType: String(row.job_type),
  attempt: Number(row.attempt),
  outcome: row.outcome as AutomationOutcomeStatus,
  reasonCode: row.reason_code as string | null,
  inputCount: Number(row.input_count),
  producedCount: Number(row.produced_count),
  deferredCount: Number(row.deferred_count),
  diagnostic: row.diagnostic_json === null ? null : JSON.parse(String(row.diagnostic_json)),
  createdAt: Number(row.created_at),
});

export function initializeAutomationOutcomeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS automation_job_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt >= 0),
      outcome TEXT NOT NULL CHECK(outcome IN ('produced','no_output','deferred','terminal','failed')),
      reason_code TEXT,
      input_count INTEGER NOT NULL DEFAULT 0 CHECK(input_count >= 0),
      produced_count INTEGER NOT NULL DEFAULT 0 CHECK(produced_count >= 0),
      deferred_count INTEGER NOT NULL DEFAULT 0 CHECK(deferred_count >= 0),
      diagnostic_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(job_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS automation_job_outcomes_type_time
      ON automation_job_outcomes(job_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS automation_job_outcomes_reason_time
      ON automation_job_outcomes(outcome, reason_code, created_at DESC);
  `);
}

export function createAutomationOutcomeStore(database: DatabaseSync) {
  return Object.freeze({
    record(input: RecordAutomationJobOutcomeInput): AutomationJobOutcomeRecord {
      const inputCount = input.inputCount ?? 0;
      const producedCount = input.producedCount ?? 0;
      const deferredCount = input.deferredCount ?? 0;
      assertCount(input.attempt, "attempt");
      assertCount(inputCount, "inputCount");
      assertCount(producedCount, "producedCount");
      assertCount(deferredCount, "deferredCount");
      if (input.outcome === "produced" && producedCount === 0) {
        throw new Error("Produced outcomes require producedCount greater than zero");
      }

      return withAddressRadarWriteTransaction(database, () => {
        database.prepare(`
          INSERT INTO automation_job_outcomes(
            job_id, job_type, attempt, outcome, reason_code, input_count,
            produced_count, deferred_count, diagnostic_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(job_id, attempt) DO UPDATE SET
            job_type=excluded.job_type,
            outcome=excluded.outcome,
            reason_code=excluded.reason_code,
            input_count=excluded.input_count,
            produced_count=excluded.produced_count,
            deferred_count=excluded.deferred_count,
            diagnostic_json=excluded.diagnostic_json,
            created_at=excluded.created_at
        `).run(
          input.jobId,
          input.jobType,
          input.attempt,
          input.outcome,
          input.reasonCode ?? null,
          inputCount,
          producedCount,
          deferredCount,
          input.diagnostic === undefined ? null : JSON.stringify(input.diagnostic),
          input.createdAt,
        );
        return this.forAttempt(input.jobId, input.attempt)!;
      });
    },
    forAttempt(jobId: string, attempt: number): AutomationJobOutcomeRecord | null {
      const row = database.prepare(
        "SELECT * FROM automation_job_outcomes WHERE job_id=? AND attempt=?",
      ).get(jobId, attempt) as Record<string, unknown> | undefined;
      return row ? decode(row) : null;
    },
    latestForJob(jobId: string): AutomationJobOutcomeRecord | null {
      const row = database.prepare(
        "SELECT * FROM automation_job_outcomes WHERE job_id=? ORDER BY attempt DESC, id DESC LIMIT 1",
      ).get(jobId) as Record<string, unknown> | undefined;
      return row ? decode(row) : null;
    },
  });
}

export type ReturnTypeOfCreateAutomationOutcomeStore = ReturnType<typeof createAutomationOutcomeStore>;
