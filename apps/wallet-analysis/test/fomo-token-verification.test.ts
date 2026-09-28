import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FomoTokenLookupProducer, FomoTokenLookupResultConsumer } from "@address-radar/collectors";
import { createCandidateHistoryStore, initializeCandidateHistorySchema } from "@address-radar/database";
import { createFomoHistoricalVerificationService } from "../src/fomo-token-verification.js";

describe("FOMO historical verification", () => {
  let database: DatabaseSync | undefined;
  let directory: string | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("queues a confirmed token again when full history is still unavailable", async () => {
    database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    store.saveHistoricalToken({
      tokenId: "base:0xtoken",
      chain: "base",
      tokenAddress: "0xToken",
      symbol: "TOK",
      imageUrl: null,
      firstTradeAt: 1,
      firstReached1mAt: 2,
      peakMarketCapUsd: 1_100_000,
      source: "fomo_realtime_dexscreener",
      sourceQueryId: null,
      provenance: {},
    });
    store.confirmHistoricalTokenPresence("base:0xtoken", 3);
    directory = mkdtempSync(join(tmpdir(), "address-radar-fomo-verification-"));
    const producer = new FomoTokenLookupProducer({ filePath: join(directory, "lookups.jsonl") });
    const enqueue = vi.spyOn(producer, "enqueue");
    const service = createFomoHistoricalVerificationService({
      database,
      producer,
      consumer: new FomoTokenLookupResultConsumer({ filePath: join(directory, "results.jsonl"), cursorPath: join(directory, "cursor.json") }),
      now: () => 4,
    });

    await expect(service.runOnce()).resolves.toEqual({ processed: true, action: "queued" });
    expect(enqueue).toHaveBeenCalledWith({ chainId: "base", tokenAddress: "0xToken", requestedAt: 4 });
  });

  it("stops producing lookups when the active queue reaches its cap", async () => {
    database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    for (const address of ["0xactive", "0xwaiting"]) store.saveHistoricalToken({
      tokenId: `base:${address}`,
      chain: "base",
      tokenAddress: address,
      symbol: "TOK",
      imageUrl: null,
      firstTradeAt: 1,
      firstReached1mAt: 2,
      peakMarketCapUsd: 1_100_000,
      source: "test",
      sourceQueryId: null,
      provenance: {},
    });
    database.prepare("UPDATE historical_token_verifications SET status = 'queued', next_retry_at = 10000 WHERE token_id = 'base:0xactive'").run();
    directory = mkdtempSync(join(tmpdir(), "address-radar-fomo-verification-"));
    const producer = new FomoTokenLookupProducer({ filePath: join(directory, "lookups.jsonl") });
    const enqueue = vi.spyOn(producer, "enqueue");
    const service = createFomoHistoricalVerificationService({
      database,
      producer,
      consumer: new FomoTokenLookupResultConsumer({ filePath: join(directory, "results.jsonl"), cursorPath: join(directory, "cursor.json") }),
      maximumActiveLookups: 1,
      now: () => 100,
    });

    await expect(service.runOnce()).resolves.toEqual({ processed: false, action: "idle" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("uses progressively longer retry leases for repeated lookups", async () => {
    database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    createCandidateHistoryStore(database).saveHistoricalToken({
      tokenId: "base:0xretry",
      chain: "base",
      tokenAddress: "0xretry",
      symbol: "TOK",
      imageUrl: null,
      firstTradeAt: 1,
      firstReached1mAt: 2,
      peakMarketCapUsd: 1_100_000,
      source: "test",
      sourceQueryId: null,
      provenance: {},
    });
    directory = mkdtempSync(join(tmpdir(), "address-radar-fomo-verification-"));
    let timestamp = 1_000;
    const service = createFomoHistoricalVerificationService({
      database,
      producer: new FomoTokenLookupProducer({ filePath: join(directory, "lookups.jsonl") }),
      consumer: new FomoTokenLookupResultConsumer({ filePath: join(directory, "results.jsonl"), cursorPath: join(directory, "cursor.json") }),
      now: () => timestamp,
    });

    await service.runOnce();
    expect(database.prepare("SELECT next_retry_at AS nextRetryAt FROM historical_token_verifications WHERE token_id = 'base:0xretry'").get()).toEqual({ nextRetryAt: timestamp + 30 * 60_000 });
    timestamp += 30 * 60_000;
    await service.runOnce();
    expect(database.prepare("SELECT next_retry_at AS nextRetryAt FROM historical_token_verifications WHERE token_id = 'base:0xretry'").get()).toEqual({ nextRetryAt: timestamp + 2 * 60 * 60_000 });
  });

  it("recovers expired queued lookups and persists the active lookup identity", async () => {
    database = new DatabaseSync(":memory:");
    initializeCandidateHistorySchema(database);
    const store = createCandidateHistoryStore(database);
    for (const address of ["0xold-a", "0xold-b"]) store.saveHistoricalToken({
      tokenId: `base:${address}`,
      chain: "base",
      tokenAddress: address,
      symbol: "TOK",
      imageUrl: null,
      firstTradeAt: 1,
      firstReached1mAt: 2,
      peakMarketCapUsd: 1_100_000,
      source: "test",
      sourceQueryId: null,
      provenance: {},
    });
    database.prepare("UPDATE historical_token_verifications SET status = 'queued', next_retry_at = 50, updated_at = 10").run();
    directory = mkdtempSync(join(tmpdir(), "address-radar-fomo-verification-"));
    const service = createFomoHistoricalVerificationService({
      database,
      producer: new FomoTokenLookupProducer({ filePath: join(directory, "lookups.jsonl") }),
      consumer: new FomoTokenLookupResultConsumer({ filePath: join(directory, "results.jsonl"), cursorPath: join(directory, "cursor.json") }),
      maximumActiveLookups: 1,
      now: () => 100,
    });

    await expect(service.runOnce()).resolves.toEqual({ processed: true, action: "queued" });

    const rows = database.prepare("SELECT status, last_lookup_id AS lookupId, queued_at AS queuedAt, last_error AS lastError FROM historical_token_verifications ORDER BY token_id").all() as Array<Record<string, unknown>>;
    expect(rows.filter(row => row.status === "queued")).toEqual([
      expect.objectContaining({ lookupId: expect.any(String), queuedAt: 100, lastError: null }),
    ]);
    expect(rows.filter(row => row.status === "deferred")).toEqual([
      expect.objectContaining({ lookupId: null, queuedAt: null, lastError: "fomo_result_timeout" }),
    ]);
  });
});
