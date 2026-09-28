import type { DatabaseSync } from "node:sqlite";
import type { AutomationJobStore, ReturnTypeOfCreateRecoveryFactLinkStore, SourceLedgerStore, TokenFactStore } from "@address-radar/database";
import { createCandidateSourceRecoveryPlanner } from "./candidate-source-recovery.js";

export function reconcileMilestoneEarlyTradeFacts(input: {
  readonly database: DatabaseSync; readonly jobs: AutomationJobStore; readonly ledger: SourceLedgerStore;
  readonly factLinks: ReturnTypeOfCreateRecoveryFactLinkStore; readonly facts: TokenFactStore;
  readonly now?: () => number; readonly limit?: number;
}) {
  const at = (input.now ?? Date.now)();
  const limit = input.limit ?? 250;
  const rows = input.database.prepare(`SELECT DISTINCT m.token_id tokenId FROM token_milestone_crossings m
    LEFT JOIN token_fact_status f ON f.token_id=m.token_id AND f.fact_type='early_trades'
    WHERE m.precision!='unavailable' AND m.crossed_at IS NOT NULL AND f.token_id IS NULL
    ORDER BY m.token_id LIMIT ?`).all(limit) as Array<{ tokenId: string }>;
  const planner = createCandidateSourceRecoveryPlanner({ ledger: input.ledger, now: () => at });
  let available = 0; let scheduled = 0; let terminal = 0;
  for (const row of rows) {
    input.facts.ensure(row.tokenId, "early_trades", "milestone-fact-reconciliation-v1", at);
    const separator = row.tokenId.indexOf(":");
    if (separator <= 0 || separator === row.tokenId.length - 1) {
      input.facts.transition({ tokenId: row.tokenId, factType: "early_trades", status: "terminal_unavailable", terminalReason: "malformed_token_id", strategyVersion: "milestone-fact-reconciliation-v1", updatedAt: at });
      terminal += 1; continue;
    }
    const chain = row.tokenId.slice(0, separator); const tokenAddress = row.tokenId.slice(separator + 1);
    const milestone = input.database.prepare(`SELECT MIN(crossed_at) crossedAt FROM token_milestone_crossings WHERE token_id=? AND precision!='unavailable' AND crossed_at IS NOT NULL`).get(row.tokenId) as { crossedAt: number };
    const event = input.database.prepare(`SELECT 1 present FROM canonical_trader_events WHERE chain=? AND token_address=? AND side='buy' AND occurred_at<=? LIMIT 1`).get(chain, tokenAddress, milestone.crossedAt);
    if (event) {
      input.facts.transition({ tokenId: row.tokenId, factType: "early_trades", status: "available", precision: "exact", primarySource: "canonical_trader_events", coverageEndAt: milestone.crossedAt, observedAt: at, knownAt: at, strategyVersion: "milestone-fact-reconciliation-v1", updatedAt: at });
      input.jobs.wakeBlockedSource(row.tokenId, at, "candidate_evidence"); available += 1; continue;
    }
    input.facts.transition({ tokenId: row.tokenId, factType: "early_trades", status: "scheduled", nextAttemptAt: at, strategyVersion: "milestone-fact-reconciliation-v1", updatedAt: at });
    const plan = planner.plan({ reasonCode: "missing_early_trades", tokenId: row.tokenId, chain, tokenAddress });
    for (const jobId of plan.recoveryJobIds) input.factLinks.ensure(jobId, "early_trades", row.tokenId, at);
    scheduled += 1;
  }
  return Object.freeze({ examined: rows.length, available, scheduled, terminal, hasMore: rows.length === limit });
}
