import {
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "../packages/database/src/index.js";

const databasePath = process.env.ADDRESS_RADAR_DATABASE_PATH?.trim();
if (!databasePath) throw new Error("ADDRESS_RADAR_DATABASE_PATH is required");

const database = openAddressRadarDatabase(databasePath);
try {
  migrateAddressRadarDatabase(database, { force: true });
  const state = database.prepare(`
    SELECT schema_version AS schemaVersion, migrated_at AS migratedAt
    FROM address_radar_schema_state
    WHERE singleton = 1
  `).get();
  console.log(JSON.stringify({ status: "ok", databasePath, state }));
} finally {
  database.close();
}
