import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";

import { createAddressConsoleApplication } from "../src/application.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "address-radar-automation-operations-"));
  directories.push(directory);
  const databasePath = join(directory, "radar.sqlite");
  const database = openAddressRadarDatabase(databasePath);
  migrateAddressRadarDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`
    INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES
      ('trader-retry', 'candidate', 0, 0, 1, 1),
      ('trader-complete', 'active', 0, 0, 1, 1),
      ('trader-active', 'candidate', 0, 0, 1, 1);
    INSERT INTO trader_coverage_state(trader_id, tier, coverage_state, last_covered_at, next_evaluation_at, strategy_version, updated_at) VALUES
      ('trader-retry', 'T1', 'degraded', NULL, 1, 'test', 1);
    INSERT INTO automation_jobs(
      job_id, idempotency_key, lane, job_type, subject_key, priority, status,
      cursor, attempt_count, next_attempt_at, lease_expires_at, lease_owner,
      payload, last_error, created_at, updated_at, completed_at
    ) VALUES
      ('job-retry', 'job:retry', 'trader_backfill', 'trader_backfill', 'trader-retry', 80, 'retryable', NULL, 2, 1, NULL, NULL, '{}', 'provider 429', 1, 1, NULL),
      ('job-complete', 'job:complete', 'trader_backfill', 'trader_backfill', 'trader-complete', 80, 'completed', NULL, 1, 1, NULL, NULL, '{}', NULL, 1, 1, 1),
      ('job-active', 'job:active', 'trader_backfill', 'trader_backfill', 'trader-active', 80, 'running', NULL, 1, 1, 9999999999999, 'worker', '{}', NULL, 1, 1, NULL);
    INSERT INTO historical_token_partitions(
      partition_id, chain, week_start, week_end, status, source_name, cursor,
      token_count, next_attempt_at, last_error, created_at, updated_at, completed_at
    ) VALUES ('partition-retry', 'base', 1, 2, 'retryable', 'dune', NULL, 3, 1, 'unavailable', 1, 1, NULL);
    INSERT INTO historical_token_mining_jobs(
      mining_job_id, partition_id, token_id, chain, token_address, status, created_at, updated_at
    ) VALUES ('mining-1', 'partition-retry', 'base:0xabc', 'base', '0xabc', 'evidence_pending', 1, 1);
  `);
  database.close();
  return { databasePath, application: createAddressConsoleApplication(databasePath) };
}

describe("automation operations console", () => {
  it("exposes automation, mining, and coverage read models with Chinese diagnostics", () => {
    const { application } = fixture();
    expect(application.handle("GET", "/api/v2/automation/overview")).toMatchObject({
      status: 200,
      body: { queue: { total: 3, backlog: 1, byStatus: { completed: 1, retryable: 1, running: 1 } } },
    });
    expect(application.handle("GET", "/api/v2/backfill/traders")).toMatchObject({
      status: 200,
      body: { total: 3, items: expect.arrayContaining([expect.objectContaining({ jobId: "job-retry", diagnosticZh: expect.stringContaining("限流") })]) },
    });
    expect(application.handle("GET", "/api/v2/backfill/traders/trader-retry")).toMatchObject({ status: 200 });
    expect(application.handle("GET", "/api/v2/mining/partitions")).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ partitionId: "partition-retry" })] } });
    expect(application.handle("GET", "/api/v2/mining/tokens")).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ tokenId: "base:0xabc" })] } });
    expect(application.handle("GET", "/api/v2/coverage/traders")).toMatchObject({ status: 200 });
    expect(application.handle("GET", "/api/v2/coverage/sources")).toMatchObject({
      status: 200,
      body: { telemetryDiagnosticZh: expect.stringContaining("尚未上报") },
    });
    application.close();
  });

  it("audits accepted retries and rejects completed or actively leased work", () => {
    const { databasePath, application } = fixture();
    expect(application.handle("POST", "/api/v2/backfill/traders/trader-retry/retry", { jobId: "job-retry" })).toMatchObject({ status: 202, body: { status: "pending" } });
    expect(application.handle("POST", "/api/v2/backfill/traders/trader-complete/retry", { jobId: "job-complete" })).toMatchObject({ status: 409 });
    expect(application.handle("POST", "/api/v2/backfill/traders/trader-active/retry", { jobId: "job-active" })).toMatchObject({ status: 409 });
    expect(application.handle("POST", "/api/v2/mining/partitions/partition-retry/retry")).toMatchObject({ status: 202, body: { status: "pending" } });
    application.close();

    const database = openAddressRadarDatabase(databasePath);
    const audits = database.prepare("SELECT action FROM operator_audit_log ORDER BY occurred_at, action").all() as Array<{ action: string }>;
    expect(audits.map(item => item.action).sort()).toEqual(["automation.partition_retry", "automation.trader_retry"]);
    expect(database.prepare("SELECT status FROM automation_jobs WHERE job_id = 'job-retry'").get()).toMatchObject({ status: "pending" });
    database.close();
  });
});

