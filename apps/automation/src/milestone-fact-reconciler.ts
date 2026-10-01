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
  const retryAt = at + 30 * 60_000;
  const milestoneRows = input.database.prepare(`
    WITH inventory AS (
      SELECT token_id FROM token_market_snapshots
      WHERE typeof(observed_at) = 'integer' AND observed_at BETWEEN 0 AND ?
      UNION
      SELECT token_id FROM token_fact_status
      WHERE fact_type = 'price_history' AND status IN ('available', 'partial', 'degraded')
        AND updated_at <= ?
    )
    SELECT inventory.token_id tokenId FROM inventory
    LEFT JOIN token_milestone_crossings milestone
      ON milestone.token_id = inventory.token_id
      AND milestone.precision != 'unavailable' AND typeof(milestone.crossed_at) = 'integer'
      AND milestone.crossed_at BETWEEN 0 AND ? AND milestone.market_cap_usd > 0
      AND length(trim(milestone.source)) > 0
    LEFT JOIN token_fact_status fact
      ON fact.token_id = inventory.token_id AND fact.fact_type = 'milestone_crossings'
    WHERE milestone.token_id IS NULL
      AND COALESCE(fact.status, 'missing') IN (
        'missing', 'scheduled', 'retry_scheduled', 'partial', 'degraded', 'conflicted'
      )
      AND (fact.next_attempt_at IS NULL OR fact.next_attempt_at <= ?)
    ORDER BY COALESCE(fact.updated_at, 0), inventory.token_id
    LIMIT ?
  `).all(at, at, at, at, limit) as Array<{ tokenId: string }>;
  const planner = createCandidateSourceRecoveryPlanner({ ledger: input.ledger, now: () => at });
  let milestoneScheduled = 0;
  let recoveryRequeued = 0;
  for (const row of milestoneRows) {
    input.facts.ensure(row.tokenId, "milestone_crossings", "milestone-fact-reconciliation-v2", at);
    const fact = input.facts.fact(row.tokenId, "milestone_crossings")!;
    if (fact.nextAttemptAt !== null && fact.nextAttemptAt > at) continue;
    const separator = row.tokenId.indexOf(":");
    if (separator <= 0 || separator === row.tokenId.length - 1) {
      input.facts.transition({ tokenId: row.tokenId, factType: "milestone_crossings", status: "terminal_unavailable", terminalReason: "malformed_token_id", strategyVersion: "milestone-fact-reconciliation-v2", updatedAt: at });
      continue;
    }
    if (fact.status !== "scheduled") {
      input.facts.transition({ tokenId: row.tokenId, factType: "milestone_crossings", status: "scheduled", nextAttemptAt: retryAt, strategyVersion: "milestone-fact-reconciliation-v2", updatedAt: at });
    }
    const chain = row.tokenId.slice(0, separator);
    const tokenAddress = row.tokenId.slice(separator + 1);
    const plan = planner.plan({ reasonCode: "missing_milestone", tokenId: row.tokenId, chain, tokenAddress });
    for (const jobId of plan.recoveryJobIds) {
      input.factLinks.ensure(jobId, "milestone_crossings", row.tokenId, at);
      if (input.ledger.requeueCompletedRecoveryJob(jobId, at, at)) recoveryRequeued += 1;
    }
    milestoneScheduled += 1;
  }
  const rows = input.database.prepare(`SELECT DISTINCT m.token_id tokenId FROM token_milestone_crossings m
    LEFT JOIN token_fact_status f ON f.token_id=m.token_id AND f.fact_type='early_trades'
    WHERE m.precision!='unavailable' AND typeof(m.crossed_at)='integer'
      AND m.crossed_at BETWEEN 0 AND ? AND m.market_cap_usd>0 AND length(trim(m.source))>0
      AND COALESCE(f.status, 'missing') IN (
        'missing', 'scheduled', 'retry_scheduled', 'partial', 'degraded', 'conflicted'
      )
      AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= ?)
    ORDER BY COALESCE(f.updated_at, 0), m.token_id LIMIT ?`).all(at, at, limit) as Array<{ tokenId: string }>;
  let available = 0; let scheduled = 0; let terminal = 0;
  for (const row of rows) {
    input.facts.ensure(row.tokenId, "early_trades", "milestone-fact-reconciliation-v1", at);
    const separator = row.tokenId.indexOf(":");
    if (separator <= 0 || separator === row.tokenId.length - 1) {
      input.facts.transition({ tokenId: row.tokenId, factType: "early_trades", status: "terminal_unavailable", terminalReason: "malformed_token_id", strategyVersion: "milestone-fact-reconciliation-v1", updatedAt: at });
      terminal += 1; continue;
    }
    const chain = row.tokenId.slice(0, separator); const tokenAddress = row.tokenId.slice(separator + 1);
    const milestone = input.database.prepare(`SELECT MIN(crossed_at) crossedAt FROM token_milestone_crossings WHERE token_id=? AND precision!='unavailable' AND typeof(crossed_at)='integer' AND crossed_at BETWEEN 0 AND ? AND market_cap_usd>0 AND length(trim(source))>0`).get(row.tokenId, at) as { crossedAt: number };
    const event = input.database.prepare(`SELECT 1 present FROM canonical_trader_events WHERE chain=? AND token_address=? AND side='buy' AND typeof(occurred_at)='integer' AND occurred_at BETWEEN 0 AND ? LIMIT 1`).get(chain, tokenAddress, milestone.crossedAt);
    if (event) {
      input.facts.transition({ tokenId: row.tokenId, factType: "early_trades", status: "available", precision: "exact", primarySource: "canonical_trader_events", coverageEndAt: milestone.crossedAt, observedAt: at, knownAt: at, strategyVersion: "milestone-fact-reconciliation-v1", updatedAt: at });
      input.jobs.wakeBlockedSource(row.tokenId, at, "candidate_evidence"); available += 1; continue;
    }
    const fact = input.facts.fact(row.tokenId, "early_trades")!;
    if (fact.nextAttemptAt !== null && fact.nextAttemptAt > at) continue;
    if (fact.status !== "scheduled") {
      input.facts.transition({ tokenId: row.tokenId, factType: "early_trades", status: "scheduled", nextAttemptAt: retryAt, strategyVersion: "milestone-fact-reconciliation-v1", updatedAt: at });
    }
    const plan = planner.plan({ reasonCode: "missing_early_trades", tokenId: row.tokenId, chain, tokenAddress });
    for (const jobId of plan.recoveryJobIds) {
      input.factLinks.ensure(jobId, "early_trades", row.tokenId, at);
      if (input.ledger.requeueCompletedRecoveryJob(jobId, at, at)) recoveryRequeued += 1;
    }
    scheduled += 1;
  }
  return Object.freeze({
    examined: rows.length,
    available,
    scheduled,
    terminal,
    milestoneExamined: milestoneRows.length,
    milestoneScheduled,
    recoveryRequeued,
    hasMore: rows.length === limit || milestoneRows.length === limit,
  });
}
