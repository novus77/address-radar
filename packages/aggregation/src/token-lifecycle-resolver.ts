import { classifyTokenLifecycle, type TokenLifecycleStage } from "@address-radar/domain";

const supportedChains = new Set(["eth", "bnb", "bsc", "monad", "robinhood", "base", "solana", "sol"]);

interface TokenLifecycleRequest {
    readonly chain: string;
    readonly tokenAddress: string;
    readonly signal: AbortSignal;
}

export interface TokenCreationProvider {
  creationFacts(input: TokenLifecycleRequest): Promise<{
    readonly status: "ready" | "rate_limited" | "unavailable";
    readonly createdAt?: number | null;
  }>;
}

export interface TokenLaunchProvider {
  launchFacts(input: TokenLifecycleRequest): Promise<{
    readonly status: "ready" | "rate_limited" | "unavailable";
    readonly markets: readonly { readonly launchedAt?: number }[];
  }>;
}

export interface TokenLifecycleResolver {
  resolve(input: {
    readonly chain: string;
    readonly tokenAddress: string;
    readonly observedAt: number;
    readonly createdAt?: number | null;
    readonly launchedAt?: number | null;
  }): Promise<TokenLifecycleStage>;
}

export function createTokenLifecycleResolver(input: {
  readonly creationProvider?: TokenCreationProvider;
  readonly launchProvider?: TokenLaunchProvider;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}): TokenLifecycleResolver {
  const cacheTtlMs = input.cacheTtlMs ?? 5 * 60_000;
  const now = input.now ?? Date.now;
  const cache = new Map<string, { readonly createdAt: number | null; readonly launchedAt: number | null; readonly expiresAt: number }>();

  return Object.freeze({
    async resolve(request: { readonly chain: string; readonly tokenAddress: string; readonly observedAt: number; readonly createdAt?: number | null; readonly launchedAt?: number | null }) {
      const chain = request.chain.toLowerCase();
      if (!supportedChains.has(chain)) return "unknown";
      const key = `${chain}:${request.tokenAddress.toLowerCase()}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        return classifyTokenLifecycle({ observedAt: request.observedAt, createdAt: request.createdAt ?? cached.createdAt, launchedAt: request.launchedAt ?? cached.launchedAt });
      }
      const providerRequest = { chain, tokenAddress: request.tokenAddress, signal: new AbortController().signal };
      const creation = request.createdAt !== undefined ? null : await input.creationProvider?.creationFacts(providerRequest);
      const launch = request.launchedAt !== undefined ? null : await input.launchProvider?.launchFacts(providerRequest);
      const createdAt = request.createdAt ?? (creation?.status === "ready" ? creation.createdAt ?? null : null);
      const launchTimes = launch?.status === "ready" ? launch.markets.flatMap(market => market.launchedAt === undefined ? [] : [market.launchedAt]) : [];
      const launchedAt = request.launchedAt ?? (launchTimes.length > 0 ? Math.min(...launchTimes) : null);
      cache.set(key, { createdAt, launchedAt, expiresAt: now() + cacheTtlMs });
      return classifyTokenLifecycle({ observedAt: request.observedAt, createdAt, launchedAt });
    },
  });
}
