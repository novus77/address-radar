import type { DiscoveryChain } from "./rpc-provider.js";

const DEFAULT_BASE_URL = "https://coins.llama.fi";
const DEFAULT_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60_000;
const MAX_HOURLY_POINTS = 2_000;

const CHAIN_IDS: Partial<Record<DiscoveryChain, string>> = {
  eth: "ethereum",
  bsc: "bsc",
  base: "base",
  solana: "solana",
};

export interface HistoricalTokenPricePoint {
  readonly observedAt: number;
  readonly priceUsd: number;
}

export interface HistoricalTokenPriceResult {
  readonly source: "defillama_chart";
  readonly confidence: number | null;
  readonly prices: readonly HistoricalTokenPricePoint[];
}

export interface HistoricalTokenPriceClient {
  chart(
    chain: DiscoveryChain,
    tokenAddress: string,
    range: { readonly fromAt: number; readonly toAt: number },
    signal?: AbortSignal,
  ): Promise<HistoricalTokenPriceResult>;
}

export class DefiLlamaPriceError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DefiLlamaPriceError";
  }
}

const finiteNumber = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function createDefiLlamaPriceClient(options: {
  readonly fetch?: typeof globalThis.fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
} = {}): HistoricalTokenPriceClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return Object.freeze({
    async chart(
      chain: DiscoveryChain,
      tokenAddress: string,
      range: { readonly fromAt: number; readonly toAt: number },
      signal?: AbortSignal,
    ) {
      const chainId = CHAIN_IDS[chain];
      if (!chainId) return Object.freeze({ source: "defillama_chart" as const, confidence: null, prices: Object.freeze([]) });
      if (!Number.isSafeInteger(range.fromAt) || !Number.isSafeInteger(range.toAt) || range.fromAt < 0 || range.toAt < range.fromAt) {
        throw new Error("Invalid historical token price range");
      }
      const address = chain === "solana" ? tokenAddress.trim() : tokenAddress.trim().toLowerCase();
      const coinId = `${chainId}:${address}`;
      const span = Math.min(MAX_HOURLY_POINTS, Math.max(2, Math.ceil((range.toAt - range.fromAt) / HOUR_MS) + 2));
      const params = new URLSearchParams({
        start: String(Math.floor(Math.max(0, range.fromAt - HOUR_MS) / 1_000)),
        span: String(span),
        period: "1h",
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchImpl(`${baseUrl}/chart/${encodeURIComponent(coinId)}?${params}`, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (response.status === 404) return Object.freeze({ source: "defillama_chart" as const, confidence: null, prices: Object.freeze([]) });
        if (!response.ok) {
          throw new DefiLlamaPriceError(
            `DefiLlama request failed with status ${response.status}`,
            response.status,
            response.status === 408 || response.status === 429 || response.status >= 500,
          );
        }
        const payload = await response.json() as { coins?: Record<string, { confidence?: unknown; prices?: unknown }> };
        const coin = payload.coins?.[coinId] ?? Object.values(payload.coins ?? {})[0];
        const confidence = finiteNumber(coin?.confidence);
        const rows = Array.isArray(coin?.prices) ? coin.prices : [];
        const prices = rows.flatMap((row): HistoricalTokenPricePoint[] => {
          if (!row || typeof row !== "object") return [];
          const timestamp = finiteNumber((row as { timestamp?: unknown }).timestamp);
          const priceUsd = finiteNumber((row as { price?: unknown }).price);
          if (timestamp === null || priceUsd === null || timestamp < 0 || priceUsd <= 0) return [];
          return [{ observedAt: Math.round(timestamp * 1_000), priceUsd }];
        }).sort((left, right) => left.observedAt - right.observedAt);
        return Object.freeze({ source: "defillama_chart" as const, confidence, prices: Object.freeze(prices) });
      } catch (error) {
        if (error instanceof DefiLlamaPriceError) throw error;
        throw new DefiLlamaPriceError(error instanceof Error ? error.message : "DefiLlama request failed", null, true);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
}
