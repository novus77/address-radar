import type { DatabaseSync } from "node:sqlite";

import type { AutomationJobStore } from "@address-radar/database";

import {
  canonicalHistoricalAddress,
  canonicalHistoricalChain,
  HISTORICAL_TOKEN_CHAINS,
  type HistoricalTokenCandidate,
  type HistoricalTokenChain,
  type HistoricalTokenPartition,
} from "./token-source-adapters.js";

export const HISTORICAL_TOKEN_ANCHOR_AT = Date.parse("2026-08-09T16:00:00.000Z");
const WEEK_MS = 7 * 24 * 60 * 60_000;
const RECENT_WINDOW_MS = 14 * 24 * 60 * 60_000;

export type HistoricalTokenSeed = HistoricalTokenCandidate;

export interface PlannedHistoricalTokenPartition extends HistoricalTokenPartition {
  readonly tokens: readonly (HistoricalTokenCandidate & { readonly tokenId: string })[];
}

export function partitionHistoricalTokens(
  values: readonly HistoricalTokenSeed[],
  options: { readonly anchorAt?: number } = {},
): readonly PlannedHistoricalTokenPartition[] {
  const anchorAt = options.anchorAt ?? HISTORICAL_TOKEN_ANCHOR_AT;
  const unique = new Map<string, HistoricalTokenCandidate & { tokenId: string }>();
  for (const value of values) {
    const chain = canonicalHistoricalChain(value.chain);
    if (!chain || value.firstReached1mAt < anchorAt) continue;
    const tokenAddress = canonicalHistoricalAddress(chain, value.tokenAddress);
    if (!tokenAddress) continue;
    const tokenId = `${chain}:${tokenAddress}`;
    const existing = unique.get(tokenId);
    unique.set(tokenId, {
      ...existing,
      ...value,
      chain,
      tokenAddress,
      tokenId,
      firstReached1mAt: Math.min(
        existing?.firstReached1mAt ?? value.firstReached1mAt,
        value.firstReached1mAt,
      ),
      peakMarketCapUsd: Math.max(
        existing?.peakMarketCapUsd ?? value.peakMarketCapUsd,
        value.peakMarketCapUsd,
      ),
    });
  }

  const grouped = new Map<string, Array<HistoricalTokenCandidate & { tokenId: string }>>();
  for (const token of unique.values()) {
    const weekStart = weekStartFor(token.firstReached1mAt, anchorAt);
    const key = `${token.chain}:${weekStart}`;
    grouped.set(key, [...(grouped.get(key) ?? []), token]);
  }

  const partitions: PlannedHistoricalTokenPartition[] = [];
  for (const [key, tokens] of grouped) {
    const [chain, weekStartValue] = key.split(":") as [HistoricalTokenChain, string];
    const weekStart = Number(weekStartValue);
    const ordered = tokens.sort((left, right) =>
      left.firstReached1mAt - right.firstReached1mAt
      || left.tokenId.localeCompare(right.tokenId));
    for (let offset = 0; offset < ordered.length; offset += 50) {
      const chunk = Math.floor(offset / 50);
      partitions.push(Object.freeze({
        partitionId: `${chain}:${weekStart}:${chunk}`,
        chain,
        weekStart,
        weekEnd: weekStart + WEEK_MS,
        cursor: null,
        tokens: Object.freeze(ordered.slice(offset, offset + 50)),
      }));
    }
  }
  return Object.freeze(partitions.sort((left, right) =>
    left.weekStart - right.weekStart
    || left.chain.localeCompare(right.chain)
    || left.partitionId.localeCompare(right.partitionId)));
}

export function selectHistoricalTokenMiningRound(
  partitions: readonly PlannedHistoricalTokenPartition[],
  input: { readonly capacity: number; readonly now: number },
): readonly PlannedHistoricalTokenPartition[] {
  const activeChains = HISTORICAL_TOKEN_CHAINS.filter((chain) =>
    partitions.some((partition) => partition.chain === chain));
  if (input.capacity < activeChains.length) {
    throw new Error("Capacity must reserve one slot per non-empty chain");
  }
  const selected: PlannedHistoricalTokenPartition[] = [];
  const selectedIds = new Set<string>();
  for (const chain of activeChains) {
    const partition = partitions
      .filter((candidate) => candidate.chain === chain)
      .sort((left, right) => left.weekStart - right.weekStart)[0];
    if (!partition) continue;
    selected.push(partition);
    selectedIds.add(partition.partitionId);
  }

  const remainingCapacity = input.capacity - selected.length;
  const remaining = partitions.filter((partition) => !selectedIds.has(partition.partitionId));
  const recentTarget = Math.ceil(remainingCapacity * 0.7);
  const recent = remaining
    .filter((partition) => partition.weekEnd > input.now - RECENT_WINDOW_MS)
    .sort((left, right) => right.weekStart - left.weekStart);
  for (const partition of recent.slice(0, recentTarget)) {
    selected.push(partition);
    selectedIds.add(partition.partitionId);
  }
  const rest = remaining
    .filter((partition) => !selectedIds.has(partition.partitionId))
    .sort((left, right) => left.weekStart - right.weekStart || left.chain.localeCompare(right.chain));
  selected.push(...rest.slice(0, input.capacity - selected.length));
  return Object.freeze(selected);
}

export function createTokenPartitionPlanner(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly anchorAt?: number;
  readonly roundCapacity?: number;
}) {
  const anchorAt = input.anchorAt ?? HISTORICAL_TOKEN_ANCHOR_AT;
  const roundCapacity = input.roundCapacity ?? 10;
  return Object.freeze({
    seed(now: number) {
      let inserted = 0;
      for (let weekStart = anchorAt; weekStart <= now; weekStart += WEEK_MS) {
        for (const chain of HISTORICAL_TOKEN_CHAINS) {
          const partitionId = `${chain}:${weekStart}`;
          const result = input.database.prepare(`
            INSERT OR IGNORE INTO historical_token_partitions(
              partition_id, chain, week_start, week_end, status, source_name, cursor,
              token_count, next_attempt_at, last_error, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, ?, NULL, ?, ?, NULL)
          `).run(partitionId, chain, weekStart, weekStart + WEEK_MS, now, now, now);
          inserted += Number(result.changes);
        }
      }
      const due = input.database.prepare(`
        SELECT partition_id AS partitionId, chain, week_start AS weekStart,
          week_end AS weekEnd, cursor
        FROM historical_token_partitions
        WHERE status IN ('pending', 'retryable') AND next_attempt_at <= ?
        ORDER BY week_start, chain
      `).all(now) as Array<Omit<PlannedHistoricalTokenPartition, "tokens">>;
      const planned = due.map((partition) => Object.freeze({ ...partition, tokens: Object.freeze([]) }));
      const selected = selectHistoricalTokenMiningRound(planned, {
        capacity: Math.min(roundCapacity, Math.max(HISTORICAL_TOKEN_CHAINS.length, planned.length)),
        now,
      });
      let queued = 0;
      for (const partition of selected) {
        const key = `historical-token-partition:${partition.partitionId}`;
        const result = input.jobs.enqueue({
          jobId: key,
          idempotencyKey: key,
          lane: "token_mining",
          jobType: "historical_token_partition",
          subjectKey: partition.partitionId,
          priority: partition.weekEnd > now - RECENT_WINDOW_MS ? 10 : 20,
          cursor: partition.cursor,
          nextAttemptAt: now,
          payload: JSON.stringify(partition),
          createdAt: now,
        });
        if (result.job.status === "pending" || result.job.status === "retryable") {
          input.database.prepare(`
            UPDATE historical_token_partitions
            SET status = 'queued', updated_at = ?
            WHERE partition_id = ? AND status IN ('pending', 'retryable')
          `).run(now, partition.partitionId);
          queued += 1;
        }
      }
      return Object.freeze({ inserted, queued });
    },
  });
}

function weekStartFor(timestamp: number, anchorAt: number): number {
  return anchorAt + Math.floor((timestamp - anchorAt) / WEEK_MS) * WEEK_MS;
}
