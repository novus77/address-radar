import type { TraderEvent } from "@address-radar/domain";

export type FomoLeaderboardWindow = "24h" | "30d";

export interface FomoBrowserSession {
  authenticated(): Promise<boolean>;
  leaderboardPayload(window: FomoLeaderboardWindow): Promise<unknown>;
}

export interface FomoLeaderboardEntry {
  readonly accountId: string;
  readonly handle: string;
  readonly rank: number;
  readonly profitUsd: number | null;
}

export interface FomoLeaderboardSource {
  top(window: FomoLeaderboardWindow, limit?: 100): Promise<readonly FomoLeaderboardEntry[]>;
}

export interface RawFomoTraderActivityEvent extends Omit<TraderEvent, "eventId"> {
  readonly eventId: string | null;
}

export interface FomoTraderActivitySource {
  authenticated(): Promise<boolean>;
  recentActivity(accountId: string, after: number | null): Promise<readonly RawFomoTraderActivityEvent[]>;
}
