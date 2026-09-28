import type { RecoveryJobRecord, RecoveryJobType, TokenFactType } from "@address-radar/database";

export interface RecoveryPostcondition {
  readonly factType: TokenFactType;
  readonly factKey: string;
  verify():
    | { readonly status: "satisfied"; readonly producedCount: number }
    | { readonly status: "deferred"; readonly reasonCode: string }
    | { readonly status: "terminal"; readonly reasonCode: string };
}

const FACT_BY_JOB_TYPE: Partial<Readonly<Record<RecoveryJobType, TokenFactType>>> = Object.freeze({
  market_enrichment: "market_identity",
  market_history: "price_history",
  milestone_early_buyers: "early_trades",
  historical_research: "milestone_crossings",
  fomo_token_history: "price_history",
  identity_resolution: "trader_attribution",
});

export function expectedRecoveryFact(job: RecoveryJobRecord): { readonly factType: TokenFactType; readonly factKey: string } | null {
  const factType = FACT_BY_JOB_TYPE[job.jobType];
  return factType ? Object.freeze({ factType, factKey: job.subjectKey }) : null;
}
