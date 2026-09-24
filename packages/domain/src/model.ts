export type TraderLifecycle = "candidate" | "probation" | "active" | "elite" | "degraded" | "suspended";
export type IdentityConfidence = "low" | "medium" | "high" | "confirmed";
export type ChainFamily = "solana" | "evm";
export type TraderStyle = "EARLY_LAUNCH" | "HIGH_MULTIPLE" | "MOMENTUM" | "HIGH_CAP" | "LARGE_CAP" | "OLD_TOKEN_MOMENTUM" | "CONCENTRATED" | "SCALPER" | "SWING" | "NARRATIVE" | "LEADER" | "FOLLOWER";
export type TraderSide = "buy" | "sell";
export type TraderEventSource = "fomo_stream" | "fomo_profile" | "fomo_leaderboard" | "fomo_token_history" | "onchain_wallet";

export interface FomoAccountInput {
  readonly accountId: string;
  readonly handle: string;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface WalletIdentityInput {
  readonly accountId: string;
  readonly chainFamily: ChainFamily;
  readonly address: string;
  readonly confidence: IdentityConfidence;
  readonly source: string;
  readonly observedAt: number;
}

export interface WalletIdentity extends WalletIdentityInput {
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
}

export interface FomoAccount extends FomoAccountInput {
  readonly wallets: readonly WalletIdentity[];
}

export interface TraderEntityInput {
  readonly entityId: string;
  readonly lifecycle: TraderLifecycle;
  readonly manual: boolean;
  readonly locked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EntityAccountLinkInput {
  readonly accountId: string;
  readonly entityId: string;
  readonly confidence: IdentityConfidence;
  readonly source: string;
  readonly observedAt: number;
}

export interface TraderEvent {
  readonly eventId: string;
  readonly accountId: string;
  readonly entityId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly side: TraderSide;
  readonly amountUsd: number | null;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly tokenAgeMs: number | null;
  readonly occurredAt: number;
  readonly collectedAt: number;
  readonly source: TraderEventSource;
}

export interface TraderScoreSnapshot {
  readonly snapshotId: string;
  readonly entityId: string;
  readonly strategyVersion: string;
  readonly window: "3d" | "7d" | "30d" | "90d" | "lifetime";
  readonly quality: number;
  readonly rawQuality?: number;
  readonly sampleConfidence?: number;
  readonly coverageConfidence?: number;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly components: Readonly<Record<string, number>>;
  readonly sampleCount: number;
  readonly asOf?: number;
  readonly recordedAt: number;
}
