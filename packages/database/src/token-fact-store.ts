import type { DatabaseSync } from "node:sqlite";

import { withAddressRadarWriteTransaction } from "./connection.js";

export const TOKEN_FACT_TYPES = Object.freeze([
  "token_identity", "fomo_presence", "market_identity", "price_history", "supply_history",
  "milestone_crossings", "early_trades", "trader_attribution", "candidate_evidence", "ability_outcomes",
] as const);
export type TokenFactType = typeof TOKEN_FACT_TYPES[number];

export const TOKEN_FACT_STATUSES = Object.freeze([
  "missing", "scheduled", "fetching", "available", "partial", "degraded",
  "retry_scheduled", "conflicted", "terminal_unavailable",
] as const);
export type TokenFactStatus = typeof TOKEN_FACT_STATUSES[number];

export const TOKEN_FACT_PRECISIONS = Object.freeze([
  "exact", "derived", "estimated", "fdv_proxy", "page_observed",
] as const);
export type TokenFactPrecision = typeof TOKEN_FACT_PRECISIONS[number];

export type TokenFactAttemptOutcome = "available" | "partial" | "empty" | "failed" | "rate_limited" | "circuit_open" | "terminal";

export interface TokenFactRecord {
  readonly tokenId: string;
  readonly factType: TokenFactType;
  readonly status: TokenFactStatus;
  readonly precision: TokenFactPrecision | null;
  readonly primarySource: string | null;
  readonly coverageStartAt: number | null;
  readonly coverageEndAt: number | null;
  readonly observedAt: number | null;
  readonly knownAt: number | null;
  readonly freshUntil: number | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: number | null;
  readonly terminalReason: string | null;
  readonly strategyVersion: string;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface TokenFactTransition {
  readonly tokenId: string;
  readonly factType: TokenFactType;
  readonly status: TokenFactStatus;
  readonly updatedAt: number;
  readonly strategyVersion: string;
  readonly precision?: TokenFactPrecision | null;
  readonly primarySource?: string | null;
  readonly coverageStartAt?: number | null;
  readonly coverageEndAt?: number | null;
  readonly observedAt?: number | null;
  readonly knownAt?: number | null;
  readonly freshUntil?: number | null;
  readonly nextAttemptAt?: number | null;
  readonly terminalReason?: string | null;
  readonly reopenTerminal?: boolean;
}

export interface TokenFactAttempt {
  readonly attemptId: string;
  readonly tokenId: string;
  readonly factType: TokenFactType;
  readonly provider: string;
  readonly outcome: TokenFactAttemptOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly factsWritten: number;
  readonly coverageStartAt?: number | null;
  readonly coverageEndAt?: number | null;
  readonly retryAt?: number | null;
  readonly message?: string | null;
  readonly payload?: unknown;
}

export interface TokenFactStore {
  ensure(tokenId: string, factType: TokenFactType, strategyVersion: string, now: number): TokenFactRecord;
  fact(tokenId: string, factType: TokenFactType): TokenFactRecord | null;
  transition(input: TokenFactTransition): TokenFactRecord;
  recordAttempt(input: TokenFactAttempt): { readonly inserted: boolean };
  addDependency(tokenId: string, factType: TokenFactType, dependsOn: TokenFactType, now: number): void;
  dependencies(tokenId: string, factType: TokenFactType): readonly TokenFactType[];
}

const transitions = (...statuses: TokenFactStatus[]): ReadonlySet<TokenFactStatus> => new Set(statuses);

const ALLOWED_TRANSITIONS: Readonly<Record<TokenFactStatus, ReadonlySet<TokenFactStatus>>> = Object.freeze({
  missing: transitions("scheduled", "fetching", "available", "partial", "conflicted", "terminal_unavailable"),
  scheduled: transitions("fetching", "available", "partial", "retry_scheduled", "conflicted", "terminal_unavailable"),
  fetching: transitions("available", "partial", "degraded", "retry_scheduled", "conflicted", "terminal_unavailable"),
  available: transitions("available", "scheduled", "degraded", "conflicted"),
  partial: transitions("partial", "scheduled", "fetching", "available", "degraded", "conflicted", "terminal_unavailable"),
  degraded: transitions("scheduled", "fetching", "available", "partial", "conflicted", "terminal_unavailable"),
  retry_scheduled: transitions("scheduled", "fetching", "available", "partial", "degraded", "conflicted", "terminal_unavailable"),
  conflicted: transitions("scheduled", "fetching", "available", "partial", "degraded", "terminal_unavailable"),
  terminal_unavailable: transitions("scheduled"),
});

const finiteTimestamp = (value: number | null | undefined, field: string): void => {
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${field} must be a non-negative finite timestamp`);
  }
};

const assertTransition = (current: TokenFactRecord, input: TokenFactTransition): void => {
  if (!ALLOWED_TRANSITIONS[current.status].has(input.status)) throw new Error(`Invalid token fact transition: ${current.status} -> ${input.status}`);
  if (current.status === "terminal_unavailable" && !input.reopenTerminal) throw new Error("Reopening a terminal token fact requires explicit authorization");
  if (input.status === "terminal_unavailable" && !input.terminalReason?.trim()) throw new Error("Terminal token facts require a reason");
  const source = input.primarySource !== undefined ? input.primarySource : current.primarySource;
  const observedAt = input.observedAt !== undefined ? input.observedAt : current.observedAt;
  if (input.status === "available" && (!source?.trim() || observedAt === null)) throw new Error("Available token facts require a primary source and observation time");
  const start = input.coverageStartAt !== undefined ? input.coverageStartAt : current.coverageStartAt;
  const end = input.coverageEndAt !== undefined ? input.coverageEndAt : current.coverageEndAt;
  if (start !== null && end !== null && start > end) throw new Error("Token fact coverage start cannot be after coverage end");
  finiteTimestamp(input.updatedAt, "updatedAt");
  finiteTimestamp(input.observedAt, "observedAt");
  finiteTimestamp(input.knownAt, "knownAt");
  finiteTimestamp(input.freshUntil, "freshUntil");
  finiteTimestamp(input.nextAttemptAt, "nextAttemptAt");
};

const toFact = (row: Record<string, unknown>): TokenFactRecord => Object.freeze({
  tokenId: String(row.token_id), factType: row.fact_type as TokenFactType, status: row.status as TokenFactStatus,
  precision: row.precision as TokenFactPrecision | null, primarySource: row.primary_source as string | null,
  coverageStartAt: row.coverage_start_at as number | null, coverageEndAt: row.coverage_end_at as number | null,
  observedAt: row.observed_at as number | null, knownAt: row.known_at as number | null,
  freshUntil: row.fresh_until as number | null, attemptCount: Number(row.attempt_count),
  nextAttemptAt: row.next_attempt_at as number | null, terminalReason: row.terminal_reason as string | null,
  strategyVersion: String(row.strategy_version), revision: Number(row.revision), updatedAt: Number(row.updated_at),
});

export function initializeTokenFactSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS token_fact_status (
      token_id TEXT NOT NULL,
      fact_type TEXT NOT NULL CHECK(fact_type IN ('token_identity','fomo_presence','market_identity','price_history','supply_history','milestone_crossings','early_trades','trader_attribution','candidate_evidence','ability_outcomes')),
      status TEXT NOT NULL CHECK(status IN ('missing','scheduled','fetching','available','partial','degraded','retry_scheduled','conflicted','terminal_unavailable')),
      precision TEXT CHECK(precision IS NULL OR precision IN ('exact','derived','estimated','fdv_proxy','page_observed')),
      primary_source TEXT,
      coverage_start_at INTEGER,
      coverage_end_at INTEGER,
      observed_at INTEGER,
      known_at INTEGER,
      fresh_until INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      terminal_reason TEXT,
      strategy_version TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(token_id, fact_type),
      CHECK(coverage_start_at IS NULL OR coverage_end_at IS NULL OR coverage_start_at <= coverage_end_at),
      CHECK(status <> 'terminal_unavailable' OR terminal_reason IS NOT NULL),
      CHECK(status <> 'available' OR (primary_source IS NOT NULL AND observed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS token_fact_status_queue ON token_fact_status(status, next_attempt_at, fact_type, updated_at);
    CREATE INDEX IF NOT EXISTS token_fact_status_token ON token_fact_status(token_id, status, fact_type);
    CREATE TABLE IF NOT EXISTS token_fact_attempts (
      attempt_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('available','partial','empty','failed','rate_limited','circuit_open','terminal')),
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      facts_written INTEGER NOT NULL,
      coverage_start_at INTEGER,
      coverage_end_at INTEGER,
      retry_at INTEGER,
      message TEXT,
      payload TEXT,
      CHECK(finished_at >= started_at),
      CHECK(facts_written >= 0),
      CHECK(coverage_start_at IS NULL OR coverage_end_at IS NULL OR coverage_start_at <= coverage_end_at),
      FOREIGN KEY(token_id, fact_type) REFERENCES token_fact_status(token_id, fact_type) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS token_fact_attempts_fact_time ON token_fact_attempts(token_id, fact_type, finished_at, attempt_id);
    CREATE INDEX IF NOT EXISTS token_fact_attempts_provider_outcome ON token_fact_attempts(provider, outcome, finished_at);
    CREATE TABLE IF NOT EXISTS token_fact_dependencies (
      token_id TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      depends_on_fact_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(token_id, fact_type, depends_on_fact_type),
      CHECK(fact_type <> depends_on_fact_type)
    );
    CREATE TABLE IF NOT EXISTS token_fact_conflicts (
      conflict_id TEXT PRIMARY KEY,
      token_id TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      left_source TEXT NOT NULL,
      right_source TEXT NOT NULL,
      left_value TEXT NOT NULL,
      right_value TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','resolved','ignored')),
      resolution TEXT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS token_fact_conflicts_open ON token_fact_conflicts(status, fact_type, last_seen_at);
    CREATE TABLE IF NOT EXISTS token_fact_watermarks (
      token_id TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      cursor TEXT,
      coverage_end_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(token_id, fact_type, provider)
    );
  `);
}

export function createTokenFactStore(database: DatabaseSync): TokenFactStore {
  const load = (tokenId: string, factType: TokenFactType): TokenFactRecord | null => {
    const row = database.prepare("SELECT * FROM token_fact_status WHERE token_id = ? AND fact_type = ?").get(tokenId, factType) as Record<string, unknown> | undefined;
    return row ? toFact(row) : null;
  };
  const store: TokenFactStore = {
    ensure(tokenId, factType, strategyVersion, now) {
      finiteTimestamp(now, "now");
      database.prepare("INSERT OR IGNORE INTO token_fact_status(token_id, fact_type, status, strategy_version, updated_at) VALUES (?, ?, 'missing', ?, ?)").run(tokenId, factType, strategyVersion, now);
      return load(tokenId, factType)!;
    },
    fact: load,
    transition(input) {
      return withAddressRadarWriteTransaction(database, () => {
        const current = load(input.tokenId, input.factType);
        if (!current) throw new Error(`Token fact does not exist: ${input.tokenId}:${input.factType}`);
        assertTransition(current, input);
        database.prepare(`UPDATE token_fact_status SET status=?, precision=?, primary_source=?, coverage_start_at=?, coverage_end_at=?, observed_at=?, known_at=?, fresh_until=?, next_attempt_at=?, terminal_reason=?, strategy_version=?, revision=revision+1, updated_at=? WHERE token_id=? AND fact_type=?`).run(
          input.status,
          input.precision !== undefined ? input.precision : current.precision,
          input.primarySource !== undefined ? input.primarySource : current.primarySource,
          input.coverageStartAt !== undefined ? input.coverageStartAt : current.coverageStartAt,
          input.coverageEndAt !== undefined ? input.coverageEndAt : current.coverageEndAt,
          input.observedAt !== undefined ? input.observedAt : current.observedAt,
          input.knownAt !== undefined ? input.knownAt : current.knownAt,
          input.freshUntil !== undefined ? input.freshUntil : current.freshUntil,
          input.nextAttemptAt !== undefined ? input.nextAttemptAt : current.nextAttemptAt,
          input.terminalReason !== undefined ? input.terminalReason : current.terminalReason,
          input.strategyVersion, input.updatedAt, input.tokenId, input.factType,
        );
        return load(input.tokenId, input.factType)!;
      });
    },
    recordAttempt(input) {
      finiteTimestamp(input.startedAt, "startedAt"); finiteTimestamp(input.finishedAt, "finishedAt");
      finiteTimestamp(input.coverageStartAt, "coverageStartAt"); finiteTimestamp(input.coverageEndAt, "coverageEndAt"); finiteTimestamp(input.retryAt, "retryAt");
      if (input.finishedAt < input.startedAt) throw new Error("Attempt finish cannot be before start");
      if (!Number.isSafeInteger(input.factsWritten) || input.factsWritten < 0) throw new Error("factsWritten must be a non-negative safe integer");
      if (input.coverageStartAt != null && input.coverageEndAt != null && input.coverageStartAt > input.coverageEndAt) throw new Error("Attempt coverage start cannot be after coverage end");
      return withAddressRadarWriteTransaction(database, () => {
        if (!load(input.tokenId, input.factType)) throw new Error(`Token fact does not exist: ${input.tokenId}:${input.factType}`);
        const result = database.prepare(`INSERT OR IGNORE INTO token_fact_attempts(attempt_id, token_id, fact_type, provider, outcome, started_at, finished_at, facts_written, coverage_start_at, coverage_end_at, retry_at, message, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.attemptId, input.tokenId, input.factType, input.provider, input.outcome, input.startedAt, input.finishedAt,
          input.factsWritten, input.coverageStartAt ?? null, input.coverageEndAt ?? null, input.retryAt ?? null,
          input.message ?? null, input.payload === undefined ? null : JSON.stringify(input.payload),
        );
        if (result.changes === 1) database.prepare("UPDATE token_fact_status SET attempt_count=attempt_count+1, updated_at=MAX(updated_at, ?) WHERE token_id=? AND fact_type=?").run(input.finishedAt, input.tokenId, input.factType);
        return Object.freeze({ inserted: result.changes === 1 });
      });
    },
    addDependency(tokenId, factType, dependsOn, now) {
      if (factType === dependsOn) throw new Error("Token facts cannot depend on themselves");
      finiteTimestamp(now, "now");
      database.prepare("INSERT OR IGNORE INTO token_fact_dependencies(token_id, fact_type, depends_on_fact_type, created_at) VALUES (?, ?, ?, ?)").run(tokenId, factType, dependsOn, now);
    },
    dependencies(tokenId, factType) {
      const rows = database.prepare("SELECT depends_on_fact_type AS factType FROM token_fact_dependencies WHERE token_id=? AND fact_type=? ORDER BY depends_on_fact_type").all(tokenId, factType) as Array<{ factType: TokenFactType }>;
      return Object.freeze(rows.map((row) => row.factType));
    },
  };
  return Object.freeze(store);
}
