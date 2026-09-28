import type { SourceLedgerStore } from "@address-radar/database";
import { normalizeDiscoveryChain, type CandidateSourceBlockReason } from "@address-radar/domain";

export interface CandidateSourceRecoveryRequest {
  readonly reasonCode: CandidateSourceBlockReason;
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
}

export interface CandidateSourceRecoveryPlan {
  readonly recoveryJobIds: readonly string[];
}

const recoveryTypes = (reason: CandidateSourceBlockReason, chain: string) => {
  if (reason === "missing_early_trades") return [{ jobType: "milestone_early_buyers" as const, priority: 35 }];
  if (reason === "missing_wallet_mapping") return [];
  if (reason === "missing_market_history") {
    return chain.toLowerCase() === "robinhood"
      ? [{ jobType: "fomo_token_history" as const, priority: 25 }]
      : [{ jobType: "market_history" as const, priority: 25 }];
  }
  if (reason === "missing_milestone" || reason === "insufficient_coverage") {
    return [
      { jobType: "market_enrichment" as const, priority: 20 },
      { jobType: "historical_research" as const, priority: 60 },
    ];
  }
  return [{ jobType: "market_enrichment" as const, priority: 20 }];
};

export interface CandidateSourceRecoveryPlanner {
  plan(request: CandidateSourceRecoveryRequest): CandidateSourceRecoveryPlan;
}

export function createCandidateSourceRecoveryPlanner(input: {
  readonly ledger: SourceLedgerStore;
  readonly now?: () => number;
}): CandidateSourceRecoveryPlanner {
  const now = input.now ?? Date.now;
  return Object.freeze({
    plan(request: CandidateSourceRecoveryRequest) {
      const createdAt = now();
      const recoveryJobIds = recoveryTypes(request.reasonCode, request.chain).map((recovery) => {
        const jobId = `recovery:${recovery.jobType}:${request.tokenId}`;
        input.ledger.enqueueRecoveryJob({
          jobId,
          jobType: recovery.jobType,
          chain: normalizeDiscoveryChain(request.chain),
          subjectKey: request.tokenId,
          priority: recovery.priority,
          cursor: null,
          nextAttemptAt: createdAt,
          createdAt,
        });
        return jobId;
      });
      return Object.freeze({ recoveryJobIds: Object.freeze(recoveryJobIds) });
    },
  });
}
