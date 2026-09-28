import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  createAutomationJobStore,
  createCandidateHistoryStore,
  createSourceLedgerStore,
  initializeCandidateHistorySchema,
  initializeSourceLedgerSchema,
  migrateAddressRadarDatabase,
} from "@address-radar/database";

import { createCandidateEvidenceWorker } from "../src/candidate-evidence-worker.js";
import { createCandidateSourceRecoveryPlanner } from "../src/candidate-source-recovery.js";

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

function addFomoIdentity(database: DatabaseSync, traderId: string, accountId: string, handle: string): void {
  database.prepare(`
    INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
    VALUES (?, ?, 1, 1)
  `).run(accountId, handle);
  database.prepare(`
    INSERT INTO entity_accounts(entity_id, account_id, confidence, source, first_observed_at, last_observed_at)
    VALUES (?, ?, 'confirmed', 'test', 1, 1)
  `).run(traderId, accountId);
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
  it("derives an estimated milestone from observed trader market cap", async () => {
    const { database, history, worker } = setup();
    addTrader(database, "trader-derived");
    database.prepare(`
      INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
      VALUES ('account-derived', 'derived', 1, 1)
    `).run();
    addBuy({ database, eventId: "buy-derived", traderId: "trader-derived", tokenId: "base:token-derived", amountUsd: 60 });
    database.prepare(`
      INSERT INTO trader_events(
        event_id, account_id, entity_id, chain, token_address, side,
        amount_usd, price_usd, market_cap_usd, token_age_ms,
        occurred_at, collected_at, source
      ) VALUES ('event-derived', 'account-derived', 'trader-derived', 'base', 'token-derived', 'buy', 60, 5, 300000, NULL, 200, 200, 'fomo_stream')
    `).run();
    database.prepare(`
      INSERT INTO market_observations(chain, token_address, observed_at, price_usd, source)
      VALUES ('base', 'token-derived', 100, 1, 'test'), ('base', 'token-derived', 200, 5, 'test')
    `).run();

    await expect(evaluate(worker, "base:token-derived")).resolves.toMatchObject({ status: "completed" });
    expect(history.evidenceForTrader("trader-derived")).toEqual([
      expect.objectContaining({ evidenceType: "market_cap_300k_5x" }),
    ]);
    expect(database.prepare(`
      SELECT precision, source
      FROM token_milestone_crossings
      WHERE token_id = 'base:token-derived' AND market_cap_usd = 300000
    `).get()).toEqual({ precision: "estimated", source: "trader_event_market_cap" });
    database.close();
  });

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
    await expect(evaluate(worker, "solana:token-a")).resolves.toMatchObject({
      outcome: { status: "no_output", producedCount: 0 },
    });

    expect(history.evidenceForTrader("fomo:trader-a")).toEqual([
      expect.objectContaining({ sourceEventIds: ["event-a:FOMO_AND_ONCHAIN"] }),
    ]);
    expect(history.admissionSnapshots("fomo:trader-a")).toHaveLength(2);
    database.close();
  });

  it("evaluates historical evidence at processing time and queues unresolved admitted traders", async () => {
    const { database, history, worker } = setup();
    database.prepare(`
      INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
      VALUES ('fomo:account-stale', 'suspended', 0, 0, 1, 1)
    `).run();
    addFomoIdentity(database, "fomo:account-stale", "account-stale", "stale-handle");
    addToken({ database, tokenId: "base:token-stale", milestoneMarketCapUsd: 300_000, crossingPrice: 5 });
    addBuy({ database, eventId: "event-stale", traderId: "fomo:account-stale", tokenId: "base:token-stale", amountUsd: 100 });

    await worker.execute({
      payload: JSON.stringify({ tokenId: "base:token-stale", evaluatedAt: 150 }),
      cursor: null,
    } as never, new AbortController().signal);

    expect(history.latestAdmissionSnapshot("fomo:account-stale")).toMatchObject({
      currentAdmission: true,
      status: "current_admitted",
      evaluatedAt: NOW,
    });
    expect(database.prepare("SELECT lifecycle FROM trader_entities WHERE entity_id = 'fomo:account-stale'").get())
      .toEqual({ lifecycle: "candidate" });
    expect(database.prepare("SELECT policy FROM trader_monitoring_policy WHERE trader_id = 'fomo:account-stale'").get())
      .toEqual({ policy: "lightweight" });
    expect(database.prepare("SELECT account_id AS accountId, status FROM identity_resolution_queue WHERE handle = 'stale-handle'").get())
      .toEqual({ accountId: "account-stale", status: "pending" });
    database.close();
  });

  it("promotes admitted traders with resolved wallets to realtime probation", async () => {
    const { database, worker } = setup();
    database.prepare(`
      INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
      VALUES ('fomo:account-wallet', 'suspended', 0, 0, 1, 1)
    `).run();
    addFomoIdentity(database, "fomo:account-wallet", "account-wallet", "wallet-handle");
    database.prepare(`
      INSERT INTO wallet_identities(account_id, chain_family, address, confidence, source, first_observed_at, last_observed_at)
      VALUES ('account-wallet', 'evm', '0xabc', 'confirmed', 'test', 1, 1)
    `).run();
    addToken({ database, tokenId: "bsc:token-wallet", milestoneMarketCapUsd: 300_000, crossingPrice: 5 });
    addBuy({ database, eventId: "event-wallet", traderId: "fomo:account-wallet", tokenId: "bsc:token-wallet", amountUsd: 100 });

    await evaluate(worker, "bsc:token-wallet");

    expect(database.prepare("SELECT lifecycle FROM trader_entities WHERE entity_id = 'fomo:account-wallet'").get())
      .toEqual({ lifecycle: "probation" });
    expect(database.prepare("SELECT policy FROM trader_monitoring_policy WHERE trader_id = 'fomo:account-wallet'").get())
      .toEqual({ policy: "realtime" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_resolution_queue WHERE handle = 'wallet-handle'").get())
      .toEqual({ count: 0 });
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

  it("blocks and schedules early-trade recovery when a milestone has no canonical buys", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    initializeSourceLedgerSchema(database);
    addToken({ database, tokenId: "base:token-empty", milestoneMarketCapUsd: 300_000, crossingPrice: 5 });
    const jobs = createAutomationJobStore(database);
    const recovery = createCandidateSourceRecoveryPlanner({
      ledger: createSourceLedgerStore(database),
      now: () => NOW,
    });
    const worker = createCandidateEvidenceWorker({ database, jobs, recovery, now: () => NOW });

    await expect(evaluate(worker, "base:token-empty")).resolves.toMatchObject({
      status: "waiting_source",
      sourceBlock: {
        reasonCode: "missing_early_trades",
        recoveryJobIds: ["recovery:milestone_early_buyers:base:token-empty"],
      },
    });
    database.close();
  });

  it("recovers chain identity from token id without historical token metadata", async () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    initializeCandidateHistorySchema(database);
    initializeSourceLedgerSchema(database);
    const jobs = createAutomationJobStore(database);
    const recovery = createCandidateSourceRecoveryPlanner({
      ledger: createSourceLedgerStore(database),
      now: () => NOW,
    });
    const worker = createCandidateEvidenceWorker({ database, jobs, recovery, now: () => NOW });

    await expect(evaluate(worker, "bsc:0xabc")).resolves.toMatchObject({
      status: "waiting_source",
      sourceBlock: {
        reasonCode: "missing_milestone",
        recoveryJobIds: [
          "recovery:market_enrichment:bsc:0xabc",
          "recovery:historical_research:bsc:0xabc",
        ],
      },
    });
    database.close();
  });
});
