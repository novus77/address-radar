import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";
import { afterEach, describe, expect, it } from "vitest";

import { createAddressConsoleApplication } from "../src/application.js";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("automation funnel", () => {
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
