import { normalizeFomoHandle, type ChainFamily } from "@address-radar/domain";
import type { AddressRadarRepository } from "@address-radar/database";

export interface ResolvedFomoWallet {
  readonly chainFamily: ChainFamily;
  readonly address: string;
}

export type FomoScanLookupResult =
  | { readonly kind: "resolved"; readonly accountId: string; readonly handle: string; readonly wallets: readonly ResolvedFomoWallet[]; readonly asOf: number }
  | { readonly kind: "not_observed" }
  | { readonly kind: "deferred"; readonly reason: "rate_limited" | "quota_exceeded" | "reveal_limit_reached" | "overloaded" | "unavailable"; readonly retryAt: number };

export interface FomoScanClient {
  byHandle(handle: string): Promise<FomoScanLookupResult>;
}

export const IDENTITY_CACHE_MS = 30 * 24 * 60 * 60 * 1_000;
export const NOT_OBSERVED_CACHE_MS = 24 * 60 * 60 * 1_000;
export const NO_PREVIEW_CACHE_MS = 30 * 24 * 60 * 60 * 1_000;

export type IdentityResolutionResult = FomoScanLookupResult | { readonly kind: "deferred"; readonly reason: "negative_cache"; readonly retryAt: number };

export function createIdentityResolutionService(input: {
  readonly repository: AddressRadarRepository;
  readonly client: FomoScanClient;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  return Object.freeze({
    async resolve(rawHandle: string): Promise<IdentityResolutionResult> {
      const handle = normalizeFomoHandle(rawHandle);
      const clock = now();
      const cached = input.repository.identityResolution(handle);
      if (cached && cached.status === "resolved" && cached.expiresAt > clock && cached.payload) {
        return Object.freeze(JSON.parse(cached.payload) as Extract<FomoScanLookupResult, { kind: "resolved" }>);
      }
      if (cached && cached.status === "not_observed" && cached.expiresAt > clock) {
        return Object.freeze({ kind: "deferred", reason: "negative_cache", retryAt: cached.expiresAt });
      }
      if (cached && cached.status === "deferred" && cached.nextAttemptAt > clock && cached.payload) {
        return Object.freeze(JSON.parse(cached.payload) as Extract<FomoScanLookupResult, { kind: "deferred" }>);
      }

      const result = await input.client.byHandle(handle);
      if (result.kind === "resolved") {
        input.repository.upsertFomoAccount({ accountId: result.accountId, handle: result.handle, firstSeenAt: clock, lastSeenAt: clock });
        for (const wallet of result.wallets) input.repository.attachWallet({ accountId: result.accountId, ...wallet, confidence: "confirmed", source: "fomoscan", observedAt: result.asOf });
        input.repository.saveIdentityResolution({ handle, status: "resolved", accountId: result.accountId, expiresAt: clock + IDENTITY_CACHE_MS, nextAttemptAt: clock + IDENTITY_CACHE_MS, attemptCount: 0, payload: JSON.stringify(result), updatedAt: clock });
        return result;
      }
      if (result.kind === "not_observed") {
        const retryAt = clock + NOT_OBSERVED_CACHE_MS;
        input.repository.saveIdentityResolution({ handle, status: "not_observed", accountId: null, expiresAt: retryAt, nextAttemptAt: retryAt, attemptCount: (cached?.attemptCount ?? 0) + 1, payload: null, updatedAt: clock });
        return Object.freeze({ kind: "not_observed", retryAt });
      }
      input.repository.saveIdentityResolution({ handle, status: "deferred", accountId: null, expiresAt: result.retryAt, nextAttemptAt: result.retryAt, attemptCount: (cached?.attemptCount ?? 0) + 1, payload: JSON.stringify(result), updatedAt: clock });
      return result;
    },
  });
}
