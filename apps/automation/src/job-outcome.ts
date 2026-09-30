import type { AutomationExecutionResult } from "./scheduler.js";

export type AutomationOutcomeReasonCode =
  | "missing_token_identity"
  | "missing_market_history"
  | "missing_milestone"
  | "missing_early_trades"
  | "missing_wallet_mapping"
  | "insufficient_coverage"
  | "no_eligible_wallets"
  | "evidence_below_threshold"
  | "already_current"
  | "unsupported_chain"
  | "provider_unavailable"
  | "manual_resolution_required"
  | "checkpoint_pending"
  | "retryable_failure"
  | "terminal_failure";

export interface AutomationJobOutcome {
  readonly status: "produced" | "no_output" | "deferred" | "terminal" | "failed";
  readonly reasonCode?: AutomationOutcomeReasonCode;
  readonly inputCount: number;
  readonly producedCount: number;
  readonly deferredCount: number;
  readonly diagnostic?: Readonly<Record<string, unknown>>;
}

export function inferAutomationJobOutcome(result: AutomationExecutionResult): AutomationJobOutcome {
  if (result.outcome) return result.outcome;
  if (result.status === "completed") {
    return { status: "produced", inputCount: 1, producedCount: 1, deferredCount: 0 };
  }
  if (result.status === "checkpoint") {
    return {
      status: "deferred",
      reasonCode: "checkpoint_pending",
      inputCount: 1,
      producedCount: 0,
      deferredCount: 1,
    };
  }
  if (result.status === "waiting_source") {
    return {
      status: "deferred",
      reasonCode: result.sourceBlock?.reasonCode ?? "provider_unavailable",
      inputCount: 1,
      producedCount: 0,
      deferredCount: 1,
    };
  }
  if (result.status === "retryable") {
    return {
      status: "failed",
      reasonCode: "retryable_failure",
      inputCount: 1,
      producedCount: 0,
      deferredCount: 1,
    };
  }
  return {
    status: "terminal",
    reasonCode: "terminal_failure",
    inputCount: 1,
    producedCount: 0,
    deferredCount: 0,
  };
}
