import { addressRadarTokenId, type TraderEvent, type TraderLifecycle } from "@address-radar/domain";
import type { AddressRadarRepository } from "@address-radar/database";
import type { AddressSignalEvidence, TokenLifecycleResolver } from "@address-radar/aggregation";
import { createRuntimeQualitySnapshot, type ProviderStatus } from "@address-radar/observability";
import { createTokenSignalService, type RadarSignalV1 } from "@address-radar/signal-engine";
import type { TokenMarketProvider, TokenMarketSnapshot } from "@address-radar/collectors";
import type { ScannerPolicyConfig } from "./config.js";

export interface ScannerObservation {
  readonly chain?: string;
  readonly tokenAddress?: string;
  readonly evidence?: AddressSignalEvidence;
  readonly event?: TraderEvent;
  readonly createdAt?: number | null;
  readonly launchedAt?: number | null;
}
export interface ScannerCollectorBatch {
  readonly observations: readonly ScannerObservation[];
  readonly status: ProviderStatus;
  readonly queueOldestAt?: number | null;
  readonly registryVersion?: number;
  readonly commit?: () => void | Promise<void>;
}
export interface ScannerCollector { readonly name?: string; collect(): Promise<readonly ScannerObservation[] | ScannerCollectorBatch> }
export interface SignalCandidateSink { accept(candidates: readonly RadarSignalV1[]): void | Promise<void> }
export interface ScannerRuntimeJob { start(): void | Promise<void>; stop(): void | Promise<void> }
export interface ScannerRunResult { readonly collected: number; readonly accepted: number; readonly rejected: number; readonly candidateCount: number; readonly collectorFailures: number }
export interface ScannerRuntimeOptions {
  readonly repository: AddressRadarRepository;
  readonly collectors: readonly ScannerCollector[];
  /** External delivery is owned by the outbox publisher, never by candidate generation. */
  readonly signalSink?: SignalCandidateSink;
  readonly clock: { now(): number };
  readonly config: ScannerPolicyConfig;
  readonly lifecycleResolver?: Pick<TokenLifecycleResolver, "resolve">;
  readonly marketProvider?: TokenMarketProvider;
  readonly jobs?: readonly ScannerRuntimeJob[];
  readonly onCollectorError?: (error: unknown, collectorIndex: number) => void;
}

export function createScannerRuntime(options: ScannerRuntimeOptions) {
  const service = createTokenSignalService({ repository: options.repository, threshold: options.config.signalThreshold, minimumTotalBuyUsd: options.config.minimumAggregateBuyUsd, strategyVersion: options.config.strategyVersion, now: options.clock.now });
  const allowed = new Set(options.config.allowedChains.map(value => value.toLowerCase()));
  const excluded = new Set(options.config.excludedTokenIds);
  const jobs = [...(options.jobs ?? [])];
  const previousQuality = options.repository.latestRuntimeQualitySnapshot();
  const startedAt = previousQuality?.startedAt ?? options.clock.now();
  let lastEventAt = previousQuality?.lastEventAt ?? (previousQuality?.eventFreshnessMs == null ? null : previousQuality.recordedAt - previousQuality.eventFreshnessMs);
  let latestAggregationAt = previousQuality?.latestAggregationAt ?? (previousQuality?.aggregationLagMs == null ? null : previousQuality.recordedAt - previousQuality.aggregationLagMs);
  let registryVersion = previousQuality?.registryVersion ?? 0;
  let closed = false;

  return Object.freeze({
    async start() { if (closed) throw new Error("Scanner runtime is closed"); for (const job of jobs) await job.start(); },
    async runOnce(): Promise<ScannerRunResult> {
      if (closed) throw new Error("Scanner runtime is closed");
      const settled = await Promise.allSettled(options.collectors.map(collector => collector.collect()));
      const statuses: Record<string, ProviderStatus> = {};
      let failures = 0;
      let collected = 0;
      let accepted = 0;
      let rejected = 0;
      let candidateCount = 0;
      let queueOldestAt: number | null = null;
      let lifecycleStatus: ProviderStatus = "ready";
      let marketStatus: ProviderStatus = "ready";

      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index]!;
        const name = options.collectors[index]?.name ?? `collector-${index}`;
        if (result.status === "rejected") {
          failures += 1;
          statuses[name] = "unavailable";
          options.onCollectorError?.(result.reason, index);
          continue;
        }
        const value = result.value;
        const batch: ScannerCollectorBatch = Array.isArray(value)
          ? { observations: value as readonly ScannerObservation[], status: "ready" }
          : value as ScannerCollectorBatch;
        statuses[name] = batch.status;
        collected += batch.observations.length;
        registryVersion = Math.max(registryVersion, batch.registryVersion ?? 0);
        if (batch.queueOldestAt != null) queueOldestAt = queueOldestAt === null ? batch.queueOldestAt : Math.min(queueOldestAt, batch.queueOldestAt);

        let batchFailed = false;
        const groups = new Map<string, { chain: string; tokenAddress: string; evidence: AddressSignalEvidence[]; market: TokenMarketSnapshot | null }>();
        for (const observation of batch.observations) {
          try {
            let chain: string;
            let tokenAddress: string;
            let evidence: AddressSignalEvidence;
            let market: TokenMarketSnapshot | null = null;
            let observationLaunchStatus: "ready" | "unavailable" | undefined;
            if (observation.event) {
              const mappedEntity = options.repository.entityForAccount(observation.event.accountId);
              const event = mappedEntity ? { ...observation.event, entityId: mappedEntity } : observation.event;
              options.repository.insertTraderEvent(event);
              chain = event.chain.toLowerCase();
              tokenAddress = event.tokenAddress;
              if (options.marketProvider) {
                try { market = await options.marketProvider.lookup(chain, tokenAddress); observationLaunchStatus = "ready"; }
                catch (error) { marketStatus = "degraded"; observationLaunchStatus = "unavailable"; batchFailed = true; options.onCollectorError?.(error, index); }
              }
              let lifecycleStage: AddressSignalEvidence["lifecycleStage"] = "unknown";
              if (options.lifecycleResolver) {
                try {
                  const launchProviderStatus = observationLaunchStatus ?? (observation.launchedAt !== undefined ? "ready" as const : undefined);
                  lifecycleStage = await options.lifecycleResolver.resolve({ chain, tokenAddress, observedAt: event.occurredAt, ...(observation.createdAt !== undefined ? { createdAt: observation.createdAt } : {}), ...(observation.launchedAt !== undefined ? { launchedAt: observation.launchedAt } : {}), ...(launchProviderStatus ? { launchProviderStatus } : {}) });
                } catch (error) {
                  lifecycleStatus = "degraded";
                  batchFailed = true;
                  options.onCollectorError?.(error, index);
                }
              }
              const ability = options.repository.latestTraderAbility(event.entityId, "30d") ?? options.repository.latestTraderAbility(event.entityId, "90d") ?? options.repository.latestTraderAbility(event.entityId, "lifetime");
              evidence = {
                eventId: event.eventId,
                entityId: event.entityId,
                contribution: ability?.adjustedQuality ?? 0,
                occurredAt: event.occurredAt,
                source: event.source === "onchain_wallet" ? "onchain" : "fomo",
                side: event.side,
                amountUsd: event.amountUsd,
                lifecycleStage,
                traderTags: ability ? Object.entries(ability.styles).filter(([, score]) => score >= 0.6).map(([tag]) => tag) : [],
              };
            } else if (observation.evidence && observation.chain && observation.tokenAddress) {
              chain = observation.chain.toLowerCase();
              tokenAddress = observation.tokenAddress;
              evidence = observation.evidence;
            } else {
              rejected += 1;
              continue;
            }
            const tokenId = addressRadarTokenId(chain, tokenAddress);
            if ((allowed.size > 0 && !allowed.has(chain)) || excluded.has(tokenId) || (evidence.amountUsd ?? 0) < options.config.minimumPurchaseUsd) {
              rejected += 1;
              continue;
            }
            options.repository.saveAddressSignalEvidence(chain, tokenAddress, evidence);
            const group = groups.get(tokenId) ?? { chain, tokenAddress, evidence: [], market };
            group.evidence.push(evidence);
            if (market) group.market = market;
            groups.set(tokenId, group);
            lastEventAt = Math.max(lastEventAt ?? 0, evidence.occurredAt);
            accepted += 1;
          } catch (error) {
            batchFailed = true;
            options.onCollectorError?.(error, index);
          }
        }

        const candidates: RadarSignalV1[] = [];
        for (const group of groups.values()) {
          try {
            const latest = Math.max(...group.evidence.map(item => item.occurredAt));
            const rolling = options.repository.addressSignalEvidenceForToken(group.chain, group.tokenAddress, latest - 3_600_000);
            const metadata = group.market ? { symbol: group.market.symbol ?? null, name: group.market.name ?? null, imageUrl: group.market.imageUrl ?? null, marketCapUsd: group.market.marketCapUsd, priceUsd: group.market.priceUsd } : undefined;
            const evaluation = service.evaluate(group.chain, group.tokenAddress, rolling, metadata);
            if (evaluation.candidate) candidates.push(evaluation.candidate);
            latestAggregationAt = options.clock.now();
          } catch (error) {
            batchFailed = true;
            options.onCollectorError?.(error, index);
          }
        }
        candidateCount += candidates.length;
        if (!batchFailed && batch.commit) {
          try { await batch.commit(); }
          catch (error) { batchFailed = true; options.onCollectorError?.(error, index); }
        }
        if (batchFailed) failures += 1;
      }

      if (options.lifecycleResolver) statuses.lifecycle = lifecycleStatus;
      if (options.marketProvider) statuses.market = marketStatus;
      const quality = createRuntimeQualitySnapshot({ now: options.clock.now(), startedAt, lastEventAt, oldestQueuedAt: queueOldestAt, latestAggregationAt, registryVersion, providerStatuses: statuses, staleAfterMs: 15 * 60_000 });
      options.repository.saveRuntimeQualitySnapshot(quality);
      return Object.freeze({ collected, accepted, rejected, candidateCount, collectorFailures: failures });
    },
    async close() { if (closed) return; for (const job of [...jobs].reverse()) await job.stop(); closed = true; },
  });
}

export const createPollingRuntimeJob = (input: { readonly runOnce: () => unknown | Promise<unknown>; readonly intervalMs: number; readonly onError?: (error: unknown) => void }): ScannerRuntimeJob => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let active = false;
  const tick = () => { if (!active || running) return; running = Promise.resolve(input.runOnce()).then(() => undefined).catch(error => input.onError?.(error)).finally(() => { running = undefined; }); };
  return Object.freeze({ start() { if (active) return; active = true; tick(); timer = setInterval(tick, input.intervalMs); timer.unref(); }, async stop() { active = false; if (timer) clearInterval(timer); timer = undefined; await running; } });
};
export const RECONCILIATION_INTERVAL_MS: Readonly<Record<TraderLifecycle, number>> = Object.freeze({ candidate: 1_800_000, probation: 900_000, active: 300_000, elite: 120_000, degraded: 3_600_000, suspended: 86_400_000 });
export const reconciliationIntervalMs = (lifecycle: TraderLifecycle, manualPriority = false): number => manualPriority ? RECONCILIATION_INTERVAL_MS.elite : RECONCILIATION_INTERVAL_MS[lifecycle];
