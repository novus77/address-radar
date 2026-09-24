import type { ChainFamily } from "@address-radar/domain";
import type { DiscoveryChain } from "@address-radar/collectors";
import { loadWalletAnalysisConfig } from "./config.js";
import { createEvmRpcWalletHistoryProvider, createSolanaRpcWalletHistoryProvider, openHistoricalEventStore, openSqliteHistoricalMarketSource } from "./history.js";
import { createConfiguredAnalysisRpcClient } from "./rpc.js";
import { createWalletAnalysisRuntime, type WalletHistoryProvider } from "./runtime.js";
import { runWalletAnalysisService } from "./service.js";
import { openWalletAnalysisStore } from "./store.js";

const config = loadWalletAnalysisConfig(process.env);
const store = openWalletAnalysisStore(config.databasePath);
const eventStore = openHistoricalEventStore(config.databasePath);
const market = openSqliteHistoricalMarketSource(config.databasePath);
const rpc = createConfiguredAnalysisRpcClient({ endpoints: config.endpoints });
const chains = Object.keys(config.endpoints) as DiscoveryChain[];
const providers: Partial<Record<ChainFamily, WalletHistoryProvider>> = {};
const evmChains = chains.filter((chain): chain is Exclude<DiscoveryChain, "solana"> => chain !== "solana");
if (evmChains.length) providers.evm = createEvmRpcWalletHistoryProvider({ rpc, chains: evmChains, market, events: eventStore });
if (chains.includes("solana")) providers.solana = createSolanaRpcWalletHistoryProvider({ rpc, market, events: eventStore });
if (!providers.evm && !providers.solana) throw new Error("No usable wallet history provider configured");
const runtime = createWalletAnalysisRuntime({ store, providers });
const controller = new AbortController(); let stopping = false;
const stop = () => { if (!stopping) { stopping = true; controller.abort(); } };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try { await runWalletAnalysisService({ signal: controller.signal, intervalMs: config.intervalMs, runOnce: () => runtime.runOnce(controller.signal) }); }
finally { store.close(); eventStore.close(); market.close(); }
