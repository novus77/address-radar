import type { DiscoveryChain } from "@address-radar/collectors";

import type { HistoricalProviderRoute, HistoricalProviderRouter } from "./historical-provider-router.js";

export interface HistoricalMilestoneJob {
  id: string;
  chain: DiscoveryChain;
  tokenAddress: string;
  fromTimestamp: number;
  toTimestamp: number;
  attempt: number;
}

export interface HistoricalMilestoneQueue {
  claim(): Promise<HistoricalMilestoneJob | null>;
  complete(jobId: string, metadata: HistoricalMilestoneCompletionMetadata): Promise<void>;
  defer(jobId: string, retryAt: number, reason: string): Promise<void>;
  fail(jobId: string, reason: string): Promise<void>;
}

export interface HistoricalMilestoneCompletionMetadata {
  provider: string;
  milestoneCount: number;
  candleCount: number;
  attempts: HistoricalProviderRoute["attempts"];
}

export interface HistoricalMilestoneRecord {
  idempotencyKey: string;
  jobId: string;
  chain: DiscoveryChain;
  tokenAddress: string;
  thresholdUsd: number;
  crossedAt: number;
  estimatedMarketCapUsd: number;
  provider: string;
  source: string;
  precision: string;
  poolAddress: string | null;
  supplyBasis: "market_cap" | "fdv" | null;
  recordedAt: number;
}

export interface HistoricalMilestoneRepository {
  upsert(records: readonly HistoricalMilestoneRecord[]): Promise<void>;
}

export interface HistoricalMilestoneWorkerOptions {
  queue: HistoricalMilestoneQueue;
  repository: HistoricalMilestoneRepository;
  router: HistoricalProviderRouter;
  now?: () => number;
  retryDelayMs?: {
    retryableFailure?: number;
    insufficientMarketData?: number;
    notFound?: number;
    persistenceFailure?: number;
  };
}

export type HistoricalMilestoneWorkerOutcome =
  | { status: "idle" }
  | { status: "completed"; jobId: string; provider: string; milestoneCount: number }
  | { status: "deferred"; jobId: string; retryAt: number; reason: string }
  | { status: "failed"; jobId: string; reason: string };

export interface HistoricalMilestoneWorker {
  runOnce(): Promise<HistoricalMilestoneWorkerOutcome>;
}

const DEFAULT_RETRY_DELAYS = {
  retryableFailure: 30 * 60 * 1000,
  insufficientMarketData: 2 * 60 * 60 * 1000,
  notFound: 6 * 60 * 60 * 1000,
  persistenceFailure: 5 * 60 * 1000,
};

function reasonFor(route: HistoricalProviderRoute): string {
  const failed = route.attempts.filter((attempt) => attempt.message).map((attempt) => (
    `${attempt.provider}: ${attempt.message}`
  ));
  return failed.length > 0 ? failed.join("; ") : route.result.status;
}

function idempotencyKey(job: HistoricalMilestoneJob, provider: string, thresholdUsd: number): string {
  return [job.chain, job.tokenAddress.toLowerCase(), thresholdUsd, provider].join(":");
}

export function createHistoricalMilestoneWorker(options: HistoricalMilestoneWorkerOptions): HistoricalMilestoneWorker {
  const now = options.now ?? Date.now;
  const delays = { ...DEFAULT_RETRY_DELAYS, ...options.retryDelayMs };

  return {
    async runOnce() {
      const job = await options.queue.claim();
      if (!job) return { status: "idle" };

      const route = await options.router.reconstruct({
        chain: job.chain,
        tokenAddress: job.tokenAddress,
        fromTimestamp: job.fromTimestamp,
        toTimestamp: job.toTimestamp,
      });

      if (route.result.status !== "available") {
        const terminalFailure = route.attempts.some((attempt) => (
          attempt.outcome === "failed" && !attempt.retryable
        ));
        const reason = reasonFor(route);
        if (terminalFailure) {
          await options.queue.fail(job.id, reason);
          return { status: "failed", jobId: job.id, reason };
        }

        const hasRetryableFailure = route.attempts.some((attempt) => attempt.retryable);
        const delay = hasRetryableFailure
          ? delays.retryableFailure
          : route.result.status === "not_found"
            ? delays.notFound
            : delays.insufficientMarketData;
        const retryAt = now() + delay;
        await options.queue.defer(job.id, retryAt, reason);
        return { status: "deferred", jobId: job.id, retryAt, reason };
      }

      const recordedAt = now();
      const records = route.result.milestones.map((milestone): HistoricalMilestoneRecord => ({
        idempotencyKey: idempotencyKey(job, route.provider, milestone.thresholdUsd),
        jobId: job.id,
        chain: job.chain,
        tokenAddress: job.tokenAddress,
        thresholdUsd: milestone.thresholdUsd,
        crossedAt: milestone.crossedAt,
        estimatedMarketCapUsd: milestone.estimatedMarketCapUsd,
        provider: route.provider,
        source: milestone.source,
        precision: milestone.precision,
        poolAddress: route.result.poolAddress,
        supplyBasis: route.result.supplyBasis,
        recordedAt,
      }));

      try {
        await options.repository.upsert(records);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const retryAt = now() + delays.persistenceFailure;
        await options.queue.defer(job.id, retryAt, `milestone_persistence_failed: ${reason}`);
        return { status: "deferred", jobId: job.id, retryAt, reason };
      }

      await options.queue.complete(job.id, {
        provider: route.provider,
        milestoneCount: records.length,
        candleCount: route.result.candleCount,
        attempts: route.attempts,
      });
      return { status: "completed", jobId: job.id, provider: route.provider, milestoneCount: records.length };
    },
  };
}
