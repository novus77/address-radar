import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import {
  openAddressRadarDatabase,
  withAddressRadarWriteTransaction,
} from "../src/index.js";

describe("write transaction retry", () => {
  it("reuses an existing write transaction without nesting", () => {
    const database = openAddressRadarDatabase(":memory:");
    database.exec("CREATE TABLE values_table(value TEXT PRIMARY KEY)");
    withAddressRadarWriteTransaction(database, () => {
      withAddressRadarWriteTransaction(database, () => {
        database.prepare("INSERT INTO values_table(value) VALUES ('nested')").run();
      });
    });
    expect(database.prepare("SELECT value FROM values_table").get()).toEqual({ value: "nested" });
    database.close();
  });

  it("retries a real lock conflict without losing an event or advancing only the checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-write-retry-"));
    const databasePath = join(directory, "radar.sqlite");
    const setup = openAddressRadarDatabase(databasePath);
    setup.exec(`
      CREATE TABLE observations(event_id TEXT PRIMARY KEY);
      CREATE TABLE checkpoints(scope TEXT PRIMARY KEY, cursor TEXT NOT NULL);
      INSERT INTO checkpoints(scope, cursor) VALUES ('wallet', 'previous');
    `);
    setup.close();

    const lockHolder = new Worker(`
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const database = new DatabaseSync(workerData);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        database.exec("COMMIT");
        database.close();
        parentPort.postMessage("released");
      }, 120);
    `, { eval: true, workerData: databasePath });
    await once(lockHolder, "message");

    const database = openAddressRadarDatabase(databasePath);
    database.exec("PRAGMA busy_timeout = 1");
    const startedAt = Date.now();
    withAddressRadarWriteTransaction(database, () => {
      database.prepare("INSERT INTO observations(event_id) VALUES ('event-1')").run();
      database.prepare("UPDATE checkpoints SET cursor = 'next' WHERE scope = 'wallet'").run();
    }, { maximumAttempts: 50, baseDelayMs: 5, maximumDelayMs: 20 });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(50);
    expect(database.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT cursor FROM checkpoints WHERE scope = 'wallet'").get())
      .toEqual({ cursor: "next" });
    database.close();
    await once(lockHolder, "exit");
  });
});
