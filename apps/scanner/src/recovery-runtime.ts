import type {
  RecoveryJobRecord,
  RecoveryJobType,
  ReturnTypeOfCreateRecoveryFactLinkStore,
  SourceLedgerStore,
  TokenFactStore,
  TokenFactAttemptOutcome,
} from "@address-radar/database";

import { expectedRecoveryFact, type RecoveryPostcondition } from "./recovery-postcondition.js";

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

export class WaitingRecoveryResultError extends RetryableRecoveryError {
  constructor(message: string, readonly retryAt: number) {
    super(message);
    this.name = "WaitingRecoveryResultError";
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
  readonly postcondition?: RecoveryPostcondition;
}

export interface RecoveryHandlerContext {
  readonly job: RecoveryJobRecord;
  readonly signal?: AbortSignal;
  assertActive?(): void;
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
  readonly deadlineMs?: number;
  readonly retryBaseMs?: number;
  readonly factLinks?: ReturnTypeOfCreateRecoveryFactLinkStore;
  readonly tokenFacts?: TokenFactStore;
  readonly onReEvaluate?: (request: NonNullable<RecoveryHandlerResult["reEvaluate"]>) => void | Promise<void>;
}) {
  const deadlineMs = input.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("Recovery deadline must be a positive integer");
  const leaseMs = Math.max(input.leaseMs ?? 60_000, deadlineMs + 5_000);
  const retryBaseMs = input.retryBaseMs ?? 30_000;

  return Object.freeze({
    async runOnce(): Promise<RecoveryRunResult> {
      const now = input.clock.now();
      const job = input.ledger.claimRecoveryJob(now, leaseMs);
      if (!job) return Object.freeze({ jobId: null, outcome: "idle" as const });
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const ownsLease = (): boolean => {
        const current = input.ledger.recoveryJob(job.jobId);
        return current?.status === "running" && current.attemptCount === job.attemptCount
          && current.leaseExpiresAt !== null && current.leaseExpiresAt > input.clock.now();
      };
      const assertActive = (): void => {
        controller.signal.throwIfAborted();
        if (input.clock.now() >= now + deadlineMs) throw new RetryableRecoveryError("recovery_deadline_exceeded");
        if (!ownsLease()) throw new RetryableRecoveryError("recovery_lease_lost");
      };
      const handler = input.handlers[job.jobType];
      const expectedFact = expectedRecoveryFact(job);
      if (expectedFact) input.factLinks?.ensure(job.jobId, expectedFact.factType, expectedFact.factKey, now);
      const attemptFact = expectedFact && job.jobType !== "identity_resolution" ? expectedFact : null;
      const previousFact = attemptFact ? input.tokenFacts?.ensure(attemptFact.factKey, attemptFact.factType, "token-facts-v1", now) : null;
      const providers = new Set<string>();
      const recordAttempt = (outcome: TokenFactAttemptOutcome, reasonCode: string | null = null, retryAt: number | null = null): void => {
        if (!attemptFact || !input.tokenFacts) return;
        const fact = input.tokenFacts.fact(attemptFact.factKey, attemptFact.factType);
        input.tokenFacts.recordAttempt({
          attemptId: `${job.jobId}:attempt:${job.attemptCount}`,
          tokenId: attemptFact.factKey,
          factType: attemptFact.factType,
          provider: [...providers].sort().join(",") || `recovery:${job.jobType}`,
          outcome,
          startedAt: now,
          finishedAt: Math.max(now, input.clock.now()),
          factsWritten: fact && previousFact && fact.revision > previousFact.revision ? 1 : 0,
          coverageStartAt: fact?.coverageStartAt ?? null,
          coverageEndAt: fact?.coverageEndAt ?? null,
          retryAt,
          message: reasonCode,
          payload: { jobType: job.jobType, attempt: job.attemptCount, previousRevision: previousFact?.revision ?? null, revision: fact?.revision ?? null },
        });
      };
      let reEvaluate: RecoveryHandlerResult["reEvaluate"];
      let checkpoint = job.cursor;

      try {
        if (!handler) throw new RetryableRecoveryError(`handler_unavailable:${job.jobType}`);
        const execution = handler({
          job,
          signal: controller.signal,
          assertActive,
          checkpoint(cursor) { assertActive(); checkpoint = cursor; },
          consumeBudget(request) {
            assertActive();
            providers.add(request.provider);
            if (request.provider === "dune" && job.jobType !== "historical_research") {
              throw new TerminalRecoveryError("dune_scope_violation");
            }
            if (!input.ledger.tryConsumeBudget(request.provider, request.usageWindow, request.units, request.limit, input.clock.now())) throw new ProviderBudgetExhaustedError(request.provider, request.retryAt);
          },
        });
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new RetryableRecoveryError("recovery_deadline_exceeded");
            controller.abort(error);
            reject(error);
          }, deadlineMs);
        });
        const result = await Promise.race([execution, deadline]);
        assertActive();
        checkpoint = result?.cursor ?? checkpoint;
        if (result?.postcondition) {
          const verification = result.postcondition.verify();
          if (verification.status === "deferred") throw new RetryableRecoveryError(verification.reasonCode);
          if (verification.status === "terminal") throw new TerminalRecoveryError(verification.reasonCode);
          input.factLinks?.satisfy(job.jobId, result.postcondition.factType, result.postcondition.factKey, input.clock.now());
        } else if (expectedFact && input.factLinks) {
          throw new RetryableRecoveryError(`postcondition_missing:${expectedFact.factType}`);
        }
        if (checkpoint !== null) input.ledger.checkpointRecoveryJob(job.jobId, checkpoint, input.clock.now());
        input.ledger.completeRecoveryJob(job.jobId, input.clock.now());
        const fact = attemptFact ? input.tokenFacts?.fact(attemptFact.factKey, attemptFact.factType) : null;
        recordAttempt(fact?.status === "partial" ? "partial" : fact?.status === "available" ? "available" : "empty");
        reEvaluate = result?.reEvaluate;
      } catch (error) {
        controller.abort(error);
        if (!ownsLease()) return Object.freeze({ jobId: job.jobId, outcome: "retry" as const });
        const message = error instanceof Error ? error.message : String(error);
        if (checkpoint !== null && checkpoint !== job.cursor) input.ledger.checkpointRecoveryJob(job.jobId, checkpoint, input.clock.now());
        if (error instanceof WaitingRecoveryResultError) {
          const retryAt = Math.max(input.clock.now() + 1, error.retryAt);
          input.ledger.failRecoveryJob(job.jobId, message, retryAt, false, input.clock.now());
          recordAttempt("empty", "waiting_result", retryAt);
          return Object.freeze({ jobId: job.jobId, outcome: "retry" as const });
        }
        if (error instanceof ProviderBudgetExhaustedError) {
          input.ledger.failRecoveryJob(job.jobId, message, error.retryAt, false, input.clock.now());
          recordAttempt("rate_limited", "provider_budget_exhausted", error.retryAt);
          return Object.freeze({ jobId: job.jobId, outcome: "budget_exhausted" as const });
        }
        if (error instanceof TerminalRecoveryError) {
          if (expectedFact) input.factLinks?.terminal(job.jobId, expectedFact.factType, expectedFact.factKey, message, input.clock.now());
          input.ledger.failRecoveryJob(job.jobId, message, input.clock.now(), true, input.clock.now());
          recordAttempt("terminal", "terminal_recovery_error");
          return Object.freeze({ jobId: job.jobId, outcome: "dead_letter" as const });
        }
        const exponent = Math.max(0, job.attemptCount - 1);
        const retryAt = input.clock.now() + Math.min(retryBaseMs * 2 ** exponent, 3_600_000);
        input.ledger.failRecoveryJob(job.jobId, message, retryAt, false, input.clock.now());
        // Error messages can contain URLs or identities; persist only a safe category here.
        recordAttempt(/429|rate.limit/i.test(message) ? "rate_limited" : "failed", /timeout/i.test(message) ? "provider_timeout" : "recovery_deferred", retryAt);
        return Object.freeze({ jobId: job.jobId, outcome: "retry" as const });
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      // A downstream wake failure must not turn an already completed collection into a retry.
      if (reEvaluate) await input.onReEvaluate?.(reEvaluate);
      return Object.freeze({ jobId: job.jobId, outcome: "completed" as const });
    },
  });
}
