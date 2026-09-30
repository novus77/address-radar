import type {
  CanonicalChainId,
  TokenFactAttemptOutcome,
  TokenFactPrecision,
  TokenFactStatus,
  TokenFactStore,
  TokenFactType,
} from "@address-radar/database";

import type { ProviderRouteContext, ProviderRouteRegistry } from "./provider-route-registry.js";

const DEFAULT_DEPENDENCIES: Readonly<Partial<Record<TokenFactType, readonly TokenFactType[]>>> = Object.freeze({
  fomo_presence: ["token_identity"],
  market_identity: ["token_identity"],
  price_history: ["market_identity"],
  supply_history: ["token_identity"],
  milestone_crossings: ["price_history", "supply_history"],
  early_trades: ["market_identity", "milestone_crossings"],
  trader_attribution: ["early_trades"],
  candidate_evidence: ["milestone_crossings", "early_trades", "trader_attribution"],
  ability_outcomes: ["candidate_evidence"],
});

export interface TokenFactRecoveryRequest {
  readonly tokenId: string;
  readonly chainId: CanonicalChainId;
  readonly factType: TokenFactType;
  readonly providerId: string;
  readonly factRevision: number;
  readonly requestedAt: number;
}

export interface TokenFactRecoveryDispatcher {
  dispatch(request: TokenFactRecoveryRequest): { readonly accepted: boolean };
}

export interface TokenFactProviderResult {
  readonly attemptId: string;
  readonly tokenId: string;
  readonly chainId: CanonicalChainId;
  readonly factType: TokenFactType;
  readonly providerId: string;
  readonly outcome: TokenFactAttemptOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly factsWritten: number;
  readonly precision?: TokenFactPrecision | null;
  readonly coverageStartAt?: number | null;
  readonly coverageEndAt?: number | null;
  readonly observedAt?: number | null;
  readonly knownAt?: number | null;
  readonly retryAt?: number | null;
  readonly message?: string | null;
  readonly payload?: unknown;
}

export interface TokenFactPlanResult {
  readonly scheduled: readonly TokenFactType[];
  readonly blocked: readonly TokenFactType[];
  readonly complete: readonly TokenFactType[];
  readonly terminal: readonly TokenFactType[];
}

const dependencySatisfied = (status: TokenFactStatus): boolean => status === "available" || status === "partial" || status === "degraded";

export function createTokenFactOrchestrator(input: {
  readonly facts: TokenFactStore;
  readonly routes: ProviderRouteRegistry;
  readonly dispatcher: TokenFactRecoveryDispatcher;
  readonly strategyVersion: string;
  readonly now?: () => number;
  readonly routeContext?: ProviderRouteContext;
  readonly maximumAttempts?: number;
  readonly retryDelayMs?: (attemptCount: number) => number;
}) {
  const now = input.now ?? Date.now;
  const maximumAttempts = input.maximumAttempts ?? 8;
  const retryDelayMs = input.retryDelayMs ?? ((attemptCount) => [300_000, 1_800_000, 7_200_000, 28_800_000, 86_400_000][Math.min(attemptCount, 4)]!);

  const ensureGraph = (tokenId: string, factTypes: readonly TokenFactType[], at: number): void => {
    const visit = (factType: TokenFactType): void => {
      input.facts.ensure(tokenId, factType, input.strategyVersion, at);
      for (const dependency of DEFAULT_DEPENDENCIES[factType] ?? []) {
        visit(dependency);
        input.facts.addDependency(tokenId, factType, dependency, at);
      }
    };
    for (const factType of factTypes) visit(factType);
  };

  return Object.freeze({
    plan(tokenId: string, chainId: CanonicalChainId, factTypes: readonly TokenFactType[]): TokenFactPlanResult {
      const at = now();
      ensureGraph(tokenId, factTypes, at);
      const scheduled: TokenFactType[] = [];
      const blocked: TokenFactType[] = [];
      const complete: TokenFactType[] = [];
      const terminal: TokenFactType[] = [];
      for (const factType of factTypes) {
        const fact = input.facts.fact(tokenId, factType)!;
        if (fact.status === "available") { complete.push(factType); continue; }
        if (fact.status === "terminal_unavailable") { terminal.push(factType); continue; }
        if (fact.status === "fetching" || fact.status === "scheduled" || (fact.nextAttemptAt !== null && fact.nextAttemptAt > at)) { blocked.push(factType); continue; }
        const dependencies = input.facts.dependencies(tokenId, factType);
        if (dependencies.some((dependency) => !dependencySatisfied(input.facts.fact(tokenId, dependency)!.status))) { blocked.push(factType); continue; }
        const route = input.routes.route(chainId, factType, fact.attemptCount, input.routeContext);
        if (!route || fact.attemptCount >= maximumAttempts) {
          input.facts.transition({ tokenId, factType, status: "terminal_unavailable", terminalReason: route ? "attempt_budget_exhausted" : "no_provider_route", strategyVersion: input.strategyVersion, updatedAt: at });
          terminal.push(factType);
          continue;
        }
        const transition = input.facts.transition({ tokenId, factType, status: "scheduled", nextAttemptAt: at, terminalReason: null, strategyVersion: input.strategyVersion, updatedAt: at });
        const accepted = input.dispatcher.dispatch({ tokenId, chainId, factType, providerId: route.providerId, factRevision: transition.revision, requestedAt: at }).accepted;
        if (accepted) scheduled.push(factType);
        else {
          input.facts.transition({ tokenId, factType, status: "retry_scheduled", nextAttemptAt: at + retryDelayMs(fact.attemptCount), strategyVersion: input.strategyVersion, updatedAt: at });
          blocked.push(factType);
        }
      }
      return Object.freeze({ scheduled: Object.freeze(scheduled), blocked: Object.freeze(blocked), complete: Object.freeze(complete), terminal: Object.freeze(terminal) });
    },

    recordProviderResult(result: TokenFactProviderResult) {
      input.facts.recordAttempt({
        attemptId: result.attemptId, tokenId: result.tokenId, factType: result.factType, provider: result.providerId,
        outcome: result.outcome, startedAt: result.startedAt, finishedAt: result.finishedAt, factsWritten: result.factsWritten,
        ...(result.coverageStartAt !== undefined ? { coverageStartAt: result.coverageStartAt } : {}),
        ...(result.coverageEndAt !== undefined ? { coverageEndAt: result.coverageEndAt } : {}),
        ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(result.payload !== undefined ? { payload: result.payload } : {}),
      });
      const current = input.facts.fact(result.tokenId, result.factType)!;
      let status: TokenFactStatus;
      let terminalReason: string | null = null;
      let nextAttemptAt: number | null = null;
      if (result.outcome === "available" && result.factsWritten > 0) status = "available";
      else if (result.outcome === "partial" && result.factsWritten > 0) status = "partial";
      else if (result.outcome === "terminal") { status = "terminal_unavailable"; terminalReason = result.message?.trim() || "provider_terminal"; }
      else if (current.attemptCount >= maximumAttempts) { status = "terminal_unavailable"; terminalReason = result.outcome === "empty" ? "all_providers_empty" : "attempt_budget_exhausted"; }
      else { status = "retry_scheduled"; nextAttemptAt = result.retryAt ?? result.finishedAt + retryDelayMs(current.attemptCount); }
      return input.facts.transition({
        tokenId: result.tokenId, factType: result.factType, status,
        ...(result.precision !== undefined ? { precision: result.precision } : {}),
        primarySource: result.factsWritten > 0 ? result.providerId : current.primarySource,
        ...(result.coverageStartAt !== undefined ? { coverageStartAt: result.coverageStartAt } : {}),
        ...(result.coverageEndAt !== undefined ? { coverageEndAt: result.coverageEndAt } : {}),
        observedAt: result.factsWritten > 0 ? (result.observedAt ?? result.finishedAt) : current.observedAt,
        knownAt: result.knownAt ?? result.finishedAt, nextAttemptAt, terminalReason,
        strategyVersion: input.strategyVersion, updatedAt: result.finishedAt,
      });
    },
  });
}
