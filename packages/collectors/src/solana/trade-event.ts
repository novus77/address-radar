import type { TraderEvent } from "@address-radar/domain";

import type { OnchainWalletRecord, ResolvedTraderIdentity } from "../types.js";

const finiteOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function normalizeSolanaWalletRecord(record: OnchainWalletRecord, identity: ResolvedTraderIdentity): TraderEvent | null {
  if (
    record.chainFamily !== "solana" || !record.eventId?.trim() || record.chain?.trim().toLowerCase() !== "solana" ||
    !record.walletAddress?.trim() || !record.tokenAddress?.trim() || (record.side !== "buy" && record.side !== "sell") ||
    !Number.isSafeInteger(record.occurredAt) || record.occurredAt! < 0 ||
    !Number.isSafeInteger(identity.collectedAt) || identity.collectedAt < 0
  ) return null;
  return Object.freeze({
    eventId: record.eventId.trim(),
    accountId: identity.accountId,
    entityId: identity.entityId,
    chain: "solana",
    tokenAddress: record.tokenAddress.trim(),
    side: record.side,
    amountUsd: finiteOrNull(record.amountUsd),
    priceUsd: finiteOrNull(record.priceUsd),
    marketCapUsd: finiteOrNull(record.marketCapUsd),
    tokenAgeMs: null,
    occurredAt: record.occurredAt!,
    collectedAt: identity.collectedAt,
    source: "onchain_wallet",
  });
}
