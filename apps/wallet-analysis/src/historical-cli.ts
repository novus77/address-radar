import { createDuneDataApiClient, FomoTokenLookupProducer, FomoTokenLookupResultConsumer } from "@address-radar/collectors";
import { createCandidateHistoryStore, migrateAddressRadarDatabase, openAddressRadarDatabase, openAddressRadarRepository } from "@address-radar/database";

import { loadHistoricalBackfillConfig } from "./config.js";
import { createDuneHistoricalBackfillWorker } from "./dune-historical-worker.js";
import { createFomoHistoricalVerificationService } from "./fomo-token-verification.js";
import { createHistoricalBackfillScheduler, runHistoricalBackfillCycle } from "./historical-backfill.js";
import { createHistoricalPartitions } from "./historical-partitions.js";
import { createHistoricalStagePlanner } from "./historical-stage-planner.js";
import { runWalletAnalysisService } from "./service.js";
import { createSolanaTokenSupplyProvider } from "./solana-token-supply.js";

const config = loadHistoricalBackfillConfig(process.env);
const repository = openAddressRadarRepository(config.databasePath);
const database = openAddressRadarDatabase(config.databasePath);
migrateAddressRadarDatabase(database);
const historyStore = createCandidateHistoryStore(database);
const verification = createFomoHistoricalVerificationService({
  database,
  producer: new FomoTokenLookupProducer({ filePath: config.fomoLookupQueuePath }),
  consumer: new FomoTokenLookupResultConsumer({ filePath: config.fomoLookupResultPath, cursorPath: config.fomoLookupResultCursorPath }),
  maximumActiveLookups: config.fomoMaximumActiveLookups,
});
const client = createDuneDataApiClient({ apiKey: config.apiKey, timeoutMs: config.timeoutMs, pollIntervalMs: config.pollIntervalMs });
const worker = createDuneHistoricalBackfillWorker({
  client,
  repository,
  historyStore,
  queryIds: config.queryIds,
  pageSize: config.pageSize,
  strategyVersion: config.strategyVersion,
  ...(config.solanaRpc ? { solanaSupply: createSolanaTokenSupplyProvider({ endpoint: config.solanaRpc.primary, ...(config.solanaRpc.fallback ? { fallbackEndpoint: config.solanaRpc.fallback } : {}) }) } : {}),
  resolveVerifiedTokenAddresses: verification.resolveEligibleAddresses,
  resolveTraderId(chain, address) {
    const family = chain === "solana" ? "solana" : "evm";
    const row = database.prepare("SELECT ea.entity_id AS entityId FROM wallet_identities w JOIN entity_accounts ea ON ea.account_id = w.account_id WHERE w.chain_family = ? AND w.address = ? ORDER BY ea.last_observed_at DESC LIMIT 1").get(family, family === "evm" ? address.toLowerCase() : address) as { entityId: string } | undefined;
    return row?.entityId ?? null;
  },
  onAcceptedUnresolvedWallet(wallet) {
    repository.admitHistoricalWalletCandidate({ ...wallet, strategyVersion: config.strategyVersion });
  },
});
const scheduler = createHistoricalBackfillScheduler({ repository, worker, dailyCreditBudget: config.dailyCreditBudget });
const endAt = Date.now();
const stagePlanner = createHistoricalStagePlanner({ database, repository, chains: config.chains, startAt: config.startAt });

const seedStage = (queryKind: "token_universe" | "milestone_crossings" | "pre_milestone_trades", tokenAddressesByChain?: Readonly<Record<string, readonly string[]>>): void => {
  for (const partition of createHistoricalPartitions({ queryKind, chains: config.chains, from: config.startAt, to: endAt, ...(tokenAddressesByChain ? { tokenAddressesByChain } : {}), createdAt: Date.now() })) repository.enqueueHistoricalBackfillPartition(partition);
};
const seed = (): void => {
  seedStage("token_universe");
  stagePlanner.plan();
};

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await runWalletAnalysisService({ signal: controller.signal, intervalMs: config.intervalMs, runOnce: async () => {
    seed();
    return runHistoricalBackfillCycle({ verification, scheduler, signal: controller.signal });
  } });
} finally {
  repository.close();
  database.close();
}
