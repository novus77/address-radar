import type { DatabaseSync } from "node:sqlite";

import type {
  AutomationJobStore,
  TraderAutomationStore,
} from "@address-radar/database";
import type { TraderAutomationTier } from "@address-radar/domain";

export const TRADER_EVALUATION_INTERVALS = Object.freeze({
  T0: { fomoMs: 15 * 60_000, walletMs: 60 * 60_000 },
  T1: { fomoMs: 60 * 60_000, walletMs: 6 * 60 * 60_000 },
  T2: { fomoMs: 6 * 60 * 60_000, walletMs: null },
  T3: { fomoMs: 7 * 24 * 60 * 60_000, walletMs: null },
} as const satisfies Readonly<Record<TraderAutomationTier, {
  readonly fomoMs: number;
  readonly walletMs: number | null;
}>>);

export interface TraderBackfillPlan {
  readonly lightweightEvaluations: readonly {
    readonly traderId: string;
    readonly tier: TraderAutomationTier;
    readonly dueAt: number;
  }[];
  readonly deepBackfills: readonly {
    readonly traderId: string;
    readonly chainFamily: "solana" | "evm";
    readonly address: string;
    readonly windowDays: number;
    readonly maximumTokens: number;
  }[];
  readonly identityRequests: readonly {
    readonly traderId: string;
    readonly accountIds: readonly string[];
  }[];
}

export function createTraderBackfillPlanner(input: {
  readonly database: DatabaseSync;
  readonly jobs: AutomationJobStore;
  readonly states: TraderAutomationStore;
  readonly windowDays: number;
  readonly maximumTokens: number;
  readonly strategyVersion: string;
}) {
  void input.database;
  return Object.freeze({
    seed(now: number): TraderBackfillPlan {
      const lightweightEvaluations: TraderBackfillPlan["lightweightEvaluations"][number][] = [];
      const deepBackfills: TraderBackfillPlan["deepBackfills"][number][] = [];
      const identityRequests: TraderBackfillPlan["identityRequests"][number][] = [];
      let lightweightCapacity = Math.max(0, 5_000 - input.jobs.activeCount("trader_lightweight_evaluation"));
      for (const subject of input.states.subjects()) {
        const interval = TRADER_EVALUATION_INTERVALS[subject.tier].fomoMs;
        const slot = Math.floor(now / interval);
        const lightweightKey = `trader-lightweight:${subject.traderId}:${slot}:${input.strategyVersion}`;
        const lightweightResult = lightweightCapacity > 0 ? input.jobs.enqueue({
          jobId: lightweightKey,
          idempotencyKey: lightweightKey,
          lane: "trader_backfill",
          jobType: "trader_lightweight_evaluation",
          subjectKey: subject.traderId,
          priority: tierPriority(subject.tier),
          cursor: null,
          nextAttemptAt: now,
          payload: JSON.stringify({ traderId: subject.traderId, tier: subject.tier }),
          createdAt: now,
        }) : null;
        if (lightweightResult) {
          if (lightweightResult.inserted) lightweightCapacity -= 1;
          lightweightEvaluations.push(Object.freeze({
            traderId: subject.traderId,
            tier: subject.tier,
            dueAt: now,
          }));
        }

        if ((subject.tier === "T0" || subject.tier === "T1") && subject.wallets.length > 0) {
          for (const wallet of subject.wallets) {
            const key = [
              "initial-wallet-backfill",
              subject.traderId,
              wallet.chainFamily,
              wallet.address,
              `${input.windowDays}d`,
              input.maximumTokens,
              input.strategyVersion,
            ].join(":");
            input.jobs.enqueue({
              jobId: key,
              idempotencyKey: key,
              lane: "trader_backfill",
              jobType: "initial_wallet_backfill",
              subjectKey: subject.traderId,
              priority: tierPriority(subject.tier),
              cursor: null,
              nextAttemptAt: now,
              payload: JSON.stringify({
                traderId: subject.traderId,
                chainFamily: wallet.chainFamily,
                address: wallet.address,
                windowDays: input.windowDays,
                maximumTokens: input.maximumTokens,
              }),
              createdAt: now,
            });
            deepBackfills.push(Object.freeze({
              traderId: subject.traderId,
              chainFamily: wallet.chainFamily,
              address: wallet.address,
              windowDays: input.windowDays,
              maximumTokens: input.maximumTokens,
            }));
          }
        } else if (subject.tier === "T2" && subject.wallets.length === 0) {
          const key = `identity-resolution:${subject.traderId}:${input.strategyVersion}`;
          input.jobs.enqueue({
            jobId: key,
            idempotencyKey: key,
            lane: "repair",
            jobType: "identity_resolution",
            subjectKey: subject.traderId,
            priority: tierPriority(subject.tier),
            cursor: null,
            nextAttemptAt: now,
            payload: JSON.stringify({ traderId: subject.traderId, accountIds: subject.accountIds }),
            createdAt: now,
          });
          identityRequests.push(Object.freeze({
            traderId: subject.traderId,
            accountIds: subject.accountIds,
          }));
        }

        if (lightweightResult && (subject.coverageState === "unseen" || subject.coverageState === "stale")) {
          input.states.updateCoverage(subject.traderId, {
            coverageState: "queued",
            lastCoveredAt: subject.lastCoveredAt,
            nextEvaluationAt: now + interval,
            strategyVersion: input.strategyVersion,
            updatedAt: now,
          });
        }
      }
      return Object.freeze({
        lightweightEvaluations: Object.freeze(lightweightEvaluations),
        deepBackfills: Object.freeze(deepBackfills),
        identityRequests: Object.freeze(identityRequests),
      });
    },
  });
}

function tierPriority(tier: TraderAutomationTier): number {
  return ({ T0: 10, T1: 20, T2: 30, T3: 40 } as const)[tier];
}
