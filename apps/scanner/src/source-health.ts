import type {
  SourceCursorRecord,
  SourceHealthRecord,
  SourceLedgerStore,
} from "@address-radar/database";
import type { DiscoveryChain, SourceId, SourceHealthState } from "@address-radar/domain";

export type SourceStream = "fomo_live" | "rpc_head" | "wallet_observation" | "market_snapshot" | "historical_worker";

export interface SourceHealthTarget {
  readonly source: SourceId;
  readonly chain: DiscoveryChain;
  readonly stream: SourceStream;
}

interface AttemptBase extends SourceHealthTarget {
  readonly startedAt: number;
}

export interface SourceSuccessAttempt extends AttemptBase {
  readonly cursor?: string;
  readonly position?: number;
  readonly lastEventAt?: number | null;
}

export interface SourceFailureAttempt extends AttemptBase {
  readonly errorCode: string;
  readonly rateLimitResetAt?: number | null;
}

export const SOURCE_FRESHNESS_THRESHOLDS_MS: Readonly<Record<SourceStream, { readonly degraded: number; readonly stale: number }>> = Object.freeze({
  fomo_live: Object.freeze({ degraded: 60_000, stale: 300_000 }),
  rpc_head: Object.freeze({ degraded: 30_000, stale: 120_000 }),
  wallet_observation: Object.freeze({ degraded: 120_000, stale: 600_000 }),
  market_snapshot: Object.freeze({ degraded: 120_000, stale: 600_000 }),
  historical_worker: Object.freeze({ degraded: 600_000, stale: 1_800_000 }),
});

export type SourceHealthLedger = Pick<SourceLedgerStore, "advanceCursor" | "sourceCursor" | "saveSourceHealth" | "sourceHealth">;

function freshnessState(ageMs: number, stream: SourceStream): SourceHealthState {
  const threshold = SOURCE_FRESHNESS_THRESHOLDS_MS[stream];
  if (ageMs >= threshold.stale) return "stale";
  if (ageMs >= threshold.degraded) return "degraded";
  return "healthy";
}

export function createSourceHealthRecorder(input: { readonly ledger: SourceHealthLedger; readonly clock: { now(): number } }) {
  const latency = (startedAt: number, now: number): number => Math.max(0, now - startedAt);

  return Object.freeze({
    recordSuccess(attempt: SourceSuccessAttempt): SourceHealthRecord {
      const now = input.clock.now();
      const previousCursor = input.ledger.sourceCursor(attempt.source, attempt.chain);
      const previousHealth = input.ledger.sourceHealth(attempt.source, attempt.chain);
      const hasCursor = attempt.cursor !== undefined && attempt.position !== undefined;
      const cursorAdvanced = hasCursor && (previousCursor === null || attempt.position! > previousCursor.position);

      if (cursorAdvanced) {
        const cursor: SourceCursorRecord = {
          source: attempt.source,
          chain: attempt.chain,
          cursor: attempt.cursor!,
          position: attempt.position!,
          updatedAt: now,
        };
        input.ledger.advanceCursor(cursor);
      }

      const durableCursor = input.ledger.sourceCursor(attempt.source, attempt.chain);
      const lastEventAt = attempt.lastEventAt ?? previousHealth?.lastEventAt ?? null;
      const previousProgressAt = Math.max(lastEventAt ?? 0, durableCursor?.updatedAt ?? 0, previousHealth?.lastSuccessAt ?? 0);
      const progressAt = cursorAdvanced ? now : previousProgressAt > 0 ? previousProgressAt : now;
      const health: SourceHealthRecord = Object.freeze({
        source: attempt.source,
        chain: attempt.chain,
        state: freshnessState(Math.max(0, now - progressAt), attempt.stream),
        lastAttemptAt: now,
        lastSuccessAt: now,
        lastEventAt,
        consecutiveFailures: 0,
        latencyMs: latency(attempt.startedAt, now),
        rateLimitResetAt: null,
        cursor: durableCursor?.cursor ?? previousHealth?.cursor ?? null,
        lastErrorCode: null,
      });
      input.ledger.saveSourceHealth(health);
      return health;
    },

    recordFailure(attempt: SourceFailureAttempt): SourceHealthRecord {
      const now = input.clock.now();
      const previous = input.ledger.sourceHealth(attempt.source, attempt.chain);
      const cursor = input.ledger.sourceCursor(attempt.source, attempt.chain);
      const rateLimited = attempt.errorCode === "rate_limited" || attempt.rateLimitResetAt != null;
      const health: SourceHealthRecord = Object.freeze({
        source: attempt.source,
        chain: attempt.chain,
        state: rateLimited ? "rate_limited" : "unavailable",
        lastAttemptAt: now,
        lastSuccessAt: previous?.lastSuccessAt ?? null,
        lastEventAt: previous?.lastEventAt ?? null,
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        latencyMs: latency(attempt.startedAt, now),
        rateLimitResetAt: attempt.rateLimitResetAt ?? null,
        cursor: cursor?.cursor ?? previous?.cursor ?? null,
        lastErrorCode: attempt.errorCode,
      });
      input.ledger.saveSourceHealth(health);
      return health;
    },
  });
}
