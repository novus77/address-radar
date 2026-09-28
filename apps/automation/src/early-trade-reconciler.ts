import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AutomationJobStore, TokenFactStore } from "@address-radar/database";

export interface EarlyTradeReconciliationResult {
  readonly examined: number;
  readonly canonicalEventsInserted: number;
  readonly earlyTradeFactsProduced: number;
  readonly skipped: number;
  readonly hasMore: boolean;
}

interface ParsedTrade {
  readonly eventId: string;
  readonly entityId: string;
  readonly tokenAddress: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number | null;
  readonly occurredAt: number;
}

interface ObservationRow {
  readonly observationId: string;
  readonly source: string;
  readonly sourceEventId: string;
  readonly chain: string;
  readonly observedAt: number;
  readonly collectedAt: number;
  readonly payload: string;
}

const canonicalEventId = (parts: readonly unknown[]): string =>
  `canonical-reconciled-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;

const normalizeAddress = (chain: string, address: string): string =>
  chain === "solana" ? address.trim() : address.trim().toLowerCase();

function parseTrade(row: ObservationRow): ParsedTrade | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const entityId = typeof record.entityId === "string"
    ? record.entityId
    : typeof record.traderId === "string" ? record.traderId : null;
  const tokenAddress = typeof record.tokenAddress === "string" ? record.tokenAddress : null;
  const side = record.side === "buy" || record.side === "sell" ? record.side : null;
  const occurredAt = typeof record.occurredAt === "number" && Number.isFinite(record.occurredAt)
    ? record.occurredAt
    : row.observedAt;
  if (!entityId || !tokenAddress || !side || occurredAt < 0) return null;
  return {
    eventId: typeof record.eventId === "string" ? record.eventId : row.sourceEventId,
    entityId,
    tokenAddress: normalizeAddress(row.chain, tokenAddress),
    side,
    amountUsd: typeof record.amountUsd === "number" && Number.isFinite(record.amountUsd) ? record.amountUsd : null,
    occurredAt,
  };
}

export function initializeEarlyTradeReconciliationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS early_trade_reconciliation_state (
      state_id TEXT PRIMARY KEY CHECK(state_id = 'source_observations'),
      cursor_collected_at INTEGER NOT NULL,
      cursor_observation_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO early_trade_reconciliation_state(
      state_id, cursor_collected_at, cursor_observation_id, updated_at
    ) VALUES ('source_observations', 0, '', 0);
  `);
}

export function createEarlyTradeReconciler(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly facts: TokenFactStore;
  readonly now?: () => number;
  readonly batchSize?: number;
}) {
  const now = input.now ?? Date.now;
  const batchSize = input.batchSize ?? 100;
  initializeEarlyTradeReconciliationSchema(input.database);

  return Object.freeze({
    runOnce(): EarlyTradeReconciliationResult {
      const cursor = input.database.prepare(`
        SELECT cursor_collected_at AS collectedAt, cursor_observation_id AS observationId
        FROM early_trade_reconciliation_state WHERE state_id='source_observations'
      `).get() as { collectedAt: number; observationId: string };
      const rows = input.database.prepare(`
        SELECT observation_id AS observationId, source, source_event_id AS sourceEventId,
          chain, observed_at AS observedAt, collected_at AS collectedAt, payload
        FROM source_observations
        WHERE collected_at > ? OR (collected_at = ? AND observation_id > ?)
        ORDER BY collected_at, observation_id
        LIMIT ?
      `).all(cursor.collectedAt, cursor.collectedAt, cursor.observationId, batchSize) as unknown as ObservationRow[];

      let canonicalEventsInserted = 0;
      let earlyTradeFactsProduced = 0;
      let skipped = 0;
      for (const row of rows) {
        const trade = parseTrade(row);
        const entityExists = trade && input.database.prepare(
          "SELECT 1 AS present FROM trader_entities WHERE entity_id=?",
        ).get(trade.entityId);
        if (!trade || !entityExists) {
          skipped += 1;
          continue;
        }

        const existing = input.database.prepare(`
          SELECT canonical_event_id AS canonicalEventId, source_status AS sourceStatus
          FROM canonical_trader_events
          WHERE entity_id=? AND chain=? AND token_address=? AND side=?
            AND occurred_at BETWEEN ? AND ?
          ORDER BY ABS(occurred_at - ?) LIMIT 1
        `).get(
          trade.entityId, row.chain, trade.tokenAddress, trade.side,
          trade.occurredAt - 10_000, trade.occurredAt + 10_000, trade.occurredAt,
        ) as { canonicalEventId: string; sourceStatus: string } | undefined;
        const eventId = existing?.canonicalEventId ?? canonicalEventId([
          trade.entityId, row.chain, trade.tokenAddress, trade.side, trade.occurredAt,
        ]);
        const incomingStatus = row.source.startsWith("rpc_") ? "ONCHAIN_ONLY" : "FOMO_ONLY";
        const sourceStatus = existing && existing.sourceStatus !== incomingStatus ? "FOMO_AND_ONCHAIN" : incomingStatus;

        input.database.prepare(`
          INSERT OR IGNORE INTO raw_trader_observations(
            observation_id, event_id, entity_id, source_family, chain, token_address,
            side, amount_usd, occurred_at, payload, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.observationId, trade.eventId, trade.entityId,
          row.source.startsWith("rpc_") ? "onchain" : "fomo",
          row.chain, trade.tokenAddress, trade.side, trade.amountUsd,
          trade.occurredAt, row.payload, row.collectedAt,
        );
        const insert = input.database.prepare(`
          INSERT OR IGNORE INTO canonical_trader_events(
            canonical_event_id, entity_id, chain, token_address, side,
            amount_usd, occurred_at, source_status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eventId, trade.entityId, row.chain, trade.tokenAddress, trade.side,
          trade.amountUsd, trade.occurredAt, sourceStatus, row.collectedAt,
        );
        if (insert.changes === 1) canonicalEventsInserted += 1;
        if (existing && existing.sourceStatus !== sourceStatus) {
          input.database.prepare(`
            UPDATE canonical_trader_events SET source_status=?, updated_at=MAX(updated_at, ?)
            WHERE canonical_event_id=?
          `).run(sourceStatus, row.collectedAt, eventId);
        }
        input.database.prepare(`
          INSERT OR IGNORE INTO canonical_trader_event_observations(canonical_event_id, observation_id)
          VALUES (?, ?)
        `).run(eventId, row.observationId);

        if (trade.side !== "buy") continue;
        const tokenId = `${row.chain}:${trade.tokenAddress}`;
        const milestone = input.database.prepare(`
          SELECT MIN(crossed_at) AS crossedAt FROM token_milestone_crossings
          WHERE token_id=? AND precision!='unavailable' AND crossed_at IS NOT NULL
        `).get(tokenId) as { crossedAt: number | null };
        if (milestone.crossedAt === null || trade.occurredAt > milestone.crossedAt) continue;
        input.facts.ensure(tokenId, "early_trades", "early-trade-reconciliation-v1", now());
        const fact = input.facts.fact(tokenId, "early_trades")!;
        if (fact.status !== "available") {
          input.facts.transition({
            tokenId, factType: "early_trades", status: "available", precision: "exact",
            primarySource: "canonical_trader_events", coverageStartAt: trade.occurredAt,
            coverageEndAt: milestone.crossedAt, observedAt: trade.occurredAt,
            knownAt: now(), nextAttemptAt: null, terminalReason: null,
            strategyVersion: "early-trade-reconciliation-v1", updatedAt: now(),
          });
          earlyTradeFactsProduced += 1;
          input.jobs.wakeBlockedSource(tokenId, now(), "candidate_evidence");
        }
      }

      const last = rows.at(-1);
      if (last) input.database.prepare(`
        UPDATE early_trade_reconciliation_state
        SET cursor_collected_at=?, cursor_observation_id=?, updated_at=?
        WHERE state_id='source_observations'
      `).run(last.collectedAt, last.observationId, now());
      return Object.freeze({
        examined: rows.length,
        canonicalEventsInserted,
        earlyTradeFactsProduced,
        skipped,
        hasMore: rows.length === batchSize,
      });
    },
  });
}
