import { createJsonRpcClient, type DiscoveryChain, type FetchLike, type JsonRpcClient } from "@address-radar/collectors";

import {
  createProviderBudget,
  type ProviderBudget,
  type ProviderRequestKind,
} from "./provider-budget.js";

export interface WalletRpcClient {
  request(chain: DiscoveryChain, method: string, params: readonly unknown[], signal: AbortSignal, kind?: ProviderRequestKind): Promise<unknown>;
  budgetSnapshot?(chain: DiscoveryChain): ReturnType<ProviderBudget["snapshot"]> | null;
}

export class WalletRpcRateLimitError extends Error {
  constructor(readonly chain: DiscoveryChain, readonly retryAt: number) {
    super(`Wallet RPC provider is cooling down for ${chain} until ${retryAt}`);
    this.name = "WalletRpcRateLimitError";
  }
}

export function createConfiguredWalletRpcClient(input: {
  readonly endpoints: Readonly<Partial<Record<DiscoveryChain, { readonly primary: string; readonly fallback?: string }>>>;
  readonly fetch?: FetchLike;
  readonly budgets?: Readonly<Partial<Record<DiscoveryChain, ProviderBudget>>>;
  readonly rateLimitCooldownMs?: number;
  readonly now?: () => number;
}): WalletRpcClient {
  const clients = new Map<DiscoveryChain, { primary: JsonRpcClient; fallback?: JsonRpcClient }>();
  for (const [chain, endpoint] of Object.entries(input.endpoints) as Array<[DiscoveryChain, { readonly primary: string; readonly fallback?: string }]>) {
    clients.set(chain, {
      primary: createJsonRpcClient({ endpoint: endpoint.primary, ...(input.fetch ? { fetch: input.fetch } : {}) }),
      ...(endpoint.fallback ? {
        fallback: createJsonRpcClient({ endpoint: endpoint.fallback, ...(input.fetch ? { fetch: input.fetch } : {}) }),
      } : {}),
    });
  }
  if (clients.size === 0) throw new Error("At least one configured RPC client is required");
  const now = input.now ?? Date.now;
  const rateLimitCooldownMs = input.rateLimitCooldownMs ?? 30_000;
  const budgets = new Map<DiscoveryChain, ProviderBudget>();
  for (const chain of clients.keys()) {
    const configured = input.budgets?.[chain];
    if (configured) budgets.set(chain, configured);
    else if (chain === "solana") budgets.set(chain, createProviderBudget());
  }
  const rpc: WalletRpcClient = {
    async request(chain, method, params, signal, kind = "realtime") {
      if (signal.aborted) throw signal.reason ?? new Error("Aborted");
      const pair = clients.get(chain);
      if (!pair) throw new Error(`RPC chain is not configured: ${chain}`);
      const budget = budgets.get(chain);
      await budget?.acquire(kind, signal);
      try {
        return await pair.primary.request(method, params, signal);
      } catch (primaryError) {
        const primaryRateLimit = rateLimitRetryAt(primaryError, now(), rateLimitCooldownMs);
        if (primaryRateLimit !== null) budget?.rateLimited(primaryRateLimit);
        if (!pair.fallback || !fallbackEligible(primaryError)) {
          if (primaryRateLimit !== null) throw new WalletRpcRateLimitError(chain, primaryRateLimit);
          throw primaryError;
        }
        try {
          return await pair.fallback.request(method, params, signal);
        } catch (fallbackError) {
          const fallbackRateLimit = rateLimitRetryAt(fallbackError, now(), rateLimitCooldownMs);
          if (fallbackRateLimit !== null) {
            budget?.rateLimited(fallbackRateLimit);
            throw new WalletRpcRateLimitError(chain, fallbackRateLimit);
          }
          throw fallbackError;
        }
      }
    },
    budgetSnapshot(chain) {
      return budgets.get(chain)?.snapshot() ?? null;
    },
  };
  return Object.freeze(rpc);
}

function fallbackEligible(error: unknown): boolean {
  return !(error instanceof Error && (
    error.name === "JsonRpcAbortError" || error.name === "JsonRpcResponseError"
  ));
}

function rateLimitRetryAt(error: unknown, now: number, fallbackMs: number): number | null {
  if (!(error instanceof Error) || error.name !== "JsonRpcRateLimitError") return null;
  const retryAfterMs = Number((error as Error & { retryAfterMs?: unknown }).retryAfterMs);
  return now + (Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : fallbackMs);
}
