import type { DatabaseSync } from "node:sqlite";

import type {
  CandidateEvidenceV3,
  HistoricalToken,
  PersistedCandidateAdmissionSnapshot,
  TokenMilestoneCrossing,
} from "@address-radar/domain";

import { withAddressRadarWriteTransaction } from "./connection.js";

const parseArray = (value: unknown): readonly string[] => {
  if (typeof value !== "string") return Object.freeze([]);
  try {
    const parsed = JSON.parse(value) as unknown;
    return Object.freeze(Array.isArray(parsed) ? parsed.filter(item => typeof item === "string") : []);
  } catch {
    return Object.freeze([]);
  }
};

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
};

export function initializeCandidateHistorySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS historical_tokens (
      token_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      symbol TEXT,
      image_url TEXT,
      first_trade_at INTEGER,
      first_reached_1m_at INTEGER NOT NULL,
      peak_market_cap_usd REAL NOT NULL,
      source TEXT NOT NULL,
      source_query_id TEXT,
      provenance TEXT NOT NULL,
      UNIQUE(chain, token_address)
    );
    CREATE INDEX IF NOT EXISTS historical_tokens_reached_1m ON historical_tokens(first_reached_1m_at, chain);

    CREATE TABLE IF NOT EXISTS historical_token_verifications (
      token_id TEXT PRIMARY KEY REFERENCES historical_tokens(token_id),
      provider TEXT NOT NULL DEFAULT 'fomo',
      status TEXT NOT NULL CHECK(status IN ('pending', 'queued', 'confirmed', 'not_found', 'mismatch', 'deferred', 'unsupported')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      consecutive_not_found INTEGER NOT NULL DEFAULT 0,
      exact_ca_match INTEGER,
      history_available INTEGER,
      provider_token_id TEXT,
      provider_url TEXT,
      last_error TEXT,
      last_checked_at INTEGER,
      next_retry_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS historical_token_verifications_claim
      ON historical_token_verifications(status, next_retry_at, updated_at);
    INSERT OR IGNORE INTO historical_token_verifications(token_id, status, updated_at)
    SELECT token_id,
      CASE WHEN LOWER(chain) IN ('solana', 'eth', 'ethereum', 'bsc', 'robinhood', 'base') THEN 'pending' ELSE 'unsupported' END,
      0
    FROM historical_tokens;
    CREATE TRIGGER IF NOT EXISTS historical_tokens_initialize_fomo_verification
    AFTER INSERT ON historical_tokens
    BEGIN
      INSERT OR IGNORE INTO historical_token_verifications(token_id, status, updated_at)
      VALUES (
        NEW.token_id,
        CASE WHEN LOWER(NEW.chain) IN ('solana', 'eth', 'ethereum', 'bsc', 'robinhood', 'base') THEN 'pending' ELSE 'unsupported' END,
        0
      );
    END;
    UPDATE historical_token_verifications
    SET status = 'pending', next_retry_at = 0, updated_at = 0
    WHERE status = 'unsupported'
      AND token_id IN (SELECT token_id FROM historical_tokens WHERE LOWER(chain) = 'base');

    CREATE TABLE IF NOT EXISTS token_milestone_crossings (
      milestone_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      market_cap_usd REAL NOT NULL,
      crossed_at INTEGER,
      precision TEXT NOT NULL CHECK(precision IN ('exact', 'estimated', 'unavailable')),
      source TEXT NOT NULL,
      source_event_ids TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      UNIQUE(token_id, market_cap_usd, strategy_version)
    );
    CREATE INDEX IF NOT EXISTS token_milestone_crossings_token ON token_milestone_crossings(token_id, market_cap_usd);

    CREATE TABLE IF NOT EXISTS candidate_evidence_v3 (
      evidence_id TEXT PRIMARY KEY,
      trader_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      evidence_type TEXT NOT NULL,
      admission_class TEXT NOT NULL CHECK(admission_class IN ('early', 'strong')),
      cumulative_buy_usd REAL NOT NULL,
      weighted_entry_market_cap_usd REAL NOT NULL,
      theoretical_opportunity REAL NOT NULL,
      capturable_multiple REAL,
      realized_multiple REAL,
      evidence_at INTEGER NOT NULL,
      source_event_ids TEXT NOT NULL,
      strategy_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS candidate_evidence_v3_trader ON candidate_evidence_v3(trader_id, evidence_at DESC);
    CREATE INDEX IF NOT EXISTS candidate_evidence_v3_token ON candidate_evidence_v3(token_id, evidence_at DESC);

    CREATE TABLE IF NOT EXISTS candidate_admission_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      trader_id TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      early_distinct_token_count INTEGER NOT NULL,
      strong_distinct_token_count INTEGER NOT NULL,
      historical_distinct_token_count INTEGER NOT NULL,
      current_admission INTEGER NOT NULL CHECK(current_admission IN (0, 1)),
      historical_capability INTEGER NOT NULL CHECK(historical_capability IN (0, 1)),
      status TEXT NOT NULL,
      reason_codes TEXT NOT NULL,
      strategy_version TEXT NOT NULL,
      evaluated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS candidate_admission_snapshots_latest ON candidate_admission_snapshots(trader_id, evaluated_at DESC);

    CREATE TABLE IF NOT EXISTS historical_re_evaluation_requests (
      request_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      requested_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS historical_re_evaluation_requests_claim
      ON historical_re_evaluation_requests(status, requested_at, request_id);
    CREATE INDEX IF NOT EXISTS historical_re_evaluation_requests_token
      ON historical_re_evaluation_requests(token_id, requested_at DESC);
  `);
}

export function createCandidateHistoryStore(database: DatabaseSync) {
  return Object.freeze({
    saveHistoricalToken(token: HistoricalToken): void {
      database.prepare(`
        INSERT INTO historical_tokens(
          token_id, chain, token_address, symbol, image_url, first_trade_at,
          first_reached_1m_at, peak_market_cap_usd, source, source_query_id, provenance
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          symbol = COALESCE(excluded.symbol, historical_tokens.symbol),
          image_url = COALESCE(excluded.image_url, historical_tokens.image_url),
          first_trade_at = COALESCE(historical_tokens.first_trade_at, excluded.first_trade_at),
          first_reached_1m_at = MIN(historical_tokens.first_reached_1m_at, excluded.first_reached_1m_at),
          peak_market_cap_usd = MAX(historical_tokens.peak_market_cap_usd, excluded.peak_market_cap_usd),
          source = excluded.source,
          source_query_id = excluded.source_query_id,
          provenance = excluded.provenance
      `).run(token.tokenId, token.chain, token.tokenAddress, token.symbol, token.imageUrl, token.firstTradeAt,
        token.firstReached1mAt, token.peakMarketCapUsd, token.source, token.sourceQueryId, JSON.stringify(token.provenance));
    },

    historicalToken(tokenId: string): HistoricalToken | null {
      const row = database.prepare("SELECT * FROM historical_tokens WHERE token_id = ?").get(tokenId) as Record<string, unknown> | undefined;
      return row ? Object.freeze({
        tokenId: row.token_id as string,
        chain: row.chain as string,
        tokenAddress: row.token_address as string,
        symbol: row.symbol as string | null,
        imageUrl: row.image_url as string | null,
        firstTradeAt: row.first_trade_at as number | null,
        firstReached1mAt: row.first_reached_1m_at as number,
        peakMarketCapUsd: row.peak_market_cap_usd as number,
        source: row.source as string,
        sourceQueryId: row.source_query_id as string | null,
        provenance: parseJson(row.provenance),
      }) : null;
    },

    confirmHistoricalTokenPresence(tokenId: string, observedAt: number): void {
      database.prepare(`
        UPDATE historical_token_verifications
        SET status = 'confirmed', consecutive_not_found = 0, exact_ca_match = 1,
          history_available = COALESCE(history_available, 0), last_error = CASE
            WHEN COALESCE(history_available, 0) = 1 THEN NULL
            ELSE 'fomo_history_pending'
          END,
          last_checked_at = ?, next_retry_at = 0, updated_at = ?
        WHERE token_id = ?
      `).run(observedAt, observedAt, tokenId);
    },

    saveMilestoneCrossing(crossing: TokenMilestoneCrossing): void {
      withAddressRadarWriteTransaction(database, () => {
        database.prepare(`
          INSERT OR IGNORE INTO token_milestone_crossings(
            milestone_id, token_id, market_cap_usd, crossed_at, precision, source,
            source_event_ids, strategy_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crossing.milestoneId, crossing.tokenId, crossing.marketCapUsd, crossing.crossedAt,
          crossing.precision, crossing.source, JSON.stringify(crossing.sourceEventIds), crossing.strategyVersion);
        const automationJobsAvailable = database.prepare(`
          SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'
        `).get();
        if (automationJobsAvailable) {
          const updatedAt = crossing.crossedAt ?? Date.now();
          database.prepare(`
            UPDATE automation_job_blocks SET resolved_at = ?, updated_at = ?
            WHERE resolved_at IS NULL AND job_id IN (
              SELECT job_id FROM automation_jobs
              WHERE job_type = 'candidate_evidence' AND subject_key = ?
                AND status IN ('blocked_source', 'waiting_source')
            )
          `).run(updatedAt, updatedAt, crossing.tokenId);
          database.prepare(`
            UPDATE automation_jobs
            SET status = 'pending', next_attempt_at = ?, last_error = NULL, updated_at = ?
            WHERE job_type = 'candidate_evidence' AND subject_key = ?
              AND status IN ('blocked_source', 'waiting_source')
          `).run(updatedAt, updatedAt, crossing.tokenId);
        }
      });
    },

    milestoneCrossings(tokenId: string): readonly TokenMilestoneCrossing[] {
      const rows = database.prepare("SELECT * FROM token_milestone_crossings WHERE token_id = ? ORDER BY market_cap_usd").all(tokenId) as Record<string, unknown>[];
      return Object.freeze(rows.map(row => Object.freeze({
        milestoneId: row.milestone_id as string,
        tokenId: row.token_id as string,
        marketCapUsd: row.market_cap_usd as number,
        crossedAt: row.crossed_at as number | null,
        precision: row.precision as TokenMilestoneCrossing["precision"],
        source: row.source as string,
        sourceEventIds: parseArray(row.source_event_ids),
        strategyVersion: row.strategy_version as string,
      })));
    },

    saveEvidence(evidence: CandidateEvidenceV3): void {
      database.prepare(`
        INSERT OR REPLACE INTO candidate_evidence_v3(
          evidence_id, trader_id, token_id, milestone_id, evidence_type, admission_class,
          cumulative_buy_usd, weighted_entry_market_cap_usd, theoretical_opportunity,
          capturable_multiple, realized_multiple, evidence_at, source_event_ids, strategy_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(evidence.evidenceId, evidence.traderId, evidence.tokenId, evidence.milestoneId,
        evidence.evidenceType, evidence.admissionClass, evidence.cumulativeBuyUsd,
        evidence.weightedEntryMarketCapUsd, evidence.theoreticalOpportunity,
        evidence.capturableMultiple, evidence.realizedMultiple, evidence.evidenceAt,
        JSON.stringify(evidence.sourceEventIds), evidence.strategyVersion);
    },

    evidenceForTrader(traderId: string): readonly CandidateEvidenceV3[] {
      const rows = database.prepare("SELECT * FROM candidate_evidence_v3 WHERE trader_id = ? ORDER BY evidence_at, evidence_id").all(traderId) as Record<string, unknown>[];
      return Object.freeze(rows.map(row => Object.freeze({
        evidenceId: row.evidence_id as string,
        traderId: row.trader_id as string,
        tokenId: row.token_id as string,
        milestoneId: row.milestone_id as string,
        evidenceType: row.evidence_type as string,
        admissionClass: row.admission_class as CandidateEvidenceV3["admissionClass"],
        cumulativeBuyUsd: row.cumulative_buy_usd as number,
        weightedEntryMarketCapUsd: row.weighted_entry_market_cap_usd as number,
        theoreticalOpportunity: row.theoretical_opportunity as number,
        capturableMultiple: row.capturable_multiple as number | null,
        realizedMultiple: row.realized_multiple as number | null,
        evidenceAt: row.evidence_at as number,
        sourceEventIds: parseArray(row.source_event_ids),
        strategyVersion: row.strategy_version as string,
      })));
    },

    saveAdmissionSnapshot(snapshot: PersistedCandidateAdmissionSnapshot): void {
      database.prepare(`
        INSERT OR IGNORE INTO candidate_admission_snapshots(
          snapshot_id, trader_id, window_start, window_end, early_distinct_token_count,
          strong_distinct_token_count, historical_distinct_token_count, current_admission,
          historical_capability, status, reason_codes, strategy_version, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.snapshotId, snapshot.traderId, snapshot.windowStart, snapshot.windowEnd,
        snapshot.earlyDistinctTokenCount, snapshot.strongDistinctTokenCount,
        snapshot.historicalDistinctTokenCount, snapshot.currentAdmission ? 1 : 0,
        snapshot.historicalCapability ? 1 : 0, snapshot.status, JSON.stringify(snapshot.reasonCodes),
        snapshot.strategyVersion, snapshot.evaluatedAt);
    },

    admissionSnapshots(traderId: string): readonly PersistedCandidateAdmissionSnapshot[] {
      const rows = database.prepare("SELECT * FROM candidate_admission_snapshots WHERE trader_id = ? ORDER BY evaluated_at, snapshot_id").all(traderId) as Record<string, unknown>[];
      return Object.freeze(rows.map(row => Object.freeze({
        snapshotId: row.snapshot_id as string,
        traderId: row.trader_id as string,
        windowStart: row.window_start as number,
        windowEnd: row.window_end as number,
        earlyDistinctTokenCount: row.early_distinct_token_count as number,
        strongDistinctTokenCount: row.strong_distinct_token_count as number,
        historicalDistinctTokenCount: row.historical_distinct_token_count as number,
        currentAdmission: row.current_admission === 1,
        historicalCapability: row.historical_capability === 1,
        status: row.status as string,
        reasonCodes: parseArray(row.reason_codes),
        strategyVersion: row.strategy_version as string,
        evaluatedAt: row.evaluated_at as number,
      })));
    },

    latestAdmissionSnapshot(traderId: string): PersistedCandidateAdmissionSnapshot | null {
      const snapshots = this.admissionSnapshots(traderId);
      return snapshots.at(-1) ?? null;
    },
  });
}

export type CandidateHistoryStore = ReturnType<typeof createCandidateHistoryStore>;
