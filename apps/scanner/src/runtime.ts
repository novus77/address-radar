import { addressRadarTokenId, normalizeDiscoveryChain, type TraderEvent, type TraderLifecycle } from "@address-radar/domain";
import type { AddressRadarRepository, SourceLedgerStore } from "@address-radar/database";
import type { AddressSignalEvidence, TokenLifecycleResolver } from "@address-radar/aggregation";
import { createRuntimeQualitySnapshot, type ProviderStatus } from "@address-radar/observability";
import { createTokenSignalService, type RadarSignalV1 } from "@address-radar/signal-engine";
import {
  sourceObservationForTraderEvent,
  type SourceObservationRepository,
  type TokenMarketProvider,
  type TokenMarketSnapshot,
} from "@address-radar/collectors";
import type { ScannerPolicyConfig } from "./config.js";
import {
  createSourceHealthRecorder,
  type SourceHealthLedger,
  type SourceHealthTarget,
  type SourceSuccessAttempt,
} from "./source-health.js";

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
  readonly sourceProgress?: readonly Omit<SourceSuccessAttempt, "startedAt">[];
  readonly commit?: () => void | Promise<void>;
}
export interface ScannerCollector {
  readonly name?: string;
  readonly healthTargets?: readonly SourceHealthTarget[];
  collect(): Promise<readonly ScannerObservation[] | ScannerCollectorBatch>;
}
export interface SignalCandidateSink { accept(candidates: readonly RadarSignalV1[]): void | Promise<void> }
export interface ScannerRuntimeJob { start(): void | Promise<void>; stop(): void | Promise<void> }
export interface ScannerRunResult { readonly collected: number; readonly accepted: number; readonly rejected: number; readonly candidateCount: number; readonly collectorFailures: number }
export interface ObservedTokenMarket {
  readonly chain: string;
  readonly tokenAddress: string;
  readonly observedAt: number;
  readonly sourceEventIds: readonly string[];
  readonly market: TokenMarketSnapshot;
}
export interface ScannerRuntimeOptions {
  readonly repository: AddressRadarRepository;
  readonly collectors: readonly ScannerCollector[];
  /** External delivery is owned by the outbox publisher, never by candidate generation. */
  readonly signalSink?: SignalCandidateSink;
  readonly clock: { now(): number };
  readonly config: ScannerPolicyConfig;
  readonly lifecycleResolver?: Pick<TokenLifecycleResolver, "resolve">;
  readonly marketProvider?: TokenMarketProvider;
  readonly sourceLedger?: SourceObservationRepository;
  readonly sourceHealthLedger?: SourceHealthLedger;
  readonly tokenStateStore?: Pick<SourceLedgerStore, "saveTokenObservation" | "saveTokenMarketSnapshot" | "enqueueRecoveryJob">;
  readonly onTokenMarketObserved?: (observation: ObservedTokenMarket) => void | Promise<void>;
  readonly jobs?: readonly ScannerRuntimeJob[];
  readonly onCollectorError?: (error: unknown, collectorIndex: number) => void;
}

export function createScannerRuntime(options: ScannerRuntimeOptions) {
  const projectionType = "address_signal_evidence_v1";
  const projectionOwner = `scanner:${process.pid}`;
  const projectionLeaseMs = 60_000;
  const service = createTokenSignalService({ repository: options.repository, threshold: options.config.signalThreshold, minimumTotalBuyUsd: options.config.minimumAggregateBuyUsd, strategyVersion: options.config.strategyVersion, now: options.clock.now });
  const allowed = new Set(options.config.allowedChains.map(value => value.toLowerCase()));
  const excluded = new Set(options.config.excludedTokenIds);
  const jobs = [...(options.jobs ?? [])];
  const sourceHealth = options.sourceHealthLedger ? createSourceHealthRecorder({ ledger: options.sourceHealthLedger, clock: options.clock }) : null;
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
      const attemptStartedAt = options.collectors.map(() => options.clock.now());
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
          for (const target of options.collectors[index]?.healthTargets ?? []) {
            sourceHealth?.recordFailure({ ...target, startedAt: attemptStartedAt[index]!, errorCode: "collector_error" });
            if ((target.source === "rpc_evm" || target.source === "rpc_solana") && options.tokenStateStore) {
              const subjectKey = options.collectors[index]?.name ?? `collector-${index}`;
              options.tokenStateStore.enqueueRecoveryJob({
                jobId: `recovery:rpc_gap:${target.chain}:${subjectKey}`,
                jobType: "rpc_gap",
                chain: target.chain,
                subjectKey,
                priority: 10,
                cursor: null,
                nextAttemptAt: options.clock.now(),
                createdAt: options.clock.now(),
              });
            }
          }
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
        const tokenFacts = new Map<string, { chain: string; tokenAddress: string; observedAt: number; sourceEventIds: Set<string>; createdAt?: number | null; launchedAt?: number | null }>();
        for (const observation of batch.observations) {
          if (!observation.event) continue;
          const chain = observation.event.chain.toLowerCase();
          const tokenAddress = observation.event.tokenAddress;
          const tokenId = addressRadarTokenId(chain, tokenAddress);
          const supported = isSupportedDiscoveryChain(chain);
          options.tokenStateStore?.saveTokenObservation({
            tokenId,
            chain,
            tokenAddress,
            observedAt: observation.event.occurredAt,
            identityStatus: "resolved",
            marketStatus: "pending",
            fomoStatus: observation.event.source === "onchain_wallet" ? "pending" : "confirmed",
            quarantined: !supported,
            quarantineReason: supported ? null : "unsupported_chain",
          });
          if (supported && observation.event.source === "onchain_wallet") {
            enqueueTokenRecovery(options.tokenStateStore, "fomo_token_history", chain, tokenId, 30, observation.event.collectedAt);
          }
          const current = tokenFacts.get(tokenId);
          const createdTimes = [current?.createdAt, observation.createdAt].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
          const launchTimes = [current?.launchedAt, observation.launchedAt].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
          const sourceEventIds = current?.sourceEventIds ?? new Set<string>();
          sourceEventIds.add(observation.event.eventId);
          tokenFacts.set(tokenId, { chain, tokenAddress, observedAt: Math.max(current?.observedAt ?? 0, observation.event.occurredAt), sourceEventIds, ...(createdTimes.length ? { createdAt: Math.min(...createdTimes) } : {}), ...(launchTimes.length ? { launchedAt: Math.min(...launchTimes) } : {}) });
        }
        const tokenResolutionCache = new Map<string, Promise<{ market: TokenMarketSnapshot | null; lifecycleStage: NonNullable<AddressSignalEvidence["lifecycleStage"]>; failed: boolean }>>();
        const resolveToken = (chain: string, tokenAddress: string) => {
          const tokenId = addressRadarTokenId(chain, tokenAddress);
          const cached = tokenResolutionCache.get(tokenId);
          if (cached) return cached;
          const facts = tokenFacts.get(tokenId)!;
          const resolution = (async () => {
            let market: TokenMarketSnapshot | null = null;
            let marketObservedAt: number | null = null;
            let launchStatus: "ready" | "unavailable" | undefined;
            let lifecycleStage: NonNullable<AddressSignalEvidence["lifecycleStage"]> = "unknown";
            let failed = false;
            if (options.marketProvider) {
              try {
                market = await options.marketProvider.lookup(chain, tokenAddress);
                launchStatus = "ready";
                if (market) {
                  marketObservedAt = Date.parse(market.observedAt);
                  if (!Number.isSafeInteger(marketObservedAt) || marketObservedAt < 0 || marketObservedAt > options.clock.now()) {
                    market = null;
                    marketObservedAt = null;
                    throw new Error("Market observation timestamp is invalid or in the future");
                  }
                  const milestoneObserved = typeof market.marketCapUsd === "number" && market.marketCapUsd >= 100_000;
                  options.tokenStateStore?.saveTokenObservation({
                    tokenId,
                    chain,
                    tokenAddress,
                    observedAt: marketObservedAt,
                    marketStatus: "resolved",
                    symbol: market.symbol ?? null,
                    imageUrl: market.imageUrl ?? null,
                    marketCapUsd: market.marketCapUsd,
                    launchedAt: market.launchedAt ?? market.createdAt ?? null,
                    ...(milestoneObserved ? { milestoneStatus: "observed" as const, milestoneObservedAt: marketObservedAt } : {}),
                  });
                  options.tokenStateStore?.saveTokenMarketSnapshot({
                    snapshotId: `market:${tokenId}:${marketObservedAt}:${market.marketCapUsd ?? "na"}:${market.priceUsd ?? "na"}`,
                    tokenId,
                    source: "dexscreener",
                    observedAt: marketObservedAt,
                    priceUsd: market.priceUsd,
                    marketCapUsd: market.marketCapUsd,
                    liquidityUsd: market.liquidityUsd,
                    payload: market,
                  });
                }
              }
              catch (error) {
                marketStatus = "degraded";
                launchStatus = "unavailable";
                failed = true;
                options.tokenStateStore?.saveTokenObservation({ tokenId, chain, tokenAddress, observedAt: facts.observedAt, marketStatus: "pending" });
                if (isSupportedDiscoveryChain(chain)) enqueueTokenRecovery(options.tokenStateStore, "market_enrichment", chain, tokenId, 20, options.clock.now());
                options.onCollectorError?.(error, index);
              }
            }
            if (market && marketObservedAt !== null && options.onTokenMarketObserved) {
              try {
                await options.onTokenMarketObserved({ chain, tokenAddress, observedAt: marketObservedAt, sourceEventIds: Object.freeze([...facts.sourceEventIds]), market });
              } catch (error) {
                failed = true;
                options.onCollectorError?.(error, index);
              }
            }
            const launchTimes = [market?.launchedAt, facts.launchedAt].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
            const launchedAt = launchTimes.length > 0 ? Math.min(...launchTimes) : undefined;
            if (options.lifecycleResolver) {
              try {
                const launchProviderStatus = launchedAt !== undefined ? "ready" as const : launchStatus;
                lifecycleStage = await options.lifecycleResolver.resolve({ chain, tokenAddress, observedAt: facts.observedAt, ...(facts.createdAt !== undefined ? { createdAt: facts.createdAt } : {}), ...(launchedAt !== undefined ? { launchedAt } : {}), ...(launchProviderStatus ? { launchProviderStatus } : {}) });
              } catch (error) { lifecycleStatus = "degraded"; failed = true; options.onCollectorError?.(error, index); }
            }
            return Object.freeze({ market, lifecycleStage, failed });
          })();
          tokenResolutionCache.set(tokenId, resolution);
          return resolution;
        };
        for (const observation of batch.observations) {
          let claimedProjection: { eventId: string; projectionType: string; sourceRevision: string } | null = null;
          try {
            let chain: string;
            let tokenAddress: string;
            let evidence: AddressSignalEvidence;
            let market: TokenMarketSnapshot | null = null;
            if (observation.event) {
              if (options.sourceLedger && isSupportedDiscoveryChain(observation.event.chain)) {
                const extractionMode = observation.event.source === "onchain_wallet" ? "rpc" : "network";
                const sourceWrite = options.sourceLedger.saveObservation(sourceObservationForTraderEvent(observation.event, extractionMode));
                if (sourceWrite.status === "conflict") continue;
              }
              const mappedEntity = options.repository.entityForAccount(observation.event.accountId);
              const event = mappedEntity ? { ...observation.event, entityId: mappedEntity } : observation.event;
              options.repository.insertTraderEvent(event);
              chain = event.chain.toLowerCase();
              tokenAddress = event.tokenAddress;
              const projectionKey = { eventId: event.eventId, projectionType, sourceRevision: options.config.strategyVersion };
              const projectionStatus = options.repository.claimEventProjection({ ...projectionKey, owner: projectionOwner, now: options.clock.now(), leaseMs: projectionLeaseMs });
              if (projectionStatus !== "claimed") continue;
              claimedProjection = projectionKey;
              const resolved = await resolveToken(chain, tokenAddress);
              market = resolved.market;
              batchFailed ||= resolved.failed;
              const lifecycleStage = resolved.lifecycleStage;
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
              if (claimedProjection) {
                options.repository.completeEventProjection({
                  ...claimedProjection,
                  owner: projectionOwner,
                  resultKey: `filtered:${evidence.eventId}`,
                  completedAt: options.clock.now(),
                });
                claimedProjection = null;
              }
              rejected += 1;
              continue;
            }
            options.repository.saveAddressSignalEvidence(chain, tokenAddress, evidence);
            if (claimedProjection) {
              const completed = options.repository.completeEventProjection({
                ...claimedProjection,
                owner: projectionOwner,
                resultKey: evidence.eventId,
                completedAt: options.clock.now(),
              });
              if (!completed) throw new Error(`Lost event projection lease for ${evidence.eventId}`);
              claimedProjection = null;
            }
            options.tokenStateStore?.saveTokenObservation({ tokenId, chain, tokenAddress, observedAt: evidence.occurredAt, evidenceStatus: "observed" });
            const group = groups.get(tokenId) ?? { chain, tokenAddress, evidence: [], market };
            group.evidence.push(evidence);
            if (market) group.market = market;
            groups.set(tokenId, group);
            lastEventAt = Math.max(lastEventAt ?? 0, evidence.occurredAt);
            accepted += 1;
          } catch (error) {
            if (claimedProjection) {
              options.repository.failEventProjection({
                ...claimedProjection,
                owner: projectionOwner,
                error: error instanceof Error ? error.message : String(error),
                failedAt: options.clock.now(),
                nextAttemptAt: options.clock.now() + 30_000,
              });
            }
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
        if (sourceHealth) {
          const derivedProgress = deriveSourceProgress(batch.observations);
          const progress = batch.sourceProgress ?? (derivedProgress.length > 0 ? derivedProgress : options.collectors[index]?.healthTargets ?? []);
          for (const item of progress) sourceHealth.recordSuccess({ ...item, startedAt: attemptStartedAt[index]! });
        }
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

function isSupportedDiscoveryChain(chain: string): boolean {
  try { normalizeDiscoveryChain(chain); return true; }
  catch { return false; }
}

function enqueueTokenRecovery(
  store: ScannerRuntimeOptions["tokenStateStore"],
  jobType: "fomo_token_history" | "market_enrichment",
  chain: string,
  tokenId: string,
  priority: number,
  now: number,
): void {
  if (!store) return;
  store.enqueueRecoveryJob({
    jobId: `recovery:${jobType}:${tokenId}`,
    jobType,
    chain: normalizeDiscoveryChain(chain),
    subjectKey: tokenId,
    priority,
    cursor: null,
    nextAttemptAt: now,
    createdAt: now,
  });
}

function deriveSourceProgress(observations: readonly ScannerObservation[]): readonly Omit<SourceSuccessAttempt, "startedAt">[] {
  const progress = new Map<string, Omit<SourceSuccessAttempt, "startedAt">>();
  for (const observation of observations) {
    if (!observation.event) continue;
    try {
      const event = observation.event;
      const extractionMode = event.source === "onchain_wallet" ? "rpc" : "network";
      const source = sourceObservationForTraderEvent(event, extractionMode).source;
      const chain = normalizeDiscoveryChain(event.chain);
      const stream = event.source === "onchain_wallet" ? "wallet_observation" as const : "fomo_live" as const;
      const key = `${source}:${chain}:${stream}`;
      const previous = progress.get(key);
      progress.set(key, { source, chain, stream, lastEventAt: Math.max(previous?.lastEventAt ?? 0, event.occurredAt) });
    } catch {
      // Unsupported chains remain in the immutable ledger but do not create production health rows.
    }
  }
  return Object.freeze([...progress.values()]);
}

export const createPollingRuntimeJob = (input: { readonly runOnce: () => unknown | Promise<unknown>; readonly intervalMs: number; readonly maximumBackoffMs?: number; readonly now?: () => number; readonly onError?: (error: unknown) => void }): ScannerRuntimeJob => {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let active = false;
  let consecutiveFailures = 0;
  let nextAttemptAt = Number.NEGATIVE_INFINITY;
  const now = input.now ?? Date.now;
  const maximumBackoffMs = input.maximumBackoffMs ?? input.intervalMs * 32;
  const tick = () => {
    if (!active || running || now() < nextAttemptAt) return;
    running = Promise.resolve(input.runOnce())
      .then(() => { consecutiveFailures = 0; nextAttemptAt = Number.NEGATIVE_INFINITY; })
      .catch(error => {
        consecutiveFailures += 1;
        const backoffMs = Math.min(maximumBackoffMs, input.intervalMs * (2 ** (consecutiveFailures - 1)));
        nextAttemptAt = now() + backoffMs;
        input.onError?.(error);
      })
      .finally(() => { running = undefined; });
  };
  return Object.freeze({ start() { if (active) return; active = true; tick(); timer = setInterval(tick, input.intervalMs); }, async stop() { active = false; if (timer) clearInterval(timer); timer = undefined; await running; } });
};
export const RECONCILIATION_INTERVAL_MS: Readonly<Record<TraderLifecycle, number>> = Object.freeze({ candidate: 1_800_000, probation: 900_000, active: 300_000, elite: 120_000, degraded: 3_600_000, suspended: 86_400_000 });
export const reconciliationIntervalMs = (lifecycle: TraderLifecycle, manualPriority = false): number => manualPriority ? RECONCILIATION_INTERVAL_MS.elite : RECONCILIATION_INTERVAL_MS[lifecycle];
