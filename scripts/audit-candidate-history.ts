import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { migrateAddressRadarDatabase } from "@address-radar/database";

export interface CandidateHistoryAuditReport {
  readonly ok: boolean;
  readonly auditedAt: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly watermarks: readonly Readonly<Record<string, unknown>>[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

const tableExists = (database: DatabaseSync, table: string): boolean => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const scalar = (database: DatabaseSync, sql: string): number => Number((database.prepare(sql).get() as { value: number | null }).value ?? 0);

export function auditCandidateHistory(database: DatabaseSync, input: {
  readonly now: number;
  readonly deliveryEnabled: boolean;
  readonly staleLeaseGraceMs: number;
}): CandidateHistoryAuditReport {
  const hasPartitions = tableExists(database, "historical_backfill_partitions");
  const hasWatermarks = tableExists(database, "historical_backfill_watermarks");
  const hasReEvaluations = tableExists(database, "historical_re_evaluation_requests");
  const counts = Object.freeze({
    historicalTokens: tableExists(database, "historical_tokens") ? scalar(database, "SELECT COUNT(*) AS value FROM historical_tokens") : 0,
    milestoneCrossings: tableExists(database, "token_milestone_crossings") ? scalar(database, "SELECT COUNT(*) AS value FROM token_milestone_crossings") : 0,
    candidateEvidence: tableExists(database, "candidate_evidence_v3") ? scalar(database, "SELECT COUNT(*) AS value FROM candidate_evidence_v3") : 0,
    admissionSnapshots: tableExists(database, "candidate_admission_snapshots") ? scalar(database, "SELECT COUNT(*) AS value FROM candidate_admission_snapshots") : 0,
    orphanEvidence: tableExists(database, "candidate_evidence_v3") && tableExists(database, "historical_tokens")
      ? scalar(database, "SELECT COUNT(*) AS value FROM candidate_evidence_v3 e WHERE NOT EXISTS (SELECT 1 FROM historical_tokens t WHERE t.token_id = e.token_id) OR NOT EXISTS (SELECT 1 FROM token_milestone_crossings m WHERE m.milestone_id = e.milestone_id)")
      : 0,
    pendingPartitions: hasPartitions ? scalar(database, "SELECT COUNT(*) AS value FROM historical_backfill_partitions WHERE status = 'pending'") : 0,
    runningPartitions: hasPartitions ? scalar(database, "SELECT COUNT(*) AS value FROM historical_backfill_partitions WHERE status = 'running'") : 0,
    failedPartitions: hasPartitions ? scalar(database, "SELECT COUNT(*) AS value FROM historical_backfill_partitions WHERE status = 'failed'") : 0,
    staleRunningPartitions: hasPartitions ? Number((database.prepare("SELECT COUNT(*) AS value FROM historical_backfill_partitions WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at + ? < ?").get(input.staleLeaseGraceMs, input.now) as { value: number | null }).value ?? 0) : 0,
    pendingReEvaluations: hasReEvaluations ? scalar(database, "SELECT COUNT(*) AS value FROM historical_re_evaluation_requests WHERE status IN ('pending', 'running')") : 0,
    failedReEvaluations: hasReEvaluations ? scalar(database, "SELECT COUNT(*) AS value FROM historical_re_evaluation_requests WHERE status = 'failed'") : 0,
  });
  const watermarks = hasWatermarks
    ? database.prepare("SELECT chain, query_kind AS queryKind, watermark, updated_at AS updatedAt FROM historical_backfill_watermarks ORDER BY chain, query_kind").all() as Readonly<Record<string, unknown>>[]
    : [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (input.deliveryEnabled) blockers.push("gateway_delivery_enabled_during_shadow");
  if (counts.orphanEvidence > 0) blockers.push("orphan_candidate_evidence");
  if (counts.staleRunningPartitions > 0) blockers.push("stale_running_partitions");
  if (counts.failedPartitions > 0) blockers.push("failed_historical_partitions");
  if (counts.failedReEvaluations > 0) blockers.push("failed_re_evaluations");
  if (counts.historicalTokens === 0) warnings.push("historical_token_inventory_empty");
  if (counts.historicalTokens > 0 && watermarks.length === 0) warnings.push("historical_watermarks_missing");
  if (counts.pendingPartitions > 0 || counts.runningPartitions > 0) warnings.push("historical_backfill_in_progress");
  if (counts.pendingReEvaluations > 0) warnings.push("re_evaluation_in_progress");
  return Object.freeze({ ok: blockers.length === 0, auditedAt: input.now, counts, watermarks: Object.freeze(watermarks.map(item => Object.freeze(item))), blockers: Object.freeze(blockers), warnings: Object.freeze(warnings) });
}

async function main(): Promise<void> {
  const databasePath = process.argv[2] ?? process.env.ADDRESS_RADAR_DATABASE_PATH;
  if (!databasePath) throw new Error("Database path is required as argv[2] or ADDRESS_RADAR_DATABASE_PATH");
  const database = new DatabaseSync(databasePath);
  try {
    migrateAddressRadarDatabase(database);
    const report = auditCandidateHistory(database, {
      now: Date.now(),
      deliveryEnabled: process.env.ADDRESS_RADAR_GATEWAY_DELIVERY_ENABLED === "true",
      staleLeaseGraceMs: 5 * 60_000,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
