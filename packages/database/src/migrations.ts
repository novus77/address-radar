import type { DatabaseSync } from "node:sqlite";

import { initializeAddressRadarSchema } from "./schema.js";

export function migrateAddressRadarDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec("BEGIN IMMEDIATE");
  try {
    initializeAddressRadarSchema(database);
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
