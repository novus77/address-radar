import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  DiscoveryChain,
  SourceHealthState,
  SourceId,
  SourceObservation,
  SourceObservationWriteResult,
} from "@address-radar/domain";
import {
  semanticSourceObservationFingerprint,
  SOURCE_OBSERVATION_FINGERPRINT_VERSION,
} from "@address-radar/domain";
import { withAddressRadarWriteTransaction } from "./connection.js";
import { initializeSourceEnrichmentSchema } from "./source-enrichment-store.js";

export type RecoveryJobType =
  | "rpc_gap"
  | "fomo_token_history"
  | "market_enrichment"
  | "market_history"
  | "identity_resolution"
  | "milestone_early_buyers"
  | "historical_research";

export type RecoveryJobStatus = "pending" | "running" | "failed" | "completed" | "dead_letter";

export interface SourceCursorRecord {
  readonly source: SourceId;
  readonly chain: DiscoveryChain;
  readonly cursor: string;
  readonly position: number;
  readonly updatedAt: number;
}

export interface SourceHealthRecord {
  readonly source: SourceId;
  readonly chain: DiscoveryChain;
  readonly state: SourceHealthState;
  readonly lastAttemptAt: number;
  readonly lastSuccessAt: number | null;
  readonly lastEventAt: number | null;
  readonly consecutiveFailures: number;
  readonly latencyMs: number | null;
  readonly rateLimitResetAt: number | null;
  readonly cursor: string | null;
  readonly lastErrorCode: string | null;
}

export interface RecoveryJobRecord {
  readonly jobId: string;
  readonly jobType: RecoveryJobType;
  readonly chain: DiscoveryChain;
  readonly subjectKey: string;
  readonly status: RecoveryJobStatus;
  readonly priority: number;
  readonly cursor: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseExpiresAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export type TokenDimensionStatus = "unknown" | "pending" | "resolved" | "confirmed" | "observed" | "qualified" | "failed";

export interface TokenObservationRecord {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly firstObservedAt: number;
  readonly lastObservedAt: number;
  readonly identityStatus: TokenDimensionStatus;
  readonly marketStatus: TokenDimensionStatus;
  readonly fomoStatus: TokenDimensionStatus;
  readonly milestoneStatus: TokenDimensionStatus;
  readonly evidenceStatus: TokenDimensionStatus;
  readonly milestoneObservedAt: number | null;
  readonly symbol: string | null;
  readonly imageUrl: string | null;
  readonly marketCapUsd: number | null;
  readonly launchedAt: number | null;
  readonly quarantined: boolean;
  readonly quarantineReason: string | null;
}

export interface TokenObservationPatch {
  readonly tokenId: string;
  readonly chain: string;
  readonly tokenAddress: string;
  readonly observedAt: number;
  readonly identityStatus?: TokenDimensionStatus;
  readonly marketStatus?: TokenDimensionStatus;
  readonly fomoStatus?: TokenDimensionStatus;
  readonly milestoneStatus?: TokenDimensionStatus;
  readonly evidenceStatus?: TokenDimensionStatus;
  readonly milestoneObservedAt?: number | null;
  readonly symbol?: string | null;
  readonly imageUrl?: string | null;
  readonly marketCapUsd?: number | null;
  readonly launchedAt?: number | null;
  readonly quarantined?: boolean;
  readonly quarantineReason?: string | null;
}

export interface TokenMarketSnapshotRecord {
  readonly snapshotId: string;
  readonly tokenId: string;
  readonly source: SourceId;
  readonly observedAt: number;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly payload: unknown;
}

export interface SourceLedgerStore {
  saveObservation(observation: SourceObservation): SourceObservationWriteResult;
  observation(observationId: string): SourceObservation | null;
  advanceCursor(cursor: SourceCursorRecord): boolean;
  sourceCursor(source: SourceId, chain: DiscoveryChain): SourceCursorRecord | null;
  saveSourceHealth(health: SourceHealthRecord): void;
  sourceHealth(source: SourceId, chain: DiscoveryChain): SourceHealthRecord | null;
  addBudgetUsage(provider: string, usageWindow: string, units: number, updatedAt: number): void;
  budgetUsage(provider: string, usageWindow: string): number;
  enqueueRecoveryJob(job: {
    readonly jobId: string;
    readonly jobType: RecoveryJobType;
    readonly chain: DiscoveryChain;
    readonly subjectKey: string;
    readonly priority: number;
    readonly cursor: string | null;
    readonly nextAttemptAt: number;
    readonly createdAt: number;
  }): { readonly inserted: boolean };
  claimRecoveryJob(now: number, leaseMs: number): RecoveryJobRecord | null;
  checkpointRecoveryJob(jobId: string, cursor: string, updatedAt: number): void;
  failRecoveryJob(jobId: string, error: string, nextAttemptAt: number, terminal?: boolean): void;
  completeRecoveryJob(jobId: string, completedAt: number): void;
  recoveryJob(jobId: string): RecoveryJobRecord | null;
  saveTokenObservation(patch: TokenObservationPatch): TokenObservationRecord;
  tokenObservation(tokenId: string): TokenObservationRecord | null;
  saveTokenMarketSnapshot(snapshot: TokenMarketSnapshotRecord): { readonly inserted: boolean };
  tokenMarketSnapshots(tokenId: string): readonly TokenMarketSnapshotRecord[];
}

export function initializeSourceLedgerSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS source_observations (
      observation_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      collected_at INTEGER NOT NULL,
      payload_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      confidence REAL NOT NULL,
      extraction_mode TEXT NOT NULL,
      provenance TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      fingerprint_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(source, source_event_id, payload_version)
    );
    CREATE INDEX IF NOT EXISTS source_observations_chain_time
      ON source_observations(chain, observed_at, observation_id);
    CREATE INDEX IF NOT EXISTS source_observations_source_time
      ON source_observations(source, collected_at, observation_id);

    CREATE TABLE IF NOT EXISTS source_observation_conflicts (
      conflict_id TEXT PRIMARY KEY,
      observation_id TEXT NOT NULL,
      existing_fingerprint TEXT NOT NULL,
      incoming_fingerprint TEXT NOT NULL,
      existing_observation TEXT NOT NULL,
      incoming_observation TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      occurrence_count INTEGER NOT NULL,
      UNIQUE(observation_id, existing_fingerprint, incoming_fingerprint)
    );
    CREATE INDEX IF NOT EXISTS source_observation_conflicts_last_seen
      ON source_observation_conflicts(last_seen_at, conflict_id);

    CREATE TABLE IF NOT EXISTS source_cursors (
      source TEXT NOT NULL,
      chain TEXT NOT NULL,
      cursor TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(source, chain)
    );

    CREATE TABLE IF NOT EXISTS source_health (
      source TEXT NOT NULL,
      chain TEXT NOT NULL,
      state TEXT NOT NULL,
      last_attempt_at INTEGER NOT NULL,
      last_success_at INTEGER,
      last_event_at INTEGER,
      consecutive_failures INTEGER NOT NULL,
      latency_ms INTEGER,
      rate_limit_reset_at INTEGER,
      cursor TEXT,
      last_error_code TEXT,
      PRIMARY KEY(source, chain)
    );

    CREATE TABLE IF NOT EXISTS provider_budget_usage (
      provider TEXT NOT NULL,
      usage_window TEXT NOT NULL,
      units_used REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(provider, usage_window)
    );

    CREATE TABLE IF NOT EXISTS recovery_jobs (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      chain TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      cursor TEXT,
      attempt_count INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(job_type, chain, subject_key)
    );
    CREATE INDEX IF NOT EXISTS recovery_jobs_claim
      ON recovery_jobs(status, next_attempt_at, priority, created_at);

    CREATE TABLE IF NOT EXISTS token_observation_state (
      token_id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      token_address TEXT NOT NULL,
      first_observed_at INTEGER NOT NULL,
      last_observed_at INTEGER NOT NULL,
      identity_status TEXT NOT NULL,
      market_status TEXT NOT NULL,
      fomo_status TEXT NOT NULL,
      milestone_status TEXT NOT NULL,
      evidence_status TEXT NOT NULL,
      milestone_observed_at INTEGER,
      symbol TEXT,
      image_url TEXT,
      market_cap_usd REAL,
      launched_at INTEGER,
      quarantined INTEGER NOT NULL,
      quarantine_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS token_observation_state_chain_time
      ON token_observation_state(chain, last_observed_at, token_id);

    CREATE TABLE IF NOT EXISTS token_market_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      source TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      price_usd REAL,
      market_cap_usd REAL,
      liquidity_usd REAL,
      payload TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_market_snapshots_token_time
      ON token_market_snapshots(token_id, observed_at, snapshot_id);
  `);

  const sourceObservationColumns = database.prepare("PRAGMA table_info(source_observations)").all() as readonly Record<string, unknown>[];
  if (!sourceObservationColumns.some((column) => column.name === "fingerprint_version")) {
    database.exec("ALTER TABLE source_observations ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1");
  }
  initializeSourceEnrichmentSchema(database);
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
};

const stableJson = (value: unknown): string => {
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) throw new Error("Source observation content must be JSON serializable");
  return serialized;
};

const parseJson = (value: unknown): unknown => JSON.parse(String(value));

const toObservation = (row: Record<string, unknown>): SourceObservation => Object.freeze({
  observationId: String(row.observation_id),
  source: row.source as SourceId,
  sourceEventId: String(row.source_event_id),
  chain: row.chain as DiscoveryChain,
  observedAt: Number(row.observed_at),
  collectedAt: Number(row.collected_at),
  payloadVersion: Number(row.payload_version),
  payload: parseJson(row.payload),
  confidence: Number(row.confidence),
  extractionMode: row.extraction_mode as SourceObservation["extractionMode"],
  provenance: Object.freeze(parseJson(row.provenance) as Record<string, unknown>),
});

const toRecoveryJob = (row: Record<string, unknown>): RecoveryJobRecord => Object.freeze({
  jobId: String(row.job_id),
  jobType: row.job_type as RecoveryJobType,
  chain: row.chain as DiscoveryChain,
  subjectKey: String(row.subject_key),
  status: row.status as RecoveryJobStatus,
  priority: Number(row.priority),
  cursor: row.cursor as string | null,
  attemptCount: Number(row.attempt_count),
  nextAttemptAt: Number(row.next_attempt_at),
  leaseExpiresAt: row.lease_expires_at as number | null,
  lastError: row.last_error as string | null,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  completedAt: row.completed_at as number | null,
});

const toTokenObservation = (row: Record<string, unknown>): TokenObservationRecord => Object.freeze({
  tokenId: String(row.token_id),
  chain: String(row.chain),
  tokenAddress: String(row.token_address),
  firstObservedAt: Number(row.first_observed_at),
  lastObservedAt: Number(row.last_observed_at),
  identityStatus: row.identity_status as TokenDimensionStatus,
  marketStatus: row.market_status as TokenDimensionStatus,
  fomoStatus: row.fomo_status as TokenDimensionStatus,
  milestoneStatus: row.milestone_status as TokenDimensionStatus,
  evidenceStatus: row.evidence_status as TokenDimensionStatus,
  milestoneObservedAt: row.milestone_observed_at as number | null,
  symbol: row.symbol as string | null,
  imageUrl: row.image_url as string | null,
  marketCapUsd: row.market_cap_usd as number | null,
  launchedAt: row.launched_at as number | null,
  quarantined: Number(row.quarantined) === 1,
  quarantineReason: row.quarantine_reason as string | null,
});

const toTokenMarketSnapshot = (row: Record<string, unknown>): TokenMarketSnapshotRecord => Object.freeze({
  snapshotId: String(row.snapshot_id),
  tokenId: String(row.token_id),
  source: row.source as SourceId,
  observedAt: Number(row.observed_at),
  priceUsd: row.price_usd as number | null,
  marketCapUsd: row.market_cap_usd as number | null,
  liquidityUsd: row.liquidity_usd as number | null,
  payload: parseJson(row.payload),
});

export function createSourceLedgerStore(database: DatabaseSync): SourceLedgerStore {
  const transaction = <T>(operation: () => T): T => withAddressRadarWriteTransaction(database, operation);
  const saveEnrichment = (observation: SourceObservation): void => {
    const payload = observation.payload && typeof observation.payload === "object"
      ? observation.payload as Record<string, unknown>
      : {};
    const amountUsd = typeof payload.amountUsd === "number" && Number.isFinite(payload.amountUsd) ? payload.amountUsd : null;
    const priceUsd = typeof payload.priceUsd === "number" && Number.isFinite(payload.priceUsd) ? payload.priceUsd : null;
    const latest = database.prepare(`
      SELECT revision, amount_usd AS amountUsd, price_usd AS priceUsd,
        collected_at AS collectedAt, quality_score AS qualityScore, provenance_json AS provenanceJson
      FROM source_observation_enrichments
      WHERE observation_id=? ORDER BY revision DESC LIMIT 1
    `).get(observation.observationId) as {
      revision: number; amountUsd: number | null; priceUsd: number | null;
      collectedAt: number; qualityScore: number; provenanceJson: string | null;
    } | undefined;
    const provenanceJson = stableJson(observation.provenance);
    if (latest
      && latest.amountUsd === amountUsd
      && latest.priceUsd === priceUsd
      && latest.qualityScore === observation.confidence
      && latest.provenanceJson === provenanceJson
      && latest.collectedAt >= observation.collectedAt) return;
    database.prepare(`
      INSERT INTO source_observation_enrichments(
        observation_id, revision, amount_usd, price_usd, collected_at,
        provenance_json, quality_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observationId, (latest?.revision ?? 0) + 1, amountUsd, priceUsd,
      observation.collectedAt, provenanceJson, observation.confidence, observation.collectedAt,
    );
  };

  const store: SourceLedgerStore = {
    saveObservation(observation) {
      return transaction(() => {
      const contentFingerprint = semanticSourceObservationFingerprint(observation);
      const existing = database.prepare("SELECT * FROM source_observations WHERE observation_id = ?")
        .get(observation.observationId) as Record<string, unknown> | undefined;
      if (existing) {
        const existingFingerprint = Number(existing.fingerprint_version) === SOURCE_OBSERVATION_FINGERPRINT_VERSION
          ? String(existing.content_fingerprint)
          : semanticSourceObservationFingerprint(toObservation(existing));
        if (existingFingerprint !== contentFingerprint) {
          const conflictId = `source-conflict:${createHash("sha256")
            .update(observation.observationId)
            .update("\u0000")
            .update(existingFingerprint)
            .update("\u0000")
            .update(contentFingerprint)
            .digest("hex")}`;
          database.prepare(`
            INSERT INTO source_observation_conflicts(
              conflict_id, observation_id, existing_fingerprint, incoming_fingerprint,
              existing_observation, incoming_observation, first_seen_at, last_seen_at,
              occurrence_count
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(observation_id, existing_fingerprint, incoming_fingerprint) DO UPDATE SET
              incoming_observation = CASE
                WHEN excluded.last_seen_at - source_observation_conflicts.last_seen_at >= 60000
                THEN excluded.incoming_observation ELSE source_observation_conflicts.incoming_observation END,
              last_seen_at = CASE
                WHEN excluded.last_seen_at - source_observation_conflicts.last_seen_at >= 60000
                THEN excluded.last_seen_at ELSE source_observation_conflicts.last_seen_at END,
              occurrence_count = source_observation_conflicts.occurrence_count + CASE
                WHEN excluded.last_seen_at - source_observation_conflicts.last_seen_at >= 60000
                THEN 1 ELSE 0 END
          `).run(
            conflictId,
            observation.observationId,
            existingFingerprint,
            contentFingerprint,
            stableJson(toObservation(existing)),
            stableJson(observation),
            observation.collectedAt,
            observation.collectedAt,
          );
          return Object.freeze({ status: "conflict", conflictId });
        }
        if (Number(existing.fingerprint_version) !== SOURCE_OBSERVATION_FINGERPRINT_VERSION) {
          database.prepare("UPDATE source_observations SET content_fingerprint = ?, fingerprint_version = ? WHERE observation_id = ?")
            .run(contentFingerprint, SOURCE_OBSERVATION_FINGERPRINT_VERSION, observation.observationId);
        }
        saveEnrichment(observation);
        return Object.freeze({ status: "duplicate" });
      }
      database.prepare(`
        INSERT INTO source_observations(
          observation_id, source, source_event_id, chain, observed_at, collected_at,
          payload_version, payload, confidence, extraction_mode, provenance, content_fingerprint,
          fingerprint_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.observationId, observation.source, observation.sourceEventId, observation.chain,
        observation.observedAt, observation.collectedAt, observation.payloadVersion,
        stableJson(observation.payload), observation.confidence, observation.extractionMode,
        stableJson(observation.provenance), contentFingerprint, SOURCE_OBSERVATION_FINGERPRINT_VERSION,
      );
      saveEnrichment(observation);
      return Object.freeze({ status: "inserted" });
      });
    },
    observation(observationId) {
      const row = database.prepare("SELECT * FROM source_observations WHERE observation_id = ?").get(observationId) as Record<string, unknown> | undefined;
      return row ? toObservation(row) : null;
    },
    advanceCursor(cursor) {
      const result = database.prepare(`
        INSERT INTO source_cursors(source, chain, cursor, position, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source, chain) DO UPDATE SET
          cursor = excluded.cursor, position = excluded.position, updated_at = excluded.updated_at
        WHERE excluded.position >= source_cursors.position
      `).run(cursor.source, cursor.chain, cursor.cursor, cursor.position, cursor.updatedAt);
      return result.changes === 1;
    },
    sourceCursor(source, chain) {
      const row = database.prepare("SELECT * FROM source_cursors WHERE source = ? AND chain = ?").get(source, chain) as Record<string, unknown> | undefined;
      return row ? Object.freeze({ source: row.source as SourceId, chain: row.chain as DiscoveryChain, cursor: String(row.cursor), position: Number(row.position), updatedAt: Number(row.updated_at) }) : null;
    },
    saveSourceHealth(health) {
      transaction(() => database.prepare(`
        INSERT INTO source_health(
          source, chain, state, last_attempt_at, last_success_at, last_event_at,
          consecutive_failures, latency_ms, rate_limit_reset_at, cursor, last_error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, chain) DO UPDATE SET
          state = excluded.state, last_attempt_at = excluded.last_attempt_at,
          last_success_at = excluded.last_success_at, last_event_at = excluded.last_event_at,
          consecutive_failures = excluded.consecutive_failures, latency_ms = excluded.latency_ms,
          rate_limit_reset_at = excluded.rate_limit_reset_at, cursor = excluded.cursor,
          last_error_code = excluded.last_error_code
      `).run(health.source, health.chain, health.state, health.lastAttemptAt, health.lastSuccessAt,
        health.lastEventAt, health.consecutiveFailures, health.latencyMs, health.rateLimitResetAt,
        health.cursor, health.lastErrorCode));
    },
    sourceHealth(source, chain) {
      const row = database.prepare("SELECT * FROM source_health WHERE source = ? AND chain = ?").get(source, chain) as Record<string, unknown> | undefined;
      return row ? Object.freeze({
        source: row.source as SourceId,
        chain: row.chain as DiscoveryChain,
        state: row.state as SourceHealthState,
        lastAttemptAt: Number(row.last_attempt_at),
        lastSuccessAt: row.last_success_at as number | null,
        lastEventAt: row.last_event_at as number | null,
        consecutiveFailures: Number(row.consecutive_failures),
        latencyMs: row.latency_ms as number | null,
        rateLimitResetAt: row.rate_limit_reset_at as number | null,
        cursor: row.cursor as string | null,
        lastErrorCode: row.last_error_code as string | null,
      }) : null;
    },
    addBudgetUsage(provider, usageWindow, units, updatedAt) {
      if (!Number.isFinite(units) || units < 0) throw new Error("Budget usage units must be non-negative");
      database.prepare(`
        INSERT INTO provider_budget_usage(provider, usage_window, units_used, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, usage_window) DO UPDATE SET
          units_used = provider_budget_usage.units_used + excluded.units_used,
          updated_at = excluded.updated_at
      `).run(provider, usageWindow, units, updatedAt);
    },
    budgetUsage(provider, usageWindow) {
      const row = database.prepare("SELECT units_used AS unitsUsed FROM provider_budget_usage WHERE provider = ? AND usage_window = ?").get(provider, usageWindow) as { unitsUsed: number } | undefined;
      return Number(row?.unitsUsed ?? 0);
    },
    enqueueRecoveryJob(job) {
      return transaction(() => {
        const result = database.prepare(`
          INSERT OR IGNORE INTO recovery_jobs(
            job_id, job_type, chain, subject_key, status, priority, cursor, attempt_count,
            next_attempt_at, lease_expires_at, last_error, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 0, ?, NULL, NULL, ?, ?, NULL)
        `).run(job.jobId, job.jobType, job.chain, job.subjectKey, job.priority, job.cursor,
          job.nextAttemptAt, job.createdAt, job.createdAt);
        return Object.freeze({ inserted: result.changes === 1 });
      });
    },
    claimRecoveryJob(now, leaseMs) {
      return transaction(() => {
        database.prepare(`
          UPDATE recovery_jobs
          SET status = 'pending', lease_expires_at = NULL, next_attempt_at = MIN(next_attempt_at, ?), updated_at = ?
          WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        `).run(now, now, now);
        const row = database.prepare(`
          SELECT * FROM recovery_jobs
          WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
          ORDER BY next_attempt_at, priority, created_at, job_id LIMIT 1
        `).get(now) as Record<string, unknown> | undefined;
        if (!row) return null;
        database.prepare(`
          UPDATE recovery_jobs SET status = 'running', attempt_count = attempt_count + 1,
            lease_expires_at = ?, updated_at = ? WHERE job_id = ?
        `).run(now + leaseMs, now, row.job_id as string);
        return toRecoveryJob(database.prepare("SELECT * FROM recovery_jobs WHERE job_id = ?").get(row.job_id as string) as Record<string, unknown>);
      });
    },
    checkpointRecoveryJob(jobId, cursor, updatedAt) {
      transaction(() => {
        database.prepare("UPDATE recovery_jobs SET cursor = ?, lease_expires_at = NULL, status = 'pending', next_attempt_at = ?, updated_at = ? WHERE job_id = ? AND status = 'running'")
          .run(cursor, updatedAt, updatedAt, jobId);
      });
    },
    failRecoveryJob(jobId, error, nextAttemptAt, terminal = false) {
      transaction(() => {
        database.prepare("UPDATE recovery_jobs SET status = ?, lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE job_id = ?")
          .run(terminal ? "dead_letter" : "failed", error, nextAttemptAt, nextAttemptAt, jobId);
      });
    },
    completeRecoveryJob(jobId, completedAt) {
      transaction(() => {
        database.prepare("UPDATE recovery_jobs SET status = 'completed', lease_expires_at = NULL, last_error = NULL, completed_at = ?, updated_at = ? WHERE job_id = ?")
          .run(completedAt, completedAt, jobId);
      });
    },
    recoveryJob(jobId) {
      const row = database.prepare("SELECT * FROM recovery_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown> | undefined;
      return row ? toRecoveryJob(row) : null;
    },
    saveTokenObservation(patch) {
      if (!Number.isFinite(patch.observedAt) || patch.observedAt < 0) throw new Error("Token observation time must be non-negative");
      const row = database.prepare("SELECT * FROM token_observation_state WHERE token_id = ?").get(patch.tokenId) as Record<string, unknown> | undefined;
      const current = row ? toTokenObservation(row) : null;
      const value: TokenObservationRecord = {
        tokenId: patch.tokenId,
        chain: patch.chain,
        tokenAddress: patch.tokenAddress,
        firstObservedAt: Math.min(current?.firstObservedAt ?? patch.observedAt, patch.observedAt),
        lastObservedAt: Math.max(current?.lastObservedAt ?? patch.observedAt, patch.observedAt),
        identityStatus: patch.identityStatus ?? current?.identityStatus ?? "unknown",
        marketStatus: patch.marketStatus ?? current?.marketStatus ?? "unknown",
        fomoStatus: patch.fomoStatus ?? current?.fomoStatus ?? "unknown",
        milestoneStatus: patch.milestoneStatus ?? current?.milestoneStatus ?? "unknown",
        evidenceStatus: patch.evidenceStatus ?? current?.evidenceStatus ?? "unknown",
        milestoneObservedAt: patch.milestoneObservedAt !== undefined ? patch.milestoneObservedAt : current?.milestoneObservedAt ?? null,
        symbol: patch.symbol !== undefined ? patch.symbol : current?.symbol ?? null,
        imageUrl: patch.imageUrl !== undefined ? patch.imageUrl : current?.imageUrl ?? null,
        marketCapUsd: patch.marketCapUsd !== undefined ? patch.marketCapUsd : current?.marketCapUsd ?? null,
        launchedAt: patch.launchedAt !== undefined ? patch.launchedAt : current?.launchedAt ?? null,
        quarantined: patch.quarantined ?? current?.quarantined ?? false,
        quarantineReason: patch.quarantineReason !== undefined ? patch.quarantineReason : current?.quarantineReason ?? null,
      };
      database.prepare(`
        INSERT INTO token_observation_state(
          token_id, chain, token_address, first_observed_at, last_observed_at,
          identity_status, market_status, fomo_status, milestone_status, evidence_status,
          milestone_observed_at, symbol, image_url, market_cap_usd, launched_at,
          quarantined, quarantine_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          chain = excluded.chain, token_address = excluded.token_address,
          first_observed_at = excluded.first_observed_at, last_observed_at = excluded.last_observed_at,
          identity_status = excluded.identity_status, market_status = excluded.market_status,
          fomo_status = excluded.fomo_status, milestone_status = excluded.milestone_status,
          evidence_status = excluded.evidence_status, milestone_observed_at = excluded.milestone_observed_at,
          symbol = excluded.symbol, image_url = excluded.image_url, market_cap_usd = excluded.market_cap_usd,
          launched_at = excluded.launched_at, quarantined = excluded.quarantined,
          quarantine_reason = excluded.quarantine_reason
      `).run(value.tokenId, value.chain, value.tokenAddress, value.firstObservedAt, value.lastObservedAt,
        value.identityStatus, value.marketStatus, value.fomoStatus, value.milestoneStatus, value.evidenceStatus,
        value.milestoneObservedAt, value.symbol, value.imageUrl, value.marketCapUsd, value.launchedAt,
        value.quarantined ? 1 : 0, value.quarantineReason);
      return Object.freeze(value);
    },
    tokenObservation(tokenId) {
      const row = database.prepare("SELECT * FROM token_observation_state WHERE token_id = ?").get(tokenId) as Record<string, unknown> | undefined;
      return row ? toTokenObservation(row) : null;
    },
    saveTokenMarketSnapshot(snapshot) {
      const contentFingerprint = createHash("sha256").update(stableJson(snapshot)).digest("hex");
      const existing = database.prepare("SELECT content_fingerprint AS contentFingerprint FROM token_market_snapshots WHERE snapshot_id = ?").get(snapshot.snapshotId) as { contentFingerprint: string } | undefined;
      if (existing) {
        if (existing.contentFingerprint !== contentFingerprint) throw new Error(`Token market snapshot ${snapshot.snapshotId} has conflicting content`);
        return Object.freeze({ inserted: false });
      }
      database.prepare(`
        INSERT INTO token_market_snapshots(snapshot_id, token_id, source, observed_at, price_usd, market_cap_usd, liquidity_usd, payload, content_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.snapshotId, snapshot.tokenId, snapshot.source, snapshot.observedAt, snapshot.priceUsd,
        snapshot.marketCapUsd, snapshot.liquidityUsd, stableJson(snapshot.payload), contentFingerprint);
      return Object.freeze({ inserted: true });
    },
    tokenMarketSnapshots(tokenId) {
      const rows = database.prepare("SELECT * FROM token_market_snapshots WHERE token_id = ? ORDER BY observed_at, snapshot_id").all(tokenId) as Record<string, unknown>[];
      return Object.freeze(rows.map(toTokenMarketSnapshot));
    },
  };
  return Object.freeze(store);
}
