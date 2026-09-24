import type { TraderEvent } from "@address-radar/domain";

import { normalizeEvmWalletRecord } from "./evm/trade-event.js";
import { normalizeSolanaWalletRecord } from "./solana/trade-event.js";
import type { OnchainWalletRecord, ResolvedTraderIdentity } from "./types.js";

export function normalizeOnchainWalletRecord(record: OnchainWalletRecord, identity: ResolvedTraderIdentity): TraderEvent | null {
  if (record.chainFamily === "evm") return normalizeEvmWalletRecord(record, identity);
  if (record.chainFamily === "solana") return normalizeSolanaWalletRecord(record, identity);
  return null;
}
