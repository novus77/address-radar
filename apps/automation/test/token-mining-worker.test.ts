import { DatabaseSync } from "node:sqlite";

import {
  createAutomationJobStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
} from "@address-radar/database";
import { describe, expect, it } from "vitest";

import { createTokenMiningWorker } from "../src/token-mining-worker.js";
import type {
  HistoricalTokenPartition,
  HistoricalTokenSource,
} from "../src/token-source-adapters.js";

describe("historical token mining worker", () => {
  it("queues Fomo verification before buyer evidence and remains idempotent", async () => {
    const database = createDatabase();
    const partition = seedPartition(database, "bsc", 1_000, 2_000);
    const jobs = createAutomationJobStore(database);
    const source: HistoricalTokenSource = {
      name: "fixture",
      async discover() {
        return {
          status: "ready",
          tokens: [
            token("bsc", "0xABC", 1_500),
            token("bsc", "0xabc", 1_500),
          ],
          nextCursor: null,
        };
      },
    };
    const worker = createTokenMiningWorker({ database, jobs, source, now: () => 3_000 });
    const job = miningJob(partition);

    expect((await worker.execute(job, new AbortController().signal)).status).toBe("completed");
    expect((await worker.execute(job, new AbortController().signal)).status).toBe("completed");

    expect(count(database, "historical_tokens")).toBe(1);
    expect(database.prepare("SELECT status FROM historical_token_verifications").get())
      .toEqual({ status: "pending" });
    expect(database.prepare("SELECT status FROM historical_token_mining_jobs").get())
      .toEqual({ status: "verification_pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_jobs WHERE job_type = 'candidate_evidence'").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("continues confirmed tokens to evidence and checkpoints paginated sources", async () => {
    const database = createDatabase();
    const partition = seedPartition(database, "solana", 1_000, 2_000);
    database.prepare(`
      INSERT INTO historical_tokens(
        token_id, chain, token_address, symbol, image_url, first_trade_at,
        first_reached_1m_at, peak_market_cap_usd, source, source_query_id, provenance
      ) VALUES ('solana:MintOne', 'solana', 'MintOne', NULL, NULL, NULL,
                1500, 2000000, 'fixture', NULL, '[]')
    `).run();
    database.prepare(`
      UPDATE historical_token_verifications
      SET status = 'confirmed', exact_ca_match = 1, history_available = 1
      WHERE token_id = 'solana:MintOne'
    `).run();
    const jobs = createAutomationJobStore(database);
    const source: HistoricalTokenSource = {
      name: "fixture",
      async discover(_partition, cursor) {
        return cursor === null
          ? { status: "ready", tokens: [token("solana", "MintOne", 1_500)], nextCursor: "page-2" }
          : { status: "ready", tokens: [], nextCursor: null };
      },
    };
    const worker = createTokenMiningWorker({ database, jobs, source, now: () => 3_000 });

    const first = await worker.execute(miningJob(partition), new AbortController().signal);
    expect(first).toMatchObject({ status: "checkpoint", cursor: "page-2" });
    const second = await worker.execute(
      miningJob(partition, "page-2"),
      new AbortController().signal,
    );
    expect(second.status).toBe("completed");
    expect(database.prepare("SELECT status FROM historical_token_mining_jobs").get())
      .toEqual({ status: "evidence_pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM automation_jobs WHERE job_type = 'candidate_evidence'").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("waits for a missing source without changing another chain partition", async () => {
    const database = createDatabase();
    const waiting = seedPartition(database, "eth", 1_000, 2_000);
    const other = seedPartition(database, "base", 1_000, 2_000);
    const worker = createTokenMiningWorker({
      database,
      jobs: createAutomationJobStore(database),
      source: {
        name: "dune",
        async discover() {
          return { status: "waiting_source", reason: "dune_result_missing", retryAt: 9_000 };
        },
      },
      now: () => 3_000,
    });

    expect(await worker.execute(miningJob(waiting), new AbortController().signal))
      .toEqual({ status: "waiting_source", diagnostic: "dune_result_missing", retryAt: 9_000 });
    expect(database.prepare("SELECT status FROM historical_token_partitions WHERE partition_id = ?").get(waiting.partitionId))
      .toEqual({ status: "waiting_source" });
    expect(database.prepare("SELECT status FROM historical_token_partitions WHERE partition_id = ?").get(other.partitionId))
      .toEqual({ status: "pending" });
    database.close();
  });
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  migrateAddressRadarDatabase(database);
  initializeCandidateHistorySchema(database);
  return database;
}

function seedPartition(
  database: DatabaseSync,
  chain: HistoricalTokenPartition["chain"],
  weekStart: number,
  weekEnd: number,
): HistoricalTokenPartition {
  const partition: HistoricalTokenPartition = {
    partitionId: `${chain}:${weekStart}`,
    chain,
    weekStart,
    weekEnd,
    cursor: null,
  };
  database.prepare(`
    INSERT INTO historical_token_partitions(
      partition_id, chain, week_start, week_end, status, source_name, cursor,
      token_count, next_attempt_at, last_error, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, 0, NULL, 0, 0, NULL)
  `).run(partition.partitionId, chain, weekStart, weekEnd);
  return partition;
}

function token(chain: string, tokenAddress: string, reachedAt: number) {
  return {
    chain,
    tokenAddress,
    firstReached1mAt: reachedAt,
    peakMarketCapUsd: 2_000_000,
  };
}

function miningJob(partition: HistoricalTokenPartition, cursor: string | null = null) {
  return {
    jobId: `job:${partition.partitionId}`,
    idempotencyKey: `historical-token-partition:${partition.partitionId}`,
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

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
