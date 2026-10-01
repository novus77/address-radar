import type { MonitoredWallet } from "@address-radar/identity";
import type { NormalizedWalletObservation } from "./contracts.js";

export function normalizeWalletObservations(
  events: readonly Omit<NormalizedWalletObservation, "source" | "chainFamily" | "accountId" | "entityId" | "collectedAt">[],
  wallets: readonly MonitoredWallet[],
  source: string,
  chainFamily: "evm" | "solana",
  collectedAt: number,
): NormalizedWalletObservation[] {
  const key = (address: string) => chainFamily === "evm" ? address.toLowerCase() : address;
  const ownership = new Map(wallets.map(wallet => [key(wallet.address), wallet]));
  return events.flatMap(event => {
    const wallet = ownership.get(key(event.walletAddress));
    if (!wallet) return [];
    return [{ ...event, chain: event.chain.toLowerCase(), walletAddress: key(event.walletAddress),
      tokenAddress: key(event.tokenAddress), source, chainFamily,
      accountId: wallet.accountId, entityId: wallet.entityId, collectedAt }];
  });
}
