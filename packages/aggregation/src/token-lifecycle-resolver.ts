import { classifyTokenLifecycle, type TokenLifecycleStage } from "@address-radar/domain";

const supportedChains = new Set(["eth", "bnb", "bsc", "monad", "robinhood", "base", "solana", "sol"]);

export interface TokenLifecycleMarketProvider {
  marketsForToken(input: {
    readonly chain: string;
    readonly tokenAddress: string;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly status: "ready" | "rate_limited" | "unavailable";
    readonly markets: readonly { readonly launchedAt?: number }[];
  }>;
}

export interface TokenLifecycleResolver {
  resolve(input: {
    readonly chain: string;
    readonly tokenAddress: string;
    readonly observedAt: number;
  }): Promise<TokenLifecycleStage>;
}

export function createTokenLifecycleResolver(input: {
  readonly provider: TokenLifecycleMarketProvider;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}): TokenLifecycleResolver {
  const cacheTtlMs = input.cacheTtlMs ?? 5 * 60_000;
  const now = input.now ?? Date.now;
  const cache = new Map<string, { readonly launchedAt: number | null; readonly expiresAt: number }>();

  return Object.freeze({
    async resolve(request: { readonly chain: string; readonly tokenAddress: string; readonly observedAt: number }) {
      const chain = request.chain.toLowerCase();
      if (!supportedChains.has(chain)) return "unknown";
      const key = `${chain}:${request.tokenAddress.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        return classifyTokenLifecycle({ observedAt: request.observedAt, launchedAt: cached.launchedAt });
      }
      const result = await input.provider.marketsForToken({
        chain,
        tokenAddress: request.tokenAddress,
        signal: new AbortController().signal,
      });
      if (result.status !== "ready") return "unknown";
      const launchTimes = result.markets.flatMap(market => market.launchedAt === undefined ? [] : [market.launchedAt]);
      const launchedAt = launchTimes.length > 0 ? Math.min(...launchTimes) : null;
      cache.set(key, { launchedAt, expiresAt: now() + cacheTtlMs });
      return classifyTokenLifecycle({ observedAt: request.observedAt, launchedAt });
    },
  });
}
