import type { DatabaseSync } from "node:sqlite";
import { decodePersistedRadarSignal } from "@address-radar/signal-engine";

import { initializeAddressRadarSchema } from "./schema.js";

export function migrateAddressRadarDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec("BEGIN IMMEDIATE");
  try {
    initializeAddressRadarSchema(database);
    ensureColumn(database, "signal_outbox", "claim_token", "TEXT");
    ensureColumn(database, "signal_outbox", "claim_generation", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "signal_outbox", "lease_expires_at", "INTEGER");
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
