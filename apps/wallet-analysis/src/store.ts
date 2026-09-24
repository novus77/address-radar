import { DatabaseSync } from "node:sqlite";

import { migrateAddressRadarDatabase } from "@address-radar/database";
import type { ChainFamily, WalletAnalysisMetrics, WalletAnalysisPosition } from "@address-radar/domain";

export interface WalletAnalysisJob {
  readonly analysisId: string;
  readonly chainFamily: ChainFamily;
  readonly address: string;
  readonly requestedSamples: number;
  readonly from: number;
  readonly to: number;
  readonly maxTokens: number;
  readonly status: "collecting" | "review_required" | "insufficient_data" | "accepted" | "rejected" | "failed";
  readonly checkpoint: string | null;
  readonly metrics: WalletAnalysisMetrics | null;
  readonly lastError: string | null;
  readonly provenance: readonly string[];
}

export interface WalletAnalysisStore {
  enqueue(input: { readonly analysisId: string; readonly chainFamily: ChainFamily; readonly address: string; readonly requestedSamples: number; readonly createdAt: number }): void;
  next(): WalletAnalysisJob | null;
  job(analysisId: string): WalletAnalysisJob | null;
  positions(analysisId: string): readonly WalletAnalysisPosition[];
  savePage(analysisId: string, positions: readonly WalletAnalysisPosition[], nextCursor: string | null, provenance: string, updatedAt: number): number;
  complete(analysisId: string, metrics: WalletAnalysisMetrics, updatedAt: number): WalletAnalysisJob["status"];
  review(analysisId: string, status: "accepted" | "rejected", reviewedAt: number): void;
  fail(analysisId: string, error: string, updatedAt: number): void;
  close(): void;
}

export function openWalletAnalysisStore(databasePath: string): WalletAnalysisStore {
  const database = new DatabaseSync(databasePath);
  migrateAddressRadarDatabase(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS wallet_analysis_positions (
      analysis_id TEXT NOT NULL REFERENCES wallet_analysis_jobs(analysis_id),
      token_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      entered_at INTEGER NOT NULL,
      PRIMARY KEY(analysis_id, token_id)
    );
    CREATE TABLE IF NOT EXISTS wallet_analysis_provenance (
      analysis_id TEXT NOT NULL REFERENCES wallet_analysis_jobs(analysis_id),
      source TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(analysis_id, source)
    );
    CREATE TABLE IF NOT EXISTS wallet_analysis_job_bounds (
      analysis_id TEXT PRIMARY KEY REFERENCES wallet_analysis_jobs(analysis_id),
      from_at INTEGER NOT NULL,
      to_at INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL CHECK(max_tokens BETWEEN 1 AND 300)
    );
  `);

  const savePage = (analysisId: string, positions: readonly WalletAnalysisPosition[], nextCursor: string | null, provenance: string, updatedAt: number): number => {
    database.exec("BEGIN IMMEDIATE");
    try {
    const insert = database.prepare("INSERT OR IGNORE INTO wallet_analysis_positions(analysis_id, token_id, payload, entered_at) VALUES (?, ?, ?, ?)");
    let saved = 0;
    for (const position of positions) saved += Number(insert.run(analysisId, position.tokenId, JSON.stringify(position), position.enteredAt).changes);
    if (nextCursor === null) database.prepare("DELETE FROM wallet_analysis_checkpoints WHERE analysis_id = ? AND scope = 'history'").run(analysisId);
    else database.prepare(`
      INSERT INTO wallet_analysis_checkpoints(analysis_id, scope, cursor, updated_at) VALUES (?, 'history', ?, ?)
      ON CONFLICT(analysis_id, scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(analysisId, nextCursor, updatedAt);
    database.prepare("INSERT OR IGNORE INTO wallet_analysis_provenance(analysis_id, source, observed_at) VALUES (?, ?, ?)").run(analysisId, provenance, updatedAt);
    database.prepare("UPDATE wallet_analysis_jobs SET last_error = NULL, updated_at = ? WHERE analysis_id = ?").run(updatedAt, analysisId);
      database.exec("COMMIT");
      return saved;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const readJob = (analysisId?: string): WalletAnalysisJob | null => {
    const sql = analysisId
      ? "SELECT * FROM wallet_analysis_jobs WHERE analysis_id = ?"
      : "SELECT * FROM wallet_analysis_jobs WHERE status = 'collecting' ORDER BY updated_at, created_at, analysis_id LIMIT 1";
    const row = (analysisId ? database.prepare(sql).get(analysisId) : database.prepare(sql).get()) as Record<string, unknown> | undefined;
    if (!row) return null;
    const checkpoint = database.prepare("SELECT cursor FROM wallet_analysis_checkpoints WHERE analysis_id = ? AND scope = 'history'").get(row.analysis_id as string) as { cursor: string } | undefined;
    const sources = database.prepare("SELECT source FROM wallet_analysis_provenance WHERE analysis_id = ? ORDER BY source").all(row.analysis_id as string) as { source: string }[];
    const bounds = database.prepare("SELECT from_at AS fromAt, to_at AS toAt, max_tokens AS maxTokens FROM wallet_analysis_job_bounds WHERE analysis_id = ?").get(row.analysis_id as string) as { fromAt: number; toAt: number; maxTokens: number } | undefined;
    if (!bounds) throw new Error(`Wallet analysis bounds are missing: ${String(row.analysis_id)}`);
    return Object.freeze({
      analysisId: row.analysis_id as string,
      chainFamily: row.chain_family as ChainFamily,
      address: row.address as string,
      requestedSamples: row.requested_sample_count as number,
      from: bounds.fromAt,
      to: bounds.toAt,
      maxTokens: bounds.maxTokens,
      status: row.status as WalletAnalysisJob["status"],
      checkpoint: checkpoint?.cursor ?? null,
      metrics: row.metrics ? Object.freeze(JSON.parse(row.metrics as string) as WalletAnalysisMetrics) : null,
      lastError: row.last_error as string | null,
      provenance: Object.freeze(sources.map(item => item.source)),
    });
  };

  const store: WalletAnalysisStore = {
    enqueue(input) {
      const requestedSamples = Math.max(1, Math.min(300, Math.trunc(input.requestedSamples)));
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare(`
          INSERT OR IGNORE INTO wallet_analysis_jobs(
            analysis_id, chain_family, address, status, requested_sample_count,
            valid_sample_count, coverage_rate, created_at, updated_at
          ) VALUES (?, ?, ?, 'collecting', ?, 0, 0, ?, ?)
        `).run(input.analysisId, input.chainFamily, input.address, requestedSamples, input.createdAt, input.createdAt);
        database.prepare("INSERT OR IGNORE INTO wallet_analysis_job_bounds(analysis_id, from_at, to_at, max_tokens) VALUES (?, ?, ?, 300)").run(input.analysisId, input.createdAt - 60 * 24 * 60 * 60_000, input.createdAt);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
    next() { return readJob(); },
    job(analysisId) { return readJob(analysisId); },
    positions(analysisId) {
      const rows = database.prepare("SELECT payload FROM wallet_analysis_positions WHERE analysis_id = ? ORDER BY entered_at, token_id").all(analysisId) as { payload: string }[];
      return Object.freeze(rows.map(row => Object.freeze(JSON.parse(row.payload) as WalletAnalysisPosition)));
    },
    savePage,
    complete(analysisId, metrics, updatedAt) {
      const status = metrics.validSamples > 0 ? "review_required" : "insufficient_data";
      database.prepare(`
        UPDATE wallet_analysis_jobs SET status = ?, valid_sample_count = ?, coverage_rate = ?, metrics = ?,
          last_error = NULL, updated_at = ? WHERE analysis_id = ?
      `).run(status, metrics.validSamples, metrics.coverageRate, JSON.stringify(metrics), updatedAt, analysisId);
      database.prepare("DELETE FROM wallet_analysis_checkpoints WHERE analysis_id = ?").run(analysisId);
      return status;
    },
    review(analysisId, status, reviewedAt) {
      const changed = database.prepare("UPDATE wallet_analysis_jobs SET status = ?, reviewed_at = ?, updated_at = ? WHERE analysis_id = ? AND status = 'review_required'").run(status, reviewedAt, reviewedAt, analysisId).changes;
      if (Number(changed) !== 1) throw new Error("Wallet analysis is not pending review");
    },
    fail(analysisId, error, updatedAt) {
      database.prepare("UPDATE wallet_analysis_jobs SET last_error = ?, updated_at = ? WHERE analysis_id = ?").run(error, updatedAt, analysisId);
    },
    close() { database.close(); },
  };
  return Object.freeze(store);
}
