import type { DatabaseSync } from "node:sqlite";

import { initializeAddressRadarSchema } from "./schema.js";

export function migrateAddressRadarDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec("BEGIN IMMEDIATE");
  try {
    initializeAddressRadarSchema(database);
    database.exec(`
      INSERT OR IGNORE INTO economic_evidence_consumption(dedupe_key, broadcast_id, consumed_at)
      SELECT COALESCE(e.dedupe_key, ec.event_id), ec.broadcast_id, ec.consumed_at
      FROM evidence_consumption ec
      LEFT JOIN address_signal_evidence e ON e.event_id = ec.event_id;
    `);
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
