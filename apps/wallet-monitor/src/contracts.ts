import type { ExecutionBasis } from "./execution-basis.js";
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
  readonly sourceReference: string;
  readonly sourceBlockNumber?: number;
  readonly sourceBlockHash?: string;
  readonly executionBasis?: ExecutionBasis;
}

export interface WalletCollectorPartition {
  readonly partitionKey: string;
  readonly nextCheckpoint: string;
  readonly events: readonly WalletCollectorEvent[];
  readonly canonicalBlocks?: readonly { readonly blockNumber: number; readonly blockHash: string }[];
}

export interface WalletCollectorResult {
  readonly partitions: readonly WalletCollectorPartition[];
  readonly failures?: readonly { readonly partitionKey: string; readonly error: string }[];
  readonly diagnostics?: readonly {
    readonly partitionKey: string;
    readonly reason: string;
    readonly sourceReference: string;
  }[];
}

export interface WalletCollector {
  readonly name: string;
  readonly chainFamily: ChainFamily;
  collect(input: {
    readonly wallets: readonly MonitoredWallet[];
    readonly checkpoint: (partitionKey: string) => string | null;
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
