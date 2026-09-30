import { addressRadarTokenId } from "@address-radar/domain";
import {
  createCandidateHistoryStore,
  createSharedProviderRequestGate,
  createAutomationJobStore,
  createRecoveryFactLinkStore,
  createSourceLedgerStore,
  createTokenFactStore,
  openAddressRadarDatabase,
  openAddressRadarRepository,
} from "@address-radar/database";
import { createDefiLlamaPriceClient, createDexScreenerClient, createGeckoTerminalClient, FomoTokenLookupProducer } from "@address-radar/collectors";
import { createTokenLifecycleResolver } from "@address-radar/aggregation";
import { openMonitoringRegistry } from "@address-radar/identity";
import { createGatewayClient, createGatewayDeliveryWorker } from "@address-radar/delivery";
import { pathToFileURL } from "node:url";
import { parseScannerConfig, runScannerPreflight } from "./config.js";
import { createPollingRuntimeJob, createScannerRuntime } from "./runtime.js";
import { createRecoveryRuntime } from "./recovery-runtime.js";
import { createConfiguredCollectors, createProjectionReplayCollector } from "./collectors.js";
import { createDiskHeadroomGuard, createRateLimitedErrorReporter } from "./resilience.js";
import { createSourceRecoveryHandlers, reconcileCandidateSourceRecovery } from "./source-recovery-handlers.js";

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const config = parseScannerConfig(env);
  const preflight = await runScannerPreflight({ config });
  if (!preflight.ready) throw new Error(preflight.failures.map(item => `${item.code}: ${item.message}`).join("; "));

  const repository = openAddressRadarRepository(config.databasePath);
  const historyDatabase = openAddressRadarDatabase(config.databasePath);
  const historyStore = createCandidateHistoryStore(historyDatabase);
  const sourceLedger = createSourceLedgerStore(historyDatabase);
  const tokenFacts = createTokenFactStore(historyDatabase);
  const automationJobs = createAutomationJobStore(historyDatabase);
  const recoveryFactLinks = createRecoveryFactLinkStore(historyDatabase);
  const monitoringRegistry = openMonitoringRegistry(config.databasePath);
  const marketProvider = createDexScreenerClient({ ...(config.marketBaseUrl ? { baseUrl: config.marketBaseUrl } : {}) });
  const geckoGate = createSharedProviderRequestGate({ database: historyDatabase, provider: "geckoterminal:public", minimumIntervalMs: 12_500 });
  const historicalMarketProvider = createGeckoTerminalClient({ minimumRequestIntervalMs: 12_500, beforeRequest: geckoGate.acquire, onRateLimit: geckoGate.cooldown });
  const historicalPriceFallback = createDefiLlamaPriceClient();
  if (config.recoveryEnabled) reconcileCandidateSourceRecovery({ database: historyDatabase, ledger: sourceLedger });
  const lifecycleResolver = createTokenLifecycleResolver({});
  const collectors = Object.freeze([
    ...createConfiguredCollectors({ config, repository, monitoringRegistry }),
    ...(config.projectionReplayEnabled ? [createProjectionReplayCollector({
      repository,
      strategyVersion: config.strategyVersion,
      lookbackMs: config.projectionReplayLookbackMs ?? 24 * 60 * 60_000,
      batchSize: config.projectionReplayBatchSize ?? 100,
      realtimeWindowMs: config.projectionReplayRealtimeWindowMs ?? 60 * 60_000,
      realtimeBatchSize: config.projectionReplayRealtimeBatchSize ?? 25,
    })] : []),
  ]);
  const errorReporter = createRateLimitedErrorReporter({
    emit: (message, error) => console.error(message, error),
    windowMs: config.errorLogWindowMs,
  });
  const diskGuard = createDiskHeadroomGuard({
    path: config.databasePath,
    minimumFreeBytes: config.minimumFreeDiskBytes,
    checkIntervalMs: config.diskCheckIntervalMs,
  });
  const runtime = createScannerRuntime({
    repository,
    collectors,
    clock: { now: Date.now },
    config,
    lifecycleResolver,
    marketProvider,
    sourceLedger,
    sourceHealthLedger: sourceLedger,
    tokenStateStore: sourceLedger,
    onTokenMarketObserved: observation => {
      const marketCapUsd = observation.market.marketCapUsd;
      if (marketCapUsd == null || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return;
      const tokenId = addressRadarTokenId(observation.chain, observation.tokenAddress);
      tokenFacts.ensure(tokenId, "market_identity", "token-facts-v1", observation.observedAt);
      tokenFacts.transition({ tokenId, factType: "market_identity", status: "available", precision: "page_observed", primarySource: "scanner_market", observedAt: observation.observedAt, knownAt: observation.observedAt, strategyVersion: "token-facts-v1", updatedAt: observation.observedAt });
      tokenFacts.ensure(tokenId, "price_history", "token-facts-v1", observation.observedAt);
      const priceFact = tokenFacts.fact(tokenId, "price_history")!;
      if (priceFact.status !== "available") tokenFacts.transition({ tokenId, factType: "price_history", status: "partial", precision: "page_observed", primarySource: "scanner_market", coverageStartAt: observation.observedAt, coverageEndAt: observation.observedAt, observedAt: observation.observedAt, knownAt: observation.observedAt, strategyVersion: "token-facts-v1", updatedAt: observation.observedAt });
      for (const milestoneMarketCapUsd of [100_000, 200_000, 300_000, 500_000, 1_000_000]) {
        if (marketCapUsd < milestoneMarketCapUsd) continue;
        historyStore.saveMilestoneCrossing({
          milestoneId: `${observation.chain}:${observation.tokenAddress}:${milestoneMarketCapUsd}`,
          tokenId,
          marketCapUsd: milestoneMarketCapUsd,
          crossedAt: observation.observedAt,
          precision: "estimated",
          source: "fomo_realtime_dexscreener",
          sourceEventIds: observation.sourceEventIds,
          strategyVersion: "candidate-history-v3",
        });
        tokenFacts.ensure(tokenId, "milestone_crossings", "token-facts-v1", observation.observedAt);
        const milestoneFact = tokenFacts.fact(tokenId, "milestone_crossings")!;
        if (milestoneFact.status !== "available") tokenFacts.transition({ tokenId, factType: "milestone_crossings", status: "partial", precision: "estimated", primarySource: "fomo_realtime_dexscreener", coverageStartAt: observation.observedAt, coverageEndAt: observation.observedAt, observedAt: observation.observedAt, knownAt: observation.observedAt, strategyVersion: "token-facts-v1", updatedAt: observation.observedAt });
      }
      if (marketCapUsd < 1_000_000) return;
      historyStore.saveHistoricalToken({
        tokenId,
        chain: observation.chain,
        tokenAddress: observation.tokenAddress,
        symbol: observation.market.symbol ?? null,
        imageUrl: observation.market.imageUrl ?? null,
        firstTradeAt: observation.market.createdAt ?? observation.market.launchedAt ?? null,
        firstReached1mAt: observation.observedAt,
        peakMarketCapUsd: marketCapUsd,
        source: "fomo_realtime_dexscreener",
        sourceQueryId: null,
        provenance: { observedAt: observation.observedAt, sourceEventIds: observation.sourceEventIds },
      });
      historyStore.confirmHistoricalTokenPresence(tokenId, observation.observedAt);
    },
    onCollectorError: (error, collectorIndex) => errorReporter.report(`Scanner collector ${collectorIndex} failed`, error),
  });
  const polling = createPollingRuntimeJob({
    runOnce: async () => { await diskGuard.assertHealthy(); return runtime.runOnce(); },
    intervalMs: config.pollIntervalMs,
    maximumBackoffMs: 5 * 60_000,
    onError: error => errorReporter.report("Scanner iteration failed", error),
  });
  const delivery = config.gatewayDeliveryEnabled && config.gatewayEndpoint && config.gatewayKeyId && config.gatewaySharedSecret
    ? createGatewayDeliveryWorker({
        repository,
        client: createGatewayClient({ endpoint: config.gatewayEndpoint, keyId: config.gatewayKeyId, secret: config.gatewaySharedSecret, timeoutMs: config.gatewayTimeoutMs ?? 5_000 }),
        workerId: `scanner:${process.pid}`,
      })
    : null;
  const deliveryPolling = delivery ? createPollingRuntimeJob({
    runOnce: () => delivery.runOnce(),
    intervalMs: config.gatewayDeliveryIntervalMs ?? 1_000,
    onError: error => errorReporter.report("Gateway delivery iteration failed", error),
  }) : null;
  const recovery = config.recoveryEnabled ? createRecoveryRuntime({
    ledger: sourceLedger,
    factLinks: recoveryFactLinks,
    tokenFacts,
    handlers: createSourceRecoveryHandlers({
      database: historyDatabase,
      ledger: sourceLedger,
      jobs: automationJobs,
      history: historyStore,
      facts: tokenFacts,
      marketProvider,
      historicalMarketProvider,
      historicalPriceFallback,
      fomoProducer: new FomoTokenLookupProducer({ filePath: config.fomoLookupQueuePath, bucketMs: 12 * 60 * 60_000 }),
      now: Date.now,
    }),
    clock: { now: Date.now },
    leaseMs: config.recoveryLeaseMs,
    deadlineMs: config.recoveryDeadlineMs ?? 120_000,
    retryBaseMs: config.recoveryRetryBaseMs,
    onReEvaluate: request => {
      if (request.kind === "token") automationJobs.wakeBlockedSource(request.key, Date.now(), "candidate_evidence");
    },
  }) : null;
  const recoveryPolling = recovery ? createPollingRuntimeJob({
    runOnce: () => recovery.runOnce(),
    intervalMs: config.recoveryPollIntervalMs,
    onError: error => errorReporter.report("Recovery iteration failed", error),
  }) : null;

  await runtime.start();
  polling.start();
  deliveryPolling?.start();
  recoveryPolling?.start();
  const shutdown = async (): Promise<void> => {
    await recoveryPolling?.stop();
    await deliveryPolling?.stop();
    await polling.stop();
    await runtime.close();
    repository.close();
    monitoringRegistry.close();
    historyDatabase.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
