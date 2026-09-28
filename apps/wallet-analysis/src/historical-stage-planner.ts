import type { DatabaseSync } from "node:sqlite";

import type { AddressRadarRepository, CandidateHistoryStore } from "@address-radar/database";

import { classifyHistoricalTokenEligibility } from "./historical-token-eligibility.js";
import { createHistoricalPartitions } from "./historical-partitions.js";

interface HistoricalTokenRow {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly symbol: string | null;
  readonly firstReached1mAt: number | null;
  readonly peakMarketCapUsd: number;
}

export interface HistoricalStagePlanResult {
  readonly milestoneTokenCount: number;
  readonly earlyTradeTokenCount: number;
  readonly insertedPartitionCount: number;
}

export function createHistoricalStagePlanner(input: {
  readonly database: DatabaseSync;
  readonly repository: AddressRadarRepository;
  readonly historyStore?: CandidateHistoryStore;
  readonly chains: readonly string[];
  readonly startAt: number;
  readonly now?: () => number;
  readonly tokenPageSize?: number;
}) {
  const now = input.now ?? Date.now;
  const configuredChains = new Set(input.chains.map(chain => chain.trim().toLowerCase()).filter(Boolean));
  const materializedMilestoneTokens = new Set<string>();
  const attemptedPartitionIds = new Set<string>();

  const eligibleRows = (requireMilestone: boolean): readonly HistoricalTokenRow[] => {
    const rows = input.database.prepare(`
      SELECT h.token_id AS tokenId, h.chain AS chain, h.token_address AS tokenAddress, h.symbol AS symbol,
        h.first_reached_1m_at AS firstReached1mAt, h.peak_market_cap_usd AS peakMarketCapUsd
      FROM historical_tokens h
      JOIN historical_token_verifications v ON v.token_id = h.token_id
      WHERE v.status = 'confirmed'
        AND v.exact_ca_match = 1
        AND v.history_available = 1
        ${requireMilestone ? "AND EXISTS (SELECT 1 FROM token_milestone_crossings m WHERE m.token_id = h.token_id AND m.crossed_at IS NOT NULL AND m.precision != 'unavailable')" : ""}
      ORDER BY h.chain, h.token_address
    `).all() as unknown as HistoricalTokenRow[];
    return rows.filter(row => configuredChains.has(row.chain.toLowerCase()) && classifyHistoricalTokenEligibility({
      chain: row.chain,
      tokenAddress: row.tokenAddress,
      symbol: row.symbol,
    }).eligible);
  };

  const enqueue = (queryKind: "milestone_crossings" | "pre_milestone_trades", rows: readonly HistoricalTokenRow[]): number => {
    let inserted = 0;
    const byChain = new Map<string, string[]>();
    for (const row of rows) {
      const chain = row.chain.toLowerCase();
      const addresses = byChain.get(chain) ?? [];
      addresses.push(row.tokenAddress);
      byChain.set(chain, addresses);
    }
    for (const [chain, tokenAddresses] of byChain) {
      const partitions = createHistoricalPartitions({
        queryKind,
        chains: [chain],
        from: input.startAt,
        to: now(),
        tokenAddressesByChain: { [chain]: tokenAddresses },
        ...(input.tokenPageSize === undefined ? {} : { tokenPageSize: input.tokenPageSize }),
        createdAt: now(),
      });
      for (const partition of partitions) {
        if (attemptedPartitionIds.has(partition.partitionId)) continue;
        if (input.repository.enqueueHistoricalBackfillPartition(partition).inserted) inserted += 1;
        attemptedPartitionIds.add(partition.partitionId);
      }
    }
    return inserted;
  };

  return Object.freeze({
    plan(): HistoricalStagePlanResult {
      const milestoneRows = eligibleRows(false);
      for (const row of milestoneRows) {
        if (row.firstReached1mAt === null || row.peakMarketCapUsd < 1_000_000) continue;
        if (materializedMilestoneTokens.has(row.tokenId)) continue;
        input.historyStore?.saveMilestoneCrossing({
          milestoneId: `${row.tokenId}:1000000`,
          tokenId: row.tokenId,
          marketCapUsd: 1_000_000,
          crossedAt: row.firstReached1mAt,
          precision: "estimated",
          source: "historical_token_first_reached_1m",
          sourceEventIds: [`${row.tokenId}:${row.firstReached1mAt}:1000000`],
          strategyVersion: "candidate-history-v3",
        });
        materializedMilestoneTokens.add(row.tokenId);
      }
      const earlyTradeRows = eligibleRows(true);
      return Object.freeze({
        milestoneTokenCount: milestoneRows.length,
        earlyTradeTokenCount: earlyTradeRows.length,
        insertedPartitionCount: enqueue("milestone_crossings", milestoneRows) + enqueue("pre_milestone_trades", earlyTradeRows),
      });
    },
  });
}
