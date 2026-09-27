import type { DuneDataApiClient } from "@address-radar/collectors";
import type { AddressRadarRepository, CandidateHistoryStore, HistoricalBackfillQueryKind } from "@address-radar/database";
import type { HistoricalBackfillPartition } from "@address-radar/database";

import { createHistoricalEvidenceService } from "./historical-evidence.js";
import type { HistoricalBackfillWorker } from "./historical-backfill.js";
import { classifyHistoricalTokenEligibility } from "./historical-token-eligibility.js";
import type { SolanaTokenSupplyProvider } from "./solana-token-supply.js";

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
const normalizeChain = (chain: string): string => chain === "ethereum" ? "eth" : chain === "bnb" || chain === "binance" ? "bsc" : chain;

export function createDuneHistoricalBackfillWorker(input: {
  readonly client: DuneDataApiClient;
  readonly repository: AddressRadarRepository;
  readonly historyStore: CandidateHistoryStore;
  readonly queryIds: Readonly<Record<HistoricalBackfillQueryKind, number>>;
  readonly pageSize: number;
  readonly strategyVersion: string;
  readonly resolveTraderId?: (chain: string, address: string) => string | null;
  readonly resolveVerifiedTokenAddresses?: (chain: string, addresses: readonly string[]) => { readonly pending: number; readonly eligible: readonly string[] };
  readonly onAcceptedUnresolvedWallet?: (input: { readonly traderId: string; readonly chain: string; readonly address: string; readonly observedAt: number }) => void;
  readonly solanaSupply?: SolanaTokenSupplyProvider;
}): HistoricalBackfillWorker {
  const evidence = createHistoricalEvidenceService({
    store: input.historyStore,
    resolveTraderId: input.resolveTraderId ?? (() => null),
    strategyVersion: input.strategyVersion,
  });
  return Object.freeze({
    async execute(partition: HistoricalBackfillPartition, signal: AbortSignal) {
      let tokenAddresses = partition.tokenAddresses;
      if (partition.queryKind !== "token_universe" && input.resolveVerifiedTokenAddresses) {
        const verification = input.resolveVerifiedTokenAddresses(partition.chain, partition.tokenAddresses);
        if (verification.pending > 0) throw new Error(`fomo_verification_pending:${verification.pending}`);
        tokenAddresses = verification.eligible;
        if (!tokenAddresses.length) return Object.freeze({ executionId: partition.executionId ?? "fomo-filtered", nextOffset: null, rowCount: partition.rowCount, watermark: partition.dayEnd, creditsUsed: 0, done: true });
      }
      const queryId = input.queryIds[partition.queryKind];
      const page = await input.client.runSavedQueryPage<Row>(queryId, {
        ...(partition.lastError ? {} : { executionId: partition.executionId }),
        offset: partition.nextOffset ?? 0,
        pageSize: input.pageSize,
        signal,
        parameters: {
          chain: partition.chain,
          start_time: new Date(partition.dayStart).toISOString(),
          end_time: new Date(partition.dayEnd).toISOString(),
          ...(partition.queryKind === "token_universe" ? {} : {
            token_addresses: JSON.stringify(tokenAddresses),
          }),
        },
      });
      const observedAt: number[] = [];
      const solanaAddresses = [...new Set(page.rows
        .filter(row => normalizeChain(requiredString(row, "chain").toLowerCase()) === "solana")
        .map(row => normalizeAddress("solana", requiredString(row, "token_address"))))];
      const solanaSupplies: ReadonlyMap<string, number> = solanaAddresses.length > 0 && input.solanaSupply
        ? await input.solanaSupply.resolveMany(solanaAddresses, signal)
        : new Map<string, number>();
      if (solanaAddresses.length > 0 && (!input.solanaSupply || solanaSupplies.size === 0)) throw new Error("solana_supply_unavailable");
      if (partition.queryKind === "token_universe") {
        for (const row of page.rows) {
          const chain = normalizeChain(requiredString(row, "chain").toLowerCase());
          const eligibility = classifyHistoricalTokenEligibility({ chain, tokenAddress: requiredString(row, "token_address"), symbol: optionalString(row, "symbol") });
          if (!eligibility.eligible) continue;
          const tokenAddress = eligibility.tokenAddress;
          const supply = chain === "solana" ? solanaSupplies.get(tokenAddress) : undefined;
          if (chain === "solana" && supply === undefined) continue;
          const peakMarketCapUsd = chain === "solana"
            ? requiredNumber(row, "peak_price_usd") * supply!
            : requiredNumber(row, "peak_market_cap_usd");
          if (peakMarketCapUsd < 1_000_000 || peakMarketCapUsd > 100_000_000_000) continue;
          const reachedAt = chain === "solana" ? timestamp(row, "peak_price_at") : timestamp(row, "first_reached_1m_at");
          observedAt.push(reachedAt);
          input.historyStore.saveHistoricalToken({
            tokenId: `${chain}:${tokenAddress}`,
            chain,
            tokenAddress,
            symbol: optionalString(row, "symbol"),
            imageUrl: optionalString(row, "image_url"),
            firstTradeAt: row.first_trade_at == null ? null : timestamp(row, "first_trade_at"),
            firstReached1mAt: reachedAt,
            peakMarketCapUsd,
            source: "dune",
            sourceQueryId: String(queryId),
            provenance: { executionId: page.executionId, partitionId: partition.partitionId },
          });
        }
      } else if (partition.queryKind === "milestone_crossings") {
        for (const row of page.rows) {
          const chain = normalizeChain(requiredString(row, "chain").toLowerCase());
          const tokenAddress = normalizeAddress(chain, requiredString(row, "token_address"));
          const crossedAt = timestamp(row, "crossed_at");
          observedAt.push(crossedAt);
          const supply = chain === "solana" ? solanaSupplies.get(tokenAddress) : undefined;
          if (chain === "solana" && supply === undefined) continue;
          const observedMarketCapUsd = chain === "solana"
            ? requiredNumber(row, "observed_price_usd") * supply!
            : requiredNumber(row, "milestone_market_cap_usd");
          const thresholds = chain === "solana"
            ? [100_000, 200_000, 300_000, 500_000, 1_000_000].filter(value => observedMarketCapUsd >= value)
            : [observedMarketCapUsd];
          for (const marketCapUsd of thresholds) input.historyStore.saveMilestoneCrossing({ milestoneId: `${chain}:${tokenAddress}:${marketCapUsd}`, tokenId: `${chain}:${tokenAddress}`, marketCapUsd, crossedAt, precision: "estimated", source: "dune", sourceEventIds: [optionalString(row, "source_reference") ?? `${page.executionId}:${crossedAt}`], strategyVersion: input.strategyVersion });
        }
      } else {
        const rows = page.rows.map((row, index) => {
          const chain = normalizeChain(requiredString(row, "chain").toLowerCase());
          const occurredAt = timestamp(row, "block_time");
          const transaction = requiredString(row, "tx_hash");
          const eventIndex = requiredNumber(row, "event_index");
          observedAt.push(occurredAt);
          const tokenAddress = normalizeAddress(chain, requiredString(row, "token_address"));
          const supply = chain === "solana" ? solanaSupplies.get(tokenAddress) : undefined;
          if (chain === "solana" && supply === undefined) return null;
          const marketCapUsd = chain === "solana" ? requiredNumber(row, "price_usd") * supply! : requiredNumber(row, "market_cap_usd");
          if (chain === "solana" && (marketCapUsd < 100_000 || marketCapUsd > 1_000_000)) return null;
          return { eventId: `dune:${chain}:${transaction}:${eventIndex}`, economicKey: `${transaction}:${eventIndex}`, chain, tokenAddress, traderAddress: normalizeAddress(chain, requiredString(row, "trader_address")), side: requiredString(row, "side").toLowerCase() === "sell" ? "sell" as const : "buy" as const, amountUsd: requiredNumber(row, "amount_usd"), marketCapUsd, occurredAt, source: `dune:${page.executionId}:${index}` };
        }).filter((row): row is NonNullable<typeof row> => row !== null);
        const result = evidence.ingest(rows, partition.dayEnd);
        for (const traderId of result.unresolvedTraderIds) {
          const [, chain, ...addressParts] = traderId.split(":");
          const address = addressParts.join(":");
          if (chain && address) input.onAcceptedUnresolvedWallet?.({ traderId, chain, address, observedAt: partition.dayEnd });
        }
      }
      const done = page.nextOffset === null;
      return Object.freeze({ executionId: page.executionId, nextOffset: page.nextOffset, rowCount: partition.rowCount + page.rows.length, watermark: done ? partition.dayEnd : Math.max(partition.watermark ?? partition.dayStart, ...observedAt), creditsUsed: partition.executionId ? 0 : 1, done });
    },
  });
}
