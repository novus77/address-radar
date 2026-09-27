import type { DatabaseSync } from "node:sqlite";
import { decodePersistedRadarSignal } from "@address-radar/signal-engine";

import { initializeAddressRadarSchema } from "./schema.js";
import { initializeCandidateHistorySchema } from "./candidate-history-store.js";
import { initializeSourceLedgerSchema } from "./source-ledger-store.js";

export function migrateAddressRadarDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec("BEGIN IMMEDIATE");
  try {
    initializeAddressRadarSchema(database);
    initializeCandidateHistorySchema(database);
    initializeSourceLedgerSchema(database);
    migrateAutomationJobStatusConstraint(database);
    migrateWaitingSourceJobs(database);
    backfillTraderAutomationState(database);
    ensureColumn(database, "signal_outbox", "claim_token", "TEXT");
    ensureColumn(database, "signal_outbox", "claim_generation", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "signal_outbox", "lease_expires_at", "INTEGER");
    ensureColumn(database, "signal_outbox_migration_review", "decision", "TEXT CHECK(decision IN ('approved', 'skipped'))");
    ensureColumn(database, "signal_outbox_migration_review", "decided_by", "TEXT");
    ensureColumn(database, "signal_outbox_migration_review", "decision_reason", "TEXT");
    ensureColumn(database, "signal_outbox_migration_review", "decided_at", "INTEGER");
    ensureColumn(database, "token_evaluation_state", "bundle_diagnostics", "TEXT NOT NULL DEFAULT '{}'");
    migrateEntityAccountUniqueness(database);
    database.exec(`
      UPDATE signal_outbox_migration_review
      SET decision = 'approved', decided_by = 'legacy_migration', decision_reason = 'previously approved', decided_at = reviewed_at
      WHERE status = 'approved' AND decision IS NULL;
    `);
    database.exec(`
      INSERT OR IGNORE INTO economic_evidence_consumption(dedupe_key, broadcast_id, consumed_at)
      SELECT COALESCE(e.dedupe_key, ec.event_id), ec.broadcast_id, ec.consumed_at
      FROM evidence_consumption ec
      LEFT JOIN address_signal_evidence e ON e.event_id = ec.event_id;
    `);
    migrateHistoricalBroadcasts(database);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure if SQLite already rolled the transaction back.
    }
    throw error;
  }
}

function migrateWaitingSourceJobs(database: DatabaseSync): void {
  database.exec(`
    UPDATE automation_jobs
    SET status = 'blocked_source', lease_expires_at = NULL, lease_owner = NULL
    WHERE status = 'waiting_source';
  `);
}

function migrateAutomationJobStatusConstraint(database: DatabaseSync): void {
  const definition = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'
  `).get() as { sql: string } | undefined;
  if (!definition || definition.sql.includes("'blocked_source'")) return;

  database.exec(`
    ALTER TABLE automation_jobs RENAME TO automation_jobs_legacy_status;
    DROP INDEX IF EXISTS automation_jobs_claim;
    DROP INDEX IF EXISTS automation_jobs_subject;
    CREATE TABLE automation_jobs (
      job_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane TEXT NOT NULL CHECK(lane IN ('trader_backfill', 'token_mining', 'repair')),
      job_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'running', 'waiting_source', 'blocked_source', 'retryable', 'completed', 'terminal', 'cancelled')),
      cursor TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      lease_owner TEXT,
      payload TEXT NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    INSERT INTO automation_jobs(
      job_id, idempotency_key, lane, job_type, subject_key, priority, status,
      cursor, attempt_count, next_attempt_at, lease_expires_at, lease_owner,
      payload, last_error, created_at, updated_at, completed_at
    )
    SELECT job_id, idempotency_key, lane, job_type, subject_key, priority, status,
      cursor, attempt_count, next_attempt_at, lease_expires_at, lease_owner,
      payload, last_error, created_at, updated_at, completed_at
    FROM automation_jobs_legacy_status;
    DROP TABLE automation_jobs_legacy_status;
    CREATE INDEX automation_jobs_claim
      ON automation_jobs(lane, status, next_attempt_at, priority, created_at);
    CREATE INDEX automation_jobs_subject
      ON automation_jobs(job_type, subject_key, status);
  `);
}

function backfillTraderAutomationState(database: DatabaseSync): void {
  database.exec(`
    INSERT OR IGNORE INTO trader_coverage_state(
      trader_id, tier, coverage_state, last_covered_at,
      next_evaluation_at, strategy_version, updated_at
    )
    SELECT e.entity_id,
      CASE
        WHEN e.manual = 1 OR EXISTS (
          SELECT 1
          FROM entity_accounts ea
          JOIN leaderboard_observations lo ON lo.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id AND lo.window = '30d'
        ) THEN 'T0'
        WHEN EXISTS (
          SELECT 1 FROM entity_wallet_identities ew WHERE ew.entity_id = e.entity_id
          UNION ALL
          SELECT 1
          FROM entity_accounts ea
          JOIN wallet_identities w ON w.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id
        ) THEN CASE WHEN EXISTS (
          SELECT 1 FROM candidate_evidence_v3 ce WHERE ce.trader_id = e.entity_id
        ) THEN 'T1' ELSE 'T2' END
        ELSE 'T3'
      END,
      'unseen', NULL, 0, 'trader-automation-v1', e.updated_at
    FROM trader_entities e;

    INSERT OR IGNORE INTO trader_monitoring_policy(trader_id, policy, updated_at)
    SELECT e.entity_id,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM entity_wallet_identities ew WHERE ew.entity_id = e.entity_id
          UNION ALL
          SELECT 1
          FROM entity_accounts ea
          JOIN wallet_identities w ON w.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id
        ) THEN 'realtime'
        WHEN e.manual = 1 OR EXISTS (
          SELECT 1
          FROM entity_accounts ea
          JOIN leaderboard_observations lo ON lo.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id AND lo.window = '30d'
        ) THEN 'periodic'
        ELSE 'lightweight'
      END,
      e.updated_at
    FROM trader_entities e;
  `);
}

function migrateEntityAccountUniqueness(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS entity_account_mapping_conflicts (
      conflict_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      canonical_entity_id TEXT NOT NULL,
      removed_entity_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const mappings = database.prepare(`
    SELECT entity_id AS entityId, account_id AS accountId, confidence, source,
      first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt
    FROM entity_accounts
    ORDER BY account_id,
      CASE confidence WHEN 'confirmed' THEN 0 ELSE 1 END,
      first_observed_at,
      entity_id
  `).all() as Array<{ entityId: string; accountId: string; confidence: string; source: string; firstObservedAt: number; lastObservedAt: number }>;
  const canonical = new Map<string, string>();
  const quarantine = database.prepare(`
    INSERT OR IGNORE INTO entity_account_mapping_conflicts(
      conflict_id, account_id, canonical_entity_id, removed_entity_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const remove = database.prepare("DELETE FROM entity_accounts WHERE entity_id = ? AND account_id = ?");
  for (const mapping of mappings) {
    const owner = canonical.get(mapping.accountId);
    if (!owner) { canonical.set(mapping.accountId, mapping.entityId); continue; }
    quarantine.run(
      `entity-account-migration:${mapping.accountId}:${mapping.entityId}`,
      mapping.accountId,
      owner,
      mapping.entityId,
      JSON.stringify({ confidence: mapping.confidence, source: mapping.source, firstObservedAt: mapping.firstObservedAt, lastObservedAt: mapping.lastObservedAt }),
      mapping.lastObservedAt,
    );
    remove.run(mapping.entityId, mapping.accountId);
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS entity_accounts_account_unique ON entity_accounts(account_id)");
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateHistoricalBroadcasts(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT br.broadcast_id AS broadcastId, br.token_id AS tokenId, br.broadcast_number AS broadcastSequence,
      br.triggered_at AS triggeredAt, br.payload
    FROM broadcast_records br
    WHERE NOT EXISTS (SELECT 1 FROM signal_outbox o WHERE o.broadcast_id = br.broadcast_id)
      AND NOT EXISTS (SELECT 1 FROM signal_outbox_migration_review r WHERE r.broadcast_id = br.broadcast_id)
    ORDER BY br.triggered_at, br.broadcast_id
  `).all() as Array<{ broadcastId: string; tokenId: string; broadcastSequence: number; triggeredAt: number; payload: string }>;
  const insert = database.prepare(`
    INSERT INTO signal_outbox_migration_review(review_id, broadcast_id, token_id, broadcast_sequence, idempotency_key, payload, status, validation_status, reason, created_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  for (const row of rows) {
    try {
      const decoded = decodePersistedRadarSignal(row.payload);
      if (decoded.status === "replayed") {
        insert.run(`legacy-review:${row.broadcastId}`, row.broadcastId, row.tokenId, row.broadcastSequence, decoded.signal.idempotencyKey, JSON.stringify(decoded.signal), "legacy_review", "valid", "historical_delivery_unknown", row.triggeredAt);
      } else {
        insert.run(`legacy-review:${row.broadcastId}`, row.broadcastId, row.tokenId, row.broadcastSequence, decoded.idempotencyKey, row.payload, "dead_letter", "legacy_unreplayable", decoded.reason, row.triggeredAt);
      }
    } catch (error) {
      insert.run(`legacy-review:${row.broadcastId}`, row.broadcastId, row.tokenId, row.broadcastSequence, `legacy:${row.broadcastId}`, row.payload, "dead_letter", "invalid", error instanceof Error ? error.message : String(error), row.triggeredAt);
    }
  }
}
