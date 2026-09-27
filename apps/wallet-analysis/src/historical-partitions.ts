import { createHash } from "node:crypto";

import type { HistoricalBackfillPartition, HistoricalBackfillQueryKind } from "@address-radar/database";

const DAY_MS = 24 * 60 * 60_000;

export function createHistoricalPartitions(input: {
  readonly queryKind: HistoricalBackfillQueryKind;
  readonly chains: readonly string[];
  readonly from: number;
  readonly to: number;
  readonly tokenAddressesByChain?: Readonly<Record<string, readonly string[]>>;
  readonly tokenPageSize?: number;
  readonly createdAt: number;
}): readonly HistoricalBackfillPartition[] {
  if (!(input.to > input.from)) throw new Error("Historical partition range must be positive");
  const tokenPageSize = input.tokenPageSize ?? 100;
  if (!Number.isSafeInteger(tokenPageSize) || tokenPageSize <= 0) throw new Error("Historical token page size must be positive");
  const partitions: HistoricalBackfillPartition[] = [];
  const chains = [...new Set(input.chains.map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
  for (const chain of chains) {
    const configured = input.tokenAddressesByChain?.[chain];
    const canonicalAddresses = configured === undefined ? undefined : [...new Set(configured)].sort();
    const tokenPages: readonly (readonly string[])[] = configured === undefined
      ? [[]]
      : Array.from({ length: Math.ceil(canonicalAddresses!.length / tokenPageSize) }, (_, index) => canonicalAddresses!.slice(index * tokenPageSize, (index + 1) * tokenPageSize));
    for (let dayStart = input.from; dayStart < input.to; dayStart += DAY_MS) {
      const dayEnd = Math.min(dayStart + DAY_MS, input.to);
      tokenPages.forEach((tokenAddresses, pageIndex) => {
        const pageIdentity = tokenAddresses.length === 0
          ? String(pageIndex)
          : createHash("sha256").update(tokenAddresses.join("\0")).digest("hex").slice(0, 16);
        partitions.push(Object.freeze({
        partitionId: `${input.queryKind}:${chain}:${dayStart}:${pageIdentity}`,
        queryKind: input.queryKind,
        chain,
        dayStart,
        dayEnd,
        tokenAddresses: Object.freeze([...tokenAddresses]),
        status: "pending",
        executionId: null,
        nextOffset: 0,
        rowCount: 0,
        attemptCount: 0,
        watermark: null,
        nextRetryAt: input.createdAt,
        leaseExpiresAt: null,
        lastError: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: null,
      }));
      });
    }
  }
  return Object.freeze(partitions);
}
