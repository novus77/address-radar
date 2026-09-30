import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "@address-radar/database";

const VERSION = "source-recovery-v2-multi-pool";
const SUPPORTED = new Set(["solana", "eth", "base", "bsc"]);

export function reconcileSourceRecoveryV2(input: {
  readonly database: DatabaseSync;
  readonly jobIds: readonly string[];
  readonly dryRun?: boolean;
  readonly now?: number;
}) {
  const ids = [...new Set(input.jobIds)];
  if (ids.length > 20 || ids.some(id => !id.trim())) throw new Error("Recovery requires at most 20 explicit nonempty job IDs");
  const db = input.database, now = input.now ?? Date.now();
  const audited = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_recovery_repair_audit'").get());
  const eligible = ids.flatMap(jobId => {
    const row = db.prepare("SELECT * FROM recovery_jobs WHERE job_id=? AND status='dead_letter' AND job_type='historical_research' AND last_error='historical_milestone_crossing_unavailable'").get(jobId);
    if (!row || !SUPPORTED.has(String(row.chain))) return [];
    if (audited && db.prepare("SELECT 1 FROM source_recovery_repair_audit WHERE job_id=? AND repair_version=?").get(jobId, VERSION)) return [];
    return [row];
  });
  if (input.dryRun !== false) return { dryRun: true, repairVersion: VERSION, eligible: eligible.map(row => String(row.job_id)), reopened: 0 };
  return withAddressRadarWriteTransaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS source_recovery_repair_audit (
      job_id TEXT NOT NULL, repair_version TEXT NOT NULL, previous_record TEXT NOT NULL, repaired_at INTEGER NOT NULL,
      PRIMARY KEY(job_id,repair_version)
    )`);
    let reopened = 0;
    for (const row of eligible) {
      const changed = db.prepare("UPDATE recovery_jobs SET status='pending',next_attempt_at=?,lease_expires_at=NULL,last_error=NULL,completed_at=NULL,updated_at=? WHERE job_id=? AND status='dead_letter' AND last_error='historical_milestone_crossing_unavailable'").run(now, now, String(row.job_id));
      if (!changed.changes) continue;
      db.prepare("INSERT INTO source_recovery_repair_audit VALUES (?,?,?,?)").run(String(row.job_id), VERSION, JSON.stringify(row), now);
      db.prepare("UPDATE recovery_fact_links SET status='pending',terminal_reason=NULL,verified_at=NULL,updated_at=? WHERE recovery_job_id=? AND status='terminal'").run(now, String(row.job_id));
      db.prepare("UPDATE token_fact_status SET status='scheduled',terminal_reason=NULL,next_attempt_at=?,revision=revision+1,strategy_version=?,updated_at=? WHERE token_id=? AND fact_type='milestone_crossings' AND status='terminal_unavailable' AND terminal_reason='historical_milestone_crossing_unavailable'").run(now, VERSION, now, String(row.subject_key));
      reopened += 1;
    }
    return { dryRun: false, repairVersion: VERSION, eligible: eligible.map(row => String(row.job_id)), reopened };
  });
}
