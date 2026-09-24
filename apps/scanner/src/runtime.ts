import { addressRadarTokenId, type TraderEvent, type TraderLifecycle } from "@address-radar/domain";
import type { AddressRadarRepository } from "@address-radar/database";
import type { AddressSignalEvidence, TokenLifecycleResolver } from "@address-radar/aggregation";
import { createRuntimeQualitySnapshot, type ProviderStatus } from "@address-radar/observability";
import { createTokenSignalService, type RadarSignalV1 } from "@address-radar/signal-engine";
import type { TokenMarketProvider, TokenMarketSnapshot } from "@address-radar/collectors";
import type { ScannerPolicyConfig } from "./config.js";

export interface ScannerObservation { readonly chain?: string; readonly tokenAddress?: string; readonly evidence?: AddressSignalEvidence; readonly event?: TraderEvent }
export interface ScannerCollectorBatch { readonly observations: readonly ScannerObservation[]; readonly status: ProviderStatus; readonly queueOldestAt?: number | null; readonly registryVersion?: number }
export interface ScannerCollector { readonly name?: string; collect(): Promise<readonly ScannerObservation[] | ScannerCollectorBatch> }
export interface SignalCandidateSink { accept(candidates: readonly RadarSignalV1[]): void | Promise<void> }
export interface ScannerRuntimeJob { start(): void | Promise<void>; stop(): void | Promise<void> }
export interface ScannerRunResult { readonly collected: number; readonly accepted: number; readonly rejected: number; readonly candidateCount: number; readonly collectorFailures: number }
export interface ScannerRuntimeOptions {
  readonly repository: AddressRadarRepository; readonly collectors: readonly ScannerCollector[];
  readonly signalSink: SignalCandidateSink; readonly clock: { now(): number }; readonly config: ScannerPolicyConfig;
  readonly lifecycleResolver?: Pick<TokenLifecycleResolver, "resolve">; readonly marketProvider?: TokenMarketProvider;
  readonly jobs?: readonly ScannerRuntimeJob[]; readonly onCollectorError?: (error: unknown, collectorIndex: number) => void;
}

export function createScannerRuntime(options: ScannerRuntimeOptions) {
  const service = createTokenSignalService({ repository: options.repository, threshold: options.config.signalThreshold, minimumTotalBuyUsd: options.config.minimumAggregateBuyUsd, strategyVersion: options.config.strategyVersion, now: options.clock.now });
  const allowed = new Set(options.config.allowedChains.map(value => value.toLowerCase()));
  const excluded = new Set(options.config.excludedTokenIds);
  const jobs = [...(options.jobs ?? [])];
  let closed = false;
  return Object.freeze({
    async start() { if (closed) throw new Error("Scanner runtime is closed"); for (const job of jobs) await job.start(); },
    async runOnce(): Promise<ScannerRunResult> {
      if (closed) throw new Error("Scanner runtime is closed");
      const settled = await Promise.allSettled(options.collectors.map(collector => collector.collect()));
      const observations: ScannerObservation[] = [];
      const statuses: Record<string, ProviderStatus> = {};
      let failures = 0;
      let queueOldestAt: number | null = null;
      let registryVersion = 0;
      settled.forEach((result, index) => {
        const name = options.collectors[index]?.name ?? `collector-${index}`;
        if (result.status === "rejected") { failures += 1; statuses[name] = "unavailable"; options.onCollectorError?.(result.reason, index); return; }
        const value = result.value;
        const batch: ScannerCollectorBatch = Array.isArray(value)
          ? { observations: value as readonly ScannerObservation[], status: "ready" }
          : value as ScannerCollectorBatch;
        observations.push(...batch.observations); statuses[name] = batch.status;
        if (batch.queueOldestAt != null) queueOldestAt = queueOldestAt === null ? batch.queueOldestAt : Math.min(queueOldestAt, batch.queueOldestAt);
        registryVersion = Math.max(registryVersion, batch.registryVersion ?? 0);
      });
      const grouped = new Map<string, { chain: string; tokenAddress: string; evidence: AddressSignalEvidence[]; market: TokenMarketSnapshot | null }>();
      let rejected = 0;
      let lastEventAt: number | null = null;
      let marketStatus: ProviderStatus = options.marketProvider ? "ready" : "degraded";
      for (const observation of observations) {
        let chain: string; let tokenAddress: string; let evidence: AddressSignalEvidence; let market: TokenMarketSnapshot | null = null;
        if (observation.event) {
          const mappedEntity = options.repository.entityForAccount(observation.event.accountId);
          const event = mappedEntity ? { ...observation.event, entityId: mappedEntity } : observation.event;
          options.repository.insertTraderEvent(event);
          chain = event.chain.toLowerCase(); tokenAddress = event.tokenAddress;
          try { market = options.marketProvider ? await options.marketProvider.lookup(chain, tokenAddress) : null; }
          catch { marketStatus = "degraded"; }
          const lifecycleStage = options.lifecycleResolver ? await options.lifecycleResolver.resolve({ chain, tokenAddress, observedAt: event.occurredAt }) : "unknown";
          const ability = options.repository.latestTraderAbility(event.entityId, "30d") ?? options.repository.latestTraderAbility(event.entityId, "90d") ?? options.repository.latestTraderAbility(event.entityId, "lifetime");
          evidence = { eventId: event.eventId, entityId: event.entityId, contribution: ability?.adjustedQuality ?? 0.8, occurredAt: event.occurredAt, source: event.source === "onchain_wallet" ? "onchain" : "fomo", side: event.side, amountUsd: event.amountUsd, lifecycleStage, traderTags: ability ? Object.entries(ability.styles).filter(([, score]) => score >= 0.6).map(([tag]) => tag) : ["EARLY_LAUNCH"] };
        } else if (observation.evidence && observation.chain && observation.tokenAddress) {
          chain = observation.chain.toLowerCase(); tokenAddress = observation.tokenAddress; evidence = observation.evidence;
        } else { rejected += 1; continue; }
        const tokenId = addressRadarTokenId(chain, tokenAddress);
        if ((allowed.size > 0 && !allowed.has(chain)) || excluded.has(tokenId) || (evidence.amountUsd ?? 0) < options.config.minimumPurchaseUsd) { rejected += 1; continue; }
        options.repository.saveAddressSignalEvidence(chain, tokenAddress, evidence);
        const group = grouped.get(tokenId) ?? { chain, tokenAddress, evidence: [], market };
        group.evidence.push(evidence); if (market) group.market = market; grouped.set(tokenId, group);
        lastEventAt = Math.max(lastEventAt ?? 0, evidence.occurredAt);
      }
      statuses.market = marketStatus;
      const candidates: RadarSignalV1[] = [];
      let aggregationAt: number | null = null;
      for (const group of grouped.values()) {
        const latest = Math.max(...group.evidence.map(item => item.occurredAt));
        const rolling = options.repository.addressSignalEvidenceForToken(group.chain, group.tokenAddress, latest - 3_600_000);
        const metadata = group.market ? { symbol: group.market.symbol ?? null, name: group.market.name ?? null, imageUrl: group.market.imageUrl ?? null, marketCapUsd: group.market.marketCapUsd, priceUsd: group.market.priceUsd } : undefined;
        const result = service.evaluate(group.chain, group.tokenAddress, rolling, metadata);
        if (result.candidate) candidates.push(result.candidate);
        aggregationAt = options.clock.now();
      }
      if (candidates.length) await options.signalSink.accept(Object.freeze(candidates));
      const quality = createRuntimeQualitySnapshot({ now: options.clock.now(), lastEventAt, oldestQueuedAt: queueOldestAt, latestAggregationAt: aggregationAt, registryVersion, providerStatuses: statuses, staleAfterMs: 15 * 60_000 });
      options.repository.saveRuntimeQualitySnapshot(quality);
      return Object.freeze({ collected: observations.length, accepted: observations.length - rejected, rejected, candidateCount: candidates.length, collectorFailures: failures });
    },
    async close() { if (closed) return; for (const job of [...jobs].reverse()) await job.stop(); closed = true; },
  });
}

export const createPollingRuntimeJob = (input: { readonly runOnce: () => unknown | Promise<unknown>; readonly intervalMs: number; readonly onError?: (error: unknown) => void }): ScannerRuntimeJob => {
  let timer: NodeJS.Timeout | undefined; let running: Promise<void> | undefined; let active = false;
  const tick = () => { if (!active || running) return; running = Promise.resolve(input.runOnce()).then(() => undefined).catch(error => input.onError?.(error)).finally(() => { running = undefined; }); };
  return Object.freeze({ start() { if (active) return; active = true; tick(); timer = setInterval(tick, input.intervalMs); timer.unref(); }, async stop() { active = false; if (timer) clearInterval(timer); timer = undefined; await running; } });
};
export const RECONCILIATION_INTERVAL_MS: Readonly<Record<TraderLifecycle, number>> = Object.freeze({ candidate: 1_800_000, probation: 900_000, active: 300_000, elite: 120_000, degraded: 3_600_000, suspended: 86_400_000 });
export const reconciliationIntervalMs = (lifecycle: TraderLifecycle, manualPriority = false): number => manualPriority ? RECONCILIATION_INTERVAL_MS.elite : RECONCILIATION_INTERVAL_MS[lifecycle];
