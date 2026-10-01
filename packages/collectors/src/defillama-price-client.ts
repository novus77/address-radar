import type { DiscoveryChain } from "./rpc-provider.js";

const DEFAULT_BASE_URL = "https://coins.llama.fi";
const DEFAULT_TIMEOUT_MS = 10_000;
const HOUR_MS = 60 * 60_000;
const MAX_HOURLY_POINTS = 500;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

const rateLimitDelay = (response: Response): number => {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return DEFAULT_RATE_LIMIT_DELAY_MS;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0
    ? Math.max(1_000, Math.min(2_147_483_647, delay))
    : DEFAULT_RATE_LIMIT_DELAY_MS;
};

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
  readonly beforeRequest?: (signal?: AbortSignal) => Promise<void>;
  readonly onRateLimit?: (delayMs: number) => void | Promise<void>;
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
      signal?.throwIfAborted();
      const chainId = CHAIN_IDS[chain];
      if (!chainId) return Object.freeze({ source: "defillama_chart" as const, confidence: null, prices: Object.freeze([]) });
      if (!Number.isSafeInteger(range.fromAt) || !Number.isSafeInteger(range.toAt) || range.fromAt < 0 || range.toAt < range.fromAt) {
        throw new Error("Invalid historical token price range");
      }
      const address = chain === "solana" ? tokenAddress.trim() : tokenAddress.trim().toLowerCase();
      const coinId = `${chainId}:${address}`;
      const startAt = Math.max(0, range.fromAt - HOUR_MS);
      const totalPoints = Math.max(2, Math.ceil((range.toAt - startAt) / HOUR_MS) + 1);
      try {
        const merged = new Map<number, HistoricalTokenPricePoint>();
        let minimumConfidence: number | null = null;
        for (let offset = 0; offset < totalPoints; offset += MAX_HOURLY_POINTS) {
        signal?.throwIfAborted();
        await options.beforeRequest?.(signal);
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
        const params = new URLSearchParams({ start: String(Math.floor((startAt + offset * HOUR_MS) / 1_000)), span: String(Math.min(MAX_HOURLY_POINTS, totalPoints - offset)), period: "1h" });
        const response = await fetchImpl(`${baseUrl}/chart/${encodeURIComponent(coinId)}?${params}`, { headers: { Accept: "application/json" }, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (response.status === 404) continue;
        if (!response.ok) {
          if (response.status === 429) await options.onRateLimit?.(rateLimitDelay(response));
          throw new DefiLlamaPriceError(
            `DefiLlama request failed with status ${response.status}`,
            response.status,
            response.status === 408 || response.status === 429 || response.status >= 500,
          );
        }
        const payload = await response.json() as { coins?: Record<string, { confidence?: unknown; prices?: unknown }> };
        controller.signal.throwIfAborted();
        const coin = payload.coins?.[coinId];
        const confidence = finiteNumber(coin?.confidence);
        const rows = Array.isArray(coin?.prices) ? coin.prices : [];
        const prices = rows.flatMap((row): HistoricalTokenPricePoint[] => {
          if (!row || typeof row !== "object") return [];
          const timestamp = finiteNumber((row as { timestamp?: unknown }).timestamp);
          const priceUsd = finiteNumber((row as { price?: unknown }).price);
          if (timestamp === null || priceUsd === null || timestamp < 0 || priceUsd <= 0) return [];
          return [{ observedAt: Math.round(timestamp * 1_000), priceUsd }];
        }).sort((left, right) => left.observedAt - right.observedAt);
        if (confidence !== null) minimumConfidence = minimumConfidence === null ? confidence : Math.min(minimumConfidence, confidence);
        for (const point of prices) if (point.observedAt >= startAt && point.observedAt <= range.toAt) merged.set(point.observedAt, point);
        } finally {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abort);
        }
        }
        return Object.freeze({ source: "defillama_chart" as const, confidence: minimumConfidence, prices: Object.freeze([...merged.values()].sort((left, right) => left.observedAt - right.observedAt)) });
      } catch (error) {
        if (error instanceof DefiLlamaPriceError) throw error;
        throw new DefiLlamaPriceError(error instanceof Error ? error.message : "DefiLlama request failed", null, true);
      }
    },
  });
}
