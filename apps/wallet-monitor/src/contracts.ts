import type { ChainFamily } from "@address-radar/domain";
import type { MonitoredWallet } from "@address-radar/identity";

export interface WalletCollectorEvent {
  readonly eventId: string;
  readonly chain: string;
  readonly walletAddress: string;
  readonly tokenAddress: string;
  readonly side: "buy" | "sell";
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly occurredAt: number;
  readonly cursor: string;
  readonly sourceReference: string;
}

export interface WalletCollectorResult {
  readonly events: readonly WalletCollectorEvent[];
}

export interface WalletCollector {
  readonly name: string;
  readonly chainFamily: ChainFamily;
  collect(input: {
    readonly wallets: readonly MonitoredWallet[];
    readonly cursor: string | null;
    readonly signal: AbortSignal;
  }): Promise<WalletCollectorResult>;
}

export interface NormalizedWalletObservation extends WalletCollectorEvent {
  readonly source: string;
  readonly chainFamily: ChainFamily;
  readonly accountId: string;
  readonly entityId: string;
  readonly collectedAt: number;
}
