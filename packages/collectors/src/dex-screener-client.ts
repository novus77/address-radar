import { JsonRpcRateLimitError } from "./json-rpc-client.js";
import type { FetchLike, TokenMarketProvider, TokenMarketSnapshot } from "./types.js";

interface DexPair {
  readonly chainId?: unknown;
  readonly baseToken?: { readonly address?: unknown };
  readonly quoteToken?: { readonly address?: unknown };
  readonly priceUsd?: unknown;
  readonly liquidity?: { readonly usd?: unknown };
  readonly marketCap?: unknown;
  readonly fdv?: unknown;
}

const finite = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const normalizeAddress = (chain: string, address: string): string => chain === "solana" ? address : address.toLowerCase();

export function createDexScreenerClient(input: {
  readonly fetch?: FetchLike;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
} = {}): TokenMarketProvider {
  const fetcher = input.fetch ?? globalThis.fetch;
  const baseUrl = (input.baseUrl ?? "https://api.dexscreener.com").replace(/\/$/, "");
  const timeoutMs = input.timeoutMs ?? 5_000;
  const now = input.now ?? Date.now;

  return Object.freeze({
    async lookup(chain: string, tokenAddress: string): Promise<TokenMarketSnapshot | null> {
      const normalizedChain = chain.trim().toLowerCase();
      const normalizedAddress = normalizeAddress(normalizedChain, tokenAddress.trim());
      if (!normalizedChain || !normalizedAddress) throw new Error("Chain and token address are required");
      const endpoint = `${baseUrl}/latest/dex/tokens/${encodeURIComponent(normalizedAddress)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(endpoint, { signal: controller.signal });
        if (response.status === 429) throw new JsonRpcRateLimitError(endpoint);
        if (response.status === 404 || response.status >= 500) return null;
        if (!response.ok) throw new Error(`Dex Screener returned HTTP ${response.status}`);
        const body = await response.json() as { readonly pairs?: unknown };
        if (body.pairs === null) return null;
        if (!Array.isArray(body.pairs)) throw new Error("Malformed Dex Screener response");
        const pairs = (body.pairs as DexPair[]).filter(pair => {
          if (pair.chainId !== normalizedChain) return false;
          const base = typeof pair.baseToken?.address === "string" ? normalizeAddress(normalizedChain, pair.baseToken.address) : null;
          const quote = typeof pair.quoteToken?.address === "string" ? normalizeAddress(normalizedChain, pair.quoteToken.address) : null;
          return base === normalizedAddress || quote === normalizedAddress;
        });
        const selected = pairs.sort((left, right) => (finite(right.liquidity?.usd) ?? -1) - (finite(left.liquidity?.usd) ?? -1))[0];
        if (!selected) return null;
        return Object.freeze({
          chain: normalizedChain,
          tokenAddress: normalizedAddress,
          priceUsd: finite(selected.priceUsd),
          marketCapUsd: finite(selected.marketCap) ?? finite(selected.fdv),
          liquidityUsd: finite(selected.liquidity?.usd),
          observedAt: new Date(now()).toISOString(),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
