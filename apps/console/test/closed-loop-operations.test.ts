import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAutomationOutcomeStore, createRecoveryFactLinkStore, createWalletCoverageStore, migrateAddressRadarDatabase, openAddressRadarDatabase } from "@address-radar/database";

import { createAddressConsoleApplication } from "../src/application.js";

const directories: string[] = [];
afterEach(() => { while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("closed-loop operations", () => {
  it("reconciles canonical stages, productive outcomes, recovery facts, and wallet coverage", () => {
    const directory = mkdtempSync(join(tmpdir(), "address-radar-closed-loop-"));
    directories.push(directory);
    const databasePath = join(directory, "radar.sqlite");
    const database = openAddressRadarDatabase(databasePath);
    migrateAddressRadarDatabase(database);
    const now = Date.now();
    database.prepare(`
      INSERT INTO token_observation_state(
        token_id, chain, token_address, first_observed_at, last_observed_at,
        identity_status, market_status, fomo_status, milestone_status, evidence_status,
        quarantined
      ) VALUES ('base:0xabc', 'base', '0xabc', ?, ?, 'resolved', 'resolved', 'confirmed', 'observed', 'qualified', 0)
    `).run(now - 1_000, now - 1_000);
    database.prepare(`
      INSERT INTO token_market_snapshots(snapshot_id, token_id, source, observed_at, payload, content_fingerprint)
      VALUES ('market-1', 'base:0xabc', 'test', ?, '{}', 'market-fingerprint')
    `).run(now - 900);
    database.prepare(`
      INSERT INTO token_milestone_crossings(milestone_id, token_id, market_cap_usd, crossed_at, precision, source, source_event_ids, strategy_version)
      VALUES ('milestone-1', 'base:0xabc', 100000, ?, 'exact', 'test', '[]', 'test-v1')
    `).run(now - 800);
    createAutomationOutcomeStore(database).record({ jobId: "candidate-1", jobType: "candidate_evidence", attempt: 1, outcome: "produced", inputCount: 1, producedCount: 1, createdAt: now - 500 });
    const facts = createRecoveryFactLinkStore(database);
    facts.ensure("recovery-1", "early_trades", "base:0xabc", now - 700);
    facts.satisfy("recovery-1", "early_trades", "base:0xabc", now - 600);
    createWalletCoverageStore(database).upsert({ identityId: "account-1", chain: "base", provider: "blockscout_wallet_base", status: "complete", cursor: "cursor", coverageStartAt: null, coverageEndAt: null, lastSuccessAt: now - 400, updatedAt: now - 400 });
    database.close();

    const application = createAddressConsoleApplication(databasePath);
    const response = application.handle("GET", "/api/v2/operations/closed-loop");
    expect(response).toMatchObject({
      status: 200,
      body: {
        stages: expect.arrayContaining([
          expect.objectContaining({ stage: "token_discovery", completed: 1, completed15m: 1 }),
          expect.objectContaining({ stage: "market_history", completed: 1 }),
          expect.objectContaining({ stage: "milestone_confirmation", completed: 1 }),
          expect.objectContaining({ stage: "early_trade_recovery", pending: 1, untracked: 1 }),
          expect.objectContaining({ stage: "candidate_evidence", completed15m: 1 }),
        ]),
        outcomes: { total24h: 1, productive24h: 1, productiveRate24h: 1 },
        recoveryClosure: { total: 1, satisfied: 1, rate: 1 },
        walletCoverage: [expect.objectContaining({ chain: "base", provider: "blockscout_wallet_base", status: "complete", count: 1 })],
        queue: expect.objectContaining({ runnable: 0, deferred: 0, blocked: 0 }),
      },
    });
    expect((response.body as { stages: unknown[] }).stages).toHaveLength(11);
    application.close();
  });
});
