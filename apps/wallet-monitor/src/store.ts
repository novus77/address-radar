import { DatabaseSync } from "node:sqlite";

import { migrateAddressRadarDatabase } from "@address-radar/database";
import type { NormalizedWalletObservation } from "./contracts.js";

export interface WalletMonitorStore {
  cursor(source: string): string | null;
  persist(source: string, observations: readonly NormalizedWalletObservation[], cursor: string | null, updatedAt: number): number;
  recordFailure(source: string, error: string, updatedAt: number): void;
  observations(): readonly NormalizedWalletObservation[];
  close(): void;
}

export function openWalletMonitorStore(databasePath: string): WalletMonitorStore {
  const database = new DatabaseSync(databasePath);
  migrateAddressRadarDatabase(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS wallet_monitor_cursors (
      source TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_monitor_observations (
      event_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      chain_family TEXT NOT NULL CHECK(chain_family IN ('evm', 'solana')),
      chain TEXT NOT NULL,
      account_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
      amount_usd REAL,
      price_usd REAL,
      market_cap_usd REAL,
      occurred_at INTEGER NOT NULL,
      collected_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wallet_monitor_observations_entity_time
      ON wallet_monitor_observations(entity_id, occurred_at);
    CREATE TABLE IF NOT EXISTS wallet_monitor_provider_status (
      source TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded')),
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  const persist = (source: string, observations: readonly NormalizedWalletObservation[], cursor: string | null, updatedAt: number): number => {
    database.exec("BEGIN IMMEDIATE");
    try {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO wallet_monitor_observations(
        event_id, source, source_reference, chain_family, chain, account_id, entity_id,
        wallet_address, token_address, side, amount_usd, price_usd, market_cap_usd,
        occurred_at, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let accepted = 0;
    for (const event of observations) {
      accepted += Number(insert.run(
        event.eventId, event.source, event.sourceReference, event.chainFamily, event.chain,
        event.accountId, event.entityId, event.walletAddress, event.tokenAddress, event.side,
        event.amountUsd, event.priceUsd, event.marketCapUsd, event.occurredAt, event.collectedAt,
      ).changes);
    }
    if (cursor !== null) {
      database.prepare(`
        INSERT INTO wallet_monitor_cursors(source, cursor, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
      `).run(source, cursor, updatedAt);
    }
    database.prepare(`
      INSERT INTO wallet_monitor_provider_status(source, status, last_error, updated_at)
      VALUES (?, 'healthy', NULL, ?)
      ON CONFLICT(source) DO UPDATE SET status = 'healthy', last_error = NULL, updated_at = excluded.updated_at
    `).run(source, updatedAt);
      database.exec("COMMIT");
      return accepted;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const store: WalletMonitorStore = {
    cursor(source) {
      const row = database.prepare("SELECT cursor FROM wallet_monitor_cursors WHERE source = ?").get(source) as { cursor: string } | undefined;
      return row?.cursor ?? null;
    },
    persist(source, observations, cursor, updatedAt) {
      return persist(source, observations, cursor, updatedAt);
    },
    recordFailure(source, error, updatedAt) {
      database.prepare(`
        INSERT INTO wallet_monitor_provider_status(source, status, last_error, updated_at)
        VALUES (?, 'degraded', ?, ?)
        ON CONFLICT(source) DO UPDATE SET status = 'degraded', last_error = excluded.last_error, updated_at = excluded.updated_at
      `).run(source, error, updatedAt);
    },
    observations() {
      const rows = database.prepare("SELECT * FROM wallet_monitor_observations ORDER BY occurred_at, event_id").all() as Record<string, unknown>[];
      return Object.freeze(rows.map(row => Object.freeze({
        eventId: row.event_id as string,
        source: row.source as string,
        sourceReference: row.source_reference as string,
        chainFamily: row.chain_family as NormalizedWalletObservation["chainFamily"],
        chain: row.chain as string,
        accountId: row.account_id as string,
        entityId: row.entity_id as string,
        walletAddress: row.wallet_address as string,
        tokenAddress: row.token_address as string,
        side: row.side as NormalizedWalletObservation["side"],
        amountUsd: row.amount_usd as number | null,
        priceUsd: row.price_usd as number | null,
        marketCapUsd: row.market_cap_usd as number | null,
        occurredAt: row.occurred_at as number,
        collectedAt: row.collected_at as number,
        cursor: "",
      })));
    },
    close() { database.close(); },
  };
  return Object.freeze(store);
}
