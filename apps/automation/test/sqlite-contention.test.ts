import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
  withAddressRadarWriteTransaction,
} from "@address-radar/database";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("automation SQLite contention", () => {
  it("retries a real write lock and commits event plus checkpoint atomically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-contention-"));
    directories.push(directory);
    const path = join(directory, "radar.sqlite");
    const setup = openAddressRadarDatabase(path);
    migrateAddressRadarDatabase(setup);
    setup.exec(`
      INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at)
      VALUES ('trader-lock', 'candidate', 0, 0, 1, 1);
      INSERT INTO automation_jobs(
        job_id, idempotency_key, lane, job_type, subject_key, priority, status,
        cursor, attempt_count, next_attempt_at, lease_expires_at, lease_owner,
        payload, last_error, created_at, updated_at, completed_at
      ) VALUES ('lock-job', 'lock-job', 'trader_backfill', 'test', 'trader-lock', 1,
        'running', 'page-1', 1, 0, NULL, NULL, '{}', NULL, 1, 1, NULL);
    `);
    setup.close();

    const lockHolder = new Worker(`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => { database.exec("COMMIT"); database.close(); parentPort.postMessage("released"); }, 120);
    `, { eval: true, workerData: path });
    await once(lockHolder, "message");

    const database = openAddressRadarDatabase(path);
    database.exec("PRAGMA busy_timeout = 1");
    withAddressRadarWriteTransaction(database, () => {
      database.prepare(`
        INSERT INTO canonical_trader_events(
          canonical_event_id, entity_id, chain, token_address, side,
          amount_usd, occurred_at, source_status, updated_at
        ) VALUES ('event-lock', 'trader-lock', 'base', '0xabc', 'buy', 100, 10, 'FOMO_ONLY', 10)
      `).run();
      database.prepare("UPDATE automation_jobs SET cursor = 'page-2', updated_at = 10 WHERE job_id = 'lock-job'").run();
    }, { maximumAttempts: 50, baseDelayMs: 5, maximumDelayMs: 20 });

    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_trader_events WHERE canonical_event_id = 'event-lock'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT cursor FROM automation_jobs WHERE job_id = 'lock-job'").get()).toEqual({ cursor: "page-2" });
    database.close();
    await once(lockHolder, "exit");
  });
});

