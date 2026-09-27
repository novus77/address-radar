import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createCandidateHistoryStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
} from "@address-radar/database";

import { createCandidateEvidenceWorker } from "../src/candidate-evidence-worker.js";

const NOW = 10_000;

function setup() {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  initializeCandidateHistorySchema(database);
  const history = createCandidateHistoryStore(database);
  const worker = createCandidateEvidenceWorker({ database, now: () => NOW });
  return { database, history, worker };
}

function addTrader(database: DatabaseSync, traderId: string): void {
  database.prepare(`
    INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
    VALUES (?, 'candidate', 0, 0, 1, 1)
  `).run(traderId);
}

function addToken(input: {
  readonly database: DatabaseSync;
  readonly tokenId: string;
  readonly milestoneMarketCapUsd: number;
  readonly crossingPrice: number;
}): void {
  const [chain, tokenAddress] = input.tokenId.split(":");
  const history = createCandidateHistoryStore(input.database);
  history.saveHistoricalToken({
    tokenId: input.tokenId,
    chain: chain!,
    tokenAddress: tokenAddress!,
    symbol: tokenAddress!.toUpperCase(),
    imageUrl: null,
    firstTradeAt: 50,
    firstReached1mAt: 200,
    peakMarketCapUsd: 1_500_000,
    source: "test",
    sourceQueryId: null,
    provenance: {},
  });
  history.saveMilestoneCrossing({
    milestoneId: `${input.tokenId}:${input.milestoneMarketCapUsd}`,
    tokenId: input.tokenId,
    marketCapUsd: input.milestoneMarketCapUsd,
    crossedAt: 200,
    precision: "exact",
    source: "test",
    sourceEventIds: [`${input.tokenId}:crossing`],
    strategyVersion: "candidate-history-v3",
  });
  input.database.prepare(`
    INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
    VALUES (?, ?, 100, 1, 'test'), (?, ?, 200, ?, 'test')
  `).run(chain!, tokenAddress!, chain!, tokenAddress!, input.crossingPrice);
}

function addBuy(input: {
  readonly database: DatabaseSync;
  readonly eventId: string;
  readonly traderId: string;
  readonly tokenId: string;
  readonly amountUsd: number;
  readonly sourceStatus?: "FOMO_ONLY" | "ONCHAIN_ONLY" | "FOMO_AND_ONCHAIN";
}): void {
  const [chain, tokenAddress] = input.tokenId.split(":");
  input.database.prepare(`
    INSERT INTO canonical_trader_events(
      canonical_event_id, entity_id, chain, token_address, side,
      amount_usd, occurred_at, source_status, updated_at
    ) VALUES (?, ?, ?, ?, 'buy', ?, 100, ?, 150)
  `).run(input.eventId, input.traderId, chain!, tokenAddress!, input.amountUsd, input.sourceStatus ?? "FOMO_ONLY");
}

async function evaluate(worker: ReturnType<typeof createCandidateEvidenceWorker>, tokenId: string) {
  return worker.execute({
    payload: JSON.stringify({ tokenId, evaluatedAt: NOW }),
    cursor: null,
  } as never, new AbortController().signal);
}

describe("candidate evidence worker", () => {
  it("admits FOMO-only strong evidence without wallet identity and upgrades it in place", async () => {
    const { database, history, worker } = setup();
    addTrader(database, "fomo:trader-a");
    addToken({ database, tokenId: "solana:token-a", milestoneMarketCapUsd: 300_000, crossingPrice: 5 });
    addBuy({ database, eventId: "event-a", traderId: "fomo:trader-a", tokenId: "solana:token-a", amountUsd: 60 });

    await evaluate(worker, "solana:token-a");
    expect(history.evidenceForTrader("fomo:trader-a")).toEqual([
      expect.objectContaining({ evidenceType: "market_cap_300k_5x", sourceEventIds: ["event-a:FOMO_ONLY"] }),
    ]);
    expect(history.latestAdmissionSnapshot("fomo:trader-a")).toMatchObject({
      currentAdmission: true,
      reasonCodes: ["strong_evidence_in_30d"],
    });

    database.prepare(`
      UPDATE canonical_trader_events
      SET source_status = 'FOMO_AND_ONCHAIN', updated_at = 300
      WHERE canonical_event_id = 'event-a'
    `).run();
    await evaluate(worker, "solana:token-a");
    await evaluate(worker, "solana:token-a");

    expect(history.evidenceForTrader("fomo:trader-a")).toEqual([
      expect.objectContaining({ sourceEventIds: ["event-a:FOMO_AND_ONCHAIN"] }),
    ]);
    expect(history.admissionSnapshots("fomo:trader-a")).toHaveLength(2);
    database.close();
  });

  it("admits two early evidence items from two distinct tokens", async () => {
    const { database, history, worker } = setup();
    addTrader(database, "trader-early");
    addToken({ database, tokenId: "base:token-a", milestoneMarketCapUsd: 100_000, crossingPrice: 3 });
    addToken({ database, tokenId: "bsc:token-b", milestoneMarketCapUsd: 200_000, crossingPrice: 3 });
    addBuy({ database, eventId: "event-a", traderId: "trader-early", tokenId: "base:token-a", amountUsd: 60 });
    addBuy({ database, eventId: "event-b", traderId: "trader-early", tokenId: "bsc:token-b", amountUsd: 80 });

    await evaluate(worker, "base:token-a");
    await evaluate(worker, "bsc:token-b");

    expect(history.latestAdmissionSnapshot("trader-early")).toMatchObject({
      currentAdmission: true,
      earlyDistinctTokenCount: 2,
      reasonCodes: ["two_early_tokens_in_30d"],
    });
    database.close();
  });

  it("does not admit repeated buys of one early token", async () => {
    const { database, history, worker } = setup();
    addTrader(database, "trader-repeat");
    addToken({ database, tokenId: "eth:token-a", milestoneMarketCapUsd: 100_000, crossingPrice: 3 });
    addBuy({ database, eventId: "event-a", traderId: "trader-repeat", tokenId: "eth:token-a", amountUsd: 30 });
    addBuy({ database, eventId: "event-b", traderId: "trader-repeat", tokenId: "eth:token-a", amountUsd: 30 });

    await evaluate(worker, "eth:token-a");

    expect(history.evidenceForTrader("trader-repeat")).toHaveLength(1);
    expect(history.latestAdmissionSnapshot("trader-repeat")).toMatchObject({
      currentAdmission: false,
      earlyDistinctTokenCount: 1,
      status: "awaiting_second_early_token",
    });
    database.close();
  });

  it("ignores cumulative buys below $50 and keeps replay idempotent", async () => {
    const { database, history, worker } = setup();
    addTrader(database, "trader-small");
    addToken({ database, tokenId: "robinhood:token-a", milestoneMarketCapUsd: 500_000, crossingPrice: 10 });
    addBuy({ database, eventId: "event-small", traderId: "trader-small", tokenId: "robinhood:token-a", amountUsd: 49 });

    await evaluate(worker, "robinhood:token-a");
    await evaluate(worker, "robinhood:token-a");

    expect(history.evidenceForTrader("trader-small")).toEqual([]);
    expect(history.admissionSnapshots("trader-small")).toHaveLength(1);
    expect(history.latestAdmissionSnapshot("trader-small")).toMatchObject({ status: "no_evidence" });
    database.close();
  });
});
