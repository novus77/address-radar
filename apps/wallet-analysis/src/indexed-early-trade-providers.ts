import {
  extractSolanaSwapEvidence,
  type DiscoveryChain,
  type FetchLike,
  type GeckoTerminalClient,
  type SolanaSwapTransaction,
} from "@address-radar/collectors";

import type { AnalysisRpcClient } from "./history.js";
import type {
  EarlyTradeProvider,
  EarlyTradeRecoveryResult,
  RecoverEarlyTradesInput,
} from "./gecko-early-trade-provider.js";
import type { HistoricalTradeEvidenceRow } from "./historical-evidence.js";

type EvmDiscoveryChain = Exclude<DiscoveryChain, "solana">;

interface BlockscoutTransfer {
  readonly from?: { readonly hash?: unknown };
  readonly to?: { readonly hash?: unknown };
  readonly tx_hash?: unknown;
  readonly timestamp?: unknown;
  readonly total?: { readonly value?: unknown; readonly decimals?: unknown };
}

interface SolanaSignatureRecord {
  readonly signature: string;
  readonly blockTime?: number | null;
}

interface PricePoint {
  readonly timestamp: number;
  readonly priceUsd: number;
}

const normalize = (chain: DiscoveryChain, address: string): string => chain === "solana" ? address : address.toLowerCase();
const finite = (value: unknown): number | null => {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};

async function priceHistory(input: {
  readonly client: GeckoTerminalClient;
  readonly chain: DiscoveryChain;
  readonly poolAddress: string;
  readonly tokenSide: "base" | "quote";
  readonly from: number;
  readonly to: number;
  readonly signal?: AbortSignal;
}): Promise<readonly PricePoint[]> {
  const points = new Map<number, PricePoint>();
  let beforeTimestamp = input.to;
  for (let page = 0; page < 4; page += 1) {
    const candles = await input.client.ohlcv(input.chain, input.poolAddress, {
      timeframe: "hour",
      tokenSide: input.tokenSide,
      beforeTimestamp,
      limit: 1000,
    }, input.signal);
    if (!candles.length) break;
    for (const candle of candles) points.set(candle.timestamp, { timestamp: candle.timestamp, priceUsd: candle.close });
    const oldest = Math.min(...candles.map((candle) => candle.timestamp));
    if (oldest <= input.from || candles.length < 1000) break;
    beforeTimestamp = oldest - 1;
  }
  return Object.freeze([...points.values()].sort((left, right) => left.timestamp - right.timestamp));
}

function priceAt(points: readonly PricePoint[], timestamp: number): number | null {
  let selected: PricePoint | null = null;
  for (const point of points) {
    if (point.timestamp > timestamp) break;
    selected = point;
  }
  return selected?.priceUsd ?? points.find((point) => point.timestamp <= timestamp + 60 * 60 * 1000)?.priceUsd ?? null;
}

function supplyFromPool(pool: { readonly tokenPriceUsd: number; readonly marketCapUsd: number | null; readonly fdvUsd: number | null }): number | null {
  const value = pool.marketCapUsd ?? pool.fdvUsd;
  if (value === null || pool.tokenPriceUsd <= 0) return null;
  const supply = value / pool.tokenPriceUsd;
  return Number.isFinite(supply) && supply > 0 ? supply : null;
}

export function createBlockscoutEarlyTradeProvider(input: {
  readonly gecko: GeckoTerminalClient;
  readonly endpoints: Readonly<Partial<Record<EvmDiscoveryChain, string>>>;
  readonly fetch?: FetchLike;
  readonly maxPages?: number;
}): EarlyTradeProvider {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const maxPages = input.maxPages ?? 20;
  return Object.freeze({
    async recover(request: RecoverEarlyTradesInput) {
      if (request.chain === "solana") return emptyResult("not_found");
      const endpoint = input.endpoints[request.chain];
      if (!endpoint) return emptyResult("not_found");
      const pool = await input.gecko.topPool(request.chain, request.tokenAddress, request.signal);
      if (!pool) return emptyResult("not_found");
      const supply = supplyFromPool(pool);
      if (supply === null) return emptyResult("not_found", pool.poolAddress);
      const prices = await priceHistory({ client: input.gecko, chain: request.chain, poolAddress: pool.poolAddress, tokenSide: pool.tokenSide, from: request.fromTimestamp, to: request.toTimestamp, ...(request.signal ? { signal: request.signal } : {}) });
      const trades: HistoricalTradeEvidenceRow[] = [];
      let nextParams: Readonly<Record<string, unknown>> | null = {};
      let complete = false;
      let coverageStartAt: number | null = null;
      let coverageEndAt: number | null = null;
      for (let page = 0; page < maxPages && nextParams !== null; page += 1) {
        const url = new URL(`/api/v2/tokens/${encodeURIComponent(request.tokenAddress)}/transfers`, endpoint);
        url.searchParams.set("type", "ERC-20");
        for (const [key, value] of Object.entries(nextParams)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
        const response = await fetchImpl(url, { headers: { Accept: "application/json" }, ...(request.signal ? { signal: request.signal } : {}) });
        if (!response.ok) throw new Error(`Blockscout request failed with status ${response.status}`);
        const payload = await response.json() as { readonly items?: readonly BlockscoutTransfer[]; readonly next_page_params?: Readonly<Record<string, unknown>> | null };
        const items = payload.items ?? [];
        for (const transfer of items) {
          const occurredAt = typeof transfer.timestamp === "string" ? Date.parse(transfer.timestamp) : Number.NaN;
          if (!Number.isFinite(occurredAt)) continue;
          coverageStartAt = coverageStartAt === null ? occurredAt : Math.min(coverageStartAt, occurredAt);
          coverageEndAt = coverageEndAt === null ? occurredAt : Math.max(coverageEndAt, occurredAt);
          if (occurredAt < request.fromTimestamp) { complete = true; continue; }
          if (occurredAt > request.toTimestamp) continue;
          const from = typeof transfer.from?.hash === "string" ? normalize(request.chain, transfer.from.hash) : null;
          const to = typeof transfer.to?.hash === "string" ? normalize(request.chain, transfer.to.hash) : null;
          const normalizedPool = normalize(request.chain, pool.poolAddress);
          const side = from === normalizedPool ? "buy" : to === normalizedPool ? "sell" : null;
          const traderAddress = side === "buy" ? to : side === "sell" ? from : null;
          const transactionHash = typeof transfer.tx_hash === "string" ? transfer.tx_hash : null;
          const rawValue = finite(transfer.total?.value);
          const decimals = finite(transfer.total?.decimals);
          const tokenPriceUsd = priceAt(prices, occurredAt);
          if (!side || !traderAddress || !transactionHash || rawValue === null || decimals === null || tokenPriceUsd === null) continue;
          const tokenAmount = rawValue / 10 ** decimals;
          trades.push(Object.freeze({
            eventId: `blockscout:${request.chain}:${transactionHash}:${request.tokenAddress}:${side}`,
            economicKey: `${transactionHash}:${request.tokenAddress}:${side}`,
            chain: request.chain,
            tokenAddress: request.tokenAddress,
            traderAddress,
            side,
            amountUsd: tokenAmount * tokenPriceUsd,
            marketCapUsd: tokenPriceUsd * supply,
            occurredAt,
            source: `blockscout:${pool.poolAddress}`,
          }));
        }
        nextParams = payload.next_page_params ?? null;
        if (nextParams === null) complete = true;
      }
      return Object.freeze({ status: complete ? "available" as const : "partial" as const, poolAddress: pool.poolAddress, coverageStartAt, coverageEndAt, trades: Object.freeze(trades) });
    },
  });
}

export function createSolanaPoolEarlyTradeProvider(input: {
  readonly gecko: GeckoTerminalClient;
  readonly rpc: AnalysisRpcClient;
  readonly pageSize?: number;
  readonly maxPages?: number;
}): EarlyTradeProvider {
  const pageSize = Math.min(input.pageSize ?? 100, 1000);
  const maxPages = input.maxPages ?? 20;
  return Object.freeze({
    async recover(request: RecoverEarlyTradesInput) {
      if (request.chain !== "solana") return emptyResult("not_found");
      const pool = await input.gecko.topPool("solana", request.tokenAddress, request.signal);
      if (!pool) return emptyResult("not_found");
      const supply = supplyFromPool(pool);
      if (supply === null) return emptyResult("not_found", pool.poolAddress);
      const prices = await priceHistory({ client: input.gecko, chain: "solana", poolAddress: pool.poolAddress, tokenSide: pool.tokenSide, from: request.fromTimestamp, to: request.toTimestamp, ...(request.signal ? { signal: request.signal } : {}) });
      const trades: HistoricalTradeEvidenceRow[] = [];
      let before: string | null = null;
      let complete = false;
      let coverageStartAt: number | null = null;
      let coverageEndAt: number | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        const signatures = await input.rpc.request("solana", "getSignaturesForAddress", [pool.poolAddress, { commitment: "confirmed", limit: pageSize, ...(before ? { before } : {}) }], request.signal ?? new AbortController().signal) as readonly SolanaSignatureRecord[];
        if (!signatures.length) { complete = true; break; }
        for (const record of signatures) {
          const transaction = await input.rpc.request("solana", "getTransaction", [record.signature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], request.signal ?? new AbortController().signal) as (SolanaSwapTransaction & { readonly blockTime?: number | null }) | null;
          const occurredAt = (record.blockTime ?? transaction?.blockTime ?? null) === null ? null : (record.blockTime ?? transaction?.blockTime ?? 0) * 1000;
          if (occurredAt === null || !transaction) continue;
          coverageStartAt = coverageStartAt === null ? occurredAt : Math.min(coverageStartAt, occurredAt);
          coverageEndAt = coverageEndAt === null ? occurredAt : Math.max(coverageEndAt, occurredAt);
          if (occurredAt < request.fromTimestamp) { complete = true; continue; }
          if (occurredAt > request.toTimestamp) continue;
          const keys = transaction.transaction?.message?.accountKeys ?? [];
          const signerEntry = keys.find((key) => typeof key !== "string" && key.signer);
          const firstEntry = keys[0];
          const signer = signerEntry && typeof signerEntry !== "string"
            ? signerEntry.pubkey
            : typeof firstEntry === "string"
              ? firstEntry
              : firstEntry?.pubkey;
          if (!signer) continue;
          const evidence = extractSolanaSwapEvidence(transaction, signer);
          const candidate = evidence.candidateDeltas.find((delta) => delta.mint === request.tokenAddress && evidence.supportsSwap(delta));
          const tokenPriceUsd = priceAt(prices, occurredAt);
          if (!candidate || tokenPriceUsd === null) continue;
          const side = candidate.amount > 0 ? "buy" as const : "sell" as const;
          trades.push(Object.freeze({
            eventId: `solana-rpc:${record.signature}:${request.tokenAddress}`,
            economicKey: `${record.signature}:${request.tokenAddress}`,
            chain: "solana",
            tokenAddress: request.tokenAddress,
            traderAddress: signer,
            side,
            amountUsd: Math.abs(candidate.amount) * tokenPriceUsd,
            marketCapUsd: tokenPriceUsd * supply,
            occurredAt,
            source: `solana-rpc:${pool.poolAddress}`,
          }));
        }
        if (complete || signatures.length < pageSize) { complete = true; break; }
        before = signatures.at(-1)?.signature ?? null;
      }
      return Object.freeze({ status: complete ? "available" as const : "partial" as const, poolAddress: pool.poolAddress, coverageStartAt, coverageEndAt, trades: Object.freeze(trades) });
    },
  });
}

export function createFallbackEarlyTradeProvider(input: {
  readonly primary: EarlyTradeProvider;
  readonly fallbackByChain: Readonly<Partial<Record<DiscoveryChain, EarlyTradeProvider>>>;
}): EarlyTradeProvider {
  return Object.freeze({
    async recover(request: RecoverEarlyTradesInput): Promise<EarlyTradeRecoveryResult> {
      const fallback = input.fallbackByChain[request.chain];
      let primary: EarlyTradeRecoveryResult;
      try {
        primary = await input.primary.recover(request);
      } catch (error) {
        if (!fallback) throw error;
        return fallback.recover(request);
      }
      if (primary.status === "available" || !fallback) return primary;
      let secondary: EarlyTradeRecoveryResult;
      try {
        secondary = await fallback.recover(request);
      } catch (error) {
        if (primary.trades.length > 0) return primary;
        throw error;
      }
      if (secondary.status !== "available" && primary.trades.length > 0 && secondary.trades.length === 0) return primary;
      const trades = new Map<string, HistoricalTradeEvidenceRow>();
      for (const trade of [...primary.trades, ...secondary.trades]) trades.set(`${trade.chain}:${trade.economicKey}`, trade);
      return Object.freeze({
        status: secondary.status,
        poolAddress: secondary.poolAddress ?? primary.poolAddress,
        coverageStartAt: secondary.coverageStartAt ?? primary.coverageStartAt,
        coverageEndAt: primary.coverageEndAt ?? secondary.coverageEndAt,
        trades: Object.freeze([...trades.values()]),
      });
    },
  });
}

function emptyResult(status: "not_found" | "partial", poolAddress: string | null = null): EarlyTradeRecoveryResult {
  return Object.freeze({ status, poolAddress, coverageStartAt: null, coverageEndAt: null, trades: [] });
}
