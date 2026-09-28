import type { DatabaseSync } from "node:sqlite";

import type {
  AutomationJob,
  AutomationJobSourceBlock,
  AutomationLane,
  CandidateSourceBlockReason,
} from "@address-radar/domain";
import { withAddressRadarWriteTransaction } from "./connection.js";

const LANE_WEIGHTS = Object.freeze({
  trader_backfill: 40,
  token_mining: 40,
  repair: 20,
} satisfies Readonly<Record<AutomationLane, number>>);

const LANE_ORDER = Object.freeze<readonly AutomationLane[]>([
  "trader_backfill",
  "token_mining",
  "repair",
]);

export interface AutomationJobInput {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly lane: AutomationLane;
  readonly jobType: string;
  readonly subjectKey: string;
  readonly priority: number;
  readonly cursor: string | null;
  readonly nextAttemptAt: number;
  readonly payload: string;
  readonly createdAt: number;
}

export interface AutomationJobStoreOptions {
  readonly baseRetryDelayMs?: number;
  readonly maximumRetryDelayMs?: number;
  readonly defaultRetryBudget?: number;
  readonly retryBudgetByJobType?: Readonly<Record<string, number>>;
  readonly concurrencyLimitByJobType?: Readonly<Record<string, number>>;
}

export interface AutomationQueueTypeMetrics {
  readonly runnable: number;
  readonly deferred: number;
  readonly blocked: number;
  readonly terminal: number;
}

export interface AutomationQueueMetrics {
  readonly measuredAt: number;
  readonly windowMs: number;
  readonly runnable: number;
  readonly deferred: number;
  readonly blocked: number;
  readonly terminal: number;
  readonly manual: number;
  readonly admitted: number;
  readonly completed: number;
  readonly oldestRunnableAgeMs: number;
  readonly byJobType: Readonly<Record<string, AutomationQueueTypeMetrics>>;
}

export interface AutomationQueueSnapshot {
  readonly pending: number;
  readonly leased: number;
  readonly running: number;
  readonly waitingSource: number;
  readonly blockedSource: number;
  readonly retryable: number;
  readonly completed: number;
  readonly terminal: number;
  readonly cancelled: number;
}

export interface AutomationJobStore {
  enqueue(input: AutomationJobInput): { readonly inserted: boolean; readonly job: AutomationJob };
  activeCount(jobType: string): number;
  job(jobId: string): AutomationJob | null;
  sourceBlock(jobId: string): AutomationJobSourceBlock | null;
  claim(lane: AutomationLane, now: number, leaseMs: number, owner: string, enabledJobTypes?: readonly string[]): AutomationJob | null;
  checkpoint(jobId: string, owner: string, result: { readonly cursor: string | null; readonly nextAttemptAt: number; readonly updatedAt: number }): void;
  complete(jobId: string, owner: string, result: { readonly cursor: string | null; readonly completedAt: number }): void;
  retry(jobId: string, owner: string, result: { readonly error: string; readonly now: number; readonly retryAfterAt?: number }): void;
  waitForSource(jobId: string, owner: string, result: {
    readonly diagnostic: string;
    readonly reasonCode?: CandidateSourceBlockReason;
    readonly context?: Readonly<Record<string, unknown>>;
    readonly recoveryJobIds?: readonly string[];
    readonly retryAt: number;
    readonly updatedAt: number;
  }): void;
  wakeBlockedSource(subjectKey: string, updatedAt: number, jobType?: string): number;
  terminate(jobId: string, owner: string, result: { readonly reason: string; readonly terminatedAt: number }): void;
  dueLanes(now: number, enabledJobTypes?: readonly string[]): readonly AutomationLane[];
  snapshot(): AutomationQueueSnapshot;
  metrics(now: number, windowMs: number): AutomationQueueMetrics;
  selectLane(available: readonly AutomationLane[], now: number): AutomationLane | null;
}

const toJob = (row: Record<string, unknown>): AutomationJob => Object.freeze({
  jobId: String(row.job_id),
  idempotencyKey: String(row.idempotency_key),
  lane: row.lane as AutomationLane,
  jobType: String(row.job_type),
  subjectKey: String(row.subject_key),
  priority: Number(row.priority),
  status: row.status as AutomationJob["status"],
  cursor: row.cursor as string | null,
  attemptCount: Number(row.attempt_count),
  nextAttemptAt: Number(row.next_attempt_at),
  leaseExpiresAt: row.lease_expires_at as number | null,
  payload: String(row.payload),
  lastError: row.last_error as string | null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  completedAt: row.completed_at as number | null,
});

const toSourceBlock = (row: Record<string, unknown>): AutomationJobSourceBlock => Object.freeze({
  jobId: String(row.job_id),
  reasonCode: row.reason_code as CandidateSourceBlockReason,
  context: Object.freeze(JSON.parse(String(row.context)) as Record<string, unknown>),
  recoveryJobIds: Object.freeze(JSON.parse(String(row.recovery_job_ids)) as string[]),
  blockedAt: Number(row.blocked_at),
  updatedAt: Number(row.updated_at),
  resolvedAt: row.resolved_at as number | null,
});

export function createAutomationJobStore(
  database: DatabaseSync,
  options: AutomationJobStoreOptions = {},
): AutomationJobStore {
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 60 * 60_000;
  const defaultRetryBudget = options.defaultRetryBudget ?? 8;

  const transaction = <T>(operation: () => T): T =>
    withAddressRadarWriteTransaction(database, operation);
  const readJob = (jobId: string): AutomationJob | null => {
    const row = database.prepare("SELECT * FROM automation_jobs WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? toJob(row) : null;
  };
  const requireLease = (jobId: string, owner: string): Record<string, unknown> => {
    const row = database.prepare(`
      SELECT * FROM automation_jobs
      WHERE job_id = ? AND status IN ('leased', 'running') AND lease_owner = ?
    `).get(jobId, owner) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Automation job lease is not owned by ${owner}: ${jobId}`);
    return row;
  };
  const jobTypeFilter = (enabledJobTypes: readonly string[] | undefined) => {
    if (enabledJobTypes === undefined) return { sql: "", values: [] as string[] };
    const values = [...new Set(enabledJobTypes.map((item) => item.trim()).filter(Boolean))];
    if (values.length === 0) return { sql: " AND 0 = 1", values };
    return {
      sql: ` AND job_type IN (${values.map(() => "?").join(", ")})`,
      values,
    };
  };

  return Object.freeze<AutomationJobStore>({
    enqueue(input) {
      const result = database.prepare(`
        INSERT OR IGNORE INTO automation_jobs(
          job_id, idempotency_key, lane, job_type, subject_key, priority,
          status, cursor, attempt_count, next_attempt_at, lease_expires_at,
          lease_owner, payload, last_error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, NULL, NULL, ?, NULL, ?, ?, NULL)
      `).run(
        input.jobId,
        input.idempotencyKey,
        input.lane,
        input.jobType,
        input.subjectKey,
        input.priority,
        input.cursor,
        input.nextAttemptAt,
        input.payload,
        input.createdAt,
        input.createdAt,
      );
      const row = database.prepare(`
        SELECT * FROM automation_jobs WHERE idempotency_key = ? OR job_id = ?
        ORDER BY idempotency_key = ? DESC LIMIT 1
      `).get(input.idempotencyKey, input.jobId, input.idempotencyKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Unable to read enqueued automation job: ${input.jobId}`);
      return Object.freeze({ inserted: result.changes === 1, job: toJob(row) });
    },
    activeCount(jobType) {
      const row = database.prepare(`
        SELECT COUNT(*) AS count FROM automation_jobs
        WHERE job_type = ? AND status IN (
          'pending', 'leased', 'running', 'waiting_source', 'blocked_source', 'retryable'
        )
      `).get(jobType) as { count: number };
      return Number(row.count);
    },
    job: readJob,
    sourceBlock(jobId) {
      const row = database.prepare("SELECT * FROM automation_job_blocks WHERE job_id = ?")
        .get(jobId) as Record<string, unknown> | undefined;
      return row ? toSourceBlock(row) : null;
    },
    claim(lane, now, leaseMs, owner, enabledJobTypes) {
      if (!owner.trim()) throw new Error("Automation worker owner is required");
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("leaseMs must be positive");
      return transaction(() => {
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'retryable', lease_expires_at = NULL, lease_owner = NULL,
            next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
          WHERE status IN ('leased', 'running')
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        `).run(now, now, now);
        const filter = jobTypeFilter(enabledJobTypes);
        const qualifiedFilterSql = filter.sql.replace(/\bjob_type\b/g, "j.job_type");
        const candidateTypes = database.prepare(`
          SELECT j.job_type AS jobType
          FROM automation_jobs j
          LEFT JOIN automation_job_type_state s ON s.job_type = j.job_type
          WHERE j.lane = ? AND j.status IN ('pending', 'retryable')
            ${qualifiedFilterSql}
            AND j.next_attempt_at <= ?
          GROUP BY j.job_type
          ORDER BY s.last_claimed_at IS NOT NULL, s.last_claimed_at,
            MIN(j.priority), MIN(j.created_at), j.job_type
        `).all(lane, ...filter.values, now) as Array<{ jobType: string }>;
        const selectedType = candidateTypes.find(({ jobType }) => {
          const limit = options.concurrencyLimitByJobType?.[jobType] ?? Number.POSITIVE_INFINITY;
          const active = database.prepare(`
            SELECT COUNT(*) AS count FROM automation_jobs
            WHERE job_type = ? AND status IN ('leased', 'running')
              AND (lease_expires_at IS NULL OR lease_expires_at > ?)
          `).get(jobType, now) as { count: number };
          return Number(active.count) < limit;
        });
        if (!selectedType) return null;
        const row = database.prepare(`
          SELECT job_id FROM automation_jobs
          WHERE lane = ? AND status IN ('pending', 'retryable')
            AND job_type = ? AND next_attempt_at <= ?
          ORDER BY priority, next_attempt_at, created_at, job_id
          LIMIT 1
        `).get(lane, selectedType.jobType, now) as { job_id: string } | undefined;
        if (!row) return null;
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'leased', attempt_count = attempt_count + 1,
            lease_expires_at = ?, lease_owner = ?, updated_at = ?
          WHERE job_id = ?
        `).run(now + leaseMs, owner, now, row.job_id);
        database.prepare(`
          INSERT INTO automation_job_type_state(job_type, last_claimed_at, claim_count)
          VALUES (?, ?, 1)
          ON CONFLICT(job_type) DO UPDATE SET
            last_claimed_at = excluded.last_claimed_at,
            claim_count = automation_job_type_state.claim_count + 1
        `).run(selectedType.jobType, now);
        return readJob(row.job_id);
      });
    },
    checkpoint(jobId, owner, result) {
      transaction(() => {
        requireLease(jobId, owner);
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'pending', cursor = ?, next_attempt_at = ?,
            lease_expires_at = NULL, lease_owner = NULL, last_error = NULL,
            updated_at = ?
          WHERE job_id = ?
        `).run(result.cursor, result.nextAttemptAt, result.updatedAt, jobId);
      });
    },
    complete(jobId, owner, result) {
      transaction(() => {
        requireLease(jobId, owner);
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'completed', cursor = ?, lease_expires_at = NULL,
            lease_owner = NULL, last_error = NULL, completed_at = ?, updated_at = ?
          WHERE job_id = ?
        `).run(result.cursor, result.completedAt, result.completedAt, jobId);
        database.prepare(`
          UPDATE automation_job_blocks
          SET resolved_at = ?, updated_at = ?
          WHERE job_id = ? AND resolved_at IS NULL
        `).run(result.completedAt, result.completedAt, jobId);
      });
    },
    retry(jobId, owner, result) {
      transaction(() => {
        const job = requireLease(jobId, owner);
        const attemptCount = Number(job.attempt_count);
        const retryBudget = options.retryBudgetByJobType?.[String(job.job_type)] ?? defaultRetryBudget;
        if (attemptCount >= retryBudget) {
          database.prepare(`
            UPDATE automation_jobs
            SET status = 'waiting_source', lease_expires_at = NULL, lease_owner = NULL,
              last_error = ?, next_attempt_at = ?, updated_at = ?
            WHERE job_id = ?
          `).run(`retry_budget_exhausted:${result.error}`, result.now, result.now, jobId);
          return;
        }
        const delay = Math.min(
          maximumRetryDelayMs,
          baseRetryDelayMs * (2 ** Math.max(0, attemptCount - 1)),
        );
        const nextAttemptAt = Math.max(result.now + delay, result.retryAfterAt ?? 0);
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'retryable', lease_expires_at = NULL, lease_owner = NULL,
            last_error = ?, next_attempt_at = ?, updated_at = ?
          WHERE job_id = ?
        `).run(result.error, nextAttemptAt, result.now, jobId);
      });
    },
    waitForSource(jobId, owner, result) {
      transaction(() => {
        requireLease(jobId, owner);
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'blocked_source', lease_expires_at = NULL, lease_owner = NULL,
            last_error = ?, next_attempt_at = ?, updated_at = ?
          WHERE job_id = ?
        `).run(result.diagnostic, result.retryAt, result.updatedAt, jobId);
        database.prepare(`
          INSERT INTO automation_job_blocks(
            job_id, reason_code, context, recovery_job_ids, blocked_at, updated_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(job_id) DO UPDATE SET
            reason_code = excluded.reason_code,
            context = excluded.context,
            recovery_job_ids = excluded.recovery_job_ids,
            updated_at = excluded.updated_at,
            resolved_at = NULL
        `).run(
          jobId,
          result.reasonCode ?? "insufficient_coverage",
          JSON.stringify(result.context ?? {}),
          JSON.stringify(result.recoveryJobIds ?? []),
          result.updatedAt,
          result.updatedAt,
        );
      });
    },
    wakeBlockedSource(subjectKey, updatedAt, jobType) {
      return transaction(() => {
        const typeClause = jobType ? " AND job_type = ?" : "";
        const values = jobType ? [subjectKey, jobType] : [subjectKey];
        database.prepare(`
          UPDATE automation_job_blocks SET resolved_at = ?, updated_at = ?
          WHERE resolved_at IS NULL AND job_id IN (
            SELECT job_id FROM automation_jobs
            WHERE subject_key = ?${typeClause}
              AND status IN ('blocked_source', 'waiting_source')
          )
        `).run(updatedAt, updatedAt, ...values);
        const result = database.prepare(`
          UPDATE automation_jobs
          SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE subject_key = ?${typeClause}
            AND status IN ('blocked_source', 'waiting_source')
        `).run(updatedAt, updatedAt, ...values);
        return Number(result.changes);
      });
    },
    terminate(jobId, owner, result) {
      transaction(() => {
        requireLease(jobId, owner);
        database.prepare(`
          UPDATE automation_jobs
          SET status = 'terminal', lease_expires_at = NULL, lease_owner = NULL,
            last_error = ?, completed_at = ?, updated_at = ?
          WHERE job_id = ?
        `).run(result.reason, result.terminatedAt, result.terminatedAt, jobId);
        database.prepare(`
          UPDATE automation_job_blocks
          SET resolved_at = ?, updated_at = ?
          WHERE job_id = ? AND resolved_at IS NULL
        `).run(result.terminatedAt, result.terminatedAt, jobId);
      });
    },
    dueLanes(now, enabledJobTypes) {
      const filter = jobTypeFilter(enabledJobTypes);
      const rows = database.prepare(`
        SELECT DISTINCT lane FROM automation_jobs
        WHERE (
          (status IN ('pending', 'retryable') AND next_attempt_at <= ?)
          OR (status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
        ${filter.sql}
      `).all(now, now, ...filter.values) as Array<{ lane: AutomationLane }>;
      const present = new Set(rows.map((row) => row.lane));
      return Object.freeze(LANE_ORDER.filter((lane) => present.has(lane)));
    },
    snapshot() {
      const rows = database.prepare(`
        SELECT status, COUNT(*) AS count FROM automation_jobs GROUP BY status
      `).all() as Array<{ status: AutomationJob["status"]; count: number }>;
      const count = (status: AutomationJob["status"]): number =>
        Number(rows.find((row) => row.status === status)?.count ?? 0);
      return Object.freeze({
        pending: count("pending"),
        leased: count("leased"),
        running: count("running"),
        waitingSource: count("waiting_source"),
        blockedSource: count("blocked_source"),
        retryable: count("retryable"),
        completed: count("completed"),
        terminal: count("terminal"),
        cancelled: count("cancelled"),
      });
    },
    metrics(now, windowMs) {
      if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error("windowMs must be positive");
      const since = now - windowMs;
      const rows = database.prepare(`
        SELECT job_type AS jobType,
          SUM(CASE WHEN status IN ('pending','retryable') AND next_attempt_at <= ? THEN 1 ELSE 0 END) AS runnable,
          SUM(CASE WHEN status = 'waiting_source' THEN 1 ELSE 0 END) AS deferred,
          SUM(CASE WHEN status = 'blocked_source' THEN 1 ELSE 0 END) AS blocked,
          SUM(CASE WHEN status IN ('terminal','cancelled') THEN 1 ELSE 0 END) AS terminal
        FROM automation_jobs GROUP BY job_type
      `).all(now) as Array<{ jobType: string; runnable: number; deferred: number; blocked: number; terminal: number }>;
      const byJobType = Object.fromEntries(rows.map((row) => [row.jobType, Object.freeze({
        runnable: Number(row.runnable),
        deferred: Number(row.deferred),
        blocked: Number(row.blocked),
        terminal: Number(row.terminal),
      })]));
      const totals = rows.reduce((result, row) => ({
        runnable: result.runnable + Number(row.runnable),
        deferred: result.deferred + Number(row.deferred),
        blocked: result.blocked + Number(row.blocked),
        terminal: result.terminal + Number(row.terminal),
      }), { runnable: 0, deferred: 0, blocked: 0, terminal: 0 });
      const window = database.prepare(`
        SELECT
          SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS admitted,
          SUM(CASE WHEN completed_at >= ? AND status = 'completed' THEN 1 ELSE 0 END) AS completed,
          MIN(CASE WHEN status IN ('pending','retryable') AND next_attempt_at <= ? THEN created_at END) AS oldestCreatedAt,
          SUM(CASE WHEN job_type = 'identity_resolution' AND status NOT IN ('completed','terminal','cancelled') THEN 1 ELSE 0 END) AS manual
        FROM automation_jobs
      `).get(since, since, now) as { admitted: number | null; completed: number | null; oldestCreatedAt: number | null; manual: number | null };
      return Object.freeze({
        measuredAt: now,
        windowMs,
        ...totals,
        manual: Number(window.manual ?? 0),
        admitted: Number(window.admitted ?? 0),
        completed: Number(window.completed ?? 0),
        oldestRunnableAgeMs: window.oldestCreatedAt === null ? 0 : Math.max(0, now - Number(window.oldestCreatedAt)),
        byJobType: Object.freeze(byJobType),
      });
    },
    selectLane(available, now) {
      const eligible = new Set(available);
      if (eligible.size === 0) return null;
      return transaction(() => {
        for (const lane of LANE_ORDER) {
          database.prepare(`
            UPDATE automation_lane_state SET credit = credit + ?, updated_at = ? WHERE lane = ?
          `).run(LANE_WEIGHTS[lane], now, lane);
        }
        const credits = database.prepare(`
          SELECT lane, credit FROM automation_lane_state ORDER BY credit DESC
        `).all() as Array<{ lane: AutomationLane; credit: number }>;
        const selected = LANE_ORDER
          .filter((lane) => eligible.has(lane))
          .sort((left, right) => {
            const leftCredit = credits.find((item) => item.lane === left)?.credit ?? 0;
            const rightCredit = credits.find((item) => item.lane === right)?.credit ?? 0;
            return rightCredit - leftCredit || LANE_ORDER.indexOf(left) - LANE_ORDER.indexOf(right);
          })[0] ?? null;
        if (!selected) return null;
        database.prepare(`
          UPDATE automation_lane_state SET credit = credit - 100, updated_at = ? WHERE lane = ?
        `).run(now, selected);
        return selected;
      });
    },
  });
}
