import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { initializeSourceLedgerSchema } from "@address-radar/database";
import { createLocalMilestoneProvider } from "../src/local-milestone-provider.js";

describe("local milestone provider", () => {
  it("reconstructs first observed threshold crossings from durable market snapshots", async () => {
    const database = new DatabaseSync(":memory:");
    initializeSourceLedgerSchema(database);
    const insert = database.prepare(`
      INSERT INTO token_market_snapshots(
        snapshot_id, token_id, source, observed_at, price_usd,
        market_cap_usd, liquidity_usd, payload, content_fingerprint
      ) VALUES (?, 'base:0xabc', 'test', ?, 1, ?, 10000, '{}', ?)
    `);
    insert.run("one", 100, 90_000, "one");
    insert.run("two", 200, 320_000, "two");
    insert.run("three", 300, 1_200_000, "three");

    const provider = createLocalMilestoneProvider({ database });
    await expect(provider.reconstruct({ chain: "base", tokenAddress: "0xABC", fromTimestamp: 0, toTimestamp: 400 }))
      .resolves.toMatchObject({
        status: "available",
        candleCount: 3,
        milestones: [
          { thresholdUsd: 100_000, crossedAt: 200, source: "local_market_snapshot" },
          { thresholdUsd: 200_000, crossedAt: 200, source: "local_market_snapshot" },
          { thresholdUsd: 300_000, crossedAt: 200, source: "local_market_snapshot" },
          { thresholdUsd: 500_000, crossedAt: 300, source: "local_market_snapshot" },
          { thresholdUsd: 1_000_000, crossedAt: 300, source: "local_market_snapshot" },
        ],
      });
    database.close();
  });
});
