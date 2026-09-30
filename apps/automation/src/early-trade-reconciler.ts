import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AutomationJobStore, TokenFactStore } from "@address-radar/database";
import { withAddressRadarWriteTransaction } from "@address-radar/database";

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
  readonly transactionHash: string | null;
  readonly executionIndex: string | null;
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
  const transactionHash = [record.transactionHash, record.txHash, record.signature].find(value => typeof value === "string" && value.trim());
  const executionIndex = record.logIndex ?? record.eventIndex;
  return {
    eventId: typeof record.eventId === "string" ? record.eventId : row.sourceEventId,
    entityId,
    tokenAddress: normalizeAddress(row.chain, tokenAddress),
    side,
    amountUsd: typeof record.amountUsd === "number" && Number.isFinite(record.amountUsd) ? record.amountUsd : null,
    occurredAt,
    transactionHash: typeof transactionHash === "string" ? normalizeAddress(row.chain, transactionHash) : null,
    executionIndex: typeof executionIndex === "string" || typeof executionIndex === "number" ? String(executionIndex) : null,
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
      return withAddressRadarWriteTransaction(input.database, () => {
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

        const matched = input.database.prepare(`
          SELECT c.canonical_event_id AS canonicalEventId, c.source_status AS sourceStatus,
            r.event_id AS eventId, r.source_family AS sourceFamily, r.payload
          FROM canonical_trader_events c
          JOIN canonical_trader_event_observations link ON link.canonical_event_id=c.canonical_event_id
          JOIN raw_trader_observations r ON r.observation_id=link.observation_id
          WHERE c.entity_id=? AND c.chain=? AND c.token_address=? AND c.side=?
        `).all(trade.entityId, row.chain, trade.tokenAddress, trade.side) as Array<{ canonicalEventId: string; sourceStatus: string; eventId: string; sourceFamily: string; payload: string }>;
        const incomingFamily = row.source.startsWith("rpc_") ? "onchain" : "fomo";
        const existing = matched.find(candidate => {
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(candidate.payload) as Record<string, unknown>; } catch { return false; }
          const hash = [payload.transactionHash, payload.txHash, payload.signature].find(value => typeof value === "string" && value.trim());
          if (trade.transactionHash && typeof hash === "string") {
            const index = payload.logIndex ?? payload.eventIndex;
            return normalizeAddress(row.chain, hash) === trade.transactionHash && (index === undefined || index === null ? null : String(index)) === trade.executionIndex;
          }
          return !trade.transactionHash && candidate.sourceFamily === incomingFamily && candidate.eventId === trade.eventId;
        });
        const eventId = existing?.canonicalEventId ?? canonicalEventId([
          trade.entityId, row.chain, trade.tokenAddress, trade.side,
          trade.transactionHash ? [trade.transactionHash, trade.executionIndex] : [incomingFamily, trade.eventId],
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
        if (fact.status === "terminal_unavailable") input.facts.transition({ tokenId, factType: "early_trades", status: "scheduled", reopenTerminal: true, terminalReason: null, strategyVersion: "early-trade-reconciliation-v1", updatedAt: now() });
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
      });
    },
  });
}
