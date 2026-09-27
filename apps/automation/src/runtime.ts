import {
  createAutomationJobStore,
  createTraderAutomationStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";
import { openWalletAnalysisStore } from "@address-radar/wallet-analysis";

import type { AutomationConfig } from "./config.js";
import { createAutomationScheduler, type AutomationHandler } from "./scheduler.js";
import { createTraderBackfillPlanner } from "./trader-backfill-planner.js";
import { createTraderLightweightWorker } from "./trader-lightweight-worker.js";
import { createInitialWalletBackfillWorker } from "./initial-wallet-backfill-worker.js";
import { createTokenPartitionPlanner } from "./token-partition-planner.js";
import { createTokenMiningWorker } from "./token-mining-worker.js";
import { createCandidateEvidenceWorker, enqueueCandidateEvidenceDispatcher } from "./candidate-evidence-worker.js";
import { createTraderAbilityWorker, enqueueTraderAbilityDispatcher } from "./trader-ability-worker.js";
import { createSqliteHistoricalTokenSource } from "./token-source-adapters.js";

export interface PlanningGateOptions {
  readonly intervalMs: number;
  readonly now?: () => number;
}

export interface PlanningGate {
  runIfDue(plan: (plannedAt: number) => void): boolean;
}

export function createPlanningGate(options: PlanningGateOptions): PlanningGate {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Planning interval must be a positive safe integer");
  }

  const now = options.now ?? Date.now;
  let nextPlanningAt = 0;

  return Object.freeze({
    runIfDue(plan: (plannedAt: number) => void): boolean {
      const plannedAt = now();
      if (plannedAt < nextPlanningAt) return false;

      plan(plannedAt);
      nextPlanningAt = plannedAt + options.intervalMs;
      return true;
    },
  });
}

export function createAutomationRuntime(input: {
  readonly config: AutomationConfig;
  readonly handlers?: readonly AutomationHandler[];
  readonly workerId: string;
  readonly now?: () => number;
}) {
  const database = openAddressRadarDatabase(input.config.databasePath);
  migrateAddressRadarDatabase(database);
  initializeCandidateHistorySchema(database);
  const store = createAutomationJobStore(database);
  const states = createTraderAutomationStore(database);
  const walletAnalysis = openWalletAnalysisStore(input.config.databasePath);
  const now = input.now ?? Date.now;
  const planner = createTraderBackfillPlanner({
    database,
    jobs: store,
    states,
    windowDays: input.config.backfillWindowDays,
    maximumTokens: input.config.backfillMaximumTokens,
    strategyVersion: "trader-backfill-v1",
  });
  const tokenPartitionPlanner = createTokenPartitionPlanner({ database, jobs: store });
  const tokenMiningWorker = createTokenMiningWorker({
    database,
    jobs: store,
    source: createSqliteHistoricalTokenSource({ database, now }),
    now,
  });
  const candidateEvidenceWorker = createCandidateEvidenceWorker({
    database,
    jobs: store,
    now,
  });
  enqueueCandidateEvidenceDispatcher(store, now());
  const traderAbilityWorker = createTraderAbilityWorker({ database, jobs: store, now });
  enqueueTraderAbilityDispatcher(store, now());
  const lightweightWorker = createTraderLightweightWorker({
    database,
    states,
    minimumBuyUsd: input.config.evidenceMinimumBuyUsd,
    strategyVersion: "trader-lightweight-v1",
    now,
  });
  const initialWalletBackfillWorker = createInitialWalletBackfillWorker({
    store: walletAnalysis,
    now,
  });
  const scheduler = createAutomationScheduler({
    enabled: input.config.enabled,
    enabledJobTypes: input.config.enabledJobTypes,
    store,
    handlers: [
      candidateEvidenceWorker,
      traderAbilityWorker,
      lightweightWorker,
      initialWalletBackfillWorker,
      tokenMiningWorker,
      ...(input.handlers ?? []),
    ],
    workerId: input.workerId,
    leaseMs: input.config.leaseMs,
    now,
  });
  const planningGate = createPlanningGate({
    intervalMs: input.config.planningIntervalMs,
    now,
  });
  return Object.freeze({
    pollOnce(signal: AbortSignal) {
      planningGate.runIfDue((plannedAt) => {
        planner.seed(plannedAt);
        tokenPartitionPlanner.seed(plannedAt);
      });
      return scheduler.runOnce(signal);
    },
    close() {
      walletAnalysis.close();
      database.close();
    },
  });
}
