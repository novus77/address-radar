import { normalizeFomoHandle } from "@address-radar/domain";
import type { AddressRadarRepository } from "@address-radar/database";

export type FomoLeaderboardWindow = "24h" | "30d";

export interface FomoLeaderboardEntry {
  readonly accountId: string;
  readonly handle: string;
  readonly rank: number;
  readonly profitUsd: number | null;
}

export interface FomoLeaderboardSource {
  top(window: FomoLeaderboardWindow, limit?: 100): Promise<readonly FomoLeaderboardEntry[]>;
}

export interface IdentityResolutionQueue {
  enqueue(handle: string): Promise<void>;
}

export function createLeaderboardSyncService(input: {
  readonly source: FomoLeaderboardSource;
  readonly repository: AddressRadarRepository;
  readonly identityQueue: IdentityResolutionQueue;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  return Object.freeze({
    async sync() {
      const observedAt = now();
      const windows: readonly FomoLeaderboardWindow[] = ["30d"];
      const unique = new Map<string, string>();
      let observations = 0;
      for (const window of windows) {
        const entries = await input.source.top(window, 100);
        for (const entry of entries.slice(0, 100)) {
          const handle = normalizeFomoHandle(entry.handle);
          input.repository.upsertFomoAccount({ accountId: entry.accountId, handle, firstSeenAt: observedAt, lastSeenAt: observedAt });
          input.repository.recordLeaderboardObservation({ accountId: entry.accountId, window, rank: entry.rank, profitUsd: entry.profitUsd, observedAt });
          input.repository.admitLeaderboardTrader({ entityId: `fomo:${entry.accountId}`, accountId: entry.accountId, observedAt });
          unique.set(entry.accountId, handle);
          observations += 1;
        }
      }
      let queuedIdentities = 0;
      for (const handle of unique.values()) {
        const cached = input.repository.identityResolution(handle);
        const validUntil = cached?.status === "deferred" ? cached.nextAttemptAt : cached?.expiresAt;
        if (validUntil !== undefined && validUntil > observedAt) continue;
        await input.identityQueue.enqueue(handle);
        queuedIdentities += 1;
      }
      input.repository.reconcileLeaderboardPopulation({ current30dAccountIds: [...unique.keys()], observedAt });
      return Object.freeze({ uniqueAccounts: unique.size, observations, queuedIdentities });
    },
  });
}
