import { addressRadarTokenId, type TraderLifecycle } from "@address-radar/domain";
import type { AddressRadarRepository } from "@address-radar/database";
import type { AddressSignalEvidence } from "@address-radar/aggregation";
import {
  createTokenSignalService,
  type SignalCandidate,
  type TokenSignalService,
} from "@address-radar/signal-engine";
import type { ScannerPolicyConfig } from "./config.js";

export interface ScannerObservation {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly evidence: AddressSignalEvidence;
}

export interface ScannerCollector {
  collect(): Promise<readonly ScannerObservation[]>;
}

export interface SignalCandidateSink {
  accept(candidates: readonly SignalCandidate[]): void | Promise<void>;
}

export interface ScannerClock {
  now(): number;
}

export interface ScannerRuntimeJob {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface ScannerRunResult {
  readonly collected: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly candidateCount: number;
  readonly collectorFailures: number;
}

export interface ScannerRuntime {
  start(): Promise<void>;
  runOnce(): Promise<ScannerRunResult>;
  close(): Promise<void>;
}

export interface ScannerRuntimeOptions {
  readonly repository: AddressRadarRepository;
  readonly collectors: readonly ScannerCollector[];
  readonly signalSink: SignalCandidateSink;
  readonly clock: ScannerClock;
  readonly config: ScannerPolicyConfig;
  readonly jobs?: readonly ScannerRuntimeJob[];
  readonly onCollectorError?: (error: unknown, collectorIndex: number) => void;
}

export function createScannerRuntime(options: ScannerRuntimeOptions): ScannerRuntime {
  const service: TokenSignalService = createTokenSignalService({
    repository: options.repository,
    threshold: options.config.signalThreshold,
    minimumTotalBuyUsd: options.config.minimumAggregateBuyUsd,
    strategyVersion: options.config.strategyVersion,
    now: options.clock.now,
    traderAbility: entityId => {
      const snapshot = options.repository.latestTraderAbility(entityId, "30d")
        ?? options.repository.latestTraderAbility(entityId, "90d")
        ?? options.repository.latestTraderAbility(entityId, "lifetime");
      return snapshot ? { adjustedQuality: snapshot.adjustedQuality, styles: snapshot.styles } : null;
    },
  });
  const allowedChains = new Set(options.config.allowedChains.map(chain => chain.toLowerCase()));
  const excludedTokenIds = new Set(options.config.excludedTokenIds);
  const jobs = [...(options.jobs ?? [])];
  let started = false;
  let closed = false;

  return Object.freeze({
    async start() {
      if (closed) throw new Error("Scanner runtime is closed");
      if (started) return;
      for (const job of jobs) await job.start();
      started = true;
    },

    async runOnce() {
      if (closed) throw new Error("Scanner runtime is closed");
      const results = await Promise.allSettled(options.collectors.map(collector => collector.collect()));
      const observations: ScannerObservation[] = [];
      let collectorFailures = 0;
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          observations.push(...result.value);
        } else {
          collectorFailures += 1;
          options.onCollectorError?.(result.reason, index);
        }
      });

      const grouped = new Map<string, { chain: string; tokenAddress: string; evidence: AddressSignalEvidence[] }>();
      let rejected = 0;
      for (const observation of observations) {
        const chain = observation.chain.toLowerCase();
        const tokenId = addressRadarTokenId(chain, observation.tokenAddress);
        const amountUsd = observation.evidence.amountUsd ?? 0;
        if (
          (allowedChains.size > 0 && !allowedChains.has(chain))
          || excludedTokenIds.has(tokenId)
          || amountUsd < options.config.minimumPurchaseUsd
        ) {
          rejected += 1;
          continue;
        }
        options.repository.saveAddressSignalEvidence(chain, observation.tokenAddress, observation.evidence);
        const group = grouped.get(tokenId) ?? { chain, tokenAddress: observation.tokenAddress, evidence: [] };
        group.evidence.push(observation.evidence);
        grouped.set(tokenId, group);
      }

      const candidates: SignalCandidate[] = [];
      for (const group of grouped.values()) {
        const latestOccurredAt = Math.max(...group.evidence.map(item => item.occurredAt));
        const rollingEvidence = options.repository.addressSignalEvidenceForToken(
          group.chain,
          group.tokenAddress,
          latestOccurredAt - 60 * 60_000,
        );
        const evaluation = service.evaluate(group.chain, group.tokenAddress, rollingEvidence);
        if (evaluation.candidate) candidates.push(evaluation.candidate);
      }
      if (candidates.length > 0) await options.signalSink.accept(Object.freeze(candidates));
      return Object.freeze({
        collected: observations.length,
        accepted: observations.length - rejected,
        rejected,
        candidateCount: candidates.length,
        collectorFailures,
      });
    },

    async close() {
      if (closed) return;
      for (const job of [...jobs].reverse()) await job.stop();
      closed = true;
    },
  });
}

export const createPollingRuntimeJob = (input: {
  readonly runOnce: () => unknown | Promise<unknown>;
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
}): ScannerRuntimeJob => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let active = false;

  const tick = (): void => {
    if (!active || running) return;
    running = Promise.resolve(input.runOnce())
      .then(() => undefined)
      .catch(error => input.onError?.(error))
      .finally(() => { running = undefined; });
  };

  return Object.freeze({
    start() {
      if (active) return;
      active = true;
      tick();
      timer = setInterval(tick, input.intervalMs);
      timer.unref();
    },
    async stop() {
      active = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  });
};

export const RECONCILIATION_INTERVAL_MS: Readonly<Record<TraderLifecycle, number>> = Object.freeze({
  candidate: 30 * 60_000,
  probation: 15 * 60_000,
  active: 5 * 60_000,
  elite: 2 * 60_000,
  degraded: 60 * 60_000,
  suspended: 24 * 60 * 60_000,
});

export function reconciliationIntervalMs(lifecycle: TraderLifecycle, manualPriority = false): number {
  return manualPriority ? RECONCILIATION_INTERVAL_MS.elite : RECONCILIATION_INTERVAL_MS[lifecycle];
}
