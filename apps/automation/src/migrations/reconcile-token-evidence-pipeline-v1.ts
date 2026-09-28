import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  initializeCandidateEvaluationRequestSchema,
  withAddressRadarWriteTransaction,
} from "@address-radar/database";

const ACTIVE_STATUSES = "'pending','leased','running','waiting_source','blocked_source','retryable'";
const STRATEGY_VERSION = "candidate-evidence-v2";
const RECONCILIATION_SOURCE = "legacy-reconciliation-v1";
export const TOKEN_EVIDENCE_RECONCILIATION_REASON = "coalesced_to_candidate_evidence_v2";

interface LegacySubjectRow {
  readonly subjectKey: string;
  readonly activeJobs: number;
  readonly inFlightJobs: number;
  readonly latestUpdatedAt: number;
}

export interface TokenEvidencePipelineReconciliationSummary {
  readonly dryRun: boolean;
  readonly examinedSubjects: number;
  readonly legacyActiveJobs: number;
  readonly skippedInFlightSubjects: number;
  readonly cancelledJobs: number;
  readonly requestsSeeded: number;
  readonly jobsEnqueued: number;
  readonly hasMore: boolean;
  readonly cursor: string | null;
}

const stableId = (prefix: string, value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export function reconcileTokenEvidencePipelineV1(input: {
  readonly database: DatabaseSync;
  readonly dryRun?: boolean;
  readonly batchSize?: number;
  readonly now?: () => number;
}): TokenEvidencePipelineReconciliationSummary {
  const dryRun = input.dryRun ?? true;
  const batchSize = input.batchSize ?? 250;
  const now = input.now ?? Date.now;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 5_000) {
    throw new Error("batchSize must be a positive safe integer no greater than 5000");
  }
  initializeCandidateEvaluationRequestSchema(input.database);
  const subjects = input.database.prepare(`
    SELECT subject_key AS subjectKey, COUNT(*) AS activeJobs,
      SUM(CASE WHEN status IN ('leased','running') THEN 1 ELSE 0 END) AS inFlightJobs,
      MAX(updated_at) AS latestUpdatedAt
    FROM automation_jobs
    WHERE job_type='candidate_evidence'
      AND subject_key != 'candidate-evidence-dispatcher'
      AND status IN (${ACTIVE_STATUSES})
      AND idempotency_key NOT LIKE 'candidate-evidence:candidate-evidence-v2:%'
    GROUP BY subject_key
    ORDER BY subject_key
    LIMIT ?
  `).all(batchSize) as unknown as LegacySubjectRow[];
  const base = {
    dryRun,
    examinedSubjects: subjects.length,
    legacyActiveJobs: subjects.reduce((sum, row) => sum + Number(row.activeJobs), 0),
    skippedInFlightSubjects: subjects.filter((row) => Number(row.inFlightJobs) > 0).length,
    hasMore: subjects.length === batchSize,
    cursor: subjects.at(-1)?.subjectKey ?? null,
  };
  if (dryRun) return Object.freeze({ ...base, cancelledJobs: 0, requestsSeeded: 0, jobsEnqueued: 0 });

  let cancelledJobs = 0;
  let requestsSeeded = 0;
  let jobsEnqueued = 0;
  for (const subject of subjects) {
    if (Number(subject.inFlightJobs) > 0) continue;
    const timestamp = now();
    const result = withAddressRadarWriteTransaction(input.database, () => {
      const requestKey = `${STRATEGY_VERSION}:${subject.subjectKey}`;
      input.database.prepare(`INSERT OR IGNORE INTO candidate_evaluation_requests(
        request_key,token_id,strategy_version,requested_revision,processed_revision,requested_at,updated_at
      ) VALUES (?,?,?,0,0,?,?)`).run(requestKey, subject.subjectKey, STRATEGY_VERSION, timestamp, timestamp);
      const trigger = input.database.prepare(`
        INSERT OR IGNORE INTO candidate_evaluation_triggers(request_key,source_key,requested_at)
        VALUES (?,?,?)
      `).run(requestKey, RECONCILIATION_SOURCE, timestamp);
      if (trigger.changes === 1) input.database.prepare(`
        UPDATE candidate_evaluation_requests
        SET requested_revision=requested_revision+1, requested_at=MAX(requested_at,?), updated_at=MAX(updated_at,?)
        WHERE request_key=?
      `).run(timestamp, timestamp, requestKey);

      const cancelled = input.database.prepare(`
        UPDATE automation_jobs
        SET status='cancelled', last_error=?, lease_expires_at=NULL, lease_owner=NULL,
          updated_at=?, completed_at=COALESCE(completed_at,?)
        WHERE job_type='candidate_evidence' AND subject_key=?
          AND status IN (${ACTIVE_STATUSES})
          AND idempotency_key NOT LIKE 'candidate-evidence:candidate-evidence-v2:%'
      `).run(TOKEN_EVIDENCE_RECONCILIATION_REASON, timestamp, timestamp, subject.subjectKey);

      const request = input.database.prepare(`
        SELECT requested_revision AS requestedRevision, processed_revision AS processedRevision,
          active_job_id AS activeJobId, requested_at AS requestedAt
        FROM candidate_evaluation_requests WHERE request_key=?
      `).get(requestKey) as { requestedRevision: number; processedRevision: number; activeJobId: string | null; requestedAt: number };
      let inserted = 0;
      if (!request.activeJobId && request.requestedRevision > request.processedRevision) {
        const jobId = stableId("candidate-evidence", `${requestKey}:${request.requestedRevision}`);
        const idempotencyKey = `candidate-evidence:${STRATEGY_VERSION}:${subject.subjectKey}:${request.requestedRevision}`;
        const job = input.database.prepare(`INSERT OR IGNORE INTO automation_jobs(
          job_id,idempotency_key,lane,job_type,subject_key,priority,status,cursor,attempt_count,
          next_attempt_at,lease_expires_at,lease_owner,payload,last_error,created_at,updated_at,completed_at
        ) VALUES (?,?, 'token_mining','candidate_evidence',?,80,'pending',NULL,0,?,NULL,NULL,?,NULL,?,?,NULL)
        `).run(jobId, idempotencyKey, subject.subjectKey, timestamp, JSON.stringify({
          tokenId: subject.subjectKey,
          evaluatedAt: request.requestedAt,
          requestKey,
          targetRevision: request.requestedRevision,
        }), timestamp, timestamp);
        inserted = Number(job.changes);
        if (inserted === 1) input.database.prepare(`
          UPDATE candidate_evaluation_requests SET active_job_id=?,updated_at=MAX(updated_at,?)
          WHERE request_key=? AND active_job_id IS NULL
        `).run(jobId, timestamp, requestKey);
      }
      return { cancelled: Number(cancelled.changes), seeded: Number(trigger.changes), inserted };
    });
    cancelledJobs += result.cancelled;
    requestsSeeded += result.seeded;
    jobsEnqueued += result.inserted;
  }
  return Object.freeze({ ...base, cancelledJobs, requestsSeeded, jobsEnqueued });
}
