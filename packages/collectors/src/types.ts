import type { TraderEvent } from "@address-radar/domain";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface JsonRpcClient {
  request<T>(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<T>;
}

export interface TokenMarketSnapshot {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly marketCapBasis?: "market_cap" | "unavailable";
  readonly liquidityUsd: number | null;
  readonly symbol?: string | null;
  readonly name?: string | null;
  readonly imageUrl?: string | null;
  readonly createdAt?: number | null;
  readonly launchedAt?: number | null;
  readonly observedAt: string;
}

export interface TokenMarketProvider {
  lookup(chain: string, tokenAddress: string, signal?: AbortSignal): Promise<TokenMarketSnapshot | null>;
}

export interface TradeEventRepository {
  insertTraderEvent(event: TraderEvent): { readonly inserted: boolean };
}

export interface OnchainWalletRecord {
  readonly eventId?: string;
  readonly transactionHash?: string;
  readonly chainFamily?: "evm" | "solana";
  readonly chain?: string;
  readonly walletAddress?: string;
  readonly tokenAddress?: string;
  readonly side?: "buy" | "sell";
  readonly amountUsd?: number | null;
  readonly priceUsd?: number | null;
  readonly marketCapUsd?: number | null;
  readonly occurredAt?: number;
}

export interface ResolvedTraderIdentity {
  readonly accountId: string;
  readonly entityId: string;
  readonly collectedAt: number;
}
