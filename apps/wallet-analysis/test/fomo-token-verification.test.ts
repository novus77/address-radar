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
});
