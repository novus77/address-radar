import type { DatabaseSync } from "node:sqlite";

export const MANUAL_IDENTITY_MIGRATION_REASON = "migrated_to_manual_queue";

export function migrateManualIdentityAutomationJobs(database: DatabaseSync, migratedAt: number): number {
  const result = database.prepare(`
    UPDATE automation_jobs
    SET status='cancelled',
      last_error=?,
      lease_expires_at=NULL,
      lease_owner=NULL,
      updated_at=?,
      completed_at=COALESCE(completed_at, ?)
    WHERE job_type='identity_resolution'
      AND status IN ('pending','leased','running','waiting_source','blocked_source','retryable')
  `).run(MANUAL_IDENTITY_MIGRATION_REASON, migratedAt, migratedAt);
  return Number(result.changes);
}
