import type { DuneDataApiClient } from "@address-radar/collectors";
import type { AddressRadarRepository, CandidateHistoryStore, HistoricalBackfillQueryKind } from "@address-radar/database";
import type { HistoricalBackfillPartition } from "@address-radar/database";

import { createHistoricalEvidenceService } from "./historical-evidence.js";
import type { HistoricalBackfillWorker } from "./historical-backfill.js";

type Row = Readonly<Record<string, unknown>>;

const requiredString = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Dune row is missing ${key}`);
  return value.trim();
};
const optionalString = (row: Row, key: string): string | null => typeof row[key] === "string" && row[key].trim() ? row[key].trim() : null;
const requiredNumber = (row: Row, key: string): number => {
  const value = typeof row[key] === "number" ? row[key] : Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`Dune row has invalid ${key}`);
  return value;
};
const timestamp = (row: Row, key: string): number => {
  const value = row[key];
  const parsed = typeof value === "number" ? (value < 10_000_000_000 ? value * 1_000 : value) : Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(`Dune row has invalid ${key}`);
  return parsed;
};
const normalizeAddress = (chain: string, address: string): string => chain === "solana" ? address.trim() : address.trim().toLowerCase();

export function createDuneHistoricalBackfillWorker(input: {
  readonly client: DuneDataApiClient;
  readonly repository: AddressRadarRepository;
  readonly historyStore: CandidateHistoryStore;
  readonly queryIds: Readonly<Record<HistoricalBackfillQueryKind, number>>;
  readonly pageSize: number;
  readonly strategyVersion: string;
  readonly resolveTraderId?: (chain: string, address: string) => string | null;
}): HistoricalBackfillWorker {
  const evidence = createHistoricalEvidenceService({
    store: input.historyStore,
    resolveTraderId: input.resolveTraderId ?? (() => null),
    strategyVersion: input.strategyVersion,
  });
  return Object.freeze({
    async execute(partition: HistoricalBackfillPartition, signal: AbortSignal) {
      const queryId = input.queryIds[partition.queryKind];
      const page = await input.client.runSavedQueryPage<Row>(queryId, {
        executionId: partition.executionId,
        offset: partition.nextOffset ?? 0,
        pageSize: input.pageSize,
        signal,
        parameters: {
          chain: partition.chain,
          start_time: new Date(partition.dayStart).toISOString(),
          end_time: new Date(partition.dayEnd).toISOString(),
          token_addresses: JSON.stringify(partition.tokenAddresses),
        },
      });
      const observedAt: number[] = [];
      if (partition.queryKind === "token_universe") {
        for (const row of page.rows) {
          const chain = requiredString(row, "chain").toLowerCase();
          const tokenAddress = normalizeAddress(chain, requiredString(row, "token_address"));
          const reachedAt = timestamp(row, "first_reached_1m_at");
          observedAt.push(reachedAt);
          input.historyStore.saveHistoricalToken({
            tokenId: `${chain}:${tokenAddress}`,
            chain,
            tokenAddress,
            symbol: optionalString(row, "symbol"),
            imageUrl: optionalString(row, "image_url"),
            firstTradeAt: row.first_trade_at == null ? null : timestamp(row, "first_trade_at"),
            firstReached1mAt: reachedAt,
            peakMarketCapUsd: requiredNumber(row, "peak_market_cap_usd"),
            source: "dune",
            sourceQueryId: String(queryId),
            provenance: { executionId: page.executionId, partitionId: partition.partitionId },
          });
        }
      } else if (partition.queryKind === "milestone_crossings") {
        for (const row of page.rows) {
          const chain = requiredString(row, "chain").toLowerCase();
          const tokenAddress = normalizeAddress(chain, requiredString(row, "token_address"));
          const marketCapUsd = requiredNumber(row, "milestone_market_cap_usd");
          const crossedAt = timestamp(row, "crossed_at");
          observedAt.push(crossedAt);
          input.historyStore.saveMilestoneCrossing({ milestoneId: `${chain}:${tokenAddress}:${marketCapUsd}`, tokenId: `${chain}:${tokenAddress}`, marketCapUsd, crossedAt, precision: optionalString(row, "precision") === "estimated" ? "estimated" : "exact", source: "dune", sourceEventIds: [optionalString(row, "source_reference") ?? `${page.executionId}:${crossedAt}`], strategyVersion: input.strategyVersion });
        }
      } else {
        const rows = page.rows.map((row, index) => {
          const chain = requiredString(row, "chain").toLowerCase();
          const occurredAt = timestamp(row, "block_time");
          const transaction = requiredString(row, "tx_hash");
          const eventIndex = requiredNumber(row, "event_index");
          observedAt.push(occurredAt);
          return { eventId: `dune:${chain}:${transaction}:${eventIndex}`, economicKey: `${transaction}:${eventIndex}`, chain, tokenAddress: normalizeAddress(chain, requiredString(row, "token_address")), traderAddress: normalizeAddress(chain, requiredString(row, "trader_address")), side: requiredString(row, "side").toLowerCase() === "sell" ? "sell" as const : "buy" as const, amountUsd: requiredNumber(row, "amount_usd"), marketCapUsd: requiredNumber(row, "market_cap_usd"), occurredAt, source: `dune:${page.executionId}:${index}` };
        });
        evidence.ingest(rows, partition.dayEnd);
      }
      const done = page.nextOffset === null;
      return Object.freeze({ executionId: page.executionId, nextOffset: page.nextOffset, rowCount: partition.rowCount + page.rows.length, watermark: done ? partition.dayEnd : Math.max(partition.watermark ?? partition.dayStart, ...observedAt), creditsUsed: partition.executionId ? 0 : 1, done });
    },
  });
}
