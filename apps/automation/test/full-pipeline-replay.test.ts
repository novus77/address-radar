import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createAutomationJobStore,
  createCandidateHistoryStore,
  createWalletCoverageStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
} from "@address-radar/database";

import { detectRepeatedBundleRisk, type BundleTrade } from "../src/bundle-risk-detector.js";
import { createCandidateEvidenceWorker } from "../src/candidate-evidence-worker.js";
import { createTokenMiningWorker } from "../src/token-mining-worker.js";
import type { HistoricalTokenPartition, HistoricalTokenSource } from "../src/token-source-adapters.js";
import { createTraderAbilityWorker } from "../src/trader-ability-worker.js";

const NOW = 100_000;
const CHAINS = ["solana", "bsc", "eth", "base", "robinhood"] as const;

describe("full automation pipeline replay", () => {
  it("replays five chains without duplicate canonical events or candidate evidence", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    const history = createCandidateHistoryStore(database);
    for (const traderId of ["strong", "two-early", "bundle-cluster", "bundle-peer-a", "bundle-peer-b"]) {
      database.prepare(`
        INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
        VALUES (?, 'candidate', 0, 0, 1, 1)
      `).run(traderId);
    }

    seedEvidenceToken(database, history, "base:strong-token", 300_000, 5);
    seedEvidenceToken(database, history, "bsc:early-a", 100_000, 3);
    seedEvidenceToken(database, history, "eth:early-b", 200_000, 3);
    insertBuy(database, "strong-fomo", "strong", "base:strong-token", 60, "FOMO_ONLY", 1_000);
    insertBuy(database, "early-onchain", "two-early", "bsc:early-a", 60, "ONCHAIN_ONLY", 1_000);
    insertBuy(database, "early-fomo", "two-early", "eth:early-b", 60, "FOMO_ONLY", 1_000);

    insertBuy(database, "bundle-a-1", "bundle-cluster", "robinhood:bundle-a", 100, "FOMO_ONLY", 10_000);
    insertBuy(database, "bundle-peer-a", "bundle-peer-a", "robinhood:bundle-a", 100, "ONCHAIN_ONLY", 14_000);
    insertBuy(database, "bundle-a-2", "bundle-cluster", "base:bundle-b", 100, "FOMO_ONLY", 20_000);
    insertBuy(database, "bundle-peer-b", "bundle-peer-b", "base:bundle-b", 100, "ONCHAIN_ONLY", 29_000);

    const candidateWorker = createCandidateEvidenceWorker({ database, now: () => NOW });
    await evaluateCandidate(candidateWorker, "base:strong-token");
    database.prepare(`
      UPDATE canonical_trader_events SET source_status = 'FOMO_AND_ONCHAIN', updated_at = 2_000
      WHERE canonical_event_id = 'strong-fomo'
    `).run();
    await evaluateCandidate(candidateWorker, "base:strong-token");
    await evaluateCandidate(candidateWorker, "base:strong-token");
    await evaluateCandidate(candidateWorker, "bsc:early-a");
    await evaluateCandidate(candidateWorker, "eth:early-b");
    await evaluateCandidate(candidateWorker, "eth:early-b");

    const trades = database.prepare(`
      SELECT canonical_event_id AS eventId, entity_id AS traderId, chain,
        token_address AS tokenAddress, occurred_at AS occurredAt
      FROM canonical_trader_events WHERE side = 'buy'
    `).all() as unknown as BundleTrade[];
    const bundle = detectRepeatedBundleRisk(trades);
    const abilityWorker = createTraderAbilityWorker({ database, now: () => NOW });
    await abilityWorker.execute({ payload: JSON.stringify({ traderId: "bundle-cluster", evaluatedAt: NOW }), cursor: null } as never, new AbortController().signal);

    const jobs = createAutomationJobStore(database);
    const partitions = Object.fromEntries(CHAINS.map((chain, index) => {
      const partition = seedPartition(database, chain, index * 1_000, index * 1_000 + 999);
      return [chain, partition];
    })) as Record<typeof CHAINS[number], HistoricalTokenPartition>;
    const source: HistoricalTokenSource = {
      name: "dune",
      async discover(partition, cursor) {
        if (partition.chain === "solana") {
          return { status: "waiting_source", reason: "dune_unavailable_after_solana_rate_limit", retryAt: NOW + 30_000 };
        }
        if (partition.chain === "base" && cursor === null) return { status: "ready", tokens: [], nextCursor: "page-2" };
        return { status: "ready", tokens: [], nextCursor: null };
      },
    };
    const miningWorker = createTokenMiningWorker({ database, jobs, source, now: () => NOW });
    createWalletCoverageStore(database).upsert({
      identityId: "strong",
      chain: "robinhood",
      provider: "replay",
      status: "unsupported",
      cursor: null,
      coverageStartAt: null,
      coverageEndAt: null,
      lastSuccessAt: null,
      diagnostic: { code: "no_historical_provider" },
      updatedAt: NOW,
    });
    let resumeCursor: string | null = null;
    for (const chain of CHAINS) {
      const partition = partitions[chain];
      const first = await miningWorker.execute(miningJob(partition), new AbortController().signal);
      if (chain === "base") {
        resumeCursor = first.cursor ?? null;
        await miningWorker.execute(miningJob(partition, first.cursor ?? null), new AbortController().signal);
      }
    }

    const duplicateCanonicalEvents = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT entity_id, chain, token_address, side, occurred_at
        FROM canonical_trader_events
        GROUP BY entity_id, chain, token_address, side, occurred_at
        HAVING COUNT(*) > 1
      )
    `).get() as { count: number }).count);
    const duplicateCandidateEvidence = Number((database.prepare(`
      SELECT COUNT(*) - COUNT(DISTINCT evidence_id) AS count FROM candidate_evidence_v3
    `).get() as { count: number }).count);
    const admittedTraderIds = (database.prepare(`
      SELECT DISTINCT trader_id AS traderId FROM candidate_admission_snapshots
      WHERE current_admission = 1 ORDER BY trader_id
    `).all() as Array<{ traderId: string }>).map(item => item.traderId);
    const unblockedChains = (database.prepare(`
      SELECT chain FROM historical_token_partitions WHERE status = 'completed' ORDER BY chain
    `).all() as Array<{ chain: string }>).map(item => item.chain);
    const result = {
      duplicateCanonicalEvents,
      duplicateCandidateEvidence,
      admittedTraderIds,
      bundleRiskTraderIds: bundle.bundleRiskTraderIds,
      unblockedChains,
      resumeCursor,
    };

    expect(result.duplicateCanonicalEvents).toBe(0);
    expect(result.duplicateCandidateEvidence).toBe(0);
    expect(result.admittedTraderIds).toEqual(["strong", "two-early"]);
    expect(result.bundleRiskTraderIds).toEqual(["bundle-cluster"]);
    expect(result.unblockedChains).toEqual(["base", "bsc", "eth", "robinhood"]);
    expect(result.resumeCursor).toBe("page-2");
    expect(database.prepare("SELECT source_status AS sourceStatus FROM canonical_trader_events WHERE canonical_event_id = 'strong-fomo'").get())
      .toEqual({ sourceStatus: "FOMO_AND_ONCHAIN" });
    expect(database.prepare("SELECT status, last_error AS lastError FROM historical_token_partitions WHERE chain = 'solana'").get())
      .toMatchObject({ status: "waiting_source", lastError: "dune_unavailable_after_solana_rate_limit" });
    expect(database.prepare("SELECT status FROM wallet_chain_coverage WHERE identity_id='strong' AND chain='robinhood'").get())
      .toEqual({ status: "unsupported" });
    database.close();
  });
});

function seedEvidenceToken(
  database: DatabaseSync,
  history: ReturnType<typeof createCandidateHistoryStore>,
  tokenId: string,
  milestoneMarketCapUsd: number,
  crossingPrice: number,
): void {
  const separator = tokenId.indexOf(":");
  const chain = tokenId.slice(0, separator);
  const tokenAddress = tokenId.slice(separator + 1);
  history.saveHistoricalToken({ tokenId, chain, tokenAddress, symbol: tokenAddress, imageUrl: null, firstTradeAt: 500, firstReached1mAt: 2_000, peakMarketCapUsd: 1_500_000, source: "fixture", sourceQueryId: null, provenance: {} });
  history.saveMilestoneCrossing({ milestoneId: `${tokenId}:${milestoneMarketCapUsd}`, tokenId, marketCapUsd: milestoneMarketCapUsd, crossedAt: 2_000, precision: "exact", source: "fixture", sourceEventIds: [`${tokenId}:crossing`], strategyVersion: "fixture" });
  database.prepare(`
    INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
    VALUES (?, ?, 1000, 1, 'fixture'), (?, ?, 2000, ?, 'fixture')
  `).run(chain, tokenAddress, chain, tokenAddress, crossingPrice);
}

function insertBuy(
  database: DatabaseSync,
  eventId: string,
  traderId: string,
  tokenId: string,
  amountUsd: number,
  sourceStatus: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN",
  occurredAt: number,
): void {
  const separator = tokenId.indexOf(":");
  database.prepare(`
    INSERT INTO canonical_trader_events(
      canonical_event_id, entity_id, chain, token_address, side,
      amount_usd, occurred_at, source_status, updated_at
    ) VALUES (?, ?, ?, ?, 'buy', ?, ?, ?, ?)
  `).run(eventId, traderId, tokenId.slice(0, separator), tokenId.slice(separator + 1), amountUsd, occurredAt, sourceStatus, occurredAt);
}

async function evaluateCandidate(worker: ReturnType<typeof createCandidateEvidenceWorker>, tokenId: string) {
  return worker.execute({ payload: JSON.stringify({ tokenId, evaluatedAt: NOW }), cursor: null } as never, new AbortController().signal);
}

function seedPartition(database: DatabaseSync, chain: HistoricalTokenPartition["chain"], weekStart: number, weekEnd: number): HistoricalTokenPartition {
  const partition = { partitionId: `${chain}:${weekStart}`, chain, weekStart, weekEnd, cursor: null } as const;
  database.prepare(`
    INSERT INTO historical_token_partitions(
      partition_id, chain, week_start, week_end, status, source_name, cursor,
      token_count, next_attempt_at, last_error, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, 0, NULL, 0, 0, NULL)
  `).run(partition.partitionId, chain, weekStart, weekEnd);
  return partition;
}

function miningJob(partition: HistoricalTokenPartition, cursor: string | null = null) {
  return {
    jobId: `job:${partition.partitionId}`,
    idempotencyKey: `partition:${partition.partitionId}`,
    lane: "token_mining",
    jobType: "historical_token_partition",
    subjectKey: partition.partitionId,
    priority: 10,
    status: "running",
    cursor,
    attemptCount: 1,
    nextAttemptAt: 0,
    leaseExpiresAt: null,
    payload: JSON.stringify(partition),
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  } as Parameters<ReturnType<typeof createTokenMiningWorker>["execute"]>[0];
}
