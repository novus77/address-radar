import { DatabaseSync } from "node:sqlite";

import { createDuneDataApiClient } from "@address-radar/collectors";
import { createCandidateHistoryStore, migrateAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";

import { loadHistoricalBackfillConfig } from "./config.js";
import { createDuneHistoricalBackfillWorker } from "./dune-historical-worker.js";
import { createHistoricalBackfillScheduler } from "./historical-backfill.js";
import { createHistoricalPartitions } from "./historical-partitions.js";
import { runWalletAnalysisService } from "./service.js";

const config = loadHistoricalBackfillConfig(process.env);
const repository = openAddressRadarRepository(config.databasePath);
const database = new DatabaseSync(config.databasePath);
migrateAddressRadarDatabase(database);
const historyStore = createCandidateHistoryStore(database);
const client = createDuneDataApiClient({ apiKey: config.apiKey, timeoutMs: config.timeoutMs, pollIntervalMs: config.pollIntervalMs });
const worker = createDuneHistoricalBackfillWorker({
  client,
  repository,
  historyStore,
  queryIds: config.queryIds,
  pageSize: config.pageSize,
  strategyVersion: config.strategyVersion,
  resolveTraderId(chain, address) {
    const family = chain === "solana" ? "solana" : "evm";
    const row = database.prepare("SELECT ea.entity_id AS entityId FROM wallet_identities w JOIN entity_accounts ea ON ea.account_id = w.account_id WHERE w.chain_family = ? AND w.address = ? ORDER BY ea.last_observed_at DESC LIMIT 1").get(family, family === "evm" ? address.toLowerCase() : address) as { entityId: string } | undefined;
    return row?.entityId ?? null;
  },
});
const scheduler = createHistoricalBackfillScheduler({ repository, worker, dailyCreditBudget: config.dailyCreditBudget });
const endAt = Date.now();

const seedStage = (queryKind: "token_universe" | "milestone_crossings" | "pre_milestone_trades", tokenAddressesByChain?: Readonly<Record<string, readonly string[]>>): void => {
  for (const partition of createHistoricalPartitions({ queryKind, chains: config.chains, from: config.startAt, to: endAt, ...(tokenAddressesByChain ? { tokenAddressesByChain } : {}), createdAt: Date.now() })) repository.enqueueHistoricalBackfillPartition(partition);
};
const completed = (kind: string): boolean => {
  const partitions = repository.historicalBackfillPartitions().filter(item => item.queryKind === kind);
  return partitions.length > 0 && partitions.every(item => item.status === "completed");
};
const tokenAddresses = (): Readonly<Record<string, readonly string[]>> => Object.freeze(Object.fromEntries(config.chains.map(chain => [chain, Object.freeze((database.prepare("SELECT token_address AS tokenAddress FROM historical_tokens WHERE chain = ? ORDER BY token_address").all(chain) as { tokenAddress: string }[]).map(item => item.tokenAddress))])));
const seed = (): void => {
  seedStage("token_universe");
  if (completed("token_universe")) seedStage("milestone_crossings", tokenAddresses());
  if (completed("milestone_crossings")) seedStage("pre_milestone_trades", tokenAddresses());
};

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await runWalletAnalysisService({ signal: controller.signal, intervalMs: config.intervalMs, runOnce: async () => { seed(); return scheduler.runOnce(controller.signal); } });
} finally {
  repository.close();
  database.close();
}
