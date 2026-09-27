import type {
  MilestoneReconstructionResult,
  ReconstructMilestonesInput,
} from "./gecko-milestone-provider.js";

export interface HistoricalMilestoneProvider {
  reconstruct(input: ReconstructMilestonesInput): Promise<MilestoneReconstructionResult>;
}

export interface HistoricalProviderRoute {
  provider: string;
  result: MilestoneReconstructionResult;
  attempts: HistoricalProviderAttempt[];
}

export interface HistoricalProviderAttempt {
  provider: string;
  outcome: "available" | "not_found" | "insufficient_market_data" | "failed" | "circuit_open";
  retryable: boolean;
  message: string | null;
}

export interface HistoricalProviderRegistration {
  id: string;
  provider: HistoricalMilestoneProvider;
  enabled?: boolean;
}

export interface HistoricalProviderRouterOptions {
  primary: HistoricalProviderRegistration;
  fallback?: HistoricalProviderRegistration;
  now?: () => number;
  fallbackCircuitCooldownMs?: number;
  isFallbackQuotaError?: (error: unknown) => boolean;
}

export interface HistoricalProviderRouter {
  reconstruct(input: ReconstructMilestonesInput): Promise<HistoricalProviderRoute>;
  fallbackCircuit(): { open: boolean; retryAt: number | null };
}

const DEFAULT_FALLBACK_COOLDOWN_MS = 60 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryable(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "retryable" in error
    && (error as { retryable?: unknown }).retryable === true;
}

function defaultQuotaError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("credit")
    || message.includes("quota")
    || message.includes("billing limit")
    || message.includes("payment required");
}

function emptyResult(status: "not_found" | "insufficient_market_data"): MilestoneReconstructionResult {
  return {
    status,
    poolAddress: null,
    supplyEstimate: null,
    supplyBasis: null,
    milestones: [],
    candleCount: 0,
  };
}

export function createHistoricalProviderRouter(options: HistoricalProviderRouterOptions): HistoricalProviderRouter {
  const now = options.now ?? Date.now;
  const cooldownMs = options.fallbackCircuitCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS;
  const isQuotaError = options.isFallbackQuotaError ?? defaultQuotaError;
  let fallbackRetryAt: number | null = null;

  return {
    async reconstruct(input) {
      const attempts: HistoricalProviderAttempt[] = [];
      let primaryResult: MilestoneReconstructionResult;
      let primaryError: unknown = null;

      try {
        primaryResult = await options.primary.provider.reconstruct(input);
        attempts.push({
          provider: options.primary.id,
          outcome: primaryResult.status,
          retryable: false,
          message: null,
        });
        if (primaryResult.status === "available") {
          return { provider: options.primary.id, result: primaryResult, attempts };
        }
      } catch (error) {
        primaryError = error;
        attempts.push({
          provider: options.primary.id,
          outcome: "failed",
          retryable: retryable(error),
          message: errorMessage(error),
        });
        primaryResult = emptyResult("insufficient_market_data");
      }

      const fallback = options.fallback;
      if (!fallback || fallback.enabled === false) {
        if (primaryError !== null && retryable(primaryError)) throw primaryError;
        return { provider: options.primary.id, result: primaryResult, attempts };
      }

      if (fallbackRetryAt !== null && fallbackRetryAt > now()) {
        attempts.push({
          provider: fallback.id,
          outcome: "circuit_open",
          retryable: true,
          message: `Fallback circuit open until ${fallbackRetryAt}`,
        });
        return { provider: options.primary.id, result: primaryResult, attempts };
      }

      fallbackRetryAt = null;
      try {
        const result = await fallback.provider.reconstruct(input);
        attempts.push({
          provider: fallback.id,
          outcome: result.status,
          retryable: false,
          message: null,
        });
        return result.status === "available"
          ? { provider: fallback.id, result, attempts }
          : { provider: options.primary.id, result: primaryResult, attempts };
      } catch (error) {
        if (isQuotaError(error)) fallbackRetryAt = now() + cooldownMs;
        attempts.push({
          provider: fallback.id,
          outcome: "failed",
          retryable: retryable(error) || isQuotaError(error),
          message: errorMessage(error),
        });
        if (primaryError !== null && retryable(primaryError)) throw primaryError;
        return { provider: options.primary.id, result: primaryResult, attempts };
      }
    },

    fallbackCircuit() {
      const open = fallbackRetryAt !== null && fallbackRetryAt > now();
      return { open, retryAt: open ? fallbackRetryAt : null };
    },
  };
}
