import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createAutomationJobStore, createSourceLedgerStore, createTokenFactStore, migrateAddressRadarDatabase } from "@address-radar/database";
import { SOURCE_OBSERVATION_FINGERPRINT_VERSION } from "@address-radar/domain";

import { reconcileClosedLoopV1 } from "../src/migrations/reconcile-closed-loop-v1.js";

describe("closed-loop v1 reconciliation", () => {
  it("is bounded, idempotent, and only wakes jobs with canonical prerequisites", () => {
    const database = new DatabaseSync(":memory:");
    migrateAddressRadarDatabase(database);
    database.prepare("INSERT INTO trader_entities(entity_id, lifecycle, manual, locked, created_at, updated_at) VALUES ('trader-1', 'candidate', 0, 0, 1, 1)").run();
    database.prepare("INSERT INTO entity_wallet_identities(entity_id, chain_family, address, confidence, source, first_observed_at, last_observed_at) VALUES ('trader-1', 'evm', '0xabc', 'confirmed', 'test', 1, 1)").run();
    const source = createSourceLedgerStore(database);
    source.saveObservation({
      observationId: "observation-1",
      source: "fomo_feed",
      sourceEventId: "trade-1",
      chain: "base",
      observedAt: 100,
      collectedAt: 110,
      payloadVersion: 1,
      payload: { entityId: "trader-1", tokenAddress: "0xtoken", side: "buy", amountUsd: 100, occurredAt: 100 },
      confidence: 0.9,
      extractionMode: "network",
      provenance: { fixture: true },
    });
    database.prepare("UPDATE source_observations SET fingerprint_version=1, content_fingerprint='legacy' WHERE observation_id='observation-1'").run();
    database.prepare(`
      INSERT INTO token_milestone_crossings(milestone_id, token_id, market_cap_usd, crossed_at, precision, source, source_event_ids, strategy_version)
      VALUES ('milestone-1', 'base:0xtoken', 100000, 200, 'exact', 'test', '[]', 'test-v1')
    `).run();
    const facts = createTokenFactStore(database);
    facts.ensure("base:0xtoken", "milestone_crossings", "test-v1", 200);
    facts.transition({ tokenId: "base:0xtoken", factType: "milestone_crossings", status: "available", precision: "exact", primarySource: "test", coverageStartAt: 200, coverageEndAt: 200, observedAt: 200, knownAt: 200, nextAttemptAt: null, terminalReason: null, strategyVersion: "test-v1", updatedAt: 200 });
    source.enqueueRecoveryJob({ jobId: "recovery-1", jobType: "historical_research", chain: "base", subjectKey: "base:0xtoken", priority: 1, cursor: null, nextAttemptAt: 0, createdAt: 1 });
    source.completeRecoveryJob("recovery-1", 200);
    const jobs = createAutomationJobStore(database);
    jobs.enqueue({ jobId: "candidate-1", idempotencyKey: "candidate-1", lane: "trader_backfill", jobType: "candidate_evidence", subjectKey: "base:0xtoken", priority: 1, cursor: null, nextAttemptAt: 0, payload: "{}", createdAt: 1 });
    jobs.claim("trader_backfill", 2, 100, "worker");
    jobs.waitForSource("candidate-1", "worker", { diagnostic: "missing milestone", reasonCode: "missing_milestone", context: {}, recoveryJobIds: ["recovery-1"], retryAt: 3, updatedAt: 2 });
    jobs.enqueue({ jobId: "identity-1", idempotencyKey: "identity-1", lane: "repair", jobType: "identity_resolution", subjectKey: "handle-1", priority: 1, cursor: null, nextAttemptAt: 0, payload: "{}", createdAt: 1 });

    const dryRun = reconcileClosedLoopV1({ database, dryRun: true, batchSize: 10, now: () => 1_000 });
    expect(dryRun).toMatchObject({ fingerprintRevisions: 1, manualIdentityJobsReclassified: 1, walletCoverageInitialized: 4, downstreamJobsWoken: 1 });
    expect(database.prepare("SELECT fingerprint_version AS version FROM source_observations WHERE observation_id='observation-1'").get()).toEqual({ version: 1 });

    const first = reconcileClosedLoopV1({ database, dryRun: false, batchSize: 10, now: () => 1_000 });
    const second = reconcileClosedLoopV1({ database, dryRun: false, batchSize: 10, now: () => 2_000 });
    expect(first).toMatchObject({ fingerprintRevisions: 1, recoveryFactLinksSatisfied: 1, manualIdentityJobsReclassified: 1, canonicalEventsInserted: 1, walletCoverageInitialized: 4, downstreamJobsWoken: 1 });
    expect(second).toMatchObject({ fingerprintRevisions: 0, manualIdentityJobsReclassified: 0, canonicalEventsInserted: 0, walletCoverageInitialized: 0, downstreamJobsWoken: 0 });
    expect(database.prepare("SELECT fingerprint_version AS version FROM source_observations WHERE observation_id='observation-1'").get()).toEqual({ version: SOURCE_OBSERVATION_FINGERPRINT_VERSION });
    expect(database.prepare("SELECT COUNT(*) AS count FROM source_observation_enrichments WHERE observation_id='observation-1'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status FROM automation_jobs WHERE job_id='identity-1'").get()).toEqual({ status: "cancelled" });
    expect(database.prepare("SELECT status FROM automation_jobs WHERE job_id='candidate-1'").get()).toEqual({ status: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM wallet_chain_coverage WHERE identity_id='trader-1'").get()).toEqual({ count: 4 });
    database.close();
  });
});
