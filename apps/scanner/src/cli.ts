import { openAddressRadarRepository } from "@address-radar/database";
import { createDexScreenerClient } from "@address-radar/collectors";
import { createTokenLifecycleResolver } from "@address-radar/aggregation";
import { openMonitoringRegistry } from "@address-radar/identity";
import { pathToFileURL } from "node:url";
import { parseScannerConfig, runScannerPreflight } from "./config.js";
import { createPollingRuntimeJob, createScannerRuntime } from "./runtime.js";
import { createConfiguredCollectors } from "./collectors.js";

export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const config = parseScannerConfig(env);
  const preflight = await runScannerPreflight({ config });
  if (!preflight.ready) throw new Error(preflight.failures.map(item => `${item.code}: ${item.message}`).join("; "));

  const repository = openAddressRadarRepository(config.databasePath);
  const monitoringRegistry = openMonitoringRegistry(config.databasePath);
  const marketProvider = createDexScreenerClient({ ...(config.marketBaseUrl ? { baseUrl: config.marketBaseUrl } : {}) });
  const lifecycleResolver = createTokenLifecycleResolver({ provider: {
    async tokenFacts(request) {
      const market = await marketProvider.lookup(request.chain, request.tokenAddress);
      if (!market) return { status: "unavailable" as const, markets: [] };
      return {
        status: "ready" as const,
        ...(market.createdAt != null ? { createdAt: market.createdAt } : {}),
        markets: market.launchedAt != null ? [{ launchedAt: market.launchedAt }] : [],
      };
    },
  } });
  const collectors = createConfiguredCollectors({ config, repository, monitoringRegistry });
  const runtime = createScannerRuntime({
    repository,
    collectors,
    signalSink: { accept: () => undefined },
    clock: { now: Date.now },
    config,
    lifecycleResolver,
    marketProvider,
  });
  const polling = createPollingRuntimeJob({
    runOnce: () => runtime.runOnce(),
    intervalMs: config.pollIntervalMs,
    onError: error => console.error("Scanner iteration failed", error),
  });

  await runtime.start();
  polling.start();
  const shutdown = async (): Promise<void> => {
    await polling.stop();
    await runtime.close();
    repository.close();
    monitoringRegistry.close();
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
