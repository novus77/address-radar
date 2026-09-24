import { DatabaseSync } from "node:sqlite";

import type { ChainFamily, TraderLifecycle } from "@address-radar/domain";
import { migrateAddressRadarDatabase } from "@address-radar/database";

export interface MonitoredWallet {
  readonly address: string;
  readonly accountId: string;
  readonly entityId: string;
  readonly lifecycle: TraderLifecycle;
}

export interface MonitoringRegistry {
  version(): number;
  wallets(chainFamily: ChainFamily): readonly MonitoredWallet[];
  acknowledge(consumer: string, version: number, appliedAt: number): void;
  close(): void;
}

export function openMonitoringRegistry(databasePath: string): MonitoringRegistry {
  const database = new DatabaseSync(databasePath);
  migrateAddressRadarDatabase(database);

  const registry: MonitoringRegistry = {
    version() {
      const row = database.prepare(
        "SELECT version FROM monitoring_registry_state WHERE singleton = 1",
      ).get() as { version: number };
      return row.version;
    },

    wallets(chainFamily) {
      const rows = database.prepare(`
        SELECT w.address, w.account_id AS accountId, e.entity_id AS entityId, e.lifecycle
        FROM wallet_identities w
        JOIN entity_accounts ea ON ea.account_id = w.account_id
        JOIN trader_entities e ON e.entity_id = ea.entity_id
        WHERE w.chain_family = ? AND e.lifecycle != 'suspended'
        ORDER BY e.entity_id, w.address
      `).all(chainFamily) as Array<{
        address: string;
        accountId: string;
        entityId: string;
        lifecycle: TraderLifecycle;
      }>;
      return Object.freeze(rows.map((row) => Object.freeze({
        ...row,
        address: chainFamily === "evm" ? row.address.toLowerCase() : row.address,
      })));
    },

    acknowledge(consumer, version, appliedAt) {
      if (!consumer.trim()) throw new Error("consumer is required");
      if (!Number.isSafeInteger(version) || version < 0) throw new Error("version must be a non-negative safe integer");
      if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) throw new Error("appliedAt must be a non-negative safe integer");
      database.prepare(`
        INSERT INTO monitoring_registry_consumers(consumer, applied_version, applied_at)
        VALUES (?, ?, ?)
        ON CONFLICT(consumer) DO UPDATE SET
          applied_version = MAX(monitoring_registry_consumers.applied_version, excluded.applied_version),
          applied_at = MAX(monitoring_registry_consumers.applied_at, excluded.applied_at)
      `).run(consumer, version, appliedAt);
    },

    close() {
      database.close();
    },
  };
  return Object.freeze(registry);
}
