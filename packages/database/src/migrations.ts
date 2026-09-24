import type { DatabaseSync } from "node:sqlite";
import { decodePersistedRadarSignal } from "@address-radar/signal-engine";

import { initializeAddressRadarSchema } from "./schema.js";
import { initializeCandidateHistorySchema } from "./candidate-history-store.js";

export function migrateAddressRadarDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec("BEGIN IMMEDIATE");
  try {
    initializeAddressRadarSchema(database);
    initializeCandidateHistorySchema(database);
    ensureColumn(database, "signal_outbox", "claim_token", "TEXT");
    ensureColumn(database, "signal_outbox", "claim_generation", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "signal_outbox", "lease_expires_at", "INTEGER");
    ensureColumn(database, "signal_outbox_migration_review", "decision", "TEXT CHECK(decision IN ('approved', 'skipped'))");
    ensureColumn(database, "signal_outbox_migration_review", "decided_by", "TEXT");
    ensureColumn(database, "signal_outbox_migration_review", "decision_reason", "TEXT");
    ensureColumn(database, "signal_outbox_migration_review", "decided_at", "INTEGER");
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
