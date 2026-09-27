import type {
  RecoveryJobRecord,
  RecoveryJobType,
  SourceLedgerStore,
} from "@address-radar/database";

export class RetryableRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableRecoveryError";
  }
}

export class TerminalRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalRecoveryError";
  }
}

class ProviderBudgetExhaustedError extends Error {
  readonly retryAt: number;

  constructor(provider: string, retryAt: number) {
    super(`${provider}_budget_exhausted`);
    this.name = "ProviderBudgetExhaustedError";
    this.retryAt = retryAt;
  }
}

export interface RecoveryHandlerResult {
  readonly cursor?: string;
  readonly reEvaluate?: { readonly kind: "token" | "trader"; readonly key: string };
}

export interface RecoveryHandlerContext {
  readonly job: RecoveryJobRecord;
  checkpoint(cursor: string): void;
  consumeBudget(input: {
    readonly provider: string;
    readonly usageWindow: string;
    readonly units: number;
    readonly limit: number;
    readonly retryAt: number;
  }): void;
}

export type RecoveryHandler = (context: RecoveryHandlerContext) => void | RecoveryHandlerResult | Promise<void | RecoveryHandlerResult>;
export type RecoveryHandlers = Partial<Readonly<Record<RecoveryJobType, RecoveryHandler>>>;

export interface RecoveryRunResult {
  readonly jobId: string | null;
  readonly outcome: "idle" | "completed" | "retry" | "dead_letter" | "budget_exhausted";
}

export function createRecoveryRuntime(input: {
  readonly ledger: SourceLedgerStore;
  readonly handlers: RecoveryHandlers;
  readonly clock: { now(): number };
  readonly leaseMs?: number;
  readonly retryBaseMs?: number;
  readonly onReEvaluate?: (request: NonNullable<RecoveryHandlerResult["reEvaluate"]>) => void | Promise<void>;
}) {
  const leaseMs = input.leaseMs ?? 60_000;
  const retryBaseMs = input.retryBaseMs ?? 30_000;

  return Object.freeze({
    async runOnce(): Promise<RecoveryRunResult> {
      const now = input.clock.now();
      const job = input.ledger.claimRecoveryJob(now, leaseMs);
      if (!job) return Object.freeze({ jobId: null, outcome: "idle" as const });
      const handler = input.handlers[job.jobType];

      try {
        if (!handler) throw new RetryableRecoveryError(`handler_unavailable:${job.jobType}`);
        let checkpoint = job.cursor;
        const result = await handler({
          job,
          checkpoint(cursor) { checkpoint = cursor; },
          consumeBudget(request) {
            if (request.provider === "dune" && job.jobType !== "historical_research") {
              throw new TerminalRecoveryError("dune_scope_violation");
            }
            const used = input.ledger.budgetUsage(request.provider, request.usageWindow);
            if (used + request.units > request.limit) throw new ProviderBudgetExhaustedError(request.provider, request.retryAt);
            input.ledger.addBudgetUsage(request.provider, request.usageWindow, request.units, input.clock.now());
          },
        });
        checkpoint = result?.cursor ?? checkpoint;
        if (checkpoint !== null) input.ledger.checkpointRecoveryJob(job.jobId, checkpoint, input.clock.now());
        input.ledger.completeRecoveryJob(job.jobId, input.clock.now());
        if (result?.reEvaluate) await input.onReEvaluate?.(result.reEvaluate);
        return Object.freeze({ jobId: job.jobId, outcome: "completed" as const });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof ProviderBudgetExhaustedError) {
          input.ledger.failRecoveryJob(job.jobId, message, error.retryAt);
          return Object.freeze({ jobId: job.jobId, outcome: "budget_exhausted" as const });
        }
        if (error instanceof TerminalRecoveryError) {
          input.ledger.failRecoveryJob(job.jobId, message, input.clock.now(), true);
          return Object.freeze({ jobId: job.jobId, outcome: "dead_letter" as const });
        }
        const exponent = Math.max(0, job.attemptCount - 1);
        const retryAt = input.clock.now() + Math.min(retryBaseMs * 2 ** exponent, 3_600_000);
        input.ledger.failRecoveryJob(job.jobId, message, retryAt);
        return Object.freeze({ jobId: job.jobId, outcome: "retry" as const });
      }
    },
  });
}
