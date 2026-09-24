import { normalizeFomoHandle } from "./identity.js";
import type { ChainFamily, FomoAccountInput, IdentityConfidence, TraderEntityInput } from "./model.js";
import { normalizeManualWalletMapping } from "./wallet-mapping.js";

export type MonitoringCoverage = "fomo_only" | "onchain_only" | "fomo_and_onchain";

export interface CanonicalTraderWallet {
  readonly chainFamily: ChainFamily;
  readonly address: string;
  readonly confidence: IdentityConfidence;
  readonly source: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export interface CanonicalTrader {
  readonly entity: TraderEntityInput;
  readonly fomoIdentity: FomoAccountInput | null;
  readonly wallets: readonly CanonicalTraderWallet[];
  readonly monitoringCoverage: MonitoringCoverage;
}

export function createCanonicalTrader(input: {
  readonly entity: TraderEntityInput;
  readonly fomoIdentity?: FomoAccountInput | null;
  readonly wallets: readonly CanonicalTraderWallet[];
}): CanonicalTrader {
  if (!input.entity.entityId.trim()) throw new Error("entityId is required");
  const fomoIdentity = input.fomoIdentity
    ? Object.freeze({ ...input.fomoIdentity, handle: normalizeFomoHandle(input.fomoIdentity.handle) })
    : null;
  const wallets = input.wallets.map((wallet) => {
    if (!wallet.source.trim()) throw new Error("Wallet source is required");
    if (wallet.firstObservedAt > wallet.lastObservedAt) throw new Error("Wallet observation range is invalid");
    const normalized = normalizeManualWalletMapping({ family: wallet.chainFamily, address: wallet.address });
    return Object.freeze({ ...wallet, chainFamily: normalized.family, address: normalized.address });
  });
  if (!fomoIdentity && wallets.length === 0) throw new Error("Canonical trader requires a Fomo identity or wallet");
  const monitoringCoverage: MonitoringCoverage = fomoIdentity
    ? wallets.length > 0 ? "fomo_and_onchain" : "fomo_only"
    : "onchain_only";
  return Object.freeze({
    entity: Object.freeze({ ...input.entity }),
    fomoIdentity,
    wallets: Object.freeze(wallets),
    monitoringCoverage,
  });
}
