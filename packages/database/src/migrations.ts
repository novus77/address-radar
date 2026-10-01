import type { DatabaseSync } from "node:sqlite";
import { initializeExecutionRevisionSchema } from "./execution-revision-store.js";
import { initializeEventProjectionExecutionSchema } from "./event-projection-execution-store.js";
import { decodePersistedRadarSignal } from "@address-radar/signal-engine";

import { initializeAddressRadarSchema } from "./schema.js";
import { initializeCandidateHistorySchema } from "./candidate-history-store.js";
import { initializeSourceLedgerSchema } from "./source-ledger-store.js";
import { ADDRESS_RADAR_BUSY_TIMEOUT_MS, withAddressRadarWriteTransaction } from "./connection.js";
import { initializeTokenFactSchema } from "./token-fact-store.js";
import { initializeCanonicalRegistrySchema } from "./canonical-registry-store.js";
import { materializeLegacyWalletIdentities } from "./identity-automation.js";
import { initializeAutomationOutcomeSchema } from "./automation-outcome-store.js";
import { initializeRecoveryFactLinkSchema } from "./recovery-fact-link-store.js";
import { initializeSourceEnrichmentSchema } from "./source-enrichment-store.js";
import { initializeWalletCoverageSchema } from "./wallet-coverage-store.js";
import { initializeCandidateEvaluationRequestSchema } from "./candidate-evaluation-request-store.js";

export interface AddressRadarMigrationOptions {
  readonly force?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export function migrateAddressRadarDatabase(
  database: DatabaseSync,
  options: AddressRadarMigrationOptions = {},
): void {
  const environment = options.environment ?? process.env;
  if (!options.force && environment.ADDRESS_RADAR_RUNTIME_MIGRATIONS === "false") return;
  database.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${ADDRESS_RADAR_BUSY_TIMEOUT_MS};`);
  withAddressRadarWriteTransaction(database, () => {
    initializeAddressRadarSchema(database);
    migrateActiveWalletAnalysisUniqueness(database);
    initializeCandidateHistorySchema(database);
    ensureColumn(database, "historical_token_verifications", "last_lookup_id", "TEXT");
    ensureColumn(database, "historical_token_verifications", "queued_at", "INTEGER");
    ensureColumn(database, "historical_token_verifications", "result_received_at", "INTEGER");
    initializeSourceLedgerSchema(database);
    initializeTokenFactSchema(database);
    initializeCanonicalRegistrySchema(database);
    initializeAutomationOutcomeSchema(database);
    initializeRecoveryFactLinkSchema(database);
    initializeSourceEnrichmentSchema(database);
    initializeWalletCoverageSchema(database);
    initializeCandidateEvaluationRequestSchema(database);
    initializeExecutionRevisionSchema(database);
    initializeEventProjectionExecutionSchema(database);
    ensureColumn(database, "wallet_monitor_observations", "source_block_number", "INTEGER");
    ensureColumn(database, "wallet_monitor_observations", "source_block_hash", "TEXT");
    ensureColumn(database, "wallet_monitor_observations", "orphaned_at", "INTEGER");
    ensureColumn(database, "wallet_monitor_observations", "projected_at", "INTEGER");
    backfillLegacyTokenFacts(database);
    migrateAutomationJobStatusConstraint(database);
    migrateWaitingSourceJobs(database);
    backfillTraderAutomationState(database);
    materializeLegacyWalletIdentities(database);
    ensureColumn(database, "signal_outbox", "claim_token", "TEXT");
    ensureColumn(database, "signal_outbox", "claim_generation", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(database, "signal_outbox", "lease_expires_at", "INTEGER");
    ensureColumn(database, "signal_outbox_migration_review", "decision", "TEXT CHECK(decision IN ('approved', 'skipped'))");
    ensureColumn(database, "signal_outbox_migration_review", "decided_by", "TEXT");
    ensureColumn(database, "signal_outbox_migration_review", "decision_reason", "TEXT");
    ensureColumn(database, "signal_outbox_migration_review", "decided_at", "INTEGER");
    ensureColumn(database, "token_evaluation_state", "bundle_diagnostics", "TEXT NOT NULL DEFAULT '{}'");
    migrateEntityAccountUniqueness(database);
    database.exec(`
      UPDATE signal_outbox_migration_review
      SET decision = 'approved', decided_by = 'legacy_migration', decision_reason = 'previously approved', decided_at = reviewed_at
      WHERE status = 'approved' AND decision IS NULL;
    `);
    database.exec(`
      INSERT OR IGNORE INTO economic_evidence_consumption(dedupe_key, broadcast_id, consumed_at)
      SELECT COALESCE(e.dedupe_key, ec.event_id), ec.broadcast_id, ec.consumed_at
      FROM evidence_consumption ec
      LEFT JOIN address_signal_evidence e ON e.event_id = ec.event_id;
    `);
    migrateHistoricalBroadcasts(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS address_radar_schema_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version TEXT NOT NULL,
        migrated_at INTEGER NOT NULL
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO address_radar_schema_state(singleton, schema_version, migrated_at)
      VALUES (1, '2026-09-28-write-stability-v1', ?)
      ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        migrated_at = excluded.migrated_at
    `).run(Date.now());
  }, { maximumAttempts: 20, baseDelayMs: 25, maximumDelayMs: 1_000 });
}

function migrateActiveWalletAnalysisUniqueness(database: DatabaseSync): void {
  const now = Date.now();
  database.prepare(`
    UPDATE wallet_analysis_jobs
    SET status = 'failed', last_error = 'superseded_duplicate', updated_at = ?
    WHERE analysis_id IN (
      SELECT analysis_id
      FROM (
        SELECT analysis_id,
          ROW_NUMBER() OVER (
            PARTITION BY chain_family, address, requested_sample_count
            ORDER BY
              CASE
                WHEN status = 'review_required' THEN 0
                WHEN analysis_id LIKE 'initial-wallet-backfill:%' THEN 1
                ELSE 2
              END,
              updated_at DESC,
              analysis_id
          ) AS duplicate_rank
        FROM wallet_analysis_jobs
        WHERE status IN ('collecting', 'review_required')
      ) ranked
      WHERE duplicate_rank > 1
    )
  `).run(now);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS wallet_analysis_jobs_one_active
    ON wallet_analysis_jobs(chain_family, address, requested_sample_count)
    WHERE status IN ('collecting', 'review_required');
  `);
}

function backfillLegacyTokenFacts(database: DatabaseSync): void {
  const version = "legacy-fact-projection-v1";
  const insert = (selectSql: string, factType: string): void => {
    database.exec(`
      INSERT OR IGNORE INTO token_fact_status(token_id, fact_type, status, strategy_version, updated_at)
      SELECT token_id, '${factType}', 'missing', '${version}', updated_at FROM (${selectSql});
    `);
  };
  const promote = (selectSql: string, factType: string, status: "available" | "partial"): void => {
    database.exec(`
      UPDATE token_fact_status
      SET status = '${status}',
        primary_source = COALESCE(primary_source, 'legacy_projection'),
        observed_at = COALESCE(observed_at, updated_at),
        known_at = COALESCE(known_at, updated_at),
        strategy_version = '${version}'
      WHERE fact_type = '${factType}' AND status IN ('missing', 'queued', 'collecting')
        AND token_id IN (SELECT token_id FROM (${selectSql}));
    `);
  };
  const historicalTokens = `
    SELECT token_id, COALESCE(first_trade_at, first_reached_1m_at, 0) AS updated_at
    FROM historical_tokens
  `;
  insert(historicalTokens, "token_identity");
  promote(historicalTokens, "token_identity", "available");

  const priceHistory = `
    SELECT LOWER(chain) || ':' || CASE WHEN LOWER(chain) = 'solana' THEN token_address ELSE LOWER(token_address) END AS token_id,
      MAX(observed_at) AS updated_at
    FROM market_observations GROUP BY LOWER(chain), token_address
  `;
  insert(priceHistory, "price_history");
  promote(priceHistory, "price_history", "partial");

  const exactMilestones = `
    SELECT token_id, MAX(crossed_at) AS updated_at FROM token_milestone_crossings
    WHERE precision = 'exact' GROUP BY token_id
  `;
  const partialMilestones = `
    SELECT token_id, MAX(crossed_at) AS updated_at FROM token_milestone_crossings
    WHERE precision != 'unavailable' GROUP BY token_id
  `;
  insert(partialMilestones, "milestone_crossings");
  promote(partialMilestones, "milestone_crossings", "partial");
  promote(exactMilestones, "milestone_crossings", "available");

  const candidateEvidence = `
    SELECT token_id, MAX(evidence_at) AS updated_at FROM candidate_evidence_v3 GROUP BY token_id
  `;
  insert(candidateEvidence, "candidate_evidence");
  promote(candidateEvidence, "candidate_evidence", "available");

  const abilityOutcomes = `
    SELECT LOWER(sample.chain) || ':' || CASE WHEN LOWER(sample.chain) = 'solana' THEN sample.token_address ELSE LOWER(sample.token_address) END AS token_id,
      MAX(outcome.computed_at) AS updated_at
    FROM trader_token_samples sample
    JOIN trader_token_outcomes outcome ON outcome.sample_id = sample.sample_id
    WHERE outcome.coverage_status = 'complete'
    GROUP BY LOWER(sample.chain), sample.token_address
  `;
  insert(abilityOutcomes, "ability_outcomes");
  promote(abilityOutcomes, "ability_outcomes", "available");
}

function migrateWaitingSourceJobs(database: DatabaseSync): void {
  database.exec(`
    UPDATE automation_jobs
    SET status = 'blocked_source', lease_expires_at = NULL, lease_owner = NULL
    WHERE status = 'waiting_source';
  `);
}

function migrateAutomationJobStatusConstraint(database: DatabaseSync): void {
  const definition = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'
  `).get() as { sql: string } | undefined;
  if (!definition || definition.sql.includes("'blocked_source'")) return;

  database.exec(`
    ALTER TABLE automation_jobs RENAME TO automation_jobs_legacy_status;
    DROP INDEX IF EXISTS automation_jobs_claim;
    DROP INDEX IF EXISTS automation_jobs_subject;
    CREATE TABLE automation_jobs (
      job_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane TEXT NOT NULL CHECK(lane IN ('trader_backfill', 'token_mining', 'repair')),
      job_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'running', 'waiting_source', 'blocked_source', 'retryable', 'completed', 'terminal', 'cancelled')),
      cursor TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      lease_owner TEXT,
      payload TEXT NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    INSERT INTO automation_jobs(
      job_id, idempotency_key, lane, job_type, subject_key, priority, status,
      cursor, attempt_count, next_attempt_at, lease_expires_at, lease_owner,
      payload, last_error, created_at, updated_at, completed_at
    )
    SELECT job_id, idempotency_key, lane, job_type, subject_key, priority, status,
      cursor, attempt_count, next_attempt_at, lease_expires_at, lease_owner,
      payload, last_error, created_at, updated_at, completed_at
    FROM automation_jobs_legacy_status;
    DROP TABLE automation_jobs_legacy_status;
    CREATE INDEX automation_jobs_claim
      ON automation_jobs(lane, status, next_attempt_at, priority, created_at);
    CREATE INDEX automation_jobs_subject
      ON automation_jobs(job_type, subject_key, status);
  `);
}

function backfillTraderAutomationState(database: DatabaseSync): void {
  database.exec(`
    INSERT OR IGNORE INTO trader_coverage_state(
      trader_id, tier, coverage_state, last_covered_at,
      next_evaluation_at, strategy_version, updated_at
    )
    SELECT e.entity_id,
      CASE
        WHEN e.manual = 1 OR EXISTS (
          SELECT 1
          FROM entity_accounts ea
          JOIN leaderboard_observations lo ON lo.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id AND lo.window = '30d'
        ) THEN 'T0'
        WHEN EXISTS (
          SELECT 1 FROM entity_wallet_identities ew WHERE ew.entity_id = e.entity_id
          UNION ALL
          SELECT 1
          FROM entity_accounts ea
          JOIN wallet_identities w ON w.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id
        ) THEN CASE WHEN EXISTS (
          SELECT 1 FROM candidate_evidence_v3 ce WHERE ce.trader_id = e.entity_id
        ) THEN 'T1' ELSE 'T2' END
        ELSE 'T3'
      END,
      'unseen', NULL, 0, 'trader-automation-v1', e.updated_at
    FROM trader_entities e;

    INSERT OR IGNORE INTO trader_monitoring_policy(trader_id, policy, updated_at)
    SELECT e.entity_id,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM entity_wallet_identities ew WHERE ew.entity_id = e.entity_id
          UNION ALL
          SELECT 1
          FROM entity_accounts ea
          JOIN wallet_identities w ON w.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id
        ) THEN 'realtime'
        WHEN e.manual = 1 OR EXISTS (
          SELECT 1
          FROM entity_accounts ea
          JOIN leaderboard_observations lo ON lo.account_id = ea.account_id
          WHERE ea.entity_id = e.entity_id AND lo.window = '30d'
        ) THEN 'periodic'
        ELSE 'lightweight'
      END,
      e.updated_at
    FROM trader_entities e;
  `);
}

function migrateEntityAccountUniqueness(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS entity_account_mapping_conflicts (
      conflict_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      canonical_entity_id TEXT NOT NULL,
      removed_entity_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const mappings = database.prepare(`
    SELECT entity_id AS entityId, account_id AS accountId, confidence, source,
      first_observed_at AS firstObservedAt, last_observed_at AS lastObservedAt
    FROM entity_accounts
    ORDER BY account_id,
      CASE confidence WHEN 'confirmed' THEN 0 ELSE 1 END,
      first_observed_at,
      entity_id
  `).all() as Array<{ entityId: string; accountId: string; confidence: string; source: string; firstObservedAt: number; lastObservedAt: number }>;
  const canonical = new Map<string, string>();
  const quarantine = database.prepare(`
    INSERT OR IGNORE INTO entity_account_mapping_conflicts(
      conflict_id, account_id, canonical_entity_id, removed_entity_id, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const remove = database.prepare("DELETE FROM entity_accounts WHERE entity_id = ? AND account_id = ?");
  for (const mapping of mappings) {
    const owner = canonical.get(mapping.accountId);
    if (!owner) { canonical.set(mapping.accountId, mapping.entityId); continue; }
    quarantine.run(
      `entity-account-migration:${mapping.accountId}:${mapping.entityId}`,
      mapping.accountId,
      owner,
      mapping.entityId,
      JSON.stringify({ confidence: mapping.confidence, source: mapping.source, firstObservedAt: mapping.firstObservedAt, lastObservedAt: mapping.lastObservedAt }),
      mapping.lastObservedAt,
    );
    remove.run(mapping.entityId, mapping.accountId);
  }
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS entity_accounts_account_unique ON entity_accounts(account_id)");
}

function ensureColumn(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateHistoricalBroadcasts(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT br.broadcast_id AS broadcastId, br.token_id AS tokenId, br.broadcast_number AS broadcastSequence,
      br.triggered_at AS triggeredAt, br.payload
    FROM broadcast_records br
    WHERE NOT EXISTS (SELECT 1 FROM signal_outbox o WHERE o.broadcast_id = br.broadcast_id)
      AND NOT EXISTS (SELECT 1 FROM signal_outbox_migration_review r WHERE r.broadcast_id = br.broadcast_id)
    ORDER BY br.triggered_at, br.broadcast_id
  `).all() as Array<{ broadcastId: string; tokenId: string; broadcastSequence: number; triggeredAt: number; payload: string }>;
  const insert = database.prepare(`
    INSERT INTO signal_outbox_migration_review(review_id, broadcast_id, token_id, broadcast_sequence, idempotency_key, payload, status, validation_status, reason, created_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  for (const row of rows) {
    try {
      const decoded = decodePersistedRadarSignal(row.payload);
      if (decoded.status === "replayed") {
        insert.run(`legacy-review:${row.broadcastId}`, row.broadcastId, row.tokenId, row.broadcastSequence, decoded.signal.idempotencyKey, JSON.stringify(decoded.signal), "legacy_review", "valid", "historical_delivery_unknown", row.triggeredAt);
      } else {
        insert.run(`legacy-review:${row.broadcastId}`, row.broadcastId, row.tokenId, row.broadcastSequence, decoded.idempotencyKey, row.payload, "dead_letter", "legacy_unreplayable", decoded.reason, row.triggeredAt);
      }
    } catch (error) {
      insert.run(`legacy-review:${row.broadcastId}`, row.broadcastId, row.tokenId, row.broadcastSequence, `legacy:${row.broadcastId}`, row.payload, "dead_letter", "invalid", error instanceof Error ? error.message : String(error), row.triggeredAt);
    }
  }
}
