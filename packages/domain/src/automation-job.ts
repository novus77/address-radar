export type AutomationLane = "trader_backfill" | "token_mining" | "repair";

export type AutomationJobStatus =
  | "pending"
  | "leased"
  | "running"
  | "waiting_source"
  | "blocked_source"
  | "retryable"
  | "completed"
  | "terminal"
  | "cancelled";

export type CandidateSourceBlockReason =
  | "missing_token_identity"
  | "missing_market_history"
  | "missing_milestone"
  | "missing_early_trades"
  | "missing_wallet_mapping"
  | "insufficient_coverage";

export interface AutomationJobSourceBlock {
  readonly jobId: string;
  readonly reasonCode: CandidateSourceBlockReason;
  readonly context: Readonly<Record<string, unknown>>;
  readonly recoveryJobIds: readonly string[];
  readonly blockedAt: number;
  readonly updatedAt: number;
  readonly resolvedAt: number | null;
}

export interface AutomationJob {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly lane: AutomationLane;
  readonly jobType: string;
  readonly subjectKey: string;
  readonly priority: number;
  readonly status: AutomationJobStatus;
  readonly cursor: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseExpiresAt: number | null;
  readonly payload: string;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}
