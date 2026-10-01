import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "./connection.js";

export const WALLET_EXECUTION_BASIS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS wallet_monitor_execution_bases (
    source TEXT NOT NULL,
    event_id TEXT NOT NULL,
    basis_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source, event_id),
    FOREIGN KEY (source, event_id) REFERENCES wallet_monitor_observations(source, event_id)
  );
`;

/** Add provenance storage without replaying unrelated legacy data migrations. */
export function migrateWalletExecutionBasis(database: DatabaseSync): void {
  withAddressRadarWriteTransaction(database, () => database.exec(WALLET_EXECUTION_BASIS_SCHEMA));
}
