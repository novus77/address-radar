import type { AutomationJobStore, AutomationQueueSnapshot } from "@address-radar/database";
import type { AutomationJob, AutomationLane, CandidateSourceBlockReason } from "@address-radar/domain";

export interface AutomationHandler {
  readonly jobType: string;
  execute(job: AutomationJob, signal: AbortSignal): Promise<AutomationExecutionResult>;
}

export interface AutomationExecutionResult {
  readonly status: "completed" | "checkpoint" | "waiting_source" | "retryable" | "terminal";
  readonly cursor?: string | null;
  readonly retryAt?: number;
  readonly diagnostic?: string;
  readonly sourceBlock?: {
    readonly reasonCode: CandidateSourceBlockReason;
    readonly context: Readonly<Record<string, unknown>>;
    readonly recoveryJobIds: readonly string[];
  };
}

export interface AutomationSchedulerResult {
  readonly executed: boolean;
  readonly lane?: AutomationLane;
  readonly jobId?: string;
  readonly status?: AutomationExecutionResult["status"];
  readonly snapshot: AutomationQueueSnapshot;
}

export function createAutomationScheduler(input: {
  readonly enabled: boolean;
  readonly enabledJobTypes?: readonly string[];
  readonly store: AutomationJobStore;
  readonly handlers: readonly AutomationHandler[];
  readonly workerId: string;
  readonly now?: () => number;
  readonly leaseMs?: number;
}) {
  const now = input.now ?? Date.now;
  const leaseMs = input.leaseMs ?? 60_000;
  const handlers = new Map(input.handlers.map((handler) => [handler.jobType, handler]));

  return Object.freeze({
    async runOnce(signal: AbortSignal): Promise<AutomationSchedulerResult> {
      if (!input.enabled || signal.aborted) {
        return Object.freeze({ executed: false, snapshot: input.store.snapshot() });
      }
      const currentTime = now();
      const available = input.store.dueLanes(currentTime, input.enabledJobTypes);
      const lane = input.store.selectLane(available, currentTime);
      if (!lane) return Object.freeze({ executed: false, snapshot: input.store.snapshot() });
      const job = input.store.claim(
        lane,
        currentTime,
        leaseMs,
        input.workerId,
        input.enabledJobTypes,
      );
      if (!job) return Object.freeze({ executed: false, snapshot: input.store.snapshot() });
      const handler = handlers.get(job.jobType);
      if (!handler) {
        input.store.terminate(job.jobId, input.workerId, {
          reason: `missing_handler:${job.jobType}`,
          terminatedAt: now(),
        });
        return Object.freeze({
          executed: true,
          lane,
          jobId: job.jobId,
          status: "terminal",
          snapshot: input.store.snapshot(),
        });
      }

      let result: AutomationExecutionResult;
      try {
        result = await handler.execute(job, signal);
      } catch (error) {
        result = {
          status: "retryable",
          diagnostic: error instanceof Error ? error.message : String(error),
        };
      }
      const finishedAt = now();
      if (result.status === "completed") {
        input.store.complete(job.jobId, input.workerId, {
          cursor: result.cursor === undefined ? job.cursor : result.cursor,
          completedAt: finishedAt,
        });
      } else if (result.status === "checkpoint") {
        input.store.checkpoint(job.jobId, input.workerId, {
          cursor: result.cursor === undefined ? job.cursor : result.cursor,
          nextAttemptAt: result.retryAt ?? finishedAt,
          updatedAt: finishedAt,
        });
      } else if (result.status === "waiting_source") {
        input.store.waitForSource(job.jobId, input.workerId, {
          diagnostic: result.diagnostic ?? "waiting_source",
          ...(result.sourceBlock ?? {}),
          retryAt: result.retryAt ?? finishedAt + 60_000,
          updatedAt: finishedAt,
        });
      } else if (result.status === "retryable") {
        input.store.retry(job.jobId, input.workerId, {
          error: result.diagnostic ?? "retryable_failure",
          now: finishedAt,
          ...(result.retryAt === undefined ? {} : { retryAfterAt: result.retryAt }),
        });
      } else {
        input.store.terminate(job.jobId, input.workerId, {
          reason: result.diagnostic ?? "terminal_failure",
          terminatedAt: finishedAt,
        });
      }
      return Object.freeze({
        executed: true,
        lane,
        jobId: job.jobId,
        status: result.status,
        snapshot: input.store.snapshot(),
      });
    },
  });
}

export function allocateMinimumChainSlots(
  chains: readonly string[],
  capacity: number,
): Readonly<Record<string, number>> {
  const unique = [...new Set(chains)];
  if (capacity < unique.length) throw new Error("Capacity must provide at least one slot per chain");
  const slots = Object.fromEntries(unique.map((chain) => [chain, 1])) as Record<string, number>;
  let remaining = capacity - unique.length;
  let index = 0;
  while (remaining > 0) {
    const chain = unique[index % unique.length]!;
    slots[chain] = (slots[chain] ?? 0) + 1;
    remaining -= 1;
    index += 1;
  }
  return Object.freeze(slots);
}
