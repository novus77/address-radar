import { createDexScreenerClient, type DiscoveryChain } from "@address-radar/collectors";
import { openMonitoringRegistry } from "@address-radar/identity";
import { createEvmBlockWalletCollector, createSolanaWalletCollector } from "./collectors.js";
import { loadWalletMonitorConfig } from "./config.js";
import { createConfiguredWalletRpcClient } from "./rpc.js";
import { createWalletMonitorRuntime } from "./runtime.js";
import { runWalletMonitorService } from "./service.js";
import { openWalletMonitorStore } from "./store.js";

const config = loadWalletMonitorConfig(process.env);
const registry = openMonitoringRegistry(config.databasePath);
const store = openWalletMonitorStore(config.databasePath);
const rpc = createConfiguredWalletRpcClient({ endpoints: config.endpoints });
const market = createDexScreenerClient();
const collectors = (Object.keys(config.endpoints) as DiscoveryChain[]).map(chain => chain === "solana"
  ? createSolanaWalletCollector({ rpc, market, batchSize: config.solanaBatchSize })
  : createEvmBlockWalletCollector({ chain, rpc, market }));
const runtime = createWalletMonitorRuntime({ registry, store, collectors, consumer: "wallet-monitor" });
const controller = new AbortController();
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; controller.abort(); } };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await runWalletMonitorService({ signal: controller.signal, intervalMs: config.intervalMs, pollOnce: () => runtime.pollOnce(controller.signal), onError: error => console.error(`[wallet-monitor] ${error.message}`) });
} finally {
  store.close();
  registry.close();
}
