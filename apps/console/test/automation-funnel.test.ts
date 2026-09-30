import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAutomationJobStore,
  createSourceLedgerStore,
  migrateAddressRadarDatabase,
  openAddressRadarDatabase,
} from "@address-radar/database";
import { afterEach, describe, expect, it } from "vitest";

import { createAddressConsoleApplication } from "../src/application.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("automation funnel", () => {
  it("counts completed candidate evaluations even when they produce no evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-candidate-progress-"));
    directories.push(directory);
    const databasePath = join(directory, "radar.sqlite");
    const database = openAddressRadarDatabase(databasePath);
    migrateAddressRadarDatabase(database);
    const now = Date.now();
    database
      .prepare(
        `INSERT INTO automation_job_outcomes (
           job_id, job_type, attempt, outcome, reason_code,
           input_count, produced_count, deferred_count, diagnostic_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "candidate-no-output",
        "candidate_evidence",
        1,
        "no_output",
        "evidence_below_threshold",
        1,
        0,
        0,
        "{}",
        now,
      );
    database.close();
    const application = createAddressConsoleApplication(databasePath);

    const response = application.handle("GET", "/api/v2/operations/closed-loop");
    const body = response.body as {
      stages: Array<{ stage: string; completed15m: number; lastProgressAt: string | null }>;
    };
    const stage = body.stages.find((item) => item.stage === "candidate_evidence");

    expect(response.status).toBe(200);
    expect(stage).toMatchObject({ completed15m: 1 });
    expect(stage?.lastProgressAt).not.toBeNull();
    application.close();
  });

  it("reports automated repair and manual identity backlogs separately", () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-queue-separation-"));
    directories.push(directory);
    const databasePath = join(directory, "radar.sqlite");
    const database = openAddressRadarDatabase(databasePath);
    migrateAddressRadarDatabase(database);
    database.prepare(`
      INSERT INTO automation_jobs(
        job_id, idempotency_key, lane, job_type, subject_key, priority,
        status, cursor, attempt_count, next_attempt_at, lease_expires_at,
        lease_owner, payload, last_error, created_at, updated_at, completed_at
      ) VALUES ('repair-1', 'repair-1', 'repair', 'market_enrichment', 'base:0xabc', 1,
        'pending', NULL, 0, 0, NULL, NULL, '{}', NULL, 1, 1, NULL)
    `).run();
    database.prepare(`
      INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
      VALUES ('manual-account', 'manual-user', 1, 1)
    `).run();
    database.prepare(`
      INSERT INTO identity_resolution_queue(
        handle, account_id, priority, reasons, status, first_seen_at,
        last_seen_at, next_export_at, last_batch_id, resolved_at
      ) VALUES ('manual-user', 'manual-account', 1, '[]', 'pending', 1, 1, 1, NULL, NULL)
    `).run();
    database.close();

    const application = createAddressConsoleApplication(databasePath);
    expect(application.handle("GET", "/api/v2/automation/overview")).toMatchObject({
      status: 200,
      body: { queue: { backlog: 1, automatedRepairBacklog: 1, manualIdentityBacklog: 1 } },
    });
    application.close();
  });

  it("reports stable source block reasons and recovery queue progress", () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-source-recovery-"));
    directories.push(directory);
    const databasePath = join(directory, "radar.sqlite");
    const database = openAddressRadarDatabase(databasePath);
    migrateAddressRadarDatabase(database);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue({ jobId: "candidate-1", idempotencyKey: "candidate-1", lane: "trader_backfill", jobType: "candidate_evidence", subjectKey: "base:0xabc", priority: 10, cursor: null, nextAttemptAt: 0, payload: "{}", createdAt: 1 });
    jobs.claim("trader_backfill", 2, 100, "worker");
    jobs.waitForSource("candidate-1", "worker", { diagnostic: "token milestone data is not available", reasonCode: "missing_milestone", context: { tokenId: "base:0xabc" }, recoveryJobIds: ["recovery:historical_research:base:0xabc"], retryAt: 3, updatedAt: 2 });
    createSourceLedgerStore(database).enqueueRecoveryJob({ jobId: "recovery:historical_research:base:0xabc", jobType: "historical_research", chain: "base", subjectKey: "base:0xabc", priority: 60, cursor: null, nextAttemptAt: 2, createdAt: 2 });
    database.close();

    const application = createAddressConsoleApplication(databasePath);
    expect(application.handle("GET", "/api/v2/automation/overview")).toMatchObject({
      status: 200,
      body: {
        queue: {
          blockedReasons: [{ reasonCode: "missing_milestone", count: 1, oldestBlockedAt: 2 }],
          recoveryJobProgress: [{ jobType: "historical_research", status: "pending", count: 1, lastUpdatedAt: 2 }],
          blockedToWoken: 0,
        },
      },
    });
    application.close();
  });

  it("reports account, wallet, monitoring, backfill, and evidence states separately", () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-automation-funnel-"));
    directories.push(directory);
    const databasePath = join(directory, "radar.sqlite");
    const database = openAddressRadarDatabase(databasePath);
    migrateAddressRadarDatabase(database);
    database.exec("PRAGMA foreign_keys = OFF");

    const insertTrader = database.prepare(`
      INSERT INTO trader_entities(
        entity_id, lifecycle, manual, locked, created_at, updated_at
      ) VALUES (?, 'candidate', 0, 0, 1, 1)
    `);
    const insertAccount = database.prepare(`
      INSERT INTO fomo_accounts(account_id, handle, first_seen_at, last_seen_at)
      VALUES (?, ?, 1, 1)
    `);
    const linkAccount = database.prepare(`
      INSERT INTO entity_accounts(
        entity_id, account_id, confidence, source, first_observed_at, last_observed_at
      ) VALUES (?, ?, 'confirmed', 'test', 1, 1)
    `);
    for (let index = 0; index < 10; index += 1) {
      insertTrader.run(`trader-${index}`);
      if (index < 8) {
        insertAccount.run(`account-${index}`, `handle-${index}`);
        linkAccount.run(`trader-${index}`, `account-${index}`);
      }
    }

    const insertWallet = database.prepare(`
      INSERT INTO entity_wallet_identities(
        entity_id, chain_family, address, confidence, source,
        first_observed_at, last_observed_at
      ) VALUES (?, ?, ?, 'confirmed', 'test', 1, 1)
    `);
    insertWallet.run("trader-0", "solana", "Wallet0");
    insertWallet.run("trader-1", "evm", "0x0000000000000000000000000000000000000001");
    insertWallet.run("trader-2", "evm", "0x0000000000000000000000000000000000000002");

    database.exec(`
      INSERT INTO trader_monitoring_policy(trader_id, policy, updated_at) VALUES
        ('trader-0', 'realtime', 1),
        ('trader-1', 'periodic', 1),
        ('trader-2', 'off', 1),
        ('trader-3', 'off', 1),
        ('trader-4', 'off', 1),
        ('trader-5', 'off', 1),
        ('trader-6', 'off', 1),
        ('trader-7', 'off', 1),
        ('trader-8', 'off', 1),
        ('trader-9', 'off', 1);

      INSERT INTO automation_jobs(
        job_id, idempotency_key, lane, job_type, subject_key, priority,
        status, cursor, attempt_count, next_attempt_at, lease_expires_at,
        lease_owner, payload, last_error, created_at, updated_at, completed_at
      ) VALUES
        ('backfill-0', 'backfill:0', 'trader_backfill', 'initial_wallet_backfill', 'trader-0', 10,
          'completed', NULL, 1, 0, NULL, NULL, '{}', NULL, 1, 1, 1),
        ('backfill-1', 'backfill:1', 'trader_backfill', 'initial_wallet_backfill', 'trader-1', 10,
          'pending', NULL, 0, 0, NULL, NULL, '{}', NULL, 1, 1, NULL);
    `);
    database.prepare(`
      INSERT INTO candidate_evidence_v3(
        evidence_id, trader_id, token_id, milestone_id, evidence_type,
        admission_class, cumulative_buy_usd, weighted_entry_market_cap_usd,
        theoretical_opportunity, capturable_multiple, realized_multiple,
        evidence_at, source_event_ids, strategy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "evidence-0",
      "trader-3",
      "solana:Token0",
      "milestone-0",
      "market_cap_500k_10x",
      "strong",
      100,
      100_000,
      10,
      8,
      null,
      1,
      "[]",
      "test-v1",
    );
    database.close();

    const application = createAddressConsoleApplication(databasePath);
    expect(application.handle("GET", "/api/v2/automation/overview")).toMatchObject({
      status: 200,
      body: {
        updatedAt: expect.any(Number),
        funnel: {
          observedFomoHandles: 8,
          canonicalTraders: 10,
          walletResolvedTraders: 3,
          monitoringEligibleTraders: 2,
          initialBackfillQueued: 2,
          initialBackfillCompleted: 1,
          periodicCoverageCurrent: 0,
          candidateEvidenceTraders: 1,
          admittedTraders: 0,
        },
      },
    });
    application.close();
  });
});
