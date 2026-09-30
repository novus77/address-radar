import type { CanonicalChainId, TokenFactType } from "@address-radar/database";

export type ProviderCostClass = "free" | "metered" | "paid";

export interface FactProviderRoute {
  readonly providerId: string;
  readonly chainIds: readonly CanonicalChainId[];
  readonly factTypes: readonly TokenFactType[];
  readonly priority: number;
  readonly qualityRank: number;
  readonly costClass: ProviderCostClass;
  readonly enabled: boolean;
}

export interface ProviderRouteContext {
  readonly circuitOpen?: (providerId: string, chainId: CanonicalChainId, factType: TokenFactType) => boolean;
  readonly budgetAvailable?: (providerId: string, costClass: ProviderCostClass) => boolean;
}

export interface ProviderRouteRegistry {
  routes(chainId: CanonicalChainId, factType: TokenFactType, context?: ProviderRouteContext): readonly FactProviderRoute[];
  route(chainId: CanonicalChainId, factType: TokenFactType, attemptCount: number, context?: ProviderRouteContext): FactProviderRoute | null;
}

export function createProviderRouteRegistry(registrations: readonly FactProviderRoute[]): ProviderRouteRegistry {
  const duplicate = new Set<string>();
  for (const route of registrations) {
    if (!route.providerId.trim()) throw new Error("Provider id is required");
    if (!Number.isFinite(route.priority) || !Number.isFinite(route.qualityRank)) throw new Error("Provider route ranks must be finite");
    const key = `${route.providerId}:${[...route.chainIds].sort().join(",")}:${[...route.factTypes].sort().join(",")}`;
    if (duplicate.has(key)) throw new Error(`Duplicate provider route: ${key}`);
    duplicate.add(key);
  }
  const matching = (chainId: CanonicalChainId, factType: TokenFactType, context: ProviderRouteContext = {}) => registrations
    .filter((route) => route.enabled && route.chainIds.includes(chainId) && route.factTypes.includes(factType))
    .filter((route) => !context.circuitOpen?.(route.providerId, chainId, factType))
    .filter((route) => context.budgetAvailable?.(route.providerId, route.costClass) ?? true)
    .sort((left, right) => left.priority - right.priority || right.qualityRank - left.qualityRank || left.providerId.localeCompare(right.providerId));
  const registry: ProviderRouteRegistry = {
    routes(chainId, factType, context) { return Object.freeze(matching(chainId, factType, context)); },
    route(chainId, factType, attemptCount, context) {
      if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error("attemptCount must be a non-negative safe integer");
      const routes = matching(chainId, factType, context);
      return routes.length === 0 ? null : routes[Math.min(attemptCount, routes.length - 1)]!;
    },
  };
  return Object.freeze(registry);
}
