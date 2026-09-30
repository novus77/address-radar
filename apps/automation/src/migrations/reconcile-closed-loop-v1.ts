import type { DatabaseSync } from "node:sqlite";

import {
  createAutomationJobStore,
  createRecoveryFactLinkStore,
  createSourceLedgerStore,
  createTokenFactStore,
  createWalletCoverageStore,
  withAddressRadarWriteTransaction,
} from "@address-radar/database";

import { createEarlyTradeReconciler } from "../early-trade-reconciler.js";
import { migrateManualIdentityAutomationJobs } from "./manual-identity-job-cleanup.js";

export interface ClosedLoopReconciliationSummary {
  readonly dryRun: boolean;
  readonly examinedObservations: number;
  readonly fingerprintRevisions: number;
  readonly recoveryFactLinksEnsured: number;
  readonly recoveryFactLinksSatisfied: number;
  readonly manualIdentityJobsReclassified: number;
  readonly earlyTradeObservationsExamined: number;
  readonly canonicalEventsInserted: number;
  readonly earlyTradeFactsProduced: number;
  readonly walletCoverageInitialized: number;
  readonly downstreamJobsWoken: number;
  readonly hasMore: boolean;
  readonly cursor: string | null;
}

interface ObservationCursorRow {
  readonly observationId: string;
  readonly collectedAt: number;
  readonly fingerprintVersion: number;
}

const RECOVERY_FACT_TYPES = Object.freeze<Readonly<Record<string, string>>>({
  fomo_token_history: "fomo_presence",
  market_enrichment: "market_identity",
  market_history: "price_history",
  milestone_early_buyers: "early_trades",
  historical_research: "milestone_crossings",
  rpc_gap: "price_history",
});

const BLOCK_REASON_FACT_TYPES = Object.freeze<Readonly<Record<string, string>>>({
  missing_token_identity: "token_identity",
  missing_market_history: "price_history",
  missing_milestone: "milestone_crossings",
  missing_early_trades: "early_trades",
  insufficient_coverage: "early_trades",
});

export function initializeClosedLoopReconciliationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS closed_loop_reconciliation_state (
      reconciliation_id TEXT PRIMARY KEY,
      cursor_collected_at INTEGER NOT NULL,
      cursor_observation_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    INSERT OR IGNORE INTO closed_loop_reconciliation_state(
      reconciliation_id, cursor_collected_at, cursor_observation_id, updated_at, completed_at
    ) VALUES ('closed-loop-v1', 0, '', 0, NULL);
  `);
}

export function reconcileClosedLoopV1(input: {
  readonly database: DatabaseSync;
  readonly dryRun?: boolean;
  readonly batchSize?: number;
  readonly now?: () => number;
}): ClosedLoopReconciliationSummary {
  const dryRun = input.dryRun ?? true;
  const batchSize = input.batchSize ?? 250;
  const now = input.now ?? Date.now;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 5_000) {
    throw new Error("batchSize must be a positive safe integer no greater than 5000");
  }
  initializeClosedLoopReconciliationSchema(input.database);
  const state = input.database.prepare(`
    SELECT cursor_collected_at AS collectedAt, cursor_observation_id AS observationId
    FROM closed_loop_reconciliation_state WHERE reconciliation_id='closed-loop-v1'
  `).get() as { collectedAt: number; observationId: string };
  const observations = input.database.prepare(`
    SELECT observation_id AS observationId, collected_at AS collectedAt,
      fingerprint_version AS fingerprintVersion
    FROM source_observations
    WHERE collected_at > ? OR (collected_at = ? AND observation_id > ?)
    ORDER BY collected_at, observation_id LIMIT ?
  `).all(state.collectedAt, state.collectedAt, state.observationId, batchSize) as unknown as ObservationCursorRow[];
  const recoveryJobs = input.database.prepare(`
    SELECT job_id AS jobId, job_type AS jobType, subject_key AS subjectKey, status
    FROM recovery_jobs WHERE job_type != 'identity_resolution'
    ORDER BY created_at, job_id LIMIT ?
  `).all(batchSize) as Array<{ jobId: string; jobType: string; subjectKey: string; status: string }>;
  const legacyManualJobs = Number((input.database.prepare(`
    SELECT COUNT(*) AS count FROM automation_jobs
    WHERE job_type='identity_resolution'
      AND status IN ('pending','leased','running','waiting_source','blocked_source','retryable')
  `).get() as { count: number }).count);
  const coverageCandidates = resolvedWalletCoverageCandidates(input.database);
  const wakeableJobs = wakeableCandidateJobs(input.database);

  if (dryRun) {
    const last = observations.at(-1);
    return Object.freeze({
      dryRun: true,
      examinedObservations: observations.length,
      fingerprintRevisions: observations.filter(row => row.fingerprintVersion < 3).length,
      recoveryFactLinksEnsured: recoveryJobs.filter(job => RECOVERY_FACT_TYPES[job.jobType]).length,
      recoveryFactLinksSatisfied: recoveryJobs.filter(job => job.status === "completed" && recoveryFactExists(input.database, job.subjectKey, RECOVERY_FACT_TYPES[job.jobType] ?? "")).length,
      manualIdentityJobsReclassified: legacyManualJobs,
      earlyTradeObservationsExamined: observations.length,
      canonicalEventsInserted: 0,
      earlyTradeFactsProduced: 0,
      walletCoverageInitialized: coverageCandidates.length,
      downstreamJobsWoken: wakeableJobs.length,
      hasMore: observations.length === batchSize,
      cursor: last ? `${last.collectedAt}:${last.observationId}` : null,
    });
  }

  return withAddressRadarWriteTransaction(input.database, () => {
    const sourceLedger = createSourceLedgerStore(input.database);
    const factLinks = createRecoveryFactLinkStore(input.database);
    const facts = createTokenFactStore(input.database);
    const jobs = createAutomationJobStore(input.database);
    const coverage = createWalletCoverageStore(input.database);
    let fingerprintRevisions = 0;
    let recoveryFactLinksEnsured = 0;
    let recoveryFactLinksSatisfied = 0;
    let walletCoverageInitialized = 0;
    let downstreamJobsWoken = 0;

    for (const row of observations) {
      const observation = sourceLedger.observation(row.observationId);
      if (!observation) continue;
      sourceLedger.saveObservation(observation);
      if (row.fingerprintVersion < 3) fingerprintRevisions += 1;
    }

    for (const job of recoveryJobs) {
      const factType = RECOVERY_FACT_TYPES[job.jobType];
      if (!factType) continue;
      factLinks.ensure(job.jobId, factType, job.subjectKey, now());
      recoveryFactLinksEnsured += 1;
      if (job.status === "completed" && recoveryFactExists(input.database, job.subjectKey, factType)) {
        factLinks.satisfy(job.jobId, factType, job.subjectKey, now());
        recoveryFactLinksSatisfied += 1;
      }
    }

    for (const candidate of coverageCandidates) {
      if (coverage.get(candidate.identityId, candidate.chain, "reconciliation_unassigned")) continue;
      coverage.upsert({
        identityId: candidate.identityId,
        chain: candidate.chain,
        provider: "reconciliation_unassigned",
        status: "pending",
        cursor: null,
        coverageStartAt: null,
        coverageEndAt: null,
        lastSuccessAt: null,
        diagnostic: { code: "provider_assignment_pending", source: "closed-loop-v1" },
        updatedAt: now(),
      });
      walletCoverageInitialized += 1;
    }

    for (const blocked of wakeableJobs) {
      downstreamJobsWoken += jobs.wakeBlockedSource(blocked.subjectKey, now(), "candidate_evidence");
    }

    const earlyTrades = createEarlyTradeReconciler({
      database: input.database,
      jobs,
      facts,
      now,
      batchSize,
    }).runOnce();
    const manualIdentityJobsReclassified = migrateManualIdentityAutomationJobs(input.database, now());
    const last = observations.at(-1);
    if (last) input.database.prepare(`
      UPDATE closed_loop_reconciliation_state
      SET cursor_collected_at=?, cursor_observation_id=?, updated_at=?, completed_at=?
      WHERE reconciliation_id='closed-loop-v1'
    `).run(
      last.collectedAt,
      last.observationId,
      now(),
      observations.length < batchSize ? now() : null,
    );
    return Object.freeze({
      dryRun: false,
      examinedObservations: observations.length,
      fingerprintRevisions,
      recoveryFactLinksEnsured,
      recoveryFactLinksSatisfied,
      manualIdentityJobsReclassified,
      earlyTradeObservationsExamined: earlyTrades.examined,
      canonicalEventsInserted: earlyTrades.canonicalEventsInserted,
      earlyTradeFactsProduced: earlyTrades.earlyTradeFactsProduced,
      walletCoverageInitialized,
      downstreamJobsWoken,
      hasMore: observations.length === batchSize || earlyTrades.hasMore,
      cursor: last ? `${last.collectedAt}:${last.observationId}` : null,
    });
  });
}

function recoveryFactExists(database: DatabaseSync, factKey: string, factType: string): boolean {
  if (!factType) return false;
  return Boolean(database.prepare(`
    SELECT 1 AS present FROM token_fact_status
    WHERE token_id=? AND fact_type=? AND status IN ('available','partial','degraded')
  `).get(factKey, factType));
}

function resolvedWalletCoverageCandidates(database: DatabaseSync): Array<{ readonly identityId: string; readonly chain: string }> {
  const wallets = database.prepare(`
    SELECT account_id AS identityId, chain_family AS chainFamily FROM wallet_identities
    UNION SELECT entity_id AS identityId, chain_family AS chainFamily FROM entity_wallet_identities
  `).all() as Array<{ identityId: string; chainFamily: "evm" | "solana" }>;
  const candidates = wallets.flatMap(wallet => wallet.chainFamily === "solana"
    ? [{ identityId: wallet.identityId, chain: "solana" }]
    : ["eth", "bsc", "base", "robinhood"].map(chain => ({ identityId: wallet.identityId, chain })));
  return [...new Map(candidates.map(candidate => [`${candidate.identityId}:${candidate.chain}`, candidate])).values()];
}

function wakeableCandidateJobs(database: DatabaseSync): Array<{ readonly subjectKey: string }> {
  const rows = database.prepare(`
    SELECT DISTINCT j.subject_key AS subjectKey, b.reason_code AS reasonCode
    FROM automation_jobs j
    JOIN automation_job_blocks b ON b.job_id=j.job_id AND b.resolved_at IS NULL
    WHERE j.job_type='candidate_evidence' AND j.status='blocked_source'
      AND b.reason_code != 'missing_wallet_mapping'
  `).all() as Array<{ subjectKey: string; reasonCode: string }>;
  return rows.filter(row => recoveryFactExists(database, row.subjectKey, BLOCK_REASON_FACT_TYPES[row.reasonCode] ?? ""));
}
