import type { DatabaseSync } from "node:sqlite";

import type { TraderAutomationStore } from "@address-radar/database";

import type { AutomationHandler } from "./scheduler.js";
import { TRADER_EVALUATION_INTERVALS } from "./trader-backfill-planner.js";

export function createTraderLightweightWorker(input: {
  readonly database: DatabaseSync;
  readonly states: TraderAutomationStore;
  readonly minimumBuyUsd: number;
  readonly strategyVersion: string;
  readonly now?: () => number;
}): AutomationHandler {
  const now = input.now ?? Date.now;
  return Object.freeze<AutomationHandler>({
    jobType: "trader_lightweight_evaluation",
    async execute(job) {
      const payload = JSON.parse(job.payload) as { traderId?: unknown };
      const traderId = typeof payload.traderId === "string" ? payload.traderId : "";
      if (!traderId) return { status: "terminal", diagnostic: "missing_trader_id" } as const;
      const state = input.states.state(traderId);
      if (!state) return { status: "terminal", diagnostic: "unknown_trader" } as const;
      const eventMetrics = input.database.prepare(`
        SELECT COALESCE(SUM(amount_usd), 0) AS cumulativeBuyUsd,
          COUNT(DISTINCT LOWER(chain) || ':' || LOWER(token_address)) AS distinctTokens
        FROM canonical_trader_events
        WHERE entity_id = ? AND side = 'buy'
          AND source_status IN ('FOMO_ONLY', 'FOMO_AND_ONCHAIN')
      `).get(traderId) as { cumulativeBuyUsd: number; distinctTokens: number };
      const evidence = input.database.prepare(`
        SELECT COALESCE(MAX(theoretical_opportunity), 0) AS maximumOpportunity,
          COUNT(DISTINCT token_id) AS evidenceTokens
        FROM candidate_evidence_v3 WHERE trader_id = ?
      `).get(traderId) as { maximumOpportunity: number; evidenceTokens: number };
      const shouldUpgrade = state.tier === "T3" && (
        (Number(eventMetrics.cumulativeBuyUsd) >= input.minimumBuyUsd && Number(eventMetrics.distinctTokens) >= 2)
        || Number(evidence.maximumOpportunity) >= 3
        || Number(evidence.evidenceTokens) >= 2
      );
      const evaluatedAt = now();
      if (shouldUpgrade) input.states.setTier(traderId, "T2", evaluatedAt);
      const nextTier = shouldUpgrade ? "T2" : state.tier;
      input.states.updateCoverage(traderId, {
        coverageState: "current",
        lastCoveredAt: evaluatedAt,
        nextEvaluationAt: evaluatedAt + TRADER_EVALUATION_INTERVALS[nextTier].fomoMs,
        strategyVersion: input.strategyVersion,
        updatedAt: evaluatedAt,
      });
      return {
        status: "completed",
        diagnostic: [
          `cumulativeBuyUsd=${Number(eventMetrics.cumulativeBuyUsd)}`,
          `distinctTokens=${Number(eventMetrics.distinctTokens)}`,
          `maximumOpportunity=${Number(evidence.maximumOpportunity)}`,
          `tier=${nextTier}`,
        ].join(","),
      } as const;
    },
  });
}
