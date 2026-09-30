import type {
  DiscoveryChain,
  FetchLike,
  TokenMarketProvider,
} from "@address-radar/collectors";

import type {
  WalletCollector,
  WalletCollectorEvent,
  WalletCollectorPartition,
  WalletCollectorResult,
} from "./contracts.js";
import { createIndexedHistoryFetch } from "./indexed-history-fallback.js";

type EvmDiscoveryChain = Exclude<DiscoveryChain, "solana">;

interface BlockscoutTransfer {
  readonly from?: { readonly hash?: unknown };
  readonly to?: { readonly hash?: unknown };
  readonly tx_hash?: unknown;
  readonly log_index?: unknown;
  readonly timestamp?: unknown;
  readonly total?: { readonly value?: unknown; readonly decimals?: unknown };
  readonly token?: {
    readonly address_hash?: unknown;
    readonly symbol?: unknown;
    readonly type?: unknown;
  };
}

interface WalletCheckpoint {
  readonly latestSeenAt: number;
  readonly backfillParams: Readonly<Record<string, unknown>> | null;
  readonly backfillComplete: boolean;
}

interface TransferPage {
  readonly items: readonly BlockscoutTransfer[];
  readonly nextPageParams: Readonly<Record<string, unknown>> | null;
}

const STABLECOINS: Readonly<Partial<Record<EvmDiscoveryChain, ReadonlySet<string>>>> = Object.freeze({
  eth: new Set([
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
  ]),
  base: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
  ]),
  bsc: new Set([
    "0x55d398326f99059ff775485246999027b3197955",
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    "0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3",
  ]),
});

const finite = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const normalize = (value: string): string => value.trim().toLowerCase();

export function createIndexedEvmWalletCollector(input: {
  readonly chain: EvmDiscoveryChain;
  readonly endpoint: string;
  readonly fallbackEndpoint?: string;
  readonly market?: TokenMarketProvider;
  readonly fetch?: FetchLike;
  readonly walletBatchSize?: number;
  readonly maxPagesPerWallet?: number;
  readonly lookbackMs?: number;
  readonly now?: () => number;
}): WalletCollector {
  const fetchImpl = createIndexedHistoryFetch({ fetch: input.fetch ?? globalThis.fetch, ...(input.fallbackEndpoint ? { fallbackEndpoint: input.fallbackEndpoint } : {}), ...(input.now ? { now: input.now } : {}) });
  const walletBatchSize = input.walletBatchSize ?? 5;
  const maxPagesPerWallet = input.maxPagesPerWallet ?? 2;
  const lookbackMs = input.lookbackMs ?? 60 * 24 * 60 * 60 * 1_000;
  const now = input.now ?? Date.now;
  const endpoint = input.endpoint.replace(/\/$/, "");
  const name = `blockscout_wallet_${input.chain}`;

  const collector: WalletCollector = {
    name,
    chainFamily: "evm" as const,
    async collect(request): Promise<WalletCollectorResult> {
      const wallets = request.wallets.filter((wallet) => wallet.address.trim());
      if (wallets.length === 0) {
        return Object.freeze({
          partitions: Object.freeze([schedulePartition("0")]),
          diagnostics: Object.freeze([{
            partitionKey: "schedule",
            reason: "no_monitored_wallets",
            sourceReference: endpoint,
          }]),
        });
      }

      const cursor = scheduleCursor(request.checkpoint("schedule"), wallets.length);
      const selected = Array.from({ length: Math.min(walletBatchSize, wallets.length) }, (_, offset) =>
        wallets[(cursor + offset) % wallets.length]!,
      );
      const partitions: WalletCollectorPartition[] = [];
      const failures: Array<{ readonly partitionKey: string; readonly error: string }> = [];
      const diagnostics: Array<{ readonly partitionKey: string; readonly reason: string; readonly sourceReference: string }> = [];

      for (const wallet of selected) {
        if (request.signal.aborted) throw request.signal.reason ?? new Error("Aborted");
        const address = normalize(wallet.address);
        const partitionKey = `${input.chain}:${address}`;
        try {
          const checkpoint = decodeCheckpoint(request.checkpoint(partitionKey));
          const result = await collectWallet({
            chain: input.chain,
            endpoint,
            address,
            checkpoint,
            fetch: fetchImpl,
            ...(input.market ? { market: input.market } : {}),
            maxPages: maxPagesPerWallet,
            cutoff: now() - lookbackMs,
            signal: request.signal,
          });
          partitions.push(Object.freeze({
            partitionKey,
            nextCheckpoint: JSON.stringify(result.checkpoint),
            events: result.events,
          }));
          if (result.events.length === 0) diagnostics.push(Object.freeze({
            partitionKey,
            reason: result.checkpoint.backfillComplete ? "indexed_wallet_idle" : "indexed_wallet_backfill_pending",
            sourceReference: endpoint,
          }));
        } catch (error) {
          failures.push(Object.freeze({
            partitionKey,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      partitions.push(schedulePartition(String((cursor + selected.length) % wallets.length)));
      return Object.freeze({
        partitions: Object.freeze(partitions),
        failures: Object.freeze(failures),
        diagnostics: Object.freeze(diagnostics),
      });
    },
  };
  return Object.freeze(collector);
}

async function collectWallet(input: {
  readonly chain: EvmDiscoveryChain;
  readonly endpoint: string;
  readonly address: string;
  readonly checkpoint: WalletCheckpoint;
  readonly fetch: FetchLike;
  readonly market?: TokenMarketProvider;
  readonly maxPages: number;
  readonly cutoff: number;
  readonly signal: AbortSignal;
}): Promise<{ readonly checkpoint: WalletCheckpoint; readonly events: readonly WalletCollectorEvent[] }> {
  const pages: TransferPage[] = [];
  const newest = await fetchTransfers(input, null);
  pages.push(newest);

  let backfillParams = input.checkpoint.backfillParams ?? newest.nextPageParams;
  let backfillComplete = input.checkpoint.backfillComplete;
  for (let page = 1; page < input.maxPages && backfillParams && !backfillComplete; page += 1) {
    const historical = await fetchTransfers(input, backfillParams);
    pages.push(historical);
    const oldest = oldestTimestamp(historical.items);
    backfillComplete = historical.nextPageParams === null || (oldest !== null && oldest <= input.cutoff);
    backfillParams = backfillComplete ? null : historical.nextPageParams;
  }

  const allTransfers = deduplicateTransfers(pages.flatMap((page) => page.items));
  const relevant = allTransfers.filter((transfer) => {
    const occurredAt = timestamp(transfer.timestamp);
    if (occurredAt === null || occurredAt < input.cutoff) return false;
    return occurredAt > input.checkpoint.latestSeenAt || !input.checkpoint.backfillComplete;
  });
  const events = await toWalletEvents({
    chain: input.chain,
    walletAddress: input.address,
    transfers: relevant,
    ...(input.market ? { market: input.market } : {}),
    endpoint: input.endpoint,
  });
  const newestSeenAt = newestTimestamp(allTransfers) ?? input.checkpoint.latestSeenAt;
  return Object.freeze({
    checkpoint: Object.freeze({
      latestSeenAt: Math.max(input.checkpoint.latestSeenAt, newestSeenAt),
      backfillParams,
      backfillComplete,
    }),
    events,
  });
}

async function fetchTransfers(
  input: { readonly endpoint: string; readonly address: string; readonly fetch: FetchLike; readonly signal: AbortSignal },
  params: Readonly<Record<string, unknown>> | null,
): Promise<TransferPage> {
  const url = new URL(`/api/v2/addresses/${encodeURIComponent(input.address)}/token-transfers`, input.endpoint);
  url.searchParams.set("type", "ERC-20");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await input.fetch(url, { headers: { Accept: "application/json" }, signal: input.signal });
  if (!response.ok) throw new Error(`Blockscout wallet request failed with status ${response.status}`);
  const payload = await response.json() as {
    readonly items?: readonly BlockscoutTransfer[];
    readonly next_page_params?: Readonly<Record<string, unknown>> | null;
  };
  return Object.freeze({
    items: Object.freeze(payload.items ?? []),
    nextPageParams: payload.next_page_params ?? null,
  });
}

async function toWalletEvents(input: {
  readonly chain: EvmDiscoveryChain;
  readonly walletAddress: string;
  readonly transfers: readonly BlockscoutTransfer[];
  readonly market?: TokenMarketProvider;
  readonly endpoint: string;
}): Promise<readonly WalletCollectorEvent[]> {
  const byTransaction = new Map<string, BlockscoutTransfer[]>();
  for (const transfer of input.transfers) {
    const hash = text(transfer.tx_hash);
    if (!hash) continue;
    const group = byTransaction.get(hash) ?? [];
    group.push(transfer);
    byTransaction.set(hash, group);
  }

  const events: WalletCollectorEvent[] = [];
  const marketCache = new Map<string, Awaited<ReturnType<TokenMarketProvider["lookup"]>>>();
  for (const [transactionHash, transfers] of byTransaction) {
    const stableAmountUsd = stablecoinFlowUsd(input.chain, input.walletAddress, transfers);
    for (const transfer of transfers) {
      const tokenAddress = text(transfer.token?.address_hash);
      const from = text(transfer.from?.hash);
      const to = text(transfer.to?.hash);
      const occurredAt = timestamp(transfer.timestamp);
      if (!tokenAddress || !from || !to || occurredAt === null || isStablecoin(input.chain, tokenAddress)) continue;
      const normalizedFrom = normalize(from);
      const normalizedTo = normalize(to);
      const side = normalizedTo === input.walletAddress
        ? "buy" as const
        : normalizedFrom === input.walletAddress
          ? "sell" as const
          : null;
      if (!side || normalizedFrom === normalizedTo) continue;
      let snapshot = marketCache.get(normalize(tokenAddress));
      if (snapshot === undefined) {
        snapshot = input.market ? await input.market.lookup(input.chain, tokenAddress).catch(() => null) : null;
        marketCache.set(normalize(tokenAddress), snapshot);
      }
      const logIndex = finite(transfer.log_index) ?? events.length;
      events.push(Object.freeze({
        eventId: `blockscout:${input.chain}:${transactionHash}:${logIndex}`,
        chain: input.chain,
        walletAddress: input.walletAddress,
        tokenAddress: normalize(tokenAddress),
        side,
        amountUsd: stableAmountUsd,
        priceUsd: snapshot?.priceUsd ?? null,
        marketCapUsd: snapshot?.marketCapUsd ?? null,
        occurredAt,
        sourceReference: `${input.endpoint}/tx/${transactionHash}`,
      }));
    }
  }
  return Object.freeze(events);
}

function stablecoinFlowUsd(chain: EvmDiscoveryChain, walletAddress: string, transfers: readonly BlockscoutTransfer[]): number | null {
  let total = 0;
  let found = false;
  for (const transfer of transfers) {
    const tokenAddress = text(transfer.token?.address_hash);
    if (!tokenAddress || !isStablecoin(chain, tokenAddress)) continue;
    const from = text(transfer.from?.hash);
    const to = text(transfer.to?.hash);
    if (!from || !to || (normalize(from) !== walletAddress && normalize(to) !== walletAddress)) continue;
    const raw = finite(transfer.total?.value);
    const decimals = finite(transfer.total?.decimals);
    if (raw === null || decimals === null || decimals > 30) continue;
    total += raw / 10 ** decimals;
    found = true;
  }
  return found && Number.isFinite(total) ? total : null;
}

function isStablecoin(chain: EvmDiscoveryChain, address: string): boolean {
  return STABLECOINS[chain]?.has(normalize(address)) ?? false;
}

function deduplicateTransfers(transfers: readonly BlockscoutTransfer[]): readonly BlockscoutTransfer[] {
  const unique = new Map<string, BlockscoutTransfer>();
  for (const transfer of transfers) {
    const hash = text(transfer.tx_hash);
    const token = text(transfer.token?.address_hash);
    const from = text(transfer.from?.hash);
    const to = text(transfer.to?.hash);
    const index = finite(transfer.log_index);
    if (!hash || !token || !from || !to) continue;
    unique.set(`${hash}:${index ?? "unknown"}:${normalize(token)}:${normalize(from)}:${normalize(to)}`, transfer);
  }
  return Object.freeze([...unique.values()]);
}

function schedulePartition(nextCheckpoint: string): WalletCollectorPartition {
  return Object.freeze({ partitionKey: "schedule", nextCheckpoint, events: Object.freeze([]) });
}

function scheduleCursor(value: string | null, length: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed % length : 0;
}

function decodeCheckpoint(value: string | null): WalletCheckpoint {
  if (!value) return Object.freeze({ latestSeenAt: 0, backfillParams: null, backfillComplete: false });
  try {
    const parsed = JSON.parse(value) as Partial<WalletCheckpoint>;
    return Object.freeze({
      latestSeenAt: finite(parsed.latestSeenAt) ?? 0,
      backfillParams: parsed.backfillParams && typeof parsed.backfillParams === "object" ? parsed.backfillParams : null,
      backfillComplete: parsed.backfillComplete === true,
    });
  } catch {
    return Object.freeze({ latestSeenAt: 0, backfillParams: null, backfillComplete: false });
  }
}

function timestamp(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function newestTimestamp(transfers: readonly BlockscoutTransfer[]): number | null {
  const values = transfers.map((transfer) => timestamp(transfer.timestamp)).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

function oldestTimestamp(transfers: readonly BlockscoutTransfer[]): number | null {
  const values = transfers.map((transfer) => timestamp(transfer.timestamp)).filter((value): value is number => value !== null);
  return values.length ? Math.min(...values) : null;
}
