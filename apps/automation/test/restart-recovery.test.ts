import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAutomationJobStore,
  initializeCandidateHistorySchema,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";

import { createAutomationScheduler } from "../src/scheduler.js";
import { createTokenMiningWorker } from "../src/token-mining-worker.js";
import type { HistoricalTokenSource } from "../src/token-source-adapters.js";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("automation restart recovery", () => {
  it("resumes token mining from page two after the process restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-restart-"));
    directories.push(directory);
    const path = join(directory, "radar.sqlite");
    const firstDatabase = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(firstDatabase);
    initializeCandidateHistorySchema(firstDatabase);
    firstDatabase.exec(`
      INSERT INTO historical_token_partitions(
        partition_id, chain, week_start, week_end, status, source_name, cursor,
        token_count, next_attempt_at, last_error, created_at, updated_at, completed_at
      ) VALUES ('base:week-1', 'base', 1, 2, 'pending', NULL, NULL, 0, 0, NULL, 0, 0, NULL)
    `);
    const firstStore = createAutomationJobStore(firstDatabase);
    firstStore.enqueue({
      jobId: "partition-job",
      idempotencyKey: "partition:base:week-1",
      lane: "token_mining",
      jobType: "historical_token_partition",
      subjectKey: "base:week-1",
      priority: 10,
      cursor: null,
      nextAttemptAt: 0,
      payload: JSON.stringify({ partitionId: "base:week-1", chain: "base", weekStart: 1, weekEnd: 2, cursor: null }),
      createdAt: 0,
    });
    const firstSource: HistoricalTokenSource = {
      name: "fixture",
      async discover(_partition, cursor) {
        expect(cursor).toBeNull();
        return { status: "ready", tokens: [], nextCursor: "page-2" };
      },
    };
    const firstScheduler = createAutomationScheduler({
      enabled: true,
      store: firstStore,
      handlers: [createTokenMiningWorker({ database: firstDatabase, jobs: firstStore, source: firstSource, now: () => 10 })],
      workerId: "worker-before-restart",
      now: () => 10,
    });
    await expect(firstScheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({ status: "checkpoint" });
    expect(firstStore.job("partition-job")).toMatchObject({ cursor: "page-2" });
    firstDatabase.close();

    const resumedCursors: Array<string | null> = [];
    const resumedDatabase = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(resumedDatabase);
    const resumedStore = createAutomationJobStore(resumedDatabase);
    const resumedSource: HistoricalTokenSource = {
      name: "fixture",
      async discover(_partition, cursor) {
        resumedCursors.push(cursor);
        return { status: "ready", tokens: [], nextCursor: null };
      },
    };
    const resumedScheduler = createAutomationScheduler({
      enabled: true,
      store: resumedStore,
      handlers: [createTokenMiningWorker({ database: resumedDatabase, jobs: resumedStore, source: resumedSource, now: () => 20 })],
      workerId: "worker-after-restart",
      now: () => 20,
    });
    await expect(resumedScheduler.runOnce(new AbortController().signal)).resolves.toMatchObject({ status: "completed" });
    expect(resumedCursors).toEqual(["page-2"]);
    expect(resumedStore.job("partition-job")).toMatchObject({ status: "completed", cursor: "page-2" });
    resumedDatabase.close();
  });
});

