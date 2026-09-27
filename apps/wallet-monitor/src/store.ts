import {
  createSourceLedgerStore,
  openAddressRadarDatabase,
  openAddressRadarRepository,
  withAddressRadarWriteTransaction,
} from "@address-radar/database";
import { sourceObservationForTraderEvent } from "@address-radar/collectors";
import type { TraderEvent } from "@address-radar/domain";

import type { NormalizedWalletObservation } from "./contracts.js";

export interface WalletMonitorProviderStatus {
  readonly source: string;
  readonly status: "healthy" | "degraded";
  readonly successfulPartitions: number;
  readonly failedPartitions: number;
  readonly lastError: string | null;
  readonly updatedAt: number;
}

export interface WalletMonitorDiagnostic {
  readonly source: string;
  readonly partitionKey: string;
  readonly reason: string;
  readonly sourceReference: string;
  readonly recordedAt: number;
}

export interface WalletMonitorStore {
  checkpoint(source: string, partitionKey: string): string | null;
  persist(source: string, partitionKey: string, observations: readonly NormalizedWalletObservation[], nextCheckpoint: string, updatedAt: number, canonicalBlocks?: readonly { readonly blockNumber: number; readonly blockHash: string }[]): number;
  recordFailure(source: string, error: string, updatedAt: number): void;
  recordProviderResult(source: string, successfulPartitionKeys: readonly string[], failures: readonly { readonly partitionKey: string; readonly error: string }[], updatedAt: number): void;
  recordDiagnostics(source: string, diagnostics: readonly { readonly partitionKey: string; readonly reason: string; readonly sourceReference: string }[], updatedAt: number): void;
  providerStatus(source: string): WalletMonitorProviderStatus | null;
  diagnostics(): readonly WalletMonitorDiagnostic[];
  observations(): readonly NormalizedWalletObservation[];
  close(): void;
}

export function openWalletMonitorStore(databasePath: string): WalletMonitorStore {
  const database = openAddressRadarDatabase(databasePath);
  const eventRepository = openAddressRadarRepository(databasePath);
  const sourceLedger = createSourceLedgerStore(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS wallet_monitor_checkpoints (
      source TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      checkpoint TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, partition_key)
    );
    CREATE TABLE IF NOT EXISTS wallet_monitor_observations (
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      chain_family TEXT NOT NULL,
      chain TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      token_address TEXT NOT NULL,
      account_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      side TEXT NOT NULL,
      amount_usd REAL,
      price_usd REAL,
      market_cap_usd REAL,
      occurred_at INTEGER NOT NULL,
      collected_at INTEGER NOT NULL,
      source_reference TEXT NOT NULL,
      PRIMARY KEY (source, event_id)
    );
    CREATE TABLE IF NOT EXISTS wallet_monitor_provider_status (
      source TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_monitor_partition_status (
      source TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      status TEXT NOT NULL,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, partition_key)
    );
    CREATE TABLE IF NOT EXISTS wallet_monitor_diagnostics (
      source TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (source, partition_key, reason, source_reference)
    );
  `);
  ensureColumn(database, "wallet_monitor_observations", "source_block_number", "INTEGER");
  ensureColumn(database, "wallet_monitor_observations", "source_block_hash", "TEXT");
  ensureColumn(database, "wallet_monitor_observations", "orphaned_at", "INTEGER");
  ensureColumn(database, "wallet_monitor_observations", "projected_at", "INTEGER");

  const transaction = <T>(operation: () => T): T =>
    withAddressRadarWriteTransaction(database, operation);

  const projectPendingObservations = (projectedAt: number): number => {
    const rows = database.prepare(`
      SELECT * FROM wallet_monitor_observations
      WHERE orphaned_at IS NULL AND projected_at IS NULL
      ORDER BY occurred_at, source, event_id
      LIMIT 500
    `).all() as WalletMonitorObservationRow[];
    const hasIdentity = database.prepare(`
      SELECT 1 AS present FROM entity_accounts
      WHERE account_id = ? AND entity_id = ?
      LIMIT 1
    `);
    let projected = 0;
    for (const row of rows) {
      if (!hasIdentity.get(row.account_id, row.entity_id)) continue;
      const event = toTraderEvent(row);
      const sourceWrite = sourceLedger.saveObservation(sourceObservationForTraderEvent(event, "rpc", {
        walletAddress: row.wallet_address,
        sourceReference: row.source_reference,
        walletMonitorSource: row.source,
        ...(row.source_block_number === null ? {} : { sourceBlockNumber: row.source_block_number }),
        ...(row.source_block_hash === null ? {} : { sourceBlockHash: row.source_block_hash }),
      }));
      if (sourceWrite.status === "conflict") continue;
      eventRepository.insertTraderEvent(event);
      database.prepare(`
        UPDATE wallet_monitor_observations SET projected_at = ?
        WHERE source = ? AND event_id = ? AND orphaned_at IS NULL
      `).run(projectedAt, row.source, row.event_id);
      projected += 1;
    }
    return projected;
  };

  return {
    checkpoint(source, partitionKey) {
      const row = database.prepare(`
        SELECT checkpoint FROM wallet_monitor_checkpoints
        WHERE source = ? AND partition_key = ?
      `).get(source, partitionKey) as { checkpoint: string } | undefined;
      return row?.checkpoint ?? null;
    },
    persist(source, partitionKey, observations, nextCheckpoint, updatedAt, canonicalBlocks = []) {
      const persisted = transaction(() => {
        for (const block of canonicalBlocks) {
          database.prepare(`
            UPDATE wallet_monitor_observations SET orphaned_at = ?
            WHERE source = ? AND source_block_number = ?
              AND source_block_hash IS NOT NULL AND source_block_hash <> ?
              AND orphaned_at IS NULL
          `).run(updatedAt, source, block.blockNumber, block.blockHash);
        }
        let inserted = 0;
        const insert = database.prepare(`
          INSERT INTO wallet_monitor_observations (
            source, event_id, chain_family, chain, wallet_address, token_address,
            account_id, entity_id, side, amount_usd, price_usd, market_cap_usd,
            occurred_at, collected_at, source_reference, source_block_number, source_block_hash, orphaned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(source, event_id) DO UPDATE SET
            chain_family = excluded.chain_family,
            chain = excluded.chain,
            wallet_address = excluded.wallet_address,
            token_address = excluded.token_address,
            account_id = excluded.account_id,
            entity_id = excluded.entity_id,
            side = excluded.side,
            amount_usd = excluded.amount_usd,
            price_usd = excluded.price_usd,
            market_cap_usd = excluded.market_cap_usd,
            occurred_at = excluded.occurred_at,
            collected_at = excluded.collected_at,
            source_reference = excluded.source_reference,
            source_block_number = excluded.source_block_number,
            source_block_hash = excluded.source_block_hash,
            orphaned_at = NULL
          WHERE wallet_monitor_observations.chain_family IS NOT excluded.chain_family
            OR wallet_monitor_observations.chain IS NOT excluded.chain
            OR wallet_monitor_observations.wallet_address IS NOT excluded.wallet_address
            OR wallet_monitor_observations.token_address IS NOT excluded.token_address
            OR wallet_monitor_observations.account_id IS NOT excluded.account_id
            OR wallet_monitor_observations.entity_id IS NOT excluded.entity_id
            OR wallet_monitor_observations.side IS NOT excluded.side
            OR wallet_monitor_observations.amount_usd IS NOT excluded.amount_usd
            OR wallet_monitor_observations.price_usd IS NOT excluded.price_usd
            OR wallet_monitor_observations.market_cap_usd IS NOT excluded.market_cap_usd
            OR wallet_monitor_observations.occurred_at IS NOT excluded.occurred_at
            OR wallet_monitor_observations.source_reference IS NOT excluded.source_reference
            OR wallet_monitor_observations.source_block_number IS NOT excluded.source_block_number
            OR wallet_monitor_observations.source_block_hash IS NOT excluded.source_block_hash
            OR wallet_monitor_observations.orphaned_at IS NOT NULL
        `);
        for (const observation of observations) {
          inserted += Number(insert.run(
            source,
            observation.eventId,
            observation.chainFamily,
            observation.chain,
            observation.walletAddress,
            observation.tokenAddress,
            observation.accountId,
            observation.entityId,
            observation.side,
            observation.amountUsd,
            observation.priceUsd,
            observation.marketCapUsd,
            observation.occurredAt,
            observation.collectedAt,
            observation.sourceReference,
            observation.sourceBlockNumber ?? null,
            observation.sourceBlockHash ?? null,
          ).changes);
        }
        database.prepare(`
          INSERT INTO wallet_monitor_checkpoints (source, partition_key, checkpoint, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(source, partition_key) DO UPDATE SET
            checkpoint = excluded.checkpoint,
            updated_at = excluded.updated_at
        `).run(source, partitionKey, nextCheckpoint, updatedAt);
        return inserted;
      });
      projectPendingObservations(updatedAt);
      return persisted;
    },
    recordFailure(source, error, updatedAt) {
      this.recordProviderResult(source, [], [{ partitionKey: "provider", error }], updatedAt);
    },
    recordProviderResult(source, successfulPartitionKeys, failures, updatedAt) {
      transaction(() => {
        const upsert = database.prepare(`
          INSERT INTO wallet_monitor_partition_status (source, partition_key, status, last_error, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source, partition_key) DO UPDATE SET
            status = excluded.status,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `);
        for (const partitionKey of successfulPartitionKeys) {
          upsert.run(source, partitionKey, "healthy", null, updatedAt);
        }
        for (const failure of failures) {
          upsert.run(source, failure.partitionKey, "degraded", failure.error, updatedAt);
        }
        const status = failures.length === 0 ? "healthy" : "degraded";
        const summary = failures.length === 0
          ? null
          : failures.map((failure) => `${failure.partitionKey}: ${failure.error}`).join("; ");
        database.prepare(`
          INSERT INTO wallet_monitor_provider_status (source, status, last_error, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET
            status = excluded.status,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `).run(source, status, summary, updatedAt);
      });
    },
    recordDiagnostics(source, diagnostics, updatedAt) {
      const insert = database.prepare(`
        INSERT OR IGNORE INTO wallet_monitor_diagnostics (
          source, partition_key, reason, source_reference, recorded_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      transaction(() => {
        for (const diagnostic of diagnostics) {
          insert.run(source, diagnostic.partitionKey, diagnostic.reason, diagnostic.sourceReference, updatedAt);
        }
      });
    },
    providerStatus(source) {
      const provider = database.prepare(`
        SELECT source, status, last_error, updated_at
        FROM wallet_monitor_provider_status WHERE source = ?
      `).get(source) as {
        source: string;
        status: "healthy" | "degraded";
        last_error: string | null;
        updated_at: number;
      } | undefined;
      if (!provider) return null;
      const counts = database.prepare(`
        SELECT
          SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS successful,
          SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS failed
        FROM wallet_monitor_partition_status
        WHERE source = ? AND updated_at = ?
      `).get(source, provider.updated_at) as { successful: number | null; failed: number | null };
      return {
        source: provider.source,
        status: provider.status,
        successfulPartitions: counts.successful ?? 0,
        failedPartitions: counts.failed ?? 0,
        lastError: provider.last_error,
        updatedAt: provider.updated_at,
      };
    },
    diagnostics() {
      return database.prepare(`
        SELECT source, partition_key, reason, source_reference, recorded_at
        FROM wallet_monitor_diagnostics ORDER BY recorded_at, source_reference
      `).all().map((row) => {
        const value = row as Record<string, unknown>;
        return {
          source: String(value.source),
          partitionKey: String(value.partition_key),
          reason: String(value.reason),
          sourceReference: String(value.source_reference),
          recordedAt: Number(value.recorded_at),
        };
      });
    },
    observations() {
      return database.prepare(`
        SELECT * FROM wallet_monitor_observations WHERE orphaned_at IS NULL ORDER BY occurred_at, event_id
      `).all().map((row) => {
        const value = row as Record<string, unknown>;
        return {
          source: String(value.source),
          eventId: String(value.event_id),
          chainFamily: value.chain_family as "evm" | "solana",
          chain: String(value.chain),
          walletAddress: String(value.wallet_address),
          tokenAddress: String(value.token_address),
          accountId: String(value.account_id),
          entityId: String(value.entity_id),
          side: value.side as "buy" | "sell",
          amountUsd: value.amount_usd === null ? null : Number(value.amount_usd),
          priceUsd: value.price_usd === null ? null : Number(value.price_usd),
          marketCapUsd: value.market_cap_usd === null ? null : Number(value.market_cap_usd),
          occurredAt: Number(value.occurred_at),
          collectedAt: Number(value.collected_at),
          sourceReference: String(value.source_reference),
          ...(value.source_block_number === null ? {} : { sourceBlockNumber: Number(value.source_block_number) }),
          ...(value.source_block_hash === null ? {} : { sourceBlockHash: String(value.source_block_hash) }),
        };
      });
    },
    close() {
      eventRepository.close();
      database.close();
    },
  };
}

function toTraderEvent(row: WalletMonitorObservationRow): TraderEvent {
  return Object.freeze({
    eventId: row.event_id,
    accountId: row.account_id,
    entityId: row.entity_id,
    chain: row.chain,
    tokenAddress: row.token_address,
    side: row.side,
    amountUsd: row.amount_usd,
    priceUsd: row.price_usd,
    marketCapUsd: row.market_cap_usd,
    tokenAgeMs: null,
    occurredAt: row.occurred_at,
    collectedAt: row.collected_at,
    source: "onchain_wallet",
  });
}

type WalletMonitorObservationRow = {
  source: string;
  event_id: string;
  chain: string;
  wallet_address: string;
  token_address: string;
  account_id: string;
  entity_id: string;
  side: "buy" | "sell";
  amount_usd: number | null;
  price_usd: number | null;
  market_cap_usd: number | null;
  occurred_at: number;
  collected_at: number;
  source_reference: string;
  source_block_number: number | null;
  source_block_hash: string | null;
};

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
import type { DatabaseSync } from "node:sqlite";
