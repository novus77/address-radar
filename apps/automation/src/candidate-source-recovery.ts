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

const recoveryType = (reason: CandidateSourceBlockReason) => {
  if (reason === "missing_early_trades") return { jobType: "milestone_early_buyers" as const, priority: 35 };
  if (reason === "missing_wallet_mapping") return { jobType: "identity_resolution" as const, priority: 40 };
  if (reason === "missing_milestone" || reason === "insufficient_coverage") return { jobType: "historical_research" as const, priority: 60 };
  return { jobType: "market_enrichment" as const, priority: 20 };
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
      const recovery = recoveryType(request.reasonCode);
      const jobId = `recovery:${recovery.jobType}:${request.tokenId}`;
      const createdAt = now();
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
      return Object.freeze({ recoveryJobIds: Object.freeze([jobId]) });
    },
  });
}
