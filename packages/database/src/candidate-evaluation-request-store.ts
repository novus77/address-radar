import type { DatabaseSync } from "node:sqlite";
import { withAddressRadarWriteTransaction } from "./connection.js";

export interface CandidateEvaluationRequest {
  readonly requestKey: string; readonly tokenId: string; readonly strategyVersion: string;
  readonly requestedRevision: number; readonly processedRevision: number;
  readonly requestedAt: number; readonly processedAt: number | null;
  readonly activeJobId: string | null; readonly lastOutcome: string | null; readonly updatedAt: number;
}

const rowToRequest = (row: Record<string, unknown>): CandidateEvaluationRequest => Object.freeze({
  requestKey: String(row.request_key), tokenId: String(row.token_id), strategyVersion: String(row.strategy_version),
  requestedRevision: Number(row.requested_revision), processedRevision: Number(row.processed_revision),
  requestedAt: Number(row.requested_at), processedAt: row.processed_at as number | null,
  activeJobId: row.active_job_id as string | null, lastOutcome: row.last_outcome as string | null,
  updatedAt: Number(row.updated_at),
});

export function initializeCandidateEvaluationRequestSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS candidate_evaluation_requests(
      request_key TEXT PRIMARY KEY, token_id TEXT NOT NULL, strategy_version TEXT NOT NULL,
      requested_revision INTEGER NOT NULL DEFAULT 0, processed_revision INTEGER NOT NULL DEFAULT 0,
      requested_at INTEGER NOT NULL, processed_at INTEGER, active_job_id TEXT,
      last_outcome TEXT, updated_at INTEGER NOT NULL, UNIQUE(token_id, strategy_version)
    );
    CREATE INDEX IF NOT EXISTS candidate_evaluation_requests_dirty
      ON candidate_evaluation_requests(active_job_id, requested_revision, processed_revision, requested_at);
    CREATE TABLE IF NOT EXISTS candidate_evaluation_triggers(
      request_key TEXT NOT NULL REFERENCES candidate_evaluation_requests(request_key) ON DELETE CASCADE,
      source_key TEXT NOT NULL, requested_at INTEGER NOT NULL, PRIMARY KEY(request_key, source_key)
    );
  `);
}

export function createCandidateEvaluationRequestStore(database: DatabaseSync) {
  const get = (requestKey: string): CandidateEvaluationRequest | null => {
    const row = database.prepare("SELECT * FROM candidate_evaluation_requests WHERE request_key=?").get(requestKey) as Record<string, unknown> | undefined;
    return row ? rowToRequest(row) : null;
  };
  return Object.freeze({
    get,
    request(tokenId: string, strategyVersion: string, sourceKey: string, requestedAt: number) {
      const requestKey = `${strategyVersion}:${tokenId}`;
      return withAddressRadarWriteTransaction(database, () => {
        database.prepare(`INSERT OR IGNORE INTO candidate_evaluation_requests(
          request_key,token_id,strategy_version,requested_revision,processed_revision,requested_at,updated_at
        ) VALUES (?,?,?,0,0,?,?)`).run(requestKey, tokenId, strategyVersion, requestedAt, requestedAt);
        const trigger = database.prepare(`INSERT OR IGNORE INTO candidate_evaluation_triggers(request_key,source_key,requested_at) VALUES (?,?,?)`).run(requestKey, sourceKey, requestedAt);
        if (trigger.changes === 1) database.prepare(`UPDATE candidate_evaluation_requests SET
          requested_revision=requested_revision+1, requested_at=MAX(requested_at,?), updated_at=MAX(updated_at,?)
          WHERE request_key=?`).run(requestedAt, requestedAt, requestKey);
        return get(requestKey)!;
      });
    },
    bindJob(requestKey: string, jobId: string, targetRevision: number, now: number) {
      return withAddressRadarWriteTransaction(database, () => {
        const result = database.prepare(`UPDATE candidate_evaluation_requests SET active_job_id=?,updated_at=MAX(updated_at,?)
          WHERE request_key=? AND active_job_id IS NULL AND requested_revision>=? AND processed_revision<?`).run(jobId, now, requestKey, targetRevision, targetRevision);
        if (result.changes !== 1) throw new Error(`Candidate evaluation request cannot bind job: ${requestKey}`);
        return get(requestKey)!;
      });
    },
    complete(requestKey: string, jobId: string, targetRevision: number, outcome: string, now: number) {
      return withAddressRadarWriteTransaction(database, () => {
        const result = database.prepare(`UPDATE candidate_evaluation_requests SET
          processed_revision=MAX(processed_revision,?),processed_at=?,active_job_id=NULL,last_outcome=?,updated_at=MAX(updated_at,?)
          WHERE request_key=? AND active_job_id=?`).run(targetRevision, now, outcome, now, requestKey, jobId);
        if (result.changes !== 1) throw new Error(`Candidate evaluation request completion is not owned by job: ${jobId}`);
        const request = get(requestKey)!;
        return Object.freeze({ ...request, needsFollowUp: request.requestedRevision > request.processedRevision });
      });
    },
    dirtyCount() {
      return Number((database.prepare(`SELECT COUNT(*) count FROM candidate_evaluation_requests WHERE requested_revision>processed_revision`).get() as { count: number }).count);
    },
  });
}
