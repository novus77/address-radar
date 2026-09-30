import type { DiscoveryChain } from "./rpc-provider.js";

const DEFAULT_BASE_URL = "https://api.geckoterminal.com/api/v2";
const DEFAULT_TIMEOUT_MS = 10_000;

const NETWORKS: Partial<Record<DiscoveryChain, string>> = {
  eth: "eth",
  bsc: "bsc",
  base: "base",
  solana: "solana",
};

export type GeckoTerminalTokenSide = "base" | "quote";
export type GeckoTerminalTimeframe = "minute" | "hour" | "day";

export interface GeckoTerminalPool {
  network: string;
  poolAddress: string;
  tokenAddress: string;
  tokenSide: GeckoTerminalTokenSide;
  tokenPriceUsd: number;
  reserveUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  createdAt: number | null;
}

export interface GeckoTerminalOhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface GeckoTerminalTrade {
  transactionHash: string;
  traderAddress: string;
  side: "buy" | "sell";
  tokenPriceUsd: number;
  volumeUsd: number;
  occurredAt: number;
}

export interface GeckoTerminalOhlcvOptions {
  timeframe: GeckoTerminalTimeframe;
  tokenSide: GeckoTerminalTokenSide;
  aggregate?: number;
  beforeTimestamp?: number;
  limit?: number;
}

export class GeckoTerminalError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GeckoTerminalError";
  }
}

export interface GeckoTerminalClient {
  pools?(chain: DiscoveryChain, tokenAddress: string, signal?: AbortSignal): Promise<GeckoTerminalPool[]>;
  topPool(chain: DiscoveryChain, tokenAddress: string, signal?: AbortSignal): Promise<GeckoTerminalPool | null>;
  ohlcv(
    chain: DiscoveryChain,
    poolAddress: string,
    options: GeckoTerminalOhlcvOptions,
    signal?: AbortSignal,
  ): Promise<GeckoTerminalOhlcvCandle[]>;
  trades(
    chain: DiscoveryChain,
    poolAddress: string,
    tokenSide: GeckoTerminalTokenSide,
    signal?: AbortSignal,
  ): Promise<GeckoTerminalTrade[]>;
}

export interface GeckoTerminalClientOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  minimumRequestIntervalMs?: number;
  rateLimitCooldownMs?: number;
  now?: () => number;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function relationshipAddress(value: unknown, network: string): string | null {
  if (typeof value !== "string") return null;
  const prefix = `${network}_`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function sameAddress(chain: DiscoveryChain, left: string, right: string): boolean {
  return chain === "solana" ? left === right : left.toLowerCase() === right.toLowerCase();
}

export function createGeckoTerminalClient(options: GeckoTerminalClientOptions = {}): GeckoTerminalClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? 3_100;
  const rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; value: unknown }>();
  let requestTail = Promise.resolve();
  let lastRequestAt = 0;
  let rateLimitedUntil = 0;

  async function request(path: string, cacheTtlMs: number, signal?: AbortSignal): Promise<unknown> {
    const cached = cache.get(path);
    if (cached && cached.expiresAt > now()) return cached.value;
    let release: () => void = () => undefined;
    const previous = requestTail;
    requestTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const waitMs = Math.max(0, lastRequestAt + minimumRequestIntervalMs - now(), rateLimitedUntil - now());
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 404) {
        cache.set(path, { expiresAt: now() + Math.max(cacheTtlMs, 30 * 60 * 1000), value: null });
        return null;
      }
      if (!response.ok) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs = response.status === 429
          ? Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : rateLimitCooldownMs
          : null;
        if (retryAfterMs !== null) rateLimitedUntil = Math.max(rateLimitedUntil, now() + retryAfterMs);
        throw new GeckoTerminalError(
          `GeckoTerminal request failed with status ${response.status}`,
          response.status,
          response.status === 408 || response.status === 429 || response.status >= 500,
          retryAfterMs,
        );
      }
      const value = await response.json();
      cache.set(path, { expiresAt: now() + cacheTtlMs, value });
      return value;
    } catch (error) {
      if (error instanceof GeckoTerminalError) throw error;
      throw new GeckoTerminalError(error instanceof Error ? error.message : "GeckoTerminal request failed", null, true);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      lastRequestAt = now();
      release();
    }
  }

  return {
    async pools(chain, tokenAddress, signal) {
      const network = NETWORKS[chain];
      if (!network) return [];
      const payload = await request(
        `/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(tokenAddress)}/pools?page=1`,
        15 * 60 * 1000,
        signal,
      );
      if (!payload || typeof payload !== "object") return [];
      const data = (payload as { data?: unknown }).data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((entry): GeckoTerminalPool[] => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as { attributes?: Record<string, unknown>; relationships?: Record<string, { data?: { id?: unknown } }> };
        const attributes = item.attributes ?? {};
        const baseAddress = relationshipAddress(item.relationships?.base_token?.data?.id, network);
        const quoteAddress = relationshipAddress(item.relationships?.quote_token?.data?.id, network);
        const tokenSide = baseAddress && sameAddress(chain, baseAddress, tokenAddress) ? "base" : quoteAddress && sameAddress(chain, quoteAddress, tokenAddress) ? "quote" : null;
        const poolAddress = typeof attributes.address === "string" ? attributes.address : null;
        const tokenPriceUsd = finiteNumber(tokenSide === "base" ? attributes.base_token_price_usd : attributes.quote_token_price_usd);
        if (!tokenSide || !poolAddress || tokenPriceUsd === null || tokenPriceUsd <= 0) return [];
        const createdAt = typeof attributes.pool_created_at === "string" ? Date.parse(attributes.pool_created_at) : Number.NaN;
        return [{ network, poolAddress, tokenAddress, tokenSide, tokenPriceUsd, reserveUsd: finiteNumber(attributes.reserve_in_usd), marketCapUsd: finiteNumber(attributes.market_cap_usd), fdvUsd: finiteNumber(attributes.fdv_usd), createdAt: Number.isFinite(createdAt) ? createdAt : null }];
      }).sort((left, right) => (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0));
    },
    async topPool(chain, tokenAddress, signal) {
      const network = NETWORKS[chain];
      if (!network) return null;
      const payload = await request(
        `/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(tokenAddress)}/pools?page=1`,
        15 * 60 * 1000,
        signal,
      );
      if (!payload || typeof payload !== "object") return null;
      const data = (payload as { data?: unknown }).data;
      if (!Array.isArray(data)) return null;

      const pools = data.flatMap((entry): GeckoTerminalPool[] => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as {
          attributes?: Record<string, unknown>;
          relationships?: Record<string, { data?: { id?: unknown } }>;
        };
        const attributes = item.attributes ?? {};
        const baseAddress = relationshipAddress(item.relationships?.base_token?.data?.id, network);
        const quoteAddress = relationshipAddress(item.relationships?.quote_token?.data?.id, network);
        const tokenSide = baseAddress && sameAddress(chain, baseAddress, tokenAddress)
          ? "base"
          : quoteAddress && sameAddress(chain, quoteAddress, tokenAddress)
            ? "quote"
            : null;
        const poolAddress = typeof attributes.address === "string" ? attributes.address : null;
        const tokenPriceUsd = finiteNumber(
          tokenSide === "base" ? attributes.base_token_price_usd : attributes.quote_token_price_usd,
        );
        if (!tokenSide || !poolAddress || tokenPriceUsd === null || tokenPriceUsd <= 0) return [];
        const createdAt = typeof attributes.pool_created_at === "string" ? Date.parse(attributes.pool_created_at) : Number.NaN;
        return [{
          network,
          poolAddress,
          tokenAddress,
          tokenSide,
          tokenPriceUsd,
          reserveUsd: finiteNumber(attributes.reserve_in_usd),
          marketCapUsd: finiteNumber(attributes.market_cap_usd),
          fdvUsd: finiteNumber(attributes.fdv_usd),
          createdAt: Number.isFinite(createdAt) ? createdAt : null,
        }];
      });
      return pools.sort((left, right) => (right.reserveUsd ?? 0) - (left.reserveUsd ?? 0))[0] ?? null;
    },

    async ohlcv(chain, poolAddress, ohlcvOptions, signal) {
      const network = NETWORKS[chain];
      if (!network) return [];
      const params = new URLSearchParams({
        aggregate: String(ohlcvOptions.aggregate ?? 1),
        limit: String(Math.min(Math.max(ohlcvOptions.limit ?? 1000, 1), 1000)),
        currency: "usd",
        token: ohlcvOptions.tokenSide,
      });
      if (ohlcvOptions.beforeTimestamp !== undefined) {
        params.set("before_timestamp", String(Math.floor(ohlcvOptions.beforeTimestamp / 1000)));
      }
      const payload = await request(
        `/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${ohlcvOptions.timeframe}?${params}`,
        ohlcvOptions.beforeTimestamp !== undefined && ohlcvOptions.beforeTimestamp < now() - 2 * 60 * 60 * 1000
          ? 24 * 60 * 60 * 1000
          : 10 * 60 * 1000,
        signal,
      );
      if (!payload || typeof payload !== "object") return [];
      const rows = (payload as { data?: { attributes?: { ohlcv_list?: unknown } } }).data?.attributes?.ohlcv_list;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row): GeckoTerminalOhlcvCandle[] => {
        if (!Array.isArray(row) || row.length < 6) return [];
        const timestamp = finiteNumber(row[0]);
        const open = finiteNumber(row[1]);
        const high = finiteNumber(row[2]);
        const low = finiteNumber(row[3]);
        const close = finiteNumber(row[4]);
        const volumeUsd = finiteNumber(row[5]);
        if ([timestamp, open, high, low, close, volumeUsd].some((value) => value === null)) return [];
        return [{ timestamp: timestamp! * 1000, open: open!, high: high!, low: low!, close: close!, volumeUsd: volumeUsd! }];
      });
    },

    async trades(chain, poolAddress, tokenSide, signal) {
      const network = NETWORKS[chain];
      if (!network) return [];
      const payload = await request(
        `/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(poolAddress)}/trades`,
        10 * 1000,
        signal,
      );
      if (!payload || typeof payload !== "object") return [];
      const rows = (payload as { data?: unknown }).data;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row): GeckoTerminalTrade[] => {
        if (!row || typeof row !== "object") return [];
        const attributes = (row as { attributes?: Record<string, unknown> }).attributes ?? {};
        const kind = attributes.kind === "buy" || attributes.kind === "sell" ? attributes.kind : null;
        const transactionHash = typeof attributes.tx_hash === "string" ? attributes.tx_hash : null;
        const traderAddress = typeof attributes.tx_from_address === "string" ? attributes.tx_from_address : null;
        const volumeUsd = finiteNumber(attributes.volume_in_usd);
        const occurredAt = typeof attributes.block_timestamp === "string" ? Date.parse(attributes.block_timestamp) : Number.NaN;
        if (!kind || !transactionHash || !traderAddress || volumeUsd === null || !Number.isFinite(occurredAt)) return [];
        const side = tokenSide === "base" ? kind : kind === "buy" ? "sell" : "buy";
        const tokenFlowsToTrader = side === "buy";
        const tokenPriceUsd = finiteNumber(tokenFlowsToTrader ? attributes.price_to_in_usd : attributes.price_from_in_usd)
          ?? finiteNumber(tokenFlowsToTrader ? attributes.price_from_in_usd : attributes.price_to_in_usd);
        if (tokenPriceUsd === null || tokenPriceUsd <= 0) return [];
        return [{ transactionHash, traderAddress, side, tokenPriceUsd, volumeUsd, occurredAt }];
      });
    },
  };
}
